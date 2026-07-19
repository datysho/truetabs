# TrueTabs feature and settings compatibility matrix

The standing answer to "which features and settings compose, which pair up, and which exclude each other". Every future feature spec walks this table and adds its row (dev-process interaction-matrix rule); every "one-disables-other" pair must be visibly gated in the UI, every "auto-paired" pair enforced in exactly one code path.

Verdicts: **composes** (independent, no caveats) · **composes\*** (with a stated caveat) · **auto-paired** (code keeps the pair coherent - single writer `ui:setSetting` + `pairGrouping`) · **UI-gated** (a control that has nothing to manage is disabled/hidden) · **exclusive** (cannot be on together; enforced) · **documented** (platform limit we cannot enforce - stated to the user).

## Grouping axis

| Pair | Verdict | Mechanism / caveat |
|---|---|---|
| `autoGroup: topic` + `smartEngine: off` | auto-paired | Choosing topic without an engine auto-selects `builtin`; switching the engine off falls the mode back to `site` (`pairGrouping`) |
| `smartEngine` change + `autoGroup` | auto-paired | Engine on = topic, engine off = site - one rule, one writer; both pages repaint from the engine's answer |
| User rules ("My groups") + any `autoGroup` mode | composes | Rules route first in EVERY mode - a standing order, not a mode |
| User rules + smart topic naming | composes | Rule names are reserved: Smart Organize never mints a topic with a rule's name; hinted rules join the candidate list instead |
| `otherGroup` + any `autoGroup` mode | composes\* | "Other" is a parking lot, never a decision: rules, site groups and topics may take tabs back out. With `autoGroup: off` the engine places nothing - catch-all included |
| Re-home (typed) + rules / site groups / topics | composes | One destination chain, same as fresh tabs: rule, then existing domain group, then existing-topic match (engine on), then Other |
| Re-home (at-rest link) + topic groups | exclusive | Link browsing never marks topic members - a topic makes no domain claim on a reading flow; only typed navigation releases from a topic |
| Re-home + protected groups | exclusive | The lock wins: no release, no at-rest clock; entry into a protected group stays allowed |
| Re-home + hand-made groups | exclusive | Foreign groups are inviolable - never joined, never pulled from |
| Re-home + strikes / `ungroupedByUser` | composes | The same ledgers gate re-home that gate first-commit grouping; two pull-outs retire the key |
| Protected groups + Smart re-shuffle (`smartRegroupOurs`) | exclusive | Protected titles are excluded from the re-shuffle pool - a lock outranks the rebuild permission |
| Protected groups + rules | composes\* | A rule may still route NEW tabs INTO a protected group; it can never pull one out |
| Protected groups + "Other" | UI-gated | Other cannot be protected (the lock action is absent on its row) - protecting a parking lot would mean nothing |
| Protected groups + archive | composes\* | Protection guards MEMBERSHIP, not lifetime: stale members of a protected group still archive on the normal rules (allowlist is the no-archive tool) |
| Protected groups + dedup | composes\* | A duplicate inside a protected group can still merge away - two copies is what dedup exists to end; the survivor inherits the protected group when it was the victim's home |
| Twin guard + all group creation | composes | One live group per OUR title per window: every creation path routes through the same choke point; a same-titled hand-made group with an alien signature keeps its independence |
| Mid-session re-adoption + disown | exclusive | Rename/recolor = disowned forever (signature removed); no signature, no adoption - a returning saved-groups chip re-enters management only while its signature lives |

## Dedup axis

| Pair | Verdict | Mechanism / caveat |
|---|---|---|
| `dedupAuto` + `dedupScope` | composes | Scope narrows the candidate set (window vs everywhere); directionality unchanged |
| Auto dedup + pinned / active / audible tabs | exclusive | Never victims (pinned is TruePin territory by contract) |
| Auto dedup + fresh vs navigated tabs | composes | Opens dedup (fresh tab, pre-commit fast path); in-place navigation merges the STALE copy into the user's tab - attention wins |
| Blank collapse + `dedupAuto` | auto-paired | The collapse rides the dedup umbrella toggle - off means off |
| Blank collapse + in-flight tabs | exclusive | 5 s age floor: a just-created blank is a page in flight (session restore, other software) - never a victim |
| Blank collapse + active / pinned / grouped blanks | exclusive | Never victims; grouped blank = the user's decision |
| Blank collapse + archive | exclusive | Blanks are closed, never archived - there is nothing to restore |
| Manual Sweep + strikes / toggles | composes | An explicit command ignores `dedupAuto` and strikes - flags guard against automation, not clicks |
| Manual Sweep + grouped blanks | exclusive | The one `looseBlank` definition rules them all: a blank the user parked inside a group survives even the explicit Sweep |
| Dedup + non-web schemes (`file://`, `chrome-extension://`) | composes\* | Deduped by identity, closed WITHOUT an archive row (cannot be restored faithfully; the twin stays open) |

