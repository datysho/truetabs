# Spec: Native saved-groups compatibility + the feature compatibility matrix

Class: feature (code small, doc heavy) · Advisor score: 7/10 - the chip-duplication pain is real (screenshot: Google x2, Other x3, Github + GitHub) but the platform gives extensions ZERO API over saved groups, so the honest deliverable is churn minimization in code plus a definitive compatibility story; scored 7 because part of the fix is necessarily documentation and a one-time cleanup, not code · Approval: pending (batch 2026-07-19)

## Goal block
- What must exist: (1) TrueTabs stops multiplying same-named live groups (the raw material of chip duplication); (2) a written, complete compatibility matrix of every feature and setting pair - including AI mode - lives in the repo and drives the options UI gating; (3) README/FAQ tells users exactly how saved chips behave, why duplicates appear, and how to clean and prevent them; (4) a dogfood protocol pins down what Michael's Chrome actually does (auto-save on close or manual-save only).
- How we verify: e2e - re-running grouping across restarts and windows never yields two OUR live groups with the same title in one window; doc review - every settings pair appears in the matrix with a verdict.
- Do not touch: anything pretending to manage saved chips via API (none exists - verified 2026-07-19: no detection, no unsave, no chip deletion, chips survive ungroup/close and keep syncing); the per-window nature of Chrome groups (platform fact, "Other" per window stays).
- Stop/pause when: any idea requires knowing a group's saved state (impossible today; revisit only when Chrome ships such an API).

## Question round
| Question | Customer answer |
|---|---|
| What exactly do you observe? | "Взаимодействие с TruePin и Saved Groups не проработано; на скриншоте - сколько дублей групп, это ужасно; мы должны явно понимать, какие фишки и настройки совместимы между собой, а какие нет - обычный режим, АИ и куча связанного функционала; продумай всё хорошо" (2026-07-19). TruePin side - family-interop spec; this spec owns saved groups + the matrix. |

## Scope and non-goals
- In scope: same-title live-group reuse invariant (churn minimization); `docs/COMPATIBILITY.md` (the matrix, English) + README/FAQ user section (8 locales for the options hint only); options UI audit - every incompatible pair is either auto-paired, disabled-with-reason, or documented; dogfood protocol + one-time chip cleanup instructions.
- Non-goals: touching saved chips programmatically (no API); an in-extension "saved groups manager" (cannot be built); disabling Chrome features for the user (their browser, their flags); n/a on sync settings automation (user-level controls only).

## Platform facts (verified 2026-07-19, drives the design)
- Extension-created groups are NOT auto-saved by Chrome; saving is a user action (right-click - Save group) - though newer Chrome builds keep making saving easier/default-adjacent, so the design assumes chips WILL exist.
- No extension API exists to detect saved/shared state, to unsave, or to remove a chip. Ungrouping or closing a saved group's tabs leaves the chip alive and syncing.
- Chips sync across devices when Chrome Sync has "Saved tab groups" on; users can turn that toggle off; desktop flags can disable the feature UI.
- Chrome groups are per-window; identical names across windows/devices are distinct groups - saving them yields N same-named chips. This is the main duplication engine, amplified by TrueTabs recreating utility groups ("Other", domain groups) per window and per machine.

