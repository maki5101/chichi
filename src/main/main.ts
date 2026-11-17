// 主进程：窗口、状态、以及界面能调用的全部动作（IPC）。

import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import * as adb from "./adb";
import * as device from "./device";
import { claimProfile, defaultLaunch, defaultProfile, DEVICE_SIZE_ID, loadConfig, loadPresets, normalizeConfig, rememberWireless, saveConfig } from "./config";
import { allStrings, currentLanguage, LANGUAGES, resolveLanguage, setLanguage, t } from "./i18n";
import { DESKTOP_KEY, Launcher, listApps, MIRROR_KEY } from "./scrcpy";

// ═══════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════

const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");

/**
 * 改名前叫 Phone Apps，配置在 ~/.config/Phone Apps/。新位置还没有配置时把旧的拷过来，
 * 旧文件夹原样留着（是用户的数据，不替用户删）。
 */
function migrateFromOldName(): void {
  const old = path.join(app.getPath("appData"), "Phone Apps", "config.json");
  if (fs.existsSync(CONFIG_FILE) || !fs.existsSync(old)) return;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.copyFileSync(old, CONFIG_FILE);
  console.error(`[chichi] 已从改名前的配置迁移：${old}`);
}
migrateFromOldName();
const LOCALES_DIR = path.join(__dirname, "..", "locales");
// 名字由界面按语言显示（size.device），这里只是占位
const DEVICE_SIZE: SizePreset = { id: DEVICE_SIZE_ID, name: "device", width: 0, height: 0, dpi: 0 };

const loaded = loadConfig(CONFIG_FILE);
let config = loaded.config;
const presets = loadPresets(path.join(__dirname, "..", "presets.json"));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 真正退出时置为 true；否则关窗口只是藏到托盘 */
let quitting = false;

const ASSETS = path.join(__dirname, "..", "..", "assets");

const launcher = new Launcher(
  () => runtimeConfig(),
  (running, exit) => {
    win?.webContents.send("running-changed", running, exit);
    refreshTrayMenu();
  },
  // 多显示器时取主显示器的缩放；app ready 之前不会有窗口被打开
  () => screen.getPrimaryDisplay().scaleFactor,
  (serial) => profileOf(serial)?.launch ?? defaultLaunch(),
);

// ═══════════════════════════════════════════════
// 手机身份：adb 编号 → 序列号。同一部手机 USB 和无线的 adb 编号不同，序列号相同
// ═══════════════════════════════════════════════

const identities = new Map<string, adb.Identity>();

function profileOf(serial: string): DeviceProfile | null {
  const id = identities.get(serial)?.id;
  return id ? config.devices[id] ?? null : null;
}

/** 给在线的手机补上序列号和名字；第一次见到的手机顺便分配设置（认领旧设置或给默认值） */
async function identifyDevices(devices: Device[]): Promise<Device[]> {
  const tools = runtimeConfig().tools;
  for (const d of devices) {
    if (d.state !== "device") continue;
    if (!identities.has(d.serial)) {
      const who = await adb.identify(tools.adb, d.serial);
      if (!who) continue;
      identities.set(d.serial, who);
      const next = claimProfile(config, who.id, d.serial, who.name, who.model);
      if (next !== config) updateConfig(next);
      if (d.wireless) remember(d.serial, who);
      void postConnected(d.serial);
    }
    const who = identities.get(d.serial)!;
    d.id = who.id;
    d.name = who.name;
  }
  // 断开的手机下次重连时重新识别（无线的端口会变）
  for (const serial of identities.keys()) {
    if (devices.some((d) => d.serial === serial)) continue;
    identities.delete(serial);
    notified.delete(serial);
  }
  return devices;
}

/** 无线连上的手机（不管是谁连的）记下地址，下次在「设置 → 连接」一键重连 */
function remember(serial: string, who: adb.Identity): void {
  const i = serial.lastIndexOf(":");
  const next = rememberWireless(config, { id: who.id, name: who.name || who.model, host: serial.slice(0, i), lastPort: Number(serial.slice(i + 1)) || null });
  if (next !== config) updateConfig(next);
}

// ═══════════════════════════════════════════════
// 在手机上断开：通知栏里挂一条「已连接」，划掉它就断开
// ═══════════════════════════════════════════════

