#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 3 || ( "$1" != docker && "$1" != podman ) || ! "$3" =~ ^[0-9]+$ ]]; then
	echo 'Usage: smoke-standalone.sh docker|podman OCI_TAG UNUSED_PORT' >&2
	exit 64
fi
umask 077
engine=$1
tag=$2
port=$3
q=$(cd -- "$(dirname -- "$0")" && pwd -P)
dir=$(mktemp -d)
name=l4s-standalone-$port-$$
trap '"$engine" rm -f "$name" "$name-second" >/dev/null 2>&1 || true' EXIT
mkdir -p "$dir/data"
openssl rand -hex 24 > "$dir/password"
mount_options=
if command -v selinuxenabled >/dev/null && selinuxenabled; then
	mount_options=,z
fi
origin="https://127.0.0.1:$port"
start() {
	"$engine" run -d --name "$name" --stop-timeout 60 --publish "127.0.0.1:$port:8443" \
		-v "$dir/data:/data:rw$mount_options" -e "LOG4STELLAR_WEB_ORIGIN=$origin" "$@" "$tag" >/dev/null
}
ready() {
	for attempt in {1..75}; do
		"$engine" cp "$name:/run/log4stellar/web/server.crt" "$dir/ca.crt" 2>/dev/null || true
		if curl -fsS --noproxy '*' --cacert "$dir/ca.crt" "$origin/login" -o /dev/null 2>/dev/null; then return; fi
		if [[ $("$engine" inspect "$name" --format '{{.State.Running}}') != true ]]; then break; fi
		sleep 1
	done
	"$engine" logs "$name" >&2
	exit 1
}
start -v "$dir/password:/run/secrets/first-password:ro$mount_options" -e LOG4STELLAR_ADMIN_PASSWORD_FILE=/run/secrets/first-password
ready
export NODE_EXTRA_CA_CERTS="$dir/ca.crt"
"$engine" exec "$name" /opt/log4stellar/container/health.sh
node "$q/smoke-http.mjs" "$dir" "$origin" seed
before=$("$engine" exec "$name" sha256sum /data/config/instance.json)
if "$engine" run --name "$name-second" -v "$dir/data:/data:rw$mount_options" -e "LOG4STELLAR_WEB_ORIGIN=$origin" "$tag" > "$dir/lock-test.log" 2>&1; then
	echo 'A second instance accepted a mounted live data directory' >&2
	exit 1
fi
echo 'PASS second container refused the same data directory'
ports=$("$engine" port "$name" | cut -d' ' -f1)
test "$ports" = 8443/tcp
echo 'PASS only HTTPS is published'
"$engine" exec "$name" rm -f -- /data/config/storage-ready.json
echo "Simulating interruption immediately before the storage-ready marker"
"$engine" stop "$name" >/dev/null
"$engine" rm "$name" >/dev/null
start
ready
node "$q/smoke-http.mjs" "$dir" "$origin" check
after=$("$engine" exec "$name" sha256sum /data/config/instance.json)
test "$before" = "$after"
echo 'PASS stable initialization state without initial password after container recreation'
"$engine" exec --user 18023:18023 "$name" env TMPDIR=/data/cache LOG4STELLAR_MANAGED_TENANTS=1 \
	LOG4STELLAR_STORAGE_CONFIG=/data/web/storage.json LOG4STELLAR_AUTH_DIR=/data/web/auth \
	node /opt/log4stellar/release/server/backup-data.mjs /data/backups/acceptance --scope=full \
	--key-file=/data/web/backup.key
echo "PASS container encrypted backup. Remove the disposable fixture directory after reviewing: $dir"
