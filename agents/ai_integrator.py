"""
Agent 3 — AI Integrator.

Generates the artifacts for wiring Claude into MotionCut and self-validates
the system prompt (when a key is available) by asking Claude for a plan and
asserting the JSON shape. The generated Flask + UI artifacts are written to
patches/ as reference; the live, working versions are wired into app.py
(/api/ai/plan) and static/js/ai-panel.js, adapted to the REAL editor API
(filename-based clips via /api/projects/<pid>/files, window.MC.editor).
"""
import json
from pathlib import Path

from _common import call_claude

EDITPLAN_SCHEMA = {
    "segments": [{
        "clip_id": "string — uuid/filename du clip source",
        "start": "float — secondes dans le clip",
        "end": "float — secondes dans le clip",
        "order": "int — position dans le montage final",
        "transition": "string — cut|crossfade|fadein|fadeout",
        "transition_duration": "float — secondes (defaut 0.5)",
        "overlays": [{"type": "text|logo|caption", "content": "string",
                      "position": "top-left|top-right|bottom-center|...",
                      "start": "float", "end": "float"}],
        "audio": {"mute_original": "bool", "volume": "float 0.0-1.0"},
    }],
    "output": {"resolution": "1920x1080|1280x720|1080x1920",
               "aspect_ratio": "16:9|9:16|1:1", "format": "mp4",
               "music_file": "string|null", "music_volume": "float 0.0-1.0",
               "total_duration_target": "int — secondes"},
}

AI_SYSTEM_PROMPT = """
Tu es l'IA de montage video de MotionCut. Tu generes des plans de montage professionnels.
REGLES ABSOLUES :
1. Reponds UNIQUEMENT en JSON valide. Zero markdown, zero explication, zero backtick.
2. Chaque segment : start < end, et end - start >= 1.0 seconde minimum.
3. La somme des durees (end - start) proche de output.total_duration_target.
4. Ne reference que des clip_id presents dans la liste fournie.
5. Overlays optionnels — seulement si clairement demandes.
6. "immobilier"/"real estate" : ordonne drone_wide -> exterior -> interior -> detail -> drone_outro.

SCHEMA DE REPONSE :
{schema}
""".format(schema=json.dumps(EDITPLAN_SCHEMA, indent=2, ensure_ascii=False))


class AIIntegratorAgent:
    def __init__(self, client, brain):
        self.client = client
        self.brain = brain
        self.system = brain.get("best_prompts", {}).get("ai_system", AI_SYSTEM_PROMPT)

    def validate_system_prompt(self, system_prompt: str) -> dict:
        if self.client is None:
            print("   (offline — system prompt validation skipped, no API key)")
            return {"valid": None, "note": "skipped (offline)"}
        test_clips = [
            {"id": "clip_001", "filename": "drone.mp4", "duration": 12.0, "metadata": {"shot_type": "drone"}},
            {"id": "clip_002", "filename": "salon.mp4", "duration": 8.0, "metadata": {"shot_type": "interior"}},
        ]
        try:
            raw = call_claude(self.client, system=system_prompt, max_tokens=1000,
                              user=f"Cree un reel immobilier de 15 secondes. Clips: {json.dumps(test_clips)}")
            plan = json.loads(raw)
            assert "segments" in plan and "output" in plan and len(plan["segments"]) > 0
            print("   system prompt validated (EditPlan JSON correct)")
            return {"valid": True, "plan": plan}
        except Exception as e:
            print(f"   system prompt invalid: {e}")
            return {"valid": False, "error": str(e)}

    def generate_flask_endpoint(self) -> str:
        return '''# Reference artifact — the LIVE route is wired in app.py (/api/ai/plan).
# MotionCut clips are filename-keyed; clip_id == filename in this app.
import os, json, anthropic
from flask import request, jsonify

@app.route("/api/ai/plan", methods=["POST"])
def ai_generate_plan():
    data = request.get_json(silent=True) or {}
    if "prompt" not in data or "clips" not in data:
        return jsonify({"error": "prompt et clips requis"}), 400
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return jsonify({"error": "ANTHROPIC_API_KEY non configuree"}), 503
    client = anthropic.Anthropic(api_key=key)
    SYSTEM = open("agents/patches/ai_system_prompt.txt").read()
    user = f"Prompt: {data['prompt']}\\n\\nClips: {json.dumps(data['clips'], ensure_ascii=False)}"
    for attempt in range(2):
        try:
            r = client.messages.create(model="claude-sonnet-4-6", max_tokens=2000,
                                       system=SYSTEM, messages=[{"role": "user", "content": user}])
            plan = json.loads(r.content[0].text.strip())
            for s in plan["segments"]:
                assert s["end"] > s["start"] and s["end"] - s["start"] >= 1.0
            return jsonify({"plan": plan})
        except (json.JSONDecodeError, AssertionError) as e:
            if attempt == 0:
                user += f"\\n\\nTa reponse etait invalide ({e}). JSON pur uniquement."
                continue
            return jsonify({"error": f"plan invalide apres 2 essais: {e}"}), 500
'''

    def generate_frontend_ui(self) -> str:
        # Reference copy. Live version is static/js/ai-panel.js, adapted to the
        # real editor (window.MC.editor.state, /api/projects/<pid>/files).
        return ('<!-- Reference. Live module: static/js/ai-panel.js -->\n'
                '<!-- Uses window.MC.editor.state.segments + /api/ai/plan -->\n')

    def run(self) -> dict:
        print("   generating AI integration artifacts...")
        validation = self.validate_system_prompt(self.system)
        patches_dir = Path(__file__).parent / "patches"
        patches_dir.mkdir(exist_ok=True)
        (patches_dir / "ai_plan_endpoint.py").write_text(self.generate_flask_endpoint())
        (patches_dir / "ai_panel_ui.html").write_text(self.generate_frontend_ui())
        (patches_dir / "ai_system_prompt.txt").write_text(self.system)
        print("   artifacts saved to agents/patches/")
        return {"system_prompt_valid": validation.get("valid"),
                "files_generated": ["ai_plan_endpoint.py", "ai_panel_ui.html", "ai_system_prompt.txt"]}
