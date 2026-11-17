// scrcpy 相关：列应用、算窗口尺寸、拼启动参数、管理已打开的窗口进程。

import { spawn, type ChildProcess } from "node:child_process";
import { run } from "./adb";
import { defaultLaunch, DEVICE_SIZE_ID } from "./config";
import { pauseIfPlaying } from "./media";
import { t } from "./i18n";
import { bringToFront, hasSecondaryHome, isHome, MIN_SDK, parseStartLine, readDefaultHome, readHomeComponents, readLaunchComponent, readSdk, readTopActivities, screenshot, tapOnDisplay, wakeIfAsleep, type StartRecord } from "./device";

// ═══════════════════════════════════════════════
// 应用列表
// ═══════════════════════════════════════════════

/**
 * 解析 `scrcpy --list-apps` 的输出。每行形如
 *   " * 设置                             com.android.settings"
 * `*` 是系统应用，`-` 是用户安装的应用；包名是最后一段，前面剩下的是名称。
 */
export function parseAppList(output: string): PhoneApp[] {
  const apps: PhoneApp[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*([*-])\s+(.+?)\s+([A-Za-z][\w.]*)\s*$/.exec(line);
    if (!m) continue;
    apps.push({ system: m[1] === "*", name: m[2], pkg: m[3] });
  }
  return apps;
}

export async function listApps(scrcpy: string, adb: string, serial: string): Promise<{ apps: PhoneApp[]; error: string | null }> {
  const r = await run(scrcpy, ["-s", serial, "--list-apps"], 60000, { ...process.env, ADB: adb });
  if (r.missing) return { apps: [], error: missingScrcpy(scrcpy) };
  if (r.timedOut) return { apps: [], error: t("err.listAppsTimeout") };
  const apps = parseAppList(r.stdout + "\n" + r.stderr);
  if (apps.length === 0) return { apps, error: t("err.listAppsEmpty", { detail: lastErrorLine(r.stderr || r.stdout) ?? t("err.noOutput") }) };
  apps.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return { apps, error: null };
}

const missingScrcpy = (bin: string) => t("err.scrcpyMissing", { bin });

// ═══════════════════════════════════════════════
// 窗口尺寸
// ═══════════════════════════════════════════════

export interface DisplaySpec {
  width: number;
  height: number;
  dpi: number;
}

/** 解析 `wm size` / `wm density`，有 Override 时以 Override 为准 */
export function parseWmOutput(sizeOut: string, densityOut: string): DisplaySpec | null {
  const pick = (text: string, re: RegExp) => {
    const override = new RegExp(`Override ${re.source}`).exec(text);
    return override ?? new RegExp(`Physical ${re.source}`).exec(text);
  };
  const size = pick(sizeOut, /size: (\d+)x(\d+)/);
  const density = pick(densityOut, /density: (\d+)/);
  if (!size || !density) return null;
  return { width: Number(size[1]), height: Number(size[2]), dpi: Number(density[1]) };
}

async function readDeviceDisplay(adb: string, serial: string): Promise<DisplaySpec | null> {
  const [size, density] = await Promise.all([
    run(adb, ["-s", serial, "shell", "wm", "size"], 8000),
    run(adb, ["-s", serial, "shell", "wm", "density"], 8000),
  ]);
  return parseWmOutput(size.stdout, density.stdout);
}

/** 按方向摆正：竖屏高大于宽，横屏宽大于高 */
export function orient(spec: DisplaySpec, orientation: Orientation): DisplaySpec {
  const long = Math.max(spec.width, spec.height);
  const short = Math.min(spec.width, spec.height);
  return orientation === "portrait"
    ? { width: short, height: long, dpi: spec.dpi }
    : { width: long, height: short, dpi: spec.dpi };
}

// ═══════════════════════════════════════════════
// 启动参数
// ═══════════════════════════════════════════════

/**
 * 应用窗口一律不带声音。scrcpy 抓的是整部手机的声音输出，不分应用，
 * 每个窗口各抓一份会把同一段声音以不同延迟播好几遍。声音由单独的进程负责。
 */
