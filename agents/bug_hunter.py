"""
Agent 2 — Bug Hunter.

API mode: sends the full codebase to Claude for a structured JSON audit.
Offline mode: a deterministic static analyzer over .py/.js that flags real,
low-false-positive patterns. Bug ids are stable (hash of file:line:rule) so
re-runs are idempotent and brain dedup works.

Never scans agents/ itself (no circular self-analysis).
"""
import hashlib
import json
import re
from pathlib import Path

from _common import call_claude

ROOT = Path(__file__).parent.parent

SYSTEM_PROMPT = """
Tu es un expert en audit de code pour MotionCut, un editeur video Flask+FFmpeg+Vanilla JS.
Stack : Flask backend, FFmpeg via subprocess, Vanilla JS frontend avec Canvas API et GSAP.
Contrat IA : EditRequest -> EditPlan. Etat : project.motioncut.json.

Reponds UNIQUEMENT en JSON valide. Pas de markdown, pas de preamble.

Format exact attendu :
{
  "bugs": [
    {"id":"BUG-001","file":"app.py","line":42,"code":"snippet","category":"UPLOAD|PLAYBACK|CANVAS|FFMPEG|STATE|ROUTE|SILENT|ENV","severity":"BLOCKING|BROKEN|DEGRADED|SILENT","user_impact":"...","cause":"...","fix_estimate_minutes":15}
  ],
  "summary": {"total_bugs":0,"blocking":0,"broken":0,"degraded":0,"silent":0,"top_3_priorities":[]}
}
"""


def _bug_id(file, line, rule):
    h = hashlib.sha1(f"{file}:{line}:{rule}".encode()).hexdigest()[:8]
    return f"BUG-{h}"


class BugHunterAgent:
    def __init__(self, client, brain):
        self.client = client
        self.brain = brain
        self.system = brain.get("best_prompts", {}).get("bug_hunter", SYSTEM_PROMPT)

    def _iter_sources(self):
        for f in sorted(ROOT.glob("**/*.py")):
            s = str(f)
            if "/agents/" in s or "__pycache__" in s:
                continue
            yield f, "python"
        for f in sorted(ROOT.glob("**/*.js")):
            s = str(f)
            if "node_modules" in s or "/agents/" in s:
                continue
            yield f, "javascript"

    def collect_codebase(self) -> str:
        parts = []
        for f, lang in self._iter_sources():
            try:
                parts.append(f"### {f.relative_to(ROOT)}\n```{lang}\n{f.read_text()}\n```")
            except Exception:
                continue
        return "\n\n".join(parts)

    # ---- offline static analysis ------------------------------------------
    def _static_scan(self):
        bugs = []

        def add(file, line, rule, code, category, severity, impact, cause):
            bugs.append({
                "id": _bug_id(file, line, rule),
                "file": file, "line": line, "code": code.strip()[:200],
                "category": category, "severity": severity,
                "user_impact": impact, "cause": cause, "fix_estimate_minutes": 10,
            })

        # Repo-level checks
        gitignore = (ROOT / ".gitignore")
        gi = gitignore.read_text() if gitignore.exists() else ""
        if ".env" not in gi:
            add(".gitignore", 1, "env-not-ignored", ".env (absent)", "ENV", "BROKEN",
                "Une cle API placee dans .env risque d'etre commitee et fuitee.",
                ".env n'est pas dans .gitignore.")
        reqs = (ROOT / "requirements.txt")
        rq = reqs.read_text() if reqs.exists() else ""
        if "python-dotenv" not in rq and "dotenv" not in rq:
            add("requirements.txt", 1, "missing-dotenv", "python-dotenv (absent)", "ENV", "DEGRADED",
                "run_agents.py importe dotenv ; sans la dep, le systeme d'agents ne demarre pas via requirements.",
                "python-dotenv absent de requirements.txt.")

        for f, lang in self._iter_sources():
            try:
                lines = f.read_text().splitlines()
            except Exception:
                continue
            rel = str(f.relative_to(ROOT))
            for i, ln in enumerate(lines, 1):
                # Silent except: pass
                if lang == "python" and re.search(r"except[^:]*:\s*pass\s*$", ln):
                    # benign if it's cleanup (unlink/close); flag others as SILENT
                    ctx = " ".join(lines[max(0, i - 3):i]).lower()
                    if not any(k in ctx for k in ("unlink", "close", "remove", "rmtree", "missing_ok")):
                        add(rel, i, "silent-except", ln, "SILENT", "SILENT",
                            "Une erreur est avalee sans trace ; bug invisible au debug.",
                            "except ...: pass sans logging.")
                # Hardcoded secret
                if re.search(r"(api_key|secret|token)\s*=\s*[\"']sk-", ln, re.I):
                    add(rel, i, "hardcoded-secret", ln, "ENV", "BLOCKING",
                        "Secret en dur dans le code source — fuite si pushe.",
                        "Cle/secret litteral au lieu de os.environ.")
                # JS bare console.error swallow / fetch without ok (light heuristic)
                if lang == "javascript" and re.search(r"catch\s*\(\s*\)\s*\{\s*\}", ln):
                    add(rel, i, "empty-catch", ln, "SILENT", "SILENT",
                        "Erreur front avalee silencieusement.",
                        "catch vide.")
        return bugs

    def _summary(self, bugs):
        by = {"BLOCKING": 0, "BROKEN": 0, "DEGRADED": 0, "SILENT": 0}
        for b in bugs:
            by[b["severity"]] = by.get(b["severity"], 0) + 1
        order = {"BLOCKING": 0, "BROKEN": 1, "DEGRADED": 2, "SILENT": 3}
        top = sorted(bugs, key=lambda b: order.get(b["severity"], 9))[:3]
        return {"total_bugs": len(bugs), "blocking": by["BLOCKING"], "broken": by["BROKEN"],
                "degraded": by["DEGRADED"], "silent": by["SILENT"],
                "top_3_priorities": [b["id"] for b in top]}

    def run(self) -> list:
        already_fixed = {b["id"] for b in self.brain.get("fixed_bugs", [])}

        if self.client is None:
            print("   (offline mode — static analyzer, no API key)")
            bugs = self._static_scan()
        else:
            try:
                raw = call_claude(
                    self.client, system=self.system, max_tokens=8000,
                    user=("Audite ce codebase MotionCut. Bugs deja fixes (ne pas re-reporter) : "
                          f"{list(already_fixed)}\n\n{self.collect_codebase()}"))
                bugs = json.loads(raw).get("bugs", [])
            except Exception as e:
                print(f"   API audit failed ({e}) — falling back to static scan")
                bugs = self._static_scan()

        new_bugs = [b for b in bugs if b["id"] not in already_fixed]
        self.brain["last_summary"] = self._summary(new_bugs)
        print(f"   -> {len(new_bugs)} bugs (after dedup vs fixed)")
        for bug in new_bugs[:5]:
            print(f"   [{bug['severity']}] {bug['id']} — {bug['file']}:{bug['line']} — {bug['user_impact'][:60]}")
        return new_bugs
