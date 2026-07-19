# Spec: our groups never sit at one member

Class: feature · Advisor score: 8/10 - closes a whole class (the size floor exists only at creation and is held by nobody afterwards), rides the enforcer and the trigger that already exist, no new setting and no new timer; the score is not higher because the strip visibly moves under the user's hand and the autoGroup-off posture is a judgement call, not an answer · Approval: pending (2026-07-19)

## Goal block
- What must exist: a group TrueTabs made stops existing the moment it is down to one tab, and that tab is re-filed by the normal placement rules (rule group, then site bucket, then "Other", else loose). Steady state: no one-tab TrueTabs group in the strip.
- How we verify: e2e - a dedup that closes the second member of a domain group leaves no group and the survivor re-filed; rule, renamed and "Other" groups survive at one member; a close by the user's own hand converges on the tick, not instantly.
- Do not touch: foreign groups (never modified, canon), the creation-time floor (`>= 2` guards in `organizePool`, `ensureOtherGroup`, `applySmart` stay - this is their maintenance-time twin, not their replacement), dedup identity rules, archive semantics, the layout engine's ordering contract.
- Stop/pause when: the enforcer starts needing its own timer, or its own copy of "where does a tab belong". Both mean the design has drifted into a second engine, and one engine is the entire point (lessons feature-interaction-matrix, split-brain-recurrence).

## Question round
| Question | Customer answer |
|---|---|
| Trigger: dedup only, automation only, or any shrink to one? | Any shrink - dedup, merge, sweep, archive, closing tabs by hand. "Fix the class, not the instance" (2026-07-19) |
| Which groups are exempt at one member? | Rule groups, groups the user renamed (protected), and the "Other" catch-all. Domain and AI-topic groups dissolve (2026-07-19) |
| Immediate or on the minute tick? | Our own closes immediately, the user's own closes on the tick - the strip must not jump under their hand mid-series (2026-07-19) |

