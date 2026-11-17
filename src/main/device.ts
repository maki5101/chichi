// 手机状态：是否醒着、每块屏幕上正在显示哪个应用、应用的启动入口。

import { run, runBinary } from "./adb";

// ═══════════════════════════════════════════════
// 唤醒
// ═══════════════════════════════════════════════

/** 解析 `dumpsys power` 里的 mWakefulness=Awake/Asleep/Dozing */
export function parseWakefulness(output: string): string | null {
  return /mWakefulness=([A-Za-z]+)/.exec(output)?.[1] ?? null;
}

/**
 * 手机息屏（Asleep / Dozing）时，虚拟屏幕上的应用能显示但点不动，
 * 亮一下屏就好了，之后再息屏也能继续点。所以打开窗口前先唤醒一次。
 */
export async function wakeIfAsleep(adb: string, serial: string): Promise<boolean> {
  const r = await run(adb, ["-s", serial, "shell", "dumpsys", "power"], 8000);
  const state = parseWakefulness(r.stdout);
  if (!state || state === "Awake") return false;
  await run(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], 8000);
  return true;
}

/** 在指定屏幕上点一下（补发手机睡着时被丢掉的点击） */
export async function tapOnDisplay(adb: string, serial: string, display: number, x: number, y: number): Promise<void> {
  await run(adb, ["-s", serial, "shell", "input", "-d", String(display), "tap", String(x), String(y)], 5000);
}

// ═══════════════════════════════════════════════
// 每块屏幕最上面的应用
// ═══════════════════════════════════════════════

export interface TopActivity {
  pkg: string;
  activity: string;
}

/**
 * 解析 `dumpsys activity activities | grep -E 'Display #|topResumedActivity'`：
 *   Display #36 (activities from top to bottom):
 *       topResumedActivity=ActivityRecord{207394544 u0 app.podcast.cosmos/io.iftech...HomeActivity t5030}
 * 返回 屏幕编号 → 最上面的应用。没有应用的屏幕不出现在结果里。
 */
