#!/usr/bin/env bash
# Runs the optional native format readers in the same style of sandbox as Office preview.
set -euo pipefail
umask 077
mode=$1
case "$mode" in doc|xls|ppt|ocr-pdf) ;; *) exit 64 ;; esac
: "${LOG4STELLAR_SEARCH_OCI_IMAGE:?Configure a pinned search sandbox image}"
: "${LOG4STELLAR_SEARCH_OCI_SOCKET:?Configure the rootless OCI socket}"
[[ "$LOG4STELLAR_SEARCH_OCI_IMAGE" =~ ^sha256:[a-f0-9]{64}$ ]]
job=$(mktemp -d "${TMPDIR:-/tmp}/log4stellar-search.XXXXXXXX")
stdin="$job/input"
container="${job##*/}"
oci=(/usr/bin/docker --host "$LOG4STELLAR_SEARCH_OCI_SOCKET")
trap '"${oci[@]}" rm -f "$container" >/dev/null 2>&1 || true; rm -rf -- "$job"' EXIT
trap 'exit 143' TERM INT
head -c 25165825 > "$stdin"
test "$(stat -c %s "$stdin")" -le 25165824
if [[ "$mode" = ocr-pdf ]]; then
	mv "$stdin" "$job/input.pdf"
else
	mv "$stdin" "$job/input.$mode"
fi
/usr/bin/timeout --kill-after=1s 14s "${oci[@]}" run --rm --name "$container" --pull never \
	--network none --read-only --cap-drop ALL --security-opt no-new-privileges \
	--pids-limit 64 --memory 512m --cpus 1 --ulimit fsize=16777216:16777216 --ulimit core=0:0 \
	--tmpfs /tmp:rw,nosuid,nodev,noexec,size=96m \
	--mount type=bind,src=/usr,dst=/usr,readonly \
	--mount type=bind,src=/etc/fonts,dst=/etc/fonts,readonly \
	--mount type=bind,src=/etc/libreoffice,dst=/etc/libreoffice,readonly \
	--mount type=bind,src="$job",dst=/job --workdir /job \
	-e HOME=/job -e LANG=C.UTF-8 -e SAL_USE_VCLPLUGIN=svp -e OMP_THREAD_LIMIT=1 \
	--entrypoint /usr/bin/bash "$LOG4STELLAR_SEARCH_OCI_IMAGE" -euo pipefail -c '
		if [[ "$1" = ocr-pdf ]]; then
			pdftoppm -f 1 -l 3 -r 150 -scale-to 2200 -gray -png input.pdf page >&2
			shopt -s nullglob
			for page in page-*.png; do
				tesseract "$page" stdout -l eng+chi_sim --psm 3
			done
		else
			soffice -env:UserInstallation=file:///job/profile --headless --nologo --norestore \
				--convert-to pdf --outdir /job "/job/input.$1" >&2
			test -s input.pdf
			pdftotext -f 1 -l 40 -enc UTF-8 -layout input.pdf -
		fi
	' bash "$mode" > "$job/text"
head -c 49152 "$job/text"
