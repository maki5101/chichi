# Changelog

English | [中文](CHANGELOG.zh-CN.md)

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-29

First release, named 琪琪 (chichi).

### Added

- Open single phone apps as independent desktop windows through scrcpy virtual displays, one window per app.
- Mirror the whole phone screen (plain scrcpy).
- Extra screen: a resizable new phone screen showing the secondary home screen, for opening any app; closing it moves its apps back to the phone.
- Interface in ten languages: Simplified Chinese, Traditional Chinese, English, Japanese, Korean, German, French, Italian, Spanish and Arabic (right-to-left); follows the system language by default.
- App list: click a row to expand it and open/close the window, set window size, orientation and resizing, move to top, or remove.
- Settings follow the phone: each phone (recognized by serial number, same over USB and Wi-Fi) has its own app list, default size and options; copy from another phone; apps not installed on the current phone are marked.
- Pick apps from the phone's app list, with search; system apps hidden by default.
- Window size presets (iPhone 17 / Air / 17 Pro Max, Pixel 10, iPad Air 11-inch, Desktop 1080p, Match the phone) and custom sizes, with a to-scale preview.
- Per-app Fixed or Free resizing; with Free, the phone-side screen follows the window size and stays sharp on scaled (HiDPI) desktops.
- Appearance setting: System / Light / Dark.
- Sound on Phone / Computer / Both; only one audio stream however many windows are open; buffer Large/Medium/Small.
- Screenshot any open window from its row or the tray menu, at the phone's full resolution; saved to Pictures/chichi and copied to the clipboard.
- Pause an app that is playing when its window closes, instead of killing it.
- Wake a sleeping phone before opening an app, and whenever you click a window while it sleeps; the click that was dropped is resent once the phone is awake.
- Bring an app back when the Back button exits to the phone's secondary home screen.
- Tap an app's icon on the phone's home screen to take it back from the computer; its window closes.
- A "chichi is connected" notification on the phone: swipe it away to bring every app back to the phone and drop the wireless connection.
- Two keyboard modes: Basic (ASCII only) and emulated hardware keyboard (type any language with the phone's keyboard app).
- USB detected automatically; wireless connection tries an existing connection, the last port, then an nmap scan (including port 5555); the port field accepts a single port.
- Phones that have connected wirelessly are remembered; reconnect with one click from Settings → Connection.
- Features are gated by the phone's Android version with clear messages.
- Closing the main window hides it to the system tray; the tray menu shows how many phone windows are open and can quit. Single instance only.
- Application menu entry and icon; .deb and AppImage packages.
- Settings stored in `~/.config/chichi/config.json`, hand-editable with comments and trailing commas, automatically backed up if unreadable. Settings from the pre-release name (`~/.config/Phone Apps/`) are copied over on first start.
