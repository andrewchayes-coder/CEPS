---
name: Release publish baseline
description: How to choose the correct prior publish commit when generating a release range.
---

Use the newest deployment-authored publish commit on the current main ancestry. An explicitly selected candidate must descend from that baseline. Do not choose solely by timestamp.

**Why:** Replit can create similarly timed publish commits on different history lines. A later-timestamped sibling is not part of the candidate’s ancestry and would produce an incorrect release range.

**How to apply:** Walk main history to select the newest publish commit, then verify it with `git merge-base --is-ancestor <publish> <candidate>`. Use it as the exclusive baseline and reject candidates on sibling or older history lines.