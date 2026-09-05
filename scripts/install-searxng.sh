#!/usr/bin/env bash
# Install SearXNG on this machine, as a systemd service, for the agent's
# web_search tool.
#
# The other way to get search is `docker compose up`, which brings one up
# beside the portal — see docker-compose.yml. This script is for a host with no
# container runtime, which is also the case where the obvious route fails: most
# distributions still ship Python 3.9, SearXNG needs 3.10 or newer, and the
# error you get says nothing about that. It fetches its own interpreter via uv
# rather than touching system packages.
#
# Idempotent: safe to re-run to update.
#
#   sudo ./scripts/install-searxng.sh
#
set -euo pipefail

PREFIX="${SEARXNG_PREFIX:-/opt/searxng}"
CONFIG_DIR="${SEARXNG_CONFIG_DIR:-/etc/searxng}"
PYTHON_DIR="${UV_PYTHON_INSTALL_DIR:-/opt/uv-python}"
PORT="${SEARXNG_PORT:-8888}"
PYTHON_VERSION="${SEARXNG_PYTHON:-3.12}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root — it writes to $PREFIX, $CONFIG_DIR and /etc/systemd."; exit 1; }

# --- uv, for the interpreter -------------------------------------------------
if ! command -v uv >/dev/null 2>&1; then
  echo "==> installing uv"
  tmp="$(mktemp -d)"
  # The release tarball rather than the install script: piping a URL into a
  # shell is the exact shape this project's own guard refuses, and setting that
  # example in its installer would be poor form.
  curl -fsSL -o "$tmp/uv.tar.gz" \
    https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz
  tar -xzf "$tmp/uv.tar.gz" -C "$tmp"
  install -m755 "$tmp"/uv-*/uv "$tmp"/uv-*/uvx /usr/local/bin/
  rm -rf "$tmp"
fi

# Kept out of /root deliberately: the systemd unit below sets ProtectHome, so
# an interpreter under a home directory is unreachable at start and fails with
# a bare "Permission denied" that points nowhere near the cause.
export UV_PYTHON_INSTALL_DIR="$PYTHON_DIR"
mkdir -p "$PYTHON_DIR"
echo "==> installing Python $PYTHON_VERSION"
uv python install "$PYTHON_VERSION"

# --- the source --------------------------------------------------------------
if [ -d "$PREFIX/.git" ]; then
  echo "==> updating SearXNG in $PREFIX"
  git -C "$PREFIX" pull --ff-only
else
  echo "==> cloning SearXNG into $PREFIX"
  git clone --depth 1 https://github.com/searxng/searxng.git "$PREFIX"
fi

echo "==> installing dependencies"
rm -rf "$PREFIX/.venv"
(cd "$PREFIX" && uv venv --python "$PYTHON_VERSION" .venv)
VIRTUAL_ENV="$PREFIX/.venv" uv pip install \
  -r "$PREFIX/requirements.txt" -r "$PREFIX/requirements-server.txt"

# --- configuration ------------------------------------------------------------
mkdir -p "$CONFIG_DIR"
if [ -f "$CONFIG_DIR/settings.yml" ]; then
  echo "==> keeping existing $CONFIG_DIR/settings.yml"
else
  echo "==> writing $CONFIG_DIR/settings.yml"
  cat > "$CONFIG_DIR/settings.yml" <<EOF
use_default_settings: true

server:
  secret_key: "$(openssl rand -hex 32)"
  bind_address: "127.0.0.1"
  port: $PORT
  base_url: "http://127.0.0.1:$PORT/"
  # Off because this instance has exactly one caller. Leaving it on needs a
  # valkey/redis, and it exists to stop public instances being scraped.
  limiter: false
  image_proxy: false

search:
  # The line everything depends on. Every key under \`server:\` has a \$SEARXNG_*
  # environment override; nothing under \`search:\` does, and SearXNG ships with
  # html as the only format — so without this the JSON API answers 403 to every
  # request while the process looks perfectly healthy.
  formats:
    - html
    - json
  autocomplete: ""
  default_lang: "en"
EOF
  chmod 600 "$CONFIG_DIR/settings.yml"
fi

# --- service -------------------------------------------------------------------
echo "==> installing systemd unit"
cat > /etc/systemd/system/searxng.service <<EOF
[Unit]
Description=SearXNG — web search for the Phoenixclaw agent
Documentation=https://docs.searxng.org
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PREFIX
Environment=SEARXNG_SETTINGS_PATH=$CONFIG_DIR/settings.yml
Environment=PYTHONPATH=$PREFIX
Environment=PYTHONUNBUFFERED=1
ExecStart=$PREFIX/.venv/bin/python -m searx.webapp
Restart=on-failure
RestartSec=5

# It binds loopback and serves one local caller; nothing here needs privilege.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now searxng
sleep 8

if curl -fsS --max-time 25 "http://127.0.0.1:$PORT/search?q=install+check&format=json" >/dev/null 2>&1; then
  echo
  echo "SearXNG is up on http://127.0.0.1:$PORT and its JSON API answers."
  echo "Set this in the portal's environment:"
  echo
  echo "    SEARXNG_URL=http://127.0.0.1:$PORT"
else
  echo
  echo "SearXNG did not answer. Check: journalctl -u searxng -n 50" >&2
  exit 1
fi