export function buildLaunchArgs(serial: string, app: PinnedApp, display: DisplaySpec, launch: LaunchSettings, scale = 1): string[] {
  const d = app.resizable ? toFlexDisplay(display, scale) : display;
  return [
    "-s", serial,
    `--new-display=${d.width}x${d.height}/${d.dpi}`,
    ...(app.resizable ? ["--flex-display"] : []),
    `--start-app=${app.pkg}`,
    `--window-title=${app.name}`,
    `--display-ime-policy=${launch.imePolicy}`,
    `--keyboard=${launch.keyboard}`,
    "--no-audio",
    // 让 scrcpy 把每次点击打出来（input: touch ...），手机睡着时据此唤醒并补发点击；这些行不落日志
    "--verbosity=verbose",
    ...launch.extraArgs.split(/\s+/).filter(Boolean),
  ];
}

/**
 * 可拖动窗口时，scrcpy 会把手机上的屏幕改成和窗口一样的像素大小，dpi 却不变。
 * 按原 dpi 算，窗口缩到 400 像素宽时 App 只看到一百多 dp，界面会大得没法用。
 * 所以让「窗口的 1 个物理像素 = 手机上的 1 个像素」，dpi 取 160 × 桌面缩放比例：
 * 排版宽度和原尺寸一致，字的大小和桌面其它东西相当，拖多大就按多大排版。
 * 桌面有缩放时还要配合 SDL_VIDEO_WAYLAND_SCALE_TO_DISPLAY（见 flexEnv），否则 scrcpy 按逻辑尺寸
 * 建屏幕，1.5 倍缩放下只画三分之二的像素再被放大，画面发糊。
 */
export function toFlexDisplay(display: DisplaySpec, scale = 1): DisplaySpec {
  const dpi = Math.round(160 * scale);
  const toPx = (px: number) => Math.round((px * dpi) / display.dpi);
  return { width: toPx(display.width), height: toPx(display.height), dpi };
}

/**
 * scrcpy 根据窗口的逻辑尺寸调整手机上的屏幕（源码 screen.c 里直接用 SDL_EVENT_WINDOW_RESIZED 的数值），
 * 不考虑桌面缩放。让 SDL 按物理像素计算窗口，逻辑尺寸就等于物理尺寸，画面一比一不糊。
 */
export function flexEnv(resizable: boolean, scale: number, wayland = isWayland()): NodeJS.ProcessEnv {
  // 只有 Wayland 按逻辑尺寸算窗口；Windows 和 X11 下 SDL3 的窗口尺寸本来就是物理像素（SDL README-highdpi）
  return resizable && scale !== 1 && wayland ? { SDL_VIDEO_WAYLAND_SCALE_TO_DISPLAY: "1" } : {};
}

const isWayland = () => process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || Boolean(process.env.WAYLAND_DISPLAY));

export const AUDIO_BUFFER_MS: Record<AudioBufferLevel, number> = { small: 50, medium: 120, large: 250 };

/**
 * 只转声音的进程：没有画面、没有窗口、不接受控制。
 * 只在电脑响：抓整机输出（output），手机随之静音。
 * 两边都响：抓播放声（playback）并保留手机外放（--audio-dup）；个别应用禁止被录音，它们只在手机上响。
 */
export function buildAudioArgs(serial: string, buffer: AudioBufferLevel, route: Exclude<AudioRoute, "phone">): string[] {
  const args = ["-s", serial, "--no-video", "--no-window", "--no-control", `--audio-buffer=${AUDIO_BUFFER_MS[buffer]}`];
  if (route === "both") args.push("--audio-source=playback", "--audio-dup");
  return args;
}

/** 镜像整个手机屏幕：scrcpy 最基本的用法，不建虚拟屏幕 */
export function buildMirrorArgs(serial: string, launch: LaunchSettings, title: string): string[] {
  return [
    "-s", serial,
    `--window-title=${title}`,
    `--keyboard=${launch.keyboard}`,
    "--no-audio",
    "--verbosity=verbose",
    ...launch.extraArgs.split(/\s+/).filter(Boolean),
  ];
}

/**
 * 额外屏幕：不带应用的虚拟屏幕，手机会在上面显示它的副屏桌面（三星是 DeX 桌面），
 * 在上面开什么应用都行。窗口可拖动，手机上的屏幕跟着窗口变大小（见 toFlexDisplay）。
 * 关掉时上面开着的应用挪回手机，而不是被结束（--no-vd-destroy-content）。
 */
