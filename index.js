import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tool } from "@opencode-ai/plugin"
import { parse } from "yaml"

const packageRoot = dirname(fileURLToPath(import.meta.url))
const assetRoot = join(packageRoot, ".opencode")
const binary = join(packageRoot, "bin", "prr-darwin-universal")
const defaultCodexModel = "gpt-6-sol"
const sessionRounds = new Map()
const capabilities = new Map()

function canonicalPath(path) {
  const resolved = resolve(path)
  return existsSync(resolved) ? realpathSync(resolved) : resolved
}

function readMarkdown(relativePath) {
  const source = readFileSync(join(assetRoot, relativePath), "utf8")
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) throw new Error(`invalid frontmatter in ${relativePath}`)
  return { metadata: parse(match[1]) ?? {}, body: match[2].trim() }
}

function configuredWorkspace() {
  const configPath = join(homedir(), ".prr", "config.yml")
  if (!existsSync(configPath)) return canonicalPath(join(homedir(), ".prr", "workspace"))

  try {
    const config = parse(readFileSync(configPath, "utf8")) ?? {}
    const value = config.workspace_path
    if (typeof value !== "string" || value.trim() === "") {
      return canonicalPath(join(homedir(), ".prr", "workspace"))
    }
    const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value
    return canonicalPath(expanded)
  } catch {
    return canonicalPath(join(homedir(), ".prr", "workspace"))
  }
}

function configuredCodexModel() {
  const configPath = join(homedir(), ".prr", "config.yml")
  if (!existsSync(configPath)) return defaultCodexModel

  let config
  try {
    config = parse(readFileSync(configPath, "utf8")) ?? {}
  } catch {
    throw new Error("Could not read PRR configuration from ~/.prr/config.yml")
  }
  if (config.codex_model === undefined) return defaultCodexModel
  if (typeof config.codex_model !== "string" || config.codex_model.trim() === "") {
    throw new Error("codex_model must be a non-empty string in ~/.prr/config.yml")
  }
  return config.codex_model.trim()
}

const prrCommandNames = ["prr-setup", "prr-start", "prr-cleanup"]
const prrAgentNames = [
  "prr-setup-orchestrator", "prr-orchestrator", "prr-opencode-reviewer", "prr-codex-reviewer", "prr-arbiter",
]

function registerCommands(config) {
  config.command ??= {}
  for (const name of prrCommandNames) {
    if (config.command[name]) continue
    const { metadata, body } = readMarkdown(`commands/${name}.md`)
    config.command[name] = { ...metadata, template: body }
  }
}

function allowWorkspace(agent, workspace, name) {
  if (name !== "prr-orchestrator") return
  const repoPattern = join(workspace, "*", "r*", "repo", "**")
  const rolePattern = join(workspace, "*", "r*", "results", "**")
  const manifestPattern = join(workspace, "*", "r*", "context-manifest.md")
  agent.permission ??= {}
  const external = agent.permission.external_directory
  if (external && typeof external === "object") {
    external[workspace] = "allow"
    external[join(workspace, "**")] = "allow"
    external[repoPattern] = "allow"
    external[rolePattern] = "allow"
    external[manifestPattern] = "allow"
  }
}

function registerAgents(config) {
  config.agent ??= {}
  const workspace = configuredWorkspace()
  for (const name of prrAgentNames) {
    if (config.agent[name]) continue
    const { metadata, body } = readMarkdown(`agents/${name}.md`)
    const agent = { ...metadata, prompt: body }
    allowWorkspace(agent, workspace, name)
    config.agent[name] = agent
  }
}

function registerSkills(config) {
  config.skills ??= {}
  config.skills.paths ??= []
  const skills = join(assetRoot, "skills")
  if (!config.skills.paths.includes(skills)) config.skills.paths.push(skills)
}

function registerToolDefaults(config) {
  config.permission ??= {}
  for (const name of [
    "prr_artifact", "prr_bind_round", "prr_capability", "prr_codex", "prr_codex_health",
    "prr_read", "prr_write",
  ]) {
    if (config.permission[name] === undefined) config.permission[name] = "deny"
  }
}

