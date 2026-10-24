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
  assert.match(briefing, /Do not proceed until the user explicitly selects \*\*Investigate in diff view\*\* or \*\*Investigate in chat\*\*/)
  for (const option of ["Investigate in diff view", "Investigate in chat", "Explain this briefing", "Stop here"]) {
    assert.ok(briefing.includes(`- **${option}**`))
  }
  assert.match(briefing, /accept findings, authorize posting, or start step 7/)
  assert.match(briefing, /including with zero findings/)
  assert.match(skill, /approval of the previous briefing does not carry over/)
})

test("briefing is concise, uses saved assessments, and leaves investigation optional", () => {
  const briefing = skill.split("## Phase 6:")[1].split("## Phase 7:")[0]
  assert.match(briefing, /parse-report "<RESULTS_PATH>\/final-report.md" --diff "<RESULTS_PATH>\/diff.txt"/)
  for (const field of ["change_summary", "overall_assessment", "confidence_reasoning"]) {
    assert.ok(briefing.includes(`\`${field}\``))
  }
  assert.match(briefing, /Not assessed in this saved report/)
  assert.match(briefing, /Do not add findings, conduct another/)
  assert.match(briefing, /Optional LOW suggestions are non-blocking/)
  assert.match(briefing, /normally under 180 words/)
  for (const section of ["### Change size", "### Backwards compatibility", "### Why this confidence level", "### Readability and gradual modernization"]) {
    assert.ok(!briefing.includes(section))
  }
  assert.match(briefing, /\/prr-diff/)
  assert.match(briefing, /Do not add another click/)
  assert.match(briefing, /`view: "diff"`/)
  assert.match(briefing, /`view: "chat"`/)
})

test("review confidence reflects assessment quality rather than local test execution", () => {
  for (const name of ["review-prompt.md", "arbiter-prompt.md"]) {
    const prompt = readFileSync(new URL(`../references/prompts/${name}`, import.meta.url), "utf8")
    assert.match(prompt, /Trust relevant passing CI results/)
    assert.match(prompt, /lower confidence merely because no tests ran/)
    assert.match(prompt, /ticket-to-implementation/)
    assert.match(prompt, /hypothetical future/)
    assert.match(prompt, /actual mismatch caused or exposed/)
    assert.match(prompt, /\{\{ci_checks\}\}/)
  }
})

test("leaving diff investigation resumes next-step choices even without findings", () => {
  const investigation = skill.split("## Phase 7:")[1].split("## Phase 8:")[0]
  assert.match(investigation, /Continue review/)
  assert.match(investigation, /immediately use the question tool/)
  assert.match(investigation, /\*\*Post review\*\* when\nthere are zero findings/)
  assert.match(investigation, /or authorize posting/)
  assert.match(investigation, /Do not repeat the briefing, reopen the diff view/)
})
