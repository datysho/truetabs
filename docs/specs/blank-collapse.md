# Spec: Instant collapse of surplus blank New Tabs

Class: feature · Advisor score: 8/10 - the visible daily annoyance from the screenshot (six New Tabs), one event handler reusing existing sweep semantics; small and safe · Approval: pending (batch 2026-07-19)

## Goal block
- What must exist: opening a New Tab instantly closes every other blank New Tab in the same window (not pinned, not active, not grouped). Steady state: at most one blank tab per window - the one you just opened.
- How we verify: e2e - three rapid blank creations leave exactly one blank (the newest); an active or pinned blank is never closed.
- Do not touch: dedup identity rules (`dupeKey` stays null for blanks), archive (blanks are never archived - nothing to restore), manual `Sweep` button behavior, settle gate.
- Stop/pause when: any need to inspect omnibox text (impossible by platform) or to add a new setting beyond the dedup umbrella.

## Question round
| Question | Customer answer |
|---|---|
| Instant close on creation vs 1-minute auto-sweep? | "Мгновенно при открытии" (2026-07-19) |

## Scope and non-goals
- In scope: `tabs.onCreated` handler collapsing surplus blanks window-scoped; self-close markers; breaker ledger accounting; popup badge consistency (blankSurplus naturally drops).
- Non-goals: cross-window collapse (a blank in another window is that window's business); closing the single remaining blank (a lone New Tab is a legitimate launchpad); touching blanks that live inside a group (only a user drag can put one there - user decision, hands off); any grace timer (customer chose instant).

## Design
Build amendment (2026-07-19, G2 pre-flight finding): "instant" gets a 5-second in-flight floor - software (session restore, other extensions, our own harness) routinely creates a tab blank and navigates it a beat later; a blank younger than `BLANK_MIN_AGE_MS = 5s` is a page in flight, not an abandoned tab, and closing it would eat someone's navigation. A tab with NO state yet is younger than young (its own created-job has not run), never old. The floor makes a second trigger necessary: the minute tick sweeps aged surplus blanks down to the newest (`reviewBlanks`, one global query per minute), so two quick Cmd+T's still converge to one blank within a minute. Real-user perception stays "instant": an abandoned blank is minutes old when the next Cmd+T lands.

Dogfood amendment (2026-07-19, Michael's report - v1.18.1, red/green): the age floor made the HUMAN path non-instant: Cmd+T from a New Tab left the abandoned one alive for up to five seconds ("создаётся дубль, объединяются потом"). The discriminator the floor actually needed is focus, not age: the blank the user JUST LEFT (was the active tab when the newcomer took focus - in-memory prev-active per window) is an abandoned scratch by definition and dies instantly at any age; a software create-then-navigate tab is never the tab under the user's fingers, so the floor still protects exactly what it was built for. Worker death degrades to the age rule gracefully.

G4 review amendments (2026-07-19): ONE definition of a collapsible blank (`looseBlank`: ephemeral, not pinned, not active, not grouped) shared by the collapse trigger, the tick sweep, the manual Sweep button AND the popup surplus count - the manual button now honors the grouped-blank line too (a blank the user parked inside a group survives Sweep), and the "keep the newest" survivor is chosen among LOOSE blanks only, so a pinned or grouped blank can never be the survivor that dooms the user's only scratch tab. One scan produces both the survivor and the victims (no double query per window).

On `tabs.onCreated(newTab)` where `isEphemeralUrl(newTab.pendingUrl || newTab.url)`:
1. Gates: settled (session-restore storms excluded - mirror-cold-start lesson), not paused, `dedupAuto` on (blank collapse is dedup-family; one umbrella toggle, no new setting), normal window, new tab not incognito.
2. Query window tabs; victims = others with `isEphemeralUrl(url || pendingUrl)`, `!pinned`, `!active`, `groupId === -1`, not the new tab, not already self-closed in flight.
3. Close victims via the engine path: `selfClosed` marker per id (RMW through the serializer - selfclosed-rmw-race lesson), `closeLedger` accounting (circuit breaker still budgets mass closes), NO archive entry (an empty page restores nothing - consistent with manual sweep).
4. The NEW tab is never a victim, even if created in background ("open new tab to the right" edge): newest wins, matching the customer's chosen semantics.

Ordering note: `onCreated` fires before the page commits; a tab being created directly with a real URL (`tabs.create({url})` by another extension) has a non-ephemeral `pendingUrl` and is ignored here; if `pendingUrl` is empty and a real URL commits later, the tab was a blank for a moment - it may collapse a previous blank, which is correct (the previous blank was abandoned).

## Interaction matrix
| Existing feature | Intersection | Resolution |
|---|---|---|
| Dedup engine | Blanks have no `dupeKey` | Unchanged; collapse is a separate creation-time rule under the same `dedupAuto` toggle |
| Manual Sweep button | Same victims | Sweep keeps its broader semantics (also closes blanks when several exist regardless of recency); collapse just makes it rarely needed |
| Fresh-tab grouping / Other parking | Blank later commits a page | Untouched: the surviving blank follows the normal fresh-commit path; parked-blank guard already exists |
| Circuit breaker | Mass close protection | Victims go through `closeLedger`; a pathological blank storm trips the breaker like any mass close - correct |
| Undo | Accidental loss | No archive entry; recovery is Cmd+T (nothing was lost) - documented in FAQ |
| Settle gate | Session restore recreates many blanks | Collapse disabled until settled; restored blanks are then left alone until the user opens a new one |
| Strikes | User reopens blanks repeatedly | No strike key exists for blanks (no identity); the act of opening a new blank is itself the trigger, so there is no fight to detect - by construction the user always keeps the tab they just opened |
| TruePin locked tabs | Locked blank? | Locked ids excluded once family-interop zone lands; pinned blanks already excluded |

## Data deltas
n/a - no settings, no schema change (behavior rides `dedupAuto`).

## Edge cases (with resolutions)
- Cmd+T three times fast: each creation closes the previous blurred blank; one survivor. Chosen explicitly by the customer over the "spread three addresses" workflow.
- Blank dragged into a group by the user: `groupId !== -1` excludes it - user decision respected.
- Blank in another window: untouched (window-scoped).
- Only blank in the window is active and user opens another via context menu in background: active one survives (active exclusion), background new one survives (newest); two blanks momentarily - next creation collapses. Accepted: never close the active tab, never close the just-created tab.
- Vivaldi/Edge startpages: `isEphemeralUrl` already covers the family.
- Incognito windows: skipped (existing dedup posture).

## Behavior-test table
| Behavior | Test name |
|---|---|
| Three rapid blanks collapse to the newest | blanks: instant collapse keeps newest |
| Active blank never closed | blanks: active blank survives |
| Pinned blank never closed | blanks: pinned blank survives |
| Grouped blank never closed | blanks: grouped blank survives |
| No collapse before settle | blanks: settle gate holds |
| `dedupAuto` off disables collapse | blanks: dedup toggle governs |
| Collapsed blanks leave no archive entries | blanks: no archive residue |

## Build order
1. Handler + gates + self-close path with tests 1-4, 7 - done when: suite green x2.
2. Settle/toggle gates with tests 5-6 - done when: suite green x2.
3. Docs: FAQ line (README) + STORE_LISTING dedup paragraph mentions blank hygiene - done when: store-texts sweep clean (lesson store-texts-drift).

## Risks and open questions
- Muscle-memory risk (typed-but-blurred omnibox text lost with its tab): named to the customer in the question round; chosen anyway. FAQ documents it.
- No other open questions.
