// 界面逻辑。编译成普通脚本（不是模块），类型来自 src/shared/types.d.ts。
// 注意：preload 暴露的全局名是 phone，这里不能再声明同名变量。

const api = window.phone;

/** 镜像窗口的占位名，和主进程 scrcpy.ts 里的 MIRROR_KEY 一致 */
const MIRROR_KEY = "@mirror";
/** 额外屏幕的占位名，和主进程 scrcpy.ts 里的 DESKTOP_KEY 一致 */
const DESKTOP_KEY = "@desktop";

// ═══════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════

type View = "home" | "settings";
type SubView = "apps" | "window" | "audio" | "connect";

const ui = {
  state: null as AppState | null,
  devices: [] as Device[],
  deviceError: null as string | null,
  /** 当前使用的设备序列号，只会是状态为 device 的那台 */
  serial: null as string | null,
  apps: null as PhoneApp[] | null,
  appsFor: null as string | null,
  appsLoading: false,
  appsError: null as string | null,
  /** 已点击、scrcpy 进程还没起来的应用 */
  starting: new Set<string>(),
  /** 常用列表里展开的那一行 */
  expanded: null as string | null,
  /** 刚展开的那一行，只有它播放展开动画，重画时不重复播 */
  justExpanded: null as string | null,
  view: "home" as View,
  sub: "apps" as SubView,
  connecting: false,
  /** 正在连的那部记住的手机（序列号）；连「新手机」那一栏时为 null */
  connectingId: null as string | null,
  /** 每部手机（adb 编号）上装了的包名，用来标出常用列表里这部手机没有的应用 */
  installed: new Map<string, Set<string>>(),
  /** 「从另一部手机复制」第一次点击后等待确认 */
  copyArmed: false,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** 小工具：建一个元素 */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | boolean | number | ((e: Event) => void)>> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    // 走 CSSOM 赋值，不受 CSP 对内联 style 属性的限制
    else if (k === "style") el.style.cssText = String(v);
    else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== false) el.append(c);
  return el;
}

const config = () => ui.state!.config;

// ═══════════════════════════════════════════════
// 当前手机的设置：常用列表、默认尺寸、启动选项都跟着手机走
// ═══════════════════════════════════════════════

/** 当前手机的序列号：在线就用在线的那部，没连手机时显示上次用的那部 */
function currentId(): string | null {
  return ui.devices.find((d) => d.serial === ui.serial)?.id ?? config().preferredDevice;
}

function profile(): DeviceProfile {
  const id = currentId();
  return (id && config().devices[id]) || ui.state!.defaultProfile;
}

/** 只改当前手机那一份设置 */
async function saveProfile(patch: Partial<DeviceProfile>, message?: string): Promise<void> {
  const id = currentId();
  if (!id) {
    toast(t("app.noDevice"), "bad");
    return;
  }
  await save({ ...config(), devices: { ...config().devices, [id]: { ...profile(), ...patch } } }, message);
}

const saveLaunch = (patch: Partial<LaunchSettings>, message?: string) => saveProfile({ launch: { ...profile().launch, ...patch } }, message);

// ═══════════════════════════════════════════════
// 多语言：文案表随 AppState 一起从主进程拿来
// ═══════════════════════════════════════════════

function t(key: string, params?: Record<string, string | number>): string {
  const text = ui.state?.strings[key] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** 把 HTML 里 data-i18n 标记的固定文字换成当前语言，并设置文字方向 */
function applyStaticText(): void {
  const lang = ui.state!.language;
  document.documentElement.lang = lang.code;
  document.documentElement.dir = lang.dir;
  document.title = t("app.name");
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(el.dataset.i18n!);
  for (const el of document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder!);
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel!));

  const sel = $<HTMLSelectElement>("opt-language");
  const current = config().language;
  sel.replaceChildren(
    h("option", { value: "auto", selected: current === "auto" }, t("language.auto")),
    ...ui.state!.languages.map((l) => h("option", { value: l.code, selected: current === l.code, lang: l.code }, l.name)),
  );
}

async function save(next: Config, message = t("saved")): Promise<void> {
  ui.state = await api.saveConfig(next);
  toast(message, "ok");
  renderAll();
}

// ═══════════════════════════════════════════════
// 提示
// ═══════════════════════════════════════════════

let toastTimer: number | undefined;
/** 状态栏正在显示提示（而不是空闲说明） */
let toastActive = false;

/** 状态栏提示；action 是提示后面跟的一个按钮（如「打开文件夹」） */
function toast(text: string, kind: "ok" | "bad" | "info" = "info", sticky = false, action?: { label: string; run: () => void }): void {
  const el = $("status");
  toastActive = true;
  el.className = `status ${kind}`;
  el.title = text;
  el.replaceChildren(
    kind === "info" && sticky ? h("span", { class: "spinner" }) : "",
    h("span", {}, text),
    action ? h("button", { class: "btn btn-small status-action", onclick: action.run }, action.label) : "",
  );
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = window.setTimeout(showIdleHint, action ? 8000 : kind === "bad" ? 9000 : 3500);
}

