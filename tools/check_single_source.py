#!/usr/bin/env python3
"""Fail if duplicated knowledge has been re-introduced into the Apps Script files.

The MCO rules, the inventory-group mapping, the metric definitions and the Claude call
each have exactly one home (see CLAUDE.md → "The MCO grouping contract"). This script is
the guard: it looks for the specific shapes those duplicates took before they were
collapsed, so a well-meaning edit can't quietly recreate one.

    python3 tools/check_single_source.py      # exit 1 on any violation

Add a rule here whenever you collapse a new duplicate — the check is the thing that keeps
the property true over time.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CODE = ROOT / "appscript" / "Code.js"
DASH = ROOT / "appscript" / "Dashboard.html"

# (file, regex, why it's wrong / what to use instead)
FORBIDDEN: list[tuple[Path, str, str]] = [
    (DASH, r"'[a-z]+-(?:portrait|landscape)-vast(?:-\d+s)?':",
     "inventory-format mapping literal — read MCO_GROUP_MAP from getConfig() instead"),
    (DASH, r"\bALL_DN\s*=\s*\[\s*'",
     "hardcoded group list — ALL_DN is filled from CFG.keyFormats"),
    (DASH, r"\b25000\b|\b25K\b",
     "calibration threshold literal — use mcoRules().calibration.min_impressions"),
    (DASH, r"diff\s*>=\s*\d+",
     "freshness threshold literal — use TH('FRESHNESS_DAYS')"),
    (DASH, r"flipCols",
     "cost-metric list — use isCostMetric(key), backed by CFG.metrics"),
    (DASH, r"isCpa\s*\?\s*'RPA'",
     "primary-metric label literal — use metricLabel(primaryMetricKey(campType))"),
    (DASH, r"spend_share_pct\s*<\s*\d",
     "Auto-Pauser threshold literal — use mcoRules().auto_pauser.spend_share_pct"),
    (CODE, r"claude-sonnet-4|claude-3", "outdated model id — see CLAUDE_MODEL"),
    (CODE, r"DriveApp\.getFileById",
     "runtime Drive read — the skill is compiled in by tools/sync_skill.py"),
    (CODE, r"CLIENT_ID:\s*'[^']+'",
     "credential in source — read LOOKER_CLIENT_ID from Script Properties"),
]

# (file, regex, minimum, maximum, description)
COUNTS: list[tuple[Path, str, int, int, str]] = [
    (CODE, r"api\.anthropic\.com", 1, 1, "Claude call sites (must go through callClaudeJson_)"),
    (CODE, r"var MCO_GROUP_MAP_GS\s*=", 1, 1, "inventory-group map definitions"),
    (CODE, r"var MCO_RULES\s*=", 1, 1, "MCO rule-set definitions"),
    (CODE, r"var METRICS\s*=", 1, 1, "metric-definition tables"),
    (DASH, r"\.getConfig\(\)", 1, 1, "getConfig() fetches (the one channel for server config)"),
]


def main() -> int:
    failures: list[str] = []

    for path, pattern, why in FORBIDDEN:
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(pattern, line):
                failures.append(f"{path.name}:{i}: {why}\n    {line.strip()[:120]}")

    for path, pattern, lo, hi, what in COUNTS:
        n = len(re.findall(pattern, path.read_text(encoding="utf-8")))
        if not (lo <= n <= hi):
            failures.append(f"{path.name}: found {n} {what}, expected {lo}"
                            + (f"-{hi}" if hi != lo else ""))

    sync = subprocess.run([sys.executable, str(ROOT / "tools" / "sync_skill.py"), "--check"],
                          capture_output=True, text=True)
    sys.stdout.write(sync.stdout)
    if sync.returncode != 0:
        failures.append("SKILL.md and Code.js MCO_SKILL are out of sync — run tools/sync_skill.py")

    if failures:
        print(f"\n{len(failures)} single-source violation(s):\n", file=sys.stderr)
        for f in failures:
            print(f"  ✗ {f}", file=sys.stderr)
        return 1

    print("single-source check passed — no duplicated knowledge found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
