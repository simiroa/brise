# SPDX Standard License Texts

This directory vendors official plain-text licenses from the SPDX License List data repository.

- **Source URL**: [https://github.com/spdx/license-list-data](https://github.com/spdx/license-list-data) (path `text/<ID>.txt`)
- **Version**: `v3.29.0` (SPDX License List Version 3.29.0)
- **Purpose**: Fallback license texts for dependencies without bundled license files in their package directory.

## Vendored Licenses

- `Apache-2.0.txt` — Apache License 2.0
- `BSD-2-Clause.txt` — BSD 2-Clause "Simplified" License
- `BSD-3-Clause.txt` — BSD 3-Clause "New" or "Revised" License
- `BSL-1.0.txt` — Boost Software License 1.0
- `ISC.txt` — ISC License
- `LGPL-2.1-or-later.txt` — GNU Lesser General Public License v2.1 or later
- `MIT.txt` — MIT License
- `MPL-2.0.txt` — Mozilla Public License 2.0
- `Zlib.txt` — zlib License

## Instructions

Whenever dependencies are updated, added, or removed, regenerate the third-party notices and summary by running:

```bash
npm run gen:notices
```

or directly:

```bash
node scripts/gen-notices.mjs
```

If a package without bundled license text introduces a new SPDX ID, fetch the corresponding plain text from the SPDX license list data repository, place it at `scripts/spdx-texts/<ID>.txt`, and run `npm run gen:notices`.
