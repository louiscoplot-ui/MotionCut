#!/usr/bin/env python3
"""
MotionCut Agent System — entry point.

Usage:
  python agents/run_agents.py                 # full run
  python agents/run_agents.py --mode audit    # audit only
  python agents/run_agents.py --mode fix      # fix only
  python agents/run_agents.py --mode evolve   # self-improvement only

Without ANTHROPIC_API_KEY the system runs in OFFLINE mode (deterministic
static analysis) rather than aborting, so the audit/report still produce real
output. Set the key in .env (gitignored) to enable the LLM-driven agents.
"""
import os
import sys
from pathlib import Path

# Load .env from repo root if python-dotenv is available (optional dep).
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).parent))
from orchestrator import orchestrate  # noqa: E402


def main():
    mode = "full"
    for i, arg in enumerate(sys.argv):
        if arg == "--mode" and i + 1 < len(sys.argv):
            mode = sys.argv[i + 1]
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Note: ANTHROPIC_API_KEY not set — running in OFFLINE mode "
              "(static analysis). Add it to .env for the full LLM agents.")
    orchestrate(mode)


if __name__ == "__main__":
    main()