export function parseTopActivities(output: string): Map<number, TopActivity> {
  const tops = new Map<number, TopActivity>();
  let display: number | null = null;
  for (const line of output.split("\n")) {
    const d = /Display #(\d+)/.exec(line);
    if (d) {
      display = Number(d[1]);
      continue;
    }
    const t = /topResumedActivity=ActivityRecord\{\S+ u\d+ ([\w.]+)\/(\S+)/.exec(line);
    if (t && display !== null && !tops.has(display)) tops.set(display, { pkg: t[1], activity: t[2] });
  }
  return tops;
}

export async function readTopActivities(adb: string, serial: string): Promise<Map<number, TopActivity> | null> {
  const r = await run(adb, ["-s", serial, "shell", "dumpsys activity activities | grep -E 'Display #|topResumedActivity'"], 5000);
  return r.code === 0 ? parseTopActivities(r.stdout) : null;
}

// ═══════════════════════════════════════════════
// 桌面（启动器）识别
// ═══════════════════════════════════════════════

/** 把 "pkg/.Foo" 这种简写展开成 "pkg/pkg.Foo"，方便比较 */
export function normalizeComponent(pkg: string, activity: string): string {
  return `${pkg}/${activity.startsWith(".") ? pkg + activity : activity}`;
}

/** 解析 `cmd package query-activities --brief` 输出里的 "pkg/activity" 行 */
export function parseComponents(output: string): Set<string> {
  const set = new Set<string>();
  for (const line of output.split("\n")) {
    const m = /^\s*([\w.]+)\/(\S+)\s*$/.exec(line);
    if (m) set.add(normalizeComponent(m[1], m[2]));
  }
  return set;
}

/**
 * 退到底时虚拟屏幕上出现的是「副屏桌面」（三星上是 DeX 桌面）。
 * 直接问手机哪些界面声明了自己是桌面（SECONDARY_HOME 和 HOME），不写死品牌。
 */
export async function readHomeComponents(adb: string, serial: string): Promise<Set<string>> {
  const query = (category: string) => run(adb, ["-s", serial, "shell", "cmd", "package", "query-activities", "--brief",
    "-a", "android.intent.action.MAIN", "-c", `android.intent.category.${category}`], 8000);
  const [secondary, home] = await Promise.all([query("SECONDARY_HOME"), query("HOME")]);
  return new Set([...parseComponents(secondary.stdout), ...parseComponents(home.stdout)]);
}

/** 手机上有没有能显示在副屏上的桌面；没有的话新建的空屏幕上什么都不显示 */
export async function hasSecondaryHome(adb: string, serial: string): Promise<boolean> {
  const r = await run(adb, ["-s", serial, "shell", "cmd", "package", "query-activities", "--brief",
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.SECONDARY_HOME"], 8000);
  // 查询本身失败时不下结论，免得误报
  return r.code !== 0 || parseComponents(r.stdout).size > 0;
}

export const isHome = (homes: Set<string>, top: TopActivity) => homes.has(normalizeComponent(top.pkg, top.activity));

// ═══════════════════════════════════════════════
// 系统版本
// ═══════════════════════════════════════════════

/** 各功能要求的最低 API 等级（scrcpy 文档） */
export const MIN_SDK = {
  appWindow: 29, // 安卓 10：虚拟屏幕单开应用
  audio: 30, // 安卓 11：声音转发
  audioDup: 33, // 安卓 13：两边都响
} as const;

export async function readSdk(adb: string, serial: string): Promise<number | null> {
  const r = await run(adb, ["-s", serial, "shell", "getprop", "ro.build.version.sdk"], 8000);
  const n = Number(r.stdout.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ═══════════════════════════════════════════════
// 截图
// ═══════════════════════════════════════════════

/**
 * screencap -d 要的是 SurfaceFlinger 的屏幕编号（一长串数字），不是安卓的屏幕编号（如 93）。
 * `dumpsys SurfaceFlinger` 里每块虚拟屏幕写成：
 *   Display 11529215047529996626 (virtual, "scrcpy")
 *      layerFilter={layerStack=86 ...}
 * 虚拟屏幕的 layerStack 就等于安卓的屏幕编号，据此建立对应关系。
 */
export function parseSurfaceFlingerIds(dump: string): Map<number, string> {
  const ids = new Map<number, string>();
  let current: string | null = null;
  for (const line of dump.split("\n")) {
    const d = /^Display (\d+) \(virtual/.exec(line);
    if (d) {
      current = d[1];
      continue;
    }
    const l = /layerFilter=\{layerStack=(\d+)/.exec(line);
    if (l && current) {
      ids.set(Number(l[1]), current);
      current = null;
    }
  }
  return ids;
}

/** 截一块屏幕，返回 PNG。display 为 null 时截手机本身的屏幕（镜像窗口用） */
export async function screenshot(adb: string, serial: string, display: number | null): Promise<Buffer | null> {
  const args = ["-s", serial, "exec-out", "screencap", "-p"];
  if (display !== null) {
    const dump = await run(adb, ["-s", serial, "shell", "dumpsys SurfaceFlinger | grep -E '^Display [0-9]+ \\(virtual|layerFilter='"], 8000);
    const sfId = parseSurfaceFlingerIds(dump.stdout).get(display);
    if (!sfId) return null;
    args.push("-d", sfId);
  }
  const png = await runBinary(adb, args, 15000);
  // PNG 文件头 89 50 4E 47；screencap 出错时输出的是文字
  return png && png.length > 8 && png[0] === 0x89 && png[1] === 0x50 ? png : null;
}

// ═══════════════════════════════════════════════
// 手机通知栏里的「已连接」通知：划掉它就是在手机上断开
// ═══════════════════════════════════════════════

/** 套上单引号给 adb shell 用（adb 把参数拼成一行交给手机上的 sh） */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 琪琪在手机上只发这一条通知，标签固定，重发会替换掉旧的 */
export const NOTIFY_TAG = "chichi";

/** 从 `cmd notification list` 里找我们那条，形如 0|com.android.shell|2020|chichi|2000 */
export function findNotificationKey(list: string, tag: string): string | null {
  return list.split("\n").map((l) => l.trim()).find((l) => l.split("|")[3] === tag) ?? null;
}

/**
 * 从 `dumpsys notification` 里找出我们那条的所有 key（含被 snooze 的）。
 * 标签必须完全相同，`chichi-test` 之类不算。
 */
export function findTaggedKeys(dump: string, tag: string): string[] {
  const keys = new Set<string>();
  for (const m of dump.matchAll(/\b\d+\|com\.android\.shell\|\d+\|([^|\s]+)\|\d+\b/g)) if (m[1] === tag) keys.add(m[0]);
  return [...keys];
}

export async function postNotification(adb: string, serial: string, title: string, text: string): Promise<string | null> {
  // 上次退出时用 snooze 把它藏起来了；key 每次都一样，不先取消的话新发的也会直接进 snooze，看不见。
  // 被 snooze 的通知不在 `cmd notification list` 里，只能从 dumpsys 找
  const dump = await run(adb, ["-s", serial, "shell", `dumpsys notification | grep -F '|${NOTIFY_TAG}|'`], 8000);
  for (const key of findTaggedKeys(dump.stdout, NOTIFY_TAG)) {
    await run(adb, ["-s", serial, "shell", `cmd notification unsnooze ${shellQuote(key)}`], 5000);
  }
  await run(adb, ["-s", serial, "shell", `cmd notification post -S bigtext -t ${shellQuote(title)} ${NOTIFY_TAG} ${shellQuote(text)}`], 8000);
  // 发出后要过一会儿才出现在列表里，多查几次
  for (let i = 0; i < 10; i++) {
    const key = await notificationKey(adb, serial);
    if (key) return key;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** 我们那条通知还在不在通知栏里；查不到手机时返回 undefined（不能当成被划掉） */
export async function notificationKey(adb: string, serial: string): Promise<string | null | undefined> {
  const r = await run(adb, ["-s", serial, "shell", "cmd", "notification", "list"], 5000);
  if (r.code !== 0) return undefined;
  return findNotificationKey(r.stdout, NOTIFY_TAG);
}

/** 系统没有撤回通知的命令，用「推迟一年提醒」把它从通知栏里藏起来 */
export async function withdrawNotification(adb: string, serial: string, key: string): Promise<void> {
  await run(adb, ["-s", serial, "shell", `cmd notification snooze --for 31536000000 ${shellQuote(key)}`], 5000);
}

// ═══════════════════════════════════════════════
// 在手机桌面上点了图标：从系统日志里认出来
// ═══════════════════════════════════════════════

export interface StartRecord {
  pkg: string;
  /** 发起启动的应用包名，如桌面 bitpit.launcher；命令行是 com.android.shell */
  caller: string;
  /** 是不是按「点图标」的方式启动（LAUNCHER 类别） */
  fromIcon: boolean;
}

/**
 * 解析 logcat 里 ActivityTaskManager 的启动记录，例如
 *   START u0 {act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10200000
 *   cmp=com.xingin.xhs/.Index bnds=[112,507][1085,659]} with LAUNCH_SINGLE_TOP from uid 10369 (bitpit.launcher) ...
 */
export function parseStartLine(line: string): StartRecord | null {
  if (!line.includes("START u0 {")) return null;
  const cmp = /\bcmp=([\w.]+)\//.exec(line);
  const caller = /\bfrom uid \d+ \(([\w.]+)\)/.exec(line);
  if (!cmp || !caller) return null;
  return { pkg: cmp[1], caller: caller[1], fromIcon: line.includes("category.LAUNCHER") };
}

/** 手机的默认桌面（不是 DeX 那种副屏桌面），只有它发起的「点图标」才算你在手机上点 */
export async function readDefaultHome(adb: string, serial: string): Promise<string | null> {
  const r = await run(adb, ["-s", serial, "shell", "cmd", "package", "resolve-activity", "--brief",
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME"], 8000);
  const pkg = r.stdout.trim().split("\n").at(-1)?.split("/")[0];
  return pkg && pkg !== "android" ? pkg : null;
}

/** 应用的启动入口，如 app.podcast.cosmos/.default */
export async function readLaunchComponent(adb: string, serial: string, pkg: string): Promise<string | null> {
  const r = await run(adb, ["-s", serial, "shell", "cmd", "package", "resolve-activity", "--brief",
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", pkg], 8000);
  const last = r.stdout.trim().split("\n").at(-1) ?? "";
  return last.startsWith(`${pkg}/`) ? last : null;
}

/** 把应用重新拉到指定屏幕的最前面。应用还在后台时会回到原来的页面，不会重新开始 */
export async function bringToFront(adb: string, serial: string, display: number, component: string): Promise<void> {
  await run(adb, ["-s", serial, "shell", "am", "start", "--display", String(display),
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", component], 8000);
}
