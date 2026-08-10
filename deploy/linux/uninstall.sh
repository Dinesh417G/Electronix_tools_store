#!/usr/bin/env bash
# ElectronIx Tool Store — remove the service from a Linux server PC.
#
# Deliberately leaves the database and the backups alone. Removing the software
# is not the same decision as destroying the shop's inventory history, and a
# script that conflates them is a script that will one day be run in a hurry.

set -euo pipefail

INSTALL_DIR=/opt/electronix-store
CONFIG_DIR=/etc/electronix-store
BACKUP_DIR=/var/backups/electronix-store

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run this with sudo." >&2
  exit 1
fi

echo "==> stopping and disabling"
systemctl disable --now store-server.service store-backup.timer 2>/dev/null || true
systemctl stop store-backup.service 2>/dev/null || true

echo "==> removing units"
rm -f /etc/systemd/system/store-server.service \
      /etc/systemd/system/store-backup.service \
      /etc/systemd/system/store-backup.timer
systemctl daemon-reload

echo "==> removing binaries"
rm -f /usr/local/bin/store-cli
rm -rf "$INSTALL_DIR"

cat <<MSG

Removed the service and its binaries.

Left alone, on purpose:
  $CONFIG_DIR      (your enrolment secret and database URL)
  $BACKUP_DIR      (the shop's inventory history)
  the PostgreSQL database itself

Delete those by hand if you really mean to. Take a final backup first:
  store-cli backup --out-dir ~/final-backup
MSG