/** 没有提示时状态栏显示一句当前该做什么 */
function showIdleHint(): void {
  const el = $("status");
  toastActive = false;
  el.className = "status";
  el.title = "";
  const text = !ui.serial ? t("idle.noDevice")
    : profile().pinned.length === 0 ? t("idle.noApps")
    : t("idle.ready");
  el.replaceChildren(h("span", {}, text));
}

// ═══════════════════════════════════════════════
// 尺寸
// ═══════════════════════════════════════════════

function sizeById(id: string | null): SizePreset | undefined {
  return ui.state!.sizes.find((s) => s.id === (id ?? profile().defaultSizeId));
}

/** App 看到的屏幕宽度（dp），即 px ÷ (dpi ÷ 160) */
const toDp = (px: number, dpi: number) => Math.round((px * 160) / dpi);

/** 尺寸名：内置尺寸如果文案表里有翻译（size.<id>）就用翻译，自定义尺寸用用户起的名字 */
function sizeName(s: SizePreset): string {
  return ui.state!.strings[`size.${s.id}`] ?? s.name;
}

function sizeLabel(s: SizePreset): string {
  if (s.id === "device") return sizeName(s);
  return `${sizeName(s)} · ${toDp(s.width, s.dpi)}×${toDp(s.height, s.dpi)}`;
}

/** 按比例画一个小手机框，并标出尺寸 */
function sizePreview(s: SizePreset | undefined): HTMLElement {
  if (!s) return h("div", { class: "size-caption" }, t("size.missing"));
  if (s.id === "device") {
    return h("div", { class: "size-preview" },
      h("div", { class: "size-frame", style: "width:26px;height:46px" }),
      h("div", { class: "size-caption" }, h("strong", {}, sizeName(s)), t("size.deviceHint")),
    );
  }
  const w = Math.min(s.width, s.height);
  const hgt = Math.max(s.width, s.height);
  const scale = 56 / hgt;
  return h("div", { class: "size-preview" },
    h("div", { class: "size-frame", style: `width:${Math.round(w * scale)}px;height:${Math.round(hgt * scale)}px` }),
    h("div", { class: "size-caption" },
      h("strong", {}, `${toDp(w, s.dpi)} × ${toDp(hgt, s.dpi)}`),
      t("size.pixels", { width: w, height: hgt, dpi: s.dpi }),
    ),
  );
}

// ═══════════════════════════════════════════════
// 应用圆点颜色：常用应用按排列顺序取色，保证前十个互不相同；其余为灰色
// ═══════════════════════════════════════════════

const DOT_COLORS = ["#E0685A", "#4C86D9", "#5DAE6B", "#E39B3B", "#8A6FD6", "#3FA7A3", "#D66BA8", "#C9B23A", "#7C8B5A", "#B5654A"];

function dot(pkg: string): HTMLSpanElement {
  const i = profile().pinned.findIndex((p) => p.pkg === pkg);
  const color = i === -1 ? "var(--line)" : DOT_COLORS[i % DOT_COLORS.length];
  return h("span", { class: "dot", style: `--dot:${color}`, "aria-hidden": "true" });
}

// ═══════════════════════════════════════════════
// 设备
// ═══════════════════════════════════════════════

let lastDeviceSnapshot = "";

/** 无线手机断了时查一次要等 3 秒，轮询不能叠起来 */
let devicesPending: Promise<void> | null = null;

function refreshDevices(): Promise<void> {
  devicesPending ??= loadDevices().finally(() => (devicesPending = null));
  return devicesPending;
}

async function loadDevices(): Promise<void> {
  const { devices, error, config: fresh } = await api.listDevices();
  // 主进程识别到新手机时会改配置，以它为准，免得拿旧配置保存把新手机的设置覆盖掉
  ui.state = { ...ui.state!, config: fresh };
  // 每 3 秒轮询一次，没变化就不重画，免得点到一半列表被替换掉
  const snapshot = JSON.stringify([devices, error, fresh.preferredDevice]);
  if (snapshot === lastDeviceSnapshot) return;
  lastDeviceSnapshot = snapshot;

  ui.devices = devices;
  ui.deviceError = error;

  const usable = devices.filter((d) => d.state === "device");
  const preferred = usable.find((d) => d.id !== null && d.id === config().preferredDevice);
  const stillHere = usable.find((d) => d.serial === ui.serial);
  const next = (preferred ?? stillHere ?? usable[0])?.serial ?? null;

  if (next !== ui.serial) {
    ui.serial = next;
    ui.expanded = null;
    loadInstalled();
    if (isOnAppsPage() && next && ui.appsFor !== next) loadApps();
  }
  renderDevice();
  renderHome();
  // 「已记住的手机」的在线状态也跟着设备变，不能等下次打开设置页才更新
  renderKnown(config().wireless.known);
}

