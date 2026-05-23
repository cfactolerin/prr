# Trigger-Based Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PRR's current narrative-findings + Line Comments table with a single Trigger-classified Findings section that distinguishes diff-postable findings from report-only ones, end-to-end (Rust parser → prompts → skill).

**Architecture:** The Rust parser in `src/report.rs` gains a structured `Finding` shape with an `Anchor` field (`diff` | `reference` | `none`); `line_comments` is derived from diff-anchored findings only. A `--diff` flag lets the parser verify the reviewer's Anchor labels against the actual diff (downgrade mislabels, upgrade under-labels). The skill's Phase 7 splits into 7a (diff-anchored → inline GitHub comments), 7b (reference + unanchored → report-only summary), 7c (Add new). Phase 8 body regen includes both groups. Legacy reports synthesize Finding entries (anchor=diff, trigger=Code Change) so the skill walks one uniform array.

**Tech Stack:** Rust (parser, CLI), Markdown (prompts, agent personas, skill), GitHub PR REST API (Phase 8 posting).

**Spec:** `docs/superpowers/specs/2026-05-21-trigger-based-findings-design.md`

---

## File Structure

**Created (new):**
- None (only the plan itself).

**Modified — Rust (parser + CLI):**
- `src/report.rs` — `Finding` struct, `Anchor` enum, Findings-section parser, multiline bullet handling, case-insensitive parsing, validation, legacy synthesis, diff verification, derived `line_comments`.
- `src/main.rs` — `--diff` argument on `parse-report` subcommand.

**Modified — prompts:**
- `references/prompts/review-prompt.md` — per-agent review prompt: add Scope section, Trigger list with mapping guide, Findings format (at `## Findings` heading), drop per-category narrative sections.
- `references/prompts/arbiter-prompt.md` — Final Report template: Findings at `### Findings` under `## Final Report`, drop per-category narrative sections + Line Comments table.

**Modified — skill:**
- `skills/prr-start/SKILL.md` — Phase 7 split into 7a/7b/7c; Phase 8a body regen with two groups; pass `--diff` to `parse-report`; render Trigger / Why / Suggested comment / Suggested fix from `findings` directly.

**Modified — agent personas:**
- `agents/claude-reviewer.md`
- `agents/codex-reviewer.md`
- `agents/gemini-reviewer.md`
- `agents/opencode-reviewer.md`

**Modified — reference / design docs:**
- `references/report-format.md` — rewrite to match new format.
- `docs/design/prr-design.md` — replace `## Missing Things` / `## Line Comments` blocks with new Findings format.
- `CLAUDE.md` — add "Findings format" subsection.

**Modified — version metadata + binary (per repo policy):**
- `Cargo.toml`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — bump minor (binary changes).
- `bin/prr-darwin-universal` — rebuilt.
- `Cargo.lock` — auto-updated.

---

## Tasks

### Task 1: Add `Anchor` enum and extended `Finding` struct

**Files:**
- Modify: `src/report.rs` (top of file, around the existing `ParsedReport` definition)

- [ ] **Step 1: Add the failing test**

Append to the `mod tests` block in `src/report.rs`:

```rust
#[test]
fn test_finding_serializes_anchor_lowercase() {
    let finding = Finding {
        id: "F-01".into(),
        title: "Test".into(),
        trigger: "Code Change".into(),
        severity: "HIGH".into(),
        anchor: Anchor::Diff,
        location: Some("src/main.rs:42".into()),
        path: Some("src/main.rs".into()),
        line: Some(42),
        start_line: None,
        why_it_matters: "Why".into(),
        suggested_comment: "Comment".into(),
        suggested_fix: "Fix".into(),
        from_legacy: false,
    };
    let json = serde_json::to_string(&finding).unwrap();
    assert!(json.contains("\"anchor\":\"diff\""), "json was: {json}");
    assert!(!json.contains("from_legacy"), "from_legacy must not be in JSON");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --quiet test_finding_serializes_anchor_lowercase`
Expected: compilation error — `Anchor` and `Finding` are undefined.

- [ ] **Step 3: Add the types**

Just above `pub struct ParsedReport` in `src/report.rs`, add:

```rust
#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Anchor {
    Diff,
    Reference,
    None,
}

#[derive(Debug, Serialize)]
pub struct Finding {
    pub id: String,
    pub title: String,
    pub trigger: String,
    pub severity: String,
    pub anchor: Anchor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
    pub why_it_matters: String,
    pub suggested_comment: String,
    pub suggested_fix: String,
    /// Internal flag — true when synthesized from a legacy Line
    /// Comments table. Not serialized; used by the diff verifier
    /// to skip these findings.
    #[serde(skip)]
    pub from_legacy: bool,
}
```

Also add the `findings` field to `ParsedReport`:

```rust
#[derive(Debug, Serialize)]
pub struct ParsedReport {
    pub verdict: String,
    pub confidence: String,
    pub findings: Vec<Finding>,
    pub line_comments: Vec<LineComment>,
    pub review_action: Option<String>,
    pub review_body: Option<String>,
}
```