export function buildDesktopArgs(serial: string, launch: LaunchSettings, title: string, scale = 1): string[] {
  const d = toFlexDisplay(DESKTOP_DISPLAY, scale);
  return [
    "-s", serial,
    `--new-display=${d.width}x${d.height}/${d.dpi}`,
    "--flex-display",
    "--no-vd-destroy-content",
    `--window-title=${title}`,
    `--display-ime-policy=${launch.imePolicy}`,
    `--keyboard=${launch.keyboard}`,
    "--no-audio",
    "--verbosity=verbose",
    ...launch.extraArgs.split(/\s+/).filter(Boolean),
  ];
}

/** 额外屏幕打开时的大小：横向 1080p，排版宽度 1280dp；之后跟着窗口变 */
const DESKTOP_DISPLAY: DisplaySpec = { width: 1920, height: 1080, dpi: 240 };

export type InputEvent =
  | { kind: "down" | "move" | "up"; x: number; y: number }
  /** 键盘、滚动、打字、右键等：只需要手机醒着，不补发 */
  | { kind: "other" };

/**
 * 解析 scrcpy verbose 日志里的输入行（源码 control_msg.c 的 sc_control_msg_log），例如
 *   VERBOSE: input: touch [id=mouse] down position=600,1100 pressure=1.000000 ...
 * 不是输入行返回 null；鼠标悬停移动（hover-move）也返回 null——光是鼠标划过窗口不该叫醒手机。
 */
export function parseInputLine(line: string): InputEvent | null {
  const i = line.indexOf("input: ");
  if (i === -1) return null;
  const msg = line.slice(i);
  const touch = /^input: touch \[id=[^\]]+\]\s+([\w-]+)\s+position=(-?\d+),(-?\d+)/.exec(msg);
  // 只有你在窗口里的操作才算；scrcpy 自己发的同步剪贴板、开关屏幕之类的内部消息不算
  if (!touch) return /^input: (key|text|scroll|back-or-screen-on|uhid-input)\b/.test(msg) ? { kind: "other" } : null;
  const action = touch[1];
  if (action === "down" || action === "move" || action === "up") return { kind: action, x: Number(touch[2]), y: Number(touch[3]) };
  return null;
}

/** 按下和抬起离得近、时间短，才算一次点击；拖动、长按不补发 */
export function isTap(down: { x: number; y: number; t: number }, up: { x: number; y: number; t: number }): boolean {
  return up.t - down.t <= TAP_MAX_MS && Math.hypot(up.x - down.x, up.y - down.y) <= TAP_MAX_MOVE;
}

const TAP_MAX_MS = 500;
const TAP_MAX_MOVE = 24;

/** 从 scrcpy 输出里挑出最能说明问题的一行 */
export function lastErrorLine(output: string): string | null {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => /ERROR|Exception|error:/i.test(l));
  return errors.at(-1) ?? lines.at(-1) ?? null;
}

// ═══════════════════════════════════════════════
// 进程管理
// ═══════════════════════════════════════════════

interface Proc {
  proc: ChildProcess;
  output: string[];
}

interface AppProc extends Proc {
  info: RunningInfo;
  name: string;
  serial: string;
  /** scrcpy 在手机上新建的屏幕编号，从输出里的 "New display: ... (id=N)" 读到 */
  display: number | null;
  /** 上次把应用拉回来的时间，防止拉回失败时反复重试 */
  lastPull: number;
  /** 正在收回到手机：窗口进程退出时不暂停播放、不报错 */
  returning?: boolean;
}

interface AudioProc extends Proc {
  /** serial + 缓冲档位，任一变化都要重启声音进程 */
  key: string;
}

/** 镜像窗口在运行列表里的占位名；带 @，不会和真实包名撞。界面 app.ts 里有同名常量 */
export const MIRROR_KEY = "@mirror";
/** 额外屏幕的占位名，同上 */
export const DESKTOP_KEY = "@desktop";
/** 镜像和额外屏幕不是某个应用：没有包名可暂停、可收回 */
const isApp = (key: string) => key !== MIRROR_KEY && key !== DESKTOP_KEY;

