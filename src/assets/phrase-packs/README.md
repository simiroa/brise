# Phrase packs (header band)

Schema (one JSON file per pack):

```json
{
  "name": "Display name",
  "items": [
    { "text": "Short fact or line.", "source": "optional label" }
  ]
}
```

- `name` (string, required): shown in Settings.
- `items` (array, required): each entry needs non-empty `text`; `source` is optional.
- Bundled packs live here and are imported at build time.
- User packs: drop the same schema into the app data folder `phrase_packs/*.json`
  (Settings → open data dir, or create the folder). Invalid JSON is skipped with a
  console warning — never blocks boot.

## Sources policy

Bundled items are short, verifiable facts (history / general knowledge). No AI-
generated prose. Prefer well-known textbook-level claims; attach a short `source`
label when useful (e.g. domain, not a full citation).
