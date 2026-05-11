#!/usr/bin/env bash
# Install chess-server deploy artifacts into the system.
# Run as root from the repo root: sudo bash deploy/install.sh
# Idempotent — safe to re-run after editing the unit file.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "error: must be run as root (try: sudo bash deploy/install.sh)" >&2
    exit 1
fi

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing from $DEPLOY_DIR"

echo "--> systemd unit"
install -m 0644 "$DEPLOY_DIR/chess-server.service" /etc/systemd/system/chess-server.service
systemctl daemon-reload

echo "--> enabling service"
systemctl enable chess-server

echo
echo "Done. Next steps if this is a first install:"
echo "  sudo systemctl start chess-server"
echo "  sudo systemctl status chess-server"
echo
echo "Sudoers rule for the deploy user (one-time, manual):"
echo "  sudo visudo -f /etc/sudoers.d/neonchess"
echo "  add: neonchess ALL=(root) NOPASSWD: /bin/systemctl restart chess-server, /bin/systemctl is-active chess-server"
echo
echo "After editing the unit file, re-run this script then:"
echo "  sudo systemctl restart chess-server"
