# Chrome Web Store submission kit

Everything to copy-paste into the CWS developer dashboard. Keep this file in
sync with the shipped code (permission audit below is part of the release
checklist).

## Basics

- **Name:** TrueTabs
- **Category:** Workflow & Planning (alt: Tools)
- **Language:** English (US) + store descriptions below; the extension itself
  ships 8 locales (en, ru, uk, de, fr, es, pt, zh_CN).
- **Summary (132 chars max):**
  > Arc-style tab butler: no duplicate tabs, stale tabs auto-archived (undoable), tabs grouped by site or by AI topic.

## Description

```
Live in Chrome long enough and you drown in tabs: the same page opened five
times, forty tabs you'll "read later", zero structure. Arc solved this at
the browser level. TrueTabs brings that experience into Chrome's native UI -
no sidebar of its own, no new-tab takeover, Chrome stays Chrome.

BEST WITH VERTICAL TABS

Chrome can put the tab strip down the left side: Settings > Appearance >
Tab position > Vertical. If your Chrome does not show that row yet, it is
still rolling out.

Turn it on. A horizontal strip at forty tabs is a row of nameless icons -
titles gone, groups reduced to colour chips, and everything TrueTabs does is
invisible to you. Down the side, every tab keeps its title and every group
shows its name and colour, so the structure is finally something you can
read. Chrome renders the list; TrueTabs decides what is in it - no
duplicates taking a row, stale tabs leaving on their own, new tabs landing
in the right group, the order you chose staying put. That is the Arc
sidebar, in the browser you already use.

WHAT IT DOES

- Duplicate prevention: opening a URL you already have switches you to the
  existing tab instantly - before the duplicate even loads. Typing an open
  URL into an existing tab works the other way round: your tab wins and the
  stale copy merges into it (archived, so it's always reversible). One click
  sweeps the duplicates you already accumulated.
- Auto-archive: tabs untouched for 24 hours (configurable 6h-7d, or off) are
  saved to a local archive and closed. Searchable archive page, one-click
  restore, a notification with Undo after every batch.
- Auto-groups: new tabs group by site (stable colors, clean names) or by
  TOPIC via AI - one selector; idle groups collapse; "Organize now" tidies
  a whole window at once.
- Smart groups: topic clustering runs on Chrome's built-in on-device AI
  (free, no keys, nothing leaves your machine) - or your own API key
  (OpenAI, Gemini, Grok, or an OpenAI-compatible model server on your own
  machine, such as Ollama). Groups appear batch by batch with live progress.
- My groups: your own named groups with routing rules - list the sites that
  always belong there, or describe the topic in plain words for the AI.
  Rules outrank all automatic grouping.
- "Other" catch-all: with it on, nothing is left loose - a tab that fits no
  rule, no site group and no topic parks in a grey "Other" at the end. It is
  a parking lot, never a decision: a real group wins its tabs back, the
  parking lot re-empties itself when you add a rule or switch modes, and one
  click on the row files the whole pile on demand.
- Order, your way: group order and tab order - Manual (you arrange them),
  A-Z, recently used, or oldest first. Kept live by default: new tabs slot
  into place, a manual drag snaps back, and "recently used first" surfaces
  the tab you touch. Prefer it on demand? Turn "Keep the order
  automatically" off and the order applies only when you press Organize.
- Bookmark groups (optional, off by default): a folder under "TrueTabs" in
  your bookmarks is a durable group definition. "Open" materializes it (tabs
  you already have join instead of duplicating), "Update folder" pushes the
  live membership back, and the popup marks a group that drifted from its
  folder. Closing tabs never touches bookmarks. Definitions travel between
  browsers through Chrome's own bookmark sync.
- Free memory earlier (optional): a tab going stale can be unloaded from
  memory before it is archived - it keeps its place in the strip and reloads
  when you click it.
- Dashboard popup: live counts, one-click actions, merge all windows.

WHY YOU CAN TRUST THE AUTOMATION

- Everything is undoable: every automatic batch has a one-click Undo.
- Two strikes: any automatic action you counteract twice is retired for that
  page or site until the browser restarts. TrueTabs never fights you.
- Circuit breaker: automatic closes are hard-capped; anything runaway pauses
  all automation for 10 minutes and tells you once.
- Hard no-touch list: pinned tabs, the active tab, tabs playing audio,
  meeting sites, and tab groups you made yourself are never touched.
- Lock any group: the padlock on its popup row, and automation never takes a
  tab out of it again.
- Apps run their own flows: when a site opens a tab into itself (a chat
  branching into a new tab, an editor popping the document out, a checkout
  returning to its order page), that tab is the app at work, not a duplicate
  you opened - automation leaves it alone.
- Session-restore safe: zero automation until your session settles.

PRIVACY

No analytics, no telemetry, no accounts, no network requests by default.
The archive lives in your browser. On-device AI never sends titles anywhere.
The bring-your-own-key mode (off by default) sends tab titles and domains to
the provider YOU chose, on your key - stated plainly where you enable it.

From the maker of TruePin (pinned tabs that cannot be lost). TrueTabs never
closes, moves, groups or archives a pinned tab - the two coexist by design.

Free forever. Open source (MIT): https://github.com/datysho/truetabs
```

