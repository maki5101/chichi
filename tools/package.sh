#!/bin/bash
# 发布打包（由发布隔离模板改写，见 ~/.claude/skills/release-isolation/package.sh.template）
#
#   tools/package.sh              正式包：从最新提交构建，工作区有没提交的改动就拒绝
#   tools/package.sh --snapshot   试打包：按"现在 git add -A 会提交的样子"构建，文件名带 -snapshot
#
# 隔离：源码一律从 git 取（git archive），在临时目录里 npm ci 后构建，没进 git 的东西
# （.private/、node_modules、本机配置、日志）到不了包里。打完扫成品，有私人信息或密钥就中止、不留产物。
#
# 和模板的差别：
#   - 成品放 release/（这个项目的 dist/ 是 TypeScript 编译输出）
#   - 安装包是压缩格式（AppImage 的 squashfs、NSIS），扫描器拆不开，所以扫打包前的完整目录
#     （linux-unpacked / win-unpacked，就是安装包里装的全部内容）
#   - 还没有任何提交时，试打包从空树开始
set -eu
cd "$(dirname "$0")/.."
SNAPSHOT=0; [ "${1:-}" = "--snapshot" ] && SNAPSHOT=1
if [ "$SNAPSHOT" = 0 ] && ! git rev-parse -q --verify HEAD >/dev/null; then
    echo "还没有任何提交，正式包只从提交构建。先提交，或者用 --snapshot 试打包。"
    exit 1
fi
if [ "$SNAPSHOT" = 0 ] && [ -n "$(git status --porcelain)" ]; then
    echo "工作区有没提交的改动，正式包只从提交构建。先提交，或者用 --snapshot 试打包："
    git status --short | head -20
    exit 1
fi
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
if [ "$SNAPSHOT" = 1 ]; then
    IDX="$STAGE/index"   # 临时索引：真正的暂存区不动
    if git rev-parse -q --verify HEAD >/dev/null; then
        GIT_INDEX_FILE="$IDX" git read-tree HEAD
    else
        GIT_INDEX_FILE="$IDX" git read-tree --empty
    fi
    GIT_INDEX_FILE="$IDX" git add -A
    REF="$(GIT_INDEX_FILE="$IDX" git write-tree)"
else
    REF=HEAD
fi
SRC="$STAGE/src"; mkdir -p "$SRC"
git archive "$REF" | tar -x -C "$SRC"
OUT="$STAGE/out"; mkdir -p "$OUT"

# 【改 1】版本号从 package.json 取
VER="$(node -p "require('$SRC/package.json').version")"
TAG="$VER"; [ "$SNAPSHOT" = 1 ] && TAG="$VER-snapshot"

# 【改 2】构建：只在 $SRC 里做
#   要打哪些包：默认 Linux AppImage + Windows 安装程序。.deb 要等 package.json 填了 homepage 才能打，
#   填好后用 TARGETS="linux:AppImage linux:deb win:nsis" tools/package.sh
TARGETS="${TARGETS:-linux:AppImage win:nsis}"
#   Windows 包要带的 scrcpy 不在 git 里：本机 vendor/ 有就拷进去，没有就在构建目录里下载并校验
if [[ " $TARGETS " == *" win:"* ]]; then
    if [ -f vendor/scrcpy-win/scrcpy.exe ]; then
        mkdir -p "$SRC/vendor" && cp -r vendor/scrcpy-win "$SRC/vendor/"
    else
        (cd "$SRC" && bash scripts/fetch-scrcpy-win.sh)
    fi
fi
LINUX=(); WIN=()
for t in $TARGETS; do
    case "$t" in
        linux:*) LINUX+=("${t#linux:}") ;;
        win:*) WIN+=("${t#win:}") ;;
        *) echo "不认识的打包目标：$t（写成 linux:AppImage、linux:deb、win:nsis）"; exit 1 ;;
    esac
done
(
    cd "$SRC"
    npm ci --no-audit --no-fund
    npm test
    ARGS=()
    [ ${#LINUX[@]} -gt 0 ] && ARGS+=(--linux "${LINUX[@]}")
    [ ${#WIN[@]} -gt 0 ] && ARGS+=(--win "${WIN[@]}" --x64)
    # Windows 包在 Linux 上要靠 wine 生成卸载程序；用单独的 wine 环境，免得碰到本机的
    # 全新的 wine 环境要先初始化，不然生成卸载程序那一步会失败
    # WINEDLLOVERRIDES 关掉新环境初始化时「要不要装 Wine Mono / Gecko」的弹窗（打包用不上它们）
    export WINEPREFIX="${WINEPREFIX:-$HOME/.cache/chichi-wine}" WINEDEBUG=-all WINEDLLOVERRIDES="mscoree=;mshtml="
    if [ ${#WIN[@]} -gt 0 ] && [ ! -d "$WINEPREFIX" ]; then wineboot -u >/dev/null 2>&1 || true; fi
    npx electron-builder "${ARGS[@]}" --publish never
)
# 成品改名带上 $TAG，只挑安装包本身（白名单）
shopt -s nullglob
for f in "$SRC"/release/*.AppImage; do cp "$f" "$OUT/chichi-$TAG-x86_64.AppImage"; done
for f in "$SRC"/release/*.deb; do cp "$f" "$OUT/chichi_${TAG}_amd64.deb"; done
for f in "$SRC"/release/*.exe; do cp "$f" "$OUT/chichi-Setup-$TAG.exe"; done
shopt -u nullglob
[ -n "$(ls -A "$OUT")" ] || { echo "构建没有产出任何安装包"; exit 1; }

# 【改 3】扫成品：安装包是压缩格式拆不开，扫它们打包前的完整目录（包里装的就是这些）
SCAN=()
for d in "$SRC"/release/linux-unpacked "$SRC"/release/win-unpacked; do [ -d "$d" ] && SCAN+=("$d"); done
[ ${#SCAN[@]} -gt 0 ] || { echo "找不到打包前的目录，没法扫描——不能算通过"; exit 1; }
python3 tools/privacy_scan.py "${SCAN[@]}" || { echo "成品里有私人信息或密钥（见上），没有输出到 release/"; exit 1; }
(cd "$OUT" && sha256sum -- * > SHA256SUMS)
rm -rf release; mkdir -p release; cp -p "$OUT"/* release/
echo "release/（源码：$([ "$SNAPSHOT" = 1 ] && echo "工作区快照" || git rev-parse --short HEAD)）:"
ls -la release | awk 'NR>3{printf "  %-48s %s\n", $NF, $5}'
