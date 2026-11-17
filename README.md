# chichi

English | [中文](README.zh-CN.md)

Open individual Android apps as their own windows on your Linux desktop. Click "Taobao" and Taobao pops up; click "Word" and Word pops up — one window per app, independent of each other, while the phone's own screen stays untouched. It can also mirror the whole phone screen like plain scrcpy.

Under the hood it uses [scrcpy](https://github.com/Genymobile/scrcpy)'s virtual displays: for each app it creates an invisible screen on the phone, starts the app there, and streams that screen to the computer.

## Why

A lot of everyday life only exists as a phone app — chat, banking, shopping, delivery, podcasts, the app your landlord insists on. On a Linux desktop the usual options are all a bit wrong:

- **Mirroring the phone** (plain scrcpy, vendor "phone link" tools) gives you one phone-shaped window. You can only use one app at a time, and whatever you do on the computer also happens on the phone in your pocket.
- **Android emulators / Waydroid** are a second phone to set up, log in to and keep in sync. Many apps refuse to run in them, and your data isn't there.
- **Web versions** don't exist for half the apps, and are a cut-down copy for the rest.

chichi takes the approach Windows users know from RemoteApp / WinApps: the apps keep running on your real phone, with your real accounts, but each one shows up on the computer as an ordinary window you can place, resize and alt-tab to. Several apps can be open side by side, and the phone itself stays free to use for something else.

It also smooths over the rough edges that make raw scrcpy awkward for daily use:

- **One click per app**, from a small launcher or the tray — no command lines.
- **Sound is forwarded once**, however many windows are open, and you choose where it plays: phone, computer, or both. Closing a window pauses a podcast instead of killing it.
- **The phone can sleep.** Clicking a window wakes it and replays the click; the app doesn't freeze while the screen is off.
- **Hand an app back.** Tap its icon on the phone and it moves back to the phone screen where you left off. Swipe away chichi's notification to send everything back and disconnect.
- **Wireless that remembers.** Phones connected over Wi-Fi are remembered; reconnecting finds the new port automatically.
- **An extra screen**: a resizable second display (Samsung DeX on Samsung phones) for anything not in your list.
- **Per-phone settings**, window sizes that match real phones (an iPhone-width layout is one click), screenshots at full phone resolution, ten interface languages.

The only requirement on the phone is USB debugging. No root, no app to install on it.

## Requirements

**Just one: an Android phone with USB debugging enabled** (Settings → About phone, tap the build number repeatedly to unlock Developer options, then turn on USB debugging there).

No root, nothing to install on the phone. What works depends on the Android version, and the app tells you plainly when a feature isn't available instead of failing mysteriously:

| Feature | Phone |
|---|---|
| Mirror the whole phone screen | Android 5+ |
| Open single apps in windows | Android 10+ |
| Sound on the computer | Android 11+ |
| Sound on both phone and computer | Android 13+ |
| Wireless (pairing-based Wireless debugging) | Android 11+; older phones can use `adb tcpip 5555` |

On the computer:

| Software | Notes |
|---|---|
| Linux desktop | Developed and tested on Ubuntu 26.04 + KDE Plasma (Wayland). Other desktops should work; the tray icon needs StatusNotifierItem support |
| adb | `sudo apt install adb` |
| scrcpy 3.0+ | The [official Linux build](https://github.com/Genymobile/scrcpy/releases) is recommended (bundles its own libraries, survives system upgrades). Tested with 4.1 |
| nmap | Optional, finds the port for wireless connections: `sudo apt install nmap` |

The interface is available in Simplified Chinese, Traditional Chinese, English, Japanese, Korean, German, French, Italian, Spanish and Arabic. It follows the system language by default and can be changed in Settings.

## Install

### .deb package (recommended, Ubuntu / Debian)

```bash
sudo apt install ./chichi_0.1.0_amd64.deb
```

Then search the application menu for "chichi" (or "琪琪").

### AppImage

```bash
chmod +x chichi-0.1.0-x86_64.AppImage
./chichi-0.1.0-x86_64.AppImage
```

The AppImage has two catches on recent Ubuntu, so treat it as a fallback:

- It needs `libfuse2` (not installed by default since Ubuntu 22.04): `sudo apt install libfuse2t64`, or run it with `--appimage-extract-and-run`.
- Since Ubuntu 24.04, unprivileged user namespaces are restricted and Electron's sandbox fails to start (the error mentions `chrome-sandbox`). See Troubleshooting below.

### From source

```bash
git clone <repository URL> chichi
cd chichi
npm install
npm start
```

Add it to the application menu with `npm run install-desktop` (writes `~/.local/share/applications/chichi.desktop`; remove with `bash scripts/install-desktop.sh --remove`). The menu entry runs the compiled build, so run `npm run build` after changing code.

## Usage

Two pages:

- **Apps**
  - At the top, **Whole phone screen** mirrors the phone's real screen — plain scrcpy.
  - **Extra screen** adds a new screen to the phone showing its secondary home screen (Samsung DeX on Samsung phones); open any app on it. Drag or maximize the window and the phone-side screen grows with it. Closing it moves the apps on it back to the phone instead of closing them. Needs Android 10+; if the phone's home app doesn't support secondary screens it may stay blank (you'll be told when opening it).
  - **Sound on**: Phone / Computer / Both, switches instantly.
  - Below are the apps you picked. Click a row to expand it: Open / Close window, plus that app's window size, orientation, resizing (Fixed / Free), move to top, and remove.
- **Settings**: interface language and appearance (System / Light / Dark) at the top, then four sections
  - **Apps**: every app on the phone, searchable; click Add to put it in your list. System apps are hidden by default.
  - **Windows**: default window size, custom sizes, keyboard and input, waking the phone, Back-button behaviour, extra scrcpy options.
  - **Sound**: where sound plays, buffer size, pausing on close.
  - **Connection**: wireless connection, adb and scrcpy locations and a check button.

Changes are saved immediately; there is no Save button.

**Settings follow the phone.** Each phone has its own app list, default window size, sound, keyboard and phone options; language, appearance, custom sizes, the wireless address and program locations are shared. Phones are recognized by their serial number, so the same phone over USB and over Wi-Fi is one phone. A phone connected for the first time starts with an empty list; Settings → Apps can copy another phone's list and settings (click twice to confirm). Apps in the list that aren't installed on the current phone are marked and can't be opened. With several phones connected, pick one in the top-right corner.

**Screenshots**: every open window gets a Screenshot button at the end of its row (and on the Whole phone screen card); the tray menu has a Screenshot submenu too. The picture is taken on the phone at its full resolution, saved to `Pictures/chichi/` and copied to the clipboard.

**Take an app back on the phone**: while an app is open on the computer, tap its icon on the phone's home screen and the app returns to the phone's screen (keeping its state); its window on the computer closes. Only taps in the phone's default home app count, so apps switching to each other normally aren't affected.

**Disconnect from the phone**: once connected, the phone shows a "chichi is connected" notification. Swipe it away and every app open on the computer returns to the phone; a wireless connection is dropped as well, so there's no need to turn off wireless debugging. A USB connection can't be dropped from the phone — swiping only brings the apps back; after unplugging the cable the notification may stay behind, just swipe it away.

**Closing the main window only hides it to the system tray** — phone windows and sound keep running. Click the tray icon to show or hide the main window; choose Quit from its menu to really exit (it first pauses whatever is playing, then closes all phone windows). Only one instance runs at a time; launching it again from the menu brings the existing window forward.

### Window sizes

Built-in sizes (portrait values; landscape swaps them):

| Name | Pixels | dpi | Screen the app sees |
|---|---|---|---|
| Match the phone | read from the phone when opening | | |
| iPhone 17 | 1206 × 2622 | 480 | 402 × 874 |
| iPhone Air | 1260 × 2736 | 480 | 420 × 912 |
| iPhone 17 Pro Max | 1320 × 2868 | 480 | 440 × 956 |
| Pixel 10 | 1080 × 2424 | 420 | 411 × 923 |
| iPad Air 11-inch | 1640 × 2360 | 320 | 820 × 1180 |
| Desktop 1080p | 1080 × 1920 | 240 | 720 × 1280 |

Each app can also be set to **Resizing: Fixed / Free**. With Free, dragging the window edges resizes the phone-side screen too and the app re-lays out; the size you picked only sets the starting size. (Internally one physical pixel of the window becomes one pixel on the phone, with the dpi raised to match your desktop scaling, so it stays sharp on 150%/200% displays and the app lays out for exactly as wide as the window is. On a scaled desktop a Free window may open a bit shorter than the chosen size; just drag it taller.)

"Screen the app sees" decides how wide a screen the app lays itself out for: width = pixels ÷ (dpi ÷ 160). Phones are usually 360–440; bigger numbers fit more content with smaller text. Add your own under Settings → Windows → Custom sizes.

### Sound

| Sound on | Meaning |
|---|---|
| Phone | Default. Sound stays on the phone; the computer is silent |
| Computer | While any window is open, all phone sound plays on the computer and the phone is muted |
| Both | Phone and computer play together; the few apps that forbid capture only play on the phone |

However many windows are open, only one audio stream is forwarded (scrcpy captures the whole phone's output and cannot tell apps apart). When several apps make sound, Android decides: most music, podcast and video apps take turns — when one starts, the others pause. Sound cannot follow "whichever window is focused".

Buffer Large / Medium / Small is 250 / 120 / 50 ms. Pick a larger one if wireless audio crackles.

**Pause on close** (on by default): closing a window does not kill the app; if it is playing something it gets paused, so it doesn't carry on in the background.

### Keyboard and input

| Computer keyboard | Meaning |
|---|---|
| Basic (default) | Only plain ASCII gets through. Text from your computer's input method (Chinese, Japanese, accented letters, …) cannot be sent — a scrcpy limitation. Copy it on the computer and press Ctrl+V in the window instead |
| Emulate a hardware keyboard | Keys go to the phone as-is and the phone's keyboard app handles them, so any language works; switch your computer's input method to plain English while typing into a phone window. **Side effect:** while windows are open the phone believes a hardware keyboard is attached, so Gboard and others hide the on-screen keyboard when you use the phone directly |

### Phone

| Option | Meaning |
|---|---|
| Wake the phone automatically when it sleeps | While the phone is locked with the screen off, apps show up in windows but ignore clicks. With this on, the phone is woken before an app opens and whenever you click or type in a window while it sleeps, and that click is resent once the phone is awake (about half a second later), so one click is enough. Nothing happens while the phone is awake, so using the phone directly isn't affected |
| Bring the app back when Back reaches the home screen | Pressing Back repeatedly ends on the phone's secondary home screen (the DeX desktop on Samsung). With this on, the app is brought back to the same page within about a second. Apps that jump to another app on their own (e.g. a shop opening a payment app) are left alone |

### Wireless connection

USB is detected automatically. For wireless:

1. On the phone, turn on Developer options → Wireless debugging. The first time, authorize this computer over USB once, or pair from a terminal with `adb pair <address:pairing-port>` (pairing isn't in the UI).
2. Enter the phone's address in Settings → Connection. **Port** takes a range (default 32768-60999) or the exact port shown on the phone's Wireless debugging page.
3. Click Connect. It tries, in order: an already-connected device → the last working port → an nmap scan (which also covers port 5555 used by classic `adb tcpip`).

Every phone that has connected wirelessly (through chichi or any other tool) has its address remembered and listed under **Remembered phones** at the top of Settings → Connection; next time just click Connect on its row instead of typing the address. While no phone is connected, the Apps page shows a connect button for each of them too. The port changes when the phone restarts or wireless debugging is turned back on; Connect rescans automatically. Nothing reconnects in the background. Click Forget to drop a phone.

### Settings file

`~/.config/chichi/config.json`. You can edit it by hand; `//` comments and trailing commas are allowed. If it becomes unreadable, it is renamed to `config.json.broken-<timestamp>` and defaults are used.

## Troubleshooting

**Nothing happens when launching from the menu; the log mentions `chrome-sandbox ... is owned by root and has mode 4755`**

Since Ubuntu 24.04, unprivileged user namespaces are restricted and Electron's sandbox cannot start. The .deb package takes care of this. When running from source or the AppImage, add an AppArmor rule for the Electron binary (Ubuntu does the same for VS Code), replacing the path with your actual electron location:

```bash
sudo tee /etc/apparmor.d/chichi-electron >/dev/null <<'EOF'
abi <abi/5.0>,
include <tunables/global>

profile chichi-electron /path/to/chichi/node_modules/electron/dist/electron flags=(unconfined) {
  userns,
  include if exists <local/chichi-electron>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/chichi-electron
```

**Clicks inside a window do nothing**: the phone's screen is off. With "Wake the phone automatically" on (the default) the click goes through after about half a second; otherwise right-click inside the window to wake it.

**The on-screen keyboard disappeared when using the phone directly**: you chose "Emulate a hardware keyboard". Switch back to Basic, or close all phone windows.

**Sound stutters**: set the buffer to Large under Settings → Sound.

**Check says scrcpy is too old**: distribution packages may ship scrcpy 2.x; use the official Linux build.

## Known limitations

- Quitting chichi from the tray closes the phone windows it opened. Closing just the main window does not.
- One window per app; clicking Open on an app that is already open cannot raise its window.
- Pause on close sends a system-wide media "pause" key. It's only sent after confirming that this app is playing, but if two apps happen to be playing at once, the other one might get paused.
- With several phones connected, sound is forwarded from only one (the phone whose window opened first).
- Extra scrcpy options are split on spaces; values containing spaces are not supported.
- Taking an app back only works by tapping its icon in the phone's default home app; opening it another way (recent apps, a notification, another app) doesn't.
- Translations other than Chinese were written with AI help; corrections from native speakers are welcome.

## Development

```bash
npm run build   # compile to dist/
npm test        # offline tests, no phone needed
tools/package.sh --snapshot   # trial release build from the working tree into release/
tools/package.sh              # release build from the latest commit (working tree must be clean)
```

Architecture, design decisions and invariants are in [CLAUDE.md](CLAUDE.md) (Chinese); release notes in [CHANGELOG.md](CHANGELOG.md).

Release builds are made from git only, in a temporary directory, and every packaged file is scanned for private data and secrets before anything lands in `release/`. After cloning, enable the commit hook once: `git config core.hooksPath .githooks`.

UI text lives in `locales/<language>.json`, with `zh.json` as the source of truth. Add new strings to all ten files; `npm test` checks that keys and placeholders match.

## License

[MIT](LICENSE).

chichi only runs scrcpy and adb as separate programs and contains none of their code. scrcpy is Apache-2.0 licensed; adb is part of the Android SDK Platform-Tools.