function renderDevice(): void {
  const box = $("device");
  const usable = ui.devices.filter((d) => d.state === "device");
  const pending = ui.devices.find((d) => d.state !== "device");
  const current = usable.find((d) => d.serial === ui.serial);

  const describe = (d: Device) => `${d.name || d.model || d.serial} · ${t(d.wireless ? "device.wireless" : "device.usb")}`;

  if (ui.deviceError) {
    box.replaceChildren(h("span", { class: "device-label", title: ui.deviceError }, h("span", { class: "signal bad" }), t("device.adbError")));
    return;
  }
  if (!current) {
    const text = t(pending?.state === "unauthorized" ? "device.unauthorized" : "device.none");
    box.replaceChildren(h("span", { class: "device-label" }, h("span", { class: `signal ${pending ? "warn" : ""}` }), text));
    return;
  }
  if (usable.length === 1) {
    box.replaceChildren(h("span", { class: "device-label", title: current.serial }, h("span", { class: "signal ok" }), describe(current)));
    return;
  }
  const select = h("select", { "aria-label": t("aria.pickDevice"), onchange: (e: Event) => pickDevice((e.target as HTMLSelectElement).value) },
    ...usable.map((d) => h("option", { value: d.serial, selected: d.serial === ui.serial }, describe(d))));
  box.replaceChildren(h("span", { class: "signal ok" }), select);
}

async function pickDevice(serial: string): Promise<void> {
  ui.serial = serial;
  const id = ui.devices.find((d) => d.serial === serial)?.id ?? null;
  ui.expanded = null;
  await save({ ...config(), preferredDevice: id }, t("device.switched"));
  loadInstalled();
  if (isOnAppsPage()) loadApps();
}

// ═══════════════════════════════════════════════
// 常用：每行点开是一个抽屉，里面有打开按钮和这个应用的设置
// ═══════════════════════════════════════════════

function renderHome(): void {
  const pinned = profile().pinned;
  const running = new Set(ui.state!.running.map((r) => r.pkg));

  $("home-empty").hidden = pinned.length > 0;
  $("home-list").hidden = pinned.length === 0;

  const banner = $("home-banner");
  banner.hidden = Boolean(ui.serial) || pinned.length === 0;
  if (!banner.hidden) {
    const unauthorized = ui.devices.some((d) => d.state === "unauthorized");
    banner.replaceChildren(
      h("span", {}, ui.deviceError ?? t(unauthorized ? "banner.unauthorized" : "banner.notConnected")),
      h("span", { class: "banner-actions" }, ...bannerConnectButtons()),
    );
  }

  renderQuick(running);
  $("home-list").replaceChildren(...pinned.map((app, i) => appItem(app, i, running.has(app.pkg))));
  ui.justExpanded = null;

  if (!toastActive) showIdleHint();
}

/** 没连上手机时的快捷按钮：记住的手机各一个（最多 3 个），没有就用「连接新手机」栏里的地址 */
function bannerConnectButtons(): HTMLElement[] {
  const known = config().wireless.known.slice(0, 3);
  if (known.length > 0) {
    return known.map((k) => h("button", { class: "btn btn-small", onclick: () => connectWireless(k.id), disabled: ui.connecting },
      t(ui.connecting && ui.connectingId === k.id ? "connecting" : "banner.connectPhone", { name: k.name || k.host })));
  }
  if (!config().wireless.host) return [];
  return [h("button", { class: "btn btn-small", onclick: () => connectWireless(), disabled: ui.connecting }, t(ui.connecting ? "connecting" : "banner.connectWireless"))];
}

/** 声音位置的文案键：route.<id>、route.<id>Hint、route.changed<Id> */
const ROUTES: { id: AudioRoute; changed: string }[] = [
  { id: "phone", changed: "route.changedPhone" },
  { id: "computer", changed: "route.changedComputer" },
  { id: "both", changed: "route.changedBoth" },
];

/** 声音位置切换：常用页和设置页各放一个，行为相同 */
function routeButtons(): HTMLButtonElement[] {
  const p = profile();
  return ROUTES.map((r) => h("button", {
    "aria-pressed": String(p.launch.audioRoute === r.id),
    onclick: () => {
      if (p.launch.audioRoute === r.id) return;
      saveLaunch({ audioRoute: r.id }, t(r.changed));
    },
  }, t(`route.${r.id}`)));
}

/** 常用页顶部：镜像整个手机屏幕 + 声音位置 */
/** 常用页顶部的两张卡片：镜像整个手机屏幕、额外屏幕。文案键前缀分别是 mirror. / desktop. */
function renderQuick(running: Set<string>): void {
  $("home-mirror").replaceChildren(...quickCard(MIRROR_KEY, "mirror", "phone-glyph", running.has(MIRROR_KEY)));
  $("home-desktop").replaceChildren(...quickCard(DESKTOP_KEY, "desktop", "screen-glyph", running.has(DESKTOP_KEY)));
  $("home-route").replaceChildren(...routeButtons());
}

function quickCard(key: string, prefix: string, glyph: string, isRunning: boolean): HTMLElement[] {
  const starting = ui.starting.has(key);
  const button = isRunning
    ? h("button", { class: "btn btn-danger btn-small", onclick: () => stopQuick(key, prefix) }, t("app.close"))
    : h("button", { class: "btn btn-small", disabled: starting, onclick: () => launchQuick(key, prefix) }, t(starting ? "app.opening" : "app.open"));
  const shot = isRunning
    ? h("button", { class: "btn btn-small", title: t("shot.title", { name: t(`${prefix}.name`) }), onclick: () => takeShot(key) }, t("shot.button"))
    : null;
  return [
    h("span", { class: glyph, "aria-hidden": "true" }),
    h("span", { class: "app-main" },
      h("span", { class: "mirror-name" }, t(`${prefix}.name`)),
      h("span", { class: "app-meta" }, t(isRunning ? `${prefix}.metaRunning` : `${prefix}.meta`)),
    ),
    ...(shot ? [shot] : []),
    button,
  ];
}