function isWithin(parent, child) {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function codexPaths(workspace, promptPath, repoPath, outputPath) {
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error("Codex repository must be a PRR round clone")
  }
  const repo = realpathSync(resolve(repoPath))
  if (!isWithin(workspace, repo)) {
    throw new Error("Codex repository must be inside the configured PRR workspace")
  }
  const parts = relative(workspace, repo).split("/")
  if (parts.some((part) => part === "." || part === "..")
    || parts.length !== 3 || !/^r\d+$/.test(parts[1]) || parts[2] !== "repo") {
    throw new Error("Codex repository must be a PRR round clone")
  }

  const rolePath = join(workspace, parts[0], parts[1], "results", "reviewers", "codex")
  if (!existsSync(rolePath) || !existsSync(promptPath) || !statSync(promptPath).isFile()) {
    throw new Error(`Codex prompt does not exist: ${resolve(promptPath)}`)
  }
  const roleDirectory = realpathSync(rolePath)
  const prompt = realpathSync(resolve(promptPath))
  const outputPathResolved = resolve(outputPath)
  const output = join(realpathSync(dirname(outputPathResolved)), basename(outputPathResolved))
  if (!isWithin(roleDirectory, prompt) || !isWithin(roleDirectory, output)) {
    throw new Error("Codex artifacts must stay in its private reviewer directory")
  }
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) {
    throw new Error("Codex output must not be a symbolic link")
  }
  return { repo, prompt, output }
}

function codexEnvironment() {
  const names = ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "CODEX_HOME"]
  return Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []))
}

function executablePath(name) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!isAbsolute(directory)) continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH just as executable resolution would.
    }
  }
  throw new Error(`${name} executable was not found in PATH`)
}

function codexExecutablePaths() {
  const command = executablePath("codex")
  const real = realpathSync(command)
  return { command, executable: real, allowed: [...new Set([dirname(command), command, dirname(real), real])] }
}

function codexPolicyArgs(repo, additionalPaths = [], executablePaths = codexExecutablePaths()) {
  const allowed = [repo, ...additionalPaths, ...executablePaths.allowed]
    .map((path) => `"${path.replaceAll('"', '\\"')}"="read"`)
    .join(",")
  const filesystem = `{":root"="deny",":minimal"="read",${allowed}}`
  return [
    "-c", 'default_permissions="prr-review"',
    "-c", `permissions.prr-review.filesystem=${filesystem}`,
    "-c", "permissions.prr-review.network.enabled=false",
    "-c", 'web_search="disabled"',
    "-c", "allow_login_shell=false",
    "-c", 'shell_environment_policy.inherit="all"',
    "-c", "shell_environment_policy.experimental_use_profile=false",
    "-c", "shell_environment_policy.ignore_default_excludes=false",
    "-c", 'shell_environment_policy.filters={PATH="include",HOME="include",TMPDIR="include",LANG="include",LC_ALL="include",TERM="include",CODEX_HOME="include",GIT_CONFIG_NOSYSTEM="include"}',
    "-c", 'shell_environment_policy.set={PATH="/usr/bin:/bin:/usr/sbin:/sbin",GIT_CONFIG_NOSYSTEM="1"}',
  ]
}

async function runCodex({ capability, promptPath, repoPath, outputPath, timeoutSeconds }, context) {
  const workspace = configuredWorkspace()
  const paths = codexPaths(workspace, promptPath, repoPath, outputPath)
  const executablePaths = codexExecutablePaths()
  const round = dirname(paths.repo)
  requireCapability(capability, context, round, "codex")
  const contextPath = realpathSync(join(round, "context"))
  const timeout = Math.min(Math.max(timeoutSeconds, 30), 3600) * 1000
  const args = [
    "-a", "never", "exec",
    "--model", configuredCodexModel(),
    "--ignore-user-config", "--ignore-rules",
    "--disable", "hooks", "--disable", "apps", "--disable", "multi_agent",
    "--strict-config", "-C", paths.repo,
    ...codexPolicyArgs(paths.repo, [contextPath], executablePaths),
    "--ephemeral", "--color", "never",
    "--output-last-message", paths.output, "-",
  ]

  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePaths.executable, args, {
      cwd: paths.repo,
      env: codexEnvironment(),
      timeout,
      signal: context?.abort,
      stdio: ["pipe", "ignore", "pipe"],
    })
    let stderr = ""
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.stdin.on("error", fail)
    child.on("error", fail)
    child.on("close", (code, signal) => {
      if (settled) return
      if (code !== 0) {
        fail(new Error(`Codex failed${signal ? ` (${signal})` : ""}: ${stderr.trim()}`))
        return
      }
      if (!existsSync(paths.output) || statSync(paths.output).size === 0) {
        fail(new Error("Codex completed without a review output"))
        return
      }
      settled = true
      resolvePromise(`Codex wrote ${statSync(paths.output).size} bytes to ${paths.output}`)
    })
    child.stdin.end(readFileSync(paths.prompt, "utf8"))
  })
}

