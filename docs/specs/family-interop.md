# Spec: Family interop - TrueTabs + TruePin stop fighting over the front of the strip

Class: feature (two repos: TrueTabs + TruePin ship together) · Advisor score: 8.5/10 - a reproducible tug-of-war between our own two products, fully diagnosed; the fix is a small deterministic protocol plus one zone in the existing layout engine, and it creates the "family protocol" foundation future siblings reuse · Approval: pending (batch 2026-07-19)

Canonical spec lives here (TrueTabs owns the layout side); TruePin's build order mirror: `~/Projects/truepin/docs/specs/family-interop.md`.

## Diagnosis (verified in code, 2026-07-19)
TruePin `lockToFront: "always"` re-moves every TruePin-locked NORMAL tab to index `pinnedCount + i` on each `tabs.onMoved` (200 ms debounce, `enforceLockedFront`), with an idempotence guard that only stops loops against itself - an external mover re-triggers it every time. It ignores `groupId` (yanks tabs out of groups) and has no notion of other extensions. TrueTabs' layout engine enforces zones `[pinned][group block][loose]` with `groupsOnTop` - the same strip region. Result: oscillation ("постоянно какие-то непонятки"). TrueTabs' pinned-tab truce does not cover these tabs because TruePin-locked tabs are NOT Chrome-pinned.

## Goal block
- What must exist: one agreed strip contract - `[Chrome-pinned][TruePin-locked][TrueTabs group block][loose][Other]`. TruePin answers "which tabs are front-locked" over extension messaging; TrueTabs reserves that zone and treats those tabs as untouchable (no move, no group, no dedup-victim, no archive). With TruePin absent or old, TrueTabs behaves exactly as today. TruePin additionally stops yanking locked tabs out of groups the USER put them in.
- How we verify: dual-extension e2e - both unpacked extensions in one Chrome; a locked tab keeps position through Organize + sorts + groupsOnTop; a 5-second observation window records zero oscillating moves.
- Do not touch: TruePin's mirror/restore engines and its lock semantics; TrueTabs' layout engine beyond inserting the one zone at its existing pinned-offset seam; Chrome-pinned handling (already truce by construction).
- Stop/pause when: protocol needs more than the locked-front list (scope creep into a general bus - v1 is one message pair + one broadcast).

## Question round
| Question | Customer answer |
|---|---|
| Symptom confirmation | "Взаимодействие TrueTabs и TruePin не полностью проработано... продумай всё хорошо" (2026-07-19) - full interop design delegated |

## Scope and non-goals
- In scope: message protocol v1 (query + broadcast); TrueTabs locked-zone in the layout engine + untouchability set; TruePin responder/broadcaster + group-respect fix; strict sender allowlists both sides; dual-extension e2e harness capability; docs both repos.
- Non-goals: `externally_connectable` manifest keys (NOT declared on either side - the absent key already means "extensions may connect, web pages may not", which is exactly right; adding ids would only narrow future family members); shared settings or any second message family; TruePin adopting TrueTabs' queue/architecture.

## Protocol v1 (contract - mirrored verbatim in the TruePin spec)
- Transport: `chrome.runtime.sendMessage(targetId, msg)` + `onMessageExternal` both sides.
- Sender gate: hard-coded allowlist of extension ids - each side accepts the sibling's CWS id AND dev-key id (both repos pin dev `key` in manifest, so unpacked ids are stable; TruePin CWS id is live, TrueTabs' fills `TT_CWS_ID` after publication). Any other sender: ignored silently. No wildcard, ever.
- Messages:
  - `{v: 1, type: "family:lockedFront:get"}` - TrueTabs asks; TruePin replies `{v: 1, tabIds: number[], mode: "off"|"onLock"|"always"}` (tabIds empty unless mode "always").
  - `{v: 1, type: "family:lockedFront:changed", tabIds, mode}` - TruePin broadcasts on: lock/unlock, mode change, enforced move (post-debounce), startup.
- Versioning: `v` field; unknown `v`/`type` ignored (forward-compatible).
- Failure = absence: `sendMessage` rejection (sibling not installed/old) yields an empty zone and zero behavior change. No retries beyond the settle-time query and event-driven refresh.

## Design - TrueTabs side
- Zone: layout engine's pinned offset becomes `pinnedCount + lockedZone.length` when mode is "always"; locked ids are ordered by TruePin (their relative order preserved; TrueTabs never moves them - TruePin remains the zone's enforcer, we simply lay groups AFTER his zone, eliminating the contested region).
- Untouchability set `lockedTabs: Set<tabId>` (session, refreshed by broadcast/query, cleared on tab close): excluded from grouping (`placeable()` false), dedup victimhood (like pinned), archive candidates, blank collapse, re-home, folder-open adoption. One membership check added to the existing pinned-exclusion sites (same predicate object - one enforcer, not sprinkled conditions: extend the existing `isUntouchable(tab)`-style gate that pinned uses; where checks are inline `tab.pinned`, they consolidate into that predicate - surgical but single-point).
- Refresh triggers: settle-complete query; broadcast listener; `tabs.onRemoved` prunes ids. No polling.
- Layout assert already runs on `onMoved` bursts; TruePin's enforced moves carry no self-op marker of OURS - they are foreign moves and today cause assert churn; with the zone agreed, TruePin's target index IS our expected layout, so asserts see "already sorted" fast-path and stop reacting (this is what kills the oscillation: the two invariants become one).