## Design
Code (small, load-bearing):
1. Same-title reuse invariant: before `createOurGroup` with title T in window W, adopt an existing live group in W titled T when it is (a) already ours, or (b) unclaimed-foreign with OUR signature match (chip-restored copies of our own groups re-enter management instead of spawning "Google" #2). Hand-made foreign groups with alien signatures stay untouched. This kills the twin-group source live; enforcement sits inside the single group-creation choke point.
2. Existing readopt widened: chip-restored groups arrive via `tabGroups.onCreated` mid-session, not only at startup - the adoption pass listens there too (settle-gated).
Doc (the matrix): `docs/COMPATIBILITY.md` - one table of every feature/setting pair with a verdict: composes / auto-paired (code enforces) / one-disables-other (UI gates) / incompatible-documented. Covers: dedup (auto, scope, directed), blanks collapse, archive (TTL, allowlist, foreign groups, discard), grouping modes (off/site/topic-AI), rules, Other, re-home (typed, at-rest, protected), sorts (groups/tabs/auto), groupsOnTop, collapse timer, smart re-shuffle, bookmark groups, update applier, TruePin zone, native saved groups, BYOK/Nano engine states. The options-UI audit walks the matrix: any "one-disables-other" pair must be visibly gated (pattern exists: `sortAuto` grays out, `pairGrouping`), any "composes with caveat" pair gets its hint line. The matrix is a REVIEW ARTIFACT for every future feature spec (dev-process interaction-matrix rule now has a standing home).
User docs: README/FAQ section "TrueTabs and Chrome's saved groups": why chips duplicate (per-window + per-device + no API), one-time cleanup (right-click chip - Delete), prevention (do not Save TrueTabs utility groups; optionally toggle off "Saved tab groups" in sync settings; bookmark groups are the durable alternative that does not multiply).
Dogfood protocol (Michael, 5 minutes): on his Chrome - (1) let TrueTabs create a domain group, close its tabs, observe whether a chip appears without manual Save; (2) count current chips, delete the stale ones once; (3) report Chrome version + result - pinned into this spec's answer row and the FAQ wording adjusts if his build auto-saves.

## Interaction matrix
| Existing feature | Intersection | Resolution |
|---|---|---|
| Group creation (all engines) | Twin same-title groups | All creation flows route through the reuse invariant (single choke point) |
| Readopt at startup | Chip-restored groups mid-session | onCreated-time adoption, settle-gated, signature rules unchanged |
| Disown on user rename | Reuse could re-adopt a disowned group | Disowned = user claimed: excluded from (b) adoption by the disown mark for the session |
| Bookmark groups | Same durability story competing with chips | FAQ positions folders as the recommended durable path; open-reuses-live rule already prevents twins |
| Family-interop (TruePin) | Separate spec | Cross-referenced; no overlap in code paths |

## Data deltas
n/a - no settings, no schema. New doc file `docs/COMPATIBILITY.md`.

## Edge cases (with resolutions)
- Two same-titled OUR groups already live (pre-fix debt): first reuse pass merges new tabs into the first match; the second group dissolves naturally when emptied or on next Organize; no forced migration.
- Chip-restored group arrives with title matching a PROTECTED group name: adoption still fine (protection restricts removals, not adoption).
- User genuinely wants two groups named "Work" in one window: hand-made ones stay untouched (alien signature); only OUR machinery refuses to mint twins.

## Behavior-test table
| Behavior | Test name |
|---|---|
| Same-title our-group in window is reused, never twinned | native: no same-title twins |
| Chip-restored copy with our signature is adopted mid-session | native: midsession readopt |
| Disowned group is not re-adopted after rename | native: disown sticks |
| Options audit: every one-disables-other pair visibly gated | native: ui gating matches matrix (DOM assertions over options/popup) |

## Build order
1. Reuse invariant + mid-session adopt, tests 1-3 - done when: suite green x2.
2. COMPATIBILITY.md authored from live code + options audit, test 4 - done when: every pair has a verdict; UI gaps fixed or ticketed in the same build.
3. README/FAQ + locale hint strings + dogfood protocol handed to Michael - done when: store-texts sweep clean.

## Risks and open questions
- If Michael's dogfood shows his Chrome build auto-saves extension-created groups, prevention wording shifts from "do not Save" to "turn off Saved tab groups sync / flags" - FAQ has both branches ready; code path unchanged either way (churn minimization helps both worlds).
- Residual truth: existing chip debt only clears by hand once; we cannot delete chips for him. Stated plainly, not hidden.
