---
name: GitHub push authentication
description: How to preserve local commit ancestry when Git CLI credentials fail but the connected GitHub integration works.
---

Git CLI credentials may be stale even while the connected GitHub integration has working repository write access. Do not assume an authentication failure means the integration must be reauthorized, and do not ask the user to paste a token. If using the GitHub Git Data API as a fallback, verify each blob, tree, and commit has the same object ID as the local Git object before fast-forwarding the branch; never substitute a newly authored commit.

**Why:** Deployment-generated empty commits can be ahead of the tracked remote. Recreating a merely equivalent commit with different metadata would split local and remote history, and an unverified Git API write risks pushing different contents.

**How to apply:** First try the ordinary push. If it fails authentication, check the existing connection's repository permission. Only update the remote reference after confirming the exact local ancestry and object IDs; do not force-push or expose connector credentials.

The Git Data API uses the commit message exactly as supplied, without adding the terminal newline that the local Git commit normally contains. **Why:** A byte-for-byte tree and metadata match can still produce a different commit ID if the API message omits that final newline. **How to apply:** Read the local commit object's full message, including its ending, when recreating an exact object via the API. Verify its SHA before changing any ref.

When copying a Git tree through the connector, use complete file reads and verify the remote tree SHA before creating or referencing a commit. **Why:** The code-execution shell callback can silently truncate large blob output even with a generous requested byte limit; a GitHub tree built from those strings may succeed yet contain incomplete files. **How to apply:** For UTF-8 files, use complete file reads with an explicit size cap, compare the returned tree hash to the local tree, and never move the branch unless they match. Encode commit objects without losing their final message newline.

The code-execution shell callback may remove tab separators and return CRLF line endings from Git output. **Why:** Parsing `git ls-tree` lines as tab-delimited or matching untrimmed lines led to repeated failures even though the Git objects were valid. **How to apply:** When comparing Git objects through this callback, parse the fixed-width 40-character hash and trim each line; verify every uploaded blob SHA, then the tree and commit SHA, before updating a remote ref without force.