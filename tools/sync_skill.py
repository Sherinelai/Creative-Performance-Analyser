#!/usr/bin/env python3
"""Compile skills/mco-creative-explainer/SKILL.md into appscript/Code.js.

The MCO knowledge has ONE source: skills/mco-creative-explainer/SKILL.md.
Apps Script cannot read a repo file, so the prose is compiled into Code.js as the
`MCO_SKILL` constant, between these markers:

    // ── BEGIN GENERATED FROM skills/mco-creative-explainer/SKILL.md — DO NOT EDIT BY HAND ──
    var MCO_SKILL = [ ... ].join('\\n');
    // ── END GENERATED ──

Run after every edit to the .md, then `clasp push -f` from appscript/:

    python3 tools/sync_skill.py            # rewrite the generated block
    python3 tools/sync_skill.py --check    # verify it is in sync (exit 1 if not)

Frontmatter and HTML comments in the .md are stripped — the model sees the prose only.
The script also checks that the numbers in MCO_RULES (Code.js) still appear in the
prose, so a threshold cannot be changed in one place and left stale in the other.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "mco-creative-explainer" / "SKILL.md"
CODE = ROOT / "appscript" / "Code.js"

BEGIN = "// ── BEGIN GENERATED FROM skills/mco-creative-explainer/SKILL.md — DO NOT EDIT BY HAND ──"
END = "// ── END GENERATED ──"


def prose(md: str) -> str:
    """Strip YAML frontmatter and HTML comments; keep the markdown body."""
    if md.startswith("---"):
        end = md.find("\n---", 3)
        if end != -1:
            md = md[md.find("\n", end + 1) + 1:]
    md = re.sub(r"<!--.*?-->", "", md, flags=re.S)
    return md.strip("\n")


def js_block(body: str) -> str:
    """Render the body as a JS array-of-lines constant."""
    lines = ["var MCO_SKILL = ["]
    for line in body.split("\n"):
        esc = line.replace("\\", "\\\\").replace("'", "\\'")
        lines.append(f"  '{esc}',")
    lines.append("  ''")
    lines.append("].join('\\n');")
    return "\n".join(lines)


def rule_numbers(code: str) -> dict[str, str]:
    """Pull the load-bearing MCO_RULES numbers out of Code.js for the drift check."""
    want = {
        "min_impressions": r"min_impressions:\s*(\d+)",
        "min_days_live": r"min_days_live:\s*(\d+)",
        "spend_share_pct": r"spend_share_pct:\s*(\d+)",
        "selection_prob_pct": r"selection_prob_pct:\s*(\d+)",
        "min_capacity_per_format": r"min_capacity_per_format:\s*(\d+)",
        "format_overlap_pct": r"format_overlap_pct:\s*([\d.]+)",
    }
    out = {}
    for key, pattern in want.items():
        m = re.search(pattern, code)
        if m:
            out[key] = m.group(1)
    return out


def check_drift(body: str, code: str) -> list[str]:
    nums = rule_numbers(code)
    warnings = []
    imps = nums.get("min_impressions")
    if imps:
        k = f"{int(imps) // 1000}K"
        if k not in body and f"{int(imps):,}" not in body:
            warnings.append(f"calibration impressions ({imps} → '{k}') not mentioned in SKILL.md")
    for key, needle in (
        ("min_days_live", lambda v: f"{v} days"),
        ("spend_share_pct", lambda v: f"{v}%"),
        ("selection_prob_pct", lambda v: f"{v}%"),
        ("min_capacity_per_format", lambda v: v),
        ("format_overlap_pct", lambda v: v),
    ):
        v = nums.get(key)
        if v and needle(v) not in body:
            warnings.append(f"MCO_RULES.{key} = {v} not found in SKILL.md prose")
    return warnings


def main() -> int:
    check_only = "--check" in sys.argv
    body = prose(SKILL.read_text(encoding="utf-8"))
    code = CODE.read_text(encoding="utf-8")

    if BEGIN not in code or END not in code:
        print(f"ERROR: generated-block markers not found in {CODE}", file=sys.stderr)
        return 2

    head, rest = code.split(BEGIN, 1)
    _old, tail = rest.split(END, 1)
    new_code = f"{head}{BEGIN}\n{js_block(body)}\n{END}{tail}"

    warnings = check_drift(body, code)
    for w in warnings:
        print(f"WARN: {w}")

    if new_code == code:
        print(f"in sync — {len(body.splitlines())} prose lines, {len(body)} chars")
        return 1 if (check_only and warnings) else 0

    if check_only:
        print("OUT OF SYNC: run `python3 tools/sync_skill.py`", file=sys.stderr)
        return 1

    CODE.write_text(new_code, encoding="utf-8")
    print(f"wrote MCO_SKILL — {len(body.splitlines())} prose lines, {len(body)} chars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
