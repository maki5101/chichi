// 多语言：文案都在 locales/<语言>.json，代码里只写键名。
// 以 zh.json 为准，其它语言必须有同样的键（测试会检查）。缺了先退到英文，再退到键名本身。

import fs from "node:fs";
import path from "node:path";

export interface Language {
  code: string;
  /** 用这门语言自己写的名字，选的人一眼能认出来 */
  name: string;
  dir: "ltr" | "rtl";
}

export const LANGUAGES: Language[] = [
  { code: "zh", name: "简体中文", dir: "ltr" },
  { code: "zh-Hant", name: "繁體中文", dir: "ltr" },
  { code: "en", name: "English", dir: "ltr" },
  { code: "ja", name: "日本語", dir: "ltr" },
  { code: "ko", name: "한국어", dir: "ltr" },
  { code: "de", name: "Deutsch", dir: "ltr" },
  { code: "fr", name: "Français", dir: "ltr" },
  { code: "it", name: "Italiano", dir: "ltr" },
  { code: "es", name: "Español", dir: "ltr" },
  { code: "ar", name: "العربية", dir: "rtl" },
];

/** 系统语言不在列表里时用英文 */
const DEFAULT_LANGUAGE = "en";

export type Dict = Record<string, string>;

/** 把 "{name}" 这样的占位符换成参数 */
export function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/**
 * 设置里的 "auto" 按系统语言挑，如 "zh-CN" → "zh"；认不出来就用英文。
 * 中文要看地区或书写系统：台湾、香港、澳门和明确写了 Hant 的用繁体，其余用简体。
 */
export function resolveLanguage(setting: string, systemLocale: string): string {
  if (LANGUAGES.some((l) => l.code === setting)) return setting;
  const parts = systemLocale.toLowerCase().split(/[-_.@]/);
  if (parts[0] === "zh") {
    return parts.some((p) => p === "hant" || p === "tw" || p === "hk" || p === "mo") ? "zh-Hant" : "zh";
  }
  return LANGUAGES.some((l) => l.code === parts[0]) ? parts[0] : DEFAULT_LANGUAGE;
}

export function loadLocale(dir: string, code: string): Dict {
  return JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), "utf8")) as Dict;
}

// ═══════════════════════════════════════════════
// 当前语言（主进程内的全局状态，只由 setLanguage 修改）
// ═══════════════════════════════════════════════

let dict: Dict = {};
let fallback: Dict = {};
let current = DEFAULT_LANGUAGE;

export function setLanguage(dir: string, code: string): void {
  current = code;
  fallback = loadLocale(dir, DEFAULT_LANGUAGE);
  dict = code === DEFAULT_LANGUAGE ? fallback : loadLocale(dir, code);
}

export function currentLanguage(): Language {
  return LANGUAGES.find((l) => l.code === current) ?? LANGUAGES[1];
}

/** 当前语言的完整文案表（缺的键用英文补齐），发给界面用 */
export function allStrings(): Dict {
  return { ...fallback, ...dict };
}

export function t(key: string, params?: Record<string, string | number>): string {
  return interpolate(dict[key] ?? fallback[key] ?? key, params);
}
