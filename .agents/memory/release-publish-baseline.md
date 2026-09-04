---
name: Release publish baseline
description: How to choose the correct prior publish commit when generating a release range.
---

Use the newest deployment-authored publish commit that is an ancestor of the selected main release candidate. Do not choose solely by timestamp.

**Why:** Replit can create similarly timed publish commits on different history lines. A later-timestamped sibling is not part of the candidate’s ancestry and would produce an incorrect release range.

**How to apply:** List publish commits, then verify each candidate with `git merge-base --is-ancestor <publish> <candidate>`. Use the newest qualifying ancestor as the exclusive baseline and record any excluded sibling publish commit in the report methodology.