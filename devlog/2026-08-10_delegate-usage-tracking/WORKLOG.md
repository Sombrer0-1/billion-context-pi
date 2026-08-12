# WORKLOG: delegate LLM usage tracking (issue #105, PR #106)

- Task ID: `2026-08-10_delegate-usage-tracking`
- Home Repo: `billion-context-pi`
- Status: Done
- Updated: 2026-08-13

## 1. Summary

- **What was done**: PR #106 parses the delegate child's Pi JSON stream
  `message_end` events to track sub-agent LLM usage (tokens + cost), accumulates
  it across calls, surfaces it in the footer + `/acp-status` + wait/cancel tool
  results, force-kills a hung delegate ~10s after `agent_settled` (was ~5 min
  idle-watchdog floor), and adds a `displayUsage` config.
- **Why**: sub-agent cost/token accounting was invisible; hung delegates stalled
  the main session.
- **Behavior / compatibility changes**: Yes — additive. New `displayUsage` config
  (default `separate`); new footer line; delegate now force-exits faster on
  `agent_settled`. Users not reading the new fields see no behavior change.
- **Risk level**: Medium (new stream parsing + process-kill timing change).

## 2. Change Log

### Commits (author)

| Commit | Description |
|--------|-------------|
| `8fdb60d` | feat: track delegate LLM usage + separate display mode (#105) |

### Merge resolution (by maintainer side)

The PR was opened against an older master. After `#121/#123/#124/#125` landed,
it conflicted. Resolved in merge commit `1bf6bb4` (parents `[8fdb60d, 4c058eb]`),
pushed to the author's fork `Tyan66666:fix/105-delegate-usage-tracking`.

### Key Files

- `src/delegate-events.ts` — NEW. `Usage` interface, `handleMessageEnd`,
  `usage-update` / `agent_settled` event parsing.
- `src/delegate-tool.ts` — `makeEventApplier` (master refactor) extended with
  `onUsage` / `onSettled` callbacks; `accumulateUsage`; `buildChildArgs`;
  `delegateSpawnOptions`; usage returned from wait/cancel.
- `src/delegate-watchdog.ts` — NEW. `attachWatchdogs` + `settledGrace` (reuses
  existing SIGTERM→SIGKILL escalation).
- `src/footer-status.ts` — NEW. `sub-agents ↑in ↓out ($cost)` footer line.
- `src/index.ts` — `/acp-status` delegate usage section; `resetDelegateUsage()`
  on reload/restart.

## 3. Design & Implementation Notes

- **Entry point / key function**: `makeEventApplier` dispatches stream events;
  `accumulateUsage(run.usage, ev.usage)` sums per-call usage; only assistant
  `message_end` events carry usage (filtered by `msg.role === "assistant"`).
- **Conflict resolution**: master refactored the spawn's inline event-handling
  closure into `makeEventApplier` (for unit-testability). #106 had added
  `usage-update` / `agent-settled` branches to the old inline closure. Resolved
  by keeping `makeEventApplier` and adding optional `onUsage` / `onSettled`
  callbacks (keeps the applier testable — no hard dependency on `run` /
  `watchdog`), wired at the spawn call site.
- **`agent_settled` kill**: Pi emits `agent_settled` exactly once in the
  `finally` of `_runAgentPrompt`; a normal exit follows within milliseconds. If
  the child is still alive after `SETTLED_GRACE_MS` (10s), it is genuinely hung
  in teardown → `killByWatchdog` (SIGTERM, escalate to SIGKILL). Idempotent.

## 4. Testing & Verification

```sh
npm run typecheck   # 0 errors
npm test            # 230 pass / 0 fail
npm run build       # success
```

- New/modified test files: `tests/delegate-tool.test.ts`, `tests/events.test.ts`,
  `tests/watchdog.test.ts`, `tests/footer-status.test.ts`.
- Test count: 230 total, 230 pass, 0 fail (master 211 + #106 net new).
- `pr-validation` fails only on the `fix/...` branch name (regex requires
  `YYYY-MM-DD_...`); overridden at merge, same as the other recent PRs.

## 5. Risk Assessment & Rollback

- **Risk points**:
  - Malformed/missing usage fields — see the cross-platform/regression review.
  - `agent_settled` force-kill could theoretically hit a legitimately slow
    teardown; mitigated by the 10s grace + the fact Pi emits `agent_settled`
    only after the agent flow is fully done.
  - Cross-platform: process kill reuses the existing SIGTERM→SIGKILL
    `killByWatchdog` (SIGKILL is reliable on Windows); the new `settledGrace`
    path adds no new signal behavior.
- **Rollback method**: revert PR #106.
- **Compatibility notes**: additive config field `displayUsage`; no persisted
  state schema change.

## 6. Follow-ups

- [ ] Rename the PR branch to a `YYYY-MM-DD_...` name to satisfy `pr-validation`
      (currently overridden at merge).
- [ ] Remove `PROPOSAL.md` from the repo root — content now lives here as
      `DESIGN.md` (done in the same commit that created this devlog).