/** adb 编号 → 我们那条通知的 key */
const notified = new Map<string, string>();
const NOTIFY_CHECK_MS = 3000;

async function postConnected(serial: string): Promise<void> {
  if (process.env.CHICHI_SNAPSHOT) return; // 开发截图时不往手机上发通知
  const key = await device.postNotification(runtimeConfig().tools.adb, serial, t("notify.title"), t("notify.text"));
  if (key) notified.set(serial, key);
}

/** 通知不见了 = 用户在手机上划掉了：电脑上的窗口收回手机，无线连接断开 */
async function checkNotifications(): Promise<void> {
  const adbBin = runtimeConfig().tools.adb;
  for (const [serial, key] of [...notified]) {
    const now = await device.notificationKey(adbBin, serial);
    if (now === undefined || now === key) continue; // 查不到手机（不能当成划掉）或者还在
    notified.delete(serial);
    const name = identities.get(serial)?.name ?? serial;
    console.error(`[chichi] 手机上划掉了连接通知，断开 ${name}`);
    await launcher.returnAll(serial);
    if (/:\d+$/.test(serial)) await adb.run(adbBin, ["disconnect", serial], 5000);
    win?.webContents.send("phone-disconnected", name);
  }
}

/** 退出前把手机上的通知撤掉（尽力而为，手机不在就算了） */
async function withdrawAll(): Promise<void> {
  const adbBin = runtimeConfig().tools.adb;
  await Promise.all([...notified].map(([serial, key]) => device.withdrawNotification(adbBin, serial, key)));
  notified.clear();
}

function allSizes(): SizePreset[] {
  return [DEVICE_SIZE, ...presets, ...config.customSizes];
}

function findSize(profile: DeviceProfile, id: string | null): SizePreset {
  const sizes = allSizes();
  return sizes.find((s) => s.id === (id ?? profile.defaultSizeId)) ?? sizes.find((s) => s.id === profile.defaultSizeId) ?? sizes[0];
}

// ═══════════════════════════════════════════════
// 随安装包自带的 scrcpy / adb（Windows 安装包带了，Linux 用系统里的）
// ═══════════════════════════════════════════════

const EXE = process.platform === "win32" ? ".exe" : "";

function bundledTool(name: string): string | null {
  if (!app.isPackaged) return null;
  const file = path.join(process.resourcesPath, "scrcpy", name + EXE);
  return fs.existsSync(file) ? file : null;
}

/**
 * 设置里留着默认值 "adb" / "scrcpy" 时，优先用安装包自带的，没有再去系统 PATH 里找；
 * 用户填了具体路径就照用户的。配置文件里始终存用户填的原值，不存解析结果。
 */
function runtimeConfig(): Config {
  const pick = (value: string, name: string) => (value === name ? bundledTool(name) ?? value : value);
  return { ...config, tools: { adb: pick(config.tools.adb, "adb"), scrcpy: pick(config.tools.scrcpy, "scrcpy") } };
}

function state(configNotice: string | null = null): AppState {
  return {
    config,
    defaultProfile: defaultProfile(),
    language: currentLanguage(),
    languages: LANGUAGES,
    strings: allStrings(),
    sizes: allSizes(),
    running: launcher.list(),
    configNotice,
  };
}

/** 按设置切换语言；"auto" 跟随系统。系统语言要等 app ready 之后才读得到 */
function applyLanguage(): void {
  setLanguage(LOCALES_DIR, resolveLanguage(config.language, app.getLocale()));
  refreshTrayMenu();
}

/** 外观：跟随系统 / 浅色 / 深色。界面 CSS 用 prefers-color-scheme，Electron 会按 themeSource 改写它 */
function applyTheme(): void {
  nativeTheme.themeSource = config.theme;
  win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#151716" : "#F2F3F0");
}

function updateConfig(next: Config): void {
  const languageChanged = next.language !== config.language;
  const themeChanged = next.theme !== config.theme;
  config = normalizeConfig(next);
  saveConfig(CONFIG_FILE, config);
  if (languageChanged) applyLanguage();
  if (themeChanged) applyTheme();
}

// ═══════════════════════════════════════════════
// IPC
// ═══════════════════════════════════════════════

ipcMain.handle("get-state", () =>
  state(loaded.broken ? t("err.configBroken", { error: loaded.broken.error, backup: loaded.broken.backup }) : null));

