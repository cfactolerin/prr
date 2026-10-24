import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

for (const light of [false, true]) test(`visual investigation renders Markdown, blue issue highlights, and file navigation (${light ? "light" : "dark"} theme)`, () => {
  const result = spawnSync(process.execPath, ["--conditions=browser", "tests/fixtures/review-panel.mjs"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PRR_LIGHT_THEME: light ? "1" : "" },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test("explicit diff choices open once in the active session without needing a sidebar click", () => {
  const result = spawnSync(process.execPath, ["--conditions=browser", "tests/fixtures/review-auto-open.mjs"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
