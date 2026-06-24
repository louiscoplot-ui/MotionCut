"""
Agent 4 — Code Fixer.

API mode: asks Claude for exact str-replace patches per bug, auto-applies the
low-risk ones (<=5 lines, risk=low), saves the rest to patches/ for review.
Offline mode: cannot synthesise patches safely, so it records each known bug
as needing API/manual fixing (no edits applied).

Safety rails: never edits anything under agents/ (no circular self-modify);
old_code must match exactly or the patch is parked for manual review;
idempotent — a bug already in fixed_bugs is skipped.
"""
import json
from pathlib import Path

from _common import call_claude

ROOT = Path(__file__).parent.parent

FIX_PROMPT = """
Tu es un expert en debugging pour MotionCut (Flask + FFmpeg + Vanilla JS).
Pour chaque bug fourni, genere le fix en JSON strict :
{"fixes":[{"bug_id":"BUG-001","file":"app.py","old_code":"EXACT","new_code":"...","explanation":"...","risk":"low|medium|high","auto_apply":true}]}
RULES: old_code = copie EXACTE (indentation identique). auto_apply:true seulement si low risk, <5 lignes, pas de refactor. Code reel uniquement.
"""


class CodeFixerAgent:
    def __init__(self, client, brain):
        self.client = client
        self.brain = brain
        self.patches_dir = Path(__file__).parent / "patches"
        self.patches_dir.mkdir(exist_ok=True)

    def read_file(self, filepath: str) -> str:
        try:
            return (ROOT / filepath).read_text()
        except FileNotFoundError:
            return ""

    def _safe_target(self, filepath: str) -> bool:
        # Never let the fixer edit its own package.
        rel = str((ROOT / filepath).resolve())
        return "/agents/" not in rel.replace("\\", "/")

    def apply_fix(self, fix: dict) -> bool:
        if not self._safe_target(fix["file"]):
            print(f"   refused: {fix['bug_id']} targets agents/ (self-modify blocked)")
            return False
        filepath = ROOT / fix["file"]
        if not filepath.exists():
            print(f"   file not found: {fix['file']}")
            return False
        content = filepath.read_text()
        if fix["old_code"] not in content:
            (self.patches_dir / f"{fix['bug_id']}_manual.json").write_text(
                json.dumps(fix, indent=2, ensure_ascii=False))
            print(f"   target code not found in {fix['file']} for {fix['bug_id']} -> parked for review")
            return False
        filepath.write_text(content.replace(fix["old_code"], fix["new_code"], 1))
        print(f"   applied {fix['bug_id']} in {fix['file']}")
        return True

    def run(self) -> list:
        bugs = self.brain.get("known_bugs", [])
        if not bugs:
            print("   no known bugs in brain — run the Bug Hunter first.")
            return []
        already_fixed = {b["id"] for b in self.brain.get("fixed_bugs", [])}
        bugs = [b for b in bugs if b["id"] not in already_fixed]

        priority = {"BLOCKING": 0, "BROKEN": 1, "DEGRADED": 2, "SILENT": 3}
        sorted_bugs = sorted(bugs, key=lambda b: priority.get(b["severity"], 9))[:10]
        if not sorted_bugs:
            print("   nothing left to fix (all known bugs already fixed).")
            return []

        if self.client is None:
            print("   (offline mode — no patch synthesis; recording bugs for review)")
            for b in sorted_bugs:
                (self.patches_dir / f"{b['id']}_needs_api.json").write_text(
                    json.dumps({"bug": b, "note": "Run with ANTHROPIC_API_KEY to auto-generate a patch."},
                               indent=2, ensure_ascii=False))
            return []

        files_context = {}
        for bug in sorted_bugs:
            files_context.setdefault(bug["file"], self.read_file(bug["file"]))

        try:
            raw = call_claude(
                self.client, system=FIX_PROMPT, max_tokens=8000,
                user=(f"Bugs a corriger : {json.dumps(sorted_bugs, indent=2)}\n\nFichiers :\n\n" +
                      "\n\n".join(f"### {f}\n```\n{c}\n```" for f, c in files_context.items())))
            patches = json.loads(raw).get("fixes", [])
        except Exception as e:
            print(f"   fixer API failed: {e}")
            return []

        applied = []
        for fix in patches:
            (self.patches_dir / f"{fix['bug_id']}.json").write_text(
                json.dumps(fix, indent=2, ensure_ascii=False))
            if fix.get("auto_apply") and fix.get("risk") == "low":
                if self.apply_fix(fix):
                    applied.append(fix["bug_id"])
                    self.brain["fixed_bugs"] = self.brain.get("fixed_bugs", []) + [
                        {"id": fix["bug_id"], "file": fix["file"]}]
            else:
                print(f"   {fix['bug_id']} — manual review (risk: {fix.get('risk')})")
        print(f"   -> {len(applied)} auto-applied, {len(patches) - len(applied)} to review")
        return patches
