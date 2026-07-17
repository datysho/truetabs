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
no vertical sidebar, no new-tab takeover, Chrome stays Chrome.

WHAT IT DOES

- Duplicate prevention: opening a URL you already have focuses the existing
  tab and closes the new one. One click sweeps the duplicates you already
  accumulated (they are archived, so it's always reversible).
- Auto-archive: tabs untouched for 24 hours (configurable 6h-7d, or off) are
  saved to a local archive and closed. Searchable archive page, one-click
  restore, a notification with Undo after every batch.
- Auto-groups: new tabs group by site with stable colors and clean names;
  idle groups collapse; "Organize now" tidies a whole window at once.
- Smart groups (optional): cluster tabs by TOPIC using Chrome's built-in
  on-device AI (free, no keys, nothing leaves your machine) - or your own
  API key (OpenAI, Gemini, Grok, or any OpenAI-compatible endpoint).
- Dashboard popup: live counts, one-click actions, merge all windows.

WHY YOU CAN TRUST THE AUTOMATION

- Everything is undoable: every automatic batch has a one-click Undo.
- Two strikes: any automatic action you counteract twice is retired for that
  page or site until the browser restarts. TrueTabs never fights you.
- Circuit breaker: automatic closes are hard-capped; anything runaway pauses
  all automation for 10 minutes and tells you once.
- Hard no-touch list: pinned tabs, the active tab, tabs playing audio,
  meeting sites, and tab groups you made yourself are never touched.
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
- **Optional host permissions** (api.openai.com, generativelanguage.googleapis.com,
  api.x.ai, user's custom endpoint) - Requested at RUNTIME only when the
  user saves their own API key for the optional smart-grouping mode, and
  only for the single provider they chose. The extension has zero site
  access at install time and makes no network requests by default.

## Privacy practices declarations

- Single purpose: tab lifecycle management (dedup, archive, grouping).
- Data usage: does NOT collect user data. The optional BYOK mode transmits
  tab titles/domains to the user's own AI provider on the user's key;
  disclosed in the UI at the point of enablement and in the privacy policy.
- No remote code. All logic ships in the package.
- Privacy policy URL: https://github.com/datysho/truetabs/blob/main/PRIVACY.md

## Assets

- Icon 128: `extension/icons/tt-128.png`
- Screenshots (1280x800): `store/screenshots/store-options-{light,dark}.png`,
  `store-archive-{light,dark}.png`; popup shot is 344-wide - compose on a
  1280x800 canvas before upload.

## Submission checklist

- [ ] `cd test && npm test` - 28/28 green
- [ ] Permission audit: every permission above exists in manifest.json and is
      exercised by live code; nothing extra (cws-permission-scope lesson)
- [ ] Store texts in this file match the actually shipped features
- [ ] `./package.sh` - fresh zip, version matches manifest, dev key stripped
- [ ] Screenshots regenerated from the current CSS (`node test/shots.mjs`)
- [ ] Repo public, PRIVACY.md reachable at the URL above
- [ ] Upload zip, paste texts, declare privacy practices, submit
