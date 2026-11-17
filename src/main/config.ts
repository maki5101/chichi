// 配置的读取、校正与保存。
// 配置是给人手改的，解析时容忍 // 和 /* */ 注释以及尾逗号。

import fs from "node:fs";
import path from "node:path";
import { LANGUAGES } from "./i18n";

// ═══════════════════════════════════════════════
// 宽松 JSON
// ═══════════════════════════════════════════════

/** 去掉注释和尾逗号后再交给 JSON.parse，字符串里的内容原样保留 */
export function parseLooseJson(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      const end = findStringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** 返回从 start 处引号开始的字符串结束后的位置 */
function findStringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  return text.length;
}

// ═══════════════════════════════════════════════
// 默认值与校正
// ═══════════════════════════════════════════════

export const DEVICE_SIZE_ID = "device";

export function defaultLaunch(): LaunchSettings {
  return { audioRoute: "phone", audioBuffer: "medium", pauseOnClose: true, imePolicy: "local", keyboard: "sdk", wakeOnLaunch: true, stayInApp: true, extraArgs: "" };
}

/** 新手机第一次连上时的设置：常用列表是空的，其余用默认值 */
export function defaultProfile(name = "", model = ""): DeviceProfile {
  return { name, model, pinned: [], defaultSizeId: "iphone-17", launch: defaultLaunch() };
}

export function defaultConfig(): Config {
  return {
    language: "auto",
    theme: "system",
    devices: {},
    legacyProfile: null,
    customSizes: [],
    preferredDevice: null,
    wireless: { host: "", portRange: "32768-60999", lastPort: null, known: [] },
    tools: { adb: "adb", scrcpy: "scrcpy" },
  };
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const posInt = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);

/**
 * 把任意输入整理成完整的 Config：缺的补默认，类型不对的丢掉。
 * 旧格式（pinned / launch / defaultSizeId 在最外层，只有一份）会放进 legacyProfile，
 * 等它原来那部手机（旧的 preferredSerial）连上时由 claimLegacyProfile 认领。
 */
export function normalizeConfig(raw: unknown): Config {
  const d = defaultConfig();
  if (!isObj(raw)) return d;

  const wireless = isObj(raw.wireless) ? raw.wireless : {};
  const tools = isObj(raw.tools) ? raw.tools : {};
  const devices: Record<string, DeviceProfile> = {};
  if (isObj(raw.devices)) {
    for (const [id, p] of Object.entries(raw.devices)) if (id) devices[id] = normalizeProfile(p);
  }

  const lang = raw.language;
  return {
    language: lang === "auto" || LANGUAGES.some((l) => l.code === lang) ? (lang as string) : d.language,
    theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : "system",
    devices,
    legacyProfile: normalizeLegacy(raw),
    customSizes: Array.isArray(raw.customSizes) ? raw.customSizes.flatMap(normalizeSize) : d.customSizes,
    preferredDevice: typeof raw.preferredDevice === "string" ? raw.preferredDevice : null,
    wireless: {
      host: str(wireless.host, d.wireless.host).trim(),
      portRange: str(wireless.portRange, d.wireless.portRange).trim(),
      lastPort: posInt(wireless.lastPort),
      known: normalizeKnown(wireless.known),
    },
    tools: {
      adb: str(tools.adb, d.tools.adb).trim() || d.tools.adb,
      scrcpy: str(tools.scrcpy, d.tools.scrcpy).trim() || d.tools.scrcpy,
    },
  };
}

/** 同一部手机只留第一条（最近的） */
function normalizeKnown(v: unknown): KnownPhone[] {
  if (!Array.isArray(v)) return [];
  const out: KnownPhone[] = [];
  for (const k of v) {
    if (!isObj(k) || typeof k.id !== "string" || !k.id || out.some((o) => o.id === k.id)) continue;
    const host = str(k.host, "").trim();
    if (!isValidHost(host)) continue;
    out.push({ id: k.id, name: str(k.name, ""), host, lastPort: posInt(k.lastPort) });
  }
  return out;
}

/** 无线连上一部手机后记下它的地址，放到最前面；没变化时原样返回 */
export function rememberWireless(config: Config, phone: KnownPhone): Config {
  const known = config.wireless.known;
  const first = known[0];
  if (first && first.id === phone.id && first.host === phone.host && first.lastPort === phone.lastPort && first.name === phone.name) return config;
  return { ...config, wireless: { ...config.wireless, known: [phone, ...known.filter((k) => k.id !== phone.id)] } };
}

/** 主机名或 IP（v4 / 不带方括号的 v6），拼进 adb 和 nmap 的参数前用它把关 */
export function isValidHost(host: string): boolean {
  return /^[a-zA-Z0-9.:_-]+$/.test(host);
}

export function normalizeProfile(v: unknown): DeviceProfile {
  const d = defaultProfile();
  if (!isObj(v)) return d;
  return {
    name: str(v.name, ""),
    model: str(v.model, ""),
    pinned: Array.isArray(v.pinned) ? v.pinned.flatMap(normalizePinned) : d.pinned,
    defaultSizeId: str(v.defaultSizeId, d.defaultSizeId),
    launch: normalizeLaunch(v.launch),
  };
}

