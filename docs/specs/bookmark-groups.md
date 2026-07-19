# Spec: Bookmark groups - folders as durable group definitions (opt-in)

Class: feature · Advisor score: 7.5/10 - durable named groups + free cross-browser sync via native bookmarks, replacing the storage.sync "tab sets" candidate from the project passport; scored below the batch peers because it adds a permission and a second durable store, both contained (opt-in, explicit-actions-only) · Approval: pending (batch 2026-07-19)

## Goal block
- What must exist: an OPT-IN feature where a bookmark folder defines a group. One-shot "Save group to bookmarks" snapshots a live group into a folder; "Open from bookmarks" materializes a folder as a live group (dedup-aware); "Update folder from group" pushes the live state back. Closing tabs, dissolving groups, archiving, dedup - NEVER touch bookmarks. Definitions travel between browsers via native bookmark sync.
- How we verify: e2e - open-from-folder materializes a group adopting already-open tabs; closing every tab of that group leaves the folder byte-identical; the toggle off means zero `chrome.bookmarks` calls.
- Do not touch: bookmark folders outside the "TrueTabs" root; any bookmark on any automatic path (only the two explicit actions write; nothing ever deletes a folder); required manifest permissions (bookmarks goes to `optional_permissions`).
- Stop/pause when: any design pressure toward live two-way sync (explicitly rejected by the customer's own trap: "удаляем вкладку - удаляем букмарк = тупо"); any need to write outside the root folder.

## Question round
| Question | Customer answer |
|---|---|
| Model: folder=definition vs snapshot-only vs full two-way? | "Вариант 1 (папка = определение), но опциональная фишка, хорошо продумана, сочетается со всеми режимами" (2026-07-19) |
| Root folder location/name | PM decision, flagged: constant "TrueTabs" folder under "Other bookmarks" (stable across locales so sync matches between differently-localized browsers) |

## Scope and non-goals
- In scope: master toggle (default OFF); runtime `bookmarks` permission request on enable; snapshot action; folder list in popup; open/materialize; explicit push-back; interaction matrix below enforced in code; docs + PRIVACY + CWS optional-permission justification.
- Non-goals: live mirroring in either direction (no `bookmarks.onChanged` listeners in v1 - zero background bookmark processing); auto-snapshot on any schedule; deleting/renaming folders from the extension (management stays in Chrome's bookmark manager, which is already a good editor); nested folder structures (one level: root - group folders - bookmarks); syncing group COLOR/collapse state (bookmarks cannot carry it losslessly; color re-derives from title hash, collapse defaults).

## Design
Permission: manifest gains `optional_permissions: ["bookmarks"]`. Enabling the toggle in options calls `chrome.permissions.request({permissions:["bookmarks"]})` inside the click gesture; denial reverts the toggle with a plain message. Disabling the toggle calls `permissions.remove` (mirror of the BYOK origin-release pattern; lesson: grants without a release path). Every bookmark call sits behind `hasBookmarks()` (permission + toggle); toggle off = feature surfaces hidden, zero API calls.

Store layout: root folder "TrueTabs" under Other Bookmarks, found BY NAME each time (bookmark ids are per-device; sync maps them - never persist ids, resolve by path). Child folder = definition: folder title = group title; bookmarks = members (title + URL, folder order = tab order). Missing root = created on first snapshot/push only (opening the feature UI alone never writes).

Actions (all explicit, all engine-serialized):
1. Snapshot ("Save group to bookmarks", popup group row, also on Other? - no: Other is parking, not a decision; row action hidden on Other): create-or-replace folder `TrueTabs/<title>`: clear its bookmarks, write current members in tab order. Existing folder with different content - confirm dialog naming the folder ("Replace 12 bookmarks in 'Research'?"). No undo in v1 (explicit confirmed click; bookmark manager has its own trash on some platforms - not our contract).
2. Open ("Open from bookmarks": popup section listing `TrueTabs/*` folders with counts, read on popup open - one `getSubTree`, read-only): materialize into the CURRENT window: for each bookmark resolve `dupeKey`; if a tab with that key is already open in the window - adopt it into the group (dedup logic reused, no duplicate tab created); else `tabs.create` with `selfCreated` marker (api-nav-commits-as-link lesson - our own tabs must not be eaten by dedup/automation), batched with progress like smart-apply, mass-create budgeted through the existing create ledger with an explicit-command allowance raise (cap 30 per open; folders bigger than 30 open the first 30 and toast the cut - no silent truncation).
   The materialized group is OURS: registered with a signature (kind "bookmark", title+color), so restart re-adoption works (ownership-must-survive-restart lesson).
3. Push ("Update folder from group", row action on bookmark-born groups): replace folder content with live members (same confirm-on-divergence rule as snapshot).

Never-write guarantee (the customer's trap, enforced structurally): the ONLY two call sites that write bookmarks are the snapshot and push handlers, both `ui:*` ops requiring a click. Close/archive/dedup/dissolve/re-home paths have no bookmark code at all - the guarantee is the absence of call sites, verifiable by grep in review (same style as the permissions audit).

Working-set divergence is a FEATURE: the folder is the recipe, the group is tonight's cooking. Popup shows a subtle dot on bookmark-born groups whose membership diverged from the folder (cheap set-compare on popup paint, read-only) - the user decides to push, re-open, or ignore.

## Interaction matrix
| Existing feature | Intersection | Resolution |
|---|---|---|
| Dedup | Opening a folder whose URL is already open | Adoption instead of creation (reuses dupeKey); two folders containing the same URL: second open adopts the tab out of the first group - last explicit command wins (consistent with "flags protect from automation, not clicks") |
| Directed dedup (typed into existing tab) | Survivor inherits victim's group | Unchanged; if the victim was in a bookmark-born group the survivor joins it - folder untouched |
| Archive / stale | Members of bookmark-born groups age out | Archived per normal rules; folder keeps the definition, so "Open" restores tomorrow - this is the designed durability story; FAQ says it |
| Auto-grouping (site mode) | New tab of a domain that also lives in a folder | Folders do not route; only rules route. A bookmark-born group holds only what Open put there plus what rules/user add; no domain claim |
| My groups (rules) | Rule title collides with folder title | One live group per title: rule routing and folder Open share it; rule keeps routing new tabs into it; push writes the union the user sees. Precedence documented: живое членство = last explicit action; folder = only what Open/push touch |
| Smart re-shuffle (`smartRegroupOurs`) | AI dissolving definitions | Bookmark-born groups excluded from smart re-shuffle (like rule groups: they are decisions, not automation output) |
| Re-home (nav-rehome spec) | Typed nav out of a bookmark-born group | Allowed (working set diverges) unless the group is in `protectedGroups`; folder never changes |
| Other | Folder named like Other's localized name | Root children with Other's reserved names are skipped with a toast; snapshot action absent on Other row |
| Layout engine | Group order/sort | Bookmark-born groups are ordinary members of the block; no special casing |
| Protected groups | Lock a bookmark-born group | Composes: protection guards membership, folder stays the recipe |
| TruePin locked tabs (family-interop) | Folder open adopting a locked tab | Locked ids excluded from adoption and creation-dedup (zone contract); the URL opens as a fresh tab instead |
| Native saved groups (native-groups-compat) | Saving our groups in Chrome duplicates chips | FAQ: bookmark groups make Chrome's Save group redundant for TrueTabs users - one durable story, fewer chips |
| Settings export (settings-platform) | Folders in the export file? | No - bookmarks are already durable and synced by Chrome; export covers settings only; the toggle itself exports |
| Sync (Chrome bookmarks) | Simultaneous edits on two machines | Chrome's bookmark sync merges; our reads are by-name and tolerate duplicates (first match wins, duplicate-named folders shown suffixed in the list) |

## Data deltas
- `settings.bookmarkGroups: false` (sync).
- `ourGroups` registry entries gain kind `"bookmark"` (session; signatures already persist shape-agnostic).
- Manifest: `optional_permissions: ["bookmarks"]`.
- No stored bookmark ids anywhere (by-name resolution only).

## Edge cases (with resolutions)
- Root folder deleted by the user mid-session: next explicit action recreates it; open-list shows empty - correct, definitions are gone.
- Folder renamed in bookmark manager while its group is open: live group keeps its title (disown rules unchanged); the list shows the new folder as a separate entry; push from the old group targets a folder named by the GROUP's title (create-or-replace) - deterministic, documented.
- Bookmark with a non-web URL (`chrome://`, `file://`): materialized as a tab (dupeKey covers these schemes since v1.11); nothing special.
- Duplicate URLs inside one folder: second one adopts the same tab - net effect one tab; push writes the deduped live order (folder self-heals on next push, never automatically).
- Open into a window already containing the same-titled group: reuse that group (add missing members) instead of a twin - one live group per title per window (churn minimization, feeds native-groups-compat).
- Permission revoked externally (chrome://extensions): `hasBookmarks()` false - surfaces hide, toggle shows "permission needed" state on next options paint.
- 100-bookmark folder: cap 30 with toast (no silent cap - lesson: log what was dropped).
- Incognito: feature absent (extension not enabled in incognito by default; if enabled, bookmark reads work but materialization follows normal incognito tab rules - no special code, documented).

## Behavior-test table
| Behavior | Test name |
|---|---|
| Snapshot creates folder with members in tab order | bmk: snapshot writes folder |
| Snapshot onto existing folder replaces after confirm | bmk: snapshot replaces with confirm |
| Open materializes group, adopting already-open tabs | bmk: open adopts and creates |
| Open reuses same-titled live group instead of twin | bmk: open reuses live group |
| Closing all tabs of a bookmark-born group leaves folder intact | bmk: close never touches folder |
| Dissolve/archive/dedup paths make zero bookmarks calls | bmk: automation writes nothing (API spy) |
| Toggle off hides surfaces and makes zero bookmarks calls | bmk: disabled means silent |
| Divergence dot appears when membership differs from folder | bmk: divergence indicator |
| Push replaces folder with live membership | bmk: push updates folder |
| Cap: 31st bookmark not opened, toast shown | bmk: open caps at 30 with notice |
| Smart re-shuffle never dissolves bookmark-born groups | bmk: smart excludes bookmark groups |

Note on permission in e2e: `chrome.permissions.request` needs a user gesture, unavailable to the harness; tests run with a `__ttMockPermission` hook forcing `hasBookmarks()` truthy (same pattern as `__ttSetMockAi`); the real request flow is a dogfood checklist item.

## Build order
1. Toggle + permission request/release + `hasBookmarks()` gate + mock hook, test 7 - done when: suite green x2.
2. Snapshot + root resolution by name, tests 1-2 - done when: suite green x2.
3. Open/materialize with adoption, reuse, cap, registry kind, tests 3-4, 10 - done when: suite green x2.
4. Push + divergence dot, tests 8-9 - done when: suite green x2.
5. Never-write guarantee tests 5-6 + smart exclusion test 11 - done when: suite green x2.
6. Docs: README section, FAQ (incl. the saved-chips angle), PRIVACY (bookmarks only on explicit actions, never deleted), STORE_LISTING optional-permission justification, 8-locale strings - done when: parity + store-texts sweep clean; CWS justification text ready for the dashboard field.

## Risks and open questions
- Pre-mortem (top 2): (1) users read "Save group to bookmarks" as continuous sync and blame us when the folder does not follow closes - countered by the divergence dot + explicit verbs ("Update folder from group") + FAQ; (2) optional-permission prompt scares users - countered by requesting only on enable with a one-line explainer above the toggle.
- Folder order vs group sort: push writes TAB order (what you see); if group sort is alphabetical the folder inherits it - accepted, order is cosmetic in the recipe.
- Open question deferred to dogfood: whether the popup folder list should also offer "open in new window" (cheap add later; not in v1).
