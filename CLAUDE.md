@AGENTS.md

（上面一行把 AGENTS.md 里的协作红线引进来；红线只在 AGENTS.md 改，这样别的 AI 工具也读得到同一份。）

# 琪琪（chichi）— 维护说明

中文界面和日文界面显示「琪琪」，其余语言显示全小写的 `chichi`（文案键 `app.name`）。包名、配置目录、可执行文件、菜单项文件名等内部标识一律用 `chichi`。开发时曾叫 Phone Apps，`migrateFromOldName` 会在第一次启动时把 `~/.config/Phone Apps/config.json` 拷到新位置（旧文件夹不删）。

用户文档见 README.md（英文）/ README.zh-CN.md，版本变化见 CHANGELOG.md / CHANGELOG.zh-CN.md。两种语言的文档要同步改。这里记架构、决策理由和不变量。

## 唯一的使用前提

「安卓手机 + 开了 USB 调试」。除此之外的一切（品牌、系统版本、连接方式）都不能是硬前提：做不到的功能要按系统版本明确告知，不能写死某个厂商的行为。新增功能时先问自己它是不是偷偷多加了前提。已知的版本门槛（`device.ts` 的 `MIN_SDK`，均已按 scrcpy 源码/文档核实）：虚拟屏幕 API 29（scrcpy Server.java: "New virtual display is not supported before Android 10"），声音转发 API 30，`--audio-dup`/playback 源 API 33，镜像 API 21。

## 架构

Electron + TypeScript，无打包器，`tsc` 直接编译到 `dist/`，静态文件用 `cp` 拷过去。

```
src/
  shared/types.d.ts   全局类型声明（无 import/export），主进程与界面共用
  main/main.ts        窗口、IPC 注册、配置状态
  main/config.ts      配置读写：宽松 JSON、校正、原子保存、presets.json
  main/adb.ts         run()、解析 adb devices / nmap、无线连接流程
  main/scrcpy.ts      解析 --list-apps / wm 输出、拼启动参数、Launcher 进程管理（窗口 + 声音）
  main/media.ts       解析 dumpsys media_session，关窗口时暂停正在播放的应用
  main/device.ts      唤醒息屏的手机、读每块屏幕最上面的应用、把应用拉回前台
  main/i18n.ts        语言列表、解析「跟随系统」、加载 locales、t()
  preload/preload.ts  contextBridge 暴露 window.phone（PhoneApi）
  renderer/           index.html + style.css + app.ts（普通脚本）
presets.json          内置窗口尺寸，随程序发布（name 是英文兜底名）
locales/*.json        十种语言的界面文案，zh.json 为准（zh-Hant 是繁体，台湾用语）
assets/icon.svg       开始菜单图标（源文件）
assets/icon.png, tray.png  由 icon.svg 用 ImageMagick 渲染：窗口图标 256px、托盘图标 64px（Electron 的 nativeImage 不认 SVG）
scripts/install-desktop.sh  写 ~/.local/share/applications/chichi.desktop（顺手删掉改名前的 phoneapps.desktop）（--remove 卸载）
test/core.test.js     node:test，只测 dist/ 里的纯函数，全部离线
```

数据流：界面只通过 `window.phone` 调主进程；主进程是配置的唯一写入者（`updateConfig` → `normalizeConfig` → `saveConfig`）。界面每次保存都把整个 Config 发过去，拿回新的 AppState。

## 决策与理由