async function launchQuick(key: string, prefix: string): Promise<void> {
  await launch({ pkg: key, name: t(`${prefix}.windowTitle`), sizeId: null, orientation: "portrait", resizable: false });
}

async function stopQuick(key: string, prefix: string): Promise<void> {
  toast(t(`${prefix}.closing`), "info", true);
  await api.stop(key);
  toast(t(`${prefix}.closed`), "ok");
}

// ═══════════════════════════════════════════════
// 这部手机装了哪些应用
// ═══════════════════════════════════════════════

async function loadInstalled(): Promise<void> {
  const serial = ui.serial;
  if (!serial || ui.installed.has(serial)) return;
  const pkgs = await api.listPackages(serial);
  if (pkgs) ui.installed.set(serial, new Set(pkgs));
  renderHome();
}

/** 已知这部手机没装这个应用时为 true；还没读到安装列表时当作装了，不误报 */
function notInstalled(pkg: string): boolean {
  const set = ui.serial ? ui.installed.get(ui.serial) : undefined;
  return Boolean(set) && !set!.has(pkg);
}

function appItem(app: PinnedApp, index: number, isRunning: boolean): HTMLLIElement {
  const open = ui.expanded === app.pkg;
  const missing = notInstalled(app.pkg);
  const size = sizeById(app.sizeId);
  const meta = missing ? t("app.notInstalled") : [
    size ? sizeName(size) : t("app.sizeDeleted"),
    t(app.orientation === "portrait" ? "app.portrait" : "app.landscape"),
    app.resizable ? t("app.resizableTag") : "",
  ].filter(Boolean).join(" · ");

  const state = ui.starting.has(app.pkg)
    ? h("span", { class: "app-state" }, h("span", { class: "spinner" }), t("app.openingShort"))
    : isRunning ? h("span", { class: "app-state running" }, h("span", { class: "run-dot" }), t("app.isOpen")) : null;

  const row = h("button", {
    class: "app-row",
    "aria-expanded": String(open),
    "aria-controls": `drawer-${index}`,
    onclick: () => toggleExpanded(app.pkg),
  },
    dot(app.pkg),
    h("span", { class: "app-main" }, h("span", { class: "app-name" }, app.name), h("span", { class: "app-meta" }, meta)),
    state,
    h("span", { class: "chevron", "aria-hidden": "true" }),
  );

  const cls = ["app-item", open ? "open" : "", missing ? "missing" : ""].filter(Boolean).join(" ");
  // 开着的窗口在行尾放一个截图按钮，一点就截，不用先展开
  const shot = isRunning
    ? h("button", { class: "row-shot", title: t("shot.title", { name: app.name }), "aria-label": t("shot.title", { name: app.name }), onclick: () => takeShot(app.pkg) }, t("shot.button"))
    : null;
  return h("li", { class: cls }, h("div", { class: "row-line" }, row, shot), open ? drawer(app, index, isRunning) : null);
}

function drawer(app: PinnedApp, index: number, isRunning: boolean): HTMLDivElement {
  const starting = ui.starting.has(app.pkg);
  const primary = isRunning
    ? h("button", { class: "btn btn-danger", onclick: () => stop(app) }, t("app.closeWindow"))
    : h("button", { class: "btn btn-primary", disabled: starting || notInstalled(app.pkg), onclick: () => launch(app) }, t(starting ? "app.opening" : "app.open"));

  const sizeSelect = h("select", {
    class: "input",
    id: `size-${index}`,
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      updateApp(app.pkg, { sizeId: v === "" ? null : v });
    },
  },
    h("option", { value: "", selected: app.sizeId === null }, t("app.defaultSize", { size: (() => { const d = sizeById(null); return d ? sizeName(d) : t("app.sizeUnset"); })() })),
    ...ui.state!.sizes.map((s) => h("option", { value: s.id, selected: s.id === app.sizeId }, sizeLabel(s))),
  );

  const seg = h("div", { class: "seg", role: "group", "aria-label": t("aria.orientation") },
    ...(["portrait", "landscape"] as const).map((o) =>
      h("button", { "aria-pressed": String(app.orientation === o), onclick: () => updateApp(app.pkg, { orientation: o }) },
        t(o === "portrait" ? "app.portrait" : "app.landscape"))),
  );

  const modeSeg = h("div", { class: "seg", role: "group", "aria-label": t("app.sizeMode") },
    ...([false, true] as const).map((r) =>
      h("button", { "aria-pressed": String(app.resizable === r), onclick: () => updateApp(app.pkg, { resizable: r }) },
        t(r ? "app.resizable" : "app.fixed"))),
  );

  return h("div", { class: ui.justExpanded === app.pkg ? "drawer entering" : "drawer", id: `drawer-${index}` },
    h("div", { class: "drawer-fields" },
      h("label", { class: "field field-size", for: `size-${index}` }, h("span", {}, t("app.windowSize")), sizeSelect),
      h("div", { class: "field" }, h("span", {}, t("app.orientation")), seg),
      h("div", { class: "field" }, h("span", {}, t("app.sizeMode")), modeSeg),
    ),
    app.resizable ? h("p", { class: "hint" }, t("app.resizableHint")) : null,
    notInstalled(app.pkg) ? h("p", { class: "hint warn" }, t("app.notInstalledHint", { name: app.name })) : null,
    isRunning ? h("p", { class: "hint" }, t("app.applyNextTime")) : null,
    h("div", { class: "drawer-actions" },
      primary,
      h("span", { class: "spacer" }),
      h("button", { class: "btn btn-quiet", disabled: index === 0, onclick: () => pinToTop(app) }, t("app.pinToTop")),
      h("button", { class: "btn btn-quiet", onclick: () => unpin(app) }, t("app.remove")),
    ),
  );
}

