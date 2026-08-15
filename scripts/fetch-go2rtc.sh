#!/bin/sh
#
# Download the go2rtc binary used by the integration tests into `tools/`.
#
# The integration suite (`make test-integration`) needs a real go2rtc to talk
# to. It is a single static binary, so rather than asking every developer to
# install one, this script fetches the pinned release for the current
# platform. `tools/` is gitignored.
#
# POSIX sh on purpose: this has to run on both macOS and Debian-family Linux.
#
# Usage: scripts/fetch-go2rtc.sh [version]

set -eu

VERSION="${1:-v1.9.9}"
REPO="AlexxIT/go2rtc"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
tools_dir="$repo_root/tools"
target="$tools_dir/go2rtc"

# Idempotent: an existing binary of the right version is left alone.
if [ -x "$target" ]; then
	have=$("$target" --version 2>&1 | head -n 1 || true)
	case "$have" in
	*"${VERSION#v}"*)
		echo "go2rtc $VERSION already present at $target"
		exit 0
		;;
	esac
	echo "replacing $have with $VERSION"
fi

os=$(uname -s)
arch=$(uname -m)

case "$os" in
Linux) os_part="linux" ;;
Darwin) os_part="mac" ;;
*)
	echo "unsupported OS: $os (install go2rtc manually onto PATH)" >&2
	exit 1
	;;
esac

case "$arch" in
x86_64 | amd64) arch_part="amd64" ;;
aarch64 | arm64) arch_part="arm64" ;;
armv7l | armv7) arch_part="arm" ;;
*)
	echo "unsupported architecture: $arch (install go2rtc manually onto PATH)" >&2
	exit 1
	;;
esac

asset="go2rtc_${os_part}_${arch_part}"
url="https://github.com/$REPO/releases/download/$VERSION/$asset"

mkdir -p "$tools_dir"
tmp="$target.download.$$"
# Plain rm, guarded: forced rm is disallowed by this project's environment rules.
trap '[ ! -e "$tmp" ] || rm "$tmp"' EXIT INT TERM

echo "fetching $url"
if command -v curl >/dev/null 2>&1; then
	curl -fsSL "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
	wget -q "$url" -O "$tmp"
else
	echo "neither curl nor wget is available" >&2
	exit 1
fi

chmod +x "$tmp"
mv "$tmp" "$target"
trap - EXIT INT TERM

echo "installed $("$target" --version 2>&1 | head -n 1) at $target"
