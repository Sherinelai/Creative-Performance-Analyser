#!/usr/bin/env python3
"""Write a Markdown subset into a Google Doc, replacing its whole body.

    ./python-virtual-environment/bin/python3 tools/docs_write.py <docId> <file.md>

Supported: `#`/`##`/`###` headings, `- ` bullets, `**bold**`, `` `code` `` (monospace), blank
lines, plain paragraphs. Everything else is inserted verbatim, so an unsupported construct shows
up as literal text rather than silently disappearing.

Index math note: all styling requests are issued AFTER one insertText and none of them change the
text length, so every range stays valid within the single batchUpdate. Keep that property if you
extend this — inserting text mid-batch shifts every later index.

Needs auth/docs-token.json (see tools/docs_auth.py).
"""
from __future__ import annotations

import pathlib
import re
import sys

from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2.credentials import Credentials

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKEN = ROOT / "auth" / "docs-token.json"
SCOPES = ["https://www.googleapis.com/auth/documents"]
MONO = "Courier New"

HEADINGS = {1: "HEADING_1", 2: "HEADING_2", 3: "HEADING_3", 4: "HEADING_4"}


def parse_inline(line: str) -> tuple[str, list[tuple[int, int, str]]]:
    """Strip ** and ` markers, returning the clean line and (start, end, kind) spans."""
    out, spans = [], []
    i, n = 0, len(line)
    open_bold = open_code = None
    while i < n:
        if line.startswith("**", i):
            if open_bold is None:
                open_bold = len(out)
            else:
                spans.append((open_bold, len(out), "bold"))
                open_bold = None
            i += 2
            continue
        if line[i] == "`":
            if open_code is None:
                open_code = len(out)
            else:
                spans.append((open_code, len(out), "code"))
                open_code = None
            i += 1
            continue
        out.append(line[i])
        i += 1
    return "".join(out), spans


def build(md: str) -> tuple[str, list[dict]]:
    """Return (full text, style requests) for a document whose body starts at index 1."""
    lines: list[tuple[str, str, list[tuple[int, int, str]]]] = []  # (text, kind, spans)
    for raw in md.splitlines():
        m = re.match(r"^(#{1,4})\s+(.*)$", raw)
        if m:
            text, spans = parse_inline(m.group(2))
            lines.append((text, f"H{len(m.group(1))}", spans))
        elif raw.startswith("- "):
            text, spans = parse_inline(raw[2:])
            lines.append((text, "BULLET", spans))
        else:
            text, spans = parse_inline(raw)
            lines.append((text, "P", spans))

    requests: list[dict] = []
    pos = 1
    bullet_runs: list[tuple[int, int]] = []
    run_start: int | None = None
    for text, kind, spans in lines:
        start, end = pos, pos + len(text) + 1  # + the newline that ends the paragraph
        if kind.startswith("H"):
            requests.append({"updateParagraphStyle": {
                "range": {"startIndex": start, "endIndex": end},
                "paragraphStyle": {"namedStyleType": HEADINGS[int(kind[1])]},
                "fields": "namedStyleType"}})
        if kind == "BULLET":
            run_start = start if run_start is None else run_start
        elif run_start is not None:
            bullet_runs.append((run_start, start))
            run_start = None
        for s, e, span_kind in spans:
            if s == e:
                continue
            style = ({"bold": True}, "bold") if span_kind == "bold" else \
                    ({"weightedFontFamily": {"fontFamily": MONO}}, "weightedFontFamily")
            requests.append({"updateTextStyle": {
                "range": {"startIndex": start + s, "endIndex": start + e},
                "textStyle": style[0], "fields": style[1]}})
        pos = end
    if run_start is not None:
        bullet_runs.append((run_start, pos))

    # Bullets last: createParagraphBullets adds no characters, so ranges computed above hold.
    for s, e in bullet_runs:
        requests.append({"createParagraphBullets": {
            "range": {"startIndex": s, "endIndex": e},
            "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE"}})

    return "".join(t + "\n" for t, _, _ in lines), requests


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    doc_id, src = sys.argv[1], pathlib.Path(sys.argv[2])
    creds = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
    if not creds.valid:
        creds.refresh(Request())
    session = AuthorizedSession(creds)
    base = f"https://docs.googleapis.com/v1/documents/{doc_id}"

    doc = session.get(base)
    doc.raise_for_status()
    end = doc.json()["body"]["content"][-1]["endIndex"]

    text, style_requests = build(src.read_text(encoding="utf-8"))
    # Surrogate pairs would make Python's code-point offsets disagree with the API's UTF-16 ones.
    assert all(ord(ch) < 0x10000 for ch in text), "text contains non-BMP characters"

    requests: list[dict] = []
    if end > 2:  # there is existing body content to clear (the final newline is not deletable)
        requests.append({"deleteContentRange":
                         {"range": {"startIndex": 1, "endIndex": end - 1}}})
    requests.append({"insertText": {"location": {"index": 1}, "text": text}})
    requests.extend(style_requests)

    r = session.post(f"{base}:batchUpdate", json={"requests": requests})
    if r.status_code != 200:
        print(f"HTTP {r.status_code}\n{r.text[:2000]}", file=sys.stderr)
        return 1
    print(f"wrote {len(text)} chars, {len(requests)} requests -> {doc.json()['title']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
