#!/usr/bin/env bash
set -euo pipefail
# The local probe connects on loopback while validating the configured HTTPS name.
origin=$LOG4STELLAR_WEB_ORIGIN
host=$(node -p 'new URL(process.argv[1]).hostname' "$origin")
port=$(node -p 'new URL(process.argv[1]).port || 443' "$origin")
ca=()
if [[ -n "${LOG4STELLAR_HEALTH_CA:-}" ]]; then
	ca=(--cacert "$LOG4STELLAR_HEALTH_CA")
elif [[ -z "${LOG4STELLAR_TLS_CERT:-}" ]]; then
	ca=(--cacert /run/log4stellar/web/server.crt)
fi
exec curl --silent --show-error --fail --noproxy '*' \
	"${ca[@]}" \
	--connect-to "$host:$port:127.0.0.1:$LOG4STELLAR_INTERNAL_PORT" "$origin/readyz" > /dev/null
