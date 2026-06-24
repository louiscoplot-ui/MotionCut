"""
Agent 1 — Master Orchestrator.

Coordinates the five agents, persists shared memory (agent_brain.json), and
writes AGENT_REPORT.md. Reads the brain at startup so previously-fixed bugs
are not re-reported. Runs in API mode when ANTHROPIC_API_KEY is set, else in
offline mode (deterministic) so the system always produces a real report.
"""
import json
from pathlib import Path
from datetime import datetime

from _common import get_client

BRAIN_PATH = Path(__file__).parent / "memory" / "agent_brain.json"
REPORT_PATH = Path(__file__).parent / "AGENT_REPORT.md"


def load_brain() -> dict:
    if not BRAIN_PATH.exists():
        BRAIN_PATH.parent.mkdir(exist_ok=True)
        brain = {"version": 1, "runs": [], "known_bugs": [], "fixed_bugs": [],
                 "agent_scores": {}, "best_prompts": {}, "patterns_learned": []}
        BRAIN_PATH.write_text(json.dumps(brain, indent=2))
        return brain
    return json.loads(BRAIN_PATH.read_text())


def save_brain(brain: dict):
    BRAIN_PATH.write_text(json.dumps(brain, indent=2, ensure_ascii=False))


def _merge_known_bugs(brain, bugs):
    """Idempotent merge: dedup by id so re-runs never double the list."""
    by_id = {b["id"]: b for b in brain.get("known_bugs", [])}
    for b in bugs:
        by_id[b["id"]] = b
    brain["known_bugs"] = list(by_id.values())


def orchestrate(mode: str = "full"):
    brain = load_brain()
    client = get_client()
    online = client is not None

    run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    print(f"\nMotionCut Agent System — Run {run_id} — Mode: {mode} — "
          f"{'API' if online else 'OFFLINE (no ANTHROPIC_API_KEY)'}")
    print("=" * 60)

    results = {}

    if mode in ("full", "audit"):
        print("\n[1/4] Bug Hunter Agent...")
        from bug_hunter import BugHunterAgent
        results["bugs"] = BugHunterAgent(client, brain).run()
        _merge_known_bugs(brain, results["bugs"])

    if mode in ("full", "fix"):
        print("\n[2/4] Code Fixer Agent...")
        from code_fixer import CodeFixerAgent
        results["patches"] = CodeFixerAgent(client, brain).run()

    if mode in ("full",):
        print("\n[3/4] AI Integrator Agent...")
        from ai_integrator import AIIntegratorAgent
        results["ai_integration"] = AIIntegratorAgent(client, brain).run()

    if mode in ("full", "evolve"):
        print("\n[4/4] Self Evaluator + Prompt Evolver...")
        from evaluator import EvaluatorAgent
        from evolver import EvolverAgent
        scores = EvaluatorAgent(client, brain, results).run()
        results["scores"] = scores
        results["evolved_prompts"] = EvolverAgent(client, brain, scores).run()

    brain["runs"].append({
        "id": run_id, "mode": mode, "online": online,
        "timestamp": datetime.now().isoformat(),
        "bugs_found": len(results.get("bugs", [])),
        "patches_generated": len(results.get("patches", [])),
    })
    save_brain(brain)
    generate_report(run_id, results, brain, online)
    print(f"\nDone. Report: agents/AGENT_REPORT.md")
    return results


def generate_report(run_id, results, brain, online):
    bugs = results.get("bugs", brain.get("known_bugs", []))
    by = {"BLOCKING": 0, "BROKEN": 0, "DEGRADED": 0, "SILENT": 0}
    for b in bugs:
        by[b.get("severity", "SILENT")] = by.get(b.get("severity", "SILENT"), 0) + 1
    patches = results.get("patches", [])
    applied = [p for p in patches if p.get("auto_apply") and p.get("risk") == "low"]
    scores = results.get("scores", {})
    ai = results.get("ai_integration", {})
    order = {"BLOCKING": 0, "BROKEN": 1, "DEGRADED": 2, "SILENT": 3}
    top5 = sorted(bugs, key=lambda b: order.get(b.get("severity"), 9))[:5]

    prev_runs = brain.get("runs", [])
    prev_score = None
    for r in reversed(prev_runs[:-1]):
        sc = brain.get("agent_scores", {}).get(str(prev_runs.index(r)))
        if sc:
            prev_score = sc.get("global_score")
            break

    ai_status = "skipped (offline)" if ai.get("system_prompt_valid") is None \
        else ("valid" if ai.get("system_prompt_valid") else "invalid")

    lines = [
        f"# MotionCut Agent Report — {run_id}",
        "",
        f"Mode: **{'API' if online else 'OFFLINE (static analysis, no ANTHROPIC_API_KEY)'}**",
        "",
        "## Resume",
        f"- Bugs : {len(bugs)} ({by['BLOCKING']} BLOCKING, {by['BROKEN']} BROKEN, "
        f"{by['DEGRADED']} DEGRADED, {by['SILENT']} SILENT)",
        f"- Fixes appliques auto : {len(applied)}",
        f"- Fixes a review manuelle : {len(patches) - len(applied)} (voir agents/patches/)",
        f"- Score global agents : {scores.get('global_score', 'n/a')}/10",
        f"- Integration IA : {ai_status}",
        "",
        "## Top 5 bugs critiques",
        "| # | Bug ID | Fichier | Severite | Impact |",
        "|---|--------|---------|----------|--------|",
    ]
    for i, b in enumerate(top5, 1):
        lines.append(f"| {i} | {b.get('id')} | {b.get('file')}:{b.get('line')} | "
                     f"{b.get('severity')} | {str(b.get('user_impact',''))[:70]} |")
    if not top5:
        lines.append("| — | — | — | — | aucun bug detecte |")

    lines += ["", "## Fixes appliques"]
    lines += [f"- {p['bug_id']} ({p['file']}) — {p.get('explanation','')}" for p in applied] or ["- aucun"]

    lines += ["", "## A faire manuellement (agents/patches/)"]
    manual = [p for p in patches if p not in applied]
    lines += [f"- {p.get('bug_id')} — risk {p.get('risk','?')}" for p in manual] or \
             ["- voir les *_needs_api.json / *_manual.json si presents"]

    lines += ["", "## Evolution agents",
              f"Score precedent : {prev_score if prev_score is not None else 'n/a'} -> "
              f"actuel : {scores.get('global_score','n/a')}",
              f"Backlog d'evolution : {brain.get('evolution_backlog', [])}"]

    lines += ["", "## Commandes utiles",
              "`make agents` — run complete", "`make audit` — audit seulement",
              "`make fix` — fix seulement", "`cat agents/AGENT_REPORT.md` — ce rapport"]

    REPORT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
