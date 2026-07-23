# Spec: application flows are not duplicates + the popup's automation shelf

Class: bugfix (1) + feature (3, 4) + parity port (2) · Advisor score: 8/10 - the flow bug is a trust-level defect (a customer's button "stops working" and the extension looks broken, with no way to tell why), and the fix is a single invariant at one choke point rather than a per-site patch; the UI items are small, already proven in TruePin, and remove the two rough edges the customer named · Approval: Michael, 2026-07-22 (four-point request in chat; answers to the two open questions recorded in the question round)

## Goal block
- What must exist: (1) a tab an application opens INTO ITS OWN SITE survives every automatic close, and the same holds for a blank a page opened and has not filled yet; (2) the options page states what Chrome's saved-group chips are, why they multiply and how to clear them, since no API can touch them; (3) the popup scroll region and the options action row match TruePin's shipped treatment; (4) the catch-all and groups-at-front switches live in the popup, where their effect is visible.
- How we verify: e2e - an app-opened tab on an already-open url lives while a user-opened duplicate still collapses; a page-opened blank survives a collapse trigger and is swept once its flight window passes; the popup writes both new switches through and dims the routing child with its parent; the options row holds exactly three buttons, centered, with one toast and no per-button notes. Plus a standing repro script driving REAL window.open flows.
- Do not touch: the manual Sweep (an explicit command is the user speaking - it still collects app-flow duplicates); cross-site dedup (that is where real duplicates come from); the chips themselves (no API exists - verified 2026-07-19, native-groups-compat).
- Stop/pause when: a guard would need to know which script opened a tab (Chrome does not report it - probed below), or when a fix starts enumerating sites (chatgpt.com et al) instead of stating a rule.

## Question round
| Question | Customer answer (2026-07-22) |
|---|---|
| "Dead groups" - the coloured chips on the bookmarks bar, or groups inside the window? | Chrome's saved-group chips. |
| Which automation switches belong in the popup? | "Other" + groups-at-front, plus automatic dedup as its own yes/no. "Только все аккуратно и красиво." |

Automatic dedup already had its own popup switch (`Duplicate prevention`); it stays exactly one switch, now sitting above the two new ones in the same shelf.

## Platform facts (probed on Chrome for Testing, 2026-07-22)
- `window.open`, a click on `<a target=_blank>` and `chrome.tabs.create({url})` all commit as `transitionType: "link"` with no qualifiers. Chrome does NOT distinguish a script-opened tab from a hand-opened one.
- A tab opened by a page carries `openerTabId`; `tabs.create({url})` from an extension does not. The opener id survives into the pre-commit path (`webNavigation.onBeforeNavigate` + `tabs.get`).
- Therefore the ONLY honest signal available is the opener's own site.

## The defect (reproduced, not deduced)
`test/repro-appflow.mjs`, run against the live unpacked build:
- A page opens a tab whose first url is already open elsewhere - the tab was closed before the page ran (`dedup pre-commit ... -> kept N` in the trace). The customer's case: ChatGPT "branch in new chat" opens `/c/WEB:<uuid>` and swaps the url once the branch exists.
- A blank opened by a page (the popup-blocker dance: `window.open()` on the click, url when the request returns) is closed by the blank collapse: `window.open` takes focus, the user goes back to the original tab, and the "seen and left" rule kills it at any age.
- Mirror case found while testing: when the parent's own commit job lands after the child exists, the parent became the victim and the child the survivor - the extension closed the page that opened the flow.

## Design
One invariant, three enforcement points, no site list:

1. `isAppOwnFlow(tab, url)` - the tab has an `openerTabId` and the opener's registrable domain equals the destination's. Checked inside `dedupOnCommit`, which is the single choke point for both the pre-commit and the commit path. Cross-site opens keep full dedup.
2. Candidate filter: a tab THIS tab opened is never a survivor candidate, so a child can never justify closing its parent.
3. `blankInFlight(tab)` - a blank with an opener, younger than `BLANK_FLIGHT_MS` (30s), is immune to the collapse trigger, the tick sweep and the manual sweep, focus or no focus. Past the window the ordinary rules resume: an app that abandoned a blank leaves litter like anyone else.

UI:
4. Popup scroll: native bar hidden, thin overlay thumb drawn on top (TruePin v3.15.2 port) - full-width symmetric list, no lane stolen under macOS "always show scrollbars", nothing shifts when scrolling starts.
5. Options: `Copy diagnostics / Export settings / Import from file` in one centered row under the card; every transient confirmation is one fixed toast (TruePin v3.15.4-5 port). The per-button notes and their reserved boxes are gone.
6. Popup automation shelf: `Collect the rest into "Other"` as grouping's second child (dims with the parent, like the AI switch) and `Keep groups at the front` as an independent layout switch. Both reuse the existing locale keys - one string, one meaning, eight languages already translated.
7. Options: a `Chrome's saved groups` section - what the chips are, why they multiply (per window, per device, no API), how to clear them (right-click - Delete group), how to stop making more, and the bookmark folders as the durable alternative.

## Interaction matrix
| Existing feature | Intersection | Resolution |
|---|---|---|
| Pre-commit dedup | The flow tab dies before the app runs | Guarded by the same check as the commit path (one choke point) |
| Manual Sweep (duplicates) | Should an explicit command spare app flows? | No for duplicates (the user is speaking), yes for a blank in flight (never shoot a navigation) |
| Blank collapse / tick sweep | Page-opened blanks read as abandoned scratch | Flight window, then ordinary rules |
| Strike ledger | Re-opening a killed flow used to strike the key | Unchanged; with the flow no longer killed, the ledger simply never sees it |
| TruePin family zone | Locked tabs already immune | No overlap |
| Popup switches vs options | Same settings in two places | Both write through `ui:setSetting`; the engine owns the pairing rules (`pairGrouping`) |

## Behavior-test table
| Behavior | Test name |
|---|---|
| An app's own new tab is never an automatic dedup victim; Sweep still collects it | app flow: a site's own new tab is never an automatic dedup victim |
| A cross-site opener does not shield a duplicate | app flow: a cross-site opener does not shield a duplicate |
| A page-opened blank survives its flight window, then is swept | app flow: a page-opened blank rides out its flight window, then ages out |
| Popup writes both new switches; the routing child dims with the parent | popup: the catch-all and groups-at-front switches write through, and dim honestly |
| The popup list keeps full width; no native lane | popup: the scroll region carries its own overlay bar, never a reserved lane |
| One centered action row, one toast, no reserved notes, chips explainer present | options page: one centered action row, one toast, no reserved notes |

## Edge cases (with resolutions)
- Opener closed before the child navigates: `tabs.get` returns nothing, the tab is treated as ordinary - dedup applies (no opener, no claim).
- Same-site duplicate opened by hand from the site itself (Cmd+click a link to a page already open on that site): no longer auto-collapsed. Accepted cost of the rule, stated in the FAQ; the popup's duplicate counter still shows it and Sweep collects it.
- Redirect chains landing on an open url: unchanged - redirect commits were already excluded from classification (v1.12 lesson, TruePin's Meet bug).
- An app that opens a blank and abandons it: swept after 30s, same as any other blank.

## Data deltas
n/a - no settings, no schema. Four new locale strings in eight languages (`optChipsHeader`, `optChipsHint`, `optChipsHow`, `optDataWhere`).
