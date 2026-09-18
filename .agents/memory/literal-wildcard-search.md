---
name: Literal wildcard search
description: How broad SQL search preserves literal percent and underscore behavior across enum and JSON-backed fields.
---

Broad list searches must escape `%`, `_`, and `\`, then compare human-readable enum labels with underscores normalized to spaces. Do not include raw JSON text in a broad `ILIKE` condition when literal wildcard behavior matters; JSON keys commonly contain underscores and create false matches.

**Why:** An escaped `_` correctly stopped acting as a wildcard but still matched stored enum separators and JSON keys, so a search for a literal underscore returned unrelated records.

**How to apply:** Normalize stored enum-like values before comparison and select specific user-visible JSON properties rather than casting an entire JSON object to text.