// adb 相关：运行命令、解析设备列表、无线连接。
// 无线连接流程沿用作者本机一个连接脚本的思路（脚本位置见 .private/NOTES.md）：
//   已连接直接用 → 上次成功的端口 → nmap 扫端口 → 冷却后逐个尝试。
//   成功与否只看 adb devices 里的实际状态，不解析 adb connect 的文字。

import { execFile } from "node:child_process";
import { t } from "./i18n";
import { isValidHost } from "./config";

// ═══════════════════════════════════════════════
// 运行外部命令
// ═══════════════════════════════════════════════

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 程序本身找不到（ENOENT） */
  missing: boolean;
}

export function run(bin: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    // windowsHide：Windows 上 adb/scrcpy 是命令行程序，不藏起来每次调用都会闪一个黑窗口
    execFile(bin, args, { timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
        timedOut: Boolean(e?.killed),
        missing: e?.code === "ENOENT",
      });
    });
  });
}

/** 取二进制输出（截图的 PNG），失败返回 null */
export function runBinary(bin: string, args: string[], timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════
// 解析
// ═══════════════════════════════════════════════

/** 解析 `adb devices -l` 的输出 */
export function parseDevices(output: string): Device[] {
  const devices: Device[] = [];
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const [serial, state, ...rest] = parts;
    const model = rest.find((p) => p.startsWith("model:"))?.slice("model:".length).replace(/_/g, " ") ?? "";
    devices.push({ serial, state, model, wireless: /:\d+$/.test(serial), id: null, name: null });
  }
  return devices;
}

/** 从 nmap 输出里取出开放端口，如 "33431/tcp open  unknown" */
export function parseNmapPorts(output: string): number[] {
  const ports: number[] = [];
  for (const m of output.matchAll(/^(\d+)\/tcp\s+open/gm)) {
    const p = Number(m[1]);
    if (p > 0 && p <= 65535 && !ports.includes(p)) ports.push(p);
  }
  return ports;
}

/** 接受端口范围「32768-60999」或单个端口「41067」 */
export function isValidPortRange(range: string): boolean {
  const m = /^(\d+)(?:-(\d+))?$/.exec(range);
  if (!m) return false;
  const lo = Number(m[1]);
  const hi = Number(m[2] ?? m[1]);
  return lo >= 1 && hi <= 65535 && lo <= hi;
}

// ═══════════════════════════════════════════════
// 设备列表与 adb server 健康
// ═══════════════════════════════════════════════

const PROBE_TIMEOUT = 6000;

export async function listDevices(adb: string): Promise<{ devices: Device[]; error: string | null }> {
  const r = await run(adb, ["devices", "-l"], PROBE_TIMEOUT);
  if (r.missing) return { devices: [], error: t("err.adbMissing", { bin: adb }) };
  if (r.timedOut) return { devices: [], error: t("err.adbTimeout") };
  if (!r.stdout.includes("List of devices attached")) return { devices: [], error: t("err.adbOutput", { output: (r.stderr || r.stdout).trim() }) };
  return { devices: parseDevices(r.stdout), error: null };
}

export interface Identity {
  /** 序列号 ro.serialno：USB 和无线连接都一样，用它区分手机 */
  id: string;
  /** 手机里设置的名字，读不到就用型号 */
  name: string;
  model: string;
}

/** 解析一次 shell 调用里依次打印的：序列号、型号、手机名称 */
export function parseIdentity(output: string, fallbackSerial: string): Identity {
  const [serialno = "", model = "", name = ""] = output.split("\n").map((l) => l.trim());
  const cleanName = name && name !== "null" ? name : "";
  return { id: serialno || fallbackSerial, name: cleanName || model || fallbackSerial, model };
}

export async function identify(adb: string, serial: string): Promise<Identity | null> {
  const r = await run(adb, ["-s", serial, "shell", "getprop ro.serialno; getprop ro.product.model; settings get global device_name"], 8000);
  return r.code === 0 ? parseIdentity(r.stdout, serial) : null;
}