function toggleExpanded(pkg: string): void {
  ui.expanded = ui.expanded === pkg ? null : pkg;
  ui.justExpanded = ui.expanded;
  renderHome();
}

function updateApp(pkg: string, patch: Partial<PinnedApp>): void {
  saveProfile({ pinned: profile().pinned.map((p) => (p.pkg === pkg ? { ...p, ...patch } : p)) });
}

function pinToTop(app: PinnedApp): void {
  const rest = profile().pinned.filter((p) => p.pkg !== app.pkg);
  saveProfile({ pinned: [app, ...rest] }, t("app.pinnedToTop", { name: app.name }));
}

async function launch(app: PinnedApp): Promise<void> {
  if (!ui.serial) {
    toast(t("app.noDevice"), "bad");
    return;
  }
  if (ui.starting.has(app.pkg)) return;

  ui.starting.add(app.pkg);
  renderHome();
  toast(t("app.openingToast", { name: app.name }), "info", true);

  const result = await api.launch(app.pkg, ui.serial);
  if (!result.ok) {
    ui.starting.delete(app.pkg);
    renderHome();
    toast(result.message, "bad");
    return;
  }
  // 窗口要等 scrcpy 连上手机才出现，给一点时间再撤掉“打开中”
  setTimeout(() => {
    ui.starting.delete(app.pkg);
    renderHome();
  }, 2500);
  toast(result.message, "ok");
}

async function takeShot(pkg: string): Promise<void> {
  toast(t("shot.taking"), "info", true);
  showShotResult(await api.screenshot(pkg));
}

function showShotResult(result: ActionResult): void {
  if (result.ok) toast(result.message, "ok", false, { label: t("shot.openFolder"), run: () => api.openScreenshots() });
  else toast(result.message, "bad");
}

api.onScreenshotDone(showShotResult);

api.onPhoneDisconnected((name) => toast(t("device.disconnectedOnPhone", { name }), "info"));

async function stop(app: PinnedApp): Promise<void> {
  toast(t("app.closingToast", { name: app.name }), "info", true);
  await api.stop(app.pkg);
  toast(t(profile().launch.pauseOnClose ? "app.closedPaused" : "app.closed", { name: app.name }), "ok");
}

api.onRunningChanged((running, exit) => {
  ui.state = { ...ui.state!, running };
  if (exit?.kind === "app" || exit?.kind === "returned") ui.starting.delete(exit.pkg);
  if (exit?.kind === "returned") toast(t("app.returnedToPhone", { name: exit.name }), "ok");
  if (exit?.error) {
    toast(exit.kind === "audio"
      ? t("app.audioStopped", { error: exit.error })
      : t("app.crashed", { name: exit.name, error: exit.error }), "bad");
  }
  renderHome();
});

// ═══════════════════════════════════════════════
// 设置 → 应用：挑选常用应用
// ═══════════════════════════════════════════════

const isOnAppsPage = () => ui.view === "settings" && ui.sub === "apps";

async function loadApps(): Promise<void> {
  if (!ui.serial || ui.appsLoading) return;
  ui.appsLoading = true;
  ui.appsError = null;
  renderCatalog();
  const serial = ui.serial;
  const { apps, error } = await api.listApps(serial);
  ui.appsLoading = false;
  ui.apps = error ? ui.apps : apps;
  ui.appsFor = error ? ui.appsFor : serial;
  ui.appsError = error;
  renderCatalog();
  if (!error) toast(t("apps.loaded", { count: apps.length }), "ok");
}

function pin(app: PhoneApp): void {
  if (profile().pinned.some((p) => p.pkg === app.pkg)) return;
  const entry: PinnedApp = { pkg: app.pkg, name: app.name, sizeId: null, orientation: "portrait", resizable: false };
  saveProfile({ pinned: [...profile().pinned, entry] }, t("apps.addedToast", { name: app.name }));
}

function unpin(app: { pkg: string; name: string }): void {
  if (ui.expanded === app.pkg) ui.expanded = null;
  saveProfile({ pinned: profile().pinned.filter((p) => p.pkg !== app.pkg) }, t("apps.removedToast", { name: app.name }));
}

