// 主进程与界面共用的数据结构。
// 这是全局声明文件（没有 import/export），界面脚本编译成普通脚本，不能用模块导入。

/** 手机上的一个应用（来自 scrcpy --list-apps） */
interface PhoneApp {
  pkg: string;
  name: string;
  system: boolean;
}

type Orientation = "portrait" | "landscape";

/** 放在「常用」里的应用，以及它自己的窗口设置 */
interface PinnedApp {
  pkg: string;
  name: string;
  /** null 表示跟随默认尺寸 */
  sizeId: string | null;
  orientation: Orientation;
  /** 可拖动：窗口可以随意拉大拉小，手机那边的屏幕跟着变（scrcpy --flex-display） */
  resizable: boolean;
}

/** 窗口尺寸。宽高按竖屏记录，横屏时对调 */
interface SizePreset {
  id: string;
  name: string;
  width: number;
  height: number;
  dpi: number;
}

type ImePolicy = "local" | "fallback" | "hide";

/**
 * sdk：scrcpy 默认，只能传英文字符。
 * uhid：模拟一个外接键盘，由手机输入法打字，中文也能打；
 *       但窗口开着期间手机一直认为接着实体键盘，Gboard 等会隐藏屏幕键盘。
 */
type KeyboardMode = "sdk" | "uhid";

/** 声音在哪儿响：phone 只在手机；computer 只在电脑（手机静音）；both 两边都响 */
type AudioRoute = "phone" | "computer" | "both";

/** 声音缓冲档位，越大越不容易断续，但延迟越高 */
type AudioBufferLevel = "small" | "medium" | "large";

/** 跟着手机走的启动选项 */
interface LaunchSettings {
  /** 声音转到电脑时由一个独立的只转声音的进程负责，应用窗口本身不带声音 */
  audioRoute: AudioRoute;
  audioBuffer: AudioBufferLevel;
  /** 关窗口时，如果这个应用正在播放就暂停它 */
  pauseOnClose: boolean;
  imePolicy: ImePolicy;
  keyboard: KeyboardMode;
  /** 打开窗口前如果手机息屏就先唤醒，否则窗口能看不能点 */
  wakeOnLaunch: boolean;
  /** 按返回键退到桌面时，把应用拉回来 */
  stayInApp: boolean;
  /** 追加给 scrcpy 的参数，按空白切分 */
  extraArgs: string;
}

/** 一部手机自己的设置：常用列表、默认尺寸、启动选项 */
interface DeviceProfile {
  /** 手机里设置的名字（如「小明的手机」），显示用 */
  name: string;
  model: string;
  pinned: PinnedApp[];
  defaultSizeId: string;
  launch: LaunchSettings;
}

interface Config {
  /** 界面语言："auto" 跟随系统，或 locales/ 里的语言代码 */
  language: string;
  /** 外观：跟随系统 / 浅色 / 深色 */
  theme: "system" | "light" | "dark";
  /** 每部手机的设置，键是手机的序列号（ro.serialno，USB 和无线都一样） */
  devices: Record<string, DeviceProfile>;
  /** 升级前只有一份的设置，等它原来那部手机连上时认领；认领后为 null */
  legacyProfile: { profile: DeviceProfile; serial: string | null } | null;
  /** 自定义尺寸是公共的，每部手机都能选 */
  customSizes: SizePreset[];
  /** 上次使用的手机（序列号），多部同时在线时优先选它 */
  preferredDevice: string | null;
  wireless: {
    /** 「连接新手机」那一栏填的地址 */
    host: string;
    portRange: string;
    lastPort: number | null;
    /** 无线连上过的手机，最近连的在前；端口只是缓存，连不上会重新扫描 */
    known: KnownPhone[];
  };
  tools: {
    adb: string;
    scrcpy: string;
  };
}

interface KnownPhone {
  /** 手机的序列号（ro.serialno） */
  id: string;
  name: string;
  host: string;
  lastPort: number | null;
}

interface Device {
  /** adb 用的编号：USB 是序列号，无线是「IP:端口」 */
  serial: string;
  /** device / unauthorized / offline 等，原样取自 adb devices */
  state: string;
  model: string;
  wireless: boolean;
  /** 手机的序列号（ro.serialno），换连接方式也不变；只有 state 为 device 时才读得到 */
  id: string | null;
  /** 手机里设置的名字 */
  name: string | null;
}

interface RunningInfo {
  pkg: string;
  startedAt: number;
}

interface LanguageOption {
  code: string;
  name: string;
  dir: "ltr" | "rtl";
}

interface AppState {
  config: Config;
  /** 还没见过的手机用的默认设置 */
  defaultProfile: DeviceProfile;
  /** 实际在用的语言（"auto" 已解析） */
  language: LanguageOption;
  languages: LanguageOption[];
  /** 当前语言的全部文案 */
  strings: Record<string, string>;
  /** 内置尺寸 + 自定义尺寸，第一项固定是「跟随手机」 */
  sizes: SizePreset[];
  running: RunningInfo[];
  /** 配置文件读取出错时的说明（已翻译），正常为 null */
  configNotice: string | null;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

/** 某个应用的 scrcpy 进程结束了 */
interface ExitEvent {
  /** app：某个应用的窗口；audio：声音转发进程（此时 pkg 为空） */
  /** returned：应用被收回到手机上（在手机上点了它的图标，或划掉了连接通知） */
  kind: "app" | "audio" | "returned";
  pkg: string;
  name: string;
  /** 非正常退出时，从 scrcpy 输出里摘出的原因 */
  error: string | null;
}

interface ToolStatus {
  adb: { ok: boolean; detail: string };
  scrcpy: { ok: boolean; detail: string };
}

interface Window {
  phone: PhoneApi;
}

/** preload 暴露给界面的接口 */
interface PhoneApi {
  getState(): Promise<AppState>;
  saveConfig(config: Config): Promise<AppState>;
  listDevices(): Promise<{ devices: Device[]; error: string | null; config: Config }>;
  listApps(serial: string): Promise<{ apps: PhoneApp[]; error: string | null }>;
  /** 手机上装了的包名；读取失败为 null */
  listPackages(serial: string): Promise<string[] | null>;
  launch(pkg: string, serial: string): Promise<ActionResult>;
  stop(pkg: string): Promise<void>;
  /** 给开着的窗口截图，存到「图片 / chichi」并复制到剪贴板 */
  screenshot(pkg: string): Promise<ActionResult>;
  openScreenshots(): Promise<void>;
  /** 从托盘截图的结果 */
  onScreenshotDone(cb: (result: ActionResult) => void): void;
  /** 用户在手机上划掉了连接通知，已断开；参数是手机名称 */
  onPhoneDisconnected(cb: (name: string) => void): void;
  /** 不带参数连「连接新手机」栏里的地址，带序列号连记住的那部手机 */
  connectWireless(id?: string): Promise<ActionResult>;
  checkTools(): Promise<ToolStatus>;
  onConnectProgress(cb: (line: string) => void): void;
  onRunningChanged(cb: (running: RunningInfo[], exit: ExitEvent | null) => void): void;
}
