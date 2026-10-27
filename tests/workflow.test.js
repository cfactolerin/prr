import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
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
  assert.match(investigation, /supersedes the prior finding's unanswered decision menu/)
  assert.match(investigation, /even when the previous one is still Pending/)
  assert.match(skill, /header `Finding <ID>`/)
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

test("the final Q&A round uses the configured limit without forcing consensus", () => {
  const arbitration = skill.split("## Phase 5:")[1].split("## Phase 6:")[0]
  assert.match(arbitration, /`arbiter_rounds` from the preflight `config runtime` output/)
  assert.match(arbitration, /`ROUND < arbiter_rounds` and `ROUND \+ 1 == arbiter_rounds`/)
  assert.match(arbitration, /With a limit of zero, skip Q&A/)
  assert.match(arbitration, /Configured Q&A round limit: <arbiter_rounds from config runtime>/)
  assert.match(arbitration, /Next Q&A round is final:/)
  assert.match(arbitration, /Preserve it for both reviewers/)
  assert.match(arbitration, /Another Q&A round allowed: no/)
  const arbiter = readFileSync(new URL("../.opencode/agents/prr-arbiter.md", import.meta.url), "utf8")
  assert.match(arbiter, /When the next Q&A round is final/)
  assert.match(arbiter, /final position, supporting evidence, severity, and remaining/)
  assert.match(arbiter, /Revisions must follow evidence, not pressure to agree/)
})

test("question prompts read non-default Q&A limits from configuration", (t) => {
  const root = mkdtempSync(join(tmpdir(), "prr-qa-config-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const round = join(root, "round")
  mkdirSync(join(root, ".prr"))
  mkdirSync(join(round, "results"), { recursive: true })
  writeFileSync(join(round, "results/pr-metadata.json"), JSON.stringify({ number: 1, title: "Test PR" }))
  const binary = fileURLToPath(new URL("../bin/prr-darwin-universal", import.meta.url))
  const env = { ...process.env, HOME: root }
  for (const [limit, number, final] of [[1, 1, true], [5, 3, false], [5, 5, true]]) {
    writeFileSync(join(root, ".prr/config.yml"), `arbiter_rounds: ${limit}\n`)
    for (const agent of ["opencode", "codex"]) {
      execFileSync(binary, ["prompt", "--question", round, "--agent", agent, "--questions", '["Verify F-01."]', "--round", String(number)], { env })
      const prompt = readFileSync(join(round, `results/round-${number}-${agent}-question.md`), "utf8")
      assert.ok(prompt.includes(`Q&A round: ${number} of ${limit}.`))
      assert.equal(prompt.includes("This is the final Q&A round; no further clarification will follow."), final)
      assert.equal(prompt.includes("do not agree merely to reach consensus"), final)
    }
  }
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

test("large PRs use bounded evidence reads without losing review scope or isolation", () => {
  assert.match(skill, /not truncated/)
  assert.match(skill, /Read every page of a prompt before acting on it/)
  assert.match(skill, /Do not block a review merely because a source diff\/context file exceeds 2 MiB/)
  assert.match(skill, /separate 512 KiB budget, not a source-file-size limit/)
  assert.match(skill, /Do not give reviewers access to the whole results directory or to each other's outputs/)
  const prompt = readFileSync(new URL("../references/prompts/review-prompt.md", import.meta.url), "utf8")
  assert.ok(!prompt.includes("```diff\n{{diff}}"))
  assert.match(prompt, /Read every changed-file entry and the saved diff/)
  assert.match(prompt, /No section is omitted from scope/)
  assert.match(prompt, /state material coverage gaps/)
})