function renderCatalog(): void {
  const list = $("catalog");
  const note = (text: string, withSpinner = false) =>
    list.replaceChildren(h("li", { class: "catalog-note" }, withSpinner ? h("span", { class: "spinner" }) : "", text));

  $("apps-refresh").toggleAttribute("disabled", ui.appsLoading || !ui.serial);

  if (!ui.serial) return note(t("apps.connectFirst"));
  if (ui.appsLoading && !ui.apps) return note(t("apps.loading"), true);
  if (ui.appsError && !ui.apps) return note(ui.appsError);
  if (!ui.apps) return note("");

  const query = $<HTMLInputElement>("app-search").value.trim().toLowerCase();
  const showSystem = $<HTMLInputElement>("show-system").checked;
  const pinned = new Set(profile().pinned.map((p) => p.pkg));

  const shown = ui.apps.filter((a) =>
    (showSystem || !a.system || pinned.has(a.pkg)) &&
    (!query || a.name.toLowerCase().includes(query) || a.pkg.toLowerCase().includes(query)));

  $("apps-count").textContent = `${shown.length} / ${ui.apps.length}`;
  if (shown.length === 0) return note(query ? t("apps.notFound", { query }) : t("apps.none"));

  list.replaceChildren(...shown.map((app) =>
    h("li", {},
      dot(app.pkg),
      h("span", { class: "name-block" }, h("span", { class: "name" }, app.name), h("span", { class: "pkg" }, app.pkg)),
      pinned.has(app.pkg)
        ? h("button", { class: "btn btn-small btn-added", title: t("apps.addedTitle"), onclick: () => unpin(app) }, t("apps.added"))
        : h("button", { class: "btn btn-small", onclick: () => pin(app) }, t("apps.add")),
    )));
}

// ═══════════════════════════════════════════════
// 设置 → 窗口 / 声音 / 连接
// ═══════════════════════════════════════════════

/** 缓冲档位的文案键：audio.buffer<Id>、audio.buffer<Id>Hint */
const BUFFER_LEVELS: { id: AudioBufferLevel; key: string }[] = [
  { id: "large", key: "audio.bufferLarge" },
  { id: "medium", key: "audio.bufferMedium" },
  { id: "small", key: "audio.bufferSmall" },
];

function renderSettings(): void {
  const c = config();
  const p = profile();

  // 哪部手机的设置
  const id = currentId();
  const owner = id ? c.devices[id]?.name || id : null;
  for (const el of document.querySelectorAll<HTMLElement>(".for-device")) {
    el.textContent = owner ? t("settings.forDevice", { name: owner }) : t("settings.noDevice");
  }
  renderCopy(id);

  // 窗口
  const sel = $<HTMLSelectElement>("default-size");
  sel.replaceChildren(...ui.state!.sizes.map((s) => h("option", { value: s.id, selected: s.id === p.defaultSizeId }, sizeLabel(s))));
  $("default-size-preview").replaceChildren(sizePreview(sizeById(null)));

  $("custom-list").replaceChildren(...c.customSizes.map((s) =>
    h("li", {},
      h("span", {}, `${s.name} `, h("span", { class: "pkg" }, `${s.width}×${s.height} · ${s.dpi} dpi`)),
      h("button", { class: "btn btn-small", onclick: () => removeCustomSize(s) }, t("custom.delete")),
    )));
  $<HTMLSelectElement>("opt-ime").value = p.launch.imePolicy;
  $<HTMLSelectElement>("opt-keyboard").value = p.launch.keyboard;
  $("opt-keyboard-hint").textContent = t(p.launch.keyboard === "uhid" ? "input.uhidHint" : "input.sdkHint");
  $<HTMLInputElement>("opt-wake").checked = p.launch.wakeOnLaunch;
  $<HTMLInputElement>("opt-stay").checked = p.launch.stayInApp;
  setValue("opt-extra", p.launch.extraArgs);

  // 外观
  $("opt-theme").replaceChildren(...(["system", "light", "dark"] as const).map((th) =>
    h("button", {
      "aria-pressed": String(c.theme === th),
      onclick: () => { if (c.theme !== th) save({ ...c, theme: th }, t("theme.saved")); },
    }, t(`theme.${th}`))));

  // 声音
  $("opt-route").replaceChildren(...routeButtons());
  $("opt-route-hint").textContent = t(`route.${p.launch.audioRoute}Hint`);
  $<HTMLInputElement>("opt-pause").checked = p.launch.pauseOnClose;
  $("opt-buffer").replaceChildren(...BUFFER_LEVELS.map((b) =>
    h("button", {
      "aria-pressed": String(p.launch.audioBuffer === b.id),
      disabled: p.launch.audioRoute === "phone",
      onclick: () => saveLaunch({ audioBuffer: b.id }, t("audio.bufferChanged", { level: t(b.key) })),
    }, t(b.key))));
  const level = BUFFER_LEVELS.find((b) => b.id === p.launch.audioBuffer);
  $("opt-buffer-hint").textContent = level ? t(`${level.key}Hint`) : "";

  // 连接
  renderKnown(c.wireless.known);
  setValue("wl-host", c.wireless.host);
  setValue("wl-range", c.wireless.portRange);
  $("wl-last").textContent = c.wireless.lastPort ? t("wireless.lastPort", { port: c.wireless.lastPort }) : "";
  const btn = $<HTMLButtonElement>("wl-connect");
  btn.disabled = ui.connecting;
  btn.textContent = t(ui.connecting && ui.connectingId === null ? "connecting" : "wireless.connect");
  setValue("tool-adb", c.tools.adb);
  setValue("tool-scrcpy", c.tools.scrcpy);
}

