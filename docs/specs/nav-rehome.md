# Spec: Universal re-home on domain change (tab leaves its group when its page truly changes)

Class: feature · Advisor score: 8/10 - closes the most visible daily wrong-state (tab content no longer matches its group), reuses the existing rehome machinery; risk is over-eager moves, contained by rest-delay + protected list · Approval: pending (batch 2026-07-19)

## Goal block
- What must exist: a tab inside a group whose committed page moves to a different registrable domain (eTLD+1) ends up in the right place - the matching rule group, the domain group, an existing AI topic group, or "Other" - instead of sitting forever in a group it no longer belongs to. Typed navigations move instantly; link navigations move only after the tab has settled on the foreign domain. Groups the user marked as protected are never touched.
- How we verify: e2e - typed cross-domain navigation inside a smart group lands the tab in the matching domain group within one commit cycle; link navigation re-homes only after the rest window elapses and only while the tab is not active.
- Do not touch: dedup identity (`dupeKey`/`normalizeUrl`), archive engine, layout/sort engine internals (re-home only calls existing placement primitives), foreign (hand-made) group inviolability, pinned tabs, fresh-tab `groupOnCommit` path.
- Stop/pause when: re-home decision requires a second AI call design (only the single existing-topics match is in scope); any need to move tabs out of foreign groups (explicitly rejected - protected-list covers the intent).

## Question round
| Question | Customer answer |
|---|---|
| Trigger threshold: typed-only vs any domain change? | Any domain change; plus a setting for groups that must never be touched; AI mode must participate in the destination logic; "think it through well" (2026-07-19) |
| Link navigations rip reading flows - mitigation? | Delegated to PM: typed/bookmark = instant; link/redirect = re-home only "at rest" (tab inactive, mismatch persisted ~2 min). Flagged for approval in the batch digest. |