## Permission justifications (dashboard form)

- **tabs** - Core function: reading tab URLs/titles to detect duplicate and
  stale tabs and their sites; closing duplicates, archiving stale tabs,
  focusing the surviving tab.
- **tabGroups** - Creating, naming, coloring and collapsing the tab groups
  the extension manages.
- **storage** - User settings (sync); the local tab archive, counters and
  group signatures (local); per-tab engine state (session).
- **alarms** - A once-per-minute heartbeat that runs the stale-tab scan and
  group-collapse check reliably under MV3.
- **notifications** - "Archived N tabs - Undo" notices and the safety-pause
  notice from the automation circuit breaker.
- **favicon** - Rendering favicons of archived pages on the archive page.
- **webNavigation** - Classifying navigation commits (transition types and
  qualifiers) so redirect chains, form submissions and reloads are NEVER
  treated as duplicate opens. The tabs API alone cannot distinguish these.
- **bookmarks (optional)** - The optional "Bookmark groups" feature, off by
  default: a folder under the "TrueTabs" bookmarks folder is a durable group
  definition. Requested at RUNTIME only when the user switches the feature on
  and released when they switch it off. Bookmarks are read and written only
  on the user's explicit clicks ("To bookmarks", "Update folder", "Open") and
  only inside the "TrueTabs" folder; no automatic path writes there and the
  extension never deletes a folder. Closing, archiving and deduplicating tabs
  contain no bookmark calls at all.