ipcMain.handle("save-config", (_e, next: Config) => {
  updateConfig(next);
  launcher.sync(); // 声音、返回键守护等设置变了，正在运行的要跟着变
  return state();
});

ipcMain.handle("list-devices", async () => {
  const r = await adb.listDevices(runtimeConfig().tools.adb);
  await adb.markStale(runtimeConfig().tools.adb, r.devices);
  const devices = await identifyDevices(r.devices);
  // 识别新手机时这里可能改了配置，一起带回去，免得界面拿旧配置保存时把它覆盖掉
  return { devices, error: r.error, config };
});

ipcMain.handle("list-packages", (_e, serial: string) => adb.listPackages(runtimeConfig().tools.adb, serial));

ipcMain.handle("list-apps", (_e, serial: string) => listApps(runtimeConfig().tools.scrcpy, runtimeConfig().tools.adb, serial));

ipcMain.handle("launch", (_e, pkg: string, serial: string): Promise<ActionResult> => {
  if (pkg === MIRROR_KEY) return launcher.launchMirror(serial);
  if (pkg === DESKTOP_KEY) return launcher.launchDesktop(serial);
  const profile = profileOf(serial) ?? defaultProfile();
  const pinned = profile.pinned.find((p) => p.pkg === pkg);
  if (!pinned) return Promise.resolve({ ok: false, message: t("err.notPinned") });
  return launcher.launch(serial, pinned, findSize(profile, pinned.sizeId));
});

ipcMain.handle("stop", (_e, pkg: string) => launcher.stop(pkg));

ipcMain.handle("screenshot", (_e, pkg: string) => takeScreenshot(pkg));

ipcMain.handle("open-screenshots", () => shell.openPath(screenshotDir()));

ipcMain.handle("connect-wireless", async (e, id?: string): Promise<ActionResult> => {
  const known = id ? config.wireless.known.find((k) => k.id === id) : undefined;
  if (id && !known) return { ok: false, message: t("err.unknownPhone") };
  const { host, lastPort } = known ?? config.wireless;
  const log = (line: string) => e.sender.send("connect-progress", line);
  const result = await adb.connectWireless(runtimeConfig().tools.adb, host, lastPort, config.wireless.portRange, log);
  // 记住的手机连上后由 identifyDevices 更新端口；这里只管「连接新手机」那一栏
  if (!known && result.ok && result.port && result.port !== lastPort) {
    updateConfig({ ...config, wireless: { ...config.wireless, lastPort: result.port } });
  }
  return { ok: result.ok, message: result.message };
});

ipcMain.handle("check-tools", async (): Promise<ToolStatus> => {
  const tools = runtimeConfig().tools;
  const [a, s] = await Promise.all([
    adb.run(tools.adb, ["version"], 8000),
    adb.run(tools.scrcpy, ["--version"], 8000),
  ]);
  const describe = (r: adb.RunResult, bin: string) =>
    r.missing ? { ok: false, detail: t("tools.missing", { bin }) }
    : r.code !== 0 ? { ok: false, detail: (r.stderr || r.stdout).trim().split("\n")[0] || t("tools.exitCode", { code: String(r.code) }) }
    : { ok: true, detail: r.stdout.split("\n").find((l) => /version|scrcpy \d/i.test(l))?.trim() ?? t("tools.available") };
  const scrcpy = describe(s, tools.scrcpy);
  // 单开应用用到的 --new-display / --start-app 是 scrcpy 3 才有的
  const major = Number(/scrcpy (\d+)\./.exec(s.stdout)?.[1]);
  if (scrcpy.ok && major < 3) {
    return { adb: describe(a, tools.adb), scrcpy: { ok: false, detail: t("tools.scrcpyTooOld", { detail: scrcpy.detail }) } };
  }
  return { adb: describe(a, tools.adb), scrcpy };
});

// ═══════════════════════════════════════════════
// 窗口
// ═══════════════════════════════════════════════

