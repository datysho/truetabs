# Spec: Update applier - pending CWS updates apply at the first quiet moment

Class: feature · Advisor score: 7.5/10 - platform already auto-updates and our settings already survive (schema normalization on every read since v1.4); this closes the tail where a busy worker defers the switch, and pins survival with tests · Approval: pending (batch 2026-07-19)

## Goal block
- What must exist: a downloaded CWS update applies at the first quiet moment (no AI run, empty mutation queue, no extension pages open) instead of waiting for Chrome's idle heuristic or a browser restart. No "please update" UI - the butler updates himself silently. Settings, custom groups, archive and protection state provably survive.
- How we verify: e2e - simulated `onUpdateAvailable` triggers `runtime.reload()` only when quiet; settings/customGroups/archive round-trip a worker reload byte-identical.
- Do not touch: `normalizeSettings` semantics (covered by settings-platform spec), session-flag cleanup on init (mv3-worker-death lesson - already the recovery path after a reload), alarms re-registration (`ensureAlarm` on install/startup already).
- Stop/pause when: any temptation to add an update-notification UI (explicitly rejected by design) or to defer beyond one tick cycle.

## Question round
| Question | Customer answer |
|---|---|
| Show an "update ready" button vs silent background apply? | Customer asked to think it through; decision: silent - Chrome already downloads in background, we only accelerate the apply; no UI. Recorded in batch digest (2026-07-19). |

## Scope and non-goals
- In scope: `runtime.onUpdateAvailable` handler; quiet-moment predicate; deferred re-check on the existing minute tick; reason-aware `onInstalled` logging (foundation for future data migrations); survival tests.
- Non-goals: forcing update checks (`requestUpdateCheck` - CWS cadence is fine); "What's new" changelog UI; migrating any data shape today (none pending); countdown/forced reload while the user is mid-anything.

## Design
- `chrome.runtime.onUpdateAvailable.addListener(details)`: set `storage.session.updatePending = details.version`, then attempt `tryApplyUpdate()`.
- `tryApplyUpdate()` gates (all must hold): no `smartRunning`/`smartDownload`, mutation queue idle (no queued jobs), `chrome.runtime.getContexts({contextTypes: [TAB, POPUP]})` returns none of our pages (popup/options/archive open = user is mid-interaction), not inside the settle window. All green - `chrome.runtime.reload()`.
- Not green: the existing minute tick re-calls `tryApplyUpdate()` while `updatePending` is set. Worst case the update applies within a minute of the blocker clearing; if the worker dies first, Chrome applies the update itself on next idle - both paths converge.
- `onInstalled` handler gains `(details)` and logs `details.reason + previousVersion` into the diagnostics ring; the existing `migrate-settings` write-back stays. This is the future hook for version-numbered migrations; none needed now.
- Post-reload safety is already engineered: session flags cleared on init, two-stage page boot, normalize-on-read. This spec adds the missing proof (tests), not new machinery.

## Interaction matrix
| Existing feature | Intersection | Resolution |
|---|---|---|
| AI runs + keepalive | Reload mid-run would kill a smart layout | `smartRunning`/`smartDownload` block the apply; keepalive keeps the worker alive through the run, then the tick applies |
| Mutation queue | Reload drops queued jobs | Queue-idle gate; jobs are short - next tick catches the quiet moment |
| Open popup/options/archive | Reload closes them under the user | `getContexts` gate |
| Settle gate | Cold start | No apply during settle; tick handles after |
| Session state | Reload wipes `storage.session` | By design: init cleanup treats it as ephemeral (existing lesson); nothing durable lives there |
| Alarms | Reload drops alarms? | `ensureAlarm` runs on install/startup - re-registration already guaranteed |

## Data deltas
- `storage.session.updatePending: string | null`. No settings schema change, no migration.

## Edge cases (with resolutions)
- Update arrives during a 70-tab smart layout: applied by the tick after the run ends (keepalive holds the worker meanwhile).
- User keeps options open for hours: Chrome's own idle apply also cannot run (page open blocks it platform-side too); we apply the moment the page closes (tick) - still strictly earlier than stock behavior.
- Double fire of `onUpdateAvailable`: idempotent (flag overwrite + gated reload).
- Reload races a queued mutation enqueue: `runtime.reload()` after queue-idle check may still race a brand-new event; acceptable - Chrome's own idle apply has the identical race, and every engine job is written to be re-entrant after worker death (existing invariant).

## Behavior-test table
| Behavior | Test name |
|---|---|
| Quiet moment: simulated onUpdateAvailable triggers reload | update: applies when quiet |
| Smart run blocks apply; end of run + tick applies | update: waits out AI run |
| Open options page blocks apply | update: waits for pages closed |
| Settings + customGroups + archive survive a worker reload byte-identical | update: state survives reload |
| onInstalled logs reason and previousVersion | update: install reason recorded |

Note: e2e cannot perform a real CWS version swap; `onUpdateAvailable` is dispatched manually via swEval and reload is observed via the existing `__ttSimulateReload`-style lifecycle (worker target re-attach). The survival test is the real assert.

## Build order
1. Handler + gates + tick re-check with tests 1-3 - done when: suite green x2.
2. Survival + reason tests 4-5 - done when: suite green x2.
3. Docs: README one line ("updates apply silently in the background; settings survive") - done when: store-texts sweep clean.

## Risks and open questions
- None material. Pre-mortem: a gate bug could reload mid-action once - blast radius is a popup closing; every durable state already survives worker death by prior invariants.
