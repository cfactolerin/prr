import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import PrrPlugin from "../index.js"

function fakeV2Context({
  agents = [{ id: "build", name: "build", mode: "primary", hidden: false, permissions: [] }],
  sessionAgent = "build",
} = {}) {
  const registered = { hooks: {}, tools: [], agents: new Map(agents.map((agent) => [agent.id, agent])), skills: [], commands: [] }
  const calls = []
  const sessionAgents = new Map()
  const toolTransforms = []
  const reloadTools = () => {
    const tools = new Map()
    const editor = { add: (definition) => tools.set(definition.name, definition) }
    for (const transform of toolTransforms) transform(editor)
    registered.tools.splice(0, registered.tools.length, ...tools.values())
  }
  const ctx = {
    shell: { hook: async (name, callback) => { registered.hooks[name] = callback } },
    tool: {
      transform: async (callback) => { toolTransforms.push(callback); reloadTools() },
      reload: async () => reloadTools(),
    },
    agent: {
      get: async ({ agentID }) => ({ data: registered.agents.get(agentID) }),
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
      hook: async (name, callback) => { registered.hooks[name] = callback },
      get: async ({ sessionID }) => ({ agent: sessionAgents.get(sessionID) ?? sessionAgent }),
      switchAgent: async (input) => {
        calls.push(["switchAgent", input])
        sessionAgents.set(input.sessionID, input.agent)
      },
      prompt: async (input) => { calls.push(["prompt", input]) },
    },
  }
  return { ctx, registered, calls }
}

async function fakeV2Round(t) {
  const root = mkdtempSync(join(tmpdir(), "prr-v2-tools-test-"))
  const home = join(root, "home")
  const round = join(home, ".prr", "workspace", "acme-repo-pr-1", "r1")
  mkdirSync(join(round, "results"), { recursive: true })
  const previousHome = process.env.HOME
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  })
  process.env.HOME = home
  const fake = fakeV2Context()
  await PrrPlugin.setup(fake.ctx)
  const command = fake.registered.commands.find((item) => item.name === "prr-start")
  const start = (sessionID) => command.execute({ sessionID, prompt: { text: "acme/repo#1" }, delivery: "steer" })
  return { ...fake, round, start }
}

test("registers PRR commands, agents, skills, and binary environment", async () => {
  const hooks = await PrrPlugin.server()
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
    "prr_artifact", "prr_atlassian_context", "prr_bind_round", "prr_capability", "prr_codex", "prr_codex_health", "prr_read", "prr_write",
  ])
  for (const item of registered.tools) assert.equal(item.options.codemode, false)
  const read = registered.tools.find((item) => item.name === "prr_read")
  assert.deepEqual(read.input.required, ["filePath"])
  assert.equal(read.input.properties.limit.maximum, 2000)

  assert.deepEqual([...registered.agents.keys()].sort(), [
    "build", "prr-arbiter", "prr-codex-reviewer", "prr-opencode-reviewer", "prr-orchestrator", "prr-setup-orchestrator",
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

  assert.deepEqual(registered.skills.map((skill) => skill.id).sort(), ["prr-cleanup", "prr-setup", "prr-start"])
  assert.match(registered.skills.find((skill) => skill.id === "prr-start").path, /skills\/prr-start\/SKILL\.md$/)
  assert.deepEqual(registered.commands.map((command) => command.name).sort(), ["prr-cleanup", "prr-setup", "prr-start"])

  const event = { env: {} }
  registered.hooks["create.before"](event)
  assert.match(event.env.PRR_BIN, /bin\/prr-darwin-universal$/)
})

test("V2 commands switch to the PRR agent and forward arguments", async () => {
  const { ctx, registered, calls } = fakeV2Context()
  await PrrPlugin.setup(ctx)

  const start = registered.commands.find((command) => command.name === "prr-start")
  await start.execute({ sessionID: "session-1", prompt: { text: "acme/repo#1" }, delivery: "steer" })

  assert.deepEqual(calls[0], ["switchAgent", { sessionID: "session-1", agent: "prr-orchestrator" }])
  assert.equal(calls[1][0], "prompt")
  assert.equal(calls[1][1].sessionID, "session-1")
  assert.equal(calls[1][1].delivery, "steer")
  assert.match(calls[1][1].text, /exactly as `acme\/repo#1`/)
})

test("V2 refuses queued review starts before switching or submitting", async () => {
  const { ctx, registered, calls } = fakeV2Context()
  await PrrPlugin.setup(ctx)
  const start = registered.commands.find((command) => command.name === "prr-start")
  await assert.rejects(
    start.execute({ sessionID: "queued", prompt: { text: "acme/repo#1" }, delivery: "queue" }),
    /queued/i,
  )
  assert.deepEqual(calls, [])
  assert.equal((await ctx.session.get({ sessionID: "queued" })).agent, "build")
})

test("V2 refuses a second review start without submitting more work", async () => {
  const { ctx, registered, calls } = fakeV2Context()
  await PrrPlugin.setup(ctx)
  const start = registered.commands.find((command) => command.name === "prr-start")
  const input = { sessionID: "duplicate", prompt: { text: "acme/repo#1" }, delivery: "steer" }
  await start.execute(input)
  const admittedCalls = calls.length
  await assert.rejects(start.execute(input), /already active/i)
  assert.equal(calls.length, admittedCalls)
})

test("V2 reserves startup before the first session lookup settles", async () => {
  const { ctx, registered } = fakeV2Context()
  await PrrPlugin.setup(ctx)
  const start = registered.commands.find((command) => command.name === "prr-start")
  const input = { sessionID: "pending-lookup", prompt: { text: "acme/repo#1" }, delivery: "steer" }
  let finishLookup
  const lookup = new Promise((resolve) => { finishLookup = resolve })
  let reads = 0
  ctx.session.get = async () => { reads++; return lookup }
  const first = start.execute(input)
  const duplicate = assert.rejects(start.execute(input), /already active/i)
  try {
    await Promise.resolve()
    assert.equal(reads, 1)
  } finally {
    finishLookup({ agent: "build" })
    await first
    await duplicate
  }
})

for (const { label, selected, definition } of [
  { label: "null", selected: null },
  { label: "empty", selected: "" },
  { label: "blank", selected: " " },
  { label: "missing", selected: "missing" },
  { label: "hidden", selected: "custom", definition: { mode: "primary", hidden: true } },
  { label: "subagent", selected: "custom", definition: { mode: "subagent", hidden: false } },
  { label: "PRR", selected: "prr-orchestrator" },
]) {
  test(`V2 rejects the ${label} return agent without takeover and permits retry`, async () => {
    const { ctx, registered, calls } = fakeV2Context({ sessionAgent: selected })
    await PrrPlugin.setup(ctx)
    if (definition) registered.agents.set("custom", { id: "custom", ...definition, permissions: [] })
    const start = registered.commands.find((command) => command.name === "prr-start")
    const input = { sessionID: "invalid-return", prompt: { text: "acme/repo#1" }, delivery: "steer" }
    await assert.rejects(start.execute(input), /return agent|coding agent/)
    assert.deepEqual(calls, [])
    await ctx.session.switchAgent({ sessionID: input.sessionID, agent: "build" })
    await start.execute(input)
  })
}

for (const mode of ["primary", "all"]) {
  test(`V2 accepts a custom ${mode} return agent`, async () => {
    const { ctx, registered, calls } = fakeV2Context({ sessionAgent: "custom" })
    await PrrPlugin.setup(ctx)
    registered.agents.set("custom", { id: "custom", mode, hidden: false, permissions: [] })
    const start = registered.commands.find((command) => command.name === "prr-start")
    await start.execute({ sessionID: "custom-return", prompt: { text: "acme/repo#1" }, delivery: "steer" })
    assert.equal(calls[0][1].agent, "prr-orchestrator")
    assert.equal(calls[1][0], "prompt")
  })
}

for (const domain of ["session", "agent"]) {
  test(`V2 permits retry after a failed ${domain} lookup`, async () => {
    const { ctx, registered, calls } = fakeV2Context()
    await PrrPlugin.setup(ctx)
    const start = registered.commands.find((command) => command.name === "prr-start")
    const input = { sessionID: "failed-lookup", prompt: { text: "acme/repo#1" }, delivery: "steer" }
    const lookup = ctx[domain].get
    const failure = new Error("Lookup failed")
    ctx[domain].get = async () => { throw failure }
    await assert.rejects(start.execute(input), (error) => error === failure)
    assert.deepEqual(calls, [])
    ctx[domain].get = lookup
    await start.execute(input)
  })
}

