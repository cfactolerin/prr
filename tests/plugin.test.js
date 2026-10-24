import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import PrrPlugin from "../index.js"

function fakeV2Context({ agents = [], sessionAgent = "build", model } = {}) {
  const registered = { hooks: {}, sessionHooks: {}, tools: [], agents: new Map(agents.map((agent) => [agent.id, agent])), skills: [], commands: [] }
  const calls = []
  const stored = new Map()
  const ctx = {
    storage: {
      get: async (key) => structuredClone(stored.get(key)),
      set: async (key, value) => { stored.set(key, structuredClone(value)) },
    },
    rpc: {
      register: async (definition, handlers) => {
        registered.rpc = { definition, handlers, events: [] }
        return { events: { emit: async (name, data) => { registered.rpc.events.push({ name, data }) } } }
      },
    },
    shell: { hook: async (name, callback) => { registered.hooks[name] = callback } },
    tool: { transform: async (callback) => callback({ add: (definition) => registered.tools.push(definition) }) },
    agent: {
      transform: async (callback) => callback({
        list: () => [...registered.agents.values()],
        get: (id) => registered.agents.get(id),
        update: (id, update) => {
          const agent = registered.agents.get(id) ?? { id, name: id, mode: "primary", hidden: false, permissions: [] }
          registered.agents.set(id, agent)
          update(agent)
        },
      }),
    },
    skill: {
      transform: async (callback) => callback({
        get: (id) => registered.skills.find((skill) => skill.id === id),
        add: (skill) => registered.skills.push(skill),
      }),
    },
    command: { transform: async (callback) => callback({ add: (command) => registered.commands.push(command) }) },
    session: {
      hook: async (name, callback) => { registered.sessionHooks[name] = callback },
      get: async () => ({ agent: sessionAgent, model }),
      switchAgent: async (input) => { calls.push(["switchAgent", input]) },
      prompt: async (input) => { calls.push(["prompt", input]) },
    },
  }
  return { ctx, registered, calls }
}

function toolPermission(registered, agent, action) {
  return registered.agents.get(agent).permissions.findLast((rule) => rule.action === action || rule.action === "*"
    || rule.action.startsWith("*_") && action.endsWith(rule.action.slice(1)))?.effect
}

