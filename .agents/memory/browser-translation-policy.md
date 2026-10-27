---
name: CEPS browser translation policy
description: Browser translation instead of translated portal pages and how record data is protected.
---

CEPS decided on 2026-10-23 that families will use their browser's built-in
translation (Chrome, Safari, Edge). Keep the document language English so the
browser offers translation; do not add portal translation files or a language
switcher.

**Why:** Marie and Hannah are checking Spanish and Mandarin on key pages; CEPS
chose the browser approach rather than maintaining translated portal copy.

**How to apply:** Keep interface labels, help, headings, buttons, and messages
translatable, but mark record data (names, identifiers, service codes, amounts,
dates, contacts, addresses) with `translate="no"` and `notranslate`. Browser
translators can replace React-owned text nodes with `<font>`; maintain the
detached-node guard in the portal startup and simulate a translator during
browser verification. Avoid changing canonical values used in forms, filters
and exports merely to protect their presentation.
