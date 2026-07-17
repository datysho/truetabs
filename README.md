<div align="center">
  <img src="extension/icons/tt-128.png" width="96" alt="TrueTabs" />

  # TrueTabs

  **The Arc-style tab butler for Chrome.** No duplicate tabs, stale tabs
  auto-archived (always undoable), tabs grouped by site - or by topic with AI
  that runs on your device.

  ![Manifest V3](https://img.shields.io/badge/manifest-v3-2563eb)
  ![License MIT](https://img.shields.io/badge/license-MIT-16a34a)
  ![Network: none by default](https://img.shields.io/badge/network-none%20by%20default-16a34a)
  ![8 languages](https://img.shields.io/badge/languages-8-2563eb)

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="store/screenshots/store-popup-dark.png" />
    <img src="store/screenshots/store-popup-light.png" width="344" alt="TrueTabs popup" />
  </picture>
</div>

## Why

Live in Chrome long enough and you drown: the same page opened five times,
forty tabs you'll "read later", zero structure. Arc solved this at the
browser level - duplicates focus the existing tab, untouched tabs move to an
archive, everything stays organized. Chrome never did.

TrueTabs brings exactly that experience into Chrome's native UI. No vertical
sidebar, no new-tab page takeover - Chrome stays Chrome, the mess just stops.

## What it does

| | Feature | How |
|---|---|---|
| 1 | **Duplicate prevention** | Opening a page you already have focuses the existing tab instantly - a fresh duplicate is pre-empted before it even loads. Any real page counts: websites, local `file://` pages, extension and `chrome://` pages. Re-typing an open URL into an EXISTING tab works the other way round: your tab wins, the stale copy merges into it (archived first) and the tab is re-filed by your rules. Manual "Sweep duplicates" for the pile you already have. |
| 2 | **Auto-archive** | A tab untouched for 24h (configurable 6h-7d, or off) is saved to a local archive and closed. Searchable archive page, restore in one click, notification with Undo after every batch. |
| 3 | **Auto-group** | One selector: new tabs group by *site* (stable colors, clean names) or by *topic* via AI. Idle groups collapse. One-click "Organize now" for everything else. |
| 3b | **Smart groups (AI)** | Cluster tabs by *topic*, not just site - on-device Gemini Nano (free, no keys, nothing leaves your machine) or your own API key (OpenAI / Gemini / Grok / any OpenAI-compatible endpoint like Ollama). Groups appear batch by batch with live progress. With the "Other" catch-all on, nothing is left loose - new tabs that fit no topic join it. |
| 3c | **My groups (rules)** | Your named groups with routing rules: a site list (deterministic) and/or a plain-language AI hint. Rules outrank every automatic grouping. |
| 3e | **"Other" catch-all** | With it on, nothing is left loose: a tab that fits no topic, no site group and no rule parks in a grey "Other" at the end. Works with plain site grouping too - no AI required. It is a parking lot, never a decision: a real group always wins its tabs back. |
| 3d | **Order** | Two maintained axes: group order and tab order (A-Z / recently used / oldest). New tabs slot into place, manual drags snap back, and with *recently used first* the tab you use surfaces instantly - its group rises to the front. |
| 4 | **Dashboard** | Live counts (tabs, duplicates, stale, archived today), one-click actions, merge all windows, master switches per automation. |

## Safety model - why you can trust automation

Everything here descends from [TruePin](https://github.com/datysho/truepin)'s
"one rule, no surprises" school:

- **Undo everything.** Every automatic archive batch has a one-click Undo
  (notification + popup). Sweep victims are archived, not lost. The archive
  keeps entries 30 days by default.
- **Two strikes and it stops.** Any automatic action you counteract twice
  (reopen a deduped page, pull a tab out of a group, expand a collapsed
  group, restore an archived tab) retires that action for that page/site
  until the browser restarts. TrueTabs never fights you - or another
  extension. The popup says when something is retired and takes it all back
  in one click.
- **Circuit breaker.** Automatic closes are capped at 25/minute; bulk
  operations declare exact budgets. Anything runaway pauses ALL automation
  for 10 minutes and tells you once.
- **Settle-then-act.** Zero automation during session restore after startup -
  a restoring session looks exactly like a duplicate storm, so the engine
  waits until the world is calm.
- **Hard no-touch list.** Pinned tabs (TruePin territory), the active tab,
  tabs playing audio, meeting sites (allowlist), your own hand-made tab
  groups - never archived, never grouped, never closed.

<details>
<summary><b>Under the hood</b></summary>

- One service worker owns all logic; popup/options/archive are thin renderers.
- Serialized mutation queue: every state change runs FIFO - no storage races.
- Archive is written BEFORE tabs close: a crash mid-batch leaves an extra
  archive row, never a lost tab.
- URL identity: normalized (host case, default ports, trailing slash, sorted
  query, tracking params like `utm_*`/`fbclid` stripped, `#/` SPA routes
  kept) - `?v=` on YouTube stays significant.
- A navigated tab is never the dedup victim: its back-history survives. On an
  address-bar/bookmark navigation the roles flip - the OTHER copy is merged
  into the tab you are in (archived first).
- Groups this extension creates are tracked by id in session storage and
  re-adopted after a restart by signature: site groups on 3-of-3 (title +
  color + member-domain majority), topic and rule groups on title + color.
  Rename or recolor a group and it is yours forever.
- Smart grouping validates model output against a strict JSON contract;
  garbage falls back to domain grouping silently. The BYOK key lives only in
  `storage.local`, is masked in diagnostics, and host access is requested at
  runtime for the one provider you chose - install-time site access is zero.
</details>

## Honest limits

- Fresh-tab dedup acts before the page loads, ahead of navigation
  classification; the one theoretical miss is a target=_blank form POST to an
  URL you already have open - its origin page stays open, and two strikes
  retire the key anyway.
- In-place merge triggers only on address-bar and bookmark navigations; link
  browsing never merges or reshuffles anything.
- The tabs API cannot see camera/microphone use - meeting sites are protected
  by an editable allowlist (meet/zoom/teams seeded) instead.
- Only websites are archived: a local or internal page cannot be recreated
  faithfully, so it is never archived and never gets an archive row - its
  duplicates are simply closed while the original stays open.
- macOS may hide notification buttons; the popup's "Undo last batch" is the
  canonical undo path.
- On-device AI needs Chrome 138+, ~22 GB free disk and 16 GB RAM or a 4 GB
  GPU; the model downloads once (~2-4 GB) and only after you click Enable.
- Smart group names come out in the dominant language of your tab titles.
- If TruePin's "move locked tabs to front" (`always` mode) is on, it may pull
  a locked tab out of a group; TrueTabs backs off after two strikes.
- Maintained sort orders only groups TrueTabs made (groups you arranged
  yourself keep their places), and the "Other" catch-all keeps the end of
  the group block.

## Install (until the Web Store listing is live)

1. Download/clone this repo.
2. `chrome://extensions` - enable Developer mode - **Load unpacked** - pick
   the `extension/` folder.

## Development

```bash
cd test
npm install
npm test          # 64 e2e contracts against a real Chrome for Testing (ONLY="substring" to run one)
HEADFUL=1 npm test
node shots.mjs    # regenerate store screenshots
./package.sh      # build the store zip (strips the dev key)
```

## Family

TruePin protects your pinned tabs. TrueTabs runs everything else. The names
mirror the technical contract: **TrueTabs never closes, moves, groups or
archives a pinned tab** - the two coexist by construction.

- [TruePin](https://github.com/datysho/truepin) - pinned tabs that cannot be
  lost.

## Support

TrueTabs is free forever, MIT-licensed, no accounts, no telemetry. If it
saves your tabs (and your RAM), a star helps others find it. Donations - see
the heart in the popup footer once the link is live; supporters land in
[SUPPORTERS.md](SUPPORTERS.md).