test("registers PRR commands, agents, skills, and binary environment", async () => {
  const hooks = await PrrPlugin.server()
  const config = {}

  hooks.config(config)

  assert.deepEqual(Object.keys(config.command).sort(), [
    "prr-cleanup",
    "prr-setup",
    "prr-start",
    "prr-stats",
  ])
  assert.deepEqual(Object.keys(config.agent).sort(), [
    "prr-arbiter",
    "prr-codex-reviewer",
    "prr-opencode-reviewer",
    "prr-orchestrator",
    "prr-setup-orchestrator",
    "prr-stats",
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
  assert.equal(typeof hooks.tool.prr_atlassian_context.execute, "function")
  assert.equal(typeof hooks.tool.prr_artifact.execute, "function")
  assert.equal(typeof hooks.tool.prr_bind_round.execute, "function")
  assert.equal(typeof hooks.tool.prr_capability.execute, "function")
  assert.equal(typeof hooks.tool.prr_read.execute, "function")
  assert.equal(typeof hooks.tool.prr_write.execute, "function")
  assert.equal(config.permission.prr_codex, "deny")
  assert.equal(config.permission.prr_read, "deny")
  assert.equal(config.agent["prr-orchestrator"].permission.bash["*"], "deny")
  assert.equal(config.agent["prr-orchestrator"].permission.task["*"], "allow")
  assert.equal(
    config.agent["prr-orchestrator"].permission.bash['"$PRR_BIN" parse-report "*/results/final-report.md" --diff "*/results/diff.txt"'],
    "allow",
  )
  assert.equal(
    config.agent["prr-orchestrator"].permission.bash['"$PRR_BIN" parse-report */results/final-report.md --diff */results/diff.txt'],
    "allow",
  )
  assert.equal(config.agent["prr-orchestrator"].permission.bash['printf \'%s\\n\' "$PRR_BIN" && "$PRR_BIN" config runtime'], "allow")
  assert.equal(config.agent["prr-orchestrator"].permission.bash['echo "$PRR_BIN"; "$PRR_BIN" config runtime'], "allow")
  assert.equal(config.agent["prr-orchestrator"].permission.prr_post_review, undefined)
  assert.equal(config.agent["prr-orchestrator"].permission.bash['"$PRR_BIN" post-review * --payload *'], "ask")
  assert.equal(config.agent["prr-orchestrator"].permission.prr_codex, "deny")
  const setupBash = config.agent["prr-setup-orchestrator"].permission.bash
  assert.equal(setupBash["bash -lc 'command -v gh'"], "allow")
  assert.equal(setupBash["bash -lc 'command -v git'"], "allow")
  assert.equal(setupBash["bash -lc 'command -v codex'"], "allow")
  assert.equal(setupBash["bash -lc 'gh auth status'"], "allow")
  assert.equal(setupBash["bash -lc 'codex login status'"], "allow")

  const output = { env: {} }
  hooks["shell.env"]({}, output)
  assert.match(output.env.PRR_BIN, /bin\/prr-darwin-universal$/)
})

test("does not replace user command or agent overrides", async () => {
  const hooks = await PrrPlugin.server()
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
  const hooks = await PrrPlugin.server()
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

test("Codex wrapper defaults the model, validates paths and strips process secrets", async () => {
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
  const fakeCodexTarget = join(bin, "codex-target")
  writeFileSync(fakeCodexTarget, `#!${process.execPath}
const fs = require("node:fs")
if (process.argv[1] !== fs.realpathSync(process.argv[1])) {
  process.stderr.write("Codex must be launched from its resolved executable path\\n")
  process.exit(42)
}
const modelIndex = process.argv.indexOf("--model")
if (modelIndex === -1 || process.argv[modelIndex + 1] !== "gpt-6-sol") {
  process.stderr.write("Codex must use GPT-6 Sol for reviews and health checks\\n")
  process.exit(43)
}
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
  symlinkSync(fakeCodexTarget, fakeCodex)
  chmodSync(fakeCodexTarget, 0o755)

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
    const hooks = await PrrPlugin.server()
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
    const orchestratorRequirement = await hooks.tool.prr_read.execute(
      { filePath: join(contextDirectory, "requirement.txt") },
      orchestrator,
    )
    assert.match(orchestratorRequirement, /must preserve compatibility/)
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
    assert.equal(captured.args[captured.args.indexOf("--model") + 1], "gpt-6-sol")
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

test("Codex reviews and health checks read the configured model on each call", async () => {
  const root = mkdtempSync(join(tmpdir(), "prr-codex-model-test-"))
  const home = join(root, "home")
  const configPath = join(home, ".prr", "config.yml")
  const round = join(home, ".prr", "workspace", "acme-repo-pr-2", "r1")
  const repo = join(round, "repo")
  const role = join(round, "results", "reviewers", "codex")
  const prompt = join(role, "review-prompt.md")
  const output = join(role, "review.md")
  const capture = join(root, "model.txt")
  const bin = join(root, "bin")
  mkdirSync(repo, { recursive: true })
  mkdirSync(role, { recursive: true })
  mkdirSync(join(round, "context"), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(prompt, "Review this change.")
  const fakeCodex = join(bin, "codex")
  writeFileSync(fakeCodex, `#!${process.execPath}
const fs = require("node:fs")
const model = process.argv[process.argv.indexOf("--model") + 1]
fs.writeFileSync(${JSON.stringify(capture)}, model)
const outputIndex = process.argv.indexOf("--output-last-message")
if (outputIndex === -1) process.stdout.write("HELLO\\n")
else fs.writeFileSync(process.argv[outputIndex + 1], model)
`)
  chmodSync(fakeCodex, 0o755)
  const previous = { HOME: process.env.HOME, PATH: process.env.PATH }
  process.env.HOME = home
  process.env.PATH = bin

  try {
    const hooks = await PrrPlugin.server()
    const orchestrator = { agent: "prr-orchestrator", sessionID: "model-orchestrator" }
    await hooks.tool.prr_bind_round.execute({ roundPath: round }, orchestrator)
    const capability = await hooks.tool.prr_capability.execute({ roundPath: round, role: "codex" }, orchestrator)
    const review = () => hooks.tool.prr_codex.execute({
      capability, promptPath: prompt, repoPath: repo, outputPath: output, timeoutSeconds: 30,
    }, { agent: "prr-codex-reviewer", sessionID: "model-reviewer" })
    const health = () => hooks.tool.prr_codex_health.execute({})

    for (const [yaml, expected] of [
      ["codex_timeout: 900", "gpt-6-sol"],
      ["codex_model: custom-codex-model", "custom-codex-model"],
      ["codex_model: ' another-model '", "another-model"],
    ]) {
      writeFileSync(configPath, yaml)
      await health()
      assert.equal(readFileSync(capture, "utf8"), expected)
      await review()
      assert.equal(readFileSync(output, "utf8"), expected)
    }

    for (const yaml of [
      "codex_model: ''", "codex_model: '  '", "codex_model: null",
      "codex_model: []", "codex_model: {}", "codex_model: 42",
    ]) {
      writeFileSync(configPath, yaml)
      await assert.rejects(health(), /codex_model must be a non-empty string/)
      await assert.rejects(review(), /codex_model must be a non-empty string/)
    }
    writeFileSync(configPath, "codex_model: [invalid yaml")
    await assert.rejects(health(), /Could not read PRR configuration/)
    await assert.rejects(review(), /Could not read PRR configuration/)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test("tool executors settle as promises instead of returning or throwing synchronously", async () => {
  const hooks = await PrrPlugin.server()
  const orchestrator = { agent: "prr-orchestrator", sessionID: "unbound-session" }
  const missing = join(tmpdir(), "prr-missing-round", "r1")
  const failingCalls = {
    prr_atlassian_context: { roundPath: missing },
    prr_bind_round: { roundPath: missing },
    prr_capability: { roundPath: missing, role: "opencode" },
    prr_read: { filePath: join(missing, "results", "review.md") },
    prr_write: { filePath: join(missing, "results", "review.md"), content: "x" },
    prr_artifact: { operation: "remove", targetPath: join(missing, "results", "review.md") },
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

test("exports one definition that OpenCode V1 and V2 both accept", () => {
  assert.equal(PrrPlugin.id, "opencode-prr")
  assert.equal(typeof PrrPlugin.server, "function")
  assert.equal(typeof PrrPlugin.setup, "function")
})

test("V2 setup registers PRR tools, agents, skills, commands, and binary environment", async () => {
  const { ctx, registered } = fakeV2Context({
    agents: [{ id: "build", name: "build", mode: "primary", hidden: false, permissions: [] }],
  })

  await PrrPlugin.setup(ctx)

  assert.deepEqual(registered.tools.map((item) => item.name).sort(), [
    "prr_artifact", "prr_atlassian_context", "prr_bind_round", "prr_capability", "prr_codex", "prr_codex_health", "prr_progress", "prr_read", "prr_stats_record", "prr_stats_summary", "prr_write",
  ])
  for (const item of registered.tools) assert.equal(item.options.codemode, false)
  const read = registered.tools.find((item) => item.name === "prr_read")
  assert.deepEqual(read.input.required, ["filePath"])
  assert.equal(read.input.properties.limit.maximum, 2000)

  assert.deepEqual([...registered.agents.keys()].sort(), [
    "build", "prr-arbiter", "prr-codex-reviewer", "prr-opencode-reviewer", "prr-orchestrator", "prr-setup-orchestrator", "prr-stats",
  ])
  const build = registered.agents.get("build")
  assert.ok(build.permissions.some((rule) => rule.action === "prr_read" && rule.effect === "deny"))

  const orchestrator = registered.agents.get("prr-orchestrator")
  assert.equal(orchestrator.mode, "primary")
  assert.match(orchestrator.system, /PRR/)
  assert.deepEqual(orchestrator.permissions[0], { action: "*", resource: "*", effect: "deny" })
  assert.ok(orchestrator.permissions.some((rule) => rule.action === "subagent"
    && rule.resource === "*" && rule.effect === "allow"))
  assert.ok(orchestrator.permissions.some((rule) => rule.action === "subagent" && rule.resource === "prr-arbiter"))
  assert.ok(orchestrator.permissions.some((rule) => rule.action === "shell"
    && rule.resource === '"$PRR_BIN" post-review * --payload *' && rule.effect === "ask"))
  assert.ok(orchestrator.permissions.some((rule) => rule.action === "shell"
    && rule.resource === '"$PRR_BIN" parse-report "*/results/final-report.md" --diff "*/results/diff.txt"'
    && rule.effect === "allow"))
  assert.ok(orchestrator.permissions.some((rule) => rule.action === "shell"
    && rule.resource === '"$PRR_BIN" parse-report */results/final-report.md --diff */results/diff.txt'
    && rule.effect === "allow"))
  assert.ok(orchestrator.permissions.some((rule) => rule.action === "shell"
    && rule.resource === 'printf \'%s\\n\' "$PRR_BIN" && "$PRR_BIN" config runtime' && rule.effect === "allow"))
  assert.ok(orchestrator.permissions.some((rule) => rule.action === "shell"
    && rule.resource === 'echo "$PRR_BIN"; "$PRR_BIN" config runtime' && rule.effect === "allow"))
  assert.ok(orchestrator.permissions.every((rule) => rule.action !== "bash" && rule.action !== "task"))
  const setup = registered.agents.get("prr-setup-orchestrator")
  assert.ok(setup.permissions.some((rule) => rule.action === "shell"
    && rule.resource === "bash -lc 'command -v gh'" && rule.effect === "allow"))
  assert.ok(setup.permissions.some((rule) => rule.action === "shell"
    && rule.resource === "bash -lc 'codex login status'" && rule.effect === "allow"))
  const codexReviewer = registered.agents.get("prr-codex-reviewer")
  assert.equal(codexReviewer.hidden, true)
  assert.ok(codexReviewer.permissions.some((rule) => rule.action === "external_directory"
    && !rule.resource.startsWith("~") && rule.resource.endsWith("/.prr/workspace/*/r*/repo/**")))

  assert.deepEqual(registered.skills.map((skill) => skill.id).sort(), ["prr-cleanup", "prr-setup", "prr-start", "prr-stats"])
  assert.match(registered.skills.find((skill) => skill.id === "prr-start").path, /skills\/prr-start\/SKILL\.md$/)
  assert.deepEqual(registered.commands.map((command) => command.name).sort(), ["prr-cleanup", "prr-setup", "prr-start", "prr-stats"])

  const event = { env: {} }
  registered.hooks["create.before"](event)
  assert.match(event.env.PRR_BIN, /bin\/prr-darwin-universal$/)
})

test("V2 commands switch to the PRR agent and forward arguments", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "prr-start-stats-"))
  const previousHome = process.env.HOME
  process.env.HOME = root
  t.after(() => { process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }) })
  const { ctx, registered, calls } = fakeV2Context()
  await PrrPlugin.setup(ctx)

  const start = registered.commands.find((command) => command.name === "prr-start")
  await start.execute({ sessionID: "session-1", prompt: { text: "acme/repo#1" }, delivery: "queue" })

  assert.deepEqual(calls[0], ["switchAgent", { sessionID: "session-1", agent: "prr-orchestrator" }])
  assert.equal(calls[1][0], "prompt")
  assert.equal(calls[1][1].sessionID, "session-1")
  assert.equal(calls[1][1].delivery, "queue")
  assert.match(calls[1][1].text, /exactly as `acme\/repo#1`/)
  const summary = registered.tools.find((tool) => tool.name === "prr_stats_summary")
  const stats = JSON.parse((await summary.execute({}, { agent: "prr-stats", sessionID: "stats", signal: new AbortController().signal })).content)
  assert.equal(stats.tracked_runs, 1)
  assert.equal(stats.completed_review_rounds, 0)
  assert.equal(toolPermission(registered, "prr-stats", "prr_stats_record"), "deny")
  assert.equal(toolPermission(registered, "prr-stats", "prr_read"), "deny")
})

test("statistics command preserves an active review agent and cannot mutate decisions", async () => {
  const { ctx, registered, calls } = fakeV2Context({ sessionAgent: "prr-orchestrator" })
  await PrrPlugin.setup(ctx)
  await registered.commands.find((command) => command.name === "prr-stats").execute({ sessionID: "review", prompt: { text: "acme/repo#1" }, delivery: "steer" })
  assert.equal(calls[0][0], "prompt")
  assert.match(calls[0][1].text, /acme\/repo#1/)
  await assert.rejects(registered.tools.find((tool) => tool.name === "prr_stats_record").execute({ operation: "finish", status: "posted" }, { agent: "prr-stats", sessionID: "review" }), /not allowed/)
})

test("V2 automatically records starts, bound rounds, final attribution, model identity, and explicit decisions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "prr-statistics-flow-"))
  const previousHome = process.env.HOME
  process.env.HOME = root
  t.after(() => { process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }) })
  const round = join(root, ".prr/workspace/acme-repo-pr-1/r1")
  mkdirSync(join(round, "results/arbiter"), { recursive: true })
  mkdirSync(join(round, "results/reviewers/opencode"), { recursive: true })
  writeFileSync(join(round, "context-manifest.md"), "# Context Manifest\n\n- **Round**: r1\n")
  writeFileSync(join(round, "results/pr-metadata.json"), JSON.stringify({ url: "https://github.com/acme/repo/pull/1" }))
  const report = "## Final Report\n\n### Verdict\n\nCOMMENT\n\n### Confidence\n\nHIGH\n\n### Findings\n\n#### Trigger: Logic Bug\n\n##### F-01 — A concern\n\n- **Severity:** MED\n- **Anchor:** none\n- **Origin:** introduced\n- **Why this matters:** Wrong behavior.\n- **Suggested fix:** Correct it.\n- **Suggested comment:** Please correct it.\n"
  for (const role of ["opencode", "codex"]) writeFileSync(join(round, `results/${role}-review.md`), report)
  const metrics = { version: 1, agreement: { status: "reached", round: 0, reason: "Matching original reviews." }, assessments: ["opencode", "codex"].map((reviewer) => ({ reviewer, finding_id: "F-01", outcome: "validated", final_finding_ids: ["F-01"], reason: "Same supported claim." })) }
  const output = join(round, "results/arbiter/output.md")
  writeFileSync(output, report + "\n### Review Statistics\n\n```json\n" + JSON.stringify(metrics) + "\n```\n")
  const promptPath = join(round, "results/reviewers/opencode/review-prompt.md")
  writeFileSync(promptPath, "Review the supplied source.")
  const { ctx, registered } = fakeV2Context({ model: { id: "parent-model", providerID: "provider" } })
  await PrrPlugin.setup(ctx)
  await registered.commands.find((command) => command.name === "prr-start").execute({ sessionID: "review", prompt: { text: "acme/repo#1" }, delivery: "steer" })
  const context = { sessionID: "review", agent: "prr-orchestrator", signal: new AbortController().signal }
  const tool = (name) => registered.tools.find((tool) => tool.name === name)
  await tool("prr_bind_round").execute({ roundPath: round }, context)
  const capability = (await tool("prr_capability").execute({ roundPath: round, role: "opencode" }, context)).content
  await tool("prr_read").execute({ filePath: promptPath, capability }, { ...context, sessionID: "native", agent: "prr-opencode-reviewer" })
  await registered.sessionHooks["model.request"]({ sessionID: "native", agent: "prr-opencode-reviewer", kind: "primary", model: { id: "actual-model", providerID: "provider" } })
  await tool("prr_artifact").execute({ operation: "copy", sourcePath: output, targetPath: join(round, "results/final-report.md") }, context)
  await tool("prr_stats_record").execute({ operation: "decision", finding_id: "F-01", status: "rejected", reason: "not_worth_raising" }, context)
  const summary = JSON.parse((await tool("prr_stats_summary").execute({}, { ...context, agent: "prr-stats" })).content)
  assert.equal(summary.tracked_runs, 1)
  assert.equal(summary.completed_review_rounds, 1)
  assert.equal(summary.totals.rejected, 1)
  assert.equal(summary.totals.incorrect, 0)
  assert.equal(summary.harnesses.find((item) => item.reviewer === "opencode").model, "provider/actual-model")
  assert.equal(summary.harnesses.find((item) => item.reviewer === "opencode").model_basis, "session_request")
  assert.ok(!JSON.stringify(summary).includes(root))
})

test("V2 MCP read permissions belong only to the orchestrator and are hidden from PRR model requests", async () => {
  const { ctx, registered } = fakeV2Context()
  await PrrPlugin.setup(ctx)
  const reads = [
    "atlassian_getAccessibleAtlassianResources", "atlassian_getJiraIssue",
    "atlassian_getConfluenceContent", "company_atlassian_getConfluencePage",
  ]
  for (const name of reads) assert.equal(toolPermission(registered, "prr-orchestrator", name), "allow")
  for (const name of ["atlassian_editJiraIssue", "atlassian_executeWrite", "atlassian_discover", "atlassian_getGraphObject"]) {
    assert.equal(toolPermission(registered, "prr-orchestrator", name), "deny")
  }
  for (const agent of ["prr-setup-orchestrator", "prr-opencode-reviewer", "prr-codex-reviewer", "prr-arbiter"]) {
    for (const name of reads) assert.equal(toolPermission(registered, agent, name), "deny")
  }
  for (const hook of ["context", "compaction", "generate"]) {
    for (const agent of [...registered.agents.keys(), "build"]) {
      const tools = Object.fromEntries([...reads, "prr_atlassian_context", "unrelated"].map((name) => [name, {}]))
      await registered.sessionHooks[hook]({ agent, tools })
      assert.deepEqual(Object.keys(tools), agent === "build" ? [...reads, "prr_atlassian_context", "unrelated"] : ["prr_atlassian_context", "unrelated"])
    }
  }
})

test("V2 tools refuse agents whose PRR rules do not allow them", async () => {
  const { ctx, registered } = fakeV2Context()
  await PrrPlugin.setup(ctx)
  const health = registered.tools.find((item) => item.name === "prr_codex_health")
  const codex = registered.tools.find((item) => item.name === "prr_codex")
  const signal = new AbortController().signal

  await assert.rejects(health.execute({}, { agent: "build", sessionID: "s", signal }), /not allowed for build/)
  await assert.rejects(
    codex.execute({}, { agent: "prr-orchestrator", sessionID: "s", signal }),
    /not allowed for prr-orchestrator/,
  )
  const bind = registered.tools.find((item) => item.name === "prr_bind_round")
  await assert.rejects(
    bind.execute({ roundPath: join(tmpdir(), "prr-missing-round", "r1") }, { agent: "prr-orchestrator", sessionID: "s", signal }),
  )
  const atlassian = registered.tools.find((item) => item.name === "prr_atlassian_context")
  const progress = registered.tools.find((item) => item.name === "prr_progress")
  for (const agent of ["build", "prr-opencode-reviewer", "prr-codex-reviewer", "prr-arbiter", "prr-setup-orchestrator"]) {
    await assert.rejects(atlassian.execute({}, { agent, sessionID: "s", signal }), /not allowed/)
    await assert.rejects(progress.execute({ step: 1, status: "completed" }, { agent, sessionID: "s", signal }), /not allowed/)
  }
})

test("V2 sidebar RPC persists session progress and exposes only the bound manifest summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "prr-sidebar-test-"))
  const previousHome = process.env.HOME
  process.env.HOME = root
  const round = join(root, ".prr", "workspace", "acme-repo-pr-1", "r1")
  mkdirSync(join(round, "results"), { recursive: true })
  writeFileSync(join(round, "context-manifest.md"), "# Context Manifest\n\n- **PRR**: v0.24.0\n- **Ticket**: [DI-1364](https://company.atlassian.net/browse/DI-1364)\n- **Round**: r1\n\n## Private context\n\nDo not expose reviewer artifacts.\n")
  try {
    const { ctx, registered } = fakeV2Context()
    await PrrPlugin.setup(ctx)
    const context = { agent: "prr-orchestrator", sessionID: "sidebar-test", signal: new AbortController().signal }
    const get = () => registered.rpc.handlers.get({ sessionID: context.sessionID })
    assert.equal(await get(), null)
    await assert.rejects(registered.rpc.handlers.investigation({ sessionID: context.sessionID }), /Continue from the review briefing/)
    const progress = registered.tools.find((tool) => tool.name === "prr_progress")
    assert.equal(progress.input.properties.step.maximum, 7)
    assert.deepEqual(progress.input.properties.view.enum, ["diff", "chat"])
    assert.ok(!progress.input.required.includes("view"))
    await progress.execute({ step: 1, status: "completed" }, context)
    await registered.tools.find((tool) => tool.name === "prr_bind_round").execute({ roundPath: round }, context)
    await progress.execute({ step: 2, status: "in_progress" }, context)
    const state = await get()
    assert.equal(state.steps[0].status, "completed")
    assert.equal(state.steps[1].status, "in_progress")
    assert.equal(state.steps[5].label, "Review briefing")
    assert.equal(state.steps[6].label, "Interactive investigation")
    assert.equal(state.summary.find((field) => field.label === "Ticket").url, "https://company.atlassian.net/browse/DI-1364")
    assert.deepEqual(Object.keys(state).sort(), ["steps", "summary"])
    assert.ok(!JSON.stringify(state).includes("Private context"))
    assert.equal(await registered.rpc.handlers.get({ sessionID: "unrelated-session" }), null)
    assert.ok(registered.rpc.events.every((event) => event.name === "updated" && event.data.sessionID === context.sessionID))
    await PrrPlugin.setup(ctx)
    assert.deepEqual(await get(), state)
    await progress.execute({ step: 6, status: "in_progress" }, context)
    assert.equal((await get()).steps[6].status, "pending")
    await progress.execute({ step: 6, status: "completed" }, context)
    await progress.execute({ step: 7, status: "in_progress", view: "diff" }, context)
    assert.equal((await get()).steps[6].status, "in_progress")
    const pendingDiff = await registered.rpc.handlers.pendingDiff({ sessionID: context.sessionID })
    assert.equal(typeof pendingDiff.diffRequest, "string")
    assert.equal(registered.rpc.events.at(-1).name, "openDiff")
    assert.equal(registered.rpc.events.at(-1).data.diffRequest, pendingDiff.diffRequest)
    assert.deepEqual(Object.keys(await get()).sort(), ["steps", "summary"])
    writeFileSync(join(round, "results/final-report.md"), "## Verdict\n\nAPPROVE\n\n## Confidence\n\nHIGH\n")
    writeFileSync(join(round, "results/diff.txt"), "diff --git a/test.rb b/test.rb\n--- a/test.rb\n+++ b/test.rb\n@@ -1 +1 @@\n-old\n+new\n")
    const investigation = await registered.rpc.handlers.investigation({ sessionID: context.sessionID })
    assert.equal(investigation.verdict, "APPROVE")
    assert.equal(investigation.files[0].path, "test.rb")
    assert.deepEqual(investigation.findings, [])
    assert.ok(!JSON.stringify(investigation).includes(round))
    await assert.rejects(registered.rpc.handlers.investigation({ sessionID: "unrelated-session" }), /Continue from the review briefing/)
    assert.ok((await registered.rpc.handlers.diff({ sessionID: context.sessionID, snapshot: investigation.snapshot, fileID: "0" })).patch.includes("+new"))
    await assert.rejects(progress.execute({ step: 8, status: "pending" }, context), /Invalid PRR progress/)
    await registered.commands.find((command) => command.name === "prr-start").execute({
      sessionID: context.sessionID, prompt: { text: "acme/repo#1" }, delivery: "steer",
    })
    assert.equal((await get()).summary.length, 0)
    assert.ok((await get()).steps.every((step) => step.status === "pending"))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
})

test("V2 restores only the saved session round after a restart and requires fresh reviewer capabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "prr-restart-test-"))
  const previousHome = process.env.HOME
  process.env.HOME = root
  const round = join(root, ".prr", "workspace", "acme-repo-pr-1", "r1")
  const otherRound = join(root, ".prr", "workspace", "acme-repo-pr-2", "r1")
  for (const path of [round, otherRound]) {
    mkdirSync(join(path, "results", "reviewers", "opencode"), { recursive: true })
    writeFileSync(join(path, "context-manifest.md"), "# Context Manifest\n\n- **Round**: r1\n")
  }
  const prompt = join(round, "results", "reviewers", "opencode", "review-prompt.md")
  writeFileSync(prompt, "Saved review prompt")
  const context = { agent: "prr-orchestrator", sessionID: "restart-test", signal: new AbortController().signal }
  const reviewer = { ...context, agent: "prr-opencode-reviewer", sessionID: "old-reviewer" }
  try {
    const before = fakeV2Context()
    await PrrPlugin.setup(before.ctx)
    const oldTool = (name) => before.registered.tools.find((tool) => tool.name === name)
    await oldTool("prr_bind_round").execute({ roundPath: round }, context)
    const oldCapability = (await oldTool("prr_capability").execute({ roundPath: round, role: "opencode" }, context)).content
    await oldTool("prr_read").execute({ filePath: prompt, capability: oldCapability }, reviewer)

    const { default: restarted } = await import("../index.js?restart-test")
    const after = fakeV2Context()
    after.ctx.storage = before.ctx.storage
    await restarted.setup(after.ctx)
    const tool = (name) => after.registered.tools.find((tool) => tool.name === name)
    await assert.rejects(tool("prr_read").execute({ filePath: prompt }, { ...context, sessionID: "unrelated" }), /not bound/)
    assert.match((await tool("prr_read").execute({ filePath: prompt }, context)).content, /Saved review prompt/)
    await assert.rejects(tool("prr_read").execute({ filePath: join(otherRound, "context-manifest.md") }, context), /not bound/)
    await assert.rejects(tool("prr_bind_round").execute({ roundPath: otherRound }, context), /already bound/)
    await assert.rejects(tool("prr_read").execute({ filePath: prompt, capability: oldCapability }, reviewer), /Invalid PRR round capability/)
    const capability = (await tool("prr_capability").execute({ roundPath: round, role: "opencode" }, context)).content
    assert.notEqual(capability, oldCapability)
    assert.match((await tool("prr_read").execute({ filePath: prompt, capability }, { ...reviewer, sessionID: "new-reviewer" })).content, /Saved review prompt/)
    const sidebar = await after.registered.rpc.handlers.get({ sessionID: context.sessionID })
    assert.deepEqual(Object.keys(sidebar).sort(), ["steps", "summary"])
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
})

test("V2 context tool retries unavailable MCP context and caches successful imports before reviews", async () => {
  const root = mkdtempSync(join(tmpdir(), "prr-atlassian-test-"))
  const home = join(root, "home")
  const workspace = join(home, ".prr", "workspace")
  const round = join(workspace, "acme-repo-pr-1", "r1")
  mkdirSync(join(round, "results"), { recursive: true })
  mkdirSync(join(round, "context"))
  writeFileSync(join(round, "context-manifest.md"), "# Context Manifest\n\n- **Ticket**: DI-123\n")
  writeFileSync(join(round, "results", "ticket-id.txt"), "DI-123")
  writeFileSync(join(round, "results", "pr-metadata.json"), JSON.stringify({ title: "DI-123" }))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const { ctx, registered } = fakeV2Context()
    const calls = []
    let connected = false
    ctx.mcp = { list: async () => ({ data: [{ name: "atlassian", status: { status: connected ? "connected" : "needs_auth" } }] }) }
    ctx.tool.list = async () => [
      { id: "atlassian_getAccessibleAtlassianResources", execute: async (_input, execution) => {
        assert.equal(execution.agent, "prr-orchestrator")
        assert.equal(toolPermission(registered, execution.agent, "atlassian_getAccessibleAtlassianResources"), "allow")
        calls.push("sites")
        return { content: JSON.stringify({ data: { resources: [{ cloudId: "site-1", url: "https://company.atlassian.net" }] } }) }
      } },
      { id: "atlassian_getJiraIssue", input: { properties: { view: {} } }, execute: async (input, execution) => {
        assert.equal(execution.agent, "prr-orchestrator")
        assert.equal(toolPermission(registered, execution.agent, "atlassian_getJiraIssue"), "allow")
        calls.push(input)
        return { content: JSON.stringify({ key: "DI-123", fields: { summary: "Requirements", description: "Preserve ordering" } }) }
      } },
    ]
    await PrrPlugin.setup(ctx)
    const context = { agent: "prr-orchestrator", sessionID: "atlassian-test", signal: new AbortController().signal }
    const fetch = registered.tools.find((item) => item.name === "prr_atlassian_context")
    await assert.rejects(fetch.execute({ roundPath: round }, context), /not bound/)
    assert.equal(calls.length, 0)
    await registered.tools.find((item) => item.name === "prr_bind_round").execute({ roundPath: round }, context)
    const unavailable = await fetch.execute({ roundPath: round }, context)
    assert.match(unavailable.content, /Jira ticket: unavailable/)
    assert.equal(calls.length, 0)
    connected = true
    const result = await fetch.execute({ roundPath: round }, context)
    assert.match(result.content, /Source: Atlassian MCP/)
    const sidebar = await registered.rpc.handlers.get({ sessionID: context.sessionID })
    assert.equal(sidebar.summary.find((field) => field.label === "Ticket").url, "https://company.atlassian.net/browse/DI-123")
    assert.match(readFileSync(join(round, "context", "ticket-context.md"), "utf8"), /Preserve ordering/)
    const manifest = readFileSync(join(round, "context-manifest.md"), "utf8")
    assert.equal(manifest.split("## Atlassian Context").length, 2)
    assert.doesNotMatch(manifest, /Jira ticket: unavailable/)
    assert.equal(JSON.parse(readFileSync(join(round, "results", "atlassian-context.json"), "utf8")).source, "mcp")
    assert.deepEqual(calls, ["sites", { cloudId: "site-1", issueIdOrKey: "DI-123", view: "full" }])
    await fetch.execute({ roundPath: round }, context)
    assert.equal(calls.length, 2)
    writeFileSync(join(round, "results", "review-prompt.md"), "Review prompt")
    await assert.rejects(fetch.execute({ roundPath: round }, context), /before reviewer prompts/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
})
