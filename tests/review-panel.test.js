import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

test("visual investigation renders split diffs, navigates findings, and keeps chat decisions separate", () => {
  const result = spawnSync(process.execPath, ["--conditions=browser", "tests/fixtures/review-panel.mjs"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
