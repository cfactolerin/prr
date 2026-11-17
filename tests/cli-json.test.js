import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parseCliJson } from "../cli-json.js"
import { createGitHubInbox } from "../review-inbox.js"
import { createOpenCodeControl } from "../background-service.js"

const colour = (text) => `\x1b[32m${text}\x1b[0m\n`

test("plain and forced-colour JSON have the same parsed values", () => {
  for (const value of [{ login: "reviewer" }, [[{ id: 1 }], [{ id: 2 }]], { total_count: 0, items: [] }]) {
    const text = JSON.stringify(value, null, 2)
    assert.deepEqual(parseCliJson(text), value)
    assert.deepEqual(parseCliJson(colour(text)), value)
    assert.deepEqual(parseCliJson(text.replace(/[{}[\]]/g, (token) => `\x1b[36m${token}\x1b[0m`)), value)
  }
})

test("escaped terminal sequences and quoted review content remain data", () => {
  const value = { body: '\x1b[31m literal \\u001b[0m "quoted"\nsecond line' }
  assert.deepEqual(parseCliJson(colour(JSON.stringify(value))), value)
})

test("empty success responses are opt-in and unrelated text is still rejected", () => {
  assert.equal(parseCliJson("", { allowEmpty: true }), null)
  assert.equal(parseCliJson(colour(""), { allowEmpty: true }), null)
  for (const text of ["", colour("not JSON"), 'warning\n{"ok":true}', '{"partial":']) {
    assert.throws(() => parseCliJson(text), SyntaxError)
  }
})

test("GitHub discovery parses forced-colour account and paginated team responses", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "prr-cli-json-"))
  const previousPath = process.env.PATH
  t.after(() => { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }) })
  writeFileSync(join(root, "gh"), `#!${process.execPath}
const value = process.argv.includes("user") ? {login:"reviewer"} : [[{id:1,slug:"team",organization:{login:"acme"}}]]
process.stdout.write("\\u001b[32m" + JSON.stringify(value) + "\\u001b[0m\\n")
`)
  chmodSync(join(root, "gh"), 0o755)
  process.env.PATH = `${root}:${previousPath}`
  const identity = await createGitHubInbox().identity()
  assert.equal(identity.login, "reviewer")
  assert.deepEqual([...identity.teamIDs], [1])
})

test("OpenCode CLI fallback parses forced-colour session and form responses", async () => {
  const control = createOpenCodeControl({
    executable: "/bin/opencode",
    run: async (_file, args) => {
      if (args[2] === "/api/session/active") return { stdout: colour('{"data":{"session-1":{"type":"running"}}}') }
      if (args[1] === "delete") return { stdout: colour("") }
      return { stdout: colour('{"data":[{"id":"form-1"}]}') }
    },
  })
  assert.deepEqual(await control.active(), { "session-1": { type: "running" } })
  assert.deepEqual(await control.forms({ sessionID: "session-1" }), [{ id: "form-1" }])
  assert.equal(await control.cancel({ sessionID: "session-1", formID: "form-1", message: "Navigation only" }), null)
})
