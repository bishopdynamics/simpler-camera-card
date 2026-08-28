#!/bin/sh
#
# Download the go2rtc binary used by the integration tests into `tools/`.
#
# The integration suite (`make test-integration`) needs a real go2rtc to talk
# to. It is a single static binary, so rather than asking every developer to
# install one, this script fetches the pinned release for the current
# platform. `tools/` is gitignored.
#
# The download is an executable pulled off the internet and then run, so it is
# verified against a SHA-256 pinned below before it is ever made executable.
# An asset with no pinned checksum is refused, not trusted.
#
# POSIX sh on purpose: this has to run on both macOS and Debian-family Linux.
#
# Usage: scripts/fetch-go2rtc.sh [version]

set -eu

VERSION="${1:-v1.9.9}"
REPO="AlexxIT/go2rtc"

# SHA-256 of every release asset this script knows how to fetch.
#
# Computed 2026-08-28 by downloading each asset from
# https://github.com/AlexxIT/go2rtc/releases/tag/v1.9.9 and hashing the bytes
# as received. To pin a new version: run this script with that version, copy
# each "expected/actual" mismatch it reports after checking the value against
# the release page, and add a case below.
checksum_for() {
	case "$1" in
	"v1.9.9 go2rtc_linux_amd64")
		echo "aca941066c816cd69f4d689bf556f924057f5087449c2fdd7d5854d9aaec8ea9"
		;;
	"v1.9.9 go2rtc_linux_arm64")
		echo "d13d4d692833d9606ac0d0e25675bba58e804f3f401e4f70761c867f38d2777a"
		;;
	"v1.9.9 go2rtc_linux_arm")
		echo "8c5a563fe8d6b8a59f5a2b48364072681e6ba0d99b75c4f3ad5d7897cc587b30"
		;;
	"v1.9.9 go2rtc_mac_amd64.zip")
		echo "b14c1fc11f97b6a594c564832a7639247f4cc553e833143f407c6f673b79511e"
		;;
	"v1.9.9 go2rtc_mac_arm64.zip")
		echo "b134146b46bb42131eee67d590bccbcc765a9199d7f661566983bbd8a455792b"
		;;
	*)
		echo ""
		;;
	esac
}

# `sha256sum` on Linux, `shasum -a 256` on macOS; both print "<hash>  <file>".
sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	else
		echo "neither sha256sum nor shasum is available; cannot verify the download" >&2
		exit 1
	fi
}

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

# The Linux assets are bare binaries; the macOS ones are zipped.
asset="go2rtc_${os_part}_${arch_part}"
if [ "$os_part" = "mac" ]; then
	asset="$asset.zip"
fi
url="https://github.com/$REPO/releases/download/$VERSION/$asset"

expected=$(checksum_for "$VERSION $asset")
if [ -z "$expected" ] && [ "${GO2RTC_ALLOW_UNVERIFIED:-0}" != "1" ]; then
	echo "no pinned SHA-256 for $asset at $VERSION; refusing to run an unverified binary." >&2
	echo "add one to checksum_for() in $0, or set GO2RTC_ALLOW_UNVERIFIED=1 to skip." >&2
	exit 1
fi

mkdir -p "$tools_dir"
tmp="$target.download.$$"
unpacked="$target.unpacked.$$"
# Existence-guarded plain rm, so no `rm -f` is needed to make cleanup quiet.
cleanup() {
	[ ! -e "$tmp" ] || rm "$tmp"
	[ ! -e "$unpacked" ] || rm "$unpacked"
}
trap cleanup EXIT INT TERM

echo "fetching $url"
if command -v curl >/dev/null 2>&1; then
	curl -fsSL "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
	wget -q "$url" -O "$tmp"
else
	echo "neither curl nor wget is available" >&2
	exit 1
fi

if [ -n "$expected" ]; then
	actual=$(sha256_of "$tmp")
	if [ "$actual" != "$expected" ]; then
		echo "checksum mismatch for $asset at $VERSION — refusing to install it." >&2
		echo "  expected $expected" >&2
		echo "  actual   $actual" >&2
		exit 1
	fi
	echo "verified sha256 $actual"
else
	echo "WARNING: GO2RTC_ALLOW_UNVERIFIED=1 — installing $asset unverified" >&2
fi

# Verified: only now is anything made executable.
case "$asset" in
*.zip)
	if ! command -v unzip >/dev/null 2>&1; then
		echo "unzip is required to unpack $asset" >&2
		exit 1
	fi
	unzip -p "$tmp" go2rtc >"$unpacked"
	mv "$unpacked" "$tmp"
	;;
esac

chmod +x "$tmp"
mv "$tmp" "$target"
trap - EXIT INT TERM

echo "installed $("$target" --version 2>&1 | head -n 1) at $target"