## Scope and non-goals
- In scope: extending `rehomeNavigated` to exit smart-topic and custom-rule groups; an at-rest re-home pass for link navigations on the existing minute tick; "Other" as final parking destination; AI-assisted destination (match against existing topic groups only); per-group protection list (setting + popup lock action).
- Non-goals: moving tabs out of foreign (hand-made) Chrome groups - protection semantics stay "foreign = untouchable" (customer's never-touch list covers own groups); creating new AI topic groups on navigation (churn invariant: automatic passes never create groups an automatic pass would dissolve); any new timers (reuse the minute tick); undo slot ownership (re-home is not an undoable batch; dragging back = hands-off signal as today).

## Design
One enforcer: `rehomeTab(tabId, commitInfo)` - the single re-home decision function, called from both triggers. No second placement path (lessons feature-interaction-matrix, split-brain-recurrence).

Triggers:
- T1 instant: `handleCommit` kinds `address`/`bookmark`, `committedCount > 1` (existing call site) - now applies to ALL our group kinds.
- T2 at-rest: commit kinds `link`/`redirect` on a tab in one of OUR groups where `registrableDomain(post.url)` differs from the group's identity. Mark `st.mismatch = {domain, key, since}` from the EVENT payload (lesson event-vs-reread). The minute tick re-homes marked tabs when: mismatch age >= REST_MS (120s), tab not active, tab still in the same group, stored mismatch still current (a later commit updates or clears the mark). Returning to a matching domain clears the mark.

Destination chain (inside `rehomeTab`, in order):
1. Gates: settle, paused, `ungroupedByUser`, strikes, pinned, protected group (below), foreign group.
2. User rule match (`customAssign` precedence unchanged) - move to rule group.
3. Existing OUR group for the new domain in this window - join it.
4. Topic mode with engine ready: single-tab match against EXISTING topic titles only ("does this page belong to one of: [titles]? answer title or none"), off-queue with 2500 ms timeout, apply via enqueue with liveness re-check; "none"/timeout/engine-off falls through. Never creates a group.
5. `otherGroup` enabled - park to Other (committed pages only; blanks never reach here by construction).
6. Else ungroup (leave loose; layout engine owns its position).

Group identity for mismatch: site groups - registry domain; rule groups - any of the rule's domains OR the rule's AI hint said yes at assignment (mismatch = new domain not in rule domains); topic groups - no domain identity, so T2 does not fire for them on link browsing (reading flows inside a topic are legitimate); T1 typed DOES re-home out of topic groups (typing a new address is a new intent regardless of topic).

Protected groups ("never touch"):
- New synced setting `protectedGroups: string[]` (group titles, max 20 entries, each <= 40 chars, normalized like custom group names).
- UI: lock toggle on the popup group row (writes/removes the title); also editable as a list in options next to "My groups".
- Semantics: automation never REMOVES tabs from a protected group (no T1/T2 re-home out, no smart re-shuffle dissolve, no Other-review pull). Adding tabs to it stays allowed (rules/domain routing may still target it). Explicit bulk commands (Organize) also leave protected groups alone - "never" means never; only a direct user drag changes membership. Precedence over rules: protection wins (rule cannot pull a tab out of a protected group).

## Interaction matrix
| Existing feature | Intersection | Resolution |
|---|---|---|
| Dedup directed merge (`mergeIntoNavigated` + inherit) | Both run on address commits | Order unchanged: merge first, inherited group wins re-home step 2.5 (existing behavior); `rehomeTab` is the same function extended |
| Fresh-tab grouping (`groupOnCommit`) | Both place tabs | Unchanged split: `committedCount <= 1` fresh path, `> 1` re-home path; one predicate, no overlap |
| Strikes / `ungroupedByUser` | User fights a move | Same ledger and flags gate every re-home; two pull-outs retire the key for the session |
| Self-op markers | Our moves echo as events | Every `rehomeTab` group/ungroup call marks self-op BEFORE the API call; join events consume markers (existing rules) |
| Smart re-shuffle (`smartRegroupOurs`) | Could dissolve a group re-home just joined | Re-shuffle already only touches OUR auto groups; protected groups now excluded from dissolve |
| Other review (`reviewPlaceable`) | Other is both destination and source | Unchanged: re-home may park INTO Other; review may later pull it into a rule/site group - `placeable()` already allows; protected Other is not a case (Other cannot be protected - it is parking, not a decision; the lock toggle is not rendered on the Other row) |
| Archive | Stale tab in mismatch state | Independent: archive may close it first; tick liveness check skips dead tabs |
| Layout engine | Re-home changes membership | Re-home only calls group/ungroup primitives; layout assert runs after, as with any membership change |
| TruePin locked tabs (family-interop spec) | Locked tabs must not be re-homed | Locked ids excluded at gate 1 once the interop zone lands; until then locked tabs are plain tabs (current behavior) |
| Bookmark groups (bookmark-groups spec) | Folder-born groups are definitions | They are OUR groups: T1 typed re-home applies unless protected; folder content never changes from re-home (working set diverges by design) |

## Data deltas
- `settings.protectedGroups: string[]` default `[]` (sync; normalized: strings, trimmed, deduped, cap 20x40).
- Per-tab session state `t<id>` gains `mismatch: {domain, key, since} | null`.
- New constant `REHOME_REST_MS = 120_000`.
- Migration: `normalizeSettings` adds the key; no renames.

## Edge cases (with resolutions)
- OAuth hop (typed bank URL redirects through auth domain): T1 acts on the typed commit's final URL; subsequent redirect commits update the mark; at-rest pass converges once the chain settles. No flapping: T2 requires 2 min stable mismatch.
- User types a URL of the SAME domain: no mismatch, nothing moves.
- Typed URL matches the group the tab is already in (rule or domain): chain step 2/3 resolves to current group - no-op, no self-op noise (skip move when target == current).
- Tab active the whole day on foreign domain (T2): stays until user switches away - moving the tab under the user's cursor is never acceptable; active tabs are exempt from T2 (T1 typed still instant - the user just acted).
- Group renamed by user meanwhile: disown (existing) makes it foreign - mark cleared, tab stays.
- Mismatch tab dragged by user into another group: `groupId` change event clears the mark (user decided).
- Window merge mid-rest: mark survives (window-agnostic), tick re-checks liveness and current group.
- Chrome discards the tab (memory saver): URL/state intact on discard; tick skips discarded tabs (no wake just to move - move applies on next activation commit… resolution: discarded tabs are skipped by the tick and re-marked on their next commit).
- Protected list references a title no live group has: harmless; matches by title whenever such group exists.
- AI answers a title that no longer exists (raced dissolve): apply step re-checks group liveness inside the queue job; miss falls through to Other.

## Behavior-test table
| Behavior | Test name |
|---|---|
| Typed cross-domain out of smart group joins existing domain group | rehome: typed exits topic group into domain group |
| Typed URL matching another rule moves to that rule group | rehome: typed follows user rule |
| Typed with no target parks into Other | rehome: typed parks to Other when no group fits |
| Topic mode: AI matches existing topic, tab joins it (mock AI) | rehome: typed joins existing topic via engine |
| AI timeout falls through to Other without blocking | rehome: engine timeout falls back to Other |
| Link navigation does not move the tab immediately | rehome: link browse keeps membership |
| Link mismatch + rest window + inactive re-homes via tick | rehome: at-rest link mismatch re-homes |
| Active tab never re-homed by the tick | rehome: active tab immune at rest |
| Protected group holds members against typed re-home | rehome: protected group never releases |
| Foreign group untouched by both triggers | rehome: foreign group inviolable |
| Second user pull-back strikes the key and stops re-home | rehome: strikes retire the domain |
| Returning to matching domain clears the mismatch mark | rehome: mark clears on return |

## Build order
1. `rehomeTab` extraction + T1 generalization (exit smart/custom, Other fallback) with tests 1-3, 6, 9-12 - done when: suite green x2.
2. Protected groups setting + popup lock + options list + normalization - done when: test 9 + settings normalize test green.
3. T2 mismatch mark + tick pass - done when: tests 7-8 green with `__ttTick` clock.
4. AI single-tab match (off-queue, timeout, mock in e2e) - done when: tests 4-5 green.
5. Docs sweep: options hints (8 locales), README behavior section, COMPATIBILITY.md row - done when: locale parity script passes.

## Risks and open questions
- Rest-delay taste: 120 s is my call; if Michael reports "too slow/too eager" it is a one-constant tune, not a redesign.
- AI mode adds a per-navigation model call (typed only, existing topics only): kept off-queue with a hard timeout so the engine never blocks; if Nano is mid-download the step silently skips.
- Pre-mortem (top 2): (1) users experience "my tab jumped out of the group I put it in" - mitigated by drag-in = `groupId` event clears automation claim + strikes + protected list + FAQ line; (2) tug-of-war with a rule whose domains contain the old domain but user retargets often - strikes retire the pair quickly.
