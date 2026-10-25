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
import { atlassianReadTools, fetchAtlassianContext } from "./atlassian.js"
import { createReviewState, investigationReady, reviewSteps } from "./review-state.js"
import { createReviewReader } from "./review-reader.js"
import { createStatistics } from "./statistics.js"

const packageRoot = dirname(fileURLToPath(import.meta.url))
const assetRoot = join(packageRoot, ".opencode")
const binary = join(packageRoot, "bin", "prr-darwin-universal")
const defaultCodexModel = "gpt-6-sol"
const sessionRounds = new Map()
const capabilities = new Map()
const atlassianResources = new Map()

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

const prrCommandNames = ["prr-setup", "prr-start", "prr-cleanup", "prr-stats"]
const prrAgentNames = [
  "prr-setup-orchestrator", "prr-orchestrator", "prr-opencode-reviewer", "prr-codex-reviewer", "prr-arbiter",
  "prr-stats",
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
    "prr_artifact", "prr_atlassian_context", "prr_bind_round", "prr_capability", "prr_codex", "prr_codex_health",
    "prr_progress", "prr_read", "prr_write", "prr_stats_summary", "prr_stats_record", "prr_findings",
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

async function runCodex({ capability, promptPath, repoPath, outputPath, timeoutSeconds }, context, host) {
  const workspace = configuredWorkspace()
  const paths = codexPaths(workspace, promptPath, repoPath, outputPath)
  const executablePaths = codexExecutablePaths()
  const round = dirname(paths.repo)
  requireCapability(capability, context, round, "codex")
  const contextPath = realpathSync(join(round, "context"))
  const timeout = Math.min(Math.max(timeoutSeconds, 30), 3600) * 1000
  const model = configuredCodexModel()
  let statisticsWarning = ""
  try { host?.statistics?.model(round, "codex", { id: model }, "codex_invocation") }
  catch (error) { statisticsWarning = `\nStatistics warning: ${error.message}` }
  const args = [
    "-a", "never", "exec",
    "--model", model,
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
      resolvePromise(`Codex wrote ${statSync(paths.output).size} bytes to ${paths.output}${statisticsWarning}`)
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

async function runBinary(args, context) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { signal: context?.abort, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65_536) })
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65_536) })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(stderr.trim() || "PRR context command failed"))
    })
  })
}

async function runPrrAtlassianContext({ roundPath: path }, context, host) {
  if (context?.agent !== "prr-orchestrator") throw new Error("Only the PRR orchestrator may gather Atlassian context")
  const round = roundRoot(configuredWorkspace(), path)
  requireBoundRound(context, round)
  if (existsSync(join(round, "results", "review-prompt.md"))) {
    throw new Error("Atlassian context must be gathered before reviewer prompts are built")
  }
  const manifest = roundPath(configuredWorkspace(), join(round, "context-manifest.md"))
  if (manifest.round !== round || statSync(manifest.target).size > 2 * 1024 * 1024) throw new Error("Invalid context manifest")
  const saved = readFileSync(manifest.target, "utf8").split("\n## Atlassian Context\n")[1]
  if (saved !== undefined && !saved.split("\n").includes("- Jira ticket: unavailable")) return saved.trim()
  const results = realpathSync(join(round, "results"))
  const read = (name) => {
    const file = roundPath(configuredWorkspace(), join(results, name))
    if (file.round !== round || !isWithin(results, file.target) || statSync(file.target).size > 2 * 1024 * 1024) {
      throw new Error("Invalid Atlassian context input")
    }
    return readFileSync(file.target, "utf8")
  }
  const ticketId = read("ticket-id.txt").trim()
  const metadata = JSON.parse(read("pr-metadata.json"))
  const runtime = JSON.parse(await runBinary(["config", "runtime"], context))
  const snapshot = await fetchAtlassianContext({
    host, ticketId, metadata, baseUrl: runtime.jira_base_url,
    context: { ...context, signal: context.abort }, resourceCache: atlassianResources,
  })
  const output = artifactOutput(results, join(results, "atlassian-context.json"))
  writeFileSync(output, JSON.stringify(snapshot))
  return runBinary(["context-atlassian", round], context)
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
  enum: (values, { optional = false } = {}) => ({ type: "string", enum: values, optional }),
  positiveInt: ({ max, optional = false } = {}) => ({ type: "integer", max, optional }),
}

