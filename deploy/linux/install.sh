#!/usr/bin/env bash
# ElectronIx Tool Store — install or upgrade on a Linux server PC (M9).
#
# Idempotent: safe to re-run. Re-running is how you upgrade a hand-copied
# build; for a released version use `store-cli update --apply` instead
# (OTA-SETUP.md).
#
# Usage:
#   sudo ./install.sh [--dir /opt/electronix-store] [--no-start]
#
# What it does NOT do: install or configure PostgreSQL. A tool crib's database
# is the one thing that should be set up deliberately, with a backup target and
# a password somebody chose, rather than by a script guessing.

set -euo pipefail

INSTALL_DIR=/opt/electronix-store
CONFIG_DIR=/etc/electronix-store
BACKUP_DIR=/var/backups/electronix-store
SERVICE_USER=electronix
START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run this with sudo." >&2
  exit 1
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The binaries may sit next to this script (a release tarball) or up in
# target/release (a source checkout). Accept either rather than making somebody
# copy files around first.
find_binary() {
  local name="$1"
  for candidate in "$here/$name" "$here/../../target/release/$name" "$here/../$name"; do
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  done
  echo "error: cannot find $name. Build it first (cargo build --release) or run this from the release tarball." >&2
  exit 1
}

SERVER_BIN="$(find_binary store-server)"
CLI_BIN="$(find_binary store-cli)"

echo "==> installing from"
echo "    server: $SERVER_BIN"
echo "    cli:    $CLI_BIN"

# ── Service account ─────────────────────────────────────────────────────
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> creating the $SERVICE_USER system user"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
else
  echo "==> $SERVICE_USER already exists"
fi

# ── Directories ─────────────────────────────────────────────────────────
install -d -o root -g root -m 0755 "$INSTALL_DIR"
install -d -o root -g "$SERVICE_USER" -m 0750 "$CONFIG_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$BACKUP_DIR"

# ── Binaries ────────────────────────────────────────────────────────────
#
# Stop first if it is running: replacing a binary under a live process is how
# you get a half-updated server that nobody can explain.
if systemctl is-active --quiet store-server 2>/dev/null; then
  echo "==> stopping store-server for the swap"
  systemctl stop store-server
  WAS_RUNNING=1
else
  WAS_RUNNING=0
fi

# The previous binary is kept, exactly as the OTA updater does, so a rollback
# is one rename either way.
if [ -f "$INSTALL_DIR/store-server" ]; then
  mv -f "$INSTALL_DIR/store-server" "$INSTALL_DIR/store-server.old"
fi

install -o root -g root -m 0755 "$SERVER_BIN" "$INSTALL_DIR/store-server"
install -o root -g root -m 0755 "$CLI_BIN" "$INSTALL_DIR/store-cli"
ln -sf "$INSTALL_DIR/store-cli" /usr/local/bin/store-cli

# ── Configuration ───────────────────────────────────────────────────────
ENV_FILE="$CONFIG_DIR/server.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "==> writing $ENV_FILE"
  # A generated secret beats a placeholder somebody forgets to change.
  SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "$ENV_FILE" <<CONF
# ElectronIx Tool Store — server configuration.
#
# Changed anything here? systemctl restart store-server

# Postgres. Create the database and role yourself; this file only points at it.
DATABASE_URL=postgres://electronix:CHANGE_ME@localhost/electronix_store

# What the door terminal pushes to, and what the tablets talk to. One port for
# both — the terminal is configured with a single server address.
STORE_LISTEN=0.0.0.0:8080

# Typed once on each phone or tablet during setup. Anyone with this can enrol a
# terminal, so treat it like a password.
STORE_ENROLMENT_SECRET=$SECRET

# info is right for a shop floor. Use debug when chasing a device problem.
RUST_LOG=info,sqlx=warn
CONF
  chown root:"$SERVICE_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  NEEDS_CONFIG=1
else
  echo "==> keeping the existing $ENV_FILE"
  NEEDS_CONFIG=0
fi

# ── systemd ─────────────────────────────────────────────────────────────
echo "==> installing systemd units"
for unit in store-server.service store-backup.service store-backup.timer; do
  install -o root -g root -m 0644 "$here/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable store-server.service store-backup.timer >/dev/null

# ── Start ───────────────────────────────────────────────────────────────
if [ "$NEEDS_CONFIG" -eq 1 ]; then
  cat <<'MSG'

==> Almost there.

    Edit /etc/electronix-store/server.env and set DATABASE_URL, then:

        sudo systemctl start store-server

    The server migrates the database on boot, so there is no separate step.
MSG
elif [ "$START" -eq 1 ] || [ "$WAS_RUNNING" -eq 1 ]; then
  echo "==> starting store-server"
  systemctl start store-server
  sleep 2
  if systemctl is-active --quiet store-server; then
    echo "==> running"
  else
    echo "error: it did not start. journalctl -u store-server -n 50" >&2
    exit 1
  fi
fi

cat <<MSG

Installed to $INSTALL_DIR
  config   $CONFIG_DIR/server.env
  backups  $BACKUP_DIR (nightly at 02:15, kept 14 days)

Next:
  Terminal   open http://<this-machine>:8080 on a phone and enrol it with
             STORE_ENROLMENT_SECRET from the config file
  Door       point the terminal's ADMS server address at this machine, port 8080
  Check      store-cli reconcile
  Updates    store-cli update --check          (see OTA-SETUP.md)
  Logs       journalctl -u store-server -f
MSG