/** 记住的手机：无线在线的显示「已连接」，否则给一个「连接」按钮 */
function renderKnown(known: KnownPhone[]): void {
  $("known-group").hidden = known.length === 0;
  $("known-list").replaceChildren(...known.map((k) => {
    const online = ui.devices.some((d) => d.id === k.id && d.wireless && d.state === "device");
    return h("li", {},
      h("span", { class: "name-block" }, h("span", { class: "name" }, k.name || k.id), h("span", { class: "pkg", dir: "ltr" }, k.host)),
      h("span", { class: "toolbar" },
        online
          ? h("span", { class: "hint" }, t("wireless.online"))
          : h("button", { class: "btn btn-small btn-primary", onclick: () => connectWireless(k.id), disabled: ui.connecting },
            t(ui.connecting && ui.connectingId === k.id ? "connecting" : "wireless.connect")),
        h("button", { class: "btn btn-small", onclick: () => forgetPhone(k) }, t("wireless.forget"))));
  }));
}

function forgetPhone(k: KnownPhone): void {
  const c = config();
  save({ ...c, wireless: { ...c.wireless, known: c.wireless.known.filter((o) => o.id !== k.id) } }, t("wireless.forgotten", { name: k.name || k.host }));
}

/** 「从另一部手机复制」：列出其它手机；要点两次才真正覆盖 */
function renderCopy(id: string | null): void {
  const others = Object.entries(config().devices).filter(([other]) => other !== id);
  const box = $("copy-group");
  box.hidden = !id || others.length === 0;
  if (box.hidden) return;

  const sel = $<HTMLSelectElement>("copy-from");
  const keep = sel.value;
  sel.replaceChildren(...others.map(([other, d]) => h("option", { value: other, selected: other === keep }, d.name || other)));
  $("copy-go").textContent = t(ui.copyArmed ? "copy.confirm" : "copy.button");
  $("copy-go").classList.toggle("btn-danger", ui.copyArmed);
}

let copyTimer: number | undefined;

async function copyFromOther(): Promise<void> {
  const from = $<HTMLSelectElement>("copy-from").value;
  const source = config().devices[from];
  if (!source) return;
  if (!ui.copyArmed) {
    ui.copyArmed = true;
    renderSettings();
    copyTimer = window.setTimeout(() => { ui.copyArmed = false; renderSettings(); }, 4000);
    return;
  }
  clearTimeout(copyTimer);
  ui.copyArmed = false;
  await saveProfile(
    { pinned: source.pinned.map((a) => ({ ...a })), defaultSizeId: source.defaultSizeId, launch: { ...source.launch } },
    t("copy.done", { name: source.name || from }),
  );
}

/** 用户正在输入的框不回写，免得光标跳走 */
function setValue(id: string, value: string): void {
  const el = $<HTMLInputElement>(id);
  if (document.activeElement !== el) el.value = value;
}

function removeCustomSize(s: SizePreset): void {
  const c = config();
  const fallback = ui.state!.sizes.find((x) => x.id !== s.id && x.id !== "device")?.id ?? "device";
  // 自定义尺寸是公共的：每部手机里用到它的地方都改回默认
  const devices: Record<string, DeviceProfile> = {};
  for (const [id, d] of Object.entries(c.devices)) {
    devices[id] = {
      ...d,
      defaultSizeId: d.defaultSizeId === s.id ? fallback : d.defaultSizeId,
      pinned: d.pinned.map((a) => (a.sizeId === s.id ? { ...a, sizeId: null } : a)),
    };
  }
  save({ ...c, customSizes: c.customSizes.filter((x) => x.id !== s.id), devices }, t("custom.deleted", { name: s.name }));
}

function customFormValues(): { name: string; width: number; height: number; dpi: number } {
  const num = (id: string) => Number($<HTMLInputElement>(id).value);
  return { name: $<HTMLInputElement>("custom-name").value.trim(), width: num("custom-width"), height: num("custom-height"), dpi: num("custom-dpi") };
}

function updateCustomCalc(): void {
  const { width, height, dpi } = customFormValues();
  const el = $("custom-calc");
  if (width > 0 && height > 0 && dpi > 0) {
    const [short, long] = [Math.min(width, height), Math.max(width, height)];
    el.textContent = t("custom.calc", { width: toDp(short, dpi), height: toDp(long, dpi) });
  } else {
    el.textContent = t("custom.formula");
  }
}

async function connectWireless(id?: string): Promise<void> {
  if (ui.connecting) return;
  ui.connecting = true;
  ui.connectingId = id ?? null;
  $("wl-log").textContent = "";
  renderSettings();
  renderHome();
  toast(t("wireless.connecting"), "info", true);

  const result = await api.connectWireless(id);
  ui.connecting = false;
  ui.connectingId = null;
  appendLog(result.message);
  toast(result.message, result.ok ? "ok" : "bad");
  ui.state = await api.getState();
  await refreshDevices();
  renderAll();
}

function appendLog(line: string): void {
  const log = $("wl-log");
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
}

api.onConnectProgress((line) => {
  appendLog(line);
  toast(line, "info", true);
});

