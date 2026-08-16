---
name: Parallel subagents share the worktree
description: Risks when multiple subagents edit the same repo concurrently
---
Parallel subagents all edit the same working tree. One agent running `git stash` to get a clean full-suite run can strand another agent's uncommitted files in the stash (files silently vanish from the tree).

**Why:** happened during a 5-way parallel fix wave — vendor-profile page edits ended up only in a stash left by another agent; recovered via `git checkout stash@{n} -- <files>`.

**How to apply:** instruct every subagent "do NOT git stash/commit"; after a parallel wave, run `git stash list` and `git status` and reconcile before continuing. Also expect transient full-suite failures from mid-edit files of concurrent agents — re-verify serially at the end.