function canonicalCandidate(path) {
  const requested = resolve(path)
  let ancestor = requested
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  return resolve(realpathSync(ancestor), relative(ancestor, requested))
}

function roundLocation(workspace, path) {
  const target = canonicalCandidate(path)
  if (!isWithin(workspace, target)) throw new Error("Path is outside the configured PRR workspace")
  const parts = relative(workspace, target).split("/")
  if (parts.length < 3 || parts.some((part) => part === "." || part === "..") || !/^r\d+$/.test(parts[1])) {
    throw new Error("Path is not inside a PRR round")
  }
  return { target, parts, round: join(workspace, parts[0], parts[1]) }
}

function roundPath(workspace, path) {
  return roundLocation(workspace, realpathSync(resolve(path)))
}

function roundRoot(workspace, path) {
  const target = realpathSync(resolve(path))
  if (!isWithin(workspace, target)) throw new Error("Round is outside the configured PRR workspace")
  const parts = relative(workspace, target).split("/")
  if (parts.length !== 2 || parts.some((part) => part === "." || part === "..") || !/^r\d+$/.test(parts[1])) {
    throw new Error("Path is not a PRR round directory")
  }
  return target
}

function requireSession(context) {
  if (!context?.sessionID) throw new Error("PRR tool requires an OpenCode session")
  return context.sessionID
}

function requireBoundRound(context, round) {
  const bound = sessionRounds.get(requireSession(context))
  if (bound !== round) throw new Error("PRR session is not bound to this round")
}

async function runPrrBindRound({ roundPath: path }, context) {
  if (context?.agent !== "prr-orchestrator") throw new Error("Only the PRR orchestrator may bind a round")
  const workspace = configuredWorkspace()
  const round = roundRoot(workspace, path)
  const sessionID = requireSession(context)
  const existing = sessionRounds.get(sessionID)
  if (existing && existing !== round) {
    const samePullRequest = dirname(existing) === dirname(round)
    const oldRound = Number(basename(existing).slice(1))
    const newRound = Number(basename(round).slice(1))
    if (!samePullRequest || newRound <= oldRound) throw new Error("PRR session is already bound to another round")
  }
  sessionRounds.set(sessionID, round)
  return `Bound PRR session to ${round}`
}

async function runPrrCapability({ roundPath: path, role }, context) {
  if (context?.agent !== "prr-orchestrator") throw new Error("Only the PRR orchestrator may issue capabilities")
  const round = roundRoot(configuredWorkspace(), path)
  requireBoundRound(context, round)
  const token = randomUUID()
  capabilities.set(token, { round, role, sessionID: undefined })
  if (capabilities.size > 1000) capabilities.delete(capabilities.keys().next().value)
  return token
}

function requireCapability(token, context, round, role) {
  const expectedAgent = {
    opencode: "prr-opencode-reviewer",
    codex: "prr-codex-reviewer",
    arbiter: "prr-arbiter",
  }[role]
  const capability = capabilities.get(token)
  const sessionID = requireSession(context)
  if (!capability || capability.round !== round || capability.role !== role || context?.agent !== expectedAgent
    || (capability.sessionID !== undefined && capability.sessionID !== sessionID)) {
    throw new Error("Invalid PRR round capability")
  }
  capability.sessionID ??= sessionID
}

