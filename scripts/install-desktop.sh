#!/usr/bin/env bash
# 把琪琪（chichi）加进开始菜单（写 ~/.local/share/applications/chichi.desktop）。
# 项目文件夹挪了位置后重跑一次即可。卸载：bash scripts/install-desktop.sh --remove
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
TARGET="$APPS_DIR/chichi.desktop"
# 改名前的菜单项，装新的时顺手删掉，免得菜单里出现两个
OLD_ENTRY="$APPS_DIR/phoneapps.desktop"

refresh_menu() {
    command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
    command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$TARGET")" >/dev/null 2>&1 || true
}

if [[ "${1:-}" == "--remove" ]]; then
    rm -f "$TARGET" "$OLD_ENTRY"
    refresh_menu
    echo "已从开始菜单移除：$TARGET" >&2
    exit 0
fi

ELECTRON="$ROOT/node_modules/.bin/electron"
if [[ ! -x "$ELECTRON" ]]; then
    echo "找不到 Electron，先在 $ROOT 里运行：npm install" >&2
    exit 1
fi

# 菜单直接启动已编译的 dist/，不每次重新编译；改了代码后运行 npm run build
if [[ ! -f "$ROOT/dist/main/main.js" ]]; then
    echo "还没编译，先在 $ROOT 里运行：npm run build" >&2
    exit 1
fi

mkdir -p "$(dirname "$TARGET")"
cat > "$TARGET" <<EOF
[Desktop Entry]
Type=Application
Name=chichi
Name[zh_CN]=琪琪
Name[zh_TW]=琪琪
Name[zh_HK]=琪琪
Name[ja]=琪琪
GenericName=Phone app windows
Comment=Open individual Android apps as desktop windows
GenericName[zh_CN]=手机应用窗口
Comment[zh_CN]=把手机里的单个应用开成独立窗口
GenericName[zh_TW]=手機 App 視窗
Comment[zh_TW]=把手機裡的單一 App 開成獨立視窗
GenericName[zh_HK]=手機 App 視窗
Comment[zh_HK]=把手機裡的單一 App 開成獨立視窗
GenericName[ja]=スマホアプリのウィンドウ
Comment[ja]=スマホのアプリを個別のウィンドウで開く
GenericName[ko]=휴대폰 앱 창
Comment[ko]=휴대폰 앱을 각각 독립된 창으로 열기
GenericName[de]=Handy-App-Fenster
Comment[de]=Einzelne Handy-Apps in eigenen Fenstern öffnen
GenericName[fr]=Fenêtres d’apps du téléphone
Comment[fr]=Ouvrir chaque app du téléphone dans sa propre fenêtre
GenericName[it]=Finestre delle app del telefono
Comment[it]=Aprire le singole app del telefono in finestre proprie
GenericName[es]=Ventanas de apps del teléfono
Comment[es]=Abrir cada app del teléfono en su propia ventana
GenericName[ar]=نوافذ تطبيقات الهاتف
Comment[ar]=فتح كل تطبيق من الهاتف في نافذة مستقلة
Exec="$ELECTRON" "$ROOT" --class=chichi
Path=$ROOT
Icon=$ROOT/assets/icon.svg
Terminal=false
Categories=Utility;
Keywords=chichi;琪琪;phone;android;scrcpy;手机;安卓;
StartupWMClass=chichi
EOF

rm -f "$OLD_ENTRY"
desktop-file-validate "$TARGET" 2>&1 >&2 || true
refresh_menu
echo "已加入开始菜单：$TARGET" >&2
