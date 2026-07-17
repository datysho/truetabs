# TrueTabs Privacy Policy

**Effective: July 2026**

## The short version

Everything stays in your browser. TrueTabs makes **no network requests** in
its default configuration, has **no analytics, no telemetry, no accounts**,
and never sees page content.

The one exception is entirely in your hands: if you turn on Smart grouping
with **your own API key**, tab titles and domains are sent to the provider
**you** chose, using **your** key. That mode is off by default and clearly
labeled where you enable it.

## What TrueTabs stores, and where

| Data | Where | Why |
|---|---|---|
| Settings (toggles, thresholds, allowlist, language, theme) | `chrome.storage.sync` | Your preferences follow your Chrome profile |
| Archive entries: URL, title, site, group name/color, window hint, timestamp of archived tabs | `chrome.storage.local` (this device only) | So an archived tab can be searched and restored |
| Daily counters (archived/deduped today) | `chrome.storage.local` | Popup numbers |
| Group signatures (title + color + site of groups TrueTabs created) | `chrome.storage.local` | Re-recognizing its own groups after a restart |
| Your API key (only if you enable BYOK smart grouping) | `chrome.storage.local` (this device only, never synced) | Calling the provider you chose |
| Per-tab bookkeeping (ids, urls, timestamps) | `chrome.storage.session` (dies with the browser session) | Engine state |

Nothing above ever leaves your machine except in the BYOK mode described
below. Uninstalling the extension deletes all of it.

## Smart grouping modes

- **Built-in (Gemini Nano):** the model runs **on your device** via Chrome's
  built-in AI. Tab titles are processed locally and never leave the browser.
  The one-time model download is performed by Chrome itself.
- **Your own key (off by default):** tab **titles and domains** (never page
  content, never full bodies) are sent to the provider you configured -
  OpenAI, Google Gemini, xAI Grok, or your own OpenAI-compatible endpoint
  (e.g. a local Ollama). This happens only when smart grouping actually runs.
  Your key is stored only on this device and is masked in diagnostics dumps.

## Permissions, justified

| Permission | Why TrueTabs needs it |
|---|---|
| `tabs` | Read tab URLs/titles to detect duplicates, staleness and sites; close/create/move tabs on your behalf |
| `tabGroups` | Create, name, color and collapse the groups it manages |
| `storage` | Everything in the table above |
| `alarms` | The once-a-minute background heartbeat for the stale scan |
| `notifications` | The "archived N tabs - Undo" and safety-pause notices |
| `favicon` | Rendering favicons on the archive page |
| `webNavigation` | Classifying navigations (redirect chains, form posts, reloads are never deduped) |
| Optional host access (`api.openai.com`, `generativelanguage.googleapis.com`, `api.x.ai`, or your custom endpoint) | Requested at runtime ONLY when you save an API key, only for the provider you chose. Zero site access at install time. |

## Diagnostics

The "Copy diagnostics" button in settings copies a JSON dump to your
clipboard for bug reports. It contains settings, counters, engine state and
window summaries with **URLs only - no titles, no page content**, and your
API key appears only as `"set"`/`"absent"`. It is never transmitted anywhere
by the extension; you decide where to paste it.

## Contact

Questions: open an issue at https://github.com/datysho/truetabs/issues.
