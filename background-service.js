import { execFile } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { parseCliJson } from "./cli-json.js"

const execute = promisify(execFile)
const xml = (text) => String(text).replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character])
const serviceArguments = (directory, executable) => [executable, "api", "post", `/api/rpc/prr.review/wake?location%5Bdirectory%5D=${encodeURIComponent(directory)}`, "--data", '{"input":{}}']

export function backgroundServicePlist({ executable, directory, path }) {
  const args = serviceArguments(directory, executable)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.prr.review-inbox</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(directory)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>60</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`
}

const unxml = (text) => text.replace(/&(lt|gt|quot|apos|amp);/g, (_, entity) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[entity])

export async function inspectBackgroundService({ directory, executable, home = homedir(), run = execute }) {
  const target = join(home, "Library/LaunchAgents/com.prr.review-inbox.plist")
  let installed = false
  let compatible = false
  let managed = false
  if (existsSync(target)) {
    if (!lstatSync(target).isFile()) throw new Error("PRR LaunchAgent must be a regular file; the existing path was left unchanged")
    installed = true
    const content = readFileSync(target, "utf8")
    const field = (key) => unxml(content.match(new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`))?.[1] ?? "")
    const args = [...(content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unxml(match[1]))
    const expected = serviceArguments(directory, executable)
    managed = field("Label") === "com.prr.review-inbox" && args.some((arg) => arg.startsWith("/api/rpc/prr.review/wake"))
    compatible = managed && field("WorkingDirectory") === directory && JSON.stringify(args) === JSON.stringify(expected)
      && !content.includes("<key>Program</key>")
  }
  let loaded = false
  let registeredCompatible = false
  try {
    const { stdout } = await run("launchctl", ["print", `gui/${process.getuid()}/com.prr.review-inbox`], { timeout: 10_000 })
    loaded = true
    const text = stdout ?? ""
    const field = (key) => text.match(new RegExp(`^\\s*${key} = (.+)$`, "m"))?.[1].trim()
    const args = text.match(/^\s*arguments = \{\r?\n([\s\S]*?)^\s*\}/m)?.[1].split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean)
    registeredCompatible = field("program") === executable && field("working directory") === directory
      && JSON.stringify(args) === JSON.stringify(serviceArguments(directory, executable))
  } catch { /* A missing or blocked service must be installed explicitly, never by enable. */ }
  return { target, installed, compatible, managed, loaded, registeredCompatible }
}

export async function installBackgroundService({ directory, executable, path = process.env.PATH ?? "/usr/bin:/bin", home = homedir(), run = execute }) {
  if (process.platform !== "darwin") throw new Error("PRR background reviews currently require macOS")
  const state = await inspectBackgroundService({ directory, executable, home, run })
  if (state.compatible && state.registeredCompatible) return { status: "already_installed" }
  if (state.installed && !state.managed) throw new Error("The existing LaunchAgent is not recognized as PRR's service; it was left unchanged")
  const agents = join(home, "Library/LaunchAgents")
  mkdirSync(agents, { recursive: true })
  if (!state.compatible) writeFileSync(state.target, backgroundServicePlist({ executable, directory, path }), { mode: 0o600 })
  const domain = `gui/${process.getuid()}`
  if (state.loaded) {
    try { await run("launchctl", ["bootout", `${domain}/com.prr.review-inbox`], { timeout: 10_000 }) }
    catch { throw new Error("Could not update the registered PRR service; check security policy before retrying installation") }
  }
  try {
    await run("launchctl", ["bootstrap", domain, state.target], { timeout: 10_000 })
  } catch { throw new Error("Could not register the PRR service. Check LaunchAgents permissions and endpoint-security approval before retrying installation.") }
  return { status: state.compatible ? "registered" : "installed" }
}

export function createOpenCodeControl({ executable, run = execute }) {
  async function request(method, path, body) {
    const args = ["api", method, path, ...(body === undefined ? [] : ["--data", JSON.stringify(body)])]
    try {
      const { stdout } = await run(typeof executable === "function" ? executable() : executable, args, {
        encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      })
      const value = parseCliJson(stdout, { allowEmpty: true })
      return value?.data ?? value
    } catch {
      throw new Error("Could not contact the local managed OpenCode service. Check opencode service status; remote and standalone servers are not supported by the background inbox.")
    }
  }
  return {
    active: () => request("get", "/api/session/active"),
    forms: ({ sessionID }) => request("get", `/api/session/${encodeURIComponent(sessionID)}/form`),
    cancel: ({ sessionID, formID, message }) => request("delete", `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`, { message }),
  }
}
