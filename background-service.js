import { execFile } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
const xml = (text) => String(text).replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character])

export function backgroundServicePlist({ executable, directory, path }) {
  const args = [executable, "api", "post", `/api/rpc/prr.review/wake?location%5Bdirectory%5D=${encodeURIComponent(directory)}`, "--data", '{"input":{}}']
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

export async function installBackgroundService({ directory, executable, path = process.env.PATH ?? "/usr/bin:/bin" }) {
  if (process.platform !== "darwin") throw new Error("PRR background reviews currently require macOS")
  const agents = join(homedir(), "Library/LaunchAgents")
  mkdirSync(agents, { recursive: true })
  const target = join(agents, "com.prr.review-inbox.plist")
  writeFileSync(target, backgroundServicePlist({ executable, directory, path }), { mode: 0o600 })
  const domain = `gui/${process.getuid()}`
  try { await execute("launchctl", ["bootout", `${domain}/com.prr.review-inbox`], { timeout: 10_000 }) }
  catch { /* It may not have been loaded before. */ }
  try { await execute("launchctl", ["bootstrap", domain, target], { timeout: 10_000 }) }
  catch { throw new Error("Could not register the macOS background worker. Check your user LaunchAgents permissions, then enable again.") }
}

export async function pauseBackgroundService() {
  try {
    await execute("launchctl", ["bootout", `gui/${process.getuid()}/com.prr.review-inbox`], { timeout: 10_000 })
  } catch { /* The persistent disabled setting also makes any remaining wake-up a no-op. */ }
}

export function createOpenCodeControl({ executable, run = execute }) {
  async function request(method, path, body) {
    const args = ["api", method, path, ...(body === undefined ? [] : ["--data", JSON.stringify(body)])]
    try {
      const { stdout } = await run(typeof executable === "function" ? executable() : executable, args, {
        encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      })
      const value = stdout.trim() ? JSON.parse(stdout) : null
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
