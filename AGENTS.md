# AGENTS.md - 抖音直播录制工具V2

## 项目概览

基于 Electron 的抖音直播录制桌面工具，采用**流媒体直录 + 离屏评论区渲染**架构，实现高质量音视频录制并拼接右侧评论区弹幕，支持 Windows 系统。

## 技术栈

- **运行时**: Electron 33+
- **语言**: JavaScript (Node.js)
- **录制引擎**: FFmpeg (通过 @ffmpeg-installer/ffmpeg 内置)
- **配置存储**: electron-store
- **构建打包**: electron-builder (NSIS 安装包)

## 目录结构

```
.
├── main.js                     # Electron 主进程入口
├── preload.js                  # 预加载脚本 (IPC桥接)
├── src/
│   ├── index.html              # 主界面
│   ├── styles.css              # 样式 (暗色主题)
│   ├── renderer.js             # UI逻辑
│   └── lib/
│       ├── config.js           # 配置管理 (electron-store)
│       ├── douyin-utils.js     # 抖音链接解析工具
│       ├── recorder.js         # 录制引擎 (流媒体直录+评论区拼接)
│       ├── comment-renderer.js # 评论区离屏渲染器
│       └── stream-manager.js   # 直播间生命周期管理
├── package.json
└── .coze
```

## 核心架构

### 录制流程（两阶段）

```
Phase 1 (录制中):
  直播流URL → FFmpeg (stream copy) → temp_stream.mp4 (高质量音视频)
  直播间页面 → Electron离屏窗口 → 仅渲染右侧评论区 → JPEG帧序列

Phase 2 (录制结束后):
  temp_stream.mp4 + comment_frames/ → FFmpeg overlay → final.mp4
  布局: [Stream 1280x720 | Comment 360x720] = 1640x720
```

### 录制引擎 (src/lib/recorder.js)
- **流媒体直录**: 通过 FFmpeg stream copy 直接录制直播流，保留原始音视频质量
- **音频同步**: 音频直接从直播流复制，天然与视频同步
- **直播流获取**: 优先通过抖音API获取，回退到页面DOM解析
- **合并输出**: 录制结束后使用 FFmpeg overlay 滤镜拼接评论区

### 评论区渲染器 (src/lib/comment-renderer.js)
- 使用 Electron 离屏渲染 (offscreen: true) 创建隐藏 BrowserWindow
- 加载直播页面后注入 CSS，仅显示右侧评论区（弹幕）
- 通过 `webContents.capturePage()` + crop 裁剪到评论区区域
- 帧保存为 JPEG 文件序列，供后续 FFmpeg 合并

### 直播间管理 (src/lib/stream-manager.js)
- 解析分享链接/短链接，提取房间ID
- 创建监控窗口定时检测直播状态
- 自动识别主播名称
- 检测到开播自动开始录制
- 支持 merging 状态（合并中）

### 配置管理 (src/lib/config.js)
- 使用 electron-store 持久化
- 配置项：输出路径、检测间隔、评论区宽度/高度/帧率/JPEG质量、合并CRF/预设等

## 构建命令

```bash
# 安装依赖
pnpm install

# 开发模式运行 (需要桌面环境)
pnpm run dev

# 打包 Windows EXE
pnpm run build

# 打包为目录 (不生成安装包)
pnpm run build:dir
```

## 注意事项

