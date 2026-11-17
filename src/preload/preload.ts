// 在隔离环境里把主进程的动作暴露给界面，界面拿不到 Node 和 Electron 的其它能力。

import { contextBridge, ipcRenderer } from "electron";

const api: PhoneApi = {
  getState: () => ipcRenderer.invoke("get-state"),
  saveConfig: (config) => ipcRenderer.invoke("save-config", config),
  listDevices: () => ipcRenderer.invoke("list-devices"),
  listApps: (serial) => ipcRenderer.invoke("list-apps", serial),
  listPackages: (serial) => ipcRenderer.invoke("list-packages", serial),
  launch: (pkg, serial) => ipcRenderer.invoke("launch", pkg, serial),
  stop: (pkg) => ipcRenderer.invoke("stop", pkg),
  screenshot: (pkg) => ipcRenderer.invoke("screenshot", pkg),
  openScreenshots: () => ipcRenderer.invoke("open-screenshots"),
  onPhoneDisconnected: (cb) => {
    ipcRenderer.on("phone-disconnected", (_e, name: string) => cb(name));
  },
  onScreenshotDone: (cb) => {
    ipcRenderer.on("screenshot-done", (_e, result: ActionResult) => cb(result));
  },
  connectWireless: (id?: string) => ipcRenderer.invoke("connect-wireless", id),
  checkTools: () => ipcRenderer.invoke("check-tools"),
  onConnectProgress: (cb) => {
    ipcRenderer.on("connect-progress", (_e, line: string) => cb(line));
  },
  onRunningChanged: (cb) => {
    ipcRenderer.on("running-changed", (_e, running: RunningInfo[], exit: ExitEvent | null) => cb(running, exit));
  },
};

contextBridge.exposeInMainWorld("phone", api);
