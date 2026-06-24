"""
Agentic edit loop for MotionCut: Observe -> Plan -> Execute -> Verify -> Retry.

A natural-language instruction ("trim the first clip to start at 3 seconds")
is turned into a sequence of MCP tool calls, executed against the live project
document, then verified by re-observing state. If verification fails the loop
re-plans with the failure as context, up to max_iterations.

Lives at the repo root next to mcp_server.py on purpose: a `mcp_server/`
package directory would shadow the existing `mcp_server.py` module and break
`import mcp_server` everywhere. The tools layer is reused in-process — no httpx
hop, no second server — because every MCP tool already mutates
project.motioncut.json directly through app._read_doc / app._write_doc_atomic.

The Plan step calls the Anthropic SDK when ANTHROPIC_API_KEY is set; otherwise
it falls back to a deterministic rule-based planner so the loop still runs (and
is testable) in environments without a key.
"""
import inspect
import json
import os
import re
import threading
import time
import uuid

import mcp_server

MODEL = os.environ.get("MOTIONCUT_MCP_MODEL", "claude-sonnet-4-6")
MAX_ITERATIONS = int(os.environ.get("MOTIONCUT_MCP_MAX_ITERS", "3"))

PLAN_SYSTEM_PROMPT = (
    "Tu es un agent d'edition video. Tu recois un etat de projet et une "
    "instruction. Retourne un plan d'actions JSON : [{tool: str, params: dict}]. "
    "Sois minimal — seulement les actions necessaires.\n"
    "Reponds UNIQUEMENT avec le tableau JSON, sans texte autour."
)

_TASKS = {}
_TASKS_LOCK = threading.Lock()


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_task(instruction, project):
    task_id = uuid.uuid4().hex[:12]
    with _TASKS_LOCK:
        _TASKS[task_id] = {
            "task_id":         task_id,
            "status":          "running",
            "instruction":     instruction,
            "project":         project,
            "steps_completed": [],
            "result":          None,
            "error":           None,
            "created_at":      _now(),
        }
    return task_id


def get_task(task_id):
    with _TASKS_LOCK:
        t = _TASKS.get(task_id)
        return dict(t) if t else None


def _update_task(task_id, **fields):
    with _TASKS_LOCK:
        t = _TASKS.get(task_id)
        if t is not None:
            t.update(fields)


def _append_step(task_id, step):
    with _TASKS_LOCK:
        t = _TASKS.get(task_id)
        if t is not None:
            t["steps_completed"].append(step)


# ---------------------------------------------------------------------------
# Tool catalog + execution (reuse mcp_server handlers directly)
# ---------------------------------------------------------------------------

def _handler_map():
    return {t["name"]: t["handler"] for t in mcp_server.TOOLS}


def tool_catalog():
    return [
        {"name": t["name"], "description": t["description"],
         "inputSchema": t.get("inputSchema", {})}
        for t in mcp_server.TOOLS
    ]


def execute_action(action, project):
    """Run one {tool, params} action via the matching MCP handler. Returns a
    step record; never raises — failures are captured as ok=False."""
    name = (action or {}).get("tool")
    params = dict((action or {}).get("params") or {})
    handlers = _handler_map()
    handler = handlers.get(name)
    step = {"tool": name, "params": params, "ok": False}
    if handler is None:
        step["error"] = f"unknown tool: {name}"
        return step
    try:
        sig = inspect.signature(handler)
        if "project" in sig.parameters and "project" not in params and project:
            params["project"] = project
        accepted = {k: v for k, v in params.items() if k in sig.parameters}
        result = handler(**accepted)
        if isinstance(result, mcp_server.MCPResponse):
            result = {"content_items": len(result.content)}
        step["ok"] = True
        step["result"] = result
    except Exception as e:  # tools own their validation; surface the message
        step["error"] = f"{type(e).__name__}: {e}"
    return step


# ---------------------------------------------------------------------------
# PLAN — LLM planner with deterministic heuristic fallback
# ---------------------------------------------------------------------------

def _anthropic_client():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
    except ImportError:
        return None
    try:
        return anthropic.Anthropic()
    except Exception:
        return None


def plan_with_llm(instruction, clips, context_state, error_context):
    client = _anthropic_client()
    if client is None:
        return None
    user_payload = {
        "instruction":   instruction,
        "project_state": context_state,
        "clips":         clips,
        "available_tools": tool_catalog(),
    }
    if error_context:
        user_payload["previous_attempt_failed"] = error_context
    try:
        msg = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=PLAN_SYSTEM_PROMPT,
            messages=[{"role": "user",
                       "content": json.dumps(user_payload, default=str)}],
        )
        text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        return _parse_actions(text)
    except Exception:
        return None


def _parse_actions(text):
    if not text:
        return None
    text = text.strip()
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        actions = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(actions, list):
        return None
    out = []
    for a in actions:
        if isinstance(a, dict) and a.get("tool"):
            out.append({"tool": a["tool"], "params": a.get("params") or {}})
    return out or None


# --- heuristic helpers ------------------------------------------------------

