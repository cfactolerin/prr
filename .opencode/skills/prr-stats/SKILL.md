---
name: prr-stats
description: Show local PRR usage, reviewer agreement, validated unique catches, false positives, and human decisions by harness and model.
---

Call `prr_stats_summary`, passing the command's optional PR or run-ID filter as `query`. Start with total tracked runs, completed review rounds, distinct PRs, findings found and rejected, and the agreement-round distribution. Round 0 is agreement in the initial reviews; `not_reached` means actual unresolved differences, while `unassessed` means the attribution evidence is unavailable.

Show a concise table grouped by reviewer and model: proposed, arbiter-validated, invalid, uniquely validated, unresolved/unassessed, arbiter precision, and explicit human precision. Show sample denominators beside percentages. Arbiter precision is validated / (validated + invalid); human precision is confirmed / (confirmed + incorrect), deduplicated per final finding and reviewer. Scope, duplicate, preference, already-fixed, and unassessed cases do not belong in either denominator.

Keep accept/reject/edit totals separate from correctness judgments. An accepted finding is not automatically true and a rejected finding is not automatically false. Include incomplete runs, parser or attribution warnings, corrupt event counts, and unknown/mixed model identities when present. `model_basis` distinguishes observed native requests, requested Codex invocation models, and round-start snapshots; provider-side aliases are not independently fingerprinted.

The history covers instrumented OpenCode 2 runs since tracking was enabled, not lifetime usage. Local records survive workspace cleanup; no telemetry is uploaded. Do not infer missing old provenance, agreement from a forced arbiter verdict, or recall from unknown bugs. Re-review rounds are correlated. Compare matched models and PRs rather than declaring a winning harness from a few observations.

With a filter, show per-review findings, source attribution, agreement, and recorded human reasons. Without a filter, show recent review summaries only when useful, then offer to inspect a PR or run. If no runs exist, say tracking has just started; do not show invented zero-percent accuracy.
