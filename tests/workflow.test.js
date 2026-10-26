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
  assert.match(briefing, /Do not proceed until the user explicitly selects \*\*Investigate in diff view\*\*, \*\*Investigate in chat\*\*/)
  for (const option of ["Investigate in diff view", "Investigate in chat", "Explain this briefing", "Stop here"]) {
    assert.ok(briefing.includes(`- **${option}**`))
  }
  assert.match(briefing, /accept findings, authorize posting, or start step 7/)
  assert.match(briefing, /including with zero findings/)
  assert.match(skill, /approval of the previous briefing does not carry over/)
})

test("APPROVE briefing can skip investigation without accepting findings or posting", () => {
  const briefing = skill.split("## Phase 6:")[1].split("## Phase 7:")[0]
  const posting = skill.split("## Phase 9:")[1]
  assert.match(briefing, /\*\*Continue to review action\*\* - only when the parsed verdict is `APPROVE`/)
  assert.match(briefing, /including when there are non-blocking or\npre-existing findings/)
  assert.match(briefing, /Omit it for `COMMENT` and `REQUEST_CHANGES`/)
  assert.match(briefing, /An APPROVE verdict alone never advances/)
  assert.match(briefing, /mark step 7 completed as bypassed, without\nstarting investigation or setting `view`/)
  assert.match(briefing, /Do not show the Phase 7 menu, the findings walk, or 8e confirmation/)
  assert.match(briefing, /Pending findings remain pending/)
  assert.match(posting, /Exclude Rejected findings and retain exact approved edits/)
  assert.match(posting, /show every proposed inline comment verbatim/)
  assert.match(posting, /single posting preview, not a findings walk/)
  for (const option of ["Approve", "Comment only", "Request changes", "Skip posting"]) assert.ok(posting.includes(`- **${option}**`))
  assert.match(posting, /On \*\*Skip posting\*\*\nor \*\*Cancel posting\*\*, leave Pending findings pending/)
  assert.match(posting, /Only after explicit action, exact body, and proposed-comment confirmation, reread shared state/)
  assert.match(posting, /never overwrite a concurrent decision/)
  assert.match(posting, /ask` permission creates a separate approval prompt/)
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

test("diff discussion restores the full finding view and per-finding menu without resetting decisions", () => {
  const investigation = skill.split("## Phase 7:")[1].split("## Phase 8:")[0]
  assert.match(investigation, /resumes the one-at-a-time findings review at the selected finding, without a popup question/)
  assert.match(investigation, /complete step 7 only on the first transition from Phase 7 to Phase 8/)
  assert.match(investigation, /full 8b\/8c presentation/)
  assert.match(investigation, /Include focused code and all finding fields/)
  for (const option of ["Accept", "Reject", "Edit", "Add finding", "Finish findings"]) assert.ok(investigation.includes(`**${option}**`))
  assert.match(investigation, /show the same per-finding menu again/)
  assert.match(skill, /Initialize state only for findings without an existing decision/)
  assert.match(skill, /handoff starts at its selected finding ID/)
  assert.match(skill, /skipping previously decided entries/)
  assert.match(investigation, /Escape\) closes the panel\nwithout sending a message/)
  assert.match(investigation, /or replacing any pending chat question/)
  assert.match(investigation, /\*\*Continue review\*\* action \(`c`\)/)
})

test("statistics metadata cannot turn a final report into another Q&A round", () => {
  const detection = skill.split("### 5c.")[1].split("### 5d.")[0]
  assert.match(detection, /starting with `## Final Report` is a final report/)
  assert.match(detection, /JSON is metadata, never a question set/)
  assert.match(detection, /entire trimmed output is one fenced JSON block/)
})

test("diff decisions remain authoritative through chat confirmation and posting", () => {
  assert.match(skill, /`prr_findings` is the authoritative state/)
  assert.match(skill, /before final confirmation,\nand immediately before generating a posting payload/)
  assert.match(skill, /operation: "focus".*current `snapshot`/)
  assert.match(skill, /prior Accepted, Rejected, and Edited choices/)
  assert.match(skill, /Never\nreinstate a rejected finding or replace an approved edit/)
  assert.match(skill, /refresh that confirmation before\nposting/)
  assert.match(skill, /`h`\/`l`; `p`\/`n` remain finding navigation/)
})
