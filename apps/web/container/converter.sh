#!/usr/bin/env bash
set -euo pipefail
mode=$1
shift
sandbox=/opt/log4stellar/container/sandbox.py
case "$mode" in
preview)
	exec /usr/bin/python3 -I "$sandbox" "$(pwd -P)" /usr/bin/bash /opt/log4stellar/container/soffice.sh "$@"
	;;
ocr-pdf|doc|xls|ppt)
	job=$(mktemp -d /data/cache/search-XXXXXXXX)
	trap 'rm -rf -- "$job"' EXIT
	trap 'exit 143' INT TERM
	if [[ "$mode" == ocr-pdf ]]; then input=input.pdf; else input=input.$mode; fi
	head -c 25165825 > "$job/$input"
	test "$(stat -c %s "$job/$input")" -le 25165824
	/usr/bin/timeout --kill-after=1s 14s /usr/bin/python3 -I "$sandbox" "$job" /usr/bin/bash -eu -c '
		if [[ "$1" == ocr-pdf ]]; then
			pdftoppm -f 1 -l 3 -r 150 -scale-to 2200 -gray -png input.pdf page
			for page in page-*.png; do tesseract "$page" stdout -l eng+chi_sim; done
		else
			/usr/bin/bash /opt/log4stellar/container/soffice.sh -env:UserInstallation=file://"$PWD"/profile --headless --nologo --norestore \
				--convert-to pdf --outdir "$PWD" "input.$1" >&2
			pdftotext -f 1 -l 40 -enc UTF-8 -layout input.pdf -
		fi
	' bash "$mode" > "$job/text"
	head -c 49152 "$job/text"
	;;
*) exit 64 ;;
esac