## Scope and non-goals
- In scope: one predicate for "a lone group that must go", one enforcer that dissolves it, re-filing of the freed tab through the existing review pass, two triggers (our close path, the generation-gated tick), self-op markers so the dissolve is never read as a user pull-out.
- Non-goals: a setting (this is an invariant, not a preference - a one-tab group is churn by the codebase's own words); a size floor above 2; touching foreign groups; dissolving the "Other" catch-all (its contract is "with parking on, nothing stays loose" - dissolving it would break that promise); retroactively reorganizing anything beyond the freed tab.

## Design

**The gap.** `ensureOtherGroup` states the rule in a comment - "minting a new one waits for two (a one-tab group is churn, not organization)" - and `organizePool`, `applySmart` and `ensureOtherGroup` each enforce it with a `length >= 2` guard. All three guards fire at creation only. Nothing re-checks afterwards, so every path that removes a tab from a group (dedup, merge, sweep, archive, a close by hand) can leave a group of one, and it lives until the browser restarts. This is the "invariant held by intention, not by a check at every point" class (lesson mirror-parallel-group-dupes; symptom in the field: a "Bear" group holding one Bear tab after dedup).

**One predicate.** `isLoneDissolvable(owner, settings)` - true when the group is ours and is a domain group or an AI-topic group. False for: `owner.customId` (a rule is a standing order from the user), `owner.bookmark` (mirrors a folder, same family as a rule), `owner.other` (the catch-all is a parking lot, and a single tab is allowed to join it by design), `isProtectedTitle(settings, owner.title)` (the user put that name on it), and anything absent from `ourGroups` (foreign - never touched). One predicate, so the two triggers cannot disagree about what a lone group is.

**One enforcer.** `dissolveLoneGroups(windowId)`:
1. `getOurGroups()`; for each gid of that window passing `isLoneDissolvable`, `chrome.tabs.query({ groupId: gid })`.
2. Exactly one member: `markSelfOp("tabgroup", id)` BEFORE `chrome.tabs.ungroup` (lesson selfop-mark-after-call: the event beats the promise), then `removeGroupSig(title, color)` and drop the gid from `ourGroups` - the same three steps `ungroupOne` already performs for the popup's explicit command.
3. Return the number of groups dissolved. Zero members is not our business: Chrome removes empty groups itself and `tabGroups.onRemoved` already cleans the registry.

**Re-filing is not a second mechanism.** The freed tab is now `placeable()` by definition, so it re-files itself the moment the existing review pass looks at the window. `reviewPlaceable(windowId)` gains an optional window argument and calls `dissolveLoneGroups` as its head step: dissolve, then pool, then `organizePool`, then `applySort`. "Dissolve and re-sort" is one pass, and the answer to "where does this tab belong" stays in exactly one place.

**Two triggers, timing decided by cause.** The cause is already knowable, so neither trigger needs to sniff for it:
- *Ours, immediately.* `closeTabsGuarded` is the choke point of every automatic close of content - dedup (`background.js:885`), merge-into-navigated (`:970`), duplicate sweep (`:1047`), archive (`:1309`). It captures the victims' `windowId` before removal and, after the closes land, runs `dissolveLoneGroups(win)` per affected window; only if that returns non-zero does it run `reviewPlaceable(win)`. Putting the trigger at the choke point instead of at four call sites is deliberate - per-call-site wiring is how the layout rules drifted apart in v1.8. Blank collapse rides its own quiet ledger and bypasses `closeTabsGuarded` (v1.18.3); it needs nothing here, because `looseBlank` already excludes grouped tabs, so a blank close can never shrink a group.
- *The user's, on the tick.* The `onUpdated` handler already distinguishes "closed" from "pulled out" by liveness (lesson close-vs-pullout). In the branch where the tab is gone, `bumpPlaceableGen()` - the tick's generation gate then runs `reviewPlaceable()` within the minute. No new timer, no new alarm (lesson: periodic work is a generation counter on the existing tick).

Re-entrancy checked: `organizePool`, `applySort` and `reviewPlaceable` contain no `enqueue` (the only one nearby lives in `scheduleSortAssert`'s debounce, outside these paths), so calling the review inline from inside a queue job is not a nested enqueue waiting on itself (lesson nested-enqueue-recurrence, v1.3 and again 19.07).

**autoGroup = off.** Decided without asking, flagged for the approval: the enforcer runs regardless of the setting, re-filing keeps its existing `autoGroup !== "off"` gate. Rationale - "do not auto-group" is a statement about forming groups, and a group of one is not a grouping; with the setting off the freed tab simply goes loose. Approved as specced (customer, 2026-07-19).

**Build amendment (G2, found by the suite - `the review respects hands-off tabs`).** `organizePool`'s parking step did not park the pool; it re-queried the window for loose tabs and parked whatever it found. The pool is where the hands-off filter lives, so the re-query silently widened the pass: a tab the user had pulled out by hand was eligible for parking again. The hole predates this feature and was unreachable by arithmetic - a lone leftover never mints an "Other" (the creation floor), so a single hands-off tab always sat alone and safe. Dissolving a lone group puts a SECOND leftover in the window, the floor is met, and the "Other" mints over a tab nobody was allowed to move. Fix: the parking step intersects its re-query with the pool - one definition per pass of what it may touch, and the explicit Organize keeps parking hands-off tabs because its own pool includes them (the `two-explicit-commands-disagreed` rule: flags protect from automation, not from a click). Red/green is the existing contract itself: it failed on this feature without the fix and passes with it.

Method note for the next feature: the interaction matrix walked features against features and missed this, because the collision was not between two features - it was between a feature and a HELPER that re-derives its own inputs. Where a pass re-queries the world mid-flight, the matrix has to ask what filter the re-query drops.

## Interaction matrix
| Existing feature | Intersection | Resolution |
|---|---|---|
| Creation-time floor (`>= 2`) | Same rule, different moment | Both stay: creation refuses to mint a lone group, the enforcer refuses to keep one. One predicate would be wrong here - creation asks "may I form this?", the enforcer asks "may this remain?" |
| "Other" catch-all | Its contract is "with parking on, nothing stays loose" | "Other" is exempt. Dissolving it would strand its member loose and break the promise; a single tab joining "Other" is already legal by design |
| Custom rule groups / bookmark groups | A rule can legitimately match one tab | Exempt. A standing order from the user outranks the size floor |
| Protected (renamed) groups | The user named it | Exempt via `isProtectedTitle` - the existing membership lock already reads "automation does not remove tabs from this group" |
| Foreign groups | Never modified | Untouched by construction: the enforcer iterates `ourGroups` only |
| Two-strikes anti-fight ledger | An ungroup looks like a user pull-out | `markSelfOp("tabgroup", id)` before the call; the `onUpdated` handler consumes it and records neither `ungroupedByUser` nor a strike (lessons selfop-mark-after-call, selfop-lingers-on-join) |
| `ungroupedByUser` hands-off flag | A freed tab that was pulled out earlier | Stays hands-off: the review pool skips it, so it remains loose. Correct - the user's decision outlives the group |
| "Other" parking step (build amendment) | A second leftover in the window makes the catch-all mintable, and the step re-queried past the pool's hands-off filter | The parking step may only touch the pool. One definition per pass of what it may move; see the build amendment |
| Group signatures / restart adoption | A dissolved group must not be re-adopted | `removeGroupSig` on dissolve, same as `ungroupOne` |
| Undo Organize | `lastOrganize.gids` may name a dissolved group | Already safe: `undoOrganize` skips gids with no members |
| Smart / topic mode | "An automatic pass never mints a group another automatic pass would dissolve" | Holds: no pass mints a one-member group. A dissolved topic orphan re-clusters only when a real theme forms (>= 2), so there is no mint-dissolve loop |
| Collapse | A collapsed group of one | Dissolving simply removes it; nothing to expand |
| Layout engine (groups on top, sort) | The freed tab changes zone | `applySort` runs at the tail of the same pass - the strip settles once, not twice |
| Circuit breaker | Mass dissolve after a big archive batch | Ungroup is not a close and takes no close token; the enforcer is bounded by the number of our groups in one window |
| TruePin family lock | Locked tabs are never grouped | No intersection: such a tab is never in one of our groups |
| Settle gate | Cold start looks like mass shrink | The tick review is already behind `isSettled()`; `closeTabsGuarded` only runs from paths that are themselves gated |

## Three pillars
- SOLID: SRP - one predicate answers "is this a lone group", one enforcer acts, one existing pass re-files; DIP - the close path does not know placement rules, it asks the review. OCP - the creation guards are not rewritten, behaviour is added beside them.
- Zen: one obvious way to answer "where does this tab go" (the review pass); no new timer, no new setting, no new state key; the special case (autoGroup off) is stated, not smuggled in.
- Infostyle: n/a - no user-visible text. Behaviour is invisible by design; the README "How it works" line about site groups needs no change (a group of one was never promised).
- Engine parity: n/a - extension code, outside the vault's two-engine surface.

## Data deltas
n/a - no settings, no schema, no new storage key. `ourGroups` entries are deleted, which the registry already supports.

## Edge cases (with resolutions)
- Group of two, both tabs closed at once (sweep, archive batch): the group reaches zero, Chrome removes it, `tabGroups.onRemoved` cleans up. The enforcer sees no single member and does nothing.
- Dedup victim and survivor in the same group of two: the survivor is the lone member, group dissolves, survivor re-files - the reported case.
- Dedup victim in a group, survivor in another window: same, the victim's window is the affected one.
- Group of one whose sole member is the active tab: dissolve anyway. Ungrouping does not close, move focus, or lose anything; the tab keeps its position under `applySort`.
- Group of one that the user is dragging right now: the engine-activity stamp already suppresses sort asserts during user drags; the dissolve itself is idempotent and re-runs on the next tick if it lands mid-drag.
- The freed tab is the only leftover and parking is on with no "Other" yet: `ensureOtherGroup` refuses to mint for one tab, the tab stays loose. Consistent with the creation floor, no loop.
- A renamed group falls to one, then the user removes the name from the protected list: the next tick dissolves it. Correct - the exemption is the lock, not history.
- Rapid series of closes by hand inside one group: nothing moves until the tick, then one dissolve. This is the reason the user's own closes are deferred.
- autoGroup off, an Organize-made domain group falls to one: dissolves, tab goes loose, nothing re-files it. Stated above, open to override at approval.

## Behavior-test table
| Behavior | Test name | Red on old code |
|---|---|---|
| A duplicate sweep shrinking a domain group to one dissolves it and frees the survivor | `groups: duplicate sweep down to one dissolves the group, survivor freed` | yes |
| Archive shrinking a group to one dissolves it | `groups: archive down to one dissolves the group` | yes |
| The user's own close does not move the strip instantly, converges on the tick | `groups: hand-closed down to one waits for the tick, then dissolves` | yes |
| The dissolve records no strike and leaves no hands-off flag | `groups: lone dissolve is a self-op - no strike, freed tab regroups` | yes |
| The freed tab joins an existing "Other" when parking is on | `groups: a freed lone tab parks in the existing Other` | yes |
| A rule group survives at one member | `groups: a rule group survives a single member` | lock |
| A protected title survives at one member | `groups: a protected title survives a single member` | lock |
| The "Other" catch-all survives at one member | `groups: the Other catch-all survives a single member` | lock |
| A foreign group of one is never touched | `groups: a foreign group of one survives the enforcer` | structural |
| No mint-dissolve loop: a quiet browser with one lone-eligible tab settles | `groups: a lone tab settles loose - no mint/dissolve churn` | lock |
| The parking step never moves a hands-off tab (build amendment) | `the review respects hands-off tabs and stays mute while paused` (existing) | yes |

Red column, honestly labelled - "green before and after" is not a test unless something proves it bites:
- **yes** - verified failing on the pre-feature code, then passing.
- **lock** - a guard that must NOT fire; green either way by design, so it was proven by mutation instead: stripping the exemptions from `isLoneDissolvable` turns all three exemption locks red. The churn lock is proven by the same mutation reaching for groups it must leave alone.
- **structural** - green by construction (the enforcer walks `ourGroups`, which foreign groups never enter). It cannot be made red without rewriting the enforcer, so its value is forward-looking: it catches a future refactor that starts walking all groups. Recorded as such rather than counted as proof.

Suite runs twice green before merge (invariant 4): 132/132, twice, verbatim.

## Build order
1. `isLoneDissolvable` + `dissolveLoneGroups(windowId)`, `reviewPlaceable(windowId?)` head step - done when: a hand-built group of one dissolves on the tick and the tab re-files, red on old code.
2. `closeTabsGuarded` captures affected windows and runs the enforcer, review only when something dissolved - done when: the dedup case is instant, and a close that dissolves nothing costs no `organizePool` run.
3. `bumpPlaceableGen()` in the close branch of the `onUpdated` group handler - done when: closing by hand converges within one tick and no strike is recorded.
4. Remaining contracts from the table, suite twice green - done when: 8 new tests green, 79 existing still green, no flake across both runs.

## Risks and open questions
- Visible movement of the strip when the user closes tabs by hand. Mitigated by deferring their closes to the tick; if it still reads as jumpy in dogfood, the next lever is deferring the dissolve until the window is unfocused, not adding a grace timer.
- Perceived loss of a group name. Dissolving a domain group also drops its signature, so a group re-formed later gets a fresh colour. Acceptable: `colorFor(domain)` is deterministic, so the colour is in fact the same one.
- The enforcer runs on a hot path (`closeTabsGuarded` inside archive batches). Bounded by "our groups in one window" and short-circuited before any re-filing when nothing dissolved; if profiling shows cost, the fallback is to run it once per batch rather than per close call.
- Open, decided by me and reversible at approval: enforcer behaviour when `autoGroup` is off (see Design).

## Links
- Process: `~/Clemond/system/dev-process.md`
- Lessons: feature-interaction-matrix, split-brain-recurrence, selfop-mark-after-call, selfop-lingers-on-join, close-vs-pullout, nested-enqueue-recurrence, mirror-parallel-group-dupes
- Project note: `~/Clemond/projects/truetabs.md`