- **声音只转一份。** scrcpy 的 `--audio-source=output` 抓整机输出，不分应用/显示。早期版本每个窗口都带声音，同一段声音被播 N 遍（用户反馈「声音很奇怪」）。现在应用窗口一律 `--no-audio`，另起一个 `--no-video --no-window --no-control` 的声音进程（`Launcher.syncAudio`）：有窗口且开了转发就存在，serial 或缓冲档位变了就重启，意外退出后同样设置不自动重启。注意 `--no-video` 不带 `--no-window` 仍会开一个空窗口。
- **关窗口时暂停而不是杀应用。** 先 `dumpsys media_session` 确认该包的会话处于 PLAYING(3)/BUFFERING(6)，再 `cmd media_session dispatch pause`（系统级媒体键，投给当前媒体按键会话）。三条关闭路径都覆盖：界面「关闭窗口」（先暂停再杀）、直接关 scrcpy 窗口（`onAppExit` 里补暂停）、退出启动器（`stopAll` 先暂停再杀，`before-quit` 等它完成）。`onAppExit` 里先暂停再 `syncAudio`，否则停声音进程的瞬间声音会从手机外放。
- **键盘默认 sdk，uhid 可选。** sdk 只能注入 ASCII，电脑输入法打的中文进不去；uhid 模拟外接键盘，中文可用，但窗口开着期间手机一直挂着一个实体键盘，用户直接用手机时 Gboard 会隐藏屏幕键盘（手机上 `show_ime_with_hard_keyboard` 已是 1 也没用），用户试过觉得不行，所以默认改回 sdk。
- **声音位置三选一**（`launch.audioRoute`）：phone 不起声音进程；computer 用默认 output 源（手机静音）；both 用 `--audio-source=playback --audio-dup`。旧配置的 `forwardAudio` 布尔值在 `normalizeRoute` 里迁移。常用页顶部和设置页各有一个切换，共用 `routeButtons()`。
- **镜像模式**：`launchMirror` 跑不带 `--new-display` 的 scrcpy，在 `running` 里以 `MIRROR_KEY = "@mirror"` 占位（界面 app.ts 里有同名常量，改一处要同步改另一处）。没有虚拟屏幕编号，所以返回键守护天然跳过它；关闭时不做暂停。
- **额外屏幕**（`launchDesktop`，占位 `DESKTOP_KEY = "@desktop"`，界面 app.ts 有同名常量）：不带 `--start-app` 的 `--new-display`，手机会在上面显示声明了 SECONDARY_HOME 的桌面（实测三星是 DeX 的 SecondaryLauncher）。总是 `--flex-display`，初始 1920×1080/240 横屏，按 `toFlexDisplay` 换算。加 `--no-vd-destroy-content`：关掉时上面的应用挪回主屏而不是被结束（实测关后任务到了 0 号屏幕）。手机上查不到 SECONDARY_HOME（`hasSecondaryHome`）时照样打开但提示可能空白，不写死品牌。返回键守护、暂停播放、logcat 收回、`returnToPhone` 的搬任务都用 `isApp()` 跳过它和镜像；唤醒和补发点击照常（它有屏幕编号）。
- **息屏时自动唤醒，并补发被丢掉的点击。** 手机 Dozing/Asleep 时虚拟屏幕照样能显示，但注入的点击全被丢掉（实测：睡着时 `input -d N tap` 无效，KEYCODE_WAKEUP 后约 0.4 秒再点就生效）。窗口开着期间手机随时可能再次息屏，所以不能只在打开时唤醒一次。做法：应用窗口和镜像窗口都加 `--verbosity=verbose`，scrcpy 会把每个输入打成 `input: touch [id=mouse] down position=x,y ...`（源码 control_msg.c `sc_control_msg_log`）。`spawnScrcpy` 按行读输出，输入行交给 `onInput`，**不打印、不保存**（打字内容也在里面）。按下时 `ensureAwake` 查 mWakefulness（2 秒内确认过醒着就不再查），睡着就唤醒并等 0.4 秒；抬起时如果是点击（`isTap`：500ms 内、移动不超过 24px），且刚才确实把手机叫醒了，就用 `input -d <屏幕> tap` 在原坐标补发。鼠标悬停（hover-move）不触发；键盘、滚动只唤醒不补发；镜像窗口不补发（主屏刚亮时是锁屏）。**不选「一直保持唤醒」**：用户会直接拿起手机用，强行保持唤醒会让手机屏幕反复亮、按电源键锁不住。坐标按虚拟屏幕像素算，额外参数里加了 `--max-size` 时补发位置会偏。实测从点击到补发生效约 0.5 秒。
- **桌面识别不写死品牌**：`readHomeComponents` 用 `cmd package query-activities` 查手机上声明了 SECONDARY_HOME 和 HOME 的界面，按完整组件名（简写 `.Foo` 先展开）比对。只比包名会误伤（例如 systemui 既有盖板屏桌面也有别的界面）。
- **返回键守护**（`guardTick`，每秒一次）：带系统装饰的虚拟屏幕退到底会显示三星 DeX 的 SecondaryLauncher；去掉装饰（`--no-vd-system-decorations`）则变成空屏，且会影响输入法显示在窗口里，所以没用。做法是轮询 `dumpsys activity activities | grep`（手机上过滤，约 0.07 秒），屏幕最上面是桌面包名时 `am start --display N -n <入口>`；实测回到的是同一个 ActivityRecord，页面状态保留。只认桌面，不认其它应用，免得打断淘宝跳支付宝这类正常跳转。新窗口前 3 秒不检查（刚建好的屏幕会短暂显示桌面）。scrcpy 输出里的 `New display: ... (id=N)` 提供屏幕编号。
- **手机上点图标收回**（`Launcher` 的 logcat 监听）：有窗口的每部手机起一个 `logcat -T 1 -v brief ActivityTaskManager:I *:S`（第一行是旧记录，丢掉；意外退出 3 秒后重启；没窗口就停）。`parseStartLine` 解析 `START u0 {... cmp=包/类 ...} from uid N (调用方包名)`，只有调用方是手机默认桌面（`readDefaultHome`，按手机缓存）、且该包在这部手机上开着窗口才动作：`am start --display 0` 把原任务挪回主屏（实测同一个 task id，页面状态保留），等 0.3 秒再杀 scrcpy，`AppProc.returning` 标记让 `onAppExit` 发 `returned` 事件且不暂停播放。不认别的调用方，免得应用间跳转误触发。
- **通知断开**：连上（第一次识别到）时 `cmd notification post -S bigtext -t <标题> chichi <正文>` 发一条通知（以 com.android.shell 身份，tag `chichi`），每 3 秒用 `cmd notification list` 查它的 key 还在不在；不见了（用户划掉）就 `returnAll` 收回该手机所有窗口，无线连接再 `adb disconnect`。手机连不上时 `notificationKey` 返回 undefined，不算划掉。`list` 刚发完可能查不到，所以发后重试 10×300ms。没有 cancel 子命令，撤回用 `snooze --for 31536000000`（一年），通知的 key 每次都一样（`0|com.android.shell|2020|chichi|2000`），被 snooze 着时新发的会直接进 snooze、看不见，而 `list` 不列出 snooze 的通知，所以发之前从 `dumpsys notification` 里找同标签的 key（`findTaggedKeys`）先 unsnooze；退出时撤回所有通知。USB 断不了，划掉只收回应用；拔线后通知会残留。
- **「已连接」要手机实际回话**（`isAlive`：`adb shell echo`，3 秒超时）：手机断网/休眠后 adb 要过好一阵才发现，`adb devices` 里无线条目一直是 device。所以 list-devices 先 `markStale` 把不回话的无线条目改成 offline，`connectWireless` 的「已经连着」也先探一下，不通就断开重连。断了的手机探一次要 3 秒，界面的轮询加了在途保护不叠加。USB 不探。设备列表一变，「已记住的手机」的在线状态也要跟着重画（`loadDevices` 里调 `renderKnown`），否则停在打开设置页那一刻的状态。
- **无线端口**：扫描时总是带上 5555（老式 `adb tcpip`），端口栏也接受单个端口，免得只支持安卓 11 的随机端口。
- **多语言**：所有面向用户的文字走 `locales/<code>.json`，代码里只写键名。主进程用 `i18n.t()`（错误信息、托盘菜单、连接日志都在主进程产生）；界面拿 `AppState.strings` 自带一个同样的 `t()`，HTML 里的固定文字用 `data-i18n` / `data-i18n-placeholder` / `data-i18n-aria-label` 标记，由 `applyStaticText()` 填入。语言在 app ready 后才能确定（`app.getLocale()` 之前不可用），所以 `loadConfig` 只返回 `broken` 的原始信息，由 main.ts 翻译。阿拉伯语设置 `dir="rtl"`，CSS 用逻辑属性（`padding-inline-start`、`text-align: start`），别再写 left/right。按 `:lang()` 换 CJK/阿拉伯字体。内置尺寸名用 `size.<id>` 键翻译，找不到就用 presets.json 的 name。代码注释和 stderr 日志仍用中文，不翻译。中文按地区分简繁（`resolveLanguage`：TW/HK/MO/Hant → zh-Hant）。测试会检查十个文件键一致、占位符一致、代码和 HTML 用到的键都存在。
- **可拖动窗口**（`PinnedApp.resizable` → `--flex-display`）：scrcpy 会把虚拟屏幕改成窗口的像素大小但不改 dpi，按 480dpi 时 396px 宽的窗口只有 132dp，界面巨大。所以 `toFlexDisplay` 把初始尺寸换算成 dpi 160（1px = 1dp），排版宽度与原预设一致，之后窗口多宽 App 就多宽。桌面有缩放时（用户是 KDE 1.5 倍），scrcpy 按**逻辑**窗口尺寸调整手机屏幕（源码 screen.c 直接用 SDL_EVENT_WINDOW_RESIZED 的数值，最新版也一样），画面只有物理像素的 2/3 再被放大，发糊。解决：`flexEnv` 给可拖动窗口加 `SDL_VIDEO_WAYLAND_SCALE_TO_DISPLAY=1`（scrcpy 4.x 用 SDL3），让逻辑尺寸 = 物理尺寸；`toFlexDisplay` 的 dpi 取 160 × 缩放比例，排版宽度不变。缩放比例来自 Electron 的 `screen.getPrimaryDisplay().scaleFactor`（多显示器只看主显示器）。已知副作用：scrcpy 限制初始窗口不超过屏幕时用的是逻辑的可用高度，所以初始窗口被截短（实测 602×926 而不是 602×1310），`--window-height` 又不能和 `--flex-display` 一起用，只能让用户自己拖高。固定大小的窗口不加这个环境变量（它们的画面本来就比窗口大、缩小显示是清楚的）。
- **外观**（`config.theme`）：设 `nativeTheme.themeSource`，Electron 会据此改写 CSS 的 prefers-color-scheme，界面只维护一套 `@media (prefers-color-scheme: dark)` 令牌。选中态用 `--selected`，深色下要比底色亮。
- **设置跟着手机走**（`config.devices[序列号]` = `DeviceProfile`）：常用列表、默认尺寸、`LaunchSettings` 按手机存；语言、外观、自定义尺寸、无线地址、程序位置全局共用。手机用 `ro.serialno` 识别（`adb.identify` 一次 shell 读序列号/型号/`settings global device_name`），因为 adb 编号在 USB 和无线下不同、无线端口还会变。main.ts 维护 adb 编号 → 身份的缓存，第一次见到的手机调 `claimProfile`：有就用，旧格式留下的 `legacyProfile` 只给原来那部手机（旧的 `preferredSerial` 对得上，或没记编号时给第一部），其余给默认值。Launcher 通过 `getLaunch(serial)` 取每个窗口所属手机的选项；声音进程跟第一个窗口的手机走。**界面保存时发整份 Config，所以 list-devices 每次都把主进程最新的 config 带回去**，否则主进程刚认领的新手机会被界面的旧配置覆盖。当前手机没装的应用靠 `pm list packages`（每个 adb 编号读一次）标出。
- **截图在手机上截**（`device.screenshot`）：`screencap -d` 要的是 SurfaceFlinger 的长编号，不是安卓的屏幕编号（直接给 93 会报 "Display Id '93' is not valid"）。`dumpsys SurfaceFlinger` 里每块虚拟屏幕是 `Display <长编号> (virtual, "scrcpy")` 后跟 `layerFilter={layerStack=<安卓编号>`，据此对应（手机上先 grep 过滤）。镜像窗口不带 -d，截主屏。结果用 PNG 文件头校验，screencap 出错时输出的是文字。实测应用窗口 0.4 秒、整屏 0.8 秒。剪贴板用 Electron 44 的 `clipboard.write([new ClipboardItem(...)])`（旧的 writeImage 已经没有了）。没法在 scrcpy 的 SDL 窗口里加按钮，所以按钮放在启动器列表行尾和托盘。
- **只用一个 adb。** 系统 adb（34）和 scrcpy 自带 adb（37）版本不同，交替使用会互相重启 adb server，无线连接随之断开。所以 Launcher 和 listApps 启动 scrcpy 时一律设置 `ADB=config.tools.adb`。
- **窗口尺寸 = 像素 + dpi。** `--new-display=WxH/dpi`。iPhone 预设用 逻辑点 × 3 = 像素、dpi 480，使 App 看到的 dp 宽度与 iPhone 的 pt 宽度一致。
- **尺寸按竖屏存，方向在启动时摆正**（`orient()`），这样一个预设能同时用于横竖屏。
- **「跟随手机」在启动时现读 `wm size` / `wm density`**，有 Override 用 Override；这样折叠屏开合后也是当前值。
- **记住无线手机**（`config.wireless.known`，最近的在前）：`identifyDevices` 第一次识别到一个无线 adb 编号（`IP:端口`）时 `rememberWireless` 记下 序列号/名字/地址/端口，所以别的工具连上的也会记住。放在全局而不是 `DeviceProfile` 里，免得「从另一部手机复制」把地址也复制过去。`connect-wireless` 带序列号时用记住的地址和端口（端口失效照常走 nmap 扫描），不带时用「连接新手机」那一栏。用户明确不要后台自动重连：端口会变，重连必然要扫描，而且会和「划掉通知断开」打架。
- **无线连接照搬作者本机一个连接脚本的思路**（脚本位置见 `.private/NOTES.md`）：成功只看 `adb devices` 状态；nmap 扫描后冷却 3 秒；`adb connect` 返回 Connection refused（`isRefused`，端口没开）立即判失败、不重试不等待——实测拒绝只要 0.01 秒，而原来要白等约 6 秒（两次 × 等 2 秒条目出现 + 中间 2 秒），这才是慢的根源，扫描本身在本机只要约 2.3 秒；条目 2 秒内没出现就快速失败（输出是 failed to connect 时连这 2 秒也不等）；扫到多个端口时 `tryPorts` 同时试，先连上的赢，其余不再重试、万一也连上就断开（手机上开着的不一定都是调试端口，挨个试一个假端口就白等十几秒）；adb server 异常时重启一次。成功端口写回 `config.wireless.lastPort`。
- **界面是普通脚本不是 ES 模块。** 因此 app.ts 不能有 import/export，类型走全局 .d.ts。注意 `contextBridge` 暴露的名字 `phone` 已是全局只读变量，界面里不能再声明同名变量（用的是 `api`）。
- **CSP 禁止内联 style 属性**，`h()` 里用 `el.style.cssText` 赋值（CSSOM 不受限）。
- **设备每 3 秒轮询**，结果没变化不重画，避免点击途中列表被替换。
- **常用页是手风琴**：点一行展开抽屉（打开/关闭、尺寸、方向、置顶、移除），同时只展开一行。只有刚展开的那次播动画（`ui.justExpanded`），轮询重画时不重播。挑选应用在「设置 → 应用」。
- **配置目录由 package.json 的 `productName` 决定**：`~/.config/chichi/`（`app.getPath("userData")`）。
- **开始菜单项直接跑 `node_modules/.bin/electron <项目>`，不经过 npm、不重新编译**，启动快；代价是改代码后要手动 `npm run build`。菜单项里写的是绝对路径，项目挪位置要重跑安装脚本。
- **任务栏图标对应菜单项**：package.json 的 `desktopName` 决定 Wayland 下的 app_id，`--class` 和 `StartupWMClass` 管 X11，三者都是 `chichi`。
- **单实例**（`requestSingleInstanceLock`）：两个启动器会各管一套 scrcpy 进程、互相看不见，所以第二次启动直接退出并把第一个的窗口调到前面。
- **圆点颜色按常用列表的位置分配**，保证前 10 个不撞色；没加入常用的应用是灰点。

## 不变量

- 每个包名最多一个 scrcpy 窗口进程（`Launcher.running` 以 pkg 为键），声音进程至多一个。
- 关主窗口只是 `hide()`（`close` 事件里拦下），只有托盘「退出」、系统注销等真正 quit 时 `quitting` 才为 true。截图模式不建托盘、不拦关闭。
- 真正退出时 `before-quit` 先拦下、调 `stopAll()`，完成后再 quit，不留孤儿进程。scrcpy 的 stdout/stderr 接在主进程的管道上，主进程一退，管道断开 scrcpy 也会异常退出，所以即使想保留窗口也得先改成写日志文件。
- 配置解析失败时先把原文件改名备份，再用默认值，绝不直接覆盖用户手改的文件。
- `normalizeConfig` 是配置进入内存的唯一入口，界面发来的数据也要过它。

## 发布隔离

- **发版只用 `tools/package.sh`**：从 git 导出源码到临时目录，`npm ci`、跑测试、electron-builder 打包，再扫描成品，通过才放进 `release/`（带 SHA256SUMS）。正式包要求工作区干净、从 HEAD 打；`--snapshot` 按当前工作区试打包，不动暂存区。默认打 `linux:AppImage win:nsis`，用 `TARGETS=...` 改（.deb 要先填 homepage）。`npm run dist` / `dist:win` 是在工作目录里直接打的，只用于开发调试，**不要拿去发布**。
- 安装包是压缩格式（squashfs、NSIS）扫描器拆不开，所以扫的是打包前的 `linux-unpacked` / `win-unpacked`。
- **`.private/`（不进 git）**：`NOTES.md` 记本机真实信息（测试手机的序列号和名字、Tailscale 地址、本机脚本路径、显示器参数）；`patterns` 是要额外拦的字面串。仓库里的测试和文档一律用占位数据（序列号 `SERIALAAAA1`、手机名「小明的手机」、地址 `192.0.2.10`）。
- **新克隆后先启用提交钩子**：`git config core.hooksPath .githooks`。钩子跑 `tools/privacy_scan.py --staged`。
- **第三方文件清单** `.privacy-scan-thirdparty`（进 git）：npm 锁文件、Chromium 许可证汇总、随包分发的 scrcpy、改了名的 Electron 本体。这些只查密钥和身份，不查任意邮箱和路径。只放别人的东西。
- 作者和提交身份统一用公开身份 `maki`（GitHub 匿名邮箱），不要写本机用户名或真实邮箱。
- `tools/privacy_scan.py` 是 `~/.claude/skills/release-isolation/` 原件的拷贝，改规则先改原件再同步。

