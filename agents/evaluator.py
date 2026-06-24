"""
Agent 5a — Evaluator. Scores each agent's output 0-10.

API mode: Claude judges the run. Offline mode: a transparent heuristic from
the run's own counts (bugs found, patches, AI validity) so a numeric score is
always produced and the evolve loop has a signal.
"""
import json

from _common import call_claude

EVAL_PROMPT = """
Tu es un evaluateur expert de systemes d'agents IA. Evalue chaque output sur 0-10.
Reponds UNIQUEMENT en JSON :
{"scores":{"bug_hunter":{"score":8.5,"strengths":[],"weaknesses":[]},
"code_fixer":{"score":7.0,"strengths":[],"weaknesses":[]},
"ai_integrator":{"score":9.0,"strengths":[],"weaknesses":[]}},
"global_score":8.2,"improvement_priority":["code_fixer"]}
"""


class EvaluatorAgent:
    def __init__(self, client, brain, results):
        self.client = client
        self.brain = brain
        self.results = results

    def _heuristic(self) -> dict:
        bugs = self.results.get("bugs", [])
        patches = self.results.get("patches", [])
        ai = self.results.get("ai_integration", {})
        bug_score = 7.0 if bugs else 4.0
        fix_score = min(9.0, 5.0 + len(patches)) if patches else 3.0
        ai_valid = ai.get("system_prompt_valid")
        ai_score = 9.0 if ai_valid else (6.0 if ai_valid is None else 3.0)
        weak_fix = "Pas de patch auto en mode offline (pas de cle API)." if not patches else ""
        scores = {
            "bug_hunter": {"score": bug_score, "strengths": ["scan deterministe, ids stables"],
                           "weaknesses": ["couverture limitee sans LLM"] if self.client is None else []},
            "code_fixer": {"score": fix_score, "strengths": ["garde-fous str-replace"],
                           "weaknesses": [weak_fix] if weak_fix else []},
            "ai_integrator": {"score": ai_score, "strengths": ["artefacts generes"],
                              "weaknesses": ["validation prompt sautee (offline)"] if ai_valid is None else []},
        }
        gl = round(sum(s["score"] for s in scores.values()) / 3, 1)
        prio = sorted(scores, key=lambda k: scores[k]["score"])[:2]
        return {"scores": scores, "global_score": gl, "improvement_priority": prio,
                "mode": "heuristic"}

    def run(self) -> dict:
        if self.client is None:
            scores = self._heuristic()
        else:
            try:
                raw = call_claude(self.client, system=EVAL_PROMPT, max_tokens=2000,
                                  user=f"Evalue ces resultats:\n{json.dumps(self.results, indent=2, default=str)}")
                scores = json.loads(raw)
            except Exception as e:
                print(f"   evaluator API failed ({e}) — heuristic")
                scores = self._heuristic()
        self.brain.setdefault("agent_scores", {})[str(len(self.brain.get("runs", [])))] = scores
        print(f"   -> global score: {scores.get('global_score', '?')}/10")
        return scores
