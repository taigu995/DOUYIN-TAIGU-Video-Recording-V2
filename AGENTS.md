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