- **Optional host permissions** (api.openai.com, generativelanguage.googleapis.com,
  api.x.ai, user's custom endpoint) - Requested at RUNTIME only when the
  user saves their own API key for the optional smart-grouping mode, and
  only for the single provider they chose. The extension has zero site
  access at install time and makes no network requests by default.
  - The custom-endpoint option is LOOPBACK ONLY: the manifest can ask for
    `localhost` / `127.0.0.1` (a local model server such as Ollama on
    `http://localhost:11434/v1`) and for nothing else. There is deliberately
    no `http://*/*` / `https://*/*` pair - the extension has no way to request
    access to an arbitrary site, in any build. `options.js`
    `byokOriginPattern()` rejects a non-loopback custom URL before any ask,
    and `releaseUnusedByokOrigins()` hands a grant back when the user switches
    provider or turns the mode off.

## Privacy practices declarations

- Single purpose (dashboard field, paste verbatim):

  ```
  TrueTabs has one purpose: keeping the user's open tabs organized in Chrome's own tab strip.

  Everything it does serves that purpose. It prevents duplicates - opening a URL that is already open focuses the existing tab instead of adding a second one. It archives tabs the user has not touched for a configurable period, so the strip holds only what is in use, into a local searchable archive that restores in one click. It files tabs into Chrome tab groups by site, by topic, or by the user's own rules, and keeps the order the user chose.

  There is no second function. Nothing is injected into web pages, there are no accounts, no analytics, no telemetry and no network requests by default. Tab URLs and titles are read only to decide whether a tab is a duplicate, whether it has gone stale, and which group it belongs in.
  ```

  One purpose, three expressions of it. Never list dedup/archive/grouping as
  three co-equal functions: a reviewer may read that as three purposes.
- Remote code: **No**. Verified by machine before every submit - zero `eval`,
  zero `new Function`, zero dynamic `import()`, zero external `src`/`href` in
  any HTML, no wasm. All 38 packaged files are local.
- Data usage: the BYOK mode transmits tab titles/domains to the user's own AI
  provider on the user's key; disclosed in the UI at the point of enablement
  and in the privacy policy.
- Bookmark groups read and write bookmarks on the user's own machine (and
  through the user's own Chrome sync); nothing is transmitted anywhere and
  nothing is collected.
- Privacy policy URL: https://github.com/datysho/truetabs/blob/main/PRIVACY.md
- Support URL (dashboard field): https://github.com/datysho/truetabs/issues
- **Data-usage checkboxes** - tick **Web history**, and nothing else.
  - Why it is ticked at all: the CWS user-data FAQ defines "handle" as
    "collecting, transmitting, using, or sharing", and states that extensions
    "are required to disclose how they handle user data, even when data is
    processed or stored locally on a user's device and is not transmitted to
    external servers or third parties". Web browsing activity is "any
    information about the websites or other web resources a user requests or
    interacts with, including the domains or URLs the browser interacts with".
    Reading tab URLs/titles and storing archive entries locally IS that.
    Local-only is not an exemption from disclosure.
  - Why it is safe: browsing-activity handling is permitted "to the extent
    required for a user-facing feature described prominently in the Product's
    Chrome Web Store page and in the Product's user interface" - which is the
    whole of TrueTabs, described in both places.
  - **Website content** is the wrong box and must stay unticked: it means page
    contents (text, images, hyperlinks). TrueTabs injects no content scripts
    and never reads a page.
  - **Authentication information** is the one arguable box - the BYOK key is a
    credential held in `storage.local`. Recommendation: leave it unticked. The
    field asks what is collected FROM users; the key is entered by the user for
    their own provider, never reaches us, and goes nowhere but the service it
    authenticates to (the FAQ treats the analogous FTP-client-with-user-
    specified-server case the same way). Revisit if a reviewer raises it.
  - Untick everything else: PII, health, financial, personal communications,
    location, user activity.
  - Certifications (all three apply, tick each): data is not sold to third
    parties; data is not used or transferred for purposes unrelated to the
    single purpose; data is not used or transferred to determine
    creditworthiness or for lending.

## Assets

Every file below is upload-ready at the size the dashboard demands - the
generators emit exact CWS sizes, no resizing or compositing by hand.

- Icon 128: `extension/icons/tt-128.png`
- Screenshots (1280x800, pick up to 5): `store/screenshots/store-popup-{light,dark}.png`
  (the 344-wide popup composed on a branded canvas),
  `store-options-{light,dark}.png`, `store-archive-{light,dark}.png`
- Small promo tile (440x280): `store/screenshots/store-tile-440x280.png`
- Marquee promo tile (1400x560): `store/screenshots/store-marquee-1400x560.png`
  - Optional: the store only uses it if editors pick the item for the featured
    carousel. It gates nothing in review.
- GitHub social preview (1280x640): `store/social-preview.png` (+ `-dark`),
  Settings -> Social preview; also the README hero
- Regenerate: `cd test && node shots.mjs && node shot-social.mjs`

## Submission checklist

- [ ] `cd test && npm test` - full suite green, twice (flake control)
- [ ] Permission audit: every permission above exists in manifest.json and is
      exercised by live code; nothing extra (cws-permission-scope lesson)
- [ ] Store texts in this file match the actually shipped features
- [ ] `./package.sh` - fresh zip, version matches manifest, dev key stripped
- [ ] Assets regenerated from the current CSS (`node test/shots.mjs`,
      `node test/shot-social.mjs`) and every file is a legal CWS size
- [ ] Repo public, PRIVACY.md reachable at the URL above
- [ ] Upload zip, paste texts, declare privacy practices, submit
- [ ] After the id is assigned: fill `TT_CWS_ID` in `extension/config.js`
      (unhides the "rate it" link), and `TT_PAYPAL_URL` once the handle exists
