---
name: Authorization comments policy
description: CEPS distinguishes editable Comments from verbatim PDF-derived POS Notes.
---

Authorization description text is called **Comments**, and is separate from
**POS Notes**, which are copied word for word from the authorization PDF.

**Why:** CEPS explicitly made this distinction in its 2026-10-23 decision.
Changing the description label must not change what POS Notes mean.

**How to apply:** Keep the existing API/database field names and full stored
comments. Shorten only dropdown display text. Never merge Comments into POS
Notes or rewrite POS Notes to fit the Comments terminology.

When renaming an optional CSV header, retain its former header as an input alias.

**Why:** An old template can otherwise validate successfully while silently
discarding the optional comment column.

**How to apply:** New templates use the current label; older headings still map
to the same stored field. Prefer the current heading if both are supplied.
