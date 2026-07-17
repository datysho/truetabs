I have everything I need: TruePin's full architecture (background.js 2083 lines, harness, popup/options patterns, i18n, packaging, store kit). Now I'll produce the TrueTabs implementation spec.

---

# TrueTabs v1.0 — Implementation Spec

> **Shipped evolution (this spec is the v1.0 baseline; the code is canon):**
> v1.1 popup groups panel, organize undo, sort-on-organize, BYOK autosave, window-scope dedup default;
> v1.2 group words+grip, groups-on-top, smart "Other", regroup-ours option, family options header;
> v1.3 smart prompt v2 with cross-batch theme merge, live progress, quality gate (site-fallback tail);
> v1.4 settings normalize+migrate on every read (`normalizeSettings`), crash-proof two-stage page boot,
> `autoGroup: off|site|topic` replaces `groupAuto`+`smartAutoAssign`, `sortGroups`+`sortTabs` (with `live`
> MRU dwell mode) replace `sortMode`, custom rule groups (`customGroups` sync key: domains + AI hint,
> routed before all automation), smart v3 (rule pre-pass, batches of 15 applied incrementally, streamed
> per-tab progress on Nano, refinement pass for leftovers), close-vs-pullout fix (a closed grouped tab
> never strikes), popup live drag-reorder via `ui:groupReorder`.
> v1.5 pre-commit dedup (`onBeforeNavigate` fast path for fresh tabs, strike-aware, prerender-guarded),
> attention-wins merge on address/bookmark re-navigation of an existing tab (`mergeIntoNavigated`:
> archive-first, victim's OUR-group inherited) + `rehomeNavigated` (rule > victim group > domain group >
> release from a mismatched site group), popup hero relayout (labels above centered numbers).
> v1.6 instant state: shared settings schema (`settings-schema.js`, importScripts + page script tag),
> pages paint REAL values straight from storage before the first frame (anti-FOUC reveal), engine-down
> detection via off-queue `ui:ping`; `ui:getState`/`ui:smartStatus` moved off the mutation queue and made
> cheap (maintained `archiveCount`, batched tab-state reads in archiveCandidates, 60s availability cache).

Sibling of TruePin (reference implementation: `/Users/datysho/Projects/truepin`). Recommended repo root: `/Users/datysho/Projects/truetabs`. Plain JS, no build step, MV3 classic service worker.

---

## 1. Repo layout (file-by-file)

```
truetabs/
├── extension/                     # shipped verbatim, no build step
│   ├── manifest.json              # MV3, dev key, 7 permissions, action popup, options open_in_tab
│   ├── background.js              # single service worker: ALL logic (queue, dedup, archive, group, merge, breaker, ui:* backend)
│   ├── i18n.js                    # ttI18n runtime (copy of tpI18n, renamed): fetch _locales, override, PluralRules
│   ├── config.js                  # deploy constants: TT_PAYPAL_URL, TT_CWS_ID, TT_REVIEW_URL (derived), TT_GITHUB_URL; empty = hidden
│   ├── popup.html                 # 344px dashboard: tokens inline, counts card, 4 actions, 3 pillar switches, action bar
│   ├── popup.js                   # thin renderer: ui:getState -> render; sync-dispatch clicks (popup-teardown rule)
│   ├── options.html               # settings card: dedup / archive / groups / appearance / language + diagnostics
│   ├── options.js                 # DEFAULTS+FIELDS auto-save-on-change, applyTheme, allowlist parsing, diag copy
│   ├── archive.html               # Archive page (opens in a tab): search, day groups, restore/delete, tokens inline
│   ├── archive.js                 # thin renderer over ui:archive:* messages; _favicon rendering; confirm >25 restores
│   ├── icons/                     # tt-16/32/48/128.png (+ mono variants for future; single action set in v1)
│   └── _locales/{en,ru,uk,de,fr,es,pt,zh_CN}/messages.json   # ~95 keys each, appDesc for manifest
├── test/
│   ├── package.json               # private, type module, puppeteer ^24, scripts: test
│   └── e2e.mjs                    # hand-rolled harness: test()/step()/assert()/waitFor()/swEval(), local http fixture server, HEADFUL=1, SW error collector, zero-lastError finale
├── store/
│   └── screenshots/               # store-popup-{light,dark}.png, store-archive-{light,dark}.png, store-options-{light,dark}.png
├── package.sh                     # zip builder: version from manifest, strip dev key, one zip in dist/, post-zip guard
├── README.md                      # landing: badges, light/dark hero, feature table, collapsible under-the-hood, Honest limits, dev/test, Support
├── STORE_LISTING.md               # CWS copy, per-permission justifications, privacy declarations, submission checklist
├── PRIVACY.md                     # "everything stays in your browser": what is stored (urls/titles in local archive), per-permission why
├── SUPPORTERS.md                  # donor credits
├── LICENSE                        # MIT
├── .github/
│   ├── FUNDING.yml                # custom PayPal donate URL
│   ├── ISSUE_TEMPLATE/bug_report.yml
│   ├── almost.md                  # PayPal cancel-URL easter egg (TruePin pattern)
│   └── thanks.md                  # post-donation thanks
└── .gitignore                     # .DS_Store, node_modules/, .keys/, dist/
```

Git conventions: English commits, releases `vX.Y.Z: imperative summary`, scope prefixes (`readme:`, `store:`, `options:`), no bodies.

---

## 2. manifest.json draft

```json
{
  "manifest_version": 3,
  "name": "TrueTabs",
  "description": "__MSG_appDesc__",
  "default_locale": "en",
  "version": "1.0.0",
  "minimum_chrome_version": "121",
  "key": "<NEW dev key, distinct from TruePin's - stable unpacked id; stripped by package.sh>",
  "homepage_url": "https://github.com/datysho/truetabs",
  "permissions": [
    "tabs",
    "tabGroups",
    "storage",
    "alarms",
    "notifications",
    "favicon",
    "webNavigation"
  ],
  "background": { "service_worker": "background.js" },
  "action": {
    "default_icon": { "16": "icons/tt-16.png", "32": "icons/tt-32.png", "48": "icons/tt-48.png", "128": "icons/tt-128.png" },
    "default_title": "TrueTabs",
    "default_popup": "popup.html"
  },
  "options_ui": { "page": "options.html", "open_in_tab": true },
  "icons": { "16": "icons/tt-16.png", "32": "icons/tt-32.png", "48": "icons/tt-48.png", "128": "icons/tt-128.png" }
}
```

Decisions:
- **webNavigation is IN (7th permission).** The fixed product spec requires "never dedup tabs mid-redirect-chain (client_redirect/server_redirect qualifiers)" and "never dedup POST results" — both are only observable via `webNavigation.onCommitted` `transitionType`/`transitionQualifiers`; `tabs.onUpdated` has no navigation classification. CWS-wise it is free: `webNavigation` sits in the same "Read your browsing history" warning bucket as `tabs`, so the install prompt is unchanged. TruePin already ships it with an approved justification to copy. (Flagged in section 9 as the one deviation from the six-permission list.)
- NO `host_permissions`, NO content scripts, NO `scripting`, NO `sessions` (restore is from our own archive via `tabs.create`).
- `alarms`: no manifest section needed; one alarm `"tt-tick"`, `periodInMinutes: 1`, ensured via `alarms.get -> create` at SW top level (get-then-create so each SW wake doesn't reset the phase). Alarms survive SW suspension.
- `minimum_chrome_version: 121` — `tab.lastAccessed` ships on `chrome.tabs.Tab` from 121.
- v1.1 hooks designed-for, not shipped: `"omnibox": {"keyword": "tt"}` and `"commands"` are permission-warning-free manifest additions later; reading-list would add a `readingList` permission (deferred).

---

## 3. background.js module map, data structures, event wiring

### 3.1 Banner + section map (TruePin banner style)

```
// TrueTabs - service worker. An invisible tab-lifecycle butler:
//   1) a URL you already have open never opens twice (focus + close the new one),
//   2) tabs untouched for X hours are archived (saved locally, closed, undoable),
//   3) tabs are grouped by site with stable colors, stale groups collapse,
//   4) one popup with counts and one-click actions.
// Safety canon (TruePin lineage): serialized mutation queue; settle-then-act
// cold start; selfClosed markers; close/create circuit breakers with declared
// allowances; two-strikes anti-fight ledger; pinned tabs are never closed,
// moved, grouped or archived; foreign (user/other-extension) tab groups are
// never modified. Persistent truth: settings (sync), archive (local);
// per-tab/per-group ephemera in storage.session, rebuilt on restart.

importScripts("i18n.js");
importScripts("config.js");

// --- constants & defaults ------------------------------------------------
// --- serialized mutation queue + diagnostics (__ttDiag, traceDiag) --------
// --- settings (getSettings, DEFAULTS) + i18n gate (ensureI18n) ------------
// --- quiet/checked lastError helpers --------------------------------------
// --- url identity: normalizeUrl, dupeKey, registrableDomain, cleanLabel ---
// --- per-tab session state (t<id> records) --------------------------------
// --- settle gate (settled flag, calm-poll bootstrap) -----------------------
// --- selfClosed markers + selfGroupOps markers (single RMW serializer) ----
// --- circuit breakers: closeTabsGuarded, guardedCreate, allowances, pause -
// --- two-strikes ledger (strike, isStruck, classes: dedup/group/collapse/archive)
// --- dedup engine (classifyCommit, onCommitted flow, sweepDuplicates) -----
// --- archive store (RMW single key, cap, TTL, counters) --------------------
// --- stale scan + auto-discard tier + batch archive + undo -----------------
// --- grouping engine (groupOnCommit, organizeNow, ourGroups registry, sig re-adoption, collapse scan)
// --- merge windows ----------------------------------------------------------
// --- alarm tick -------------------------------------------------------------
// --- notifications (batch undo buttons, breaker) ----------------------------
// --- tab/window/group event listeners (top-level, synchronous registration) -
// --- messages: ui:* backend (handleUi) ---------------------------------------
// --- test hooks on globalThis -------------------------------------------------
```

### 3.2 Settings schema (storage.sync, key `settings`) — every default

```js
const DEFAULTS = {
  // pillar 1 - duplicates
  dedupAuto: true,            // auto close-into-focus on duplicate open
  dedupScope: "all",          // "all" | "window" - where to look for the existing copy
  // pillar 2 - archive
  archiveAfter: "24h",        // "6h" | "12h" | "24h" | "3d" | "7d" | "off"
  archiveTtl: "30d",          // "7d" | "30d" | "90d" | "forever"
  archiveForeignGroups: false,// false = never archive tabs inside user-made groups (see 6. decisions)
  archiveNotify: true,        // notification with Undo per auto-batch
  discardStale: false,        // intermediate tier: chrome.tabs.discard at threshold/2 (off; Chrome has Memory Saver)
  archiveAllowlist: [         // domains never auto-archived (camera/mic undetectable via tabs API - seed call sites)
    "meet.google.com", "zoom.us", "teams.microsoft.com"
  ],
  // pillar 3 - groups
  groupAuto: true,            // group new tabs on first commit (gentle: never re-shuffles old tabs)
  groupCollapseAfter: "10m",  // "off" | "5m" | "10m" | "30m"
  // shell
  theme: "auto",              // "auto" | "light" | "dark"
  language: "auto",
};
```

Thresholds map in code: `{"6h":216e5,...}`; `archiveAfterMs(settings)`, `collapseAfterMs(settings)` helpers.

### 3.3 Named constants

```js
const TICK_ALARM = "tt-tick";            // 1 min periodic
const SETTLE_CALM_POLLS = 3;             // tabs.length stable across 3 polls...
const SETTLE_POLL_MS = 300;              // ...300ms apart, max 40 attempts (TruePin rebuildMirror)
const SETTLE_MIN_MS = 15_000;            // hard floor after SW cold start before any automatic action
const CLOSE_WINDOW_MS = 60_000;          // close breaker sliding window
const CLOSE_BURST = 25;                  // max automatic closes per sliding minute (base budget)
const CREATE_WINDOW_MS = 60_000;
const CREATE_BURST = 25;                 // restore/undo creations cap (TruePin guardedCreate mirror)
const PAUSE_ON_TRIP_MS = 10 * 60_000;    // breaker trip pauses ALL automation
const SELF_CLOSED_TTL_MS = 60_000;
const STRIKE_WINDOW_MS = 60_000;         // counteraction within this window after our act = a strike
const STRIKE_LIMIT = 2;                  // two strikes -> class+key retired for the session
const FRESH_COMMIT_LIMIT = 1;            // dedup victims only on their FIRST committed real page
const ARCHIVE_CAP = 5000;                // FIFO
const ARCHIVE_BATCH_MAX = 20;            // per tick - gradual, keeps notifications sane
const TRACKING_PARAMS = /^(utm_|__hs|_hs)/;                       // prefix match
const TRACKING_EXACT = new Set(["fbclid","gclid","gclsrc","dclid","msclkid","yclid","twclid","ttclid","igshid","mc_cid","mc_eid","vero_id","wickedid","oly_enc_id","oly_anon_id","s_kwcid","ref_src"]);
const GROUP_COLORS = ["grey","blue","red","yellow","green","pink","purple","cyan","orange"]; // chrome's 9
```

### 3.4 storage.session keys (ephemeral truth, survives SW suspend, dies with browser session)

| key | shape | purpose |
|---|---|---|
| `settled` | `bool` | settle gate passed |
| `sessionStartedAt` | `ts` | cold-start time (SETTLE_MIN_MS floor) |
| `t<tabId>` | `{firstSeenAt, committedCount, url, key, domain, groupedByUs: gid\|null, ungroupedByUser: bool}` | per-tab ephemera |
| `ourGroups` | `{[groupId]: {domain, title, color, windowId, createdAt, lastTouchedAt, collapsedByUs}}` | groups WE created; anything not here is foreign and untouchable |
| `strikes` | `{["<class>:<key>"]: {count, lastAt}}` | two-strikes ledger (classes: `dedup`, `group`, `collapse`, `archive`) |
| `dedupRecent` | `{[dupeKey]: {closedAt, survivorId}}` | strike detection: same key re-opened soon after our close |
| `closeLedger` / `createLedger` | `[ts,...]` | breaker sliding windows (in session so a crashing SW can't reset its own budget) |
| `selfClosed` | `{[tabId]: ts}` | our closes, so onRemoved doesn't misread them |
| `selfGroupOps` | `{[groupId]: {op, ts}}` | our group mutations, so tabGroups.onUpdated doesn't count them as user counteraction |
| `pausedUntil` | `ts` | breaker trip: all automation stops |
| `lastPruneAt` | `ts` | daily TTL prune gate |

### 3.5 storage.local keys (persistent canon)

| key | shape |
|---|---|
| `archive` | `{entries: ArchiveEntry[], updatedAt}` — newest first, hard cap 5000 FIFO. Single key, single-writer RMW through the queue (selfclosed-rmw-race lesson). |
| `lastBatch` | `{batchId, at, count}` — survives restart so "Undo last batch" works after a crash |
| `counters` | `{date:"2026-07-16", archivedToday, dedupedToday, sweptToday}` — reset when date changes |
| `ourGroupSigs` | `[{domain, title, color, lastSeenAt}]` — restart re-adoption signatures (group ids do not survive restarts) |

```ts
ArchiveEntry = {
  id: string,          // `${archivedAt}-${rand4}`
  url: string,         // http(s) only
  title: string,
  favUrl: string|null, // tab.favIconUrl at archive time (product-spec fixed; page renders /_favicon/ first)
  domain: string,      // registrableDomain(url) - for search chips
  groupTitle: string|null, groupColor: string|null,  // group context at archive time (ours or foreign)
  winHint: number,     // windowId at archive time (restore-to-same-window best effort)
  archivedAt: ts,
  batchId: string,     // groups a batch for undo
  reason: "auto" | "manual" | "dupe-sweep"
}
```
Size budget: ~250–350 B/entry × 5000 ≈ 1.5 MB of the 10 MB local quota. Quota-error fallback: drop oldest 500, retry once, trace.

### 3.6 Event subscription map (all listeners top-level, synchronous; handlers `enqueue()`d)

| event | job |
|---|---|
| `runtime.onInstalled` / `runtime.onStartup` | begin settle bootstrap; ensure alarm |
| `webNavigation.onCommitted` | THE main trigger: per-tab bookkeeping (`committedCount++`, url/key/domain), then dedup flow, then group-on-first-commit flow, then dedupRecent strike check |
| `tabs.onCreated` | record `t<id>` firstSeen (no action; ephemeral urls ignored) |
| `tabs.onUpdated` (`groupId`, `url`, `pinned`) | groupId change: detect user pull-out of our group (strike + `ungroupedByUser`); keep `t<id>` current |
| `tabs.onActivated` | touch `ourGroups[gid].lastTouchedAt` if the tab is in our group (lastAccessed itself comes free from Chrome) |
| `tabs.onRemoved` | `wasSelfClosed?` -> bookkeeping only; else drop `t<id>`; if the tab was in our group and group emptied, Chrome removes the group (handled by tabGroups.onRemoved) |
| `tabs.onReplaced` | carry `t<id>` state to the new id (discard/prerender swaps) |
| `tabs.onAttached` | update `t<id>`/registry windowId (drag between windows) |
| `tabGroups.onUpdated` | ours + not in `selfGroupOps`: user expanded (collapse strike + touch) or user retitled/recolored (DISOWN: remove from ourGroups + sigs — it is theirs now) |
| `tabGroups.onRemoved` | drop from `ourGroups`; refresh `ourGroupSigs` |
| `alarms.onAlarm` (`tt-tick`) | stale scan -> discard tier -> archive batch; collapse scan; daily TTL prune; counters date roll |
| `notifications.onButtonClicked` / `onClicked` (`tt-batch-*`) | undo last batch |
| `runtime.onMessage` (`ui:*`) | `enqueue(handleUi)` + `return true` |
| `storage.onChanged` (sync `settings`) | reset i18n cache; recompute nothing destructive (no convergence needed — we have no mirror) |

Core plumbing copied from TruePin nearly verbatim: `enqueue`/`__ttDiag`/`traceDiag(40)`, `quiet`/`checked`, `withSelfClosed` serializer, `getSettings`, `ensureI18n`, popup teardown rules, test hooks style.

---

## 4. Algorithms (pseudocode)

### 4.1 URL identity

```
normalizeUrl(raw) -> string | null:
  u = new URL(raw)  (throw -> null)
  if u.protocol not in {http:, https:} -> null          // chrome://, about:, file://, extension: never participate
  if isEphemeralUrl(raw) -> null                        // about:blank|newtab family (copy TruePin's matcher)
  host = u.hostname.toLowerCase()                       // host case normalize; www. is KEPT (conservative)
  port = u.port in {"", "80" for http, "443" for https} ? "" : ":" + u.port
  path = u.pathname; if path.length > 1 and endsWith("/") -> strip trailing "/"
  params = [ (k,v) for (k,v) of u.searchParams
             if not TRACKING_PARAMS.test(k) and k not in TRACKING_EXACT ]
  params.sort by (k, then v)                            // ?a=1&b=2 == ?b=2&a=1; VALUES KEPT (youtube ?v=)
  hash = (u.hash starts with "#/" or "#!") ? u.hash : ""  // SPA hash-routing kept, anchors stripped
  return `${u.protocol}//${host}${port}${path}` + (params ? "?"+join : "") + hash

dupeKey(url)          = normalizeUrl(url)               // null => never dedups
registrableDomain(url)= TruePin's eTLD+1 approximation (last 2 labels, 3 when 2nd-to-last in KNOWN_SLD
                        {co,com,net,org,gov,ac,edu}; IP literals whole; strips leading www.)
cleanLabel(domain)    = first label of registrableDomain, first letter uppercased  // "github.com" -> "Github"
colorFor(domain)      = GROUP_COLORS[ fnv1a32(domain) % 9 ]                        // stable across sessions/machines
```

Decision — group title case: spec text says "capitalized", its example says "github"; going with **capitalized** ("Github") — reads as a label, not a hostname fragment; one-line change if reverted.

### 4.2 Dedup flow (webNavigation.onCommitted)

```
classifyCommit(details) -> "address" | "link" | "bookmark" | null:
  if details.frameId !== 0 -> null
  if details.documentLifecycle && != "active" -> null            // prerender
  q = details.transitionQualifiers || []
  if q includes client_redirect or server_redirect -> null       // mid/landing of redirect chain: hands off
  if q includes forward_back -> null                             // history moves never dedup
  t = details.transitionType
  if t == "reload" -> null                                       // includes Chrome's tab Duplicate shape
  if t == "form_submit" -> null                                  // POST results: never
  if q includes from_address_bar or t in {typed, generated, keyword} -> "address"
  if t == "auto_bookmark" -> "bookmark"
  if t == "link" -> "link"
  return null                                                    // auto_toplevel (tabs.create by extensions,
                                                                 // incl. TruePin forks/mirror copies) excluded by design

onCommitted(details): enqueue("commit"):
  st = getTabState(details.tabId) or new; st.committedCount++
  st.url = details.url; st.key = dupeKey(details.url); st.domain = registrableDomain(details.url)
  putTabState

  # strike detection for a PREVIOUS dedup close of this key
  if st.key and dedupRecent[st.key] and now - dedupRecent[st.key].closedAt < STRIKE_WINDOW_MS:
      strike("dedup", st.key); delete dedupRecent[st.key]        # user re-opened what we closed

  kind = classifyCommit(details)
  if kind: dedupOnCommit(details.tabId, details.url, kind, st)
  groupOnCommit(details.tabId, st)                                # 4.4; independent gate checks inside

dedupOnCommit(tabId, url, kind, st):
  settings = getSettings()
  if !settings.dedupAuto or !await isSettled() or await isPaused() -> return
  key = dupeKey(url); if !key -> return
  if isStruck("dedup", key) -> return                             # two-strikes ledger
  tab = quiet(tabs.get, tabId); if !tab or tab.incognito or tab.pinned -> return   # pinned NEVER a victim
  win = quiet(windows.get, tab.windowId); if !win or win.type != "normal" -> return
  if st.committedCount > FRESH_COMMIT_LIMIT -> return             # only a tab's FIRST real page is a victim:
        # covers cmd+T->type, target=_blank, bookmark-in-new-tab; an EXISTING tab the user navigated
        # keeps its history - closing it would destroy the back stack (Arc dedups new opens too)

  all = tabs.query({})                                            # then filter in JS (patterns can't express normalized equality)
  candidates = all where id != tabId and !incognito and windowType(normal)
               and (settings.dedupScope=="all" or windowId==tab.windowId)
               and dupeKey(t.url) == key                          # committed url only; pendingUrl races resolve on their own commit
  if empty -> return

  survivor = pick by preference: pinned > same-window-as-victim > max(lastAccessed)
  survivor = quiet(tabs.get, survivor.id); if !survivor -> return # re-verify: never close the victim if the anchor is gone

  # focus+close ordering (flicker-free):
  if tab.active:                                                  # user is LOOKING at the duplicate
      tabs.update(survivor.id, {active:true})                     # switch view first...
      if survivor.windowId != tab.windowId: windows.update(survivor.windowId, {focused:true})
  # background duplicate (middle-click etc.): close silently, steal no focus
  await closeTabsGuarded([tab.id], reason="dedup")                # selfClosed mark -> breaker token -> remove -> verify
  dedupRecent[key] = {closedAt: now, survivorId: survivor.id}     # arms strike detection
  counters.dedupedToday++
  traceDiag(`dedup ${kind} ${key} -> kept ${survivor.id}`)
```

Never-dedup summary (all enforced above): pinned victims; redirect-chain commits; form posts; reloads/back-forward; chrome:///about:/file:/ephemeral urls (`dupeKey` null); non-fresh tabs; incognito; non-normal windows; unsettled cold start; struck keys; paused.

**Manual "Sweep duplicates"** (`ui:sweepDupes {scope}`) — explicit command, ignores strikes and `dedupAuto`:

```
sweepDuplicates(scope, currentWindowId):
  tabs = all tabs of normal non-incognito windows (scope=="window" -> just current)
  buckets = groupBy(dupeKey non-null)
  victims = []
  for bucket where size > 1:
     survivor = pick: pinned > active > max(lastAccessed)
     victims += bucket minus survivor, minus any pinned, minus any active-in-its-window
  await withCloseAllowance(victims.length):                       # pre-declared exact allowance
     writeArchiveEntries(victims, reason="dupe-sweep", batchId)   # sweep victims ARE archived (free undo)
     closeTabsGuarded(victims)
  counters.sweptToday += n; lastBatch = {batchId,...}
  return {closed: n}
```

Auto-dedup victims are NOT archived (the survivor holds the page; archiving every dedup would spam the archive). Sweep victims are (bulk closes deserve an undo path).

### 4.3 Stale scan -> batch archive -> undo

```
onAlarm(tt-tick): enqueue("tick"):
  rollCountersDate(); pruneTtlDailyMaybe()
  if !settled or paused -> return
  settings = getSettings(); if settings.archiveAfter == "off" -> (skip archive part)
  now = Date.now(); if now - sessionStartedAt < SETTLE_MIN_MS -> return

  windows = windows.getAll({populate:true, windowTypes:["normal"]}) filter !incognito
  candidates = []
  for tab of all their tabs:
     staleSince = tab.lastAccessed > 0 ? tab.lastAccessed : (t<id>.firstSeenAt or now)
        # both directions safe: a lastAccessed reset by session-restore only DELAYS archiving
     if now - staleSince < archiveAfterMs -> skip                 # includes "younger than threshold"
     if tab.pinned or tab.active -> skip
     if tab.audible -> skip                                       # playing; camera/mic NOT detectable via tabs API ->
                                                                  # covered by the seeded allowlist (meet/zoom/teams)
     if !dupeKey-able scheme (non-http/s) -> skip                 # chrome://, file:// etc are not archivable/restorable
     if allowlistMatch(settings.archiveAllowlist, tab.url) -> skip    # exact host or eTLD+1 suffix match
     if tab.groupId != -1:
        if !ourGroups[tab.groupId] and !settings.archiveForeignGroups -> skip   # user-curated group = intent (default skip)
        if ourGroups[tab.groupId] and now - lastTouchedAt < archiveAfterMs -> skip  # a recently-worked group is a working set
     if isStruck("archive", dupeKey(tab.url) or domain) -> skip
     candidates.push(tab)

  # optional intermediate tier first (never both in one tick for the same tab)
  if settings.discardStale:
     for tab of allTabs where stale > archiveAfterMs/2 and not candidate-excluded and !tab.discarded:
        quiet(tabs.discard, tab.id)                               # id swap handled by onReplaced

  batch = candidates.slice(0, ARCHIVE_BATCH_MAX)                  # gradual; the rest next tick
  if batch empty -> return
  batchId = newBatchId()
  entries = batch.map(tab -> ArchiveEntry{..., groupTitle/Color: from tabGroups.get(tab.groupId) if any,
                                          winHint: tab.windowId, reason:"auto", batchId})
  await archiveRMW(a => { a.entries = [...entries, ...a.entries].slice(0, ARCHIVE_CAP) })   # WRITE FIRST
  await withCloseAllowance(batch.length):                         # pre-declared exact allowance
     closed = closeTabsGuarded(batch.map(id))                     # THEN close (crash order: entry w/o close = benign dup)
  counters.archivedToday += closed
  lastBatch = {batchId, at: now, count: closed} (storage.local)
  if settings.archiveNotify: notifyBatch(batchId, closed)         # id "tt-batch-<batchId>", buttons:[{title:t("undoBtn")}]
                                                                  # macOS may hide buttons -> popup Undo is canonical path
```

```
undoBatch(batchId or lastBatch.batchId): enqueue("undo-batch"):
  entries = archive.entries where batchId == X   (empty -> {restored:0})
  await withCreateAllowance(entries.length):
     for e of entries (original order):
        winId = windows.get(e.winHint) ok ? e.winHint : currentWindow
        tab = guardedCreate({windowId: winId, url: e.url, active:false}, "undo-archive")
        if tab and e.groupTitle and settings.groupAuto:
           regroupRestored(tab, e)                                # join/create OUR group by domain in that window (4.4 helper)
        strike("archive", dupeKey(e.url))                         # an undone archive is a counteraction: 2 undone batches
                                                                  # containing the same key retire that key for the session
  archiveRMW(a => remove those entries)                           # they are open again
  clear lastBatch if it was this batch; counters.archivedToday -= restored (floor 0)
  return {restored}
```

Restore from the archive page (`ui:archive:restore {ids}`) is the same loop minus the strike bookkeeping (an old restore is retrieval, not a complaint). TTL prune: entries with `now - archivedAt > ttlMs` dropped in one RMW, daily (`lastPruneAt`) and lazily on `ui:archive:list`; `"forever"` skips.

### 4.4 Auto-group flow

```
groupOnCommit(tabId, st):                                # called from onCommitted after dedup
  settings; if !settings.groupAuto or !settled or paused -> return
  tab = quiet(tabs.get, tabId); if !tab or tab.pinned or tab.incognito -> return
  if windowType != "normal" -> return
  if tab.groupId != -1 -> return                          # NEVER move a tab out of any group (ours or foreign)
  if st.committedCount > 1 -> return                      # GENTLE: only a tab's first real page; later navigations
                                                          # never re-shuffle (no fights with users dragging tabs)
  if st.ungroupedByUser -> return                         # user pulled this tab out once: hands off for the session
  domain = st.domain; if !domain or !st.key -> return     # http/s only
  if isStruck("group", domain) -> return

  gid = findOurGroup(windowId: tab.windowId, domain)      # ourGroups registry scan
  if gid:
     selfGroupOps[gid] = {op:"add", ts}
     quiet(tabs.group, {tabIds:[tab.id], groupId: gid}); touch(gid); st.groupedByUs = gid
     return
  # MIN SIZE 2: a singleton stays ungrouped. Justification: a one-tab group adds a title chip and strip
  # churn with zero organizational value, and creating/destroying it as tabs come and go is visible
  # flicker - the opposite of "invisible butler". The group is born the moment a second tab exists.
  peers = tabs.query({windowId: tab.windowId, pinned:false, groupId:-1(none)})
          where registrableDomain(url)==domain and id != tab.id
          and !t<id>.ungroupedByUser and !isEphemeralUrl(url)
  if peers empty -> return
  newGid = tabs.group({tabIds: [tab.id, ...peers.ids], createProperties:{windowId: tab.windowId}})
  title = cleanLabel(domain)
  if another ourGroup in this window already titled `title` with a DIFFERENT domain -> title = domain  # "github.io" vs "github.com"
  selfGroupOps[newGid] = {op:"create", ts}
  tabGroups.update(newGid, {title, color: colorFor(domain)})
  ourGroups[newGid] = {domain, title, color, windowId, createdAt, lastTouchedAt: now, collapsedByUs:false}
  upsert ourGroupSigs {domain, title, color, lastSeenAt}   # storage.local - restart recovery
```

**Organize now** (`ui:organizeNow {scope}`) — explicit command:

```
organizeNow(scope):
  for each normal non-incognito window in scope:
     loose = tabs.query({windowId, pinned:false}) where groupId==-1 and domain and !ephemeral
        # explicit beats implicit: ungroupedByUser tabs ARE included (the user just asked),
        # but foreign groups' members are untouched (they are not loose), pinned never
     byDomain = groupBy(registrableDomain)
     for domain, list of byDomain where list.length >= 2 or findOurGroup(windowId,domain):
        join existing our-group or create as in groupOnCommit (batched: one tabs.group call per domain)
  return {grouped, groupsCreated}
```

**Collapse scan** (same tick):

```
for gid, g of ourGroups:
  if settings.groupCollapseAfter == "off" -> break
  if now - g.lastTouchedAt < collapseAfterMs -> continue
  if isStruck("collapse", g.domain) -> continue
  grp = quiet(tabGroups.get, gid); if !grp or grp.collapsed -> continue
  members = tabs.query({groupId: gid})
  if any member.active or any member.audible -> continue      # never collapse under the user's feet
  selfGroupOps[gid] = {op:"collapse", ts}
  quiet(tabGroups.update, gid, {collapsed:true}); g.collapsedByUs = true
```

**Anti-fight wiring for groups**
- `tabs.onUpdated` with `changeInfo.groupId === -1` where `t<id>.groupedByUs` was set and no `selfGroupOps` marker: user pulled the tab out -> `ungroupedByUser = true` (per-tab, immediate — re-adding even once is already a fight) + `strike("group", domain)` (two pulled-out tabs of one domain retire auto-grouping that domain for the session).
- `tabGroups.onUpdated` for our gid, no `selfGroupOps` marker: `collapsed:false` -> `strike("collapse", domain)` + touch; `title`/`color` changed -> DISOWN (delete from `ourGroups` + `ourGroupSigs`): the user claimed it; we never rename, add to, or collapse it again.

**Restart re-adoption** (group ids do not survive browser restarts; `ourGroups` is session storage). During settle bootstrap:

```
for grp of tabGroups.query({}):                              # all windows
  sig = ourGroupSigs.find(s => s.title == grp.title and s.color == grp.color)
  if !sig -> continue
  members = tabs.query({groupId: grp.id})
  majority = count(registrableDomain(m.url) == sig.domain) >= ceil(members/2)
  if majority: ourGroups[grp.id] = {domain: sig.domain, ..., lastTouchedAt: now}   # re-adopted
# sigs with no live match stay 30 days (lastSeenAt prune) - the group may be in an unrestored window
```

Decision — recovery by **signature (title + color + member-domain majority)**, 3-of-3 required: title+color alone could claim a user's coincidental group; adding the domain-majority check makes a false claim require the user to have hand-built exactly the group we would have built — at which point managing it is what they'd expect, and any edit they make disowns it instantly. The alternative (never re-adopt) leaves orphan "Github" groups and mints duplicates next to them — strictly worse.

### 4.5 Merge all windows (`ui:mergeWindows`)

```
mergeWindows(targetWindowId):
  target must be normal, non-incognito
  for w of normalWindows() where id != target:
     for grp of tabGroups.query({windowId: w.id}):
        quiet(tabGroups.move, grp.id, {windowId: target, index: -1})   # moves members WITH title/color/collapsed;
                                                                        # foreign groups preserved, not modified
        if ourGroups[grp.id]: ourGroups[grp.id].windowId = target
     loose = tabs.query({windowId: w.id, pinned:false}) where groupId == -1
     if loose: quiet(tabs.move, loose.ids, {windowId: target, index: -1})
     # pinned tabs are NEVER moved (guardrail; also Chrome unpins on cross-window move,
     # and TruePin would re-mirror - moving them starts a war). A window left holding
     # only pinned tabs stays open; an emptied window closes itself (Chrome behavior).
  keep target focused; return {moved, groupsMoved, windowsEmptied, pinnedLeft}
```
No breaker needed (moves are not creates/closes); still runs on the queue.

### 4.6 Guarded close / create (breakers)

```
closeTabsGuarded(ids, reason):                       # ALL closes funnel here (dedup, archive, sweep)
  grant = min(ids.length, tokens available)          # closeLedger sliding window, base CLOSE_BURST=25/min,
                                                     # batch callers wrap in withCloseAllowance(exact n)
  if grant < ids.length: tripBreaker()               # stop everything: pausedUntil = now+10min,
                                                     # ONE notification "tt-breaker" (5-min renotify guard)
  victims = ids.slice(0, grant)
  markSelfClosed(victims)                            # single-serializer RMW (TruePin withSelfClosed)
  remove individually via quiet(); verify via quiet(tabs.get); retry survivors once; return closed count
  # NOTE: unlike TruePin's closeTabs we do NOT discard-before-close for archive victims by default:
  # discard swaps ids mid-flight; we already exclude audible tabs, and a stale tab's beforeunload
  # firing is rare. Kept as a constant switch if dialog reports appear.

guardedCreate(props, why)                            # copy of TruePin's: createLedger + withCreateAllowance
isPaused() = pausedUntil && now < pausedUntil        # gates dedupAuto, archive tick, groupOnCommit, collapse
```

### 4.7 Settle-then-act cold start

```
top-level: ensureAlarm(); ensureSettleBootstrap()
ensureSettleBootstrap(): if storage.session.settled -> done (SW wake mid-session: settled persists)
  else enqueue("settle"):
     sessionStartedAt = now (if unset)
     poll tabs.query({}).length: need SETTLE_CALM_POLLS consecutive equal non-zero counts,
       SETTLE_POLL_MS apart, max 40 attempts                     # TruePin's calm-wait
     seed t<id> firstSeen for every existing tab (no actions)
     re-adopt groups by sig (4.4)
     storage.session.set({settled:true})
# Until settled AND sessionStartedAt+SETTLE_MIN_MS passed: no auto dedup/archive/group/collapse.
# Manual popup commands are allowed (explicit user act, own allowances).
# Session restore's wave of duplicate-looking onCreated/onCommitted therefore hits a closed gate
# (mirror-cold-start-cascade lesson).
```

---

## 5. Pages and the ui:* contract

### 5.1 popup.html (344px, TruePin visual language: fixed header, scrolling middle, fixed action bar)

```
header: icon + "TrueTabs"
.scroll:
  section.hero (tonal card, radius 12): 2x2 counts grid
     [Open tabs · N windows] [Duplicates: N] [Stale now: N] [Archived today: N]
  section.actions: pill buttons
     [Organize now]  [Sweep duplicates]     (row 1; sweep gets a small "▾ all windows" affordance -> scope)
     [Archive stale now]  [Merge all windows]  (row 2)
     "Archived N today — Undo last batch" status row (visible when lastBatch fresh) [Undo]
  section.toggles: three Material switches (11px uppercase header "AUTOMATION")
     Duplicate prevention | Auto-archive | Auto-group     (write settings via ui:setSetting)
  #status line (ok/err)
footer.action-bar (icon buttons): Archive page | GitHub | Rate | Donate | Options
```
Rules: every button's `sendMessage` is dispatched synchronously in the click handler; any `window.close()`/focus change happens after dispatch (popup-teardown-async). Live refresh via `storage.onChanged` (counters/local) with 150 ms debounce.

### 5.2 options.html (single card, save-on-change)

Sections: **Duplicates** (dedupAuto switch, dedupScope select) · **Archive** (archiveAfter select 6h/12h/24h/3d/7d/off; archiveTtl select; archiveNotify switch; archiveForeignGroups switch "Also archive inside your own tab groups"; discardStale switch; archiveAllowlist textarea, one domain per line, parsed/validated to hostnames) · **Groups** (groupAuto switch, groupCollapseAfter select) · **Appearance** (theme 3-way) · **Language** (9 options) · footer: Copy diagnostics + version.

### 5.3 archive.html (extension page in a tab)

```
header: icon + "TrueTabs Archive" + search input (filters title/url/domain, client-side)
day sections (grouped by archivedAt local date, newest first):
  h3 "Today — 12 tabs"  [Restore all] [Delete all]   (per-day)
  rows: [checkbox] [favicon via /_favicon/?pageUrl=] [title / muted url+domain] [group chip color+title] [Restore] [x delete->confirm]
selection bar (appears when checked): "N selected" [Restore selected] [Delete selected]
footer: total count, TTL note ("entries older than 30d are removed"), link to Options
Restore >25 entries asks an inline confirm (create-breaker awareness).
```

### 5.4 ui:* message contract (request -> response)

| type | request | response |
|---|---|---|
| `ui:getState` | `{windowId}` | `{counts:{tabs,windows,dupes,staleNow,archivedToday,dedupedToday,archiveTotal}, settings, lastBatch:{batchId,count,at}\|null, paused:bool, settled:bool}` |
| `ui:setSetting` | `{key, value}` | `{ok}` (validates key against DEFAULTS; writes whole settings object to sync) |
| `ui:organizeNow` | `{scope:"window"\|"all", windowId}` | `{grouped:N, groupsCreated:M}` |
| `ui:sweepDupes` | `{scope, windowId}` | `{closed:N, batchId}` |
| `ui:archiveStaleNow` | `{windowId?}` | `{archived:N, batchId}` (same candidate logic, ignores ARCHIVE_BATCH_MAX, declares exact allowance) |
| `ui:mergeWindows` | `{targetWindowId}` | `{moved, groupsMoved, windowsEmptied, pinnedLeft}` |
| `ui:undoLastBatch` | `{batchId?}` | `{restored:N}` |
| `ui:archive:list` | `{}` | `{entries:[ArchiveEntry...], total}` (lazy TTL prune first; page groups by day itself) |
| `ui:archive:restore` | `{ids:[...]}` | `{restored:N}` |
| `ui:archive:delete` | `{ids:[...]}` | `{deleted:N}` |
| `ui:archive:clear` | `{scope:"all"\|"day", day?}` | `{deleted:N}` |
| `ui:diagnostics` | `{}` | `{version, settings, settled, pausedUntil, counters, strikes, ourGroups, sigs, ledgers:{close,create}, archive:{total,oldestAt}, windows:[{id,type,tabCount,urls:[...]}], trace:[last 40]}` — **urls only, no titles** (titles can leak document content; urls are needed to debug dedup keys) |

Test hooks (`globalThis`): `__ttUiCall(request)`, `__ttSimulateCommit(details)` (drives classifyCommit + dedup path), `__ttTick({now})` (runs the production scan with a clock override), `__ttWipeState()`, `__ttSimulateReload()`, `__ttSeedArchive(entries)`, `__ttDiag`.

---

## 6. Edge-case catalog (with resolutions)

1. **Session restore wave**: dozens of onCreated/onCommitted with duplicate-looking URLs at startup -> settle gate (calm-poll + 15 s floor) blocks all automation; per-tab firstSeen seeded during bootstrap so archive clocks start sane.
2. **SW suspension mid-batch**: the in-memory queue dies, but order-of-operations makes every step safe: archive entries are written before closes (worst case: entry exists + tab open = duplicate row, self-heals when the tab is archived again or the entry restored); breaker ledgers/selfClosed live in storage.session so budgets survive; the next tick converges the remainder. No step ever assumes a previous in-memory value.
3. **Tab dragged to another window mid-archive**: `closeTabsGuarded` re-verifies via `tabs.get` before/after; `winHint` may go stale — restore falls back to current window. onAttached updates registry windowId.
4. **User closes a tab we were about to archive**: `tabs.remove` on a gone id is a `quiet()` no-op; the pre-written archive entry stays — benign (the page is closed either way, and the entry is the safety net the user may want).
5. **Duplicate pinned vs regular**: pinned is always the survivor, never victim; two pinned duplicates -> untouched entirely (TruePin territory: its mirror legitimately keeps same-URL pins across windows — we never close pinned, so no war is possible by construction).
6. **chrome:// / about:blank / newtab / file:// / data:**: `dupeKey` returns null (non-http/s) -> excluded from dedup, archive, and grouping. `isEphemeralUrl` copied from TruePin for the newtab family across Chromium forks.
7. **Multiple normal windows**: groups are per-window entities — same domain in two windows = two groups with identical title/color (consistent look, correct Chrome model); dedup scope "all" focuses across windows (activate tab, then focus window — synchronous order); sweep scoping explicit.
8. **Incognito**: filtered everywhere (`tab.incognito`, window filter); extension not enabled there by default; if the user enables it, split session storage means our per-tab state still works, and dedup candidates never cross the incognito boundary (explicit check).
9. **Group id invalidation on restart**: ids are session-scoped; recovery via `ourGroupSigs` 3-of-3 signature match (title + color + member-domain majority) at settle; unmatched sigs kept 30 days (window may be restored later); user edits disown instantly.
10. **Archive quota overflow**: hard cap 5000 FIFO in the same RMW; on `storage.local` quota error drop oldest 500 + retry once + trace; TTL prune daily and on archive-page open.
11. **Two tabs commit the same URL simultaneously**: both jobs enqueue; serialization makes it deterministic — the first job closes the other (if fresh) or adopts it as survivor; the second job finds its tab gone and no-ops (`quiet` swallows).
12. **Survivor vanishes between query and close**: survivor re-verified immediately before closing the victim; if gone, victim lives.
13. **Duplicate-tab command (right-click > Duplicate)**: commits as reload-shaped or not at all -> classifier returns null; explicit user intent to have two copies is respected.
14. **Other extensions creating tabs** (TruePin mirror copies, nav-redirect forks): `tabs.create` navigations commit as `auto_toplevel`/no user qualifier -> classifier null -> never deduped; TruePin copies are pinned anyway (double protection).
15. **tabs.discard id swap** (our discard tier or Chrome Memory Saver): onReplaced carries `t<id>` state and ourGroups membership is group-side (group id unchanged); discarded tabs keep url/title so archiving them works.
16. **Notification buttons on macOS**: Chrome's native notifications may not surface buttons -> notification body says "Open TrueTabs to undo"; popup "Undo last batch" and archive page are the canonical undo paths; `notifications.onClicked` (body click) opens the archive page.
17. **User renames/recolors our group**: disowned immediately (anti-fight) — never re-touched, sig removed.
18. **Collapse vs active tab**: never collapse a group containing the active or an audible tab; our own collapse marked in `selfGroupOps` so the resulting onUpdated isn't read as a user act.
19. **Breaker trip**: single notification, `pausedUntil` stops every automatic class at once; manual popup commands still work (each declares its exact allowance); trace records the refusal.
20. **lastAccessed semantics after restart**: unknown whether Chrome preserves it or resets to restore time — both are safe (reset only delays archiving); missing/0 falls back to our firstSeen (= settle time), so nothing is ever archived early.
21. **Clock jumps (sleep/timezone)**: all comparisons are `Date.now()` deltas vs stored epochs; a laptop asleep for 24 h will archive on wake — acceptable and Arc-like; SETTLE_MIN_MS only gates after cold starts, not wakes (settled persists in session storage).
22. **Popup opened before settle**: `ui:getState` returns `settled:false`; popup renders counts but disables nothing — manual actions allowed; hero shows a subtle "warming up" hint.

Decisions embedded above, with justification:
- **Foreign-group archiving default OFF** (`archiveForeignGroups:false`): a user-made group is curated intent (pinning-lite); archiving from it dismantles something they built by hand. Our own auto-groups ARE archivable — they are just tidied loose tabs. Option exposed for power users.
- **Min group size 2, singleton stays ungrouped**: one-tab groups are pure chrome noise and create visible strip churn as they're minted/destroyed; the group materializes when the second same-domain tab commits, pulling both in.
- **Dedup only on a tab's first commit**: closing an existing tab that navigated to a duplicate would destroy its back-stack; Arc's dedup is on opens, not on in-place navigation.

---

## 7. E2E test plan (test/e2e.mjs, TruePin harness style)

Fixture server: pages served on `127.0.0.1:<port>` AND `localhost:<port>` (two registrable "domains" without /etc/hosts; `[::1]` as a third if needed for group tests). TruePin is NOT loaded; we assert OUR behavior contracts. All automatic-action tests drive `__ttTick({now})` / `__ttSimulateCommit` so no real waiting.

1. `extension boots: SW up, defaults in effect, alarm registered, settle flag turns true` — swEval settings + `alarms.get("tt-tick")` + waitFor settled.
2. `dedup: new tab to an already-open URL closes itself, existing tab focused (same window)` — open /a, open /a again via page target=_blank; assert one tab remains, survivor active, `dedupedToday` bumped.
3. `dedup: cross-window duplicate focuses the survivor's window` — /a in win1, open /a in win2 active; assert win1 focused, win2's copy gone.
4. `dedup: background duplicate closes silently, no focus steal` — middle-click-shaped (created inactive); assert active tab unchanged.
5. `dedup: pinned tab may be the focus target but is NEVER the victim` — pinned /a + new /a -> new closes; two pinned /a -> both survive (TruePin-coexistence invariant #1: we never close pinned).
6. `dedup: classifier ignores redirects, form posts, reloads, back/forward, prerender, subframes` — `__ttSimulateCommit` matrix asserts null kinds and no closes.
7. `dedup: normalization - utm_*/fbclid stripped, trailing slash and host case folded; ?v= values distinguish` — /a?utm_source=x dedups against /a; /watch?v=1 does NOT dedup against /watch?v=2; #/route hash kept.
8. `dedup: an existing tab with history navigating to a duplicate is left alone` — navigate /b tab to /a (committedCount>1); both tabs remain.
9. `dedup: two strikes retire the key` — dup-close /a, reopen /a (strike 1, closed again), reopen (strike 2, closed), reopen -> survives; diagnostics shows the ledger (TruePin-coexistence invariant #2: generalized UNPIN_CONFIRM).
10. `dedup: settle gate - no closes before settled` — `__ttWipeState`, recreate dup tabs, assert both alive until settle, alive after too (they predate the gate).
11. `sweep duplicates: window scope closes n-1 per bucket, keeps pinned+active, victims land in archive as dupe-sweep` — popup-path via `__ttUiCall`.
12. `archive: a stale tab is archived - entry carries url/title/group/winHint, tab closed, counter and lastBatch set` — `__ttTick({now: +25h})`.
13. `archive: exclusions hold - pinned, active, allowlisted domain, foreign-group member, non-http scheme` — build the zoo, tick, assert all alive (TruePin-coexistence invariant #1 again for pinned).
14. `archive: our-group member archives only when the group is untouched` — touch group (activate member), tick -> alive; tick at +threshold from touch -> archived.
15. `archive: undo restores the batch into the original window with our group re-applied, entries removed, archive strike recorded`.
16. `archive: FIFO cap and TTL prune` — `__ttSeedArchive` 5000+K entries -> oldest dropped; seed old entries + tick -> pruned; ttl "forever" keeps.
17. `archive page: renders day groups, search filters, single restore works` — open archive.html as a page, drive DOM (TruePin popup-test style).
18. `group: second same-domain tab mints the group with deterministic title+color; singleton never grouped` — localhost vs 127.0.0.1; assert `fnv1a` color stable across reload.
19. `group: third tab joins; different domain gets its own group; pinned tabs never grouped`.
20. `group: foreign group untouched - organize now and continuous mode never add to, rename, or collapse a group we didn't create` — pre-make a group via raw `chrome.tabs.group` in swEval without registry (simulates user/other-extension group).
21. `group: user pull-out is respected - tab not re-grouped on next commit; rename of our group disowns it (no further collapse)`.
22. `collapse: untouched our-group collapses on tick; user expand strikes; second expand retires collapsing for that group`.
23. `merge windows: loose tabs and whole groups (with title/color) move to target; pinned tabs stay behind; emptied window closes`.
24. `circuit breaker: close storm capped at 25/min, automation pauses, single notification; declared batch allowance passes exactly` — TruePin breaker-test pattern (ledger stuffing via swEval).
25. `restart: simulated reload re-adopts groups by signature - no duplicate domain group, archive and settings persist, session state rebuilt` — `__ttSimulateReload`.
26. `popup backend: ui:getState counts (dupes/staleNow) match constructed reality; pillar toggles write settings`.
27. `i18n: en default; ru and zh messages load` (byte-for-byte TruePin test shape).
28. `service worker: zero unchecked runtime.lastError / exceptions during the whole run` — final assertion, CDP Log collector attached at launch.

---

## 8. Build order (milestones, each with "done when")

- **M1 — Skeleton + canon plumbing.** Repo layout, manifest (+new dev key), icons, i18n.js + en locale (others stubbed = en), config.js, popup/options/archive shells with the full token set, background.js with: queue+diag, quiet/checked, settings, settle gate, selfClosed, both breakers, strikes ledger, alarm, ui:getState/ui:setSetting/ui:diagnostics, test harness with fixture server. *Done when*: tests 1, 26 (toggles only), 27, 28 pass; popup renders live counts of open tabs/windows.
- **M2 — Dedup.** normalizeUrl/dupeKey, classifyCommit, dedupOnCommit, dedupRecent strikes, sweepDuplicates + archive-entry write for sweep, popup Sweep button. *Done when*: tests 2–11 pass and a manual day of dogfooding produces zero surprise closes (trace reviewed).
- **M3 — Archive.** Archive RMW store, stale scan + exclusions, batch+allowance+notification, undo, archiveStaleNow, discard tier, TTL/cap, counters, archive.html/js full, popup Undo row. *Done when*: tests 12–17 pass; killing the SW mid-batch (chrome://serviceworker-internals stop) never loses a tab that isn't in the archive.
- **M4 — Groups + merge.** groupOnCommit, organizeNow, ourGroups + sigs + re-adoption, collapse scan, disown/strike wiring, mergeWindows, popup Organize/Merge buttons. *Done when*: tests 18–25 pass; reload + browser-restart dogfood shows no duplicate or orphan-managed groups.
- **M5 — Shell polish.** Options page complete (allowlist editor, all selects), popup hero/status states (paused, warming up), diagnostics dump complete, full 8-locale pass (~95 keys x 8), theme QA light/dark. *Done when*: options round-trips every setting; diagnostics JSON parses and contains urls-only summaries; all locales load (test 27 extended).
- **M6 — Ship kit.** README landing (badges, light/dark shots, feature table, Honest limits: "dedup acts only on fresh tabs", "camera/mic tabs protected via allowlist", "buttons on macOS notifications"), STORE_LISTING.md with the 7 permission justifications, PRIVACY.md, package.sh (guards: version match, no key), store screenshots via shot script, FUNDING/ISSUE_TEMPLATE/LICENSE/SUPPORTERS. *Done when*: `./package.sh` emits one guarded zip; manifest-vs-code permission audit (cws-permission-scope lesson) checklist ticked in STORE_LISTING.

---

## 9. Risks / open questions (with recommendations)

1. **webNavigation vs the fixed six-permission list.** The redirect/form never-dedup requirements are unimplementable without it; it adds no CWS warning (same "read browsing history" bucket as tabs). **Recommendation: ship 7 permissions**; if the author insists on six, fallback is settle-debounced dedup on `tabs.onUpdated status==="complete"` only for tabs with `committedCount===1` — loses form-POST detection (mitigate: never dedup within 10 s of the survivor's own commit). I recommend against the fallback.
2. **`tab.lastAccessed` behavior across restarts is under-documented.** Design is safe in both directions (reset only delays archiving; missing falls back to firstSeen), but verify empirically in M3 on a real restart; if Chrome preserves it, consider dropping SETTLE_MIN_MS from 15 s to 5 s. **Recommendation: keep the dual floor, add a one-line diagnostics field (`lastAccessedSample`) to confirm in the field.**
3. **groupAuto default ON will visibly move tabs for new users** — the classic 1-star trigger ("it rearranged my tabs"). It is fixed product spec; the mitigations are structural (only NEW tabs after install, min-2, never re-shuffle, Organize-now for the rest). **Recommendation: keep ON, plus a first-run notification "TrueTabs groups new tabs by site — turn off in the popup" (one-time, id-fixed).**
4. **Signature re-adoption can claim a hand-built group** that exactly matches title+color+domain-majority. Impact is low (we'd only add same-domain tabs and maybe collapse it; any user edit disowns) but nonzero. **Recommendation: accept with the 3-of-3 rule; revisit if Chrome ships stable group ids / saved-groups API to extensions.**
5. **Archive as a single storage.local key** means ~1.5 MB RMW writes per batch at cap. Fine at v1 cadence (a few writes/day), but omnibox search in v1.1 will want indexed reads. **Recommendation: ship single-key now (matches TruePin's canon-key pattern and the serializer), and reserve `arch:<yyyymmdd>` day-bucket migration as the v1.1 refactor gated by a `schemaVersion` field written from day one.**

---

### Critical Files for Implementation

- `/Users/datysho/Projects/truetabs/extension/background.js` — the entire engine (sections 3–4 of this spec); modeled line-for-line on `/Users/datysho/Projects/truepin/extension/background.js`
- `/Users/datysho/Projects/truetabs/extension/manifest.json` — permission set is the CWS-critical surface (section 2)
- `/Users/datysho/Projects/truetabs/test/e2e.mjs` — harness + 28 contracts (section 7); copy primitives from `/Users/datysho/Projects/truepin/test/e2e.mjs`
- `/Users/datysho/Projects/truetabs/extension/popup.html` + `popup.js` — dashboard, teardown-safe dispatch; tokens from `/Users/datysho/Projects/truepin/extension/popup.html`
- `/Users/datysho/Projects/truetabs/extension/archive.html` + `archive.js` — the one net-new UI surface (section 5.3)