// 纯逻辑测试：全部离线，不碰真实的 adb / scrcpy / 手机。
// 运行：npm test（会先编译到 dist/）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../dist/main/config");
const adb = require("../dist/main/adb");
const scrcpy = require("../dist/main/scrcpy");
const media = require("../dist/main/media");
const device = require("../dist/main/device");
const i18n = require("../dist/main/i18n");

// ═══ 配置 ═══

test("宽松 JSON：容忍注释和尾逗号，字符串里的 // 原样保留", () => {
  const text = `{
    // 行注释
    "url": "http://example.com/a", /* 块注释 */
    "list": [1, 2,],
  }`;
  assert.deepEqual(config.parseLooseJson(text), { url: "http://example.com/a", list: [1, 2] });
});

test("宽松 JSON：字符串里的转义引号不会提前结束字符串", () => {
  assert.deepEqual(config.parseLooseJson(`{"a": "x\\" // y"}`), { a: 'x" // y' });
});

test("校正配置：每部手机的设置缺的补默认，坏的条目丢掉", () => {
  const c = config.normalizeConfig({
    devices: {
      R3GL: {
        name: "小明",
        pinned: [{ pkg: "com.a", name: "A", orientation: "landscape" }, { name: "没有包名" }],
        launch: { imePolicy: "乱写的" },
      },
    },
    customSizes: [{ id: "x", name: "X", width: 1080, height: 2400, dpi: 420 }, { id: "bad", width: -1 }],
    wireless: { lastPort: "123" },
  });
  const p = c.devices.R3GL;
  assert.deepEqual(p.pinned, [{ pkg: "com.a", name: "A", sizeId: null, orientation: "landscape", resizable: false }]);
  assert.equal(p.name, "小明");
  assert.equal(p.launch.imePolicy, "local");
  assert.equal(p.launch.audioBuffer, "medium");
  assert.equal(p.launch.pauseOnClose, true);
  assert.equal(p.launch.keyboard, "sdk");
  assert.equal(p.launch.audioRoute, "phone");
  assert.equal(p.launch.wakeOnLaunch, true);
  assert.equal(p.launch.stayInApp, true);
  assert.equal(c.customSizes.length, 1);
  assert.equal(c.wireless.lastPort, null);
  assert.equal(c.tools.scrcpy, "scrcpy");
  assert.equal(c.legacyProfile, null);
});

test("旧格式（只有一份设置）迁移成待认领的设置，forwardAudio 换算成声音位置", () => {
  const old = { pinned: [{ pkg: "com.xingin.xhs", name: "小红书" }], defaultSizeId: "pixel-10", launch: { forwardAudio: true }, preferredSerial: "192.0.2.10:44009" };
  const c = config.normalizeConfig(old);
  assert.deepEqual(c.devices, {});
  assert.equal(c.legacyProfile.serial, "192.0.2.10:44009");
  assert.equal(c.legacyProfile.profile.pinned[0].pkg, "com.xingin.xhs");
  assert.equal(c.legacyProfile.profile.defaultSizeId, "pixel-10");
  assert.equal(c.legacyProfile.profile.launch.audioRoute, "computer");
  assert.equal(config.normalizeConfig({ launch: { forwardAudio: false } }).legacyProfile.profile.launch.audioRoute, "phone");
});

test("认领设置：旧设置只归原来那部手机，其它手机拿默认值，已有的保留", () => {
  const c0 = config.normalizeConfig({ pinned: [{ pkg: "p", name: "P" }], preferredSerial: "192.0.2.10:44009" });

  // 另一部手机先被识别：不能抢走旧设置
  const c1 = config.claimProfile(c0, "SERIALBBBB2", "SERIALBBBB2", "小红的手机", "XQ-X000");
  assert.deepEqual(c1.devices.SERIALBBBB2.pinned, []);
  assert.equal(c1.devices.SERIALBBBB2.name, "小红的手机");
  assert.ok(c1.legacyProfile);

  // 原来那部（adb 编号对得上）认领旧设置
  const c2 = config.claimProfile(c1, "SERIALAAAA1", "192.0.2.10:44009", "小明的手机", "SM-X000");
  assert.equal(c2.devices.SERIALAAAA1.pinned[0].pkg, "p");
  assert.equal(c2.legacyProfile, null);
  assert.equal(c2.preferredDevice, "SERIALAAAA1");

  // 已有设置的手机：只更新名字，不动其它
  const c3 = config.claimProfile(c2, "SERIALAAAA1", "SERIALAAAA1", "改了名", "SM-X000");
  assert.equal(c3.devices.SERIALAAAA1.name, "改了名");
  assert.equal(c3.devices.SERIALAAAA1.pinned[0].pkg, "p");
  assert.equal(config.claimProfile(c3, "SERIALAAAA1", "x", "改了名", "SM-X000"), c3);
});

test("认领设置：旧设置没记手机时，第一部识别到的手机认领", () => {
  const c0 = config.normalizeConfig({ pinned: [{ pkg: "p", name: "P" }] });
  const c1 = config.claimProfile(c0, "ANY", "ANY", "n", "m");
  assert.equal(c1.devices.ANY.pinned.length, 1);
  assert.equal(c1.legacyProfile, null);
});

test("读配置：格式坏掉时备份原文件并回到默认值", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chichi-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "{ 这不是 JSON");

  const r = config.loadConfig(file);
  assert.deepEqual(r.config, config.defaultConfig());
  assert.match(r.broken.backup, /^config\.json\.broken-/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith("config.json.broken-")).length, 1);
});

test("读配置：文件不存在就用默认值，保存后能原样读回", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chichi-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sub", "config.json");

  assert.deepEqual(config.loadConfig(file), { config: config.defaultConfig(), broken: null });
  const c = { ...config.defaultConfig(), theme: "dark", devices: { A: config.defaultProfile("手机", "M") } };
  config.saveConfig(file, c);
  assert.deepEqual(config.loadConfig(file).config, c);
});

test("内置尺寸表能正常读取，且每项都完整", () => {
  const presets = config.loadPresets(path.join(__dirname, "..", "presets.json"));
  assert.ok(presets.length >= 5);
  for (const p of presets) assert.ok(p.width > 0 && p.height > 0 && p.dpi > 0, p.id);
});

// ═══ adb ═══

test("解析 adb devices -l：区分 USB 与无线，读出型号", () => {
  const out = [
    "List of devices attached",
    "192.0.2.10:41067     device product:xxx model:SM_X000 device:xxx transport_id:3",
    "R5CT1234ABC            unauthorized usb:1-2 transport_id:4",
    "",
  ].join("\n");
  assert.deepEqual(adb.parseDevices(out), [
    { serial: "192.0.2.10:41067", state: "device", model: "SM X000", wireless: true, id: null, name: null },
    { serial: "R5CT1234ABC", state: "unauthorized", model: "", wireless: false, id: null, name: null },
  ]);
});

test("解析 adb devices：忽略 daemon 启动提示", () => {
  const out = "* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n\n";
  assert.deepEqual(adb.parseDevices(out), []);
});

test("解析 nmap 输出里的开放端口，去重", () => {
  const out = "PORT      STATE SERVICE\n41067/tcp open  unknown\n43210/tcp open  unknown\n41067/tcp open  unknown\n";
  assert.deepEqual(adb.parseNmapPorts(out), [41067, 43210]);
});

test("端口范围校验", () => {
  assert.equal(adb.isValidPortRange("32768-60999"), true);
  assert.equal(adb.isValidPortRange("60999-32768"), false);
  assert.equal(adb.isValidPortRange("1-70000"), false);
  assert.equal(adb.isValidPortRange("abc"), false);
  assert.equal(adb.isValidPortRange("41067"), true);
  assert.equal(adb.isValidPortRange("70000"), false);
});

// ═══ scrcpy ═══

test("解析应用列表：中文名、带空格的名字、系统与用户应用", () => {
  const out = [
    "[server] INFO: List of apps:",
    " * 设置                             com.android.settings",
    " - Google Play 商店                 com.android.vending",
    " - 小红书                            com.xingin.xhs",
  ].join("\n");
  assert.deepEqual(scrcpy.parseAppList(out), [
    { system: true, name: "设置", pkg: "com.android.settings" },
    { system: false, name: "Google Play 商店", pkg: "com.android.vending" },
    { system: false, name: "小红书", pkg: "com.xingin.xhs" },
  ]);
});

test("解析 wm size / density：有 Override 以 Override 为准", () => {
  const size = "Physical size: 1248x1972\n";
  const density = "Physical density: 420\nOverride density: 450\n";
  assert.deepEqual(scrcpy.parseWmOutput(size, density), { width: 1248, height: 1972, dpi: 450 });
  assert.equal(scrcpy.parseWmOutput("", density), null);
});

test("方向摆正：竖屏高大于宽，横屏宽大于高", () => {
  const s = { width: 1640, height: 2360, dpi: 320 };
  assert.deepEqual(scrcpy.orient(s, "portrait"), { width: 1640, height: 2360, dpi: 320 });
  assert.deepEqual(scrcpy.orient(s, "landscape"), { width: 2360, height: 1640, dpi: 320 });
});

test("启动参数：应用窗口一律不带声音，额外参数只加给窗口", () => {
  const app = { pkg: "com.microsoft.office.word", name: "Word", sizeId: null, orientation: "landscape", resizable: false };
  const launch = { audioRoute: "computer", audioBuffer: "medium", pauseOnClose: true, imePolicy: "local", keyboard: "uhid", extraArgs: "  --video-bit-rate=16M   --stay-awake " };
  assert.deepEqual(scrcpy.buildLaunchArgs("SERIAL", app, { width: 2360, height: 1640, dpi: 320 }, launch), [
    "-s", "SERIAL",
    "--new-display=2360x1640/320",
    "--start-app=com.microsoft.office.word",
    "--window-title=Word",
    "--display-ime-policy=local",
    "--keyboard=uhid",
    "--no-audio",
    "--verbosity=verbose",
    "--video-bit-rate=16M",
    "--stay-awake",
  ]);
});

test("声音进程参数：无画面、无窗口、不控制，缓冲按档位；两边都响时保留手机外放", () => {
  assert.deepEqual(scrcpy.buildAudioArgs("SERIAL", "large", "computer"),
    ["-s", "SERIAL", "--no-video", "--no-window", "--no-control", "--audio-buffer=250"]);
  assert.deepEqual(scrcpy.buildAudioArgs("SERIAL", "medium", "both").slice(-2), ["--audio-source=playback", "--audio-dup"]);
  assert.ok(scrcpy.AUDIO_BUFFER_MS.small < scrcpy.AUDIO_BUFFER_MS.medium);
  assert.ok(scrcpy.AUDIO_BUFFER_MS.medium < scrcpy.AUDIO_BUFFER_MS.large);
});

test("可拖动窗口：换算成 1 像素 = 1dp，加上 --flex-display", () => {
  const app = { pkg: "p", name: "P", sizeId: null, orientation: "portrait", resizable: true };
  const launch = config.defaultLaunch();
  const args = scrcpy.buildLaunchArgs("S", app, { width: 1206, height: 2622, dpi: 480 }, launch);
  assert.ok(args.includes("--new-display=402x874/160"));
  // 桌面 150% 缩放：物理像素一比一，dpi 跟着放大，排版宽度仍是 402dp
  const hidpi = scrcpy.buildLaunchArgs("S", app, { width: 1206, height: 2622, dpi: 480 }, launch, 1.5);
  assert.ok(hidpi.includes("--new-display=603x1311/240"));
  // 只有 Wayland 需要让 SDL 按物理像素算窗口；Windows / X11 本来就是物理像素
  assert.deepEqual(scrcpy.flexEnv(app.resizable, 1.5, true), { SDL_VIDEO_WAYLAND_SCALE_TO_DISPLAY: "1" });
  assert.deepEqual(scrcpy.flexEnv(app.resizable, 1.5, false), {});
  assert.deepEqual(scrcpy.flexEnv(app.resizable, 1, true), {});
  assert.deepEqual(scrcpy.flexEnv(false, 1.5, true), {});
  assert.ok(args.includes("--flex-display"));
  const fixed = scrcpy.buildLaunchArgs("S", { ...app, resizable: false }, { width: 1206, height: 2622, dpi: 480 }, launch);
  assert.ok(fixed.includes("--new-display=1206x2622/480"));
  assert.ok(!fixed.includes("--flex-display"));
});

test("镜像参数：不建虚拟屏幕、不带声音", () => {
  const launch = { ...config.defaultLaunch(), extraArgs: "--max-size=1600" };
  const args = scrcpy.buildMirrorArgs("SERIAL", launch, "手机屏幕");
  assert.deepEqual(args, ["-s", "SERIAL", "--window-title=手机屏幕", "--keyboard=sdk", "--no-audio", "--verbosity=verbose", "--max-size=1600"]);
  assert.ok(!args.some((a) => a.startsWith("--new-display")));
});

test("从 scrcpy 输出里挑出错误行", () => {
  const out = "INFO: scrcpy 4.1\nERROR: Could not find any ADB device\nINFO: bye\n";
  assert.equal(scrcpy.lastErrorLine(out), "ERROR: Could not find any ADB device");
  assert.equal(scrcpy.lastErrorLine("just one line"), "just one line");
  assert.equal(scrcpy.lastErrorLine(""), null);
});

// ═══ 媒体会话 ═══

// 摘自真机 dumpsys media_session 的结构：没有 PlaybackState 的会话会被跳过
const DUMP = `
  Sessions Stack - have 4 sessions:
    CosmosHeadsetHandler app.podcast.cosmos/CosmosHeadsetHandler/20 (userId=0)
      SUMMARY: package=app.podcast.cosmos, uid=10368, controllers=413, active=true
      package=app.podcast.cosmos
      active=true
      state=PlaybackState {state=PLAYING(3), position=2295000, buffered position=0, speed=0.9}
    taobao com.taobao.taobao/xx (userId=0)
      package=com.taobao.taobao
      active=true
      state=null
    netease com.netease.cloudmusic/yy (userId=0)
      package=com.netease.cloudmusic
      state=PlaybackState {state=PAUSED(2), position=0}
`;

test("解析媒体会话，判断某个应用是否在播放", () => {
  const sessions = media.parseMediaSessions(DUMP);
  assert.deepEqual(sessions, [
    { pkg: "app.podcast.cosmos", state: 3 },
    { pkg: "com.netease.cloudmusic", state: 2 },
  ]);
  assert.equal(media.isPlaying(sessions, "app.podcast.cosmos"), true);
  assert.equal(media.isPlaying(sessions, "com.netease.cloudmusic"), false);
  assert.equal(media.isPlaying(sessions, "com.taobao.taobao"), false);
});

// ═══ 手机状态 ═══

test("解析 dumpsys power 里的唤醒状态", () => {
  assert.equal(device.parseWakefulness("  mWakefulness=Dozing\n  mStayOn=false"), "Dozing");
  assert.equal(device.parseWakefulness("mWakefulness=Awake"), "Awake");
  assert.equal(device.parseWakefulness(""), null);
});

test("解析每块屏幕最上面的应用（取自真机输出）", () => {
  const out = [
    "Display #0 (activities from top to bottom):",
    "Display #36 (activities from top to bottom):",
    "      topResumedActivity=ActivityRecord{88193039 u0 com.sec.android.app.launcher/com.honeyspace.dexservice.SecondaryLauncher t5029}",
    "Display #37 (activities from top to bottom):",
    "    topResumedActivity=ActivityRecord{207394544 u0 app.podcast.cosmos/io.iftech.android.podcast.app.home.index.view.HomeActivity t5030}",
  ].join("\n");
  const tops = device.parseTopActivities(out);
  assert.equal(tops.has(0), false);
  assert.deepEqual(tops.get(36), { pkg: "com.sec.android.app.launcher", activity: "com.honeyspace.dexservice.SecondaryLauncher" });
  assert.equal(tops.get(37).pkg, "app.podcast.cosmos");
});

test("识别桌面：按手机声明的桌面界面比对，简写展开后也能对上", () => {
  const out = [
    "4 activities found:",
    "  Activity #0:",
    "    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true",
    "    com.android.systemui/.cover.CoverHomeActivity",
    "  Activity #2:",
    "    com.sec.android.app.launcher/com.honeyspace.dexservice.SecondaryLauncher",
  ].join("\n");
  const homes = device.parseComponents(out);
  assert.equal(homes.size, 2);
  assert.ok(homes.has("com.android.systemui/com.android.systemui.cover.CoverHomeActivity"));
  assert.equal(device.isHome(homes, { pkg: "com.sec.android.app.launcher", activity: "com.honeyspace.dexservice.SecondaryLauncher" }), true);
  assert.equal(device.isHome(homes, { pkg: "com.android.systemui", activity: ".cover.CoverHomeActivity" }), true);
  // 同一个包里的其它界面不算桌面
  assert.equal(device.isHome(homes, { pkg: "com.android.systemui", activity: "com.android.systemui.Other" }), false);
  assert.equal(device.isHome(homes, { pkg: "app.podcast.cosmos", activity: "x.Home" }), false);
});

// ═══ 多语言 ═══

const LOCALES = path.join(__dirname, "..", "locales");
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("每种语言都有文案文件，键与中文完全一致，占位符一一对应", () => {
  const zh = i18n.loadLocale(LOCALES, "zh");
  const files = fs.readdirSync(LOCALES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(files, i18n.LANGUAGES.map((l) => l.code).sort());

  for (const { code } of i18n.LANGUAGES) {
    const dict = i18n.loadLocale(LOCALES, code);
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(zh).sort(), `${code} 的键和 zh 不一致`);
    for (const key of Object.keys(zh)) {
      assert.ok(dict[key].trim(), `${code}.${key} 是空的`);
      assert.deepEqual(placeholders(dict[key]), placeholders(zh[key]), `${code}.${key} 的占位符和 zh 不一致`);
    }
  }
});

test("界面 HTML 里用到的文案键都存在", () => {
  const zh = i18n.loadLocale(LOCALES, "zh");
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  const keys = [...html.matchAll(/data-i18n(?:-placeholder|-aria-label)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 50);
  for (const k of keys) assert.ok(k in zh, `index.html 用了不存在的键 ${k}`);
});

test("代码里 t(\"…\") 引用的文案键都存在", () => {
  const zh = i18n.loadLocale(LOCALES, "zh");
  const dir = path.join(__dirname, "..", "src");
  const files = ["renderer/app.ts", "main/main.ts", "main/adb.ts", "main/scrcpy.ts"];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/\bt\("([\w.-]+)"/g)) assert.ok(m[1] in zh, `${f} 用了不存在的键 ${m[1]}`);
  }
});

test("跟随系统时按系统语言挑，认不出来用英文", () => {
  assert.equal(i18n.resolveLanguage("auto", "zh-CN"), "zh");
  assert.equal(i18n.resolveLanguage("auto", "zh-TW"), "zh-Hant");
  assert.equal(i18n.resolveLanguage("auto", "zh_HK.UTF-8"), "zh-Hant");
  assert.equal(i18n.resolveLanguage("auto", "zh-Hant-SG"), "zh-Hant");
  assert.equal(i18n.resolveLanguage("auto", "zh-SG"), "zh");
  assert.equal(i18n.resolveLanguage("zh-Hant", "en-US"), "zh-Hant");
  assert.equal(i18n.resolveLanguage("auto", "ja_JP"), "ja");
  assert.equal(i18n.resolveLanguage("auto", "pt-BR"), "en");
  assert.equal(i18n.resolveLanguage("de", "zh-CN"), "de");
  assert.equal(i18n.resolveLanguage("xx", "ko"), "ko");
});

test("占位符替换，缺参数时原样保留", () => {
  assert.equal(i18n.interpolate("打开 {name}，第 {n} 次", { name: "淘宝", n: 2 }), "打开 淘宝，第 2 次");
  assert.equal(i18n.interpolate("{a}{b}", { a: 1 }), "1{b}");
});

test("设置里的语言：认识的保留，不认识的回到跟随系统", () => {
  assert.equal(config.normalizeConfig({ language: "ar" }).language, "ar");
  assert.equal(config.normalizeConfig({ language: "klingon" }).language, "auto");
  assert.equal(config.defaultConfig().language, "auto");
  assert.equal(config.normalizeConfig({ theme: "dark" }).theme, "dark");
  assert.equal(config.normalizeConfig({ theme: "紫色" }).theme, "system");
});

test("解析手机身份：序列号、型号、手机名称；没设名字时用型号", () => {
  assert.deepEqual(adb.parseIdentity("SERIALAAAA1\nSM-X000\n小明的手机\n", "192.0.2.10:44009"),
    { id: "SERIALAAAA1", name: "小明的手机", model: "SM-X000" });
  assert.deepEqual(adb.parseIdentity("SERIALBBBB2\nXQ-X000\nnull\n", "SERIALBBBB2"),
    { id: "SERIALBBBB2", name: "XQ-X000", model: "XQ-X000" });
  // 读不到序列号时退回 adb 编号，至少不会把两部手机混成一部
  assert.equal(adb.parseIdentity("\n\n\n", "emulator-5554").id, "emulator-5554");
});

