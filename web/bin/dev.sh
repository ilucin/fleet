#!/usr/bin/env bash
# Run fleet-web in the foreground for development.
# Usage: bin/dev.sh [port]
#   Uses the shared fleet config ($FLEET_CONFIG or ~/.config/fleet/config.json);
#   without one it runs as a single local host on 127.0.0.1.
#   Env: FLEET_CONFIG, FLEET_WEB_BIND (default here: 127.0.0.1), FLEET_WEB_UI, FLEET_BIN.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-${FLEET_WEB_PORT:-7799}}"
BIND="${FLEET_WEB_BIND:-127.0.0.1}"

echo "fleet-web dev  config=${FLEET_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/fleet/config.json}  port=${PORT}"
echo "  http://${BIND}:${PORT}/"
exec env FLEET_WEB_PORT="$PORT" FLEET_WEB_BIND="$BIND" node "$WEB_DIR/server.mjs"