const toolDefinitions = {
  prr_findings: {
    description: "Read shared finding decisions, focus the current chat finding in the diff, or save an explicit decision. Get the snapshot and revision first; reread before posting. This never authorizes posting.",
    args: {
      operation: arg.enum(["get", "focus", "decision"]), snapshot: arg.string({ optional: true }),
      finding_id: arg.string({ optional: true }), status: arg.enum(["pending", "accepted", "rejected", "edited"], { optional: true }),
      revision: { type: "integer", min: 0, optional: true }, overridden_body: arg.string({ optional: true }),
    },
    execute: async ({ finding_id, overridden_body, ...input }, context, host) => {
      if (context?.agent !== "prr-orchestrator") throw new Error("Only the PRR orchestrator may synchronize findings")
      if (!host?.reader) return "Shared finding decisions require OpenCode 2; retain the existing in-memory review state."
      return JSON.stringify(await host.reader.findings({ ...input, sessionID: requireSession(context), findingID: finding_id, overriddenBody: overridden_body }))
    },
  },
  prr_stats_summary: {
    description: "Read local PRR usage, agreement, reviewer attribution, and human-decision statistics. No review code or credentials are returned.",
    args: { query: arg.string({ optional: true }), limit: arg.positiveInt({ max: 100, optional: true }) },
    execute: async (input, _context, host) => JSON.stringify((host?.statistics ?? createStatistics({ directory: join(homedir(), ".prr/statistics/v1"), binary })).summary(input)),
  },
  prr_stats_record: {
    description: "Record an explicit human finding decision or review outcome for the bound round. Accept/reject does not imply correctness. Use collect only to retry collection of a saved final report.",
    args: {
      operation: arg.enum(["decision", "finish", "collect"]),
      finding_id: arg.string({ optional: true }),
      status: arg.enum(["pending", "accepted", "rejected", "edited", "added", "posted", "skipped", "aborted"], { optional: true }),
      correctness: arg.enum(["confirmed", "incorrect", "unassessed"], { optional: true }),
      reason: arg.enum(["incorrect", "out_of_scope", "already_fixed", "not_worth_raising", "duplicate", "other", "not_assessed"], { optional: true }),
    },
    execute: async ({ operation, ...input }, context, host) => {
      if (context?.agent !== "prr-orchestrator") throw new Error("Only the PRR orchestrator may record review decisions")
      const sessionID = requireSession(context)
      const state = await host?.reviewState?.get(sessionID)
      if (!state?.statsRun) return "Statistics were not enabled for this saved review; no historical accuracy judgment was recorded."
      const round = sessionRounds.get(sessionID)
      if (!round) throw new Error("No bound PRR round")
      if (operation === "collect") await host.statistics.collect(state.statsRun, round)
      else if (operation === "decision") host.statistics.decision(state.statsRun, round, input)
      else host.statistics.finish(state.statsRun, round, input.status)
      return "Local review statistics recorded."
    },
  },
  prr_progress: {
    description: "Update a PRR review stage (1-based). Starting step 7 with view=diff opens visual investigation in the active terminal; view=chat keeps the chat workflow.",
    args: { step: arg.positiveInt({ max: reviewSteps.length }), status: arg.enum(["pending", "in_progress", "completed", "blocked"]), view: arg.enum(["diff", "chat"], { optional: true }) },
    execute: async ({ step, status, view }, context, host) => {
      if (context?.agent !== "prr-orchestrator") throw new Error("Only the PRR orchestrator may update progress")
      await host.reviewState.update(requireSession(context), step, status, view)
      return `PRR step ${step}: ${status}`
    },
  },
  prr_atlassian_context: {
    description: "Gather the bound round's ticket and linked Confluence pages through read-only Atlassian MCP tools, falling back to Jira API credentials.",
    args: { roundPath: arg.string() },
    execute: runPrrAtlassianContext,
  },
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
      : spec.type === "integer" ? tool.schema.number().int().min(spec.min ?? 1)
        : tool.schema.string()
    if (spec.max !== undefined) schema = schema.max(spec.max)
    return [name, spec.optional ? schema.optional() : schema]
  }))
}