_ORDINALS = {
    "first": 0, "second": 1, "third": 2, "fourth": 3, "fifth": 4,
    "1st": 0, "2nd": 1, "3rd": 2, "4th": 3, "5th": 4,
}


def _seconds_in(text):
    vals = [float(m) for m in re.findall(r"(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b", text)]
    if vals:
        return vals
    return [float(m) for m in re.findall(r"\b(\d+(?:\.\d+)?)\b", text)]


def _clip_index(text, n):
    if n <= 0:
        return None
    if "last" in text:
        return n - 1
    for word, idx in _ORDINALS.items():
        if re.search(rf"\b{re.escape(word)}\b", text):
            return idx if idx < n else None
    m = re.search(r"\bclip\s*#?\s*(\d+)\b", text)
    if m:
        idx = int(m.group(1)) - 1
        return idx if 0 <= idx < n else None
    return None


def _detect_format(text):
    if re.search(r"vertical|9:16|portrait|reel|tiktok|story|stories", text):
        return "9:16"
    if re.search(r"square|1:1", text):
        return "1:1"
    if re.search(r"16:9|horizontal|landscape|youtube|widescreen", text):
        return "16:9"
    return None


def plan_heuristic(instruction, clips, context_state, error_context):
    text = instruction.lower().strip()
    n = len(clips)

    # 1) Export / render / one-shot brief
    if re.search(r"\b(export|render|generate|make|create|produce|cut)\b.*"
                 r"\b(video|reel|edit|clip|cut|mp4|film|montage)\b", text) or \
       re.search(r"\b(make|generate)\s+me\b", text) or \
       re.search(r"^\s*(export|render)\b", text):
        params = {"brief": instruction}
        fmt = _detect_format(text)
        if fmt:
            params["format"] = fmt
        dur = _seconds_in(text)
        if dur:
            params["duration"] = int(dur[0])
        return [{"tool": "generate_edit_from_brief", "params": params}]

    # 2) Reverse / reorder
    if re.search(r"\b(reverse|flip)\b.*\b(clip|order|timeline|sequence)\b", text) or \
       re.search(r"\breverse\b", text):
        ids = [c["id"] for c in reversed(clips) if c.get("id")]
        if ids:
            return [{"tool": "reorder_clips", "params": {"clip_ids": ids},
                     "expect": {"order": ids}}]

    # 3) Speed
    m = re.search(r"(\d+(?:\.\d+)?)\s*x\b|\bspeed\s*(?:to|=)?\s*(\d+(?:\.\d+)?)", text)
    if m and re.search(r"\bspeed|faster|slower|slow|fast\b", text):
        idx = _clip_index(text, n)
        if idx is not None:
            speed = float(m.group(1) or m.group(2))
            cid = clips[idx]["id"]
            return [{"tool": "set_clip_property",
                     "params": {"clip_id": cid, "property": "speed", "value": speed},
                     "expect": {"clip_id": cid, "property": "speed", "value": speed}}]

    # 4) Trim
    if re.search(r"\b(trim|cut|start|end|begin|from)\b", text):
        idx = _clip_index(text, n)
        if idx is None and n > 0:
            idx = 0  # default to the first clip when unambiguous
        if idx is not None and n > 0:
            clip = clips[idx]
            cid = clip["id"]
            cur_in = float(clip.get("in_point") or 0.0)
            cur_out = clip.get("out_point")
            if cur_out is None:
                cur_out = clip.get("duration") or 0.0
            cur_out = float(cur_out)

            mrange = re.search(r"(?:from|between)\s+(\d+(?:\.\d+)?)\s*"
                               r"(?:seconds?|secs?|s)?\s*(?:to|and|-)\s*"
                               r"(\d+(?:\.\d+)?)", text)
            if mrange:
                in_pt, out_pt = float(mrange.group(1)), float(mrange.group(2))
            else:
                in_pt, out_pt = cur_in, cur_out
                mstart = re.search(r"(?:start(?:s|ing)?(?:\s+at)?|begin(?:s|ning)?(?:\s+at)?)\s+"
                                   r"(\d+(?:\.\d+)?)", text)
                mend = re.search(r"(?:end(?:s|ing)?(?:\s+at)?)\s+(\d+(?:\.\d+)?)", text)
                if mstart:
                    in_pt = float(mstart.group(1))
                if mend:
                    out_pt = float(mend.group(1))
                if not mstart and not mend:
                    secs = _seconds_in(text)
                    if len(secs) >= 2:
                        in_pt, out_pt = secs[0], secs[1]
                    elif len(secs) == 1:
                        # "first N seconds" / "trim to N seconds"
                        in_pt, out_pt = 0.0, secs[0]
            return [{"tool": "trim_clip",
                     "params": {"clip_id": cid, "in_point": in_pt, "out_point": out_pt},
                     "expect": {"clip_id": cid, "in_point": in_pt, "out_point": out_pt}}]

    return []


def make_plan(instruction, clips, context_state, error_context):
    actions = plan_with_llm(instruction, clips, context_state, error_context)
    if actions:
        return actions, "llm"
    return plan_heuristic(instruction, clips, context_state, error_context), "heuristic"


# ---------------------------------------------------------------------------
# VERIFY
# ---------------------------------------------------------------------------

