"""
MotionCut Agent System — shared helpers.

Two execution modes:
  - API mode   : ANTHROPIC_API_KEY present + `anthropic` installed -> real
                 Claude calls (the design in the spec).
  - OFFLINE    : no key / no SDK -> deterministic local analysis so the
                 system still runs (and `make audit` produces a real report)
                 in environments without API access.

get_client() returns an anthropic.Anthropic or None. Every agent must handle
client is None by falling back to its offline path.
"""
import os


def get_client():
    """Return an anthropic client, or None when unavailable (offline mode)."""
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


def call_claude(client, *, system, user, model="claude-sonnet-4-6", max_tokens=4000):
    """Thin wrapper returning the text of the first content block, or raising.
    Centralised so a future model migration is a one-line change."""
    resp = client.messages.create(
        model=model, max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": user}],
    )
    return resp.content[0].text
