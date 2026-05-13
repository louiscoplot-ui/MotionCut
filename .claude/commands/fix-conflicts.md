---
description: Detect and auto-resolve git merge conflict markers
argument-hint: [keep-ours | keep-theirs]
---

Find every file with merge conflict markers and resolve them.

Default strategy: **keep-ours** (the side currently in HEAD wins).
If the user passes `keep-theirs`, take the stashed/incoming side instead.

Steps:
1. `grep -rln "^<<<<<<<" --exclude-dir=.git .`
2. For each file: read it, find each `<<<<<<< ... ======= ... >>>>>>>`
   block, keep the requested side, delete the markers.
3. Run the lint commands from CLAUDE.md to confirm syntax is clean.
4. `git status` to show the result. Do NOT commit automatically —
   the user reviews then runs `/ship` or commits manually.

If no markers are found, say so in one line and stop.

$ARGUMENTS