def _close(a, b, tol=0.05):
    try:
        return abs(float(a) - float(b)) <= tol
    except (TypeError, ValueError):
        return a == b


def verify(steps, planned_actions, project, version_before):
    failed = [s for s in steps if not s.get("ok")]
    if failed:
        return {"verified": False,
                "reason": "step(s) returned an error",
                "failed": [{"tool": s["tool"], "error": s.get("error")} for s in failed]}

    if not steps:
        return {"verified": False, "reason": "planner produced no actions"}

    clips_after = {c["id"]: c for c in mcp_server.tool_list_clips(project) if c.get("id")}
    mismatches = []
    for action in planned_actions:
        expect = action.get("expect")
        if not expect:
            continue
        if "order" in expect:
            actual = list(clips_after.keys())
            wanted = expect["order"]
            if actual[:len(wanted)] != wanted:
                mismatches.append({"expected_order": wanted, "actual_order": actual})
            continue
        cid = expect.get("clip_id")
        clip = clips_after.get(cid)
        if clip is None:
            mismatches.append({"clip_id": cid, "reason": "clip not found after edit"})
            continue
        if "in_point" in expect and not _close(clip.get("in_point"), expect["in_point"]):
            mismatches.append({"clip_id": cid, "field": "in_point",
                               "expected": expect["in_point"], "actual": clip.get("in_point")})
        if "out_point" in expect and not _close(clip.get("out_point"), expect["out_point"]):
            mismatches.append({"clip_id": cid, "field": "out_point",
                               "expected": expect["out_point"], "actual": clip.get("out_point")})
        if expect.get("property") and not _close(clip.get(expect["property"]), expect.get("value")):
            mismatches.append({"clip_id": cid, "field": expect["property"],
                               "expected": expect.get("value"),
                               "actual": clip.get(expect["property"])})

    if mismatches:
        return {"verified": False, "reason": "post-state did not match plan",
                "mismatches": mismatches}

    version_after = mcp_server.get_version()
    return {"verified": True,
            "version_before": version_before,
            "version_after": version_after}


# ---------------------------------------------------------------------------
# LOOP
# ---------------------------------------------------------------------------

def run_edit_instruction(instruction, project=None, max_iterations=None, task_id=None):
    """Observe -> Plan -> Execute -> Verify, retrying up to max_iterations.
    Updates the shared task record live when task_id is given. Returns the
    final result dict."""
    max_iterations = max_iterations or MAX_ITERATIONS
    pid = (mcp_server.motioncut_app.safe_project_id(project) if project
           else mcp_server.get_active_project())

    error_context = None
    iterations = []
    planner_used = "heuristic"
    last_verification = None

    for attempt in range(1, max_iterations + 1):
        # 1. OBSERVE
        state = mcp_server.tool_get_project_context(pid)
        clips = mcp_server.tool_list_clips(pid)
        version_before = mcp_server.get_version()

        # 2. PLAN
        slim_state = {k: state.get(k) for k in
                      ("project_id", "clip_count", "segment_count",
                       "total_duration_seconds", "export_settings", "version")}
        actions, planner_used = make_plan(instruction, clips, slim_state, error_context)

        if not actions:
            last_verification = {"verified": False,
                                 "reason": "no plan could be produced for this instruction"}
            iterations.append({"attempt": attempt, "planner": planner_used,
                               "actions": [], "steps": [],
                               "verification": last_verification})
            break

        # 3. EXECUTE
        steps = []
        for action in actions:
            step = execute_action(action, pid)
            steps.append(step)
            if task_id:
                _append_step(task_id, {"attempt": attempt, **step})

        # 4. VERIFY
        last_verification = verify(steps, actions, pid, version_before)
        iterations.append({"attempt": attempt, "planner": planner_used,
                           "actions": actions, "steps": steps,
                           "verification": last_verification})

        if last_verification.get("verified"):
            break
        error_context = last_verification  # feed the failure into the next PLAN

    final_state = mcp_server.tool_get_project_context(pid)
    verified = bool(last_verification and last_verification.get("verified"))
    result = {
        "status":          "done" if verified else "error",
        "verified":        verified,
        "instruction":     instruction,
        "project":         pid,
        "planner":         planner_used,
        "iterations":      len(iterations),
        "attempts":        iterations,
        "verification":    last_verification,
        "final_version":   mcp_server.get_version(),
        "clip_count":      final_state.get("clip_count"),
    }

    if task_id:
        _update_task(task_id,
                     status="done" if verified else "error",
                     result=result,
                     error=None if verified else (last_verification or {}).get("reason"))
    return result


def start_instruction(instruction, project=None, max_iterations=None):
    """Kick the loop off on a daemon thread and return its task_id at once."""
    task_id = new_task(instruction, project)

    def _worker():
        try:
            run_edit_instruction(instruction, project=project,
                                 max_iterations=max_iterations, task_id=task_id)
        except Exception as e:
            _update_task(task_id, status="error", error=f"{type(e).__name__}: {e}")

    threading.Thread(target=_worker, daemon=True, name=f"mcp-instruct-{task_id}").start()
    return task_id
