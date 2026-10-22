import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { reviewSteps } from "../review-state.js"

const skill = readFileSync(new URL("../.opencode/skills/prr-start/SKILL.md", import.meta.url), "utf8")

test("workflow stages match sidebar ordering including the briefing pause", () => {
  const list = skill.split("Track these items in order:")[1].split("For phases")[0]
  assert.deepEqual([...list.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]), reviewSteps)
  for (const [number, title] of [[6, "Review Briefing"], [7, "Interactive Investigation"], [8, "One-at-a-Time Findings Review"], [9, "Generate and Post GitHub Review"]]) {
    assert.ok(skill.includes(`## Phase ${number}: ${title}`))
  }
})

test("briefing requires explicit continuation even with no findings or after re-review", () => {
  const briefing = skill.split("## Phase 6:")[1].split("## Phase 7:")[0]
  assert.match(briefing, /Keep step 6 `in_progress` and step 7 pending/)
  assert.match(briefing, /Do not proceed until the user explicitly selects \*\*Continue to investigation\*\*/)
  for (const option of ["Continue to investigation", "Explain this briefing", "Stop here"]) {
    assert.ok(briefing.includes(`- **${option}**`))
  }
  assert.match(briefing, /accept findings, authorize posting, or start step 7/)
  assert.match(briefing, /even with zero findings/)
  assert.match(skill, /approval of the previous briefing does not carry over/)
})

test("briefing uses snapshot statistics and arbiter assessments without performing another review", () => {
  const briefing = skill.split("## Phase 6:")[1].split("## Phase 7:")[0]
  assert.match(briefing, /parse-report "<RESULTS_PATH>\/final-report.md" --diff "<RESULTS_PATH>\/diff.txt"/)
  assert.match(briefing, /Use `change_stats`/)
  for (const field of ["change_summary", "overall_assessment", "code_quality", "backwards_compatibility", "confidence_reasoning"]) {
    assert.ok(briefing.includes(`\`${field}\``))
  }
  assert.match(briefing, /Not assessed in this saved report/)
  assert.match(briefing, /Do not add findings, conduct another/)
  assert.match(briefing, /Optional LOW suggestions are non-blocking/)
})
