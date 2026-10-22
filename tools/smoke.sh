#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
python3 tools/smoke.py
export XDG_DATA_HOME="$PWD/../work/gnome-smoke/data"
export XDG_CONFIG_HOME="$PWD/../work/gnome-smoke/config"
export XDG_CACHE_HOME="$PWD/../work/gnome-smoke/cache"
export GSETTINGS_BACKEND=keyfile
# These settings and the display are isolated from the user's running session.
exec timeout 13s dbus-run-session -- bash -c 'gsettings set org.gnome.shell enabled-extensions "[\"clipboard-indicator@lautilosio.github.io\"]"; gnome-shell --headless --wayland --no-x11 --virtual-monitor=1280x800'