test("截图：从 SurfaceFlinger 输出里找到虚拟屏幕对应的长编号", () => {
  const dump = [
    "Display 11529215047529996626 (virtual, \"scrcpy\")",
    "   layerFilter={layerStack=86 toInternalDisplay=false skipScreenshot=false }",
    "Display 4630947123231501204 (physical, \"内置屏幕\")",
    "   layerFilter={layerStack=0 toInternalDisplay=true skipScreenshot=false }",
    "Display 11529215048581881716 (virtual, \"scrcpy\")",
    "   layerFilter={layerStack=91 toInternalDisplay=false skipScreenshot=false }",
  ].join("\n");
  const ids = device.parseSurfaceFlingerIds(dump);
  assert.equal(ids.get(86), "11529215047529996626");
  assert.equal(ids.get(91), "11529215048581881716");
  assert.equal(ids.has(0), false); // 物理屏幕不算
});

test("解析 scrcpy 的输入日志：按下/拖动/抬起带坐标，鼠标悬停不算，键盘打字只需唤醒", () => {
  assert.deepEqual(scrcpy.parseInputLine("VERBOSE: input: touch [id=mouse] down position=600,1100 pressure=1.000000 action_button=000001 buttons=000001"),
    { kind: "down", x: 600, y: 1100 });
  assert.deepEqual(scrcpy.parseInputLine("VERBOSE: input: touch [id=mouse] up   position=601,1102 pressure=0.000000 action_button=000001 buttons=000000"),
    { kind: "up", x: 601, y: 1102 });
  assert.deepEqual(scrcpy.parseInputLine("VERBOSE: input: touch [id=1] move position=10,20 pressure=1.000000 action_button=000000 buttons=000000"),
    { kind: "move", x: 10, y: 20 });
  assert.equal(scrcpy.parseInputLine("VERBOSE: input: touch [id=mouse] hover-move position=5,5 pressure=0.000000 action_button=000000 buttons=000000"), null);
  assert.deepEqual(scrcpy.parseInputLine("VERBOSE: input: key down code=29 repeat=0 meta=000000"), { kind: "other" });
  assert.deepEqual(scrcpy.parseInputLine("VERBOSE: input: text \"hello\""), { kind: "other" });
  assert.equal(scrcpy.parseInputLine("INFO: Texture: 1206x2622"), null);
  // scrcpy 自己发的内部消息不算用户操作
  assert.equal(scrcpy.parseInputLine("VERBOSE: input: set-clipboard sequence=1 paste=false \"x\""), null);
  assert.equal(scrcpy.parseInputLine("VERBOSE: input: get-clipboard copy_key=none"), null);
  assert.deepEqual(scrcpy.parseInputLine("VERBOSE: input: scroll position=1,2 hscroll=0.000000 vscroll=-1.000000 buttons=000000"), { kind: "other" });
});

test("判断是不是一次点击：时间短、位置几乎不动", () => {
  const down = { x: 100, y: 100, t: 0 };
  assert.equal(scrcpy.isTap(down, { x: 105, y: 103, t: 120 }), true);
  assert.equal(scrcpy.isTap(down, { x: 100, y: 400, t: 200 }), false); // 拖动
  assert.equal(scrcpy.isTap(down, { x: 100, y: 100, t: 900 }), false); // 长按
});

test("连接通知：从 cmd notification list 里找到我们那条", () => {
  const list = "0|com.whatsapp|1|null|10123\n0|com.android.shell|2020|chichi|2000\n0|com.android.shell|2020|other|2000\n";
  assert.equal(device.findNotificationKey(list, "chichi"), "0|com.android.shell|2020|chichi|2000");
  assert.equal(device.findNotificationKey("0|com.whatsapp|1|null|10123\n", "chichi"), null);
});

test("adb shell 参数加引号：单引号也能原样传过去", () => {
  assert.equal(device.shellQuote("It's 琪琪"), "'It'\\''s 琪琪'");
});

