# AGENTS.md - 抖音直播录制工具V2

## 项目概览

基于 Electron 的抖音直播录制桌面工具，采用**流媒体直录 + 离屏评论区渲染**架构，实现高质量音视频录制并拼接右侧评论区弹幕和礼物特效，支持 Windows 系统。

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
- 加载直播页面后注入 CSS，仅显示右侧评论区（弹幕+礼物特效）
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
- 文件名格式: [主播名称]_[年-月-日-时-分-秒].mp4
- 支持粘贴抖音分享文本，自动提取链接和主播名
- 录制结束后需要合并处理，期间会显示"合并中..."状态
- 合并过程需要重新编码视频（CRF 15），音频直接复制
- 评论区帧率默认 10fps（评论区不需要高帧率）
