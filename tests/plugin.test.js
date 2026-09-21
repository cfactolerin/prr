import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import PrrPlugin from "../index.js"

test("registers PRR commands, agents, skills, and binary environment", async () => {
  const hooks = await PrrPlugin()
  const config = {}

  hooks.config(config)

  assert.deepEqual(Object.keys(config.command).sort(), [
    "prr-cleanup",
    "prr-setup",
    "prr-start",
  ])
  assert.deepEqual(Object.keys(config.agent).sort(), [
    "prr-arbiter",
    "prr-codex-reviewer",
    "prr-opencode-reviewer",
    "prr-orchestrator",
    "prr-setup-orchestrator",
  ])
  assert.equal(config.agent["prr-opencode-reviewer"].mode, "subagent")
  assert.equal(config.agent["prr-opencode-reviewer"].model, undefined)
  assert.equal(config.command["prr-start"].agent, "prr-orchestrator")
  assert.equal(config.command["prr-setup"].agent, "prr-setup-orchestrator")
  assert.match(config.command["prr-start"].template, /\$ARGUMENTS/)
  assert.equal(config.skills.paths.length, 1)

  const reviewerPermissions = config.agent["prr-opencode-reviewer"].permission
  assert.equal(reviewerPermissions["*"], "deny")
  assert.equal(reviewerPermissions.bash, "deny")
  assert.equal(reviewerPermissions.external_directory["~/.prr/**"], undefined)
  assert.equal(reviewerPermissions.edit["~/.prr/**"], undefined)
  assert.deepEqual(reviewerPermissions.read, { "*": "deny" })
  assert.deepEqual(reviewerPermissions.edit, { "*": "deny" })
  assert.deepEqual(reviewerPermissions.external_directory, { "*": "deny" })
  assert.equal(reviewerPermissions.prr_read, "allow")
  assert.equal(config.agent["prr-codex-reviewer"].permission.bash, "deny")
  assert.equal(config.agent["prr-codex-reviewer"].permission.prr_codex, "allow")
  assert.equal(typeof hooks.tool.prr_codex.execute, "function")
  assert.equal(typeof hooks.tool.prr_codex_health.execute, "function")
  assert.equal(typeof hooks.tool.prr_artifact.execute, "function")
  assert.equal(typeof hooks.tool.prr_bind_round.execute, "function")
  assert.equal(typeof hooks.tool.prr_capability.execute, "function")
  assert.equal(typeof hooks.tool.prr_post_review.execute, "function")
  assert.equal(typeof hooks.tool.prr_read.execute, "function")
  assert.equal(typeof hooks.tool.prr_write.execute, "function")
  assert.equal(config.permission.prr_codex, "deny")
  assert.equal(config.permission.prr_read, "deny")
  assert.equal(config.agent["prr-orchestrator"].permission.bash["*"], "deny")
  assert.equal(config.agent["prr-orchestrator"].permission.prr_post_review, "ask")
  assert.equal(config.agent["prr-orchestrator"].permission.prr_codex, "deny")

  const output = { env: {} }
  hooks["shell.env"]({}, output)
  assert.match(output.env.PRR_BIN, /bin\/prr-darwin-universal$/)
})

test("does not replace user command or agent overrides", async () => {
  const hooks = await PrrPlugin()
  const config = {
    command: { "prr-start": { template: "custom" } },
    agent: { "prr-arbiter": { description: "custom" } },
    skills: { paths: ["/tmp/custom-skills"] },
  }

  hooks.config(config)

  assert.equal(config.command["prr-start"].template, "custom")
  assert.equal(config.agent["prr-arbiter"].description, "custom")
  assert.equal(config.skills.paths[0], "/tmp/custom-skills")
  assert.equal(config.skills.paths.length, 2)
})

test("rejects Codex paths outside a PRR round", async () => {
  const hooks = await PrrPlugin()
  await assert.rejects(
    hooks.tool.prr_codex.execute({
      promptPath: "/tmp/prompt.md",
      repoPath: "/tmp/repo",
      outputPath: "/tmp/review.md",
      timeoutSeconds: 30,
    }),
    /PRR round clone/,
  )
})