const OUTPUT_TAIL = 40;
/** 把任务搬到手机屏幕后，等它落定再关电脑上的窗口 */
const MOVE_SETTLE_MS = 300;
/** 实测：唤醒后约 0.4 秒虚拟屏幕才接受点击 */
const WAKE_SETTLE_MS = 400;
const AWAKE_CACHE_MS = 2000;
const GUARD_INTERVAL_MS = 1000;
const PULL_COOLDOWN_MS = 3000;
const EXIT_WAIT_MS = 3000;

/**
 * 管理所有 scrcpy 进程：每个应用最多一个窗口进程，外加至多一个声音进程。
 * 声音进程在有窗口开着且开启了声音转发时存在，最后一个窗口关掉就停。
 */
export class Launcher {
  private running = new Map<string, AppProc>();
  private audio: AudioProc | null = null;
  /** 声音进程意外退出后，同样的设置不再自动重启，免得反复失败 */
  private audioFailedKey: string | null = null;
  /** 「退到桌面就拉回来」的轮询 */
  private guardTimer: NodeJS.Timeout | null = null;
  private guardBusy = false;
  /** 每台手机上声明为桌面的界面，退到桌面时用来识别 */
  private homes = new Map<string, Set<string>>();
  /** 每台手机的 API 等级，决定哪些功能能用 */
  private sdks = new Map<string, number | null>();
  private components = new Map<string, string>();

  constructor(
    private getConfig: () => Config,
    private onChange: (running: RunningInfo[], exit: ExitEvent | null) => void,
    /** 桌面缩放比例（1.5 表示 150%），可拖动窗口要用它算清晰度 */
    private getScale: () => number = () => 1,
    /** 某部手机（按 adb 编号）的启动选项；每部手机各有一份 */
    private getLaunch: (serial: string) => LaunchSettings = () => defaultLaunch(),
  ) {}

  list(): RunningInfo[] {
    return [...this.running.values()].map((r) => r.info);
  }

  /** 开着的窗口：包名和窗口标题，托盘菜单用 */
  windows(): { pkg: string; name: string }[] {
    return [...this.running.values()].map((r) => ({ pkg: r.info.pkg, name: r.name }));
  }

  async launch(serial: string, app: PinnedApp, size: SizePreset): Promise<ActionResult> {
    if (this.running.has(app.pkg)) return { ok: true, message: t("err.alreadyOpen", { name: app.name }) };
    const config = this.getConfig();

    const sdk = await this.sdkOf(serial);
    if (sdk !== null && sdk < MIN_SDK.appWindow) {
      return { ok: false, message: t("err.needAndroid10", { sdk }) };
    }

    let display: DisplaySpec | null = size;
    if (size.id === DEVICE_SIZE_ID) {
      display = await readDeviceDisplay(config.tools.adb, serial);
      if (!display) return { ok: false, message: t("err.noDisplaySize") };
    }
    const scale = this.getScale();
    const args = buildLaunchArgs(serial, app, orient(display, app.orientation), this.getLaunch(serial), scale);
    return this.start(serial, app.pkg, app.name, args, flexEnv(app.resizable, scale));
  }

  /** 镜像整个手机屏幕，在运行列表里用 MIRROR_KEY 占位 */
  async launchMirror(serial: string): Promise<ActionResult> {
    if (this.running.has(MIRROR_KEY)) return { ok: true, message: t("mirror.alreadyOpen") };
    const title = t("mirror.windowTitle");
    return this.start(serial, MIRROR_KEY, title, buildMirrorArgs(serial, this.getLaunch(serial), title));
  }

  /** 额外屏幕：一块空的手机屏幕，显示手机的副屏桌面 */
  async launchDesktop(serial: string): Promise<ActionResult> {
    if (this.running.has(DESKTOP_KEY)) return { ok: true, message: t("desktop.alreadyOpen") };
    const sdk = await this.sdkOf(serial);
    if (sdk !== null && sdk < MIN_SDK.appWindow) return { ok: false, message: t("err.needAndroid10", { sdk }) };
    const title = t("desktop.windowTitle");
    const scale = this.getScale();
    const r = await this.start(serial, DESKTOP_KEY, title, buildDesktopArgs(serial, this.getLaunch(serial), title, scale),
      flexEnv(true, scale));
    // 桌面没声明副屏界面的手机，新屏幕上不会有桌面，只能用来显示别处打开的应用
    if (r.ok && !(await hasSecondaryHome(this.getConfig().tools.adb, serial))) return { ok: true, message: t("desktop.noSecondaryHome") };
    return r;
  }

