#!/usr/bin/env bash
set -euo pipefail
umask 077
if ! mountpoint -q /data; then
	echo 'Mount a dedicated persistent volume or host directory at /data.' >&2
	exit 1
fi
# LibreOffice uses job-local IPC when the shared temp paths are read-only.
chmod 0755 /tmp /var/tmp
exec flock --nonblock --no-fork /data/.log4stellar.lock node /opt/log4stellar/container/entrypoint.mjs
