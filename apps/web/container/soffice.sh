#!/usr/bin/env bash
set -u
# The launcher expects a writable shared temp directory. The conversion job
# instead supplies its own pipe directory and uses the actual office process.
office=/usr/lib/libreoffice/program/soffice.bin
"$office" -env:OSL_SOCKET_PATH=. "$@"
status=$?
# A fresh LibreOffice profile can request one restart during initialization.
if [[ $status == 81 ]]; then
	exec "$office" -env:OSL_SOCKET_PATH=. "$@"
fi
exit "$status"