test("Codex wrapper validates paths and strips process secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "prr-plugin-test-"))
  const home = join(root, "home")
  const workspace = join(home, ".prr", "workspace")
  const round = join(workspace, "acme-repo-pr-1", "r1")
  const repo = join(round, "repo")
  const role = join(round, "results", "reviewers", "codex")
  const contextDirectory = join(round, "context")
  const bin = join(root, "bin")
  const prompt = join(role, "review-prompt.md")
  const output = join(role, "review.md")
  mkdirSync(repo, { recursive: true })
  mkdirSync(role, { recursive: true })
  mkdirSync(contextDirectory, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(prompt, "Review this change.")
  writeFileSync(join(contextDirectory, "requirement.txt"), "must preserve compatibility\n")
  writeFileSync(join(workspace, "acme-repo-pr-1", "pr-info.json"), JSON.stringify({
    owner: "acme",
    repo: "repo",
    number: 1,
  }))
  writeFileSync(join(round, "results", "pr-metadata.json"), JSON.stringify({
    headRefOid: "a".repeat(40),
  }))
  writeFileSync(join(repo, "code.js"), "const answer = 42\n")
  writeFileSync(join(root, "secret"), "do not read")
  symlinkSync(join(root, "secret"), join(repo, "leak"))

  const fakeCodex = join(bin, "codex")
  writeFileSync(fakeCodex, `#!${process.execPath}
const fs = require("node:fs")
const index = process.argv.indexOf("--output-last-message")
if (index === -1) {
  process.stdout.write("HELLO\\n")
  process.exit(0)
}
fs.writeFileSync(process.argv[index + 1], JSON.stringify({
  args: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME || null,
  secret: process.env.PRR_TEST_SECRET || null,
}))
`)
  chmodSync(fakeCodex, 0o755)

  const previous = {
    CODEX_HOME: process.env.CODEX_HOME,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    PRR_TEST_SECRET: process.env.PRR_TEST_SECRET,
  }
  process.env.HOME = home
  process.env.PATH = bin
  process.env.CODEX_HOME = join(home, ".codex-custom")
  process.env.PRR_TEST_SECRET = "must-not-leak"

  try {
    const hooks = await PrrPlugin()
    const orchestrator = { agent: "prr-orchestrator", sessionID: "orchestrator-session" }
    await hooks.tool.prr_bind_round.execute({ roundPath: round }, orchestrator)
    const opencodeCapability = await hooks.tool.prr_capability.execute(
      { roundPath: round, role: "opencode" },
      orchestrator,
    )
    const codexCapability = await hooks.tool.prr_capability.execute(
      { roundPath: round, role: "codex" },
      orchestrator,
    )
    const code = await hooks.tool.prr_read.execute(
      { capability: opencodeCapability, filePath: join(repo, "code.js") },
      { agent: "prr-opencode-reviewer", sessionID: "reviewer-session" },
    )
    assert.match(code, /const answer = 42/)
    const requirement = await hooks.tool.prr_read.execute(
      { capability: opencodeCapability, filePath: join(contextDirectory, "requirement.txt") },
      { agent: "prr-opencode-reviewer", sessionID: "reviewer-session" },
    )
    assert.match(requirement, /must preserve compatibility/)
    await assert.rejects(
      hooks.tool.prr_read.execute(
        { capability: opencodeCapability, filePath: join(repo, "code.js") },
        { agent: "prr-opencode-reviewer", sessionID: "other-reviewer-session" },
      ),
      /Invalid PRR round capability/,
    )
    const otherRepo = join(workspace, "acme-repo-pr-1", "r2", "repo")
    mkdirSync(otherRepo, { recursive: true })
    writeFileSync(join(otherRepo, "code.js"), "const other = true\n")
    await assert.rejects(
      hooks.tool.prr_read.execute(
        { capability: opencodeCapability, filePath: join(otherRepo, "code.js") },
        { agent: "prr-opencode-reviewer", sessionID: "reviewer-session" },
      ),
      /Invalid PRR round capability/,
    )
    await assert.rejects(
      hooks.tool.prr_read.execute(
        { capability: opencodeCapability, filePath: join(repo, "leak") },
        { agent: "prr-opencode-reviewer", sessionID: "reviewer-session" },
      ),
      /outside the configured PRR workspace/,
    )
    const siblingRepo = join(workspace, "..", "r1", "repo")
    mkdirSync(siblingRepo, { recursive: true })
    await assert.rejects(
      hooks.tool.prr_codex.execute({
        capability: codexCapability,
        promptPath: prompt,
        repoPath: siblingRepo,
        outputPath: join(role, "escaped.md"),
        timeoutSeconds: 30,
      }),
      /configured PRR workspace/,
    )
    const copied = join(round, "results", "reviewers", "opencode", "copied-prompt.md")
    await hooks.tool.prr_artifact.execute(
      { operation: "copy", sourcePath: prompt, targetPath: copied },
      orchestrator,
    )
    assert.equal(readFileSync(copied, "utf8"), "Review this change.")
    const nativeReview = join(round, "results", "reviewers", "opencode", "review.md")
    await hooks.tool.prr_write.execute(
      { capability: opencodeCapability, filePath: nativeReview, content: "No findings." },
      { agent: "prr-opencode-reviewer", sessionID: "reviewer-session" },
    )
    assert.equal(readFileSync(nativeReview, "utf8"), "No findings.")
    await hooks.tool.prr_artifact.execute(
      { operation: "remove", targetPath: copied },
      orchestrator,
    )
    const invalidPayload = join(round, "results", "invalid-review.json")
    writeFileSync(invalidPayload, JSON.stringify({ event: "DELETE_REPO", body: "no" }))
    await assert.rejects(
      hooks.tool.prr_post_review.execute(
        { owner: "acme", repo: "repo", number: 1, payloadPath: invalidPayload },
        orchestrator,
      ),
      /invalid shape/,
    )
    await hooks.tool.prr_codex_health.execute({}, { worktree: repo })
    await hooks.tool.prr_codex.execute({
      capability: codexCapability,
      promptPath: prompt,
      repoPath: repo,
      outputPath: output,
      timeoutSeconds: 30,
    }, { agent: "prr-codex-reviewer", sessionID: "codex-session" })
    const captured = JSON.parse(readFileSync(output, "utf8"))
    assert.equal(captured.secret, null)
    assert.equal(captured.codexHome, process.env.CODEX_HOME)
    assert.ok(captured.args.includes("--ignore-user-config"))
    assert.ok(captured.args.some((arg) => arg.includes("shell_environment_policy.filters")))
    assert.ok(captured.args.some((arg) => arg.includes('PATH="/usr/bin:/bin:/usr/sbin:/sbin"')))
    assert.ok(captured.args.every((arg) => !arg.includes('"/opt/homebrew"="read"')))

    writeFileSync(fakeCodex, `#!${process.execPath}\nsetTimeout(() => {}, 10000)\n`)
    const controller = new AbortController()
    const cancelled = hooks.tool.prr_codex.execute({
      capability: codexCapability,
      promptPath: prompt,
      repoPath: repo,
      outputPath: join(role, "cancelled.md"),
      timeoutSeconds: 30,
    }, { agent: "prr-codex-reviewer", sessionID: "codex-session", abort: controller.signal })
    controller.abort()
    await assert.rejects(cancelled, /abort/i)

    writeFileSync(prompt, "x".repeat(1024 * 1024))
    writeFileSync(fakeCodex, `#!${process.execPath}\nprocess.exit(1)\n`)
    await assert.rejects(
      hooks.tool.prr_codex.execute({
        capability: codexCapability,
        promptPath: prompt,
        repoPath: repo,
        outputPath: join(role, "failed.md"),
        timeoutSeconds: 30,
      }, { agent: "prr-codex-reviewer", sessionID: "codex-session" }),
    )
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test("tool executors settle as promises instead of returning or throwing synchronously", async () => {
  const hooks = await PrrPlugin()
  const orchestrator = { agent: "prr-orchestrator", sessionID: "unbound-session" }
  const missing = join(tmpdir(), "prr-missing-round", "r1")
  const failingCalls = {
    prr_bind_round: { roundPath: missing },
    prr_capability: { roundPath: missing, role: "opencode" },
    prr_read: { filePath: join(missing, "results", "review.md") },
    prr_write: { filePath: join(missing, "results", "review.md"), content: "x" },
    prr_artifact: { operation: "remove", targetPath: join(missing, "results", "review.md") },
    prr_post_review: { owner: "acme", repo: "repo", number: 1, payloadPath: join(missing, "results", "r.json") },
    prr_codex: {
      capability: "invalid",
      promptPath: join(missing, "results", "prompt.md"),
      repoPath: join(missing, "repo"),
      outputPath: join(missing, "results", "review.md"),
      timeoutSeconds: 30,
    },
  }

  for (const [name, args] of Object.entries(failingCalls)) {
    const settled = hooks.tool[name].execute(args, orchestrator)
    assert.equal(typeof settled?.then, "function", `${name} must return a promise`)
    await assert.rejects(settled)
  }
  assert.equal(hooks.tool.prr_codex_health.execute.constructor.name, "AsyncFunction")
})