async function runPrrRead({ capability, filePath, offset = 1, limit = 2000 }, context) {
  const workspace = configuredWorkspace()
  const { target, round } = roundPath(workspace, filePath)
  const allowed = {
    "prr-opencode-reviewer": [
      join(round, "repo"), join(round, "context"), join(round, "results", "reviewers", "opencode"),
    ],
    "prr-arbiter": [join(round, "repo"), join(round, "context"), join(round, "results", "arbiter")],
    "prr-orchestrator": [
      join(round, "repo"),
      join(round, "context"),
      join(round, "results"),
      join(round, "context-manifest.md"),
    ],
  }[context?.agent]
  if (context?.agent === "prr-orchestrator") requireBoundRound(context, round)
  else if (context?.agent === "prr-opencode-reviewer") requireCapability(capability, context, round, "opencode")
  else if (context?.agent === "prr-arbiter") requireCapability(capability, context, round, "arbiter")
  if (!allowed || !allowed.some((root) => isWithin(root, target))) {
    throw new Error(`PRR read is not allowed for ${context?.agent ?? "this agent"}`)
  }

  const stat = statSync(target)
  if (stat.isDirectory()) {
    return readdirSync(target, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(offset - 1, offset - 1 + Math.min(limit, 2000))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .join("\n")
  }
  if (!stat.isFile()) throw new Error("PRR read supports only files and directories")
  if (stat.size > 2 * 1024 * 1024) throw new Error("PRR read refuses files larger than 2 MiB")
  const lines = readFileSync(target, "utf8").split("\n")
  const start = Math.max(offset, 1)
  return lines
    .slice(start - 1, start - 1 + Math.min(limit, 2000))
    .map((line, index) => `${start + index}: ${line.slice(0, 2000)}`)
    .join("\n")
}

async function runPrrWrite({ capability, filePath, content }, context) {
  if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) throw new Error("PRR write exceeds 2 MiB")
  const workspace = configuredWorkspace()
  const location = roundLocation(workspace, filePath)
  const results = realpathSync(join(location.round, "results"))
  let allowed
  if (context?.agent === "prr-orchestrator") {
    requireBoundRound(context, location.round)
    allowed = results
  } else if (context?.agent === "prr-opencode-reviewer") {
    requireCapability(capability, context, location.round, "opencode")
    allowed = join(results, "reviewers", "opencode")
  } else if (context?.agent === "prr-arbiter") {
    requireCapability(capability, context, location.round, "arbiter")
    allowed = join(results, "arbiter")
  } else {
    throw new Error("PRR write is not allowed for this agent")
  }
  const target = artifactOutput(realpathSync(allowed), filePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${target}`
}

function artifactOutput(results, path) {
  const requested = resolve(path)
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) {
    throw new Error("Artifact path must not be a symbolic link")
  }
  const output = canonicalCandidate(path)
  if (!isWithin(results, output)) throw new Error("Artifact path must stay in its round results directory")
  return output
}

async function runPrrArtifact({ operation, sourcePath, targetPath }, context) {
  if (context?.agent !== "prr-orchestrator") throw new Error("Only the PRR orchestrator may move artifacts")
  const workspace = configuredWorkspace()
  const selectedPath = operation === "copy" ? sourcePath : targetPath
  if (!selectedPath) throw new Error(`${operation} requires an artifact path`)
  const { parts, round } = operation === "copy"
    ? roundPath(workspace, selectedPath)
    : roundLocation(workspace, selectedPath)
  if (parts[2] !== "results") throw new Error("Artifacts must stay in a round results directory")
  requireBoundRound(context, round)
  const results = realpathSync(join(round, "results"))

  if (operation === "remove") {
    const target = artifactOutput(results, targetPath)
    if (existsSync(target)) unlinkSync(target)
    return `Removed ${target}`
  }
  if (!sourcePath || !targetPath) throw new Error("copy requires sourcePath and targetPath")
  const source = roundPath(workspace, sourcePath)
  if (source.round !== round || source.parts[2] !== "results" || !statSync(source.target).isFile()) {
    throw new Error("Artifact source and target must be files in the same round results directory")
  }
  const target = artifactOutput(results, targetPath)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source.target, target)
  return `Copied ${source.target} to ${target}`
}

async function runCodexHealth(_args, context) {
  const model = configuredCodexModel()
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "prr-codex-health-")))
  const executablePaths = codexExecutablePaths()
  const args = [
    "-a", "never", "exec",
    "--model", model,
    "--ignore-user-config", "--ignore-rules",
    "--disable", "hooks", "--disable", "apps", "--disable", "multi_agent",
    "--strict-config", "--skip-git-repo-check", "-C", repo,
    ...codexPolicyArgs(repo, [], executablePaths),
    "--ephemeral", "--color", "never", "-",
  ]

  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePaths.executable, args, {
      cwd: repo,
      env: codexEnvironment(),
      timeout: 30_000,
      signal: context?.abort,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65_536) })
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65_536) })
    child.stdin.on("error", fail)
    child.on("error", fail)
    child.on("close", (code, signal) => {
      if (settled) return
      if (code !== 0) {
        fail(new Error(`Codex health check failed${signal ? ` (${signal})` : ""}: ${stderr.trim()}`))
        return
      }
      if (!/HELLO/i.test(stdout)) {
        fail(new Error("Codex health check returned no recognizable response"))
        return
      }
      settled = true
      resolvePromise("Codex health check passed")
    })
    child.stdin.end("Reply with exactly: HELLO\n")
  }).finally(() => rmSync(repo, { recursive: true, force: true }))
}

const arg = {
  string: ({ optional = false } = {}) => ({ type: "string", optional }),
  enum: (values) => ({ type: "string", enum: values, optional: false }),
  positiveInt: ({ max, optional = false } = {}) => ({ type: "integer", max, optional }),
}

const toolDefinitions = {
  prr_bind_round: {
    description: "Bind the current PRR orchestrator session to one review round.",
    args: { roundPath: arg.string() },
    execute: runPrrBindRound,
  },
  prr_capability: {
    description: "Issue a role-specific capability for the orchestrator's bound PRR round.",
    args: { roundPath: arg.string(), role: arg.enum(["opencode", "codex", "arbiter"]) },
    execute: runPrrCapability,
  },
  prr_read: {
    description: "Read a file or directory through PRR role and canonical-path restrictions.",
    args: {
      capability: arg.string({ optional: true }),
      filePath: arg.string(),
      offset: arg.positiveInt({ optional: true }),
      limit: arg.positiveInt({ max: 2000, optional: true }),
    },
    execute: runPrrRead,
  },
  prr_write: {
    description: "Write a PRR artifact through round and role capability restrictions.",
    args: { capability: arg.string({ optional: true }), filePath: arg.string(), content: arg.string() },
    execute: runPrrWrite,
  },
  prr_artifact: {
    description: "Copy or remove files within one PRR round's results directory.",
    args: {
      operation: arg.enum(["copy", "remove"]),
      sourcePath: arg.string({ optional: true }),
      targetPath: arg.string({ optional: true }),
    },
    execute: runPrrArtifact,
  },
  prr_codex_health: {
    description: "Check Codex authentication and isolated execution without exposing process secrets.",
    args: {},
    execute: runCodexHealth,
  },
  prr_codex: {
    description: "Run an isolated Codex PR review using validated PRR workspace paths.",
    args: {
      capability: arg.string(),
      promptPath: arg.string(),
      repoPath: arg.string(),
      outputPath: arg.string(),
      timeoutSeconds: arg.positiveInt(),
    },
    execute: runCodex,
  },
}

function zodArgs(args) {
  return Object.fromEntries(Object.entries(args).map(([name, spec]) => {
    let schema = spec.enum ? tool.schema.enum(spec.enum)
      : spec.type === "integer" ? tool.schema.number().int().positive()
        : tool.schema.string()
    if (spec.max !== undefined) schema = schema.max(spec.max)
    return [name, spec.optional ? schema.optional() : schema]
  }))
}

function jsonSchemaArgs(args) {
  const properties = Object.fromEntries(Object.entries(args).map(([name, spec]) => [name, {
    type: spec.type,
    ...spec.enum ? { enum: spec.enum } : {},
    ...spec.type === "integer" ? { minimum: 1 } : {},
    ...spec.max !== undefined ? { maximum: spec.max } : {},
  }]))
  const required = Object.entries(args).filter(([, spec]) => !spec.optional).map(([name]) => name)
  return { type: "object", properties, required, additionalProperties: false }
}

function requireBinary() {
  if (!existsSync(binary)) {
    throw new Error(`PRR binary is missing from the plugin package: ${binary}`)
  }
}

async function server() {
  requireBinary()

  return {
    config(config) {
      registerCommands(config)
      registerAgents(config)
      registerSkills(config)
      registerToolDefaults(config)
    },
    "shell.env"(_input, output) {
      output.env.PRR_BIN = binary
      output.env.PRR_PLUGIN_ROOT = packageRoot
    },
    // OpenCode passes each executor to Effect's promise combinator, which calls .then()
    // on the return value, so a synchronous return or throw breaks the tool call.
    tool: Object.fromEntries(Object.entries(toolDefinitions).map(([name, definition]) => [name, tool({
      description: definition.description,
      args: zodArgs(definition.args),
      execute: definition.execute,
    })])),
  }
}

// OpenCode V2 renamed these V1 permission actions; mirrors its own V1 config migration.
function v2Action(action) {
  if (action === "write" || action === "patch") return "edit"
  if (action === "task") return "subagent"
  if (action === "bash") return "shell"
  return action
}

function expandHome(resource) {
  if (resource === "~") return homedir()
  return resource.startsWith("~/") ? join(homedir(), resource.slice(2)) : resource
}

function v2Permissions(permission = {}) {
  return Object.entries(permission).flatMap(([key, rule]) => {
    const action = v2Action(key)
    const pathAction = ["external_directory", "read", "edit"].includes(action)
    if (typeof rule === "string") return [{ action, resource: "*", effect: rule }]
    return Object.entries(rule).map(([resource, effect]) => ({
      action,
      resource: pathAction ? expandHome(resource) : resource,
      effect,
    }))
  })
}

function v2Agents() {
  const workspace = configuredWorkspace()
  return prrAgentNames.map((name) => {
    const { metadata, body } = readMarkdown(`agents/${name}.md`)
    const agent = { ...metadata, prompt: body }
    allowWorkspace(agent, workspace, name)
    return { name, agent, permissions: v2Permissions(agent.permission) }
  })
}

function v2Skills() {
  const root = join(assetRoot, "skills")
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const { metadata, body } = readMarkdown(`skills/${entry.name}/SKILL.md`)
    return {
      id: metadata.name ?? entry.name,
      name: metadata.name ?? entry.name,
      description: metadata.description,
      path: join(root, entry.name, "SKILL.md"),
      content: body,
    }
  })
}

// V2 does not evaluate permissions for plugin tools, so each tool enforces the calling
// agent's own rule for it and refuses agents that PRR does not define.
function toolAllowed(permissions, name) {
  const rule = permissions?.findLast((item) => item.action === "*" || item.action === name)
  return rule?.effect === "allow"
}

async function setup(ctx) {
  requireBinary()
  const agents = v2Agents()
  const agentPermissions = new Map(agents.map(({ name, permissions }) => [name, permissions]))
  const skills = v2Skills()
  const commands = prrCommandNames.map((name) => ({ name, ...readMarkdown(`commands/${name}.md`) }))
  const toolDenials = Object.keys(toolDefinitions).map((action) => ({ action, resource: "*", effect: "deny" }))

  await ctx.shell.hook("create.before", (event) => {
    event.env.PRR_BIN = binary
    event.env.PRR_PLUGIN_ROOT = packageRoot
  })

  await ctx.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(toolDefinitions)) {
      editor.add({
        name,
        description: definition.description,
        input: jsonSchemaArgs(definition.args),
        options: { codemode: false },
        execute: async (input, context) => {
          if (!toolAllowed(agentPermissions.get(context.agent), name)) {
            throw new Error(`${name} is not allowed for ${context.agent ?? "this agent"}`)
          }
          const content = await definition.execute(input, { ...context, abort: context.signal })
          return { content }
        },
      })
    }
  })

  await ctx.agent.transform((editor) => {
    for (const existing of editor.list()) {
      if (!agentPermissions.has(existing.id)) editor.update(existing.id, (agent) => agent.permissions.push(...toolDenials))
    }
    for (const { name, agent: definition, permissions } of agents) {
      if (editor.get(name)) continue
      editor.update(name, (agent) => {
        agent.name = name
        agent.system = definition.prompt
        agent.mode = definition.mode ?? "all"
        agent.hidden = definition.hidden === true
        if (definition.description !== undefined) agent.description = definition.description
        agent.permissions.push(...permissions)
      })
    }
  })

  await ctx.skill.transform((editor) => {
    for (const skill of skills) if (!editor.get(skill.id)) editor.add(skill)
  })

  await ctx.command.transform((editor) => {
    for (const { name, metadata, body } of commands) {
      editor.add({
        name,
        description: metadata.description,
        execute: async ({ sessionID, prompt, delivery }) => {
          if (metadata.agent) {
            const session = await ctx.session.get({ sessionID })
            if (session.agent !== metadata.agent) await ctx.session.switchAgent({ sessionID, agent: metadata.agent })
          }
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: body.replaceAll("$ARGUMENTS", prompt.text),
            delivery,
          })
        },
      })
    }
  })
}

// OpenCode V1 (1.18.29+) calls server(); OpenCode V2 validates { id, setup } and calls setup().
export default { id: "opencode-prr", server, setup }