- 首次使用需点击"登录抖音"按钮登录账号
- 录制文件默认保存到 用户视频/抖音直播录制工具V2/ 目录
- 文件名格式: 主播名称_年-月-日_时-分-秒.mp4
- 支持粘贴抖音分享文本，自动提取链接和主播名
- 录制结束后需要合并处理，期间会显示"合并中..."状态
- 合并过程需要重新编码视频（CRF 15），音频直接复制
- 评论区帧率默认 10fps（评论区不需要高帧率）
- 评论区容器选择器必须三处同步：init DOM探测/注入脚本内嵌探测（`[class*="webcast-chatroom"]` 等）与心跳 `findCommentRoot()`（comment-renderer.js 约92行）。当前抖音评论区容器 class 为 `webcast-chatroom-*`；心跳选择器若缺少它会导致每5秒误报"容器未找到"，60秒后误触发自愈刷新把正常页面刷坏（v2.12.10 修复）
- 每次开播录制 init 时会先 `reloadIgnoringCache()` 强制刷新评论页面再探测捕捉（v2.12.11），规避 session/磁盘缓存中的"直播已结束"旧快照；此过程增加约10-30秒评论区初始化延迟（FFmpeg流录制不受影响）
- 流时间戳损坏检测（v2.12.12）：FFmpeg stderr 的 `Non-monotonous DTS` 警告分两形态处理——①current 为负或回退超一半=时间轴回绕，累计3次 kill 重录；②视频轨(0:0) current==previous 连续60次(约2分钟)=视频轨停滞（画面卡死但 frame= 仍涨、停滞看门狗检不出），kill 重录。两类警告及 `Application provided duration`/`invalid dropping`/`pts has no value`/`changing to` 拆行等时间戳噪声统一计数+60秒汇总一条日志（逐条写曾致单场140万行/300MB）；导出过滤同步 DROP 这些模式
- Merge-Final 合并输入带 `-fflags +discardcorrupt`（v2.12.12）：源流含损坏段时丢弃坏帧完成合并，避免解码失败（Conversion failed）后兜底标准化用纯流覆盖输出导致评论区丢失；合并失败兜底时录制完成报告显示"合并失败(已保留源视频...)"而非误导性的"合并: true"
- 评论页 init 挂起防护（v2.12.13）：强制刷新/DOM探测的 executeJavaScript 在页面导航 pending 时会无限挂起（Electron 特性），曾致整场录制无任何文件且残留 .temp 空目录。防护：①强制刷新 20s 超时后必须 `webContents.stop()` 终止挂起导航；②`_detectCommentAreaFromDOM` executeJavaScript 加 8s race 超时；③Recorder 新增 `_startingUp` 标志（startRecording 入口置位、FFmpeg 启动成功/失败清除），stopRecording 与下播分支（API/页面两处）识别 `_startingUp` 走取消清理（destroy 窗口→挂起点 reject→startRecording catch 统一清空文件夹）；④`_autoStartRecording` 摘离旧实例时，`_startingUp` 实例直接 destroy 而非转入 mergingRecorder
- stream-only 模式流提取超时防护（v2.12.14）：`_getStreamUrlWithoutRenderer` 加 60 秒总超时 race，避免临时窗口 loadURL/executeJavaScript 永久挂起；临时窗口注册到 `this._tempStreamWin`，`_cleanup` 统一销毁
- 合并命令改用 `-fflags +genpts`（v2.12.15）：源视频在某个时间点画面卡住（但单文件播放正常）的问题是 `+discardcorrupt` 丢弃了损坏帧导致后续视频轨无帧输出；`+genpts` 自动修复时间戳异常而不丢弃帧，保证画面连续
- 合并命令加 `-err_detect ignore_err`（v2.12.16）：源视频含损坏帧时 FFmpeg 解码失败后停止输出视频帧（画面卡住），`ignore_err` 让解码器忽略错误继续处理后续帧，保证画面连续
- 删除礼物横幅功能（v2.12.17）：礼物横幅（GiftBanner）功能从未实际生效，删除以减少代码臃肿。删除内容包括：GIFT_BANNER_SCRIPT/GIFT_DETECT_SCRIPT 注入脚本、injectGiftBanner/injectExternalGift/_showExternalBanner 方法、_startGiftDetection/_stopGiftDetection 检测轮询、GiftStream WS 礼物流模块、giftHoldMs/giftCheckMs 配置项。保留评论区心跳检测（HEARTBEAT_SCRIPT）用于容器缺失自愈刷新
- 强制刷新超时后增加渲染等待（v2.12.18）：强制刷新 20s 超时后 `stopLoading()` 终止挂起导航，但页面可能还在渲染中，后续 `capturePage()` 捕获的是黑屏帧（曾致整场弹幕区全黑）。修复：超时后额外等待 5s 确保页面渲染完成再初始化
- 评论区实时显示录制时间（v2.12.19）：在评论区顶部注入时间戳显示脚本，实时显示当前录制日期时间（格式：YYYY-MM-DD HH:MM:SS），每秒更新一次。时间戳显示在评论区最顶部，固定定位，半透明黑色背景，白色等宽字体，不影响弹幕内容。init 和自愈刷新后均会注入
- 时间戳显示位置修复（v2.12.20）：时间戳元素从 body 改为插入到评论区容器内部（webcast-chatroom），使用 sticky 定位确保在评论区顶部显示，避免被其他元素遮挡
- 主播名称末尾点号处理（v2.12.21）：主播名称末尾的点号（如"小孤独."）会导致 FFmpeg 输出文件路径解析失败（No such file or directory），safeName 增加 `.replace(/\.$/, '_')` 将末尾点号替换为下划线
- 启动失败熔断机制优化（v2.12.22）：将触发熔断的连续失败次数从 3 次放宽至 20 次，熔断等待时间从 5 分钟缩短至 1 分钟。避免偶发性直播流 URL 过期（HTTP 404）导致长时间无法自动重录
- 视频轨停滞优化（v2.12.23）：检测到视频轨停滞（DTS 连续 60 次无进展）时，先尝试重新获取直播流 URL（可能是 URL 过期导致），用新 URL 重启 FFmpeg 进程（在同一个场次内，不触发 stream-interrupted），避免场次分割。仅当重新获取 URL 失败时才强制重启录制
- 视频轨停滞 URL 刷新逻辑修正（v2.12.24）：移除多余的 `_currentStreamUrl` 变量，统一使用 `_streamUrl`，确保 FFmpeg 重启时使用新的直播流 URL
- 合并延迟优化（v2.12.25）：直播结束后延迟 5 分钟再开始合并视频，防止直播流中断后重新获取流时造成卡顿
- 合并视频源画面提前播完修复（v2.12.26）：源视频因直播流中断被分成多个片段，总时长比评论区视频短，导致合并后的视频中源画面提前播完。修复：合并前检测源视频和评论区视频的时长差，如果源视频比评论区视频短超过 1 秒，使用 tpad 滤镜在源视频末尾添加黑屏帧补偿时长
- 弹幕区持续显示直播已结束修复（v2.12.26）：评论区初始化时，捕获的帧一直是"直播已结束"的状态。修复：①增加初始化等待时间从 8s 到 10s；②DOM 探测成功后，验证评论区容器是否有内容，无内容则等待 5s 后重新检测；③快速刷新重试的等待时间从 8s 增加到 10s
- 连续两次未开始录制修复（v2.12.26）：FFmpeg 在尝试下载直播流时收到 Unknown error 错误，导致录制失败。修复：启动 FFmpeg 录制前，先验证直播流 URL 是否有效（通过 HEAD 请求快速验证），如果无效则尝试重新获取直播流 URL（最多重试 2 次）
- 未录制未捞取调试截图修复（v2.12.26）：评论区初始化失败，导致录制没有开始。修复：增加评论区初始化的整体超时时间从 150s 到 180s，添加更多的调试日志（加载超时设置、加载失败详情等）
- 直播间改名称后管理列表同步更新（v2.12.26）：检测到直播间名称变更时，自动更新管理列表中的名称。修复：在 checkLiveStatus 和 _checkLiveStatusFromPage 方法中，检测到名称变更时更新管理列表并记录日志
- 新增左侧信息面板（特效区）捕获功能（v2.13.0）：在有账号录制选项中增加"有账号+评论区+特效区"录制模式，可同时捕获左侧信息面板（主播信息、礼物榜、观众列表等）。新增 LeftPanelRenderer 类用于离屏渲染左侧信息面板，修改合并逻辑支持三区域拼接（左侧面板+直播画面+评论区）。新增录制模式 'stream+comment+effect'，UI界面已添加对应选项
- 修复左侧面板帧文件名不匹配问题（v2.13.0）：左侧面板帧文件名前缀为 `left_frame_`，但合并逻辑中使用 `frame_%06d.jpg` 模式匹配，导致无法找到左侧面板帧。修复：①`_finishRecording` 方法中检查左侧面板帧文件时使用 `left_frame_\d{6}\.jpg` 正则表达式；②合并逻辑中编码左侧面板视频时使用 `left_frame_%06d.jpg` 作为输入文件模式
- 修复合并进度恢复缺少左侧面板信息问题（v2.13.0）：合并进度保存中缺少左侧面板信息，导致合并恢复时无法获取左侧面板数据。修复：①`_saveMergeProgress` 方法中添加 `leftPanelFramesDir` 和 `leftPanelInfo` 字段；②合并恢复逻辑中恢复左侧面板信息并传递给 `_mergeStreamAndComments` 方法
- 修复评论区黑屏直播已结束问题（v2.13.1）：强制刷新页面超时后，页面可能还在渲染中，导致捕获到的是"直播已结束"的界面。修复：①将评论区容器无内容的等待时间从 5 秒增加到 8 秒；②将快速刷新重试次数从 2 次增加到 3 次，等待时间从 10 秒增加到 15 秒
- 修复"有账号+评论区+特效区"模式下无法录制问题（v2.13.2）：评论区渲染器初始化失败导致录制无法开始。修复：①在 recorder.js 中添加 commentRenderer 为 null 的检查；②在 commentRenderer 初始化失败时回退到纯直播流模式；③在 left-panel-renderer.js 中添加 body 背景色设置
- 手动停止录制时立即合并视频（v2.13.2）：当手动点击"停止录制"按钮时，立即开始合并视频，不再等待 5 分钟。修复：在 recorder.js 中添加 `_isManualStop` 标志，手动停止时跳过 5 分钟合并延迟
- 修复左侧面板捕获黑屏问题（v2.13.3）：左侧面板渲染器使用与评论区相同的捕获方法，通过评论区容器的前一个兄弟元素找到左侧面板，并添加更多选择器支持。修复：①修改 `_detectLeftPanelAreaFromDOM` 方法，优先通过评论区容器的前一个兄弟元素找到左侧面板；②修改心跳检测脚本，使用相同的左侧面板容器查找逻辑
- 修复左侧面板捕获黑屏问题（v2.13.4）：左侧面板渲染器的DOM探测失败，使用了估算区域导致捕获到黑屏。修复：修改 `_detectLeftPanelAreaFromDOM` 方法，使用与评论区渲染器相同的捕获方法，通过评论区容器找到左侧面板
- 重构左侧面板渲染器（v2.13.5）：创建 LeftPanelRendererV2，完全复用评论区渲染器的捕获逻辑，在同一个离屏窗口中同时捕获评论区和左侧面板。修复：①使用与评论区渲染器相同的窗口创建和页面加载逻辑；②DOM探测时优先通过评论区容器的前一个兄弟元素找左侧面板；③添加更多左侧面板选择器支持（LeftPanel、LeftSide、RoomInfo、UserInfo等）；④CSS注入时隐藏视频播放器和评论区，显示左侧面板
- 修复左侧面板渲染器 logger 导入错误（v2.13.6）：left-panel-renderer-v2.js 中 logger 导入方式不正确导致初始化失败。修复：将 `const logger = require('./logger')` 改为 `const { getLogger } = require('./logger'); const logger = getLogger()`，与其他文件保持一致
- 修复左侧面板渲染器 config 导入错误（v2.13.7）：left-panel-renderer-v2.js 中 config 导入方式不正确导致初始化失败。修复：将 `config.get('outputPath')` 改为 `getConfig('outputPath')`，正确使用 config 模块导出的函数
- 修复左侧面板渲染器 getConfig 使用错误（v2.13.8）：left-panel-renderer-v2.js 中 getConfig() 使用方式不正确导致初始化失败。修复：将 `getConfig('outputPath')` 改为 `getConfig().outputFolder`，正确获取配置对象属性
- 修复左侧面板调试截图保存路径错误（v2.13.9）：调试截图保存在全局临时目录 `.temp\debug\`，而不是录制文件夹中。修复：①LeftPanelRendererV2 构造函数添加 `debugDir` 参数；②recorder.js 中传递 `path.dirname(this.outputFile)` 作为调试目录
- 左特效区捕获改为复用评论区同一窗口同时裁剪（v2.13.10）：独立 LeftPanelRenderer 窗口因页面加载状态/布局一致性差，左侧特效区 DOM 探测持续失败导致捕获黑屏、left-panel 帧为空。抖音竖屏直播页面为左-中-右三栏（左侧公屏聊天+礼物栏 / 中间视频 / 右侧评论区）。修复：移除 coordinator 对 LeftPanelRendererV2 的独立初始化，改在 CommentRenderer（已正常工作的离屏窗口）中：①新增 enableLeftPanel/leftPanelOutputDir 配置，同一 `capturePage()` 帧分别裁剪评论区（右）与左侧特效区（左）；②新增 `_detectLeftPanelAreaFromDOM`（先找评论区、沿其左侧兄弟链取非视频节点，回退页面左侧最大可见div）；③左侧帧以 `left_frame_%06d.jpg` 写入 `.temp/left-panel/`，与评论区同 FPS；④stopCapture 返回 leftPanelInfo；⑤recorder.js 从 commentInfo.leftPanelInfo 取得左特效区信息用于三区域合并
- 修复左侧特效区截取范围过宽问题（v2.13.11）：`_detectLeftPanelAreaFromDOM` 的 `largest-left-div` 策略误选中包裹"左侧弹幕区+中间直播画面"的大容器（x=0, w=1517），导致左特效区把中间直播画面也截进去。修复：①新增 `video-left-bound` 优先策略——取页面中面积最大的 video/canvas（即中间直播主画面）的左边界作为左侧特效区右边界，最精确；②所有策略统一加宽度上限 `maxLeftW = min(评论区宽*1.4, 页面宽*0.34)`，防止任何策略把中间直播画面包进左特效区；③`video-left-bound` 超上限时按上限收敛
- 修复三区域合并中间源视频画面黑屏（v2.13.12，根本原因）：filter_complex 中 `[lp_sep][stream]overlay=${leftPanelScaleW + separatorW}:0` 的 overlay 滤镜**不会自动扩展画布**。此时画布宽仅 `leftPanelW + separatorW`（约562px），把 stream（608px宽）叠加到 x=562 完全落在画布外被丢弃，之后才 `pad` 扩展画布但 stream 已丢失，中间只剩黑色背景。双区域合并正常是因为先把 stream `pad` 到全宽再 overlay 评论区。修复：改为先把 leftpanel `pad` 到全宽 `totalWithSep`，再在全宽画布上依次 overlay stream 和 comments（参考双区域正确写法），needsPadding 与无 padding 两处三区域分支同步修复
- 修复 `Recorder._getFFmpegPath is not a function`（v2.13.12）：`_mergeStreamAndCommentFiles`(实例)与 `_getMediaDuration`(静态) 调用 `this._getFFmpegPath()`/`Recorder._getFFmpegPath()`，但该方法从未定义（仅 30 行有模块级 `getFFmpegPath()`），导致探测源视频时长失败回退墙钟估算、进度条失真。修复：两处统一改用模块级 `getFFmpegPath()`
- 修复左特效区误捕获视频画面（v2.13.12，根本原因）：抖音直播播放器用 **Shadow DOM** 封装，`document.querySelectorAll('video, canvas')` 与 `div.querySelector('video')` 均查不到内部视频元素，导致 `video-left-bound` 找不到视频而失效、`largest-left-div` 的视频排除也失效，最终误选中包含视频的大容器。修复 `_detectLeftPanelAreaFromDOM`：①新增 `collectMedia`/`containsMediaDeep` 穿透 Shadow DOM 递归探测视频/画布；②`video-left-bound` 改用穿透结果，视频几乎占满左侧（vLeft<100，该直播间左侧无独立特效区）时返回 width=0 触发上层禁用特效区（`_leftPanelRect=null`，自动回退双区域录制）；③`largest-left-div` 改为按文字密度优选（弹幕区文字多且紧凑），穿透排除视频容器并要求 innerText≥15 字，避免大面积视频背景容器胜出
- 新增特效区单独视频留存（v2.13.12）：与评论区 `_comments.mp4` 一致，录制结束合并后把 `left_panel_video.mp4` 复制为 `${baseName}_effect.mp4` 保存到输出目录（`_saveIntermediateFiles`，仅三区域模式下生成）
- 团播直播间团员榜单自动展开（v2.13.13）：团播直播间左侧特效区左上角有折叠的"团员榜单 >"，默认折叠只显示榜首摘要。新增 `MEMBER_RANK_EXPAND_SCRIPT` 注入脚本（`comment-renderer.js`，与时间戳/心跳脚本同一注入通道）：①文本定位"团员榜单"触发元素（取最内层含该文本的元素，避免误点包裹大容器，不匹配"本场成员"）；②hover+click 展开，带防跳转回退（click 引发导航则 history.back()）；③`findPanel` 判定榜单面板是否已展开（含"团员榜单"文本且高度≥120或含≥2个团员头像的最内层可见容器），`panelRef` 缓存引用；④定时器每 4s 检测，收起则重新展开，点击冷却 8s 防止 toggle 高频展开收起。仅在特效区模式（enableLeftPanel）下注入，init 与自愈刷新两处注入点均覆盖（刷新后页面脚本丢失需重注入）
- 新增"有账号+评论区+特效区+团播榜单"录制模式（v2.13.14）：团播直播间"团员榜单"展开后是**居中模态弹窗**（紧邻评论区左侧、覆盖中间视频区），并非在左侧特效区内联展开，v2.13.13 的特效区内展开思路作废。新模式 `stream+comment+effect+rank` 承接特效区框架，核心是**扩宽评论区捕获区域**把展开榜单一并录进右侧：①`RANK_PANEL_SCRIPT`（comment-renderer.js）穿透 Shadow DOM 定位"团员榜单"触发器（collectAll 递归 shadowRoot，修复 v2.13.13 普通 querySelector 查不到导致的 trigger_not_found），hover+click 展开、防跳转 history.back、8s 点击冷却防 toggle，每 2s 保持展开并把面板 rect 维护到 `window.__rankPanelInfo`；②`CommentRenderer._setupRankPanelMode` 注入脚本→轮询等待展开(12s)→`_applyRankPanelWiden` 按面板 rect 把 `_commentRect.x` 左移到面板左缘、width 相应增大（右缘不变，防呆上限 2.2 倍原宽），非团播/展开失败优雅降级为普通特效区模式不扩宽；③每次该模式录制保存两类调试截图到录制文件夹：`debug_rank_full_page.png`（榜单展开后整体界面）与 `debug_rank_comment_area.png`（榜单+评论区扩宽后单独裁切），供后续调整；④合并逻辑零改动自适应（commentScaleW/totalWidth 由 commentInfo.width 按比例自动计算，扩宽后右侧区域变宽约 1.9 倍）；⑤直播流是 FFmpeg 直录原始流，榜单弹窗遮挡页面中间画面不影响 stream 录制，左侧特效区在页面最左与右侧扩宽无冲突。接入点：index.html 新增第 6 个 radio、renderer.js 卡片下拉+showAccount、stream-manager.js 有账号分支、recorder.js `useLeftPanel`(含 rank)/`useRankPanel`→CommentRenderer `enableRankPanel`