async function checkTools(): Promise<void> {
  const box = $("tool-status");
  box.replaceChildren(h("span", {}, h("span", { class: "spinner" }), " ", t("tools.checking")));
  const s = await api.checkTools();
  const line = (label: string, r: { ok: boolean; detail: string }) =>
    h("span", { class: r.ok ? "ok" : "bad", title: r.detail }, `${r.ok ? "✓" : "✕"} ${t("tools.line", { label, detail: r.detail })}`);
  box.replaceChildren(line("adb", s.adb), line("scrcpy", s.scrcpy));
}

// ═══════════════════════════════════════════════
// 视图切换与事件绑定
// ═══════════════════════════════════════════════

function showView(view: View, sub?: SubView): void {
  ui.view = view;
  if (sub) ui.sub = sub;
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.view === view));
  }
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".subtab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.sub === ui.sub));
  }
  $("view-home").hidden = view !== "home";
  $("view-settings").hidden = view !== "settings";
  for (const s of ["apps", "window", "audio", "connect"] as const) $(`subview-${s}`).hidden = s !== ui.sub;

  if (isOnAppsPage() && ui.serial && ui.appsFor !== ui.serial) loadApps();
  renderAll();
}

function renderAll(): void {
  renderDevice();
  renderHome();
  if (ui.view === "settings") {
    renderSettings();
    if (ui.sub === "apps") renderCatalog();
  }
}

function bindEvents(): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.addEventListener("click", () => showView(tab.dataset.view as View));
  }
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".subtab")) {
    tab.addEventListener("click", () => showView("settings", tab.dataset.sub as SubView));
  }
  $("goto-apps").addEventListener("click", () => showView("settings", "apps"));

  $("app-search").addEventListener("input", renderCatalog);
  $("show-system").addEventListener("change", renderCatalog);
  $("apps-refresh").addEventListener("click", loadApps);

  $("default-size").addEventListener("change", (e) =>
    saveProfile({ defaultSizeId: (e.target as HTMLSelectElement).value }));

  for (const id of ["custom-name", "custom-width", "custom-height", "custom-dpi"]) $(id).addEventListener("input", updateCustomCalc);
  $("custom-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = customFormValues();
    const size: SizePreset = { id: `custom-${Date.now()}`, ...v };
    (e.target as HTMLFormElement).reset();
    updateCustomCalc();
    save({ ...config(), customSizes: [...config().customSizes, size] }, t("custom.added", { name: v.name }));
  });

  // 文本框：离开输入框或按回车时保存
  const onCommit = (id: string, apply: (c: Config, value: string) => Config) => {
    $(id).addEventListener("change", (e) => {
      const value = (e.target as HTMLInputElement).value.trim();
      save(apply(config(), value));
    });
  };
  onCommit("wl-host", (c, v) => ({ ...c, wireless: { ...c.wireless, host: v, lastPort: v === c.wireless.host ? c.wireless.lastPort : null } }));
  onCommit("wl-range", (c, v) => ({ ...c, wireless: { ...c.wireless, portRange: v } }));
  onCommit("tool-adb", (c, v) => ({ ...c, tools: { ...c.tools, adb: v } }));
  onCommit("tool-scrcpy", (c, v) => ({ ...c, tools: { ...c.tools, scrcpy: v } }));

  const onToggle = (id: string, patch: (on: boolean) => Partial<LaunchSettings>, onKey: string, offKey: string) => {
    $(id).addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      saveLaunch(patch(on), t(on ? onKey : offKey));
    });
  };
  $("opt-extra").addEventListener("change", (e) => saveLaunch({ extraArgs: (e.target as HTMLInputElement).value.trim() }));
  onToggle("opt-pause", (on) => ({ pauseOnClose: on }), "audio.pauseOn", "audio.pauseOff");
  onToggle("opt-wake", (on) => ({ wakeOnLaunch: on }), "phone.wakeOn", "phone.wakeOff");
  onToggle("opt-stay", (on) => ({ stayInApp: on }), "phone.stayOn", "phone.stayOff");
  $("opt-keyboard").addEventListener("change", (e) =>
    saveLaunch({ keyboard: (e.target as HTMLSelectElement).value as KeyboardMode },
      t("input.keyboardSaved")));
  $("opt-ime").addEventListener("change", (e) =>
    saveLaunch({ imePolicy: (e.target as HTMLSelectElement).value as ImePolicy }));

  $("opt-language").addEventListener("change", async (e) => {
    ui.state = await api.saveConfig({ ...config(), language: (e.target as HTMLSelectElement).value });
    applyStaticText();
    renderAll();
    toast(t("language.saved"), "ok");
  });

  $("copy-go").addEventListener("click", copyFromOther);
  $("wl-connect").addEventListener("click", () => connectWireless());
  $("tool-check").addEventListener("click", checkTools);
}

// ═══════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════

const DEVICE_POLL_MS = 3000;

async function start(): Promise<void> {
  ui.state = await api.getState();
  applyStaticText();
  bindEvents();
  updateCustomCalc();
  renderAll();
  if (ui.state.configNotice) toast(ui.state.configNotice, "bad");
  await refreshDevices();
  setInterval(refreshDevices, DEVICE_POLL_MS);
}

start();