function normalizeLaunch(v: unknown): LaunchSettings {
  const d = defaultLaunch();
  const launch = isObj(v) ? v : {};
  const ime = launch.imePolicy;
  const buffer = launch.audioBuffer;
  return {
    audioRoute: normalizeRoute(launch),
    audioBuffer: buffer === "small" || buffer === "medium" || buffer === "large" ? buffer : d.audioBuffer,
    pauseOnClose: bool(launch.pauseOnClose, d.pauseOnClose),
    imePolicy: ime === "local" || ime === "fallback" || ime === "hide" ? ime : d.imePolicy,
    keyboard: launch.keyboard === "sdk" || launch.keyboard === "uhid" ? launch.keyboard : d.keyboard,
    wakeOnLaunch: bool(launch.wakeOnLaunch, d.wakeOnLaunch),
    stayInApp: bool(launch.stayInApp, d.stayInApp),
    extraArgs: str(launch.extraArgs, d.extraArgs),
  };
}

/** 旧格式 → 待认领的设置；新格式里原样保留还没被认领的 legacyProfile */
function normalizeLegacy(raw: Obj): Config["legacyProfile"] {
  if (isObj(raw.legacyProfile)) {
    const l = raw.legacyProfile;
    return { profile: normalizeProfile(l.profile), serial: typeof l.serial === "string" ? l.serial : null };
  }
  const isOldFormat = "pinned" in raw || "launch" in raw || "defaultSizeId" in raw;
  if (!isOldFormat) return null;
  return {
    profile: normalizeProfile({ pinned: raw.pinned, launch: raw.launch, defaultSizeId: raw.defaultSizeId }),
    serial: typeof raw.preferredSerial === "string" ? raw.preferredSerial : null,
  };
}

/**
 * 一部手机第一次被识别时调用，返回这部手机应得的设置：
 * 已有就用已有的；没有且旧设置正等着它（adb 编号对得上，或旧设置没记编号）就认领旧设置；否则给默认值。
 * 返回新的 Config，不修改传入的对象。
 */
export function claimProfile(config: Config, id: string, serial: string, name: string, model: string): Config {
  const existing = config.devices[id];
  if (existing) {
    if (existing.name === name && existing.model === model) return config;
    return { ...config, devices: { ...config.devices, [id]: { ...existing, name, model } } };
  }
  const legacy = config.legacyProfile;
  if (legacy && (legacy.serial === null || legacy.serial === serial)) {
    // 旧设置原来就是这部手机在用，顺便记成「上次使用的手机」，多部同时在线时先显示它
    return {
      ...config,
      legacyProfile: null,
      preferredDevice: config.preferredDevice ?? id,
      devices: { ...config.devices, [id]: { ...legacy.profile, name, model } },
    };
  }
  return { ...config, devices: { ...config.devices, [id]: defaultProfile(name, model) } };
}

/** 旧版本用的是 forwardAudio 开关：true 等于「只在电脑」，false 等于「只在手机」 */
function normalizeRoute(launch: Obj): AudioRoute {
  const r = launch.audioRoute;
  if (r === "phone" || r === "computer" || r === "both") return r;
  if (typeof launch.forwardAudio === "boolean") return launch.forwardAudio ? "computer" : "phone";
  return defaultLaunch().audioRoute;
}

function normalizePinned(v: unknown): PinnedApp[] {
  if (!isObj(v) || typeof v.pkg !== "string" || !v.pkg) return [];
  return [
    {
      pkg: v.pkg,
      name: str(v.name, v.pkg),
      sizeId: typeof v.sizeId === "string" ? v.sizeId : null,
      orientation: v.orientation === "landscape" ? "landscape" : "portrait",
      resizable: v.resizable === true,
    },
  ];
}

export function normalizeSize(v: unknown): SizePreset[] {
  if (!isObj(v)) return [];
  const width = posInt(v.width);
  const height = posInt(v.height);
  const dpi = posInt(v.dpi);
  if (typeof v.id !== "string" || !v.id || !width || !height || !dpi) return [];
  return [{ id: v.id, name: str(v.name, v.id), width, height, dpi }];
}

// ═══════════════════════════════════════════════
// 读写
// ═══════════════════════════════════════════════

export interface LoadResult {
  config: Config;
  /** 配置写坏时的原因和备份文件名；读配置时语言还没定，由调用方翻译成提示 */
  broken: { error: string; backup: string } | null;
}

/**
 * 读配置。文件不存在就用默认值；解析失败时把原文件改名备份，
 * 避免下次保存把用户手改的内容覆盖掉。
 */
export function loadConfig(file: string): LoadResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: defaultConfig(), broken: null };
    throw e;
  }

  try {
    return { config: normalizeConfig(parseLooseJson(text)), broken: null };
  } catch (e) {
    const backup = `${file}.broken-${Date.now()}`;
    fs.renameSync(file, backup);
    return { config: defaultConfig(), broken: { error: (e as Error).message, backup: path.basename(backup) } };
  }
}

/** 先写临时文件再改名，保存到一半崩溃也不会留下半截配置 */
export function saveConfig(file: string, config: Config): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** 读内置尺寸表（随程序发布的 presets.json） */
export function loadPresets(file: string): SizePreset[] {
  const raw = parseLooseJson(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${file} 应该是一个数组`);
  return raw.flatMap(normalizeSize);
}
