#!/usr/bin/env bash
# Runs at the start of every Claude Code session. Prints a status block
# the assistant can read to know the repo state without polling.
# Keep this fast (<1 s) and write to stdout only — exit code is ignored.

set -e
cd "$(dirname "$0")/../.."

echo "=== MotionCut SessionStart ==="
echo "branch: $(git symbolic-ref --short HEAD 2>/dev/null || echo detached)"
echo "head:   $(git log -1 --oneline 2>/dev/null || echo none)"

# 1) Working-tree state. Dirty WT often means a stash conflict — flag it.
DIRTY=$(git status --porcelain 2>/dev/null | wc -l)
if [ "$DIRTY" -gt 0 ]; then
  echo "wt:     DIRTY ($DIRTY files)"
  git status --short 2>/dev/null | head -10
else
  echo "wt:     clean"
fi

# 2) Conflict markers — the single most common bug in this repo's history.
MARKERS=$(grep -rln "^<<<<<<<\|^=======$\|^>>>>>>>" \
  --include="*.py" --include="*.js" --include="*.html" --include="*.css" \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=__pycache__ \
  . 2>/dev/null || true)
if [ -n "$MARKERS" ]; then
  echo "CONFLICT MARKERS FOUND:"
  echo "$MARKERS"
else
  echo "markers: none"
fi

# 3) Stale Flask processes — these eat ports and confuse smoke tests.
FLASK=$(pgrep -f "flask --app app run" 2>/dev/null | wc -l)
if [ "$FLASK" -gt 0 ]; then
  echo "flask:  $FLASK stale process(es) — kill with: pkill -f 'flask --app app run'"
else
  echo "flask:  no stale procs"
fi

# 4) Stash list — a leftover stash usually means an unresolved conflict
#    from a previous session.
STASHES=$(git stash list 2>/dev/null | wc -l)
if [ "$STASHES" -gt 0 ]; then
  echo "stash:  $STASHES entr(ies) — inspect with: git stash list"
fi

# 5) Quick lint of the two hot files. Cheap and catches 80% of bad pushes.
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -c "import ast; ast.parse(open('app.py').read())" 2>/dev/null; then
    echo "lint:   app.py SYNTAX ERROR"
  fi
fi
if command -v node >/dev/null 2>&1; then
  if ! node --input-type=module --check < static/js/generate.js 2>/dev/null; then
    echo "lint:   generate.js SYNTAX ERROR"
  fi
fi

echo "=== End SessionStart ==="