In the existing `parse_report` function, initialize `findings: Vec::new()` in the returned struct so the code compiles. (Population comes in later tasks.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --quiet test_finding_serializes_anchor_lowercase`
Expected: PASS. Also run `cargo test --quiet` to confirm no existing tests broke.

- [ ] **Step 5: Commit**

```bash
git add src/report.rs
git commit -m "feat(report): add Anchor enum and Finding struct"
```

---

### Task 2: Parse the Findings section (both heading levels)

**Files:**
- Modify: `src/report.rs`

- [ ] **Step 1: Add the failing tests**

```rust
#[test]
fn test_locate_findings_section_h3() {
    let content = "## Final Report\n\n### Verdict\n\nAPPROVE\n\n### Findings\n\n#### Trigger: Code Change\n";
    let findings = parse_findings_section(content);
    assert_eq!(findings.len(), 0); // section located but no finding bodies yet
}

#[test]
fn test_locate_findings_section_h2() {
    let content = "## Verdict\n\nAPPROVE\n\n## Findings\n\n### Trigger: Code Change\n";
    let findings = parse_findings_section(content);
    assert_eq!(findings.len(), 0);
}

#[test]
fn test_no_findings_section_returns_empty() {
    let content = "## Verdict\n\nAPPROVE\n";
    let findings = parse_findings_section(content);
    assert_eq!(findings.len(), 0);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --quiet test_locate_findings_section`
Expected: compilation error — `parse_findings_section` undefined.

- [ ] **Step 3: Add the scaffolding**

Add to `src/report.rs`:

```rust
/// Find the Findings section heading and its level.
/// Returns (start_byte_after_heading, heading_level) where heading_level
/// is 2 or 3. `None` if no Findings section.
fn find_findings_section(content: &str) -> Option<(usize, u32)> {
    let re = Regex::new(r"(?m)^(##|###)\s+Findings\s*$").ok()?;
    let m = re.captures(content)?;
    let level = m.get(1).unwrap().as_str().len() as u32;
    let end = m.get(0).unwrap().end();
    Some((end, level))
}

/// Top-level: parse the Findings section and return its findings.
/// Returns an empty Vec if no Findings section is present.
pub fn parse_findings_section(content: &str) -> Vec<Finding> {
    let Some((_start, _level)) = find_findings_section(content) else {
        return Vec::new();
    };
    // Population happens in Task 3+.
    Vec::new()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --quiet test_locate_findings_section test_no_findings_section`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/report.rs
git commit -m "feat(report): locate Findings section at h2 or h3"
```

---

### Task 3: Parse Trigger groups and finding headings

**Files:**
- Modify: `src/report.rs`

- [ ] **Step 1: Add the failing test**

```rust
#[test]
fn test_parse_finding_headings() {
    let content = r#"## Findings

### Trigger: Code Change

#### F-01 — First finding

- **Severity:** HIGH
- **Anchor:** diff
- **Location:** `src/main.rs:42`
- **Why this matters:** It matters.
- **Suggested comment:** Comment text.
- **Suggested fix:** Fix it.

### Trigger: Security

#### F-02 — Second finding

- **Severity:** MED
- **Anchor:** none
- **Why this matters:** Also matters.
- **Suggested comment:** Other comment.
- **Suggested fix:** Other fix.
"#;
    let findings = parse_findings_section(content);
    assert_eq!(findings.len(), 2);
    assert_eq!(findings[0].id, "F-01");
    assert_eq!(findings[0].title, "First finding");
    assert_eq!(findings[0].trigger, "Code Change");
    assert_eq!(findings[1].id, "F-02");
    assert_eq!(findings[1].trigger, "Security");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --quiet test_parse_finding_headings`
Expected: FAIL — currently returns empty Vec.

- [ ] **Step 3: Implement Trigger + finding heading parsing**

Update `parse_findings_section`:

```rust
pub fn parse_findings_section(content: &str) -> Vec<Finding> {
    let Some((start, level)) = find_findings_section(content) else {
        return Vec::new();
    };
    let body = &content[start..];

    // Heading patterns scaled to the Findings section level:
    let trigger_level = level + 1;
    let finding_level = level + 2;
    let trigger_re = Regex::new(&format!(
        r"(?m)^{}\s+Trigger:\s*(.+?)\s*$",
        "#".repeat(trigger_level as usize)
    )).unwrap();
    let finding_re = Regex::new(&format!(
        r"(?m)^{}\s+(F-\d+)\s+[—\-]\s+(.+?)\s*$",
        "#".repeat(finding_level as usize)
    )).unwrap();
    // Stop at any heading at the Findings level or shallower:
    let stop_re = Regex::new(&format!(
        r"(?m)^#{{1,{}}}\s+",
        level
    )).unwrap();

    let mut findings = Vec::new();
    let mut current_trigger: Option<String> = None;
    let mut pos: usize = 0;

    // Stop the search at the first occurrence of a stop heading.
    let search_end = stop_re.find(body).map(|m| m.start()).unwrap_or(body.len());
    let scope = &body[..search_end];

    // Walk through Trigger and Finding headings interleaved.
    let mut events: Vec<(usize, &str)> = Vec::new();
    for m in trigger_re.captures_iter(scope) {
        events.push((m.get(0).unwrap().start(), "T"));
    }
    for m in finding_re.captures_iter(scope) {
        events.push((m.get(0).unwrap().start(), "F"));
    }
    events.sort_by_key(|&(p, _)| p);

    // Re-scan in order:
    let _ = pos; // pos is unused for now; bullet parsing happens in Task 4
    for (start_idx, kind) in events {
        let line_end = scope[start_idx..]
            .find('\n')
            .map(|i| start_idx + i)
            .unwrap_or(scope.len());
        let line = &scope[start_idx..line_end];
        if kind == "T" {
            let caps = trigger_re.captures(line).unwrap();
            current_trigger = Some(caps[1].to_string());
        } else {
            let caps = finding_re.captures(line).unwrap();
            let Some(trigger) = current_trigger.clone() else {
                // Finding heading without a Trigger group above it — skip.
                continue;
            };
            findings.push(Finding {
                id: caps[1].to_string(),
                title: caps[2].to_string(),
                trigger,
                severity: String::new(),
                anchor: Anchor::None,
                location: None,
                path: None,
                line: None,
                start_line: None,
                why_it_matters: String::new(),
                suggested_comment: String::new(),
                suggested_fix: String::new(),
                from_legacy: false,
            });
        }
    }
    findings
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --quiet test_parse_finding_headings`
Expected: PASS (titles, IDs, triggers populated; bullets still empty — populated in Task 4).

- [ ] **Step 5: Commit**

```bash
git add src/report.rs
git commit -m "feat(report): walk Trigger groups and finding headings"
```

---

### Task 4: Parse finding bullets (with multiline continuation and case-insensitive keys)

**Files:**
- Modify: `src/report.rs`

- [ ] **Step 1: Add the failing test**

```rust
#[test]
fn test_parse_finding_bullets_full() {
    let content = r#"## Findings

### Trigger: Code Change

#### F-01 — Title here

- **Severity:** HIGH
- **Anchor:** diff
- **Location:** `src/main.rs:42`
- **Why this matters:** Sentence one.
  Sentence two continues on a second line.
- **Suggested comment:** Body of the comment that the
  author should post on the PR.
- **Suggested fix:** Replace `x` with `y` at line 42.
"#;
    let findings = parse_findings_section(content);
    assert_eq!(findings.len(), 1);
    let f = &findings[0];
    assert_eq!(f.severity, "HIGH");
    assert_eq!(f.anchor, Anchor::Diff);
    assert_eq!(f.location.as_deref(), Some("src/main.rs:42"));
    assert_eq!(f.path.as_deref(), Some("src/main.rs"));
    assert_eq!(f.line, Some(42));
    assert!(f.why_it_matters.starts_with("Sentence one."));
    assert!(f.why_it_matters.contains("Sentence two continues"));
    assert!(f.suggested_comment.contains("author should post"));
    assert!(f.suggested_fix.contains("Replace"));
}

#[test]
fn test_parse_finding_bullets_case_insensitive() {
    let content = r#"## Findings

### Trigger: Code Change

#### F-01 — Title

- **severity:** HIGH
- **ANCHOR:** Diff
- **Location:** `src/main.rs:42`
- **why this matters:** Why.
- **Suggested Comment:** Comment.
- **suggested fix:** Fix.
"#;
    let findings = parse_findings_section(content);
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].severity, "HIGH");
    assert_eq!(findings[0].anchor, Anchor::Diff);
    assert_eq!(findings[0].why_it_matters, "Why.");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --quiet test_parse_finding_bullets`
Expected: FAIL — bullets aren't parsed yet (fields are empty strings).

- [ ] **Step 3: Add the bullet parser**

Replace the body-building loop in `parse_findings_section` to also capture the bullet block for each finding. Add a helper:

```rust
/// Parse the bullet block belonging to a finding. Returns key→value
/// map with keys lowercased. Multiline values are space-joined; blank
/// lines end a value.
fn parse_finding_bullets(block: &str) -> std::collections::HashMap<String, String> {
    let bullet_re = Regex::new(r"^-\s*\*\*([^:*]+):\*\*\s*(.*)$").unwrap();
    let mut out = std::collections::HashMap::new();
    let mut current_key: Option<String> = None;
    let mut current_val: Vec<String> = Vec::new();

    let flush = |key: &Option<String>, val: &Vec<String>, out: &mut std::collections::HashMap<String, String>| {
        if let Some(k) = key {
            out.insert(k.clone(), val.join(" ").trim().to_string());
        }
    };

    for line in block.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            // Blank line ends the current bullet value
            flush(&current_key, &current_val, &mut out);
            current_key = None;
            current_val.clear();
            continue;
        }
        if let Some(caps) = bullet_re.captures(trimmed) {
            // New bullet — flush previous
            flush(&current_key, &current_val, &mut out);
            current_val.clear();
            current_key = Some(caps[1].trim().to_lowercase());
            let initial = caps[2].trim().to_string();
            if !initial.is_empty() {
                current_val.push(initial);
            }
        } else if current_key.is_some() {
            // Continuation line
            current_val.push(trimmed.trim().to_string());
        }
        // Lines outside any bullet are ignored.
    }
    flush(&current_key, &current_val, &mut out);
    out
}

fn parse_anchor(s: &str) -> Option<Anchor> {
    match s.trim().to_lowercase().as_str() {
        "diff" => Some(Anchor::Diff),
        "reference" => Some(Anchor::Reference),
        "none" => Some(Anchor::None),
        _ => None,
    }
}
```

Then modify the body-building loop in `parse_findings_section` to extract each finding's bullet block (the text between its heading and the next finding-or-stop heading) and call `parse_finding_bullets`:

```rust
// Replace the previous loop body. For each finding heading, locate
// the start of the next finding heading or stop heading to bound the
// bullet block.
let mut findings = Vec::new();
let mut current_trigger: Option<String> = None;

// Build a sorted list of all heading positions (Trigger + Finding +
// stop) so we know where to terminate each bullet block.
let mut headings: Vec<(usize, &str)> = Vec::new();
for m in trigger_re.captures_iter(scope) {
    headings.push((m.get(0).unwrap().start(), "T"));
}
for m in finding_re.captures_iter(scope) {
    headings.push((m.get(0).unwrap().start(), "F"));
}
headings.push((scope.len(), "END"));
headings.sort_by_key(|&(p, _)| p);

for window in headings.windows(2) {
    let (start_idx, kind) = window[0];
    let (next_start, _) = window[1];
    let line_end = scope[start_idx..].find('\n').map(|i| start_idx + i).unwrap_or(scope.len());
    let heading_line = &scope[start_idx..line_end];

    if kind == "T" {
        let caps = trigger_re.captures(heading_line).unwrap();
        current_trigger = Some(caps[1].to_string());
        continue;
    }
    if kind == "F" {
        let caps = finding_re.captures(heading_line).unwrap();
        let Some(trigger) = current_trigger.clone() else { continue; };
        let block = &scope[line_end..next_start];
        let bullets = parse_finding_bullets(block);

        let severity = bullets.get("severity").cloned().unwrap_or_default();
        let anchor_str = bullets.get("anchor").cloned().unwrap_or_default();
        let anchor = parse_anchor(&anchor_str).unwrap_or(Anchor::None);
        let location = bullets.get("location").cloned();
        let why = bullets.get("why this matters").cloned().unwrap_or_default();
        let sc = bullets.get("suggested comment").cloned().unwrap_or_default();
        let sf = bullets.get("suggested fix").cloned().unwrap_or_default();

        let (path, line, start_line) = location.as_deref()
            .and_then(parse_location)
            .map(|(p, l, s)| (Some(p), Some(l), s))
            .unwrap_or((None, None, None));

        findings.push(Finding {
            id: caps[1].to_string(),
            title: caps[2].to_string(),
            trigger,
            severity,
            anchor,
            location,
            path,
            line,
            start_line,
            why_it_matters: why,
            suggested_comment: sc,
            suggested_fix: sf,
            from_legacy: false,
        });
    }
}
```

Add a Location parser:

```rust
/// Parse "path/to/file:42" or "path/to/file:100-105" or
/// "path/to/file:610, 623" into (path, end_line, start_line).
fn parse_location(loc: &str) -> Option<(String, u64, Option<u64>)> {
    let trimmed = loc.trim().trim_matches('`');
    let (path, rest) = trimmed.rsplit_once(':')?;
    let (end, start) = parse_line_ref(rest);
    if end == 0 { return None; }
    Some((path.to_string(), end, start))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --quiet test_parse_finding_bullets`
Expected: PASS (full + case-insensitive variants).

- [ ] **Step 5: Commit**

```bash
git add src/report.rs
git commit -m "feat(report): parse finding bullets with multiline continuation"
```

---

### Task 5: Validation — required bullets, conditional Location, closed Trigger list

**Files:**
- Modify: `src/report.rs`

- [ ] **Step 1: Add the failing tests**

```rust
#[test]
fn test_validation_missing_required_bullet_skipped() {
    let content = r#"## Findings

### Trigger: Code Change

#### F-01 — Missing why

- **Severity:** HIGH
- **Anchor:** diff
- **Location:** `src/main.rs:42`
- **Suggested comment:** Comment.
- **Suggested fix:** Fix.
"#;
    let findings = parse_findings_section(content);
    assert_eq!(findings.len(), 0, "finding missing 'Why this matters' must be skipped");
}

#[test]
fn test_validation_anchor_none_with_location_skipped() {
    let content = r#"## Findings

### Trigger: Code Change

#### F-01 — Anchor none with location

- **Severity:** HIGH
- **Anchor:** none
- **Location:** `src/main.rs:42`
- **Why this matters:** w
- **Suggested comment:** c
- **Suggested fix:** f
"#;
    let findings = parse_findings_section(content);
    assert_eq!(findings.len(), 0);
}

#[test]
fn test_validation_anchor_diff_without_location_skipped() {
    let content = r#"## Findings

### Trigger: Code Change

#### F-01 — Anchor diff missing location

- **Severity:** HIGH
- **Anchor:** diff
- **Why this matters:** w
- **Suggested comment:** c
- **Suggested fix:** f
"#;
    let findings = parse_findings_section(content);
    assert_eq!(findings.len(), 0);
}

#[test]
fn test_validation_unknown_trigger_skipped() {
    let content = r#"## Findings

### Trigger: Banana

#### F-01 — Bad trigger

- **Severity:** HIGH
- **Anchor:** none
- **Why this matters:** w
- **Suggested comment:** c
- **Suggested fix:** f
"#;
    let findings = parse_findings_section(content);
    assert_eq!(findings.len(), 0);
}

#[test]
fn test_validation_anchor_none_no_location_passes() {
    let content = r#"## Findings

### Trigger: Missing Test

#### F-01 — Cross-cutting

- **Severity:** MED
- **Anchor:** none
- **Why this matters:** w
- **Suggested comment:** c
- **Suggested fix:** f
"#;
    let findings = parse_findings_section(content);
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].anchor, Anchor::None);
    assert!(findings[0].location.is_none());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --quiet test_validation_`
Expected: most FAIL because validation isn't enforced yet.

- [ ] **Step 3: Add validation**

Add near the top of `src/report.rs`:

```rust
const KNOWN_TRIGGERS: &[&str] = &[
    "Acceptance Criteria",
    "Code Change",
    "Code Quality",
    "Logic Bug",
    "Security",
    "Performance",
    "Missing Test",
    "Missing Doc / Error Handling",
];

fn validate_finding(f: &Finding) -> Result<(), String> {
    if !KNOWN_TRIGGERS.iter().any(|t| t.eq_ignore_ascii_case(&f.trigger)) {
        return Err(format!("unknown Trigger '{}'", f.trigger));
    }
    if f.severity.is_empty() {
        return Err("missing Severity".into());
    }
    if f.why_it_matters.is_empty() {
        return Err("missing 'Why this matters'".into());
    }
    if f.suggested_comment.is_empty() {
        return Err("missing 'Suggested comment'".into());
    }
    if f.suggested_fix.is_empty() {
        return Err("missing 'Suggested fix'".into());
    }
    match f.anchor {
        Anchor::Diff | Anchor::Reference => {
            if f.location.is_none() {
                return Err(format!("Anchor: {:?} requires a Location", f.anchor));
            }
        }
        Anchor::None => {
            if f.location.is_some() {
                return Err("Anchor: none must not have a Location".into());
            }
        }
    }
    Ok(())
}
```

In `parse_findings_section`, after constructing each `Finding`, validate before pushing:

```rust
let finding = Finding { /* ... */ };
match validate_finding(&finding) {
    Ok(()) => findings.push(finding),
    Err(msg) => eprintln!(
        "warning: skipping finding {} ({}): {}",
        finding.id, finding.title, msg
    ),
}
```

Also: the existing `parse_anchor` returns `None` for unknown values, which currently falls back to `Anchor::None` and would mis-validate. Tighten the call site:

```rust
let anchor = match parse_anchor(&anchor_str) {
    Some(a) => a,
    None => {
        eprintln!(
            "warning: skipping finding {} — unknown Anchor '{}'",
            caps[1].to_string(), anchor_str
        );
        continue;
    }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --quiet test_validation_`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report.rs
git commit -m "feat(report): validate required bullets + closed Trigger list"
```

---

### Task 6: Derive `line_comments` from diff-anchored findings

**Files:**
- Modify: `src/report.rs`

- [ ] **Step 1: Add the failing test**

```rust
#[test]
fn test_line_comments_derived_from_diff_anchored_only() {
    let content = r#"## Findings

### Trigger: Code Change

#### F-01 — Inline-able

- **Severity:** HIGH
- **Anchor:** diff
- **Location:** `src/main.rs:42`
- **Why this matters:** w1
- **Suggested comment:** Body 1
- **Suggested fix:** f1

#### F-02 — Reference-anchored

- **Severity:** MED
- **Anchor:** reference
- **Location:** `lib/foo.rb:10`
- **Why this matters:** w2
- **Suggested comment:** Body 2
- **Suggested fix:** f2

#### F-03 — Cross-cutting

- **Severity:** LOW
- **Anchor:** none
- **Why this matters:** w3
- **Suggested comment:** Body 3
- **Suggested fix:** f3
"#;
    let report = parse_report(content);
    assert_eq!(report.findings.len(), 3);
    assert_eq!(report.line_comments.len(), 1);
    assert_eq!(report.line_comments[0].path, "src/main.rs");
    assert_eq!(report.line_comments[0].line, 42);
    assert_eq!(report.line_comments[0].body, "Body 1");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --quiet test_line_comments_derived_from_diff_anchored_only`
Expected: FAIL — `findings` is still empty in `parse_report`'s output, and the derived `line_comments` isn't wired up.

- [ ] **Step 3: Wire findings into `parse_report` and derive line_comments**

In `parse_report`, after computing `verdict` / `confidence`, populate `findings`:

```rust
let findings = parse_findings_section(content);
```

Add a derivation helper:

```rust
fn derive_line_comments(findings: &[Finding]) -> Vec<LineComment> {
    findings.iter()
        .filter(|f| f.anchor == Anchor::Diff)
        .filter_map(|f| {
            let path = f.path.clone()?;
            let line = f.line?;
            Some(LineComment {
                checked: true,
                path,
                line,
                start_line: f.start_line,
                url: None,
                body: f.suggested_comment.clone(),
            })
        })
        .collect()
}
```

Use it in `parse_report`. The existing `extract_line_comments` fallback is kept for the legacy path (Task 9 wires this together):

```rust
let findings = parse_findings_section(content);
let line_comments = if findings.is_empty() {
    extract_line_comments(content)  // legacy fallback
} else {
    derive_line_comments(&findings)
};
```

Return `findings` and `line_comments` in the `ParsedReport`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --quiet test_line_comments_derived_from_diff_anchored_only`
Expected: PASS. Also run full `cargo test --quiet` to confirm no regression on old-format tests (they should still pass via the legacy fallback).

- [ ] **Step 5: Commit**

```bash
git add src/report.rs
git commit -m "feat(report): derive line_comments from diff-anchored findings"
```

---

### Task 7: Synthesize legacy `Line Comments` into Finding entries

**Files:**
- Modify: `src/report.rs`

- [ ] **Step 1: Add the failing test**

```rust
#[test]
fn test_legacy_line_comments_synthesized_to_findings() {
    let content = r#"### Verdict

REQUEST_CHANGES

### Line Comments

| File | Line | Issue | Severity |
|------|------|-------|----------|
| `src/main.rs` | 42 | Fix null check | HIGH |
| `lib/foo.rb` | 10 | Consider logging | LOW |
"#;
    let report = parse_report(content);
    assert_eq!(report.findings.len(), 2);
    assert_eq!(report.findings[0].anchor, Anchor::Diff);
    assert_eq!(report.findings[0].trigger, "Code Change");
    assert_eq!(report.findings[0].severity, "HIGH");
    assert_eq!(report.findings[0].suggested_comment, "Fix null check");
    assert!(report.findings[0].from_legacy);
    assert_eq!(report.findings[1].severity, "LOW");
    // line_comments still populated for legacy consumers
    assert_eq!(report.line_comments.len(), 2);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --quiet test_legacy_line_comments_synthesized_to_findings`
Expected: FAIL — `findings` is empty for legacy reports.

- [ ] **Step 3: Add the synthesis path**

Update the fallback in `parse_report`:

```rust
let (findings, line_comments) = {
    let new_findings = parse_findings_section(content);
    if !new_findings.is_empty() {
        let lc = derive_line_comments(&new_findings);
        (new_findings, lc)
    } else {
        let legacy_lc = extract_line_comments(content);
        let synthesized = synthesize_findings_from_legacy(&legacy_lc);
        (synthesized, legacy_lc)
    }
};
```

Add:

```rust
fn synthesize_findings_from_legacy(legacy: &[LineComment]) -> Vec<Finding> {
    legacy.iter().enumerate().map(|(i, lc)| {
        // Severity isn't directly available on LineComment in the
        // current schema. The body contains the issue text; the
        // table's Severity column is captured into the body only
        // when the table-parse regex includes it — for now, default
        // MED and let the legacy verification carve-out preserve the
        // line_comments invariant.
        Finding {
            id: format!("F-{:02}", i + 1),
            title: first_n_words(&lc.body, 8),
            trigger: "Code Change".into(),
            severity: "MED".into(),
            anchor: Anchor::Diff,
            location: Some(format!("{}:{}", lc.path, lc.line)),
            path: Some(lc.path.clone()),
            line: Some(lc.line),
            start_line: lc.start_line,
            why_it_matters: "(legacy report — not classified)".into(),
            suggested_comment: lc.body.clone(),
            suggested_fix: "(legacy report — no fix suggested)".into(),
            from_legacy: true,
        }
    }).collect()
}

fn first_n_words(s: &str, n: usize) -> String {
    s.split_whitespace().take(n).collect::<Vec<_>>().join(" ")
}
```

For the severity-from-table case mentioned in the spec, extend the new-table regex captures to forward the Severity column into a side channel — or accept MED as the default for legacy reports (the spec allows the default). Default MED is fine for the cache-compat invariant; the actual `line_comments` array (which is what the compat check tests) is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --quiet test_legacy_line_comments_synthesized_to_findings`
Expected: PASS. Confirm no regression in existing `test_old_format_*` tests.

- [ ] **Step 5: Commit**

```bash
git add src/report.rs
git commit -m "feat(report): synthesize legacy Line Comments into Findings"
```

---

### Task 8: Add `--diff` CLI argument

**Files:**
- Modify: `src/main.rs`
- Modify: `src/report.rs`

- [ ] **Step 1: Inspect the current `parse-report` subcommand definition**

Run: `grep -n "parse-report\|ParseReport\|parse_report\|parse_and_print" src/main.rs`

You'll see how the subcommand is defined (probably with `clap` derive). Note the exact pattern used.

- [ ] **Step 2: Add the failing test**

In `src/report.rs`:

```rust
#[test]
fn test_parse_and_print_accepts_optional_diff() {
    // The public entry point should accept Option<&str> for diff path.
    let dir = tempfile::tempdir().unwrap();
    let report_path = dir.path().join("report.md");
    std::fs::write(&report_path, "### Verdict\n\nAPPROVE\n").unwrap();
    // None means: no diff verification.
    parse_and_print(report_path.to_str().unwrap(), None).unwrap();
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --quiet test_parse_and_print_accepts_optional_diff`
Expected: FAIL — `parse_and_print` currently takes one argument.

- [ ] **Step 4: Update the signature in `src/report.rs`**

Change `parse_and_print` to accept the diff path. For this task it ignores the diff (verification wiring lands in Task 10):

```rust
pub fn parse_and_print(report_path: &str, _diff_path: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(report_path)?;
    let report = parse_report(&content);
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
```

No new wrapper function — Task 10 introduces `parse_report_inner` and rewrites this body to call it. Renaming the unused parameter to `_diff_path` keeps the compiler quiet without leaving a placeholder behind.

- [ ] **Step 5: Update `src/main.rs`**

In the `parse-report` subcommand definition, add a `--diff <path>` argument. Example pattern (adjust to match the existing style):

```rust
ParseReport {
    /// Path to the final-report.md file.
    report: String,
    /// Optional path to a unified diff for Anchor verification.
    #[arg(long)]
    diff: Option<String>,
},
```

And in the dispatcher:

```rust
Cmd::ParseReport { report, diff } => {
    report::parse_and_print(&report, diff.as_deref())?;
}
```

- [ ] **Step 6: Run tests + binary**

Run: `cargo build --release` (verify it compiles).
Run: `cargo test --quiet test_parse_and_print_accepts_optional_diff`
Expected: PASS.

Also smoke-test the CLI:

```bash
echo "### Verdict\n\nAPPROVE\n" > /tmp/report.md
cargo run --release --quiet -- parse-report /tmp/report.md
cargo run --release --quiet -- parse-report /tmp/report.md --diff /tmp/nonexistent.diff
```

The first must print JSON with `"verdict":"APPROVE"`. The second must also succeed (warning to stderr OK from Task 10 onward; for now the wrapper just delegates).

- [ ] **Step 7: Commit**

```bash
git add src/main.rs src/report.rs
git commit -m "feat(parse-report): add optional --diff CLI flag"
```

---

### Task 9: Parse unified diff into per-file added-line ranges

**Files:**
- Modify: `src/report.rs`

- [ ] **Step 1: Add the failing test**

```rust
#[test]
fn test_diff_added_lines_per_file() {
    let diff = r#"diff --git a/src/foo.rs b/src/foo.rs
index abc..def 100644
--- a/src/foo.rs
+++ b/src/foo.rs
@@ -10,3 +10,5 @@ fn x() {
     let a = 1;
+    let b = 2;
+    let c = 3;
     let d = 4;
diff --git a/lib/bar.rb b/lib/bar.rb
new file mode 100644
--- /dev/null
+++ b/lib/bar.rb
@@ -0,0 +1,2 @@
+puts "hi"
+puts "bye"
"#;
    let map = parse_diff_added_lines(diff);
    let foo = map.get("src/foo.rs").unwrap();
    assert!(foo.contains(&11));
    assert!(foo.contains(&12));
    assert!(!foo.contains(&10));
    assert!(!foo.contains(&13));
    let bar = map.get("lib/bar.rb").unwrap();
    assert!(bar.contains(&1));
    assert!(bar.contains(&2));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --quiet test_diff_added_lines_per_file`
Expected: FAIL — `parse_diff_added_lines` doesn't exist.

- [ ] **Step 3: Implement the diff parser**

Add to `src/report.rs`:

```rust
use std::collections::{HashMap, HashSet};

/// Walk a unified diff and return, per new-file path, the set of
/// line numbers in the new file that were added (lines starting
/// with `+`, excluding the `+++` file header).
pub fn parse_diff_added_lines(diff: &str) -> HashMap<String, HashSet<u64>> {
    let mut out: HashMap<String, HashSet<u64>> = HashMap::new();
    let hunk_re = Regex::new(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@").unwrap();

    let mut current_path: Option<String> = None;
    let mut current_line: u64 = 0;

    for line in diff.lines() {
        // New-file header
        if let Some(rest) = line.strip_prefix("+++ ") {
            let path = rest.trim_start_matches("b/").trim();
            if path == "/dev/null" {
                current_path = None;
            } else {
                current_path = Some(path.to_string());
            }
            current_line = 0;
            continue;
        }
        // Old-file header — ignore for new-file accounting
        if line.starts_with("--- ") { continue; }

        // Hunk header
        if let Some(caps) = hunk_re.captures(line) {
            current_line = caps[1].parse().unwrap_or(0);
            continue;
        }

        if current_path.is_none() || current_line == 0 { continue; }
        let path = current_path.as_ref().unwrap();

        if let Some(c) = line.chars().next() {
            match c {
                '+' => {
                    out.entry(path.clone()).or_default().insert(current_line);
                    current_line += 1;
                }
                ' ' => { current_line += 1; }
                '-' => { /* removed; new-file line unchanged */ }
                _ => { /* "\\ No newline at end of file" or other; ignore */ }
            }
        }
    }
    out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --quiet test_diff_added_lines_per_file`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/report.rs
git commit -m "feat(report): parse unified diff into per-file added-line sets"
```

---

### Task 10: Anchor verification — downgrade mislabels, upgrade under-labels, skip legacy

**Files:**
- Modify: `src/report.rs`

- [ ] **Step 1: Add the failing tests**

```rust
#[test]
fn test_anchor_downgrade_when_location_not_in_diff() {
    let content = r#"## Findings

### Trigger: Code Change

#### F-01 — Mislabeled

- **Severity:** HIGH
- **Anchor:** diff
- **Location:** `src/foo.rs:99`
- **Why this matters:** w
- **Suggested comment:** c
- **Suggested fix:** f
"#;
    let diff = "diff --git a/src/foo.rs b/src/foo.rs\n--- a/src/foo.rs\n+++ b/src/foo.rs\n@@ -10,1 +10,2 @@\n line\n+added\n";
    let report = parse_report_inner(content, Some(diff));
    assert_eq!(report.findings.len(), 1);
    assert_eq!(report.findings[0].anchor, Anchor::Reference);
    assert_eq!(report.line_comments.len(), 0);
}

#[test]
fn test_anchor_upgrade_when_location_in_diff() {
    let content = r#"## Findings

### Trigger: Code Change

#### F-01 — Under-labeled

- **Severity:** HIGH
- **Anchor:** reference
- **Location:** `src/foo.rs:11`
- **Why this matters:** w
- **Suggested comment:** c
- **Suggested fix:** f
"#;
    let diff = "--- a/src/foo.rs\n+++ b/src/foo.rs\n@@ -10,1 +10,2 @@\n line\n+added\n";
    let report = parse_report_inner(content, Some(diff));
    assert_eq!(report.findings[0].anchor, Anchor::Diff);
    assert_eq!(report.line_comments.len(), 1);
}

#[test]
fn test_anchor_range_partially_outside_diff_downgraded() {
    let content = r#"## Findings

### Trigger: Code Change

#### F-01 — Range partially outside

- **Severity:** HIGH
- **Anchor:** diff
- **Location:** `src/foo.rs:11-13`
- **Why this matters:** w
- **Suggested comment:** c
- **Suggested fix:** f
"#;
    // Diff covers lines 11-12 but not 13.
    let diff = "--- a/src/foo.rs\n+++ b/src/foo.rs\n@@ -10,1 +10,3 @@\n line\n+added1\n+added2\n";
    let report = parse_report_inner(content, Some(diff));
    assert_eq!(report.findings[0].anchor, Anchor::Reference);
}

#[test]
fn test_legacy_findings_bypass_verification() {
    let content = r#"### Verdict

REQUEST_CHANGES

### Line Comments

| File | Line | Issue | Severity |
|------|------|-------|----------|
| `src/foo.rs` | 99 | Issue here | HIGH |
"#;
    // Diff does NOT contain src/foo.rs:99
    let diff = "--- a/other.rs\n+++ b/other.rs\n@@ -1,1 +1,2 @@\n a\n+b\n";
    let report = parse_report_inner(content, Some(diff));
    assert_eq!(report.findings.len(), 1);
    assert_eq!(report.findings[0].anchor, Anchor::Diff);
    assert_eq!(report.line_comments.len(), 1, "legacy line_comments invariant must hold");
}
```

These tests target `parse_report_inner` directly — it's the function Task 10 introduces (next step) that accepts diff content rather than a path. The on-disk loading happens in `parse_and_print`, which the CLI calls and which Task 10 also updates.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --quiet test_anchor_downgrade test_anchor_upgrade test_legacy_findings_bypass`
Expected: FAIL.

- [ ] **Step 3: Implement verification**

Refactor `parse_report` to delegate to an inner function that takes diff content:

```rust
pub fn parse_report(content: &str) -> ParsedReport {
    parse_report_inner(content, None)
}

pub fn parse_report_inner(content: &str, diff: Option<&str>) -> ParsedReport {
    // ... existing verdict / confidence parsing ...

    let mut findings = parse_findings_section(content);

    // Diff verification
    if let Some(diff_text) = diff {
        let added = parse_diff_added_lines(diff_text);
        verify_anchors(&mut findings, &added);
    }

    let line_comments = if findings.is_empty() {
        // No new-format findings — fall back to legacy table extraction,
        // then synthesize Findings from those rows.
        let legacy_lc = extract_line_comments(content);
        let synthesized = synthesize_findings_from_legacy(&legacy_lc);
        // Note: synthesized findings have `from_legacy = true`; the
        // verifier (already called above when diff is Some) does NOT
        // see them because we synthesize AFTER verification. The
        // `parse_diff_added_lines` map is therefore not used for
        // legacy paths, preserving the cache-compat invariant.
        findings = synthesized;
        legacy_lc
    } else {
        derive_line_comments(&findings)
    };

    ParsedReport { /* ... */ findings, line_comments, ... }
}

fn verify_anchors(findings: &mut [Finding], added: &std::collections::HashMap<String, std::collections::HashSet<u64>>) {
    for f in findings.iter_mut() {
        if f.from_legacy { continue; }
        let Some(path) = f.path.as_deref() else { continue; };
        let Some(line) = f.line else { continue; };
        let start = f.start_line.unwrap_or(line);
        let in_diff = (start..=line).all(|l| {
            added.get(path).map(|set| set.contains(&l)).unwrap_or(false)
        });
        match (f.anchor, in_diff) {
            (Anchor::Diff, false) => {
                eprintln!(
                    "warning: finding {} ({}) labeled Anchor:diff but {} not in diff; downgrading to reference",
                    f.id, f.title, f.location.as_deref().unwrap_or("")
                );
                f.anchor = Anchor::Reference;
            }
            (Anchor::Reference, true) => {
                // Silent upgrade
                f.anchor = Anchor::Diff;
            }
            _ => {}
        }
    }
}
```

Update `parse_and_print` to read the diff from disk and pass it:

```rust
pub fn parse_and_print(report_path: &str, diff_path: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(report_path)?;
    let diff = match diff_path {
        Some(p) => match std::fs::read_to_string(p) {
            Ok(text) => Some(text),
            Err(e) => {
                eprintln!("warning: diff unreadable at {p} ({e}) — verification skipped");
                None
            }
        },
        None => None,
    };
    let report = parse_report_inner(&content, diff.as_deref());
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --quiet test_anchor_downgrade test_anchor_upgrade test_legacy_findings_bypass`
Expected: PASS. Run full `cargo test --quiet` to check for regressions.

- [ ] **Step 5: Commit**

```bash
git add src/report.rs
git commit -m "feat(report): verify Anchor labels against diff (with legacy carve-out)"
```

---

### Task 11: End-to-end Rust parse-report smoke test

**Files:**
- Read-only: existing cached workspace

- [ ] **Step 1: Run the binary against an old cached report**

```bash
cargo run --release --quiet -- parse-report /Users/cris/.prr/workspace/IndependentIP-bulk-pr-1301/r1/results/final-report.md
```

Verify:
- `verdict` and `confidence` are unchanged (REQUEST_CHANGES / HIGH).
- `line_comments.length` matches what the pre-change binary produced (21 entries, all from the legacy table).
- `findings.length` is also 21 — synthesized.
- Each synthesized finding has `"anchor":"diff"`, `"trigger":"Code Change"`.

- [ ] **Step 2: Run with `--diff` pointing to the same round's diff**

```bash
cargo run --release --quiet -- parse-report \
  /Users/cris/.prr/workspace/IndependentIP-bulk-pr-1301/r1/results/final-report.md \
  --diff /Users/cris/.prr/workspace/IndependentIP-bulk-pr-1301/r1/results/diff.txt
```

Verify:
- `line_comments.length` is unchanged (legacy carve-out — diff verification bypassed for synthesized findings).
- No "downgrading" warnings on stderr.

- [ ] **Step 3: No commit needed**

This is a manual verification of the Rust changes. If anything fails, return to the corresponding task and fix.

---

### Task 12: Update `references/prompts/review-prompt.md` (per-agent review prompt)

**Files:**
- Modify: `references/prompts/review-prompt.md`

- [ ] **Step 1: Replace the instructions + output-format sections**

The new file content (full replacement of everything from `## Instructions` to end of file):

```markdown
## Reviewer Tasks

{{reviewer_tasks}}

---

## Scope

A finding may appear in your review **only if** at least one of:

1. It is caused by, exposed by, or directly affected by a line in the diff.
2. It is required by the ticket's Acceptance Criteria but missing or violated by the diff (or by code the diff relies on).

If neither holds, drop the finding. Specifically:

- A complaint about unchanged code with no connection to the diff or the AC is **not allowed**.
- A complaint about unchanged code that the diff now relies on **is allowed**, but anchor on the new call site (the line in the diff), not on the unchanged method body.
- An AC requirement that unchanged code violates **is allowed**, with `Trigger: Acceptance Criteria`. Use `Anchor: reference` — the finding won't be posted as an inline comment but will be summarized in the review body.

## Instructions

You are an expert code reviewer. Review this pull request thoroughly and rigorously.

Work through each of the following checks in order:

1. **Ticket Alignment** — Does the code implement exactly what the ticket requires?
2. **Flow Tracing** — Trace the execution path for the main change. Does the logic flow correctly end to end?
3. **Code Quality** — Naming, readability, duplication, structure, adherence to repo conventions.
4. **Missing Things** — Error handling, edge cases, tests, documentation, logging.
5. **Logic Bugs** — Off-by-ones, race conditions, incorrect assumptions, wrong data transformations.
6. **Security** — Injection risks, auth bypass, secret exposure, unsafe deserialization.
7. **Performance / Resource** — Leaks, unbounded growth, missing cleanup, slow queries.
8. **Hallucination Check** — Re-read your findings. Verify each is grounded in the diff or the ticket AC. Drop anything unrelated to both.
9. **Proof of Findings** — For every finding, the Location must point to a real file:line you've read.

## Findings Format

Every finding you produce must carry a `Trigger` label from this closed list (pick exactly one — the one that best explains *why the finding matters*):

| Symptom | Trigger |
|---------|---------|
| Diff violates a ticket AC (or unchanged code that the AC requires violates it) | `Acceptance Criteria` |
| Diff is functionally wrong: off-by-one, race condition, wrong assumption | `Logic Bug` |
| Diff exposes injection / auth bypass / secret leak / unsafe deserialization | `Security` |
| Diff introduces a memory leak, unbounded growth, missing cleanup, slow query, expensive loop | `Performance` |
| Diff has naming / duplication / readability / structural issues | `Code Quality` |
| Diff adds new behaviour without a corresponding test | `Missing Test` |
| Diff adds new behaviour without docs, comments, or error handling | `Missing Doc / Error Handling` |
| Diff looks suspicious but fits none of the above | `Code Change` |

Each finding also carries an `Anchor` label:

- `diff` — Location is on a line in the diff. This finding can be posted as an inline GitHub comment.
- `reference` — Location is on an unchanged line (the AC requires fixing it, or the diff relies on it). Won't be posted inline.
- `none` — Cross-cutting finding with no single anchor line (e.g., "no integration test for X"). Won't be posted inline.

## Output Format

Respond with the following markdown structure **exactly**. Do not add extra sections.

```
## Verdict

APPROVE | REQUEST_CHANGES | COMMENT

## Confidence

HIGH | MEDIUM | LOW — one sentence explaining your confidence level.

## Ticket Alignment

(Your findings or "No ticket provided — skipped.")

## Findings

### Trigger: Acceptance Criteria

#### F-01 — <short title>

- **Severity:** HIGH | MED | LOW
- **Anchor:** diff | reference | none
- **Location:** `path/to/file:line` or `path/to/file:start-end`
  (omit only when Anchor is `none`)
- **Why this matters:** 2-4 sentences. State the consequence and how the diff or AC makes it relevant.
- **Suggested comment:** Text the author would post on the PR, as-is.
- **Suggested fix:** Concrete remediation.

#### F-02 — <short title>

- **Severity:** ...
- **Anchor:** ...
- **Location:** ...
- **Why this matters:** ...
- **Suggested comment:** ...
- **Suggested fix:** ...

### Trigger: Code Change

#### F-03 — <short title>

...

(Omit empty Trigger groups. If you have zero findings, write `## Findings\n\nNone identified.`)

## Open Questions

- Question 1
- Question 2

(Or "None." if no open questions.)
```
```

- [ ] **Step 2: Diff and review**

Run: `git diff references/prompts/review-prompt.md`

Check that:
- The `## Scope` section is present and worded as in the spec.
- The Trigger mapping table has all 8 triggers.
- The Findings example has `Severity` / `Anchor` / `Location` / `Why this matters` / `Suggested comment` / `Suggested fix`.
- The old per-category sections (`## Code Quality`, `## Logic Bugs`, etc.) are gone.

- [ ] **Step 3: Commit**

```bash
git add references/prompts/review-prompt.md
git commit -m "feat(prompts): switch review prompt to Trigger-based Findings"
```

---

### Task 13: Update `references/prompts/arbiter-prompt.md` (Final Report template)

**Files:**
- Modify: `references/prompts/arbiter-prompt.md`

- [ ] **Step 1: Replace the Final Report Template section**

Locate the existing template (between the triple-backtick block after "## Final Report Template"). Replace it with:

````markdown
## Final Report Template

When you are ready to finalize, output the following markdown structure **exactly**:

```
## Final Report

### Metadata

| Field | Value |
|-------|-------|
| PR | [#{{pr_number}} — {{pr_title}}]({{pr_url}}) |
| Ticket | {{ticket_id}} |
| Repo | {{repo}} |
| Reviewers | (list agents that participated) |
| Rounds | (number of Q&A rounds completed) |

### Verdict

APPROVE | REQUEST_CHANGES | COMMENT

(One paragraph explaining the overall verdict.)

### Confidence

HIGH | MEDIUM | LOW

(How confident are you in this verdict?)

### Ticket Alignment

| Requirement | Implemented? | Notes |
|-------------|-------------|-------|
| Requirement 1 | Yes / No / Partial | ... |

### Agreements

(Findings both reviewers agreed on.)

### Disagreements & Resolution

(Points of disagreement and how you resolved them.)

### Findings

Every finding carries a `Trigger` (pick exactly one from the closed list: Acceptance Criteria, Code Change, Code Quality, Logic Bug, Security, Performance, Missing Test, Missing Doc / Error Handling), an `Anchor` (`diff` if on a diff line, `reference` if on unchanged code, `none` for cross-cutting), and the five required fields below.

The scope rule: a finding may appear only if it is caused/exposed by the diff or required by the ticket AC. Drop everything else.

#### Trigger: Acceptance Criteria

##### F-01 — <short title>

- **Severity:** HIGH | MED | LOW
- **Anchor:** diff | reference | none
- **Location:** `path/to/file:line` (omit only when Anchor is `none`)
- **Why this matters:** 2-4 sentences.
- **Suggested comment:** Text the author would post on the PR, as-is.
- **Suggested fix:** Concrete remediation.

##### F-02 — <short title>

- **Severity:** ...
- **Anchor:** ...
- **Location:** ...
- **Why this matters:** ...
- **Suggested comment:** ...
- **Suggested fix:** ...

#### Trigger: Code Change

##### F-03 — <short title>

...

(Omit empty Trigger groups. If zero findings, write `### Findings\n\nNone identified.`)

### Review Action

- [ ] Author: address all HIGH severity items before merge
- [ ] Author: address MED severity items or document rationale
- [ ] Reviewer: re-review after changes
- [ ] Merge when: all HIGH items resolved
```
````

- [ ] **Step 2: Diff and review**

Run: `git diff references/prompts/arbiter-prompt.md`

Verify:
- The old `### Ticket Alignment Findings`, `### Code Quality Findings`, `### Logic & Bug Findings`, `### Security Findings`, `### Missing Things`, `### Line Comments` are all gone.
- The new `### Findings` section uses `####` for Trigger and `#####` for F-NN — matching the parser's `### Findings` expectation.
- The scope-rule paragraph is in the Findings preamble.

- [ ] **Step 3: Commit**

```bash
git add references/prompts/arbiter-prompt.md
git commit -m "feat(prompts): switch arbiter Final Report template to Findings format"
```

---

### Task 14: Update `agents/*-reviewer.md` personas — add scope-rule paragraph

**Files:**
- Modify: `agents/claude-reviewer.md`
- Modify: `agents/codex-reviewer.md`
- Modify: `agents/gemini-reviewer.md`
- Modify: `agents/opencode-reviewer.md`

- [ ] **Step 1: Edit each persona file**

For each of the four agent persona files, append the following paragraph at the end of the `## Important` section (or create a new `## Scope` section if `## Important` is absent):

```markdown
## Scope

Every finding you produce must be traceable to either a line in the diff or a ticket Acceptance Criterion. Findings about unchanged code that's unrelated to both are out of scope — drop them. When a finding does anchor on unchanged code (because the AC requires it), use `Anchor: reference` so the report makes the postability explicit and the GitHub API doesn't reject the inline comment.
```

For `codex-reviewer.md` and `opencode-reviewer.md` (which dispatch external CLIs), the scope rule will still flow into the dispatched prompt via `review-prompt.md`, but include the paragraph in the persona for symmetry — if someone reads the persona file expecting a complete picture of the agent's job, they should see it.

- [ ] **Step 2: Diff and review**

Run: `git diff agents/`

Verify the same paragraph is present in all four files.

- [ ] **Step 3: Commit**

```bash
git add agents/claude-reviewer.md agents/codex-reviewer.md agents/gemini-reviewer.md agents/opencode-reviewer.md
git commit -m "feat(agents): reinforce scope rule in reviewer personas"
```

---

### Task 15: Update `references/report-format.md`

**Files:**
- Modify: `references/report-format.md`

- [ ] **Step 1: Replace the file contents**

Overwrite with:

```markdown
# PRR Review Output Format

All review agents produce their output in this format. The arbiter consolidates these into a Final Report with the same Findings shape (heading levels shifted to nest under `## Final Report`).

## Verdict

APPROVE | REQUEST_CHANGES | COMMENT

## Confidence

HIGH | MEDIUM | LOW

## Ticket Alignment

| # | Criterion | Met | Evidence |
|---|-----------|-----|----------|
| 1 | <criterion> | Yes / No / Partial | `path:line` |

## Findings

Each finding carries:

- **Trigger** — one of: `Acceptance Criteria`, `Code Change`, `Code Quality`, `Logic Bug`, `Security`, `Performance`, `Missing Test`, `Missing Doc / Error Handling`.
- **Severity** — HIGH | MED | LOW.
- **Anchor** — `diff` (postable as inline comment), `reference` (anchored on unchanged code, report-only), or `none` (cross-cutting, no anchor).
- **Location** — `path:line` or `path:start-end`. Required when Anchor is `diff` or `reference`; omitted when `none`.
- **Why this matters** — 2-4 sentences.
- **Suggested comment** — text to post on the PR, as-is.
- **Suggested fix** — concrete remediation.

Findings are grouped by Trigger. Per-agent reviews use `## Findings` / `### Trigger: X` / `#### F-NN — <title>`. The arbiter's Final Report uses one level deeper: `### Findings` / `#### Trigger: X` / `##### F-NN — <title>`.

Example finding (per-agent):

```
## Findings

### Trigger: Code Change

#### F-01 — Parser invocation may raise when feature disabled

- **Severity:** MED
- **Anchor:** diff
- **Location:** `lib/resources/asset.rb:97`
- **Why this matters:** The parser now runs unconditionally, raising
  ClientResponsibilityError on missing orgs even when the feature
  flag is off.
- **Suggested comment:** Gate this call behind cp_supports_rights_claim_feature?
- **Suggested fix:** Wrap the parser invocation in an if guard.
```

If there are zero findings, write `## Findings\n\nNone identified.`

## Scope

A finding may appear only if it is caused/exposed by the diff or required by the ticket Acceptance Criteria. Findings about unchanged code unrelated to both are out of scope.

## Open Questions

- Question 1
- Question 2

(Or "None." if no open questions.)
```

- [ ] **Step 2: Diff and review**

Run: `git diff references/report-format.md`

Confirm the old `## Verdict: <value>` inline syntax, `## Memory`, `## Hallucination Check`, `## Proof of Findings`, and `## Line Comments` sections are gone, and the new Findings shape is in.

- [ ] **Step 3: Commit**

```bash
git add references/report-format.md
git commit -m "docs: update report-format reference to new Findings shape"
```

---

### Task 16: Update `docs/design/prr-design.md`

**Files:**
- Modify: `docs/design/prr-design.md`

- [ ] **Step 1: Locate the stale sections**

Run: `grep -n "Missing Things\|Line Comments\|Proof of Findings" docs/design/prr-design.md`

Expected lines (from earlier inspection): 210, 225, 228.

- [ ] **Step 2: Replace the stale block**

Read the file around lines 200-235 to see the surrounding context. Replace the per-section narrative + Line Comments block with a description of the new Findings shape pointing to the report-format reference:

```markdown
## Findings

All reviewer output and the final report use a single **Findings** section grouped by **Trigger** (Acceptance Criteria / Code Change / Code Quality / Logic Bug / Security / Performance / Missing Test / Missing Doc / Error Handling).

Each finding carries:

- `Trigger` — classification (one of the 8 above)
- `Severity` — HIGH | MED | LOW
- `Anchor` — `diff` (postable inline), `reference` (anchored on unchanged code, report-only), or `none` (cross-cutting)
- `Location` — `path:line` or `path:start-end` (required unless Anchor is `none`)
- `Why this matters`
- `Suggested comment`
- `Suggested fix`

The parser at `src/report.rs` derives the GitHub-postable `line_comments` array from findings whose `Anchor` is `diff` only. Findings with `Anchor: reference` or `Anchor: none` are summarized in the regenerated review body but never posted as inline comments.

See `references/report-format.md` for the full output format and `docs/superpowers/specs/2026-05-21-trigger-based-findings-design.md` for the design.
```

- [ ] **Step 3: Diff and review**

Run: `git diff docs/design/prr-design.md`

Confirm: no `## Missing Things` or `## Line Comments` blocks remain.

- [ ] **Step 4: Commit**

```bash
git add docs/design/prr-design.md
git commit -m "docs: refresh prr-design with Trigger-based Findings"
```

---

### Task 17: SKILL.md Phase 7a — diff-anchored findings render from `findings`

**Files:**
- Modify: `skills/prr-start/SKILL.md`

- [ ] **Step 1: Locate Phase 7**

Run: `grep -n "## Phase 7\|### Step 7\|Step 7b\|Phase 8" skills/prr-start/SKILL.md`

Note the line ranges of the existing Phase 7 (typically `## Phase 7: Line Comment Review` through to `## Phase 8`).

- [ ] **Step 2: Replace Phase 7 with the new structure**

Replace the entire `## Phase 7: Line Comment Review` section with:

````markdown
## Phase 7: Findings Review

### Step 7a — Parse the report (with diff verification)

Run:
```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal parse-report <ROUND_DIR>/results/final-report.md --diff <ROUND_DIR>/results/diff.txt
```

This outputs JSON to stdout. Parse it. The structure is:

```json
{
  "verdict": "REQUEST_CHANGES",
  "confidence": "HIGH",
  "findings": [
    {
      "id": "F-01",
      "title": "...",
      "trigger": "Acceptance Criteria",
      "severity": "HIGH",
      "anchor": "diff" | "reference" | "none",
      "location": "path/to/file:line" | null,
      "path": "path/to/file" | null,
      "line": 42 | null,
      "start_line": 40 | null,
      "why_it_matters": "...",
      "suggested_comment": "...",
      "suggested_fix": "..."
    }
  ],
  "line_comments": [ /* derived: diff-anchored findings only */ ],
  "review_action": "Request Changes",
  "review_body": "..."
}
```

Maintain an in-memory list of `CommentState` entries, one per `Finding`:

```
CommentState {
  finding: Finding          // straight from the JSON
  status: Pending | Accepted | Rejected | Edited
  overridden_body: string | null  // populated when status == Edited
}
```

Initialize every entry with `status = Pending`. New findings the user adds in Step 7c are appended with `status = Accepted`. The list survives across 7a/7b/7c and is consumed by Phase 8.

### Step 7b — Diff-anchored findings (inline-postable)

Walk `findings` where `anchor == "diff"`. For each, present in **two parts**: rich context as regular text, then a minimal AskUserQuestion.

#### Rich text output

```
## Comment N/M — <Trigger> — <title> (<Severity>)

📄 [path#L<line>](url) (lines start–end)

<code context in a language-specific fenced block; target line marked with # <-->

**Why this matters:** <why_it_matters>

**Suggested comment:**
> <suggested_comment>

**Suggested fix:** <suggested_fix>
```

N/M counts only diff-anchored findings. Code context is read from `<ROUND_DIR>/repo/<path>`, ~5 lines before/after the target line, language-hinted fence (e.g., ` ```ruby `), target line marked with a trailing `# <--` comment. The clickable link uses the `url` field if present, else plain text `path#L<line>`.

#### AskUserQuestion

```
Comment N/M — <one-line summary>
```

Options:
- **Accept** — keep as-is
- **Reject** — drop this comment
- **Edit** — provide replacement text

Free-text input is accepted as a clarification or edit (rewrite the comment incorporating the input, show for confirmation, then move on).

Special commands: `add`/`new`/`+` switches to Step 7c; `done`/`stop`/`enough` exits Phase 7.

#### Update CommentState

- Accept → `status = Accepted`
- Reject → `status = Rejected`
- Edit → `status = Edited`, `overridden_body = <new text>`

### Step 7c — Reference / unanchored findings (report-only)

After diff-anchored findings, walk `findings` where `anchor` is `reference` or `none`. These cannot be posted as inline comments but must still be reviewed for inclusion in the regenerated review body.

#### Rich text output

```
## Report-Only Finding N/M — <Trigger> — <title> (<Severity>)

(Report-only — won't be posted as an inline comment; will be summarized in the review body.)

📄 <path:line if anchor == reference; else "(no anchor line)">

**Why this matters:** <why_it_matters>

**Suggested comment:**
> <suggested_comment>

**Suggested fix:** <suggested_fix>
```

For `anchor: reference`, render the code context the same way as 7b but note "(unchanged code — for reference only)" above the fence.

#### AskUserQuestion

```
Report-Only Finding N/M — <one-line summary>
```

Options:
- **Accept** — include this finding in the regenerated review body
- **Reject** — drop it from the body
- **Edit** — provide replacement text for the body summary

CommentState updates as in 7b.

### Step 7d — Add new finding

Triggered by `add`/`new`/`+` at any point in 7b or 7c. Collect:

1. **Trigger** — AskUserQuestion with the 8 options (Acceptance Criteria, Code Change, Code Quality, Logic Bug, Security, Performance, Missing Test, Missing Doc / Error Handling).
2. **Severity** — AskUserQuestion: HIGH / MED / LOW.
3. **Anchor** — AskUserQuestion: "Is this anchored on a changed line, on existing code, or no specific line?" → `diff` / `reference` / `none`.
4. If Anchor ≠ `none`: ask for `path:line`. Validate against `<ROUND_DIR>/results/diff.txt` — if user says `diff` but the line isn't in the diff, ask whether to downgrade to `reference`.
5. Draft `Why this matters`, `Suggested comment`, `Suggested fix` with the user; confirm.
6. Append a synthetic CommentState with `status = Accepted` and continue the review.

### After Phase 7

Show the final list (accepted + edited entries from both 7b and 7c):

```
---

## Final Findings (N total)

**Inline comments (P):**

1. `path:line` — <Trigger> — <one-line summary>
...

**Report-only findings (Q):**

1. `path:line` (or no anchor) — <Trigger> — <one-line summary>
...

---
```

Confirm: "Ready to post? [yes / edit more]"
````

- [ ] **Step 3: Diff and review**

Run: `git diff skills/prr-start/SKILL.md | head -200`

Verify:
- Old `## Phase 7: Line Comment Review` is gone.
- New `## Phase 7: Findings Review` is present with Steps 7a/7b/7c/7d.
- `parse-report` is called with `--diff`.

- [ ] **Step 4: Commit**

```bash
git add skills/prr-start/SKILL.md
git commit -m "feat(skill): split Phase 7 into diff-anchored / report-only / add-new"
```

---

### Task 18: SKILL.md Phase 8a — body regen includes report-only findings

**Files:**
- Modify: `skills/prr-start/SKILL.md`

- [ ] **Step 1: Locate Phase 8a**

Run: `grep -n "### Step 8a\|Step 8b" skills/prr-start/SKILL.md`

- [ ] **Step 2: Replace the Step 8a body**

Find `### Step 8a: Generate review body from accepted comments` and replace its body with:

```markdown
### Step 8a: Generate review body from accepted findings

Do NOT use the arbiter's original `review_body` directly. Regenerate based on the CommentState list from Phase 7.

1. Partition Accepted + Edited entries into two groups:
   - `inline = findings with anchor == "diff"`
   - `other  = findings with anchor == "reference" or "none"`
2. Build the body:

   ```
   <one opening sentence with overall assessment>

   **Inline comments (P):**
   - `path:line` — <Trigger> — <one-line summary from suggested_comment or overridden_body>
   - ...

   **Other findings (Q):**
   - `path:line` (or "(no anchor)") — <Trigger> — <one-line summary>
   - ...
   ```

3. Omit either section if its list is empty. If both lists are empty, use a short body appropriate to the action (e.g., "LGTM" for APPROVE, "No actionable findings." for COMMENT).

Save as `REVIEW_BODY`.

The GitHub payload (Step 8e) builds `comments[]` from the `inline` group only — the `other` group is captured in the review body and never sent as inline comments.
```

- [ ] **Step 3: Diff and review**

Run: `git diff skills/prr-start/SKILL.md`

- [ ] **Step 4: Commit**

```bash
git add skills/prr-start/SKILL.md
git commit -m "feat(skill): include report-only findings in regenerated review body"
```

---

### Task 19: Update `CLAUDE.md` with Findings format subsection

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find a sensible location**

Run: `grep -n "^##" CLAUDE.md`

Insert a new `## Findings Format` section after `## Conventions` (or wherever fits the existing flow).

- [ ] **Step 2: Add the subsection**

```markdown
## Findings Format

PRR reviews produce structured findings classified by `Trigger`. Every finding carries six fields (Severity, Anchor, Location, Why this matters, Suggested comment, Suggested fix) and is grouped under one of 8 Triggers:

`Acceptance Criteria` · `Code Change` · `Code Quality` · `Logic Bug` · `Security` · `Performance` · `Missing Test` · `Missing Doc / Error Handling`

**Trigger mapping (the closed list):**

| Symptom | Trigger |
|---------|---------|
| Diff violates ticket AC (or unchanged code that AC requires violates it) | `Acceptance Criteria` |
| Off-by-one, race condition, wrong assumption, wrong transformation | `Logic Bug` |
| Injection / auth bypass / secret leak / unsafe deserialization | `Security` |
| Memory leak, unbounded growth, missing cleanup, slow query, expensive loop | `Performance` |
| Naming / duplication / readability / structural | `Code Quality` |
| New behaviour without test | `Missing Test` |
| New behaviour without docs / error handling | `Missing Doc / Error Handling` |
| Suspicious but fits none of the above (catch-all of last resort) | `Code Change` |

**Required bullets per finding:** `Severity`, `Anchor`, `Why this matters`, `Suggested comment`, `Suggested fix`. `Location` is required when `Anchor` is `diff` or `reference`; omitted when `none`.

**Postability classification (the `Anchor` field):**

- `diff` — Location is on a line in the unified diff. Posted as an inline GitHub PR comment.
- `reference` — Location is on an unchanged line (the AC requires it, or the diff relies on it). Summarized in the review body; not posted inline.
- `none` — Cross-cutting finding with no anchor line. Summarized in the review body; not posted inline.

**Scope rule:** a finding may appear in a report only if it is caused/exposed by the diff or required by the ticket AC. Drop anything else.

Authoritative shape: `references/report-format.md`. Design: `docs/superpowers/specs/2026-05-21-trigger-based-findings-design.md`.
```

- [ ] **Step 3: Diff and commit**

Run: `git diff CLAUDE.md`

```bash
git add CLAUDE.md
git commit -m "docs: document Findings format in CLAUDE.md"
```

---

### Task 20: End-to-end manual verification

**Files:**
- Read-only: a real PR

- [ ] **Step 1: Pick a PR with a small diff**

Find or pick a PR with a known small diff (1-3 files, < 50 lines changed). Note the URL.

- [ ] **Step 2: Run a fresh review**

```bash
# Replace <PR_URL> with the actual PR URL
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal context <PR_URL> --workspace /tmp/prr-verify
# Then run the full /prr:start flow against this PR via Claude Code.
```

- [ ] **Step 3: Verify**

After the run completes, inspect `final-report.md` and the parsed JSON:

```bash
ls /tmp/prr-verify/*/r1/results/
cat /tmp/prr-verify/*/r1/results/final-report.md | head -100
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal parse-report \
  /tmp/prr-verify/*/r1/results/final-report.md \
  --diff /tmp/prr-verify/*/r1/results/diff.txt
```

Confirm:
- The final report has a `### Findings` section (no `### Code Quality Findings` / `### Line Comments` / etc.).
- Each finding has all 5 (or 6 with Location) required bullets.
- Every Trigger is one of the 8 closed values.
- The parsed JSON has populated `findings` and `line_comments`, with `line_comments.length ≤ findings.length`.
- No "downgrading" warnings on stderr for the diff-anchored findings (they should be correctly labeled).

- [ ] **Step 4: Walk through the skill UI**

Run `/prr:start` against the same PR. Verify:
- Phase 7b shows diff-anchored comments with Trigger / Severity / Why / Suggested comment / Suggested fix.
- Phase 7c shows report-only findings (if any) with the "(Report-only — won't be posted as an inline comment...)" note.
- Phase 8 review body has both "Inline comments" and "Other findings" sections if both groups are non-empty.

- [ ] **Step 5: Don't commit anything yet**

This is a verification gate. If it reveals issues, return to the corresponding earlier task.

---

### Task 21: Version bump + binary rebuild + final commit

**Files:**
- Modify: `Cargo.toml`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `bin/prr-darwin-universal` (regenerated)

- [ ] **Step 1: Bump versions**

The accumulated changes touch `src/` so this is a **minor** bump per the repo's versioning policy. Current version is 0.4.1; next is 0.5.0.

Edit `Cargo.toml`:
```toml
version = "0.5.0"
```

Edit `.claude-plugin/plugin.json`:
```json
"version": "0.5.0",
```

Edit `.claude-plugin/marketplace.json`:
```json
"version": "0.5.0",
```

- [ ] **Step 2: Rebuild the universal binary**

```bash
./scripts/build-universal.sh
```

Expected: `Built: bin/prr-darwin-universal` plus the `Mach-O universal binary with 2 architectures` line.

- [ ] **Step 3: Confirm Cargo.lock updated**

Run: `git diff Cargo.lock`

If `version = "0.4.1"` → `version = "0.5.0"` appears for the `prr` package, you're good.

- [ ] **Step 4: Final commit**

```bash
git add Cargo.toml Cargo.lock .claude-plugin/plugin.json .claude-plugin/marketplace.json bin/prr-darwin-universal
git commit -m "$(cat <<'EOF'
chore: bump to 0.5.0 and rebuild binary

Bundles the trigger-based findings work:

- Parser emits Findings with Trigger / Anchor and derives the
  diff-anchored subset into line_comments
- Prompts (review + arbiter) require the new Findings format
- Skill Phase 7 splits diff-anchored from report-only findings
- Agent personas reinforce the scope rule
- Reference docs (report-format.md, prr-design.md, CLAUDE.md)
  document the new shape
EOF
)"
```

- [ ] **Step 5: Final verification**

```bash
git log --oneline -25
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal --version 2>&1 || \
  ./bin/prr-darwin-universal --version
```

The version string from the binary should be 0.5.0 (this confirms the rebuild succeeded — stale binaries are a known bug class in this repo per CLAUDE.md).

---

## Self-Review Notes

Spec coverage check:

- Scope rule → Task 12 (review prompt), Task 13 (arbiter prompt), Task 14 (agent personas)
- Trigger list + mapping guide → Task 12, Task 19 (CLAUDE.md)
- Per-finding format (Severity, Anchor, Location, Why, Suggested comment, Suggested fix) → Task 1 (struct), Task 4 (bullet parse), Task 5 (validation), Task 12 / 13 (prompts)
- Required vs optional fields → Task 5 (validation logic + tests)
- Postability classification (diff/reference/none) → Task 1, Task 6 (derive), Task 10 (verification)
- Report structure (### Findings under ## Final Report; ## Findings standalone) → Task 2 (parser handles both), Task 12, Task 13
- Parser changes — `findings` field, `Anchor` enum, `--diff` flag, multiline continuation, case-insensitive keys, validation, diff verification, legacy synthesis with verification carve-out → Tasks 1-10
- Skill changes — Phase 7 split, body regen, --diff invocation → Tasks 17-18
- Agent persona changes → Task 14
- CLAUDE.md → Task 19
- references/report-format.md and docs/design/prr-design.md → Tasks 15-16
- Backward compatibility (legacy synthesis, verification bypass) → Task 7, Task 10
- Verification (parser tests, e2e, cache compat) → spread through TDD in each task; Task 11 and Task 20 are explicit checkpoints
- Version bump + rebuild → Task 21

No placeholder steps; every code-touching task contains the actual code to write.