test("V2 preserves an agent selected manually during startup", async () => {
  const { ctx, registered, calls } = fakeV2Context()
  await PrrPlugin.setup(ctx)
  const start = registered.commands.find((command) => command.name === "prr-start")
  const lookup = ctx.agent.get
  ctx.agent.get = async (input) => {
    await ctx.session.switchAgent({ sessionID: "manual-start", agent: "plan" })
    return lookup(input)
  }
  await assert.rejects(
    start.execute({ sessionID: "manual-start", prompt: { text: "acme/repo#1" }, delivery: "steer" }),
    /agent changed/i,
  )
  assert.equal((await ctx.session.get({ sessionID: "manual-start" })).agent, "plan")
  assert.equal(calls.filter(([name]) => name === "prompt").length, 0)
})

test("V2 tool snapshots cannot acquire authority from later review starts", async (t) => {
  const { registered, round, start } = await fakeV2Round(t)
  const beforeStart = registered.tools.find((item) => item.name === "prr_bind_round")
  const context = (sessionID) => ({ agent: "prr-orchestrator", sessionID, signal: new AbortController().signal })
  await start("snapshot-one")
  await assert.rejects(beforeStart.execute({ roundPath: round }, context("snapshot-one")), /not active/)
  const firstReview = registered.tools.find((item) => item.name === "prr_bind_round")
  await start("snapshot-two")
  const latest = registered.tools.find((item) => item.name === "prr_bind_round")
  await assert.rejects(firstReview.execute({ roundPath: round }, context("snapshot-two")), /not active/)
  assert.match((await firstReview.execute({ roundPath: round }, context("snapshot-one"))).content, /Bound PRR session/)
  assert.match((await latest.execute({ roundPath: round }, context("snapshot-two"))).content, /Bound PRR session/)
})

test("V2 assigns owned startup input IDs without changing other commands", async () => {
  const { ctx, registered, calls } = fakeV2Context()
  await PrrPlugin.setup(ctx)
  const execute = (name, sessionID) => registered.commands.find((item) => item.name === name).execute({
    sessionID, prompt: { text: "acme/repo#1" }, delivery: "steer",
  })
  await execute("prr-start", "input-one")
  await execute("prr-start", "input-two")
  await execute("prr-cleanup", "cleanup-input")
  await execute("prr-setup", "setup-input")
  const prompts = calls.filter(([name]) => name === "prompt").map(([, input]) => input)
  assert.match(prompts[0].id, /^msg_[0-9a-f-]{36}$/)
  assert.match(prompts[1].id, /^msg_[0-9a-f-]{36}$/)
  assert.notEqual(prompts[0].id, prompts[1].id)
  assert.equal(prompts[2].id, undefined)
  assert.equal(prompts[3].id, undefined)
  assert.equal(typeof registered.hooks.context, "function")
  assert.equal(typeof registered.hooks.compaction, "function")
})

test("V2 canceled orchestrator tool calls cannot write an artifact", async (t) => {
  const { registered, round, start } = await fakeV2Round(t)
  await start("cancelled-write")
  const signal = new AbortController().signal
  const context = { agent: "prr-orchestrator", sessionID: "cancelled-write", signal }
  await registered.tools.find((item) => item.name === "prr_bind_round").execute({ roundPath: round }, context)
  const cancelled = new AbortController()
  cancelled.abort()
  const target = join(round, "results", "cancelled.txt")
  await assert.rejects(
    registered.tools.find((item) => item.name === "prr_write").execute(
      { filePath: target, content: "Must not be written" }, { ...context, signal: cancelled.signal },
    ),
    { name: "AbortError" },
  )
  assert.equal(existsSync(target), false)
})

test("V2 rolls back a failed tool refresh before prompt admission", async () => {
  const { ctx, registered, calls } = fakeV2Context()
  await PrrPlugin.setup(ctx)
  const start = registered.commands.find((item) => item.name === "prr-start")
  const input = { sessionID: "failed-refresh", prompt: { text: "acme/repo#1" }, delivery: "steer" }
  const reload = ctx.tool.reload
  const failure = new Error("Tool refresh failed")
  ctx.tool.reload = async () => { throw failure }
  await assert.rejects(start.execute(input), (error) => error === failure)
  assert.equal((await ctx.session.get({ sessionID: input.sessionID })).agent, "build")
  assert.equal(calls.filter(([name]) => name === "prompt").length, 0)
  ctx.tool.reload = reload
  await start.execute(input)
})

for (const failurePoint of ["restore", "lookup"]) {
  test(`V2 revokes failed startup dispatch when refresh and rollback fail (${failurePoint})`, async (t) => {
    const { ctx, registered, calls, round, start } = await fakeV2Round(t)
    const sessionID = `refresh-rollback-${failurePoint}`
    const reload = ctx.tool.reload
    const switchAgent = ctx.session.switchAgent
    const getSession = ctx.session.get
    const refreshError = new Error("Tool refresh failed")
    const rollbackError = new Error("Rollback failed")
    let rollingBack = false
    let captured
    ctx.tool.reload = async () => {
      await reload()
      captured = [...registered.tools]
      rollingBack = true
      throw refreshError
    }
    ctx.session.switchAgent = async (input) => {
      if (rollingBack && failurePoint === "restore") throw rollbackError
      return switchAgent(input)
    }
    ctx.session.get = async (input) => {
      if (rollingBack && failurePoint === "lookup") throw rollbackError
      return getSession(input)
    }

    await assert.rejects(start(sessionID), (error) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [refreshError, rollbackError])
      return true
    })
    ctx.tool.reload = reload
    ctx.session.switchAgent = switchAgent
    ctx.session.get = getSession
    assert.equal((await getSession({ sessionID })).agent, "prr-orchestrator")
    assert.equal(calls.filter(([name]) => name === "prompt").length, 0)
    await assert.rejects(start(sessionID), /already active/)

    const context = { agent: "prr-orchestrator", sessionID, signal: new AbortController().signal }
    const target = join(round, "results", "failed-start.txt")
    const refusesDispatch = async (tools) => {
      await assert.rejects(tools.find((item) => item.name === "prr_bind_round").execute({ roundPath: round }, context), /not active/)
      await assert.rejects(tools.find((item) => item.name === "prr_write").execute({ filePath: target, content: "Must not be written" }, context), /not active/)
      assert.equal(existsSync(target), false)
    }
    await refusesDispatch(captured)
    await reload()
    await refusesDispatch(registered.tools)
    await start("healthy-refresh")
    await refusesDispatch(registered.tools)
  })
}

for (const failurePoint of ["before", "after", "manual"]) {
  test(`V2 recovers a failed agent switch (${failurePoint})`, async () => {
    const { ctx, registered, calls } = fakeV2Context()
    await PrrPlugin.setup(ctx)
    const start = registered.commands.find((command) => command.name === "prr-start")
    const input = { sessionID: "failed-switch", prompt: { text: "acme/repo#1" }, delivery: "steer" }
    const switchAgent = ctx.session.switchAgent
    ctx.session.switchAgent = async (selection) => {
      if (selection.agent !== "prr-orchestrator") return switchAgent(selection)
      if (failurePoint !== "before") await switchAgent(selection)
      if (failurePoint === "manual") await switchAgent({ ...selection, agent: "plan" })
      throw new Error("Agent switch failed")
    }

    await assert.rejects(start.execute(input), /Agent switch failed/)
    assert.equal(
      (await ctx.session.get({ sessionID: input.sessionID })).agent,
      failurePoint === "manual" ? "plan" : "build",
    )
    assert.equal(calls.filter(([name]) => name === "prompt").length, 0)

    ctx.session.switchAgent = switchAgent
    await switchAgent({ sessionID: input.sessionID, agent: "build" })
    await start.execute(input)
  })
}

for (const failurePoint of ["restore", "lookup"]) {
  test(`V2 retains recovery ownership when rollback fails (${failurePoint})`, async () => {
    const { ctx, registered } = fakeV2Context()
    await PrrPlugin.setup(ctx)
    const start = registered.commands.find((command) => command.name === "prr-start")
    const input = { sessionID: "rollback-failure", prompt: { text: "acme/repo#1" }, delivery: "steer" }
    const switchAgent = ctx.session.switchAgent
    const getSession = ctx.session.get
    const takeoverError = new Error("Takeover failed")
    const rollbackError = new Error("Rollback failed")
    let rollingBack = false
    ctx.session.switchAgent = async (selection) => {
      if (rollingBack) throw rollbackError
      await switchAgent(selection)
      rollingBack = true
      throw takeoverError
    }
    ctx.session.get = async (selection) => {
      if (rollingBack && failurePoint === "lookup") throw rollbackError
      return getSession(selection)
    }

    await assert.rejects(start.execute(input), (error) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [takeoverError, rollbackError])
      return true
    })
    ctx.session.switchAgent = switchAgent
    ctx.session.get = getSession
    assert.equal((await getSession({ sessionID: input.sessionID })).agent, "prr-orchestrator")
    await assert.rejects(start.execute(input), /already active/i)
  })
}

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
  for (const agent of ["build", "prr-opencode-reviewer", "prr-codex-reviewer", "prr-arbiter", "prr-setup-orchestrator"]) {
    await assert.rejects(atlassian.execute({}, { agent, sessionID: "s", signal }), /not allowed/)
  }
})

test("V2 context tool saves a read-only MCP snapshot in the bound round before reviews", async () => {
  const root = mkdtempSync(join(tmpdir(), "prr-atlassian-test-"))
  const home = join(root, "home")
  const workspace = join(home, ".prr", "workspace")
  const round = join(workspace, "acme-repo-pr-1", "r1")
  mkdirSync(join(round, "results"), { recursive: true })
  mkdirSync(join(round, "context"))
  writeFileSync(join(round, "context-manifest.md"), "# Context Manifest\n")
  writeFileSync(join(round, "results", "ticket-id.txt"), "DI-123")
  writeFileSync(join(round, "results", "pr-metadata.json"), JSON.stringify({ title: "DI-123" }))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const { ctx, registered } = fakeV2Context()
    const calls = []
    ctx.mcp = { list: async () => ({ data: [{ name: "atlassian", status: { status: "connected" } }] }) }
    ctx.tool.list = async () => [
      { id: "atlassian_getAccessibleAtlassianResources", execute: async () => {
        calls.push("sites")
        return { content: JSON.stringify([{ id: "site-1", url: "https://company.atlassian.net" }]) }
      } },
      { id: "atlassian_getJiraIssue", input: { properties: { view: {} } }, execute: async (input) => {
        calls.push(input)
        return { content: JSON.stringify({ key: "DI-123", fields: { summary: "Requirements", description: "Preserve ordering" } }) }
      } },
    ]
    await PrrPlugin.setup(ctx)
    await registered.commands.find((item) => item.name === "prr-start").execute({
      sessionID: "atlassian-test", prompt: { text: "acme/repo#1" }, delivery: "steer",
    })
    const context = { agent: "prr-orchestrator", sessionID: "atlassian-test", signal: new AbortController().signal }
    const fetch = registered.tools.find((item) => item.name === "prr_atlassian_context")
    await assert.rejects(fetch.execute({ roundPath: round }, context), /not bound/)
    assert.equal(calls.length, 0)
    await registered.tools.find((item) => item.name === "prr_bind_round").execute({ roundPath: round }, context)
    const result = await fetch.execute({ roundPath: round }, context)
    assert.match(result.content, /Source: Atlassian MCP/)
    assert.match(readFileSync(join(round, "context", "ticket-context.md"), "utf8"), /Preserve ordering/)
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

test("V2 cancellation during a delayed MCP read prevents a late snapshot", { timeout: 5000 }, async (t) => {
  const { ctx, registered, round, start } = await fakeV2Round(t)
  const manifest = join(round, "context-manifest.md")
  writeFileSync(manifest, "# Context Manifest\n")
  writeFileSync(join(round, "results", "ticket-id.txt"), "DI-123")
  writeFileSync(join(round, "results", "pr-metadata.json"), JSON.stringify({ title: "DI-123" }))
  let readStarted
  const ready = new Promise((resolve) => { readStarted = resolve })
  let completeRead
  const pending = new Promise((resolve) => { completeRead = resolve })
  ctx.mcp = { list: async () => ({ data: [{ name: "atlassian", status: { status: "connected" } }] }) }
  ctx.tool.list = async () => [
    { id: "atlassian_getAccessibleAtlassianResources", execute: async () => ({ content: JSON.stringify([{ id: "site-1", url: "https://company.atlassian.net" }]) }) },
    { id: "atlassian_getJiraIssue", execute: async () => { readStarted(); return pending } },
  ]
  await start("delayed-mcp")
  const cancelled = new AbortController()
  const context = { agent: "prr-orchestrator", sessionID: "delayed-mcp", signal: cancelled.signal }
  await registered.tools.find((item) => item.name === "prr_bind_round").execute({ roundPath: round }, context)
  const fetch = registered.tools.find((item) => item.name === "prr_atlassian_context")
  const rejected = assert.rejects(fetch.execute({ roundPath: round }, context), { name: "AbortError" })
  try {
    await ready
    cancelled.abort()
  } finally {
    completeRead({ content: JSON.stringify({ key: "DI-123", fields: { summary: "Late requirements" } }) })
  }
  await rejected
  assert.equal(existsSync(join(round, "results", "atlassian-context.json")), false)
  assert.equal(existsSync(join(round, "context", "ticket-context.md")), false)
  assert.equal(readFileSync(manifest, "utf8"), "# Context Manifest\n")
})
