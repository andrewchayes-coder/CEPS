---
name: PDF Indic font coverage
description: Why embedded PDF font regression coverage must include an Indic script.
---

Keep an Indic-script extraction case when updating embedded PDF fonts or fontkit.

**Why:** The installed pdf-lib fontkit build renders Latin and CJK without
exercising its Indic shaping state machine. Punjabi text exposed an undeclared
regenerator runtime requirement that Latin-only tests and typechecks missed.

**How to apply:** Do not consider a font/runtime dependency update verified with
Latin or CJK alone. Verify Punjabi extraction and the built-server PDF download,
not just the unbundled source implementation.
