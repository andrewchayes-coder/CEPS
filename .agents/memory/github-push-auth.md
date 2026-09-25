---
name: GitHub push authentication
description: How to preserve local commit ancestry when Git CLI credentials fail but the connected GitHub integration works.
---

Git CLI credentials may be stale even while the connected GitHub integration has working repository write access. Do not assume an authentication failure means the integration must be reauthorized, and do not ask the user to paste a token. If using the GitHub Git Data API as a fallback, verify each blob, tree, and commit has the same object ID as the local Git object before fast-forwarding the branch; never substitute a newly authored commit.

**Why:** Deployment-generated empty commits can be ahead of the tracked remote. Recreating a merely equivalent commit with different metadata would split local and remote history, and an unverified Git API write risks pushing different contents.

**How to apply:** First try the ordinary push. If it fails authentication, check the existing connection's repository permission. Only update the remote reference after confirming the exact local ancestry and object IDs; do not force-push or expose connector credentials.