import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { backgroundServicePlist, inspectBackgroundService, installBackgroundService } from "../background-service.js"
import { installCommand } from "../background-install.js"
import { createInboxStore } from "../review-inbox.js"

function fixture(t, { file = true, loaded = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "prr-service-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const directory = join(home, "project & tools")
  const executable = "/Applications/OpenCode Tools/opencode"
  const target = join(home, "Library/LaunchAgents/com.prr.review-inbox.plist")
  const options = { directory, executable, home, path: "/usr/bin:/bin" }
  const state = { loaded, registered: { directory, executable }, next: { directory, executable }, blocked: false }
  const calls = []
  if (file) {
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true })
    writeFileSync(target, backgroundServicePlist(options))
  }
  const run = async (command, args) => {
    assert.equal(command, "launchctl")
    calls.push(args)
    if (args[0] === "print") {
      if (!state.loaded) throw new Error("Service not found")
      const { directory, executable } = state.registered
      const values = [executable, "api", "post", `/api/rpc/prr.review/wake?location%5Bdirectory%5D=${encodeURIComponent(directory)}`, "--data", '{"input":{}}']
      return { stdout: `gui/501/com.prr.review-inbox = {\n program = ${executable}\n arguments = {\n${values.map((value) => `  ${value}`).join("\n")}\n }\n working directory = ${directory}\n}\n` }
    }
    if (args[0] === "bootout") { state.loaded = false; return { stdout: "" } }
    assert.equal(args[0], "bootstrap")
    if (state.blocked) throw new Error("Security policy refused registration")
    state.loaded = true
    state.registered = { ...state.next }
    return { stdout: "" }
  }
  return { ...options, target, calls, state, options: { ...options, run } }
}

test("service inspection only reads the definition and launchctl print", async (t) => {
  const f = fixture(t)
  const before = readFileSync(f.target, "utf8")
  const result = await inspectBackgroundService(f.options)
  assert.equal(result.compatible, true)
  assert.equal(result.registeredCompatible, true)
  assert.deepEqual(f.calls.map((args) => args[0]), ["print"])
  assert.equal(readFileSync(f.target, "utf8"), before)
})

test("an already matching service is not rewritten, restarted, or re-registered", async (t) => {
  const f = fixture(t)
  const before = readFileSync(f.target, "utf8")
  const modified = statSync(f.target).mtimeMs
  assert.equal((await installBackgroundService({ ...f.options, path: "/different/terminal/path" })).status, "already_installed")
  assert.deepEqual(f.calls.map((args) => args[0]), ["print"])
  assert.equal(readFileSync(f.target, "utf8"), before)
  assert.equal(statSync(f.target).mtimeMs, modified)
})

test("explicit first installation creates and bootstraps once without bootout", async (t) => {
  const f = fixture(t, { file: false, loaded: false })
  assert.equal((await installBackgroundService(f.options)).status, "installed")
  assert.deepEqual(f.calls.map((args) => args[0]), ["print", "bootstrap"])
  assert.equal(readFileSync(f.target, "utf8"), backgroundServicePlist(f.options))
  assert.equal(existsSync(join(f.home, ".prr/background.yml")), false)
  assert.equal((await installBackgroundService(f.options)).status, "already_installed")
  assert.deepEqual(f.calls.map((args) => args[0]), ["print", "bootstrap", "print"])
})

test("a matching unloaded definition is registered only by explicit installation", async (t) => {
  const f = fixture(t, { loaded: false })
  const before = readFileSync(f.target, "utf8")
  const inspection = await inspectBackgroundService(f.options)
  assert.equal(inspection.loaded, false)
  assert.deepEqual(f.calls.map((args) => args[0]), ["print"])
  assert.equal((await installBackgroundService(f.options)).status, "registered")
  assert.deepEqual(f.calls.map((args) => args[0]), ["print", "print", "bootstrap"])
  assert.equal(readFileSync(f.target, "utf8"), before)
})

test("only an explicit changed-definition install reloads the service", async (t) => {
  const f = fixture(t)
  const executable = "/new/location/opencode"
  f.state.next.executable = executable
  await installBackgroundService({ ...f.options, executable })
  assert.deepEqual(f.calls.map((args) => args[0]), ["print", "bootout", "bootstrap"])
  assert.equal((await installBackgroundService({ ...f.options, executable })).status, "already_installed")
})

test("a matching plist does not conceal an old running registration", async (t) => {
  const f = fixture(t)
  f.state.registered.executable = "/old/location/opencode"
  const inspection = await inspectBackgroundService(f.options)
  assert.equal(inspection.compatible, true)
  assert.equal(inspection.registeredCompatible, false)
  await installBackgroundService(f.options)
  assert.deepEqual(f.calls.map((args) => args[0]), ["print", "print", "bootout", "bootstrap"])
})

test("security refusal is reported without retrying or changing protection", async (t) => {
  const f = fixture(t, { file: false, loaded: false })
  f.state.blocked = true
  await assert.rejects(installBackgroundService(f.options), /endpoint-security approval/)
  assert.deepEqual(f.calls.map((args) => args[0]), ["print", "bootstrap"])
  assert.equal(existsSync(join(f.home, ".prr/background.yml")), false)
})

test("unrecognized LaunchAgent files and symlinks are left unchanged", async (t) => {
  const f = fixture(t)
  writeFileSync(f.target, "<plist>Unrelated user configuration</plist>")
  await assert.rejects(installBackgroundService(f.options), /not recognized/)
  assert.equal(readFileSync(f.target, "utf8"), "<plist>Unrelated user configuration</plist>")
  assert.deepEqual(f.calls.map((args) => args[0]), ["print"])
  rmSync(f.target)
  const other = join(f.home, "other")
  writeFileSync(other, "Do not overwrite")
  symlinkSync(other, f.target)
  await assert.rejects(installBackgroundService(f.options), /regular file/)
  assert.equal(readFileSync(other, "utf8"), "Do not overwrite")
})

test("the explicit installer records an owner but never enables or resets the queue", async (t) => {
  const f = fixture(t, { file: false, loaded: false })
  const store = createInboxStore(join(f.home, ".prr"))
  store.transaction((queue) => {
    queue.entries.push({ key: "acme/repo#1", status: "ready" })
    queue.lastPoll = "2026-11-17T01:00:00Z"
  })
  const before = store.read()
  const calls = []
  await installCommand({ args: [], home: f.home, directory: f.directory, executable: f.executable,
    install: async (input) => { calls.push(input); return { status: "installed" } } })
  assert.equal(store.config().enabled, false)
  assert.equal(existsSync(store.configPath), false)
  assert.deepEqual(store.read().entries, before.entries)
  assert.equal(store.read().lastPoll, before.lastPoll)
  assert.deepEqual(store.read().owner, { directory: f.directory })
  assert.equal(calls.length, 1)
  await assert.rejects(installCommand({ args: ["enable"], home: f.home, install: async () => assert.fail("must not install") }), /no arguments/)
})
