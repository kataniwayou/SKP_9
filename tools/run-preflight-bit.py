"""Run the analyst's preflight BIT exam out-of-band, byte-faithful to PreflightBit.CheckAsync.

Usage:  python bit_exam.py <prompt-file>
"""
import json
import re
import sys
import textwrap
import urllib.request

REPO = r"C:/Users/UserL/source/repos/SK_P9"
BITPROMPT = REPO + "/src/Processor.Analyst/Bit/BitPrompt.cs"
APPSETTINGS = REPO + "/src/Processor.Analyst/appsettings.json"

OPEN_TAG = "<prompt-under-evaluation>"
CLOSE_TAG = "</prompt-under-evaluation>"
TOOL_NAME = "report_fitness"
TOOL_DESC = ("Report every unfit stage. An empty list means every stage is present, "
             "well-formed and consistent.")

SCHEMA = {
    "type": "object",
    "properties": {"problems": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "stage": {"type": "string",
                      "enum": ["research", "validate", "plan", "execute", "verify"]},
            "kind": {"type": "string",
                     "enum": ["missing", "malformed", "contradicting"]},
            "offending": {"type": "string"}},
        "required": ["stage", "kind", "offending"],
        "additionalProperties": False}}},
    "required": ["problems"],
    "additionalProperties": False,
}


def extract_system() -> str:
    """Pull BitPrompt.System out of the C# raw string literal, dedented as the compiler would."""
    src = open(BITPROMPT, encoding="utf-8").read()
    m = re.search(r'internal const string System = """\r?\n(.*?)\r?\n(\s*)"""\s*;',
                  src, re.S)
    if not m:
        sys.exit("could not extract BitPrompt.System")
    body, closing_indent = m.group(1), m.group(2)
    lines = [ln[len(closing_indent):] if ln.startswith(closing_indent) else ln.lstrip()
             for ln in body.split("\n")]
    return "\n".join(ln.rstrip("\r") for ln in lines)


def wrap(prompt: str) -> str:
    neutralized = (prompt
                   .replace(OPEN_TAG, r"\<prompt-under-evaluation\>")
                   .replace(CLOSE_TAG, r"\</prompt-under-evaluation\>"))
    return f"{OPEN_TAG}\n{neutralized}\n{CLOSE_TAG}"


def main() -> int:
    prompt = open(sys.argv[1], encoding="utf-8").read().strip()
    cfg = json.load(open(APPSETTINGS, encoding="utf-8"))["Analyst"]["Model"]

    body = {
        "model": cfg["ModelId"],
        "reasoning_effort": cfg["ReasoningEffort"],
        "messages": [
            {"role": "system", "content": extract_system()},
            {"role": "user", "content": wrap(prompt)},
        ],
        "tools": [{"type": "function", "function": {
            "name": TOOL_NAME, "description": TOOL_DESC, "parameters": SCHEMA}}],
    }

    req = urllib.request.Request(
        cfg["BaseUrl"].rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + cfg["ApiKey"],
                 "Content-Type": "application/json"})

    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.load(r)

    msg = out["choices"][0]["message"]
    calls = [c for c in (msg.get("tool_calls") or [])
             if c.get("function", {}).get("name") == TOOL_NAME]
    if not calls:
        print("NO report_fitness CALL -- the gate would raise AnalysisImpossibleException.")
        print((msg.get("content") or "")[:1500])
        return 2

    problems = json.loads(calls[0]["function"]["arguments"])["problems"]
    usage = out.get("usage", {})
    print(f"prompt chars: {len(prompt)}   tokens: {usage}")
    print()
    if not problems:
        print("VERDICT: FIT  -- every stage present, well-formed and consistent.")
        return 0

    print(f"VERDICT: UNFIT  ({len(problems)} problems)")
    print("summary as the pod would log it:")
    print("  " + "; ".join(f"{p['stage']}: {p['kind']}" for p in problems))
    print()
    for p in problems:
        print(f"--- {p['stage'].upper()}: {p['kind']} ---")
        print(textwrap.fill(p["offending"], 96, initial_indent="  ", subsequent_indent="  "))
        print()
    return 1


if __name__ == "__main__":
    sys.exit(main())
