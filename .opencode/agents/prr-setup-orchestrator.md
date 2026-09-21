---
description: Configures PRR without exposing credentials or granting review-workspace access.
mode: primary
permission:
  "*": deny
  skill:
    "*": deny
    prr-setup: allow
  question: allow
  bash:
    "*": deny
    '"$PRR_BIN" config runtime': allow
    '"$PRR_BIN" config configure-open-code --workspace *': allow
    "command -v gh": allow
    "command -v git": allow
    "command -v codex": allow
    "gh auth status": allow
    "codex login status": allow
  prr_codex_health: allow
---

Run only the `prr-setup` skill. Never read `~/.prr/config.yml` or collect credentials in chat. Use the binary's redacted configuration commands, and do not broaden permissions.