function jsonSchemaArgs(args) {
  const properties = Object.fromEntries(Object.entries(args).map(([name, spec]) => [name, {
    type: spec.type,
    ...spec.enum ? { enum: spec.enum } : {},
    ...spec.type === "integer" ? { minimum: spec.min ?? 1 } : {},
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
    tool: Object.fromEntries(Object.entries(toolDefinitions).filter(([name]) => name !== "prr_progress").map(([name, definition]) => [name, tool({
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
    const permissions = v2Permissions(agent.permission)
    if (name === "prr-orchestrator") {
      // MCP executors check the caller even when invoked internally by the context bridge.
      permissions.push(...atlassianReadTools.map((tool) => ({ action: `*_${tool}`, resource: "*", effect: "allow" })))
    }
    return { name, agent, permissions }
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
  const { reviewRpc } = await import("./review-rpc.js")
  let registration
  const reviewState = createReviewState(ctx.storage, async ({ sessionID, diffRequest }) => {
    await registration.events.emit("updated", { sessionID })
    if (diffRequest) await registration.events.emit("openDiff", { sessionID, diffRequest })
  })
  const statistics = createStatistics({ directory: join(homedir(), ".prr/statistics/v1"), binary })
  const reader = createReviewReader({
    state: reviewState, resolveRound: (round) => roundRoot(configuredWorkspace(), round), binary,
    onDecision: async ({ sessionID, round, ...decision }) => {
      const state = await reviewState.get(sessionID)
      if (state?.statsRun) statistics.decision(state.statsRun, round, decision)
    },
  })
  registration = await ctx.rpc.register(reviewRpc, {
    investigation: reader.investigation,
    diff: reader.diff,
    decide: reader.decide,
    pendingDiff: async ({ sessionID }) => {
      const state = await reviewState.get(sessionID)
      return investigationReady(state) && state.steps[6].status === "in_progress" && state.diffRequest
        ? { diffRequest: state.diffRequest } : null
    },
    get: async ({ sessionID }) => {
      const state = await reviewState.get(sessionID)
      return state ? { steps: state.steps, summary: state.summary } : null
    },
  })
  const agents = v2Agents()
  const agentPermissions = new Map(agents.map(({ name, permissions }) => [name, permissions]))
  const skills = v2Skills()
  const commands = prrCommandNames.map((name) => ({ name, ...readMarkdown(`commands/${name}.md`) }))
  const toolDenials = Object.keys(toolDefinitions).map((action) => ({ action, resource: "*", effect: "deny" }))

  // Only the bound-round bridge may choose which ticket and linked pages to read.
  const hideAtlassianReads = (event) => {
    if (!agentPermissions.has(event.agent)) return
    for (const id of Object.keys(event.tools)) {
      if (atlassianReadTools.some((name) => id.endsWith(`_${name}`))) delete event.tools[id]
    }
  }
  for (const hook of ["compaction", "generate"]) await ctx.session.hook(hook, hideAtlassianReads)
  await ctx.session.hook("context", async (event) => {
    hideAtlassianReads(event)
    if (event.agent !== "prr-orchestrator" || !investigationReady(await reviewState.get(event.sessionID))) return
    event.system ??= []
    event.system.push({ type: "text", text: "PRR finding decisions are shared between chat and diff through prr_findings. Read them when resuming review and before confirmation or posting; retain rejected findings and exact approved edits. Before each original finding's rich block/menu, call prr_findings focus with its ID and the current snapshot so reopening the diff follows the active chat finding. Save explicit original-finding decisions through prr_findings using the current revision. Never overwrite a newer choice or treat navigation or acceptance as permission to post." })
  })

  const recordedModels = new Set()
  await ctx.session.hook("model.request", (event) => {
    if (event.agent !== "prr-opencode-reviewer" || event.kind !== "primary") return
    const capability = [...capabilities.values()].find((value) => value.role === "opencode" && value.sessionID === event.sessionID)
    if (!capability) return
    const key = `${capability.round}:${JSON.stringify(event.model)}`
    if (recordedModels.has(key)) return
    try {
      statistics.model(capability.round, "opencode", event.model, "session_request")
      recordedModels.add(key)
      if (recordedModels.size > 1000) recordedModels.delete(recordedModels.values().next().value)
    } catch { /* A statistics write must not interrupt a reviewer request. */ }
  })

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
          if (context.agent === "prr-orchestrator" && !sessionRounds.has(context.sessionID)
            && ["prr_bind_round", "prr_capability", "prr_read", "prr_write", "prr_artifact", "prr_atlassian_context", "prr_stats_record"].includes(name)) {
            const saved = await reviewState.get(requireSession(context))
            if (saved?.round) {
              sessionRounds.set(context.sessionID, roundRoot(configuredWorkspace(), saved.round))
            }
          }
          const host = { ...ctx, reviewState, statistics, reader }
          const content = await definition.execute(input, { ...context, abort: context.signal }, host)
          if (name === "prr_bind_round" || name === "prr_atlassian_context") {
            const round = sessionRounds.get(context.sessionID)
            const manifest = roundPath(configuredWorkspace(), join(round, "context-manifest.md"))
            if (manifest.round !== round || statSync(manifest.target).size > 2 * 1024 * 1024) {
              throw new Error("Invalid context manifest")
            }
            await reviewState.context(context.sessionID, round, readFileSync(manifest.target, "utf8"))
          }
          let statisticsWarning = ""
          try {
            const state = context.agent === "prr-orchestrator" ? await reviewState.get(context.sessionID) : null
            const round = sessionRounds.get(context.sessionID)
            if (state?.statsRun && round) {
              if (name === "prr_bind_round") {
                const session = await ctx.session.get({ sessionID: context.sessionID })
                statistics.bind(state.statsRun, round, { opencode: session.model, codex: { id: configuredCodexModel() } })
              }
              if (name === "prr_artifact" && input.operation === "copy" && canonicalCandidate(input.targetPath) === join(round, "results/final-report.md")) {
                await statistics.collect(state.statsRun, round)
              }
            }
          } catch (error) { statisticsWarning = `\nStatistics warning: ${error.message}` }
          return { content: content + statisticsWarning }
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
            if (session.agent !== metadata.agent && !(name === "prr-stats" && session.agent === "prr-orchestrator")) {
              await ctx.session.switchAgent({ sessionID, agent: metadata.agent })
            }
          }
          let statisticsWarning = ""
          if (name === "prr-start") {
            const runID = randomUUID()
            await reviewState.reset(sessionID, runID)
            try { statistics.start(runID, prompt.text) }
            catch (error) { statisticsWarning = `\nReport this local statistics warning without stopping the review: ${error.message}` }
          }
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: body.replaceAll("$ARGUMENTS", prompt.text) + statisticsWarning,
            delivery,
          })
        },
      })
    }
  })
}

// OpenCode V1 (1.18.29+) calls server(); OpenCode V2 validates { id, setup } and calls setup().
export default { id: "opencode-prr", server, setup }
