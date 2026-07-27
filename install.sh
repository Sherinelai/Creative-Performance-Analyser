#!/bin/bash
# Creative Performance Analyser — one-time setup.
# Creates the project venv (Python 3.14) and installs dependencies.
# Run once from the project root: bash install.sh
set -e

VENV=./python-virtual-environment
PY="$VENV/bin/python3"

if [ ! -x "$PY" ]; then
  echo "Creating venv at $VENV ..."
  uv venv "$VENV" --python 3.14
fi

echo "Installing dependencies ..."
uv pip install --python "$PY" \
  mcp looker-sdk gspread gspread-dataframe google-auth google-auth-oauthlib \
  google-cloud-bigquery db-dtypes pandas numpy pyarrow

echo
echo "Done. Next:"
echo "  1. Put your own auth/looker.ini (mint your own Looker API3 keys) + Google creds in auth/."
echo "  2. Verify: $PY -c \"import creative_mcp as m; print(m.list_trino_connections())\""
echo "  3. The creative-mcp server auto-registers via .mcp.json in Claude Code."
