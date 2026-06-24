"""
Agent 5b — Evolver. Rewrites the lowest-scoring agents' system prompts and
stores the winners in brain["best_prompts"]. This is the self-improvement
loop. Offline it no-ops (prompt rewriting needs the LLM) but records intent.
"""
import json

from _common import call_claude

EVOLVE_PROMPT = """
Tu es un expert en prompt engineering pour agents IA. On te donne les system
prompts actuels et leurs scores. Reecris les prompts des agents les moins
performants. Conserve les forces, corrige les faiblesses. Reponds UNIQUEMENT en JSON :
{"evolved_prompts":{"bug_hunter":"...","code_fixer":"..."},
"rationale":{"bug_hunter":"...","code_fixer":"..."}}
"""


class EvolverAgent:
    def __init__(self, client, brain, scores):
        self.client = client
        self.brain = brain
        self.scores = scores

    def run(self) -> dict:
        agents_to_improve = (self.scores or {}).get("improvement_priority", [])[:2]
        if not agents_to_improve:
            print("   no evolution needed (scores OK)")
            return {}
        if self.client is None:
            print(f"   (offline — would evolve: {agents_to_improve}; needs API key)")
            self.brain.setdefault("evolution_backlog", [])
            for a in agents_to_improve:
                if a not in self.brain["evolution_backlog"]:
                    self.brain["evolution_backlog"].append(a)
            return {}
        try:
            raw = call_claude(
                self.client, system=EVOLVE_PROMPT, max_tokens=6000,
                user=(f"Agents a ameliorer: {agents_to_improve}\n\n"
                      f"Prompts actuels: {json.dumps(self.brain.get('best_prompts', {}), indent=2)}\n\n"
                      f"Scores: {json.dumps(self.scores, indent=2)}"))
            evolved = json.loads(raw).get("evolved_prompts", {})
        except Exception as e:
            print(f"   evolver API failed: {e}")
            return {}
        for agent, new_prompt in evolved.items():
            self.brain.setdefault("best_prompts", {})[agent] = new_prompt
            print(f"   evolved prompt for {agent} stored in brain")
        return evolved
