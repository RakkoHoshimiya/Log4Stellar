#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 4 || ( "$3" != web && "$3" != standalone ) || ( "$1" != docker && "$1" != podman ) ]]; then
	echo 'Usage: build.sh docker|podman RELEASE_DIRECTORY web|standalone OCI_TAG' >&2
	exit 64
fi
here=$(cd -- "$(dirname -- "$0")" && pwd -P)
release=$(realpath -e -- "$2")
node "$release/server/verify-web-release.mjs" "$release"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
context=$(mktemp -d)
trap 'rm -rf -- "$context"' EXIT
install -m 755 "$(command -v node)" "$context/node"
cp -a -- "$release" "$context/release"
mkdir "$context/container"
cp -- "$here"/{bootstrap.mjs,entrypoint.mjs,seed-admin.mjs,sandbox.py,start.sh,health.sh,converter.sh,office-preview.sh,soffice.sh} "$context/container/"
chmod -R a+rX "$context/release" "$context/container"
cp -- "$here/Dockerfile" "$context/Dockerfile"
"$1" build --build-arg "DEBIAN_MIRROR=${LOG4STELLAR_DEBIAN_MIRROR:-http://deb.debian.org}" --target "$3" --tag "$4" "$context"
