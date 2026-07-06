# AGENTS.md - 抖音直播录制工具

## 项目概览

基于 Electron 的抖音直播录制桌面工具，可自动录制直播间画面（含弹幕和礼物特效），支持 Windows 系统。

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
│       ├── recorder.js         # 录制引擎 (离屏渲染+FFmpeg)
│       └── stream-manager.js   # 直播间生命周期管理
├── package.json
└── .coze
```

## 核心模块

### 录制引擎 (src/lib/recorder.js)
- 使用 Electron 离屏渲染 (offscreen: true) 创建隐藏 BrowserWindow
- 通过 `webContents.capturePage()` 循环捕获帧
- 使用 FFmpeg 将原始 RGBA 帧编码为 H.264 MP4
- 捕获完整渲染输出：视频画面 + 弹幕 + 礼物特效

### 直播间管理 (src/lib/stream-manager.js)
- 解析分享链接/短链接，提取房间ID
- 创建监控窗口定时检测直播状态
- 自动识别主播名称
- 检测到开播自动开始录制

### 配置管理 (src/lib/config.js)
- 使用 electron-store 持久化
- 配置项：输出路径、检测间隔、帧率、自动录制等

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
- 录制文件默认保存到 用户视频/抖音直播录制/ 目录
- 文件名格式: [主播名称]_[年-月-日-时-分-秒].mp4
- 支持粘贴抖音分享文本，自动提取链接和主播名