test("解析启动记录：从桌面点图标 / 命令行启动 / 应用跳转", () => {
  const icon = "I/ActivityTaskManager(16571): START u0 {act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10200000 xflg=0x4 cmp=com.xingin.xhs/.Index bnds=[112,507][1085,659]} with LAUNCH_SINGLE_TOP from uid 10369 (some.launcher) (BAL_ALLOW_VISIBLE_WINDOW) result code=3";
  assert.deepEqual(device.parseStartLine(icon), { pkg: "com.xingin.xhs", caller: "some.launcher", fromIcon: true });
  const shell = "START u0 {act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10000000 cmp=com.android.settings/.Settings} with LAUNCH_MULTIPLE from uid 2000 (com.android.shell) (BAL_ALLOW_PERMISSION) result code=0";
  assert.equal(device.parseStartLine(shell).caller, "com.android.shell");
  const jump = "START u0 {flg=0x4000000 xflg=0x4 cmp=com.tencent.mm/.ui.Foo (has extras)} with LAUNCH_MULTIPLE from uid 10480 (com.tencent.mm) (BAL_ALLOW_VISIBLE_WINDOW) result code=0";
  assert.equal(device.parseStartLine(jump).fromIcon, false);
  assert.equal(device.parseStartLine("I/ActivityTaskManager: Displayed com.x/.Y"), null);
});

test("记住的无线手机：校正、去重、最近的在前", () => {
  const c = config.normalizeConfig({ wireless: { known: [
    { id: "SERIALAAAA1", name: "小明的手机", host: "192.0.2.10", lastPort: 44009 },
    { id: "SERIALAAAA1", name: "重复", host: "192.0.2.11", lastPort: 1 },
    { id: "", host: "192.0.2.12" },
    { id: "SERIALBBBB2", host: "bad host;rm" },
    "garbage",
  ] } });
  assert.deepEqual(c.wireless.known, [{ id: "SERIALAAAA1", name: "小明的手机", host: "192.0.2.10", lastPort: 44009 }]);
  assert.deepEqual(config.normalizeConfig({}).wireless.known, []);

  const same = config.rememberWireless(c, { id: "SERIALAAAA1", name: "小明的手机", host: "192.0.2.10", lastPort: 44009 });
  assert.equal(same, c);
  const c2 = config.rememberWireless(c, { id: "SERIALBBBB2", name: "小红的手机", host: "192.0.2.20", lastPort: 5555 });
  assert.deepEqual(c2.wireless.known.map((k) => k.id), ["SERIALBBBB2", "SERIALAAAA1"]);
  const c3 = config.rememberWireless(c2, { id: "SERIALAAAA1", name: "小明的手机", host: "192.0.2.10", lastPort: 40001 });
  assert.deepEqual(c3.wireless.known.map((k) => `${k.id}:${k.lastPort}`), ["SERIALAAAA1:40001", "SERIALBBBB2:5555"]);
});

test("从 dumpsys notification 找我们那条通知（含 snooze 的），标签要完全相同", () => {
  const dump = [
    "    key: 0|com.android.shell|2020|chichi|2000",
    "    key: 0|com.android.shell|2020|chichi-test|2000",
    "    key: 0|com.android.shell|2020|chichi|2000 until: 1822662360713",
    "    key: 0|com.example|2020|chichi|10001",
  ].join("\n");
  assert.deepEqual(device.findTaggedKeys(dump, "chichi"), ["0|com.android.shell|2020|chichi|2000"]);
  assert.deepEqual(device.findTaggedKeys("", "chichi"), []);
});

test("额外屏幕：空的可拖动虚拟屏幕，关掉时应用挪回手机", () => {
  const launch = { ...config.defaultLaunch(), extraArgs: "--max-fps=60" };
  const args = scrcpy.buildDesktopArgs("SERIALAAAA1", launch, "额外屏幕", 1.5);
  assert.ok(args.includes("--new-display=1920x1080/240"));
  assert.ok(args.includes("--flex-display"));
  assert.ok(args.includes("--no-vd-destroy-content"));
  assert.ok(args.includes("--no-audio"));
  assert.ok(args.includes("--max-fps=60"));
  assert.ok(!args.some((a) => a.startsWith("--start-app")));
  assert.ok(scrcpy.buildDesktopArgs("SERIALAAAA1", launch, "x", 1).includes("--new-display=1280x720/160"));
});

test("adb connect 被拒绝（端口没开）能认出来，不用干等", () => {
  assert.ok(adb.isRefused("failed to connect to '192.0.2.10:40999': Connection refused\n"));
  assert.ok(adb.isRefused("cannot connect to 192.0.2.10:40999: No connection could be made because the target machine actively refused it. (10061)"));
  assert.ok(!adb.isRefused("connected to 192.0.2.10:37551\n"));
  assert.ok(!adb.isRefused("failed to connect to '192.0.2.10:40999': Connection timed out\n"));
});