/** 手机上装了哪些应用（包名），用来标出常用列表里这部手机没有的应用 */
export async function listPackages(adb: string, serial: string): Promise<string[] | null> {
  const r = await run(adb, ["-s", serial, "shell", "pm", "list", "packages"], 15000);
  if (r.code !== 0) return null;
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("package:")).map((l) => l.slice("package:".length));
}

/** adb server 卡死或版本冲突时重启一次 */
async function ensureServer(adb: string, log: (s: string) => void): Promise<boolean> {
  const probe = await run(adb, ["devices"], PROBE_TIMEOUT);
  const bad = /cannot connect to daemon|failed to start daemon|protocol fault|does not match this client|server is out of date/i;
  if (!probe.timedOut && probe.stdout.includes("List of devices attached") && !bad.test(probe.stdout + probe.stderr)) {
    return true;
  }
  log(t("wl.restarting"));
  await run(adb, ["kill-server"], 10000);
  await sleep(1000);
  const start = await run(adb, ["start-server"], 25000);
  if (start.code !== 0) {
    log(t("wl.restartFailed", { detail: (start.stderr || start.stdout).trim() }));
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════
// 无线连接
// ═══════════════════════════════════════════════

const CONNECT_TIMEOUT = 8000;
const STATE_WAIT = 10000;
const STATE_WAIT_ABSENT = 2000;
const RETRIES = 2;
const NMAP_TIMEOUT = 120000;
const COOLDOWN_AFTER_SCAN = 3000;
const CLASSIC_ADB_PORT = 5555;
/** 手机在线时回话约 0.1 秒（无线），3 秒没回就当不通 */
const ALIVE_TIMEOUT = 3000;

type PortOutcome = "ok" | "unauthorized" | "fail";

export interface WirelessResult extends ActionResult {
  /** 连上的端口，写回配置当作下次的缓存 */
  port: number | null;
}

export async function connectWireless(
  adb: string,
  host: string,
  lastPort: number | null,
  portRange: string,
  log: (s: string) => void,
): Promise<WirelessResult> {
  const fail = (message: string): WirelessResult => ({ ok: false, message, port: null });

  if (!host) return fail(t("wl.noHost"));
  if (!isValidHost(host)) return fail(t("wl.badHost", { host }));
  if (!(await ensureServer(adb, log))) return fail(t("wl.serverDown"));

  const { devices } = await listDevices(adb);
  const mine = devices.filter((d) => d.serial.startsWith(`${host}:`));
  for (const d of mine.filter((d) => d.state === "device")) {
    if (await isAlive(adb, d.serial)) {
      return { ok: true, message: t("wl.alreadyConnected", { serial: d.serial }), port: Number(d.serial.split(":").pop()) };
    }
    log(t("wl.stale", { serial: d.serial }));
  }
  // 清掉 offline、已经不通的残留条目，免得干扰这次连接
  for (const d of mine) await run(adb, ["disconnect", d.serial], 5000);

  if (lastPort) {
    log(t("wl.tryLast", { port: lastPort }));
    const r = await tryPort(adb, host, lastPort, log, () => false);
    if (r === "ok") return { ok: true, message: t("wl.connected", { target: `${host}:${lastPort}` }), port: lastPort };
    if (r === "unauthorized") return unauthorized();
    log(t("wl.lastFailed"));
  }

  if (!isValidPortRange(portRange)) return fail(t("wl.badRange", { range: portRange }));

  // 安卓 11 以后的「无线调试」用随机高位端口；更老的 `adb tcpip` 方式固定用 5555，一起扫
  const ports = `${CLASSIC_ADB_PORT},${portRange}`;
  log(t("wl.scanning", { host, ports }));
  const scan = await run("nmap", ["-p", ports, "--open", "-Pn", "--max-retries", "1", "-T4", host], NMAP_TIMEOUT);
  if (scan.missing) return fail(t("wl.nmapMissing"));
  if (scan.timedOut) return fail(t("wl.scanTimeout"));

  const found = parseNmapPorts(scan.stdout).filter((p) => p !== lastPort);
  if (found.length === 0) return fail(t("wl.noPorts"));
  log(t("wl.foundPorts", { ports: found.join(", ") }));

  // nmap 全连接扫描会和 adbd 握手后立刻断开，adbd 需要一点时间恢复
  await sleep(COOLDOWN_AFTER_SCAN);

  const best = await tryPorts(adb, host, found, log);
  if (best.outcome === "ok") return { ok: true, message: t("wl.connected", { target: `${host}:${best.port}` }), port: best.port };
  if (best.outcome === "unauthorized") return unauthorized();
  return fail(t("wl.allFailed"));
}

function unauthorized(): WirelessResult {
  return { ok: false, message: t("wl.unauthorized"), port: null };
}

/**
 * 端口没开（手机重启或重开过无线调试后旧端口就是这样）时 adb connect 立刻返回 Connection refused，
 * 这是确定的结果，不用再等 adb devices、也不用重试。Windows 上这句报错可能被系统翻译，认不出时照旧等。
 */
export const isRefused = (output: string) => /connection refused|actively refused/i.test(output);

/**
 * 扫到的几个端口同时试（手机上开着的不一定都是调试端口，挨个试时一个假端口就要白等十几秒），
 * 哪个先连上就用哪个；其余还在试的不再重试，万一也连上了就断开，免得同一部手机挂两个条目。
 */
export async function tryPorts(adb: string, host: string, ports: number[], log: (s: string) => void): Promise<{ outcome: PortOutcome; port: number }> {
  let winner: number | null = null;
  return new Promise((resolve) => {
    const attempts = ports.map(async (port) => {
      const r = await tryPort(adb, host, port, log, () => winner !== null);
      if (r === "ok" && winner === null) {
        winner = port;
        resolve({ outcome: "ok", port });
      } else if (r === "ok") {
        await run(adb, ["disconnect", `${host}:${port}`], 5000);
      }
      return r;
    });
    void Promise.all(attempts).then((rs) => {
      if (winner === null) resolve({ outcome: rs.includes("unauthorized") ? "unauthorized" : "fail", port: 0 });
    });
  });
}

/** 让手机实际回一句话。网断了以后 adb devices 还会把无线条目显示成 device 好一阵子，只看状态会误以为连着 */
export async function isAlive(adb: string, serial: string): Promise<boolean> {
  const r = await run(adb, ["-s", serial, "shell", "echo", "chichi-alive"], ALIVE_TIMEOUT);
  return r.stdout.includes("chichi-alive");
}

/** 无线条目显示 device 但手机不回话的，改成 offline（界面按没连上处理）。USB 不会这样，不查 */
export async function markStale(adb: string, devices: Device[]): Promise<void> {
  await Promise.all(devices.filter((d) => d.wireless && d.state === "device").map(async (d) => {
    if (!(await isAlive(adb, d.serial))) d.state = "offline";
  }));
}

async function tryPort(adb: string, host: string, port: number, log: (s: string) => void, stop: () => boolean): Promise<PortOutcome> {
  const target = `${host}:${port}`;
  for (let i = 1; i <= RETRIES; i++) {
    if (stop()) return "fail";
    log(t("wl.trying", { target, attempt: i }));
    const r = await run(adb, ["connect", target], CONNECT_TIMEOUT);
    const out = r.stdout + r.stderr;
    if (isRefused(out)) return "fail";
    // 连不上（超时、不是 adb 的端口）时条目根本不会出现，不用再等 adb devices
    if (/failed to connect|cannot connect/i.test(out)) {
      if (i < RETRIES) await sleep(2000);
      continue;
    }
    const state = await waitForState(adb, target);
    if (state === "device") return "ok";
    if (state === "unauthorized") return "unauthorized";
    await run(adb, ["disconnect", target], 5000);
    if (i < RETRIES) await sleep(2000);
  }
  return "fail";
}

/** 轮询 adb devices 直到目标进入稳定状态；条目一直不出现就提前放弃 */
async function waitForState(adb: string, target: string): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < STATE_WAIT) {
    const { devices } = await listDevices(adb);
    const entry = devices.find((d) => d.serial === target);
    if (entry?.state === "device" || entry?.state === "unauthorized") return entry.state;
    if (!entry && Date.now() - start > STATE_WAIT_ABSENT) return null;
    await sleep(500);
  }
  return null;
}
