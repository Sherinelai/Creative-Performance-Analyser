#!/usr/bin/env python3
"""One-off: mint a Google Docs-scoped OAuth token into auth/docs-token.json.

The tokens already in auth/ are spreadsheets- and bigquery-scoped, so neither can touch a Google
Doc. This reuses the installed-app client in google-api-credentials.json and opens a browser for
consent once; after that tools/docs_write.py refreshes the saved token silently.

    ./python-virtual-environment/bin/python3 tools/docs_auth.py

auth/ is gitignored — the token never enters version control.
"""
from __future__ import annotations

import json
import pathlib
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

ROOT = pathlib.Path(__file__).resolve().parent.parent
CLIENT = ROOT / "google-api-credentials.json"
OUT = ROOT / "auth" / "docs-token.json"
SCOPES = ["https://www.googleapis.com/auth/documents"]


def main() -> int:
    if not CLIENT.exists():
        print(f"missing OAuth client secrets: {CLIENT}", file=sys.stderr)
        return 1
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT), SCOPES)
    creds = flow.run_local_server(port=0, open_browser=True,
                                  authorization_prompt_message="Consent in the browser: {url}",
                                  success_message="Docs scope granted — you can close this tab.")
    OUT.write_text(creds.to_json(), encoding="utf-8")
    print(f"wrote {OUT} for {json.loads(creds.to_json()).get('account') or 'account'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
