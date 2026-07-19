# Spec: Settings platform - cross-browser sync hardening + export/import

Class: feature · Advisor score: 8/10 - sync itself has shipped since v1.0 (settings + custom groups live in `storage.sync`); this spec fixes the one real cross-version hazard, adds the missing escape hatch (file export/import), and finally SAYS it to the user · Approval: pending (batch 2026-07-19)

## Goal block
- What must exist: (1) settings written by a NEWER version on one machine survive a write from an OLDER version on another machine (forward-compat merge); (2) options page offers Export to a JSON file and Import from one, with BYOK key excluded unless explicitly opted in; (3) README + options footer state plainly that settings sync via Chrome Sync.
- How we verify: e2e - a settings object carrying unknown future keys passes through `ui:setSetting` with the unknown keys intact; export-wipe-import round-trip restores settings + custom groups exactly; exported blob contains no `byokKey` by default.
- Do not touch: what lives where (BYOK key stays `storage.local` only - that IS the safe-sync design; archive stays local; session stays session); sync quota guards (customGroups 7000-byte cap); `ui:setSetting` single-writer contract.
- Stop/pause when: any temptation to sync the BYOK key or archive; any second writer path appearing.

## Question round
| Question | Customer answer |
|---|---|
| - | No questions: customer asked to "think through" safe sync (п.3) and export/import (п.5); design decisions recorded here, flagged in the batch digest: key excluded from export by default (opt-in checkbox with warning), archive not exported in v1. |

## Scope and non-goals
- In scope: forward-compat merge on every settings write-back; export/import UI in options; import validation through the existing normalizers; docs (README, options footer, PRIVACY line for the export file).
- Non-goals: archive export (data, not settings - candidate for a later "archive backup" feature); per-device setting overrides (no current need); sync conflict UI (Chrome last-write-wins per key is acceptable at our write rates); import of foreign/competitor formats.

## Design
Forward-compat merge (the hazard): `normalizeSettings` validates against DEFAULTS and drops unknown keys; today a full-object write from an old version erases keys a newer version added, and sync propagates the loss. Fix - one write helper `writeSettings(patch)`: read raw stored object, overlay the normalized known keys, PRESERVE unknown keys verbatim (they belong to a newer schema), write through the serializer. All writers (`ui:setSetting`, install migrate, import) go through it. Reads stay normalize-on-read (unknown keys invisible to logic). `migrate-settings` on install keeps pruning RETIRED keys (rename map) - retired is a known set, unknown is not pruned.

Export (options page - long-lived tab, no popup-teardown hazard):
- Button "Export settings" - JSON blob download `truetabs-settings-<version>-<date>.json`:
  `{ format: "truetabs-settings", schema: 1, version, exportedAt, settings, customGroups }` - settings normalized, minus `byokKey` (never stored in settings anyway) and with `byokBaseUrl` included (it is a preference, not a secret).
- Checkbox "Include API key" (default off) with warning text "The file will contain your key in plain text"; when on, adds `byokKey` from `storage.local`.
- PRIVACY.md: export happens only on click, the file never leaves the machine by our doing, key only when opted.

Import:
- File input - parse, require `format === "truetabs-settings"`; run `normalizeSettings` / `normalizeCustomGroups` over payload; show a confirm summary (N settings, M rules, key present yes/no); on confirm - single engine op `ui:importSettings` (serialized): `writeSettings(known)`, `ui:customGroups:set` path with existing size guard, `byokKey` written to local only if present AND the confirm had a second explicit checkbox ticked.
- Reject with a readable message on: wrong format marker, unparseable JSON, oversize (> 64 KB defensive cap).
- After import both pages repaint from the engine answer (existing single-writer contract).

Docs (the "say it" part): README section "Sync between browsers" - what syncs (preferences, My groups, protected list), what never syncs (API key, archive, per-session state), that Chrome Sync must be on; options footer one-liner with the same fact. This closes п.3 verbatim.

## Interaction matrix
| Existing feature | Intersection | Resolution |
|---|---|---|
| `ui:setSetting` single writer | New writers appear | Export reads only; import routes through the same engine ops; `writeSettings` is a helper inside the writer, not a second writer |
| customGroups 7000-byte guard | Import can exceed | Same guard rejects with the same message |
| `pairGrouping` coupling | Import sets an incoherent pair | Import applies through normalize + the same pairing pass `ui:setSetting` uses (one rule, one place) |
| BYOK optional host permissions | Imported provider without granted origin | Existing runtime-request flow on next use; import does not request permissions itself (no gesture) - options shows the usual "grant" state |
| Sync (Chrome) | Import on machine A propagates | By design - import IS a settings write; documented |
| protectedGroups (nav-rehome spec) | New key rides sync + export | Included in both automatically via DEFAULTS |
| Update applier | Reload mid-import | Import is one serialized job; queue-idle gate on the applier means no interleave |

## Data deltas
- No new persisted keys. New engine op `ui:importSettings`. Export format v1 as above (documented in the file itself via `schema: 1`).

## Edge cases (with resolutions)
- Import of a file exported by a NEWER version: unknown settings keys preserved by `writeSettings` (dormant until update), unknown top-level sections ignored, `schema > 1` shows "exported by a newer version; importing what this version understands".
- Import while a smart run is active: op waits in the queue like any mutation (read-only UI stays live per existing rules).
- Two machines import different files simultaneously: Chrome sync last-write-wins per key - same as any concurrent settings edit; acceptable, documented.
- Key included but target machine already has a key: confirm summary states "will replace the stored key".
- Locale: export/import strings added to all 8 locales; parity script guards (existing).

## Behavior-test table
| Behavior | Test name |
|---|---|
| Unknown future keys survive a `ui:setSetting` write | settings: forward-compat merge preserves unknown keys |
| Export-wipe-import restores settings + rules exactly | settings: export-import round-trip |
| Export blob has no byokKey by default | settings: export excludes key by default |
| Opted export carries the key; import with second confirm writes it to local | settings: key export-import is double-opt-in |
| Import rejects wrong format marker with readable error | settings: import rejects foreign json |
| Oversized customGroups import rejected by existing guard | settings: import respects size guard |

## Build order
1. `writeSettings` merge helper + rewire writers, test 1 - done when: suite green x2.
2. Export (blob, checkbox, warning), tests 3 - done when: suite green x2.
3. Import (parse, validate, confirm, engine op), tests 2, 4-6 - done when: suite green x2.
4. Docs: README sync section, options footer line, PRIVACY export paragraph, 8-locale strings - done when: parity + store-texts sweep clean.

## Risks and open questions
- Plaintext key export is a deliberate, double-opted foot-gun; warning text carries it. Alternative (encrypted export) rejected: password UX for a v1 escape hatch is over-engineering.
- No other open questions.