## Design - TruePin side
- Responder + broadcaster per contract (background.js; ~60 lines; the debounce already coalesces broadcast storms).
- Group-respect fix (own bug regardless of TrueTabs): `enforceLockedFront` and `moveLockedToFront` skip tabs whose `groupId !== -1` - a locked tab the USER placed into a group keeps its page protection but stops being yanked to the front; it re-enters the zone when it leaves the group. (Split-view tabs already exempt; same pattern.)
- No other ordering behavior changes; `"onLock"` one-shot move unaffected.

## Interaction matrix (TrueTabs features x locked tabs)
| Feature | Resolution |
|---|---|
| Layout/sort/groupsOnTop | Locked zone sits between pinned and groups; sorts operate after the zone; groupsOnTop offset includes zone |
| Dedup (auto + directed + sweep) | Locked tab never a victim; as survivor it may receive merges (like pinned) but never relocates |
| Archive/discard | Locked ids skipped (TruePin territory extends to locked) |
| Blank collapse | Locked blank never closed |
| Grouping (rules/site/topic/Other/folder-open) | `placeable()` false; folder-open opens a fresh tab instead of adopting a locked one |
| Re-home | Gate 1 exclusion (spec cross-ref nav-rehome) |
| Merge windows | Locked tabs move with their window merge like pinned do today (TruePin re-asserts zone after; broadcast refreshes ids) |
| Resurrection strike (existing TruePin defense) | Unchanged; with untouchability the trigger should simply stop firing - strike stays as belt-and-suspenders |

## Data deltas
- TrueTabs: session set `lockedTabs`; constants `FAMILY_IDS` (2 ids). No settings.
- TruePin: constants `FAMILY_IDS`; no settings, no storage change.
- Manifests: none (no new permissions; messaging needs none).

## Edge cases (with resolutions)
- TruePin updated first, TrueTabs old: broadcasts land on a router that ignores unknown senders/types - inert. TrueTabs first, TruePin old: query rejects, empty zone - today's behavior. Ship order therefore free; same-day release still the plan.
- Mode flips to "off" mid-session: broadcast carries empty ids; zone dissolves; tabs become ordinary (placeable again) - next layout assert integrates them.
- Locked tab closed: both sides prune on `onRemoved`.
- User drags a loose tab INTO the locked zone region: TruePin re-enforces its packing (its zone, its rules); TrueTabs assert does not fight (indices before its block are out of its contract).
- Sender id spoofing: impossible - `sender.id` is browser-attested; allowlist compares against it, never against message content.
- Test hooks security posture (v1.14 audit said "no externally_connectable, __tt* unreachable"): adding `onMessageExternal` opens extension-to-extension reach, so the external router must accept ONLY `family:*` types from ONLY allowlisted ids - `__tt*`/`ui:*` names remain unrouted externally; security gate G4в re-runs this audit at review.

## Behavior-test table (dual-extension harness)
| Behavior | Test name |
|---|---|
| Harness boots both extensions, ids handshake | family: handshake |
| Locked tab keeps zone position through Organize + sort + groupsOnTop | family: locked zone survives layout |
| 5 s observation after layout: zero repeated moves of the locked tab | family: no oscillation |
| Locked tab excluded from dedup victimhood and archive | family: locked untouchable |
| TruePin absent: zone empty, all suites unchanged | family: graceful absence (existing 79 pass untouched) |
| TruePin: locked tab inside a user group is not yanked | truepin family: group respected (in TruePin suite) |
| External router ignores non-family types and alien senders | family: router allowlist |

## Build order
1. Dual-extension e2e capability (load both unpacked, second SW target attach) - done when: handshake test green.
2. TruePin responder/broadcaster + group-respect + its suite additions - done when: TruePin suite green x2 (42+2).
3. TrueTabs zone + untouchability predicate consolidation + router - done when: full suite green x2 (79 existing + 5 new).
4. Security re-audit of the external router (G4в trigger: new IPC surface) - done when: findings list resolved.
5. Docs: both READMEs' "Family" sections describe the truce contract; COMPATIBILITY.md row - done when: store-texts sweep clean both repos.
6. Release together: TruePin 3.12.0 + TrueTabs (version per batch order); after TrueTabs CWS id exists, fill it into TruePin's `FAMILY_IDS` (release-checklist line).

## Risks and open questions
- Pre-mortem (top 2): (1) id drift - TrueTabs CWS id unknown until publication; mitigated by dev-key ids working now and a checklist line to add the CWS id in TruePin's next patch; (2) a third mover (another tab manager installed) still fights TruePin - out of scope, the strike/pause defenses remain the answer there.
- Broadcast storm under rapid lock toggling: debounce already coalesces; worst case a few messages per second briefly - harmless.
