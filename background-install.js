import { accessSync, constants, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createInboxStore } from "./review-inbox.js"
import { installBackgroundService } from "./background-service.js"

export async function installCommand({ args = process.argv.slice(2), directory = process.cwd(), home = homedir(), install = installBackgroundService, executable } = {}) {
  if (args.length) throw new Error("The PRR service installer accepts no arguments")
  if (!executable) {
    for (const path of (process.env.PATH ?? "").split(":")) {
      if (!isAbsolute(path)) continue
      const candidate = join(path, "opencode")
      try { accessSync(candidate, constants.X_OK); executable = candidate; break } catch {}
    }
  }
  if (!executable) throw new Error("OpenCode executable was not found in PATH")
  const store = createInboxStore(join(home, ".prr"))
  const owner = store.read().owner ?? { directory }
  if (!isAbsolute(owner.directory)) throw new Error("The PRR worker directory must be absolute")
  const result = await install({ directory: owner.directory, executable, home })
  store.transaction((queue) => { queue.owner ??= owner })
  return result
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  installCommand().then((result) => {
    console.log(`PRR background service: ${result.status}. Review settings were not changed.`)
  }).catch(() => {
    console.error("PRR service installation failed. Check LaunchAgents permissions and endpoint-security approval. Do not bypass security software or automatically retry.")
    process.exitCode = 1
  })
}