function createWindow(): void {
  win = new BrowserWindow({
    width: 440,
    height: 720,
    minWidth: 360,
    minHeight: 480,
    title: t("app.name"),
    icon: path.join(ASSETS, "icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151716" : "#F2F3F0",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  // 关窗口 = 藏到托盘，手机窗口和声音照常运行；从托盘菜单「退出」才真正结束
  win.on("close", (e) => {
    if (quitting || process.env.CHICHI_SNAPSHOT) return;
    e.preventDefault();
    win?.hide();
  });
  win.on("closed", () => (win = null));
  if (process.env.CHICHI_SNAPSHOT) snapshotAndQuit(win, process.env.CHICHI_SNAPSHOT);
}

/** 开发用：页面加载后截图到指定文件再退出，用来检查界面，不影响正常使用 */
function snapshotAndQuit(w: BrowserWindow, file: string): void {
  w.webContents.once("did-finish-load", () => {
    // CHICHI_SNAPSHOT_CLICK：用 | 分隔的 CSS 选择器，截图前依次点击
    const clicks = (process.env.CHICHI_SNAPSHOT_CLICK ?? "").split("|").filter(Boolean);
    clicks.forEach((sel, i) =>
      setTimeout(() => w.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.click()`), 1200 + i * 500));
    setTimeout(async () => {
      const img = await w.webContents.capturePage();
      fs.writeFileSync(file, img.toPNG());
      app.quit();
    }, Number(process.env.CHICHI_SNAPSHOT_DELAY ?? 2500));
  });
}

function showWindow(): void {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ═══════════════════════════════════════════════
// 截图：存到「图片 / chichi」，同时复制到剪贴板
// ═══════════════════════════════════════════════

const screenshotDir = () => path.join(app.getPath("pictures"), "chichi");

/** 文件名里不能有的字符换掉，应用名可能带 / 之类 */
const safeName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "_").trim() || "screenshot";

async function takeScreenshot(pkg: string): Promise<ActionResult> {
  const { png, name } = await launcher.screenshot(pkg);
  if (!png) return { ok: false, message: t("shot.failed", { name: name || pkg }) };

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = path.join(screenshotDir(), `${safeName(name)}_${stamp}.png`);
  fs.mkdirSync(screenshotDir(), { recursive: true });
  fs.writeFileSync(file, png);
  // Electron 44 起剪贴板是浏览器式的接口；复制失败不影响已保存的文件
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) })]).catch((e) => {
    console.error(`[chichi] 截图复制到剪贴板失败：${e}`);
  });
  return { ok: true, message: t("shot.saved", { file: path.basename(file) }) };
}

// ═══════════════════════════════════════════════
// 托盘
// ═══════════════════════════════════════════════

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, "tray.png")));
  tray.on("click", () => (win?.isVisible() ? win.hide() : showWindow()));
  refreshTrayMenu();
}

/** 托盘菜单里显示有几个手机窗口开着，退出前心里有数 */
/** 从托盘截图时主窗口可能藏着，结果交给界面显示（界面没开就算了，文件照样存了） */
function notifyShot(result: ActionResult): void {
  win?.webContents.send("screenshot-done", result);
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setToolTip(t("app.name"));
  const running = launcher.windows();
  const count = running.length;
  const shots = running.map((r) => ({ label: r.name, click: () => takeScreenshot(r.pkg).then(notifyShot) }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t("tray.show"), click: showWindow },
    { label: count ? t("tray.count", { count }) : t("tray.none"), enabled: false },
    { label: t("tray.screenshot"), enabled: count > 0, submenu: shots.length ? shots : undefined },
    { type: "separator" },
    { label: count ? t("tray.quitWithWindows") : t("tray.quit"), click: () => app.quit() },
  ]));
}

// 只允许一个启动器：再从菜单点一次，就把已开着的窗口调到前面，而不是再管一套 scrcpy 进程
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(() => {
    setInterval(() => void checkNotifications(), NOTIFY_CHECK_MS);
    applyLanguage();
    nativeTheme.themeSource = config.theme;
    createWindow();
    if (!process.env.CHICHI_SNAPSHOT) createTray();
  });
}
// 窗口只会被藏起来，不会全部关掉；这里只在截图模式等真正关闭时才走到
app.on("window-all-closed", () => app.quit());
// 退出前先暂停正在播放的应用、等所有 scrcpy 进程结束，再真正退出
let stopped = false;
app.on("before-quit", (e) => {
  quitting = true;
  if (stopped) return;
  e.preventDefault();
  Promise.all([withdrawAll(), launcher.stopAll()]).finally(() => {
    stopped = true;
    app.quit();
  });
});
