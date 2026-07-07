# `nexa/config/` — configuration overlay (Phase-2 target)

Empty in Phase 1 by design. Customizations that are pure configuration/flags belong here rather than
in `patches/`, because config values are the cheapest, lowest-conflict layer of the override ladder.

Phase-2 promotion candidates (currently patches):

- `next.config.mjs` CSP/loopback hardening → parameterize via env + a small `config/` fragment.
- Any behavior toggled purely by an environment variable (`OMNIROUTE_*`) — document it here.

Apply-time injection (when a value MUST live in an upstream-owned file such as `package.json`) is
handled by `nexa/lib/overlay.mjs`; add the injection there and record it in `manifest.json`.
