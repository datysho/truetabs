# CLAUDE.md

TrueTabs - Chrome MV3 extension that keeps the tab strip organized: grouping by rules/domains/AI, directed dedup, stale-tab archive with undo, one layout engine ("groups at front" + group/tab order). Store package is built from `extension/`.

## Commands

- Test: `cd test && npm test` - run TWICE before any merge or release (flake control); 79 e2e contracts against real Chrome for Testing. Filter one test: `ONLY="substring" npm test`; watch it live: `HEADFUL=1 npm test`.
- Assets: `cd test && node shots.mjs && node shot-social.mjs` - regenerate store screenshots and social previews from the live CSS; every file must be an exact legal CWS size (checked by machine, never by eye).
- Package: `./package.sh` - guarded build: strips the dev key, keeps a single zip in `dist/`, asserts the packaged manifest version matches source. Rebuild after ANY version bump; a stale zip is a store rejection.

## Process

Full pipeline (change classes, gates, release checklist): `~/Clemond/system/dev-process.md`.
Before dev work: read the Дистиллят of `~/Clemond/system/lessons/lessons-dev.md`; grep `~/Clemond/system/lessons/` for the symptom before fixing any bug.
Feature specs live in `docs/specs/` (project v1 spec: `docs/SPEC.md`); the spec is approved before build and is the single source across the boundary - divergence goes back into the spec, never silently improvised around.
Release: fill the "Submission checklist" in `STORE_LISTING.md`; dogfood and CWS submit are Michael's steps.

## QA invariants (non-negotiable, survive without the vault)

1. Every acceptance behavior has a named automated test; the spec's behavior-test table is the coverage report.
2. Every bugfix ships with a regression test proven to fail on the old code (red/green).
3. Platform limits (CWS 132-char descriptions, 1280x800 screenshots, quotas) live in tests, not memory.
4. Suite runs twice green before merge/release; a flake is a bug, not a re-roll.
5. Test fixtures reach real-user magnitudes (55 tabs, not 3).
6. Chronic bug classes get standing repro scripts kept runnable.

Plus: no fix without investigation (root cause + tested hypothesis); after 3 failed fixes in a row - stop, the class needs an invariant, not a fourth point-fix.

## Process overrides

None.

## Gotchas

- MV3 kills the service worker after ~30s without a `chrome.*` call - long AI work runs under the keepalive heartbeat; "work in progress" flags in `storage.session` outlive the worker and are cleared on init (lesson mv3-worker-death-mid-ai).
- `chrome.storage` get/set are not atomic - every read-modify-write of a shared key goes through the serializer (lesson selfclosed-rmw-race).
- The action popup dies synchronously on focus loss - dispatch post-action work with no `await` between (lesson popup-teardown-async).
- All layout/ordering behavior lives in the single layout engine - never add a point-optimizer beside it, it will drift into a split-brain (lessons feature-interaction-matrix, split-brain-recurrence).
- Cold start is settle-then-adopt behind the readiness gate - no auto dedup/archive/group while the session restores (lesson mirror-cold-start-cascade).
- Engine self-op markers are set BEFORE the API call and consumed by the event they produce, on every branch; handlers judge by the event payload, not re-read state.
- Defensive automation (strikes, pauses) must be visible in the popup with one-click resume - invisible self-disabling reads as "broken" (lesson invisible-safety-reads-as-broken).
- When a feature is cut, sweep STORE_LISTING/PRIVACY/locale texts - they drift and mislead CWS reviewers (lesson store-texts-drift).
- Full lesson corpus and registry: `~/Clemond/system/lessons/` (this repo's rows mostly in lessons-dev.md).
