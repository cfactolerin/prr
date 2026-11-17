import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { createReviewReader } from "../review-reader.js"
import { createReviewState, reviewSteps } from "../review-state.js"

const binary = fileURLToPath(new URL("../bin/prr-darwin-universal", import.meta.url))
const patch = "diff --git a/a.rb b/a.rb\n--- a/a.rb\n+++ b/a.rb\n@@ -1 +1 @@\n-old\n+new\n"
const report = `## Final Report

### Verdict

COMMENT

### Findings

#### Trigger: Logic Bug

##### F-01 — Wrong value

- **Severity:** MED
- **Anchor:** diff
- **Origin:** introduced
- **Location:** a.rb:1
- **Why this matters:** Wrong value.
- **Suggested fix:** Correct it.
- **Suggested comment:** Correct the value.
`

function fixture(t, failedSource = "", colored = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prr-context-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "gh"), `#!${process.execPath}
const fs = require("node:fs")
const args = process.argv.slice(2)
const print = (value) => console.log(${colored} ? "\\x1b[1;37m" + JSON.stringify(value) + "\\x1b[m" : JSON.stringify(value))
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n")
if (args[0] === "repo") {
  fs.mkdirSync(args[3], { recursive: true })
} else if (args[0] === "pr") {
  console.log(JSON.stringify({number: 1, title: "A change", body: "", headRefName: "feature", baseRefName: "main", headRefOid: "head", url: "https://github.com/acme/repo/pull/1"}))
} else if (args[0] === "api") {
  const endpoint = args.at(-1)
  if (!args.includes("--paginate") || !args.includes("--slurp")) process.exit(2)
  if (process.env.FAILED_SOURCE && endpoint.includes(process.env.FAILED_SOURCE)) process.exit(1)
  if (endpoint.includes("/issues/")) {
    print([[{id: 10, body: "General PR discussion", user: {login: "author"}, created_at: "2026-01-01", html_url: "https://github.com/acme/repo/pull/1#issuecomment-10"}]])
  } else if (endpoint.includes("/reviews")) {
    print([[{id: 20, body: "Review summary discussion", user: {login: "reviewer"}, submitted_at: "2026-01-02", state: "COMMENTED"}]])
  } else {
    print([
      [{id: 30, body: "Correct the value.", path: "a.rb", line: 1, side: "RIGHT", commit_id: "head", user: {login: "reviewer"}, created_at: "2026-01-03"}],
      [{id: 31, in_reply_to_id: 30, body: "This is intentional; see the contract.", path: "a.rb", line: 1, user: {login: "author"}, created_at: "2026-01-04"}]
    ])
  }
} else process.exit(2)
`, { mode: 0o755 })
  writeFileSync(join(bin, "git"), `#!${process.execPath}
const args = process.argv.slice(2)
if (args.includes("diff")) {
  process.stdout.write(args.includes("--name-only") ? "a.rb\\n" : ${JSON.stringify(patch)})
} else if (args.includes("merge-base")) console.log("base")
`, { mode: 0o755 })
  const env = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, CALLS: join(root, "calls.jsonl"), FAILED_SOURCE: failedSource }
  const run = (...args) => execFileSync(binary, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  const context = () => run("context", "acme/repo#1", "--workspace", join(root, "workspace")).trim().split("\n").at(-1)
  return { root, run, context }
}

test("a new round receives explicit rejection history and paginated GitHub replies as common evidence", async (t) => {
  const { root, run, context } = fixture(t)
  const first = context()
  writeFileSync(join(first, "results/final-report.md"), report)
  let stored = { round: first, steps: reviewSteps.map((label) => ({ label, status: "completed" })) }
  const state = createReviewState({ get: async () => structuredClone(stored), set: async (_key, value) => { stored = structuredClone(value) } }, async () => {})
  const reader = createReviewReader({ state, resolveRound: realpathSync, binary })
  const { snapshot } = await reader.findings({ sessionID: "review" })
  await reader.decide({ sessionID: "review", snapshot, revision: 0, findingID: "F-01", status: "rejected" })
  const second = context()
  assert.match(second, /\/r2$/)
  assert.match(readFileSync(join(second, "results/previous-decisions.md"), "utf8"), /F-01: rejected/)
  for (const kind of ["review", "arbiter"]) {
    run("prompt", `--${kind}`, second)
    const prompt = readFileSync(join(second, `results/${kind}-prompt.md`), "utf8")
    assert.match(prompt, /F-01: rejected/)
    assert.match(prompt, /General PR discussion/)
    assert.match(prompt, /Review summary discussion/)
    assert.match(prompt, /2026-01-02/)
    assert.match(prompt, /This is intentional; see the contract\./)
    assert.ok(!prompt.includes("{{previous_decisions}}"))
    assert.ok(!prompt.includes("{{github_discussions}}"))
  }
  assert.match(readFileSync(join(second, "context-manifest.md"), "utf8"), /1 inline threads, 1 PR comments, 1 review summaries/)
  assert.match(readFileSync(join(second, "results/github-discussions/thread-30.md"), "utf8"), /@reviewer[\s\S]*Correct the value\.[\s\S]*@author[\s\S]*This is intentional/)
  const apiCalls = readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((args) => args[0] === "api")
  assert.equal(apiCalls.length, 6)
  assert.ok(apiCalls.every((args) => args.includes("--paginate") && args.includes("--slurp")))
})

test("unavailable GitHub sources do not erase other discussions or masquerade as empty context", (t) => {
  const { context } = fixture(t, "/issues/")
  const round = context()
  assert.match(readFileSync(join(round, "context-manifest.md"), "utf8"), /GitHub discussions:.*\(incomplete\)/)
  const discussion = readFileSync(join(round, "results/github-discussions.md"), "utf8")
  assert.match(discussion, /Unavailable sources: issue_comments/)
  assert.match(discussion, /issue_comments: GitHub discussion request failed/)
  assert.match(discussion, /This is intentional/)
  assert.match(discussion, /Review summary discussion/)
})

test("forced-colour GitHub CLI output still supplies all discussion sources", (t) => {
  const { context } = fixture(t, "", true)
  const round = context()
  const manifest = readFileSync(join(round, "context-manifest.md"), "utf8")
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.ok(manifest.includes(`- **PRR**: v${version}`), "Packaged binary must match the package version")
  assert.match(manifest, /GitHub discussions: 1 inline threads, 1 PR comments, 1 review summaries/)
  assert.ok(!manifest.includes("(incomplete)"))
  const discussion = readFileSync(join(round, "results/github-discussions.md"), "utf8")
  assert.match(discussion, /General PR discussion/)
  assert.match(discussion, /Review summary discussion/)
  assert.match(discussion, /This is intentional/)
  assert.ok(!discussion.includes("\x1b"))
})