  private async sdkOf(serial: string): Promise<number | null> {
    if (!this.sdks.has(serial)) this.sdks.set(serial, await readSdk(this.getConfig().tools.adb, serial));
    return this.sdks.get(serial) ?? null;
  }

  private async start(serial: string, key: string, name: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<ActionResult> {
    const config = this.getConfig();
    await this.sdkOf(serial); // 先记下系统版本，声音进程要用
    if (this.getLaunch(serial).wakeOnLaunch && (await wakeIfAsleep(config.tools.adb, serial))) {
      console.error(`[chichi] 手机在息屏状态，已唤醒`);
    }

    const tap = { down: null as { x: number; y: number; t: number } | null, woke: Promise.resolve(false) };
    const onInput = (e: InputEvent) => {
      if (!this.getLaunch(serial).wakeOnLaunch) return;
      if (e.kind === "down") {
        tap.down = { x: e.x, y: e.y, t: Date.now() };
        tap.woke = this.ensureAwake(serial);
      } else if (e.kind === "up" && tap.down) {
        const down = tap.down;
        tap.down = null;
        if (isTap(down, { x: e.x, y: e.y, t: Date.now() })) void this.replayIfWoken(entry, tap.woke, down);
      } else if (e.kind === "other") {
        void this.ensureAwake(serial);
      }
    };
    const entry: AppProc = {
      ...spawnScrcpy(config, args, key, env, onInput),
      name,
      serial,
      info: { pkg: key, startedAt: Date.now() },
      display: null,
      // 新屏幕刚建好、应用还没起来时会短暂显示桌面，前几秒不算「被退出」
      lastPull: Date.now(),
    };
    this.running.set(key, entry);
    const findDisplay = (chunk: Buffer) => {
      const m = /New display: .*\(id=(\d+)\)/.exec(String(chunk));
      if (m) entry.display = Number(m[1]);
    };
    entry.proc.stdout?.on("data", findDisplay);
    entry.proc.stderr?.on("data", findDisplay);

    return new Promise((resolve) => {
      entry.proc.once("spawn", () => {
        this.onChange(this.list(), null);
        this.sync();
        resolve({ ok: true, message: t("app.openingPlain", { name }) });
      });
      entry.proc.once("error", (err) => {
        this.running.delete(key);
        const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
        resolve({ ok: false, message: missing ? missingScrcpy(config.tools.scrcpy) : t("err.launchFailed", { detail: err.message }) });
      });
      entry.proc.once("exit", (code) => this.onAppExit(entry, code));
    });
  }

  private async onAppExit(entry: AppProc, code: number | null): Promise<void> {
    const { pkg } = entry.info;
    if (this.running.get(pkg) !== entry) return;
    this.running.delete(pkg);

    if (entry.returning) {
      // 应用已经搬到手机屏幕上了，你正在手机上用它：不暂停，也不算出错
      this.onChange(this.list(), { kind: "returned", pkg, name: entry.name, error: null });
      this.sync();
      return;
    }

    const error = code === 0 || code === null ? null : lastErrorLine(entry.output.join("\n")) ?? t("err.exitCode", { code });
    this.onChange(this.list(), { kind: "app", pkg, name: entry.name, error });

    // 直接点 scrcpy 窗口的关闭按钮时走到这里：窗口已经没了，应用可能转到后台接着播。
    // 先暂停再停声音进程，否则停掉声音转发的瞬间，声音会从手机外放出来。
    const config = this.getConfig();
    if (this.getLaunch(entry.serial).pauseOnClose && isApp(pkg)) await pauseIfPlaying(config.tools.adb, entry.serial, pkg);
    this.sync();
  }

  // ─── 手机睡着时点不动：点击时顺手叫醒，并把那一下补发过去 ───

  /** 每部手机最近一次确认醒着的时间；2 秒内不重复查 */
  private awakeAt = new Map<string, number>();
  private waking = new Map<string, Promise<boolean>>();

  /** 手机睡着就唤醒，返回是否真的叫醒了它（叫醒了才需要补发点击） */
  private ensureAwake(serial: string): Promise<boolean> {
    const pending = this.waking.get(serial);
    if (pending) return pending;
    if (Date.now() - (this.awakeAt.get(serial) ?? 0) < AWAKE_CACHE_MS) return Promise.resolve(false);
    const p = (async () => {
      const woke = await wakeIfAsleep(this.getConfig().tools.adb, serial);
      if (woke) {
        console.error(`[chichi] 点击时手机在息屏状态，已唤醒`);
        await new Promise((r) => setTimeout(r, WAKE_SETTLE_MS));
      }
      this.awakeAt.set(serial, Date.now());
      return woke;
    })().finally(() => this.waking.delete(serial));
    this.waking.set(serial, p);
    return p;
  }

  /** 这次点击发生时手机睡着、被丢掉了：唤醒后按原坐标补发一次。镜像窗口不补（主屏刚亮时是锁屏） */
  private async replayIfWoken(entry: AppProc, woke: Promise<boolean>, at: { x: number; y: number }): Promise<void> {
    if (!(await woke) || entry.display === null || this.running.get(entry.info.pkg) !== entry) return;
    await tapOnDisplay(this.getConfig().tools.adb, entry.serial, entry.display, at.x, at.y);
  }

  /** 给某个开着的窗口截图：截的是手机上那块屏幕的原始画面，不是电脑上的窗口 */
  async screenshot(pkg: string): Promise<{ png: Buffer | null; name: string }> {
    const entry = this.running.get(pkg);
    if (!entry) return { png: null, name: "" };
    // 镜像窗口截手机本身的屏幕；应用窗口截它自己的虚拟屏幕
    const display = pkg === MIRROR_KEY ? null : entry.display;
    if (pkg !== MIRROR_KEY && display === null) return { png: null, name: entry.name };
    return { png: await screenshot(this.getConfig().tools.adb, entry.serial, display), name: entry.name };
  }

  /** 关闭一个应用的窗口：先暂停它的播放，再结束窗口进程 */
  async stop(pkg: string): Promise<void> {
    const entry = this.running.get(pkg);
    if (!entry) return;
    const config = this.getConfig();
    if (this.getLaunch(entry.serial).pauseOnClose && isApp(pkg)) await pauseIfPlaying(config.tools.adb, entry.serial, pkg);
    entry.proc.kill("SIGTERM");
  }

  /** 启动器退出时调用：暂停正在播放的、关掉所有窗口和声音进程，等它们真正退出 */
  async stopAll(): Promise<void> {
    const entries = [...this.running.values()];
    const config = this.getConfig();
    await Promise.all(entries
      .filter((e) => this.getLaunch(e.serial).pauseOnClose && isApp(e.info.pkg))
      .map((e) => pauseIfPlaying(config.tools.adb, e.serial, e.info.pkg)));
    const procs = [...entries.map((e) => e.proc), ...(this.audio ? [this.audio.proc] : [])];
    this.running.clear();
    this.audio = null;
    this.syncGuard();
    this.syncWatchers(); // 没有窗口了，logcat 监听也一起停
    await Promise.all(procs.map(killAndWait));
  }

  /** 让声音进程和返回键守护与「有没有窗口开着」「设置」保持一致。设置变化后也要调用 */
  sync(): void {
    this.syncAudio();
    this.syncGuard();
    this.syncWatchers();
  }

  // ─── 收回到手机 ───

  /**
   * 把开在电脑上的应用搬回手机屏幕：在 0 号屏幕（手机本身）上启动它，安卓会把同一个任务整个搬过去，
   * 页面状态保留（实测任务编号不变）；然后关掉电脑上那个已经空了的窗口。镜像窗口没东西可搬，直接关；
   * 额外屏幕关掉时上面的应用自己会挪回手机（--no-vd-destroy-content）。
   */
  async returnToPhone(pkg: string): Promise<void> {
    const entry = this.running.get(pkg);
    if (!entry || entry.returning) return;
    entry.returning = true;
    if (isApp(pkg)) {
      const adb = this.getConfig().tools.adb;
      const key = `${entry.serial}|${pkg}`;
      const component = this.components.get(key) ?? (await readLaunchComponent(adb, entry.serial, pkg));
      if (component) {
        this.components.set(key, component);
        await bringToFront(adb, entry.serial, 0, component);
        await new Promise((r) => setTimeout(r, MOVE_SETTLE_MS));
      }
    }
    entry.proc.kill("SIGTERM");
  }

  /** 这部手机在电脑上开着的窗口全部收回（手机上划掉了连接通知） */
  async returnAll(serial: string): Promise<void> {
    const entries = [...this.running.values()].filter((e) => e.serial === serial);
    await Promise.all(entries.map((e) => this.returnToPhone(e.info.pkg)));
  }

  // ─── 在手机桌面上点了开在电脑上的应用：自动收回 ───

  /** 每部手机一个 logcat 进程，只在这部手机有应用窗口开着时运行 */
  private watchers = new Map<string, ChildProcess>();
  private homes0 = new Map<string, string | null>();

  private syncWatchers(): void {
    const want = new Set([...this.running.values()].filter((e) => isApp(e.info.pkg) && !e.returning).map((e) => e.serial));
    for (const [serial, proc] of this.watchers) {
      if (!want.has(serial)) {
        this.watchers.delete(serial);
        proc.kill("SIGTERM");
      }
    }
    for (const serial of want) if (!this.watchers.has(serial)) this.startWatcher(serial);
  }

  private startWatcher(serial: string): void {
    const adb = this.getConfig().tools.adb;
    // -T 1：从最新一条开始往后看；那一条是旧的，丢掉
    const proc = spawn(adb, ["-s", serial, "logcat", "-T", "1", "-v", "brief", "ActivityTaskManager:I", "*:S"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    this.watchers.set(serial, proc);
    let rest = "";
    let first = true;
    proc.stdout?.on("data", (chunk: Buffer) => {
      const lines = (rest + String(chunk)).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (first) {
          first = false;
          continue;
        }
        const rec = parseStartLine(line);
        if (rec?.fromIcon) void this.onPhoneLaunch(serial, rec);
      }
    });
    proc.once("exit", () => {
      if (this.watchers.get(serial) !== proc) return;
      this.watchers.delete(serial);
      // 意外断了（比如 adb 重启）：过一会儿按需重开
      setTimeout(() => this.syncWatchers(), 3000);
    });
  }

  private async onPhoneLaunch(serial: string, rec: StartRecord): Promise<void> {
    const entry = this.running.get(rec.pkg);
    if (!entry || entry.serial !== serial) return;
    if (!this.homes0.has(serial)) this.homes0.set(serial, await readDefaultHome(this.getConfig().tools.adb, serial));
    // 只认手机默认桌面上点的图标：琪琪自己发的命令、应用之间的跳转、DeX 那种副屏桌面都不算
    if (rec.caller !== this.homes0.get(serial)) return;
    console.error(`[chichi] 在手机上点了 ${entry.name}，收回到手机`);
    await this.returnToPhone(rec.pkg);
  }

  private syncAudio(): void {
    const config = this.getConfig();
    const first = this.running.values().next().value as AppProc | undefined;
    // 声音只转一份：跟第一个打开的窗口所在的手机走，用那部手机的声音设置
    const launch = first ? this.getLaunch(first.serial) : null;
    const route = launch?.audioRoute ?? "phone";
    const wantKey = route !== "phone" && first ? `${first.serial}|${launch!.audioBuffer}|${route}` : null;

    if (this.audio && this.audio.key !== wantKey) {
      const old = this.audio;
      this.audio = null;
      old.proc.kill("SIGTERM");
    }
    if (!wantKey) {
      this.audioFailedKey = null;
      return;
    }
    if (this.audio || this.audioFailedKey === wantKey) return;

    // 系统版本不够时不硬起进程，直接说明原因
    const sdk = this.sdks.get(first!.serial) ?? null;
    const need = route === "both" ? MIN_SDK.audioDup : MIN_SDK.audio;
    if (sdk !== null && sdk < need) {
      this.audioFailedKey = wantKey;
      const error = t(route === "both" ? "err.audioNeed13" : "err.audioNeed11", { sdk });
      this.onChange(this.list(), { kind: "audio", pkg: "", name: "", error });
      return;
    }

    const audio: AudioProc = { ...spawnScrcpy(config, buildAudioArgs(first!.serial, launch!.audioBuffer, route as Exclude<AudioRoute, "phone">), "声音"), key: wantKey };
    this.audio = audio;
    audio.proc.once("error", () => {});
    audio.proc.once("exit", (code) => {
      if (this.audio !== audio) return; // 是我们主动停的
      this.audio = null;
      this.audioFailedKey = wantKey;
      const error = lastErrorLine(audio.output.join("\n")) ?? t("err.exitCode", { code: String(code) });
      this.onChange(this.list(), { kind: "audio", pkg: "", name: "", error });
    });
  }

  // ─── 返回键退到底时把应用拉回来 ───

  private syncGuard(): void {
    const want = [...this.running.values()].some((e) => this.getLaunch(e.serial).stayInApp);
    if (want && !this.guardTimer) this.guardTimer = setInterval(() => this.guardTick(), GUARD_INTERVAL_MS);
    if (!want && this.guardTimer) {
      clearInterval(this.guardTimer);
      this.guardTimer = null;
    }
  }

  /**
   * 虚拟屏幕上的应用被返回键退到底，屏幕会显示桌面（三星是 DeX 桌面）。
   * 这时应用只是被挪到后台，重新拉到前面就回到原来的页面。
   * 只在显示桌面时拉回；应用自己跳到别的应用（比如淘宝跳支付宝）不管。
   */
  private async guardTick(): Promise<void> {
    if (this.guardBusy) return;
    this.guardBusy = true;
    try {
      const adb = this.getConfig().tools.adb;
      const bySerial = new Map<string, AppProc[]>();
      for (const e of this.running.values()) {
        // 额外屏幕上显示桌面是正常的，不拉
        if (e.display !== null && isApp(e.info.pkg) && this.getLaunch(e.serial).stayInApp) bySerial.set(e.serial, [...(bySerial.get(e.serial) ?? []), e]);
      }
      for (const [serial, entries] of bySerial) {
        const tops = await readTopActivities(adb, serial);
        if (!tops) continue;
        if (!this.homes.has(serial)) this.homes.set(serial, await readHomeComponents(adb, serial));
        const homes = this.homes.get(serial)!;

        for (const e of entries) {
          const top = tops.get(e.display!);
          if (!top || !isHome(homes, top) || Date.now() - e.lastPull < PULL_COOLDOWN_MS) continue;
          e.lastPull = Date.now();
          const key = `${serial}|${e.info.pkg}`;
          const component = this.components.get(key) ?? (await readLaunchComponent(adb, serial, e.info.pkg));
          if (!component) continue;
          this.components.set(key, component);
          console.error(`[chichi] ${e.name} 被退到了桌面，拉回来`);
          await bringToFront(adb, serial, e.display!, component);
        }
      }
    } finally {
      this.guardBusy = false;
    }
  }
}

/**
 * 启动 scrcpy，按行读它的输出。输入行（点击、按键，**连你打的字也在里面**）只交给 onInput，
 * 不打印也不保存；其余的行照常转到 stderr 并留最后几十行备查。
 */
function spawnScrcpy(config: Config, args: string[], tag: string, extraEnv: NodeJS.ProcessEnv = {}, onInput?: (e: InputEvent) => void): Proc {
  console.error(`[chichi] ${config.tools.scrcpy} ${args.join(" ")}`);
  const proc = spawn(config.tools.scrcpy, args, {
    env: { ...process.env, ...extraEnv, ADB: config.tools.adb },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output: string[] = [];
  const reader = () => {
    let rest = "";
    return (chunk: Buffer) => {
      const lines = (rest + String(chunk)).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (line.includes("input: ")) {
          const e = parseInputLine(line);
          if (e) onInput?.(e);
          continue;
        }
        if (line.startsWith("VERBOSE: ") || line.startsWith("DEBUG: ")) continue; // 调试级别的杂讯不留
        process.stderr.write(`[scrcpy ${tag}] ${line}\n`);
        output.push(line);
      }
      output.splice(0, Math.max(0, output.length - OUTPUT_TAIL));
    };
  };
  proc.stdout?.on("data", reader());
  proc.stderr?.on("data", reader());
  return { proc, output };
}

function killAndWait(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, EXIT_WAIT_MS);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}