## 打包

`npm run dist`：先跑测试，再用 electron-builder 出 `release/` 下的 .deb 和 AppImage。只打包 `dist/`、`assets/`、`package.json`（运行时没有 npm 依赖）。
- .deb 是主推：安装后 chrome-sandbox 由 postinst 设成 root 4755，在限制用户命名空间的 Ubuntu 上无需 AppArmor 规则即可运行。`recommends` adb、nmap；不依赖系统 scrcpy（软件源版本常常太旧）。
- AppImage 需要 libfuse2，且在限制用户命名空间的系统上同样会遇到沙箱问题，只作备用。
- 窗口/托盘图标路径是 `__dirname/../../assets`，打包后同样成立，改目录结构时注意。
- 许可证 MIT（0.1.0 开发期间曾是 GPL-3.0-or-later，公开前改为 MIT）。scrcpy（Apache-2.0）/adb 只作为独立进程调用，Windows 版随包分发 scrcpy 时要带上它的 LICENSE。

## 开发用截图

```bash
CHICHI_SNAPSHOT=/tmp/x.png CHICHI_SNAPSHOT_CLICK='#tab-settings|#sub-audio' npx electron . --user-data-dir=/tmp/pa-test
```

加载完成后按顺序点击 `|` 分隔的 CSS 选择器，再截图并退出（`snapshotAndQuit`）。配合 `--user-data-dir` 可以用测试配置，不碰真实配置。

## 已知技术债

- 额外 scrcpy 参数按空白切分，不支持带空格的参数值。
- 没有真正的窗口聚焦：已打开的应用再次点击只会提示，没法把 SDL 窗口提到前台。
- 界面没有自动化测试，只有纯函数测试。
