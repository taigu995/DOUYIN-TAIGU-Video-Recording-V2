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
