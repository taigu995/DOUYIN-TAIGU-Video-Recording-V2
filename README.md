# 抖音直播录制工具V2

基于 Electron 的抖音直播录制桌面工具，采用 **流媒体直录 + 离屏评论区渲染** 架构，实现高质量音视频录制并拼接右侧评论区弹幕和礼物特效。

## 功能特性

- **高质量录制**：通过 FFmpeg stream copy 直接录制直播流，保留原始音视频质量，零损耗
- **评论区拼接**：自动捕获直播间右侧评论区（弹幕 + 礼物特效），合成到最终视频右侧
- **智能监控**：支持自动检测直播状态，开播自动录制，下播自动停止
- **多直播间**：同时添加多个直播间，独立监控和录制
- **链接解析**：支持粘贴抖音分享文本，自动提取直播间链接和主播名称
- **断线重录**：直播流中断后自动重新检测，若仍在直播则立即继续录制
- **暗色主题**：现代化暗色 UI，长时间使用不伤眼

## 技术栈

| 技术 | 说明 |
|------|------|
| Electron 33+ | 桌面应用框架 |
| JavaScript (Node.js) | 开发语言 |
| FFmpeg | 录制引擎（通过 @ffmpeg-installer/ffmpeg 内置） |
| electron-store | 配置持久化存储 |
| electron-builder | Windows 打包（NSIS 安装包） |

## 架构设计

### 两阶段录制流程

```
Phase 1 (录制中):
  直播流 URL → FFmpeg (stream copy) → temp_stream.mp4 (原始音视频)
  直播间页面 → Electron 离屏窗口 → DOM 探测评论区 → JPEG 帧序列

Phase 2 (录制结束后):
  temp_stream.mp4 + comment_frames/ → FFmpeg pad + overlay → final.mp4
  布局: [直播画面 | 分隔线 | 评论区]
```

### 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 主进程 | `main.js` | Electron 主进程，IPC 桥接 |
| 预加载脚本 | `preload.js` | 安全暴露 API 给渲染进程 |
| 录制引擎 | `src/lib/recorder.js` | FFmpeg 流录制 + 合并 |
| 评论区渲染器 | `src/lib/comment-renderer.js` | 离屏捕获评论区帧 |
| 直播间管理 | `src/lib/stream-manager.js` | 生命周期管理、状态监控 |
| 配置管理 | `src/lib/config.js` | electron-store 持久化配置 |
| 链接解析 | `src/lib/douyin-utils.js` | 抖音分享链接/短链接解析 |

## 安装与运行

### 环境要求

- Node.js 18+
- Windows 10/11（仅支持 Windows）

### 开发模式

```bash
# 安装依赖
npm install

# 启动开发模式（需要桌面环境）
npm run dev
```

### 打包构建

```bash
# 打包为 Windows 安装包 (NSIS)
npm run build

# 打包为目录（不生成安装包，便于调试）
npm run build:dir
```

打包完成后：
- 安装包：`dist/DouyinLiveRecorder Setup x.x.x.exe`
- 免安装版：`dist/win-unpacked/DouyinLiveRecorder.exe`

## 使用说明

### 基本流程

1. **登录抖音**：首次使用点击「登录抖音」按钮，扫码或账号密码登录
2. **添加直播间**：粘贴抖音分享文本或直播间链接，点击添加
3. **开启自动录制**：点击「自动录制：关」切换为开启状态
4. **等待开播**：系统自动检测直播状态，开播后自动开始录制
5. **手动控制**：也可点击「开始录制」手动启动录制
6. **停止录制**：点击「停止录制」，系统自动合并直播画面和评论区
7. **查看文件**：录制文件保存在 `用户视频/抖音直播录制工具V2/` 目录

### 支持的链接格式

- 抖音分享文本（自动提取链接）：`"xxx正在直播，快来看看... https://v.douyin.com/xxxxx/"`
- 短链接：`https://v.douyin.com/xxxxx/`
- 直播间链接：`https://live.douyin.com/xxxxx`
- 房间号：直接输入数字房间号

### 输出文件

- **保存路径**：`用户视频/抖音直播录制工具V2/主播名称/日期/文件名.mp4`
- **文件命名**：`主播名称_年-月-日_时-分.mp4`
- **视频布局**：`[直播画面 | 2px分隔线 | 评论区]`
- **分辨率**：1080p（根据直播流原始分辨率自适应）

## 配置说明

配置文件位于 `%APPDATA%/douyin-live-recorder/config.json`，可通过应用内设置界面修改：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 输出路径 | 用户视频/抖音直播录制工具V2 | 录制文件保存位置 |
| 检测间隔 | 30s | 直播状态检测间隔 |
| 评论区宽度 | 500px | 评论区捕获宽度 |
| 评论区帧率 | 15fps | 评论区捕获帧率 |
| JPEG 质量 | 92 | 评论区帧压缩质量 |
| 合并 CRF | 15 | 视频编码质量（越小越高质量） |
| 合并预设 | medium | 编码速度预设 |

## 项目结构

```
.
├── main.js                     # Electron 主进程入口
├── preload.js                  # 预加载脚本 (IPC 桥接)
├── src/
│   ├── index.html              # 主界面 HTML
│   ├── styles.css              # 暗色主题样式
│   ├── renderer.js             # UI 逻辑
│   └── lib/
│       ├── config.js           # 配置管理
│       ├── douyin-utils.js     # 抖音链接解析
│       ├── recorder.js         # 录制引擎
│       ├── comment-renderer.js # 评论区离屏渲染器
│       └── stream-manager.js   # 直播间生命周期管理
├── build/
│   └── icon.jpeg               # 应用图标
├── package.json
└── 一键打包.bat                 # Windows 一键打包脚本
```

## 注意事项

- 首次使用需登录抖音账号（点击「登录抖音」按钮）
- 录制结束后需要合并处理，期间显示「合并中...」状态，请勿关闭窗口
- 合并过程需要重新编码视频，耗时取决于视频长度和电脑性能
- 评论区帧率默认 15fps（评论区不需要高帧率，节省资源）
- **多直播间同时录制时，仅能获取其中一个直播间的评论区**（受 Electron 离屏窗口资源限制，建议单直播间录制以获得完整评论区）
- 仅支持 Windows 系统

## 许可证

MIT License
