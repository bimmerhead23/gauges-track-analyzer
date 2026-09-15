#!/bin/sh
# Restore the library from a gold .gsbak snapshot.
#
#   docker exec gauges python -m app.backup export /data/gold.gsbak
#   docker exec gauges python -m app.backup restore /data/gold.gsbak

set -e
GOLD="${GOLD:-/data/gold.gsbak}"
if [ ! -f "$GOLD" ]; then
  echo "missing gold backup: $GOLD" >&2
  exit 1
fi
exec python -m app.backup restore "$GOLD"