## Archive axis

| Pair | Verdict | Mechanism / caveat |
|---|---|---|
| `archiveAfter` + `discardStale` | composes | Discard fires at half-threshold, archive at full; never both in one tick |
| Archive + `archiveAllowlist` | exclusive | Allowlisted domains neither archive nor discard |
| Archive + foreign groups | UI-gated | `archiveForeignGroups` (default off): hand-made groups are curated intent |
| Archive + pinned / active / audible | exclusive | Never candidates |
| Archive + TruePin locked pages | documented | A page TruePin resurrects right after archiving strikes the archive class for that key - two rounds retire it for the session |
| Archive TTL + archive cap | composes | TTL prunes by age, FIFO cap (5000) by count |

## Order and layout axis

| Pair | Verdict | Mechanism / caveat |
|---|---|---|
| `sortGroups` / `sortTabs` / `groupsOnTop` | composes | One layout engine enforces zones, group order, tab order, Other-last in a single pass |
| `sortAuto` + both orders manual | UI-gated | A live-order switch with no live order to keep is disabled |
| Manual drag + an active sort | composes\* | The drag snaps back (maintained invariant); the popup hides the drag grip under a managed order instead of lying |
| "Other" + any group order | composes | Other closes the group block (or the strip) regardless of sort mode |
| Recency sort + Ctrl+Tab cycling | composes | Activation re-sorts through the same engine with coalescing - a cycle settles to one move |
| Layout engine + TruePin `lockToFront: always` | documented → family-interop | Today: two enforcers can contest the front (see the family-interop spec shipping next); after it: zones `[pinned][locked][groups][loose][Other]` with locked tabs untouchable |

## AI axis

| Pair | Verdict | Mechanism / caveat |
|---|---|---|
| `smartEngine: builtin` + Chrome without Nano | UI-gated | Runtime availability detection; download only on explicit click; topic mode falls back to site grouping while unavailable |
| `smartEngine: byok` + missing key | UI-gated | Explicit "no key" status; assignment falls back to site |
| BYOK provider + host permissions | composes | Origins are requested at key entry and RELEASED on provider switch / engine off; custom endpoint = loopback only (manifest ceiling) |
| Smart Organize + mutation queue | composes | The AI phase runs off-queue (pages stay live); application is one atomic job; keepalive heartbeat spans the run (MV3 worker death) |
| Smart Organize + user rules | composes | Rule pre-pass routes matches first; rule names reserved as topics |
| Smart Organize + hand-made groups | exclusive | Never rebuilt; `smartRegroupOurs` covers OUR auto groups only, minus protected titles |
| Background AI on a timer | exclusive (rejected 3/10) | Would block the Organize button on a schedule and jitter names (model nondeterminism); periodic work is generation-counter driven and deterministic instead |
| Re-home topic match + AI cost | composes\* | One single-tab question, existing topics only, never creates groups, asked BEFORE anything moves (same answer = zero churn); engine silent = membership stands, except a typed cross-domain jump which releases deterministically |
| Re-home + the minute tick | exclusive (AI) | The at-rest pass runs `allowSmart: false` - a timer never wakes the model or spends BYOK tokens; only the user's own navigation may |

## Platform (Chrome native) axis

| Pair | Verdict | Mechanism / caveat |
|---|---|---|
| Extension groups + Chrome saved-groups chips | documented | No API exists to detect, unsave or delete a chip; chips survive close/ungroup and sync per the user's "Saved tab groups" sync toggle. TrueTabs minimizes the raw material (twin guard, chip re-adoption); existing chip debt is a one-time manual cleanup (right-click - Delete) |
| Per-window groups + cross-device sync | documented | "Other" and domain groups exist per window by platform design; saving them yields same-named chips per window and per device - the duplication engine behind the screenshot; FAQ tells the story |
| Groups + incognito | exclusive | The engine skips non-normal windows entirely |
| Settings + Chrome Sync | composes | `settings` + `customGroups` (+ `protectedGroups`) live in `storage.sync`; BYOK key and archive are deliberately local (see the settings-platform spec for the sync story) |
| Session state + browser restart | composes | Session storage resets by design; signatures re-adopt our groups; settle gate holds automation until the world stops moving |

## Update lifecycle (rides the settings-platform spec)

| Pair | Verdict | Mechanism / caveat |
|---|---|---|
| CWS auto-update + user settings | composes | `storage.sync`/`local` survive updates; every read normalizes against the schema; retired keys map forward |
| Update apply + AI run / open pages | exclusive | The applier (1.17) waits for the quiet moment; Chrome's own idle rule already defers while pages are open |
