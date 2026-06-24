# Reference artifact — the LIVE route is wired in app.py (/api/ai/plan).
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
    user = f"Prompt: {data['prompt']}\n\nClips: {json.dumps(data['clips'], ensure_ascii=False)}"
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
                user += f"\n\nTa reponse etait invalide ({e}). JSON pur uniquement."
                continue
            return jsonify({"error": f"plan invalide apres 2 essais: {e}"}), 500
