---
description: Lint + smoke test + commit + push the current changes
argument-hint: <commit message>
---

End-of-sprint flow. Treat `$ARGUMENTS` as the commit summary line.

1. **Lint** — fail fast:
   - `python3 -c "import ast; ast.parse(open('app.py').read())"`
   - `python3 -c "import ast; ast.parse(open('auto_planner.py').read())"`
   - `node --input-type=module --check < static/js/generate.js`
   - `node --check static/js/workers/*.js static/js/worker-bridge.js`

2. **Code review** — spawn `code-reviewer` sub-agent. If it returns
   NEEDS FIX, stop and report the findings; do NOT commit.

3. **Smoke test** — spawn `smoke-tester`. If it reports FAIL, stop and
   show the failure; do NOT commit.

4. **Show diff** — `git diff --stat` then ask the user to confirm the
   scope is what they expect. Wait for confirmation before continuing.

5. **Commit** — stage only files actually changed in this session.
   Never `git add -A` (avoids staging .pyc, .DS_Store, etc.). Use a
   HEREDOC body that follows the project's commit style: one-line
   summary = `$ARGUMENTS`, followed by 2-4 bullet "why" lines, plus
   the Claude session footer.

6. **Push** — `git push -u origin claude/motioncut-video-editor-nZFMP`.
   On network error, retry up to 4× with exponential backoff (2 s, 4 s,
   8 s, 16 s).

7. **Report** — final SHA + lines changed + which files.

$ARGUMENTS
