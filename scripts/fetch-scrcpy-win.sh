#!/usr/bin/env bash
# 下载要随 Windows 安装包一起分发的 scrcpy（自带 adb），放到 vendor/scrcpy-win/。
# 版本固定为开发时实测过的版本；下载后按官方 SHA256SUMS.txt 校验，不通过就中止。
set -euo pipefail

VERSION="4.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor/scrcpy-win"
ZIP="scrcpy-win64-v${VERSION}.zip"
BASE="https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}"

if [[ -f "$DEST/scrcpy.exe" && "$(cat "$DEST/.version" 2>/dev/null)" == "$VERSION" ]]; then
    echo "vendor/scrcpy-win 已是 ${VERSION}，跳过下载" >&2
    exit 0
fi

for bin in curl sha256sum unzip; do
    command -v "$bin" >/dev/null || { echo "缺少 $bin，先安装：sudo apt install $bin" >&2; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "下载 ${ZIP} …" >&2
curl -fsSL -o "$TMP/$ZIP" "$BASE/$ZIP"
curl -fsSL -o "$TMP/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt"

# 只核对这一个文件
(cd "$TMP" && grep " ${ZIP}\$" SHA256SUMS.txt | sha256sum -c -) >&2 || {
    echo "校验失败：${ZIP} 和官方 SHA256SUMS.txt 对不上，已中止" >&2
    exit 1
}

unzip -q "$TMP/$ZIP" -d "$TMP/unzipped"
# 压缩包里是一层 scrcpy-win64-vX/ 目录
SRC="$(find "$TMP/unzipped" -maxdepth 2 -name scrcpy.exe -printf '%h\n' | head -1)"
[[ -n "$SRC" ]] || { echo "压缩包里没找到 scrcpy.exe" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/
# 压缩包自带 LICENSE.txt（scrcpy 是 Apache-2.0），随程序分发时它会一起带上
[[ -f "$DEST/LICENSE.txt" ]] || { echo "压缩包里没有 LICENSE.txt，不能分发" >&2; exit 1; }
echo "$VERSION" > "$DEST/.version"
echo "已放到 $DEST" >&2
