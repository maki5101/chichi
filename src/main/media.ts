// 手机上的媒体播放控制：关窗口时把正在播放的应用暂停，而不是杀掉它。

import { run } from "./adb";

export interface MediaSession {
  pkg: string;
  /** PlaybackState 的数值：2 暂停，3 播放，6 缓冲中 */
  state: number;
}

const PLAYING_STATES = new Set([3, 6]);

/**
 * 解析 `dumpsys media_session`。每个会话先出现一行 `package=xxx`，
 * 之后跟着 `state=PlaybackState {state=PLAYING(3), ...}`（可能为 null）。
 */
export function parseMediaSessions(output: string): MediaSession[] {
  const sessions: MediaSession[] = [];
  let pkg: string | null = null;
  for (const line of output.split("\n")) {
    const p = /^\s*package=(\S+)/.exec(line);
    if (p) {
      pkg = p[1];
      continue;
    }
    const s = /state=PlaybackState \{state=\w+\((\d+)\)/.exec(line);
    if (s && pkg) {
      sessions.push({ pkg, state: Number(s[1]) });
      pkg = null;
    }
  }
  return sessions;
}

export function isPlaying(sessions: MediaSession[], pkg: string): boolean {
  return sessions.some((s) => s.pkg === pkg && PLAYING_STATES.has(s.state));
}

/**
 * 如果这个应用正在播放，发一个暂停键。
 * 暂停键由系统投递给当前的媒体按键会话，通常就是正在播放的那个应用；
 * 所以先确认它确实在播，免得误停别的应用。
 */
export async function pauseIfPlaying(adb: string, serial: string, pkg: string): Promise<boolean> {
  const dump = await run(adb, ["-s", serial, "shell", "dumpsys", "media_session"], 8000);
  if (dump.code !== 0 || !isPlaying(parseMediaSessions(dump.stdout), pkg)) return false;
  await run(adb, ["-s", serial, "shell", "cmd", "media_session", "dispatch", "pause"], 8000);
  return true;
}
