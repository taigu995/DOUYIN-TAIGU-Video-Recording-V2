/**
 * 左侧面板渲染器 V2
 * 
 * 复用评论区渲染器的捕获方法，但捕获左侧特效区
 * 在同一个离屏窗口中，同时裁剪左侧特效区和右侧评论区
 */

const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const config = require('./config');

// 左侧面板 CSS 注入脚本：隐藏评论区，显示左侧面板
const LEFT_PANEL_SCRIPT = `
(function() {
  if (window.__leftPanelInjected) return 'already';
  window.__leftPanelInjected = true;

  // 设置 body 背景色
  document.body.style.backgroundColor = '#0f0f0f';
  document.documentElement.style.backgroundColor = '#0f0f0f';

  // 隐藏视频播放器和右侧评论区
  const style = document.createElement('style');
  style.textContent = \`
    body { background: #0f0f0f !important; overflow: hidden !important; }
    * { pointer-events: none !important; }

    /* 隐藏视频播放器区域 */
    [class*="player"],
    [class*="video"],
    [id*="player"],
    [class*="Player"],
    [class*="Video"] {
      display: none !important;
    }

    /* 隐藏右侧评论区 */
    [class*="webcast-chatroom"],
    [id*="chatroom"],
    [class*="ChatRoom"],
    [class*="chat-room"] {
      display: none !important;
    }

    /* 显示左侧面板 */
    [class*="LeftPanel"],
    [class*="left-panel"],
    [class*="LeftSide"],
    [class*="left-side"],
    [class*="RoomInfo"],
    [class*="room-info"],
    [class*="UserInfo"],
    [class*="user-info"] {
      display: block !important;
      position: fixed !important;
      left: 0 !important;
      top: 0 !important;
      width: 384px !important;
      height: 100vh !important;
      z-index: 99999 !important;
      background: #0f0f0f !important;
      overflow-y: auto !important;
      overflow-x: hidden !important;
    }
  \`;
  document.head.appendChild(style);

  return 'injected';
})();
`;

// 左侧面板心跳检测脚本
const LEFT_PANEL_HEARTBEAT_SCRIPT = `
(function() {
  if (window.__leftPanelHeartbeat) return 'already';
  window.__leftPanelHeartbeat = true;

  function findLeftPanelRoot() {
    // 方法1：通过评论区容器的前一个兄弟元素找左侧面板
    const commentSelectors = [
      '[class*="webcast-chatroom"]',
      '[id*="chatroom"]',
      '[class*="ChatRoom"]',
      '[class*="chat-room"]'
    ];

    let commentRoot = null;
    for (const sel of commentSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        commentRoot = el;
        break;
      }
    }

    if (commentRoot && commentRoot.previousElementSibling) {
      const leftPanel = commentRoot.previousElementSibling;
      if (leftPanel) {
        return { found: true, method: 'previousSibling', element: leftPanel };
      }
    }

    // 方法2：直接查找左侧面板容器
    const leftPanelSelectors = [
      '[class*="LeftPanel"]',
      '[class*="left-panel"]',
      '[class*="LeftSide"]',
      '[class*="left-side"]',
      '[class*="RoomInfo"]',
      '[class*="room-info"]',
      '[class*="UserInfo"]',
      '[class*="user-info"]'
    ];

    for (const sel of leftPanelSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        return { found: true, method: 'direct', element: el };
      }
    }

    return { found: false, method: 'none', element: null };
  }

  setInterval(() => {
    const result = findLeftPanelRoot();
    if (!result.found) {
      console.warn('[LeftPanelHeartbeat] 左侧面板容器未找到');
    } else {
      console.log('[LeftPanelHeartbeat] 左侧面板容器存在 (method:', result.method, ')');
    }
  }, 5000);

  return 'installed';
})();
`;

class LeftPanelRendererV2 {
  constructor(roomUrl, fps = 5) {
    this.roomUrl = roomUrl;
    this.fps = fps;
    this.captureWindow = null;
    this.captureTimer = null;
    this.frameDir = null;
    this.frameIndex = 0;
    this.isRunning = false;
    this.debugDir = null;
    this._leftPanelRect = null;
    this._commentRect = null;
    this._isDestroyed = false;
  }

  async init() {
    logger.info(`[LeftPanelRendererV2] 初始化: ${this.roomUrl}`);

    // 创建帧保存目录
    this.frameDir = path.join(config.get('outputPath'), '.temp', 'left_panel');
    this.debugDir = path.join(config.get('outputPath'), '.temp', 'debug');
    fs.mkdirSync(this.frameDir, { recursive: true });
    fs.mkdirSync(this.debugDir, { recursive: true });

    // 创建离屏窗口
    this.captureWindow = new BrowserWindow({
      width: 1920,
      height: 1040,
      show: false,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:douyin'
      }
    });

    // 强制刷新页面，忽略缓存
    logger.info('[LeftPanelRendererV2] 强制刷新页面...');
    try {
      await this.captureWindow.loadURL(this.roomUrl);
    } catch (e) {
      logger.warn('[LeftPanelRendererV2] 页面加载异常:', e.message);
    }

    // 等待页面渲染
    logger.info('[LeftPanelRendererV2] 等待页面渲染...');
    await new Promise((r) => setTimeout(r, 10000));

    // 注入 CSS 隐藏评论区，显示左侧面板
    try {
      const injectResult = await this.captureWindow.webContents.executeJavaScript(LEFT_PANEL_SCRIPT);
      logger.info('[LeftPanelRendererV2] CSS 注入完成:', injectResult);
    } catch (e) {
      logger.warn('[LeftPanelRendererV2] CSS 注入失败:', e.message);
    }

    // 等待 CSS 生效
    await new Promise((r) => setTimeout(r, 2000));

    // DOM 探测左侧面板位置
    let detectedRect = await this._detectLeftPanelAreaFromDOM();
    if (detectedRect) {
      logger.info(`[LeftPanelRendererV2] DOM探测成功: x=${detectedRect.x}, y=${detectedRect.y}, w=${detectedRect.width}, h=${detectedRect.height}`);
    } else {
      logger.warn('[LeftPanelRendererV2] DOM探测失败，尝试估算区域');
    }

    // 捕获页面尺寸
    let capturedSize = { width: 1920, height: 1040 };
    try {
      const probeImage = await this.captureWindow.webContents.capturePage();
      capturedSize = probeImage.getSize();
      logger.info(`[LeftPanelRendererV2] 页面捕获尺寸: ${capturedSize.width}x${capturedSize.height}`);
    } catch (e) {
      logger.warn('[LeftPanelRendererV2] 页面尺寸探测失败，使用默认值:', e.message);
    }

    // 计算裁剪区域
    if (detectedRect && detectedRect.width > 80 && detectedRect.height > 100) {
      // DOM 探测成功
      this._leftPanelRect = {
        x: detectedRect.x,
        y: 0,
        width: detectedRect.width,
        height: capturedSize.height
      };
    } else {
      // 回退：估算左侧区域（384px 宽）
      this._leftPanelRect = {
        x: 0,
        y: 0,
        width: 384,
        height: capturedSize.height
      };
    }
    logger.info(`[LeftPanelRendererV2] 左侧面板裁剪区域: x=${this._leftPanelRect.x}, y=${this._leftPanelRect.y}, w=${this._leftPanelRect.width}, h=${this._leftPanelRect.height}`);

    // 保存调试截图
    try {
      const debugImage = await this.captureWindow.webContents.capturePage();
      const debugPath = path.join(this.debugDir, 'debug_left_panel_full_page.png');
      fs.writeFileSync(debugPath, debugImage.toPNG());
      logger.info(`[LeftPanelRendererV2] 完整页面截图已保存: ${debugPath}`);

      const r = this._leftPanelRect;
      const safeW = Math.min(r.width, capturedSize.width - r.x);
      const safeH = Math.min(r.height, capturedSize.height - r.y);
      if (safeW > 0 && safeH > 0) {
        const leftPanelCrop = await this.captureWindow.webContents.capturePage({
          x: r.x, y: r.y, width: safeW, height: safeH
        });
        const leftPanelPath = path.join(this.debugDir, 'debug_left_panel_area.png');
        fs.writeFileSync(leftPanelPath, leftPanelCrop.toPNG());
        logger.info(`[LeftPanelRendererV2] 左侧面板截图已保存: ${leftPanelPath}`);
      }
    } catch (e) {
      logger.warn('[LeftPanelRendererV2] 调试截图保存失败:', e.message);
    }

    // 注入心跳检测脚本
    try {
      const heartbeatResult = await this.captureWindow.webContents.executeJavaScript(LEFT_PANEL_HEARTBEAT_SCRIPT);
      logger.info('[LeftPanelRendererV2] 心跳检测脚本注入结果:', heartbeatResult);
    } catch (e) {
      logger.warn('[LeftPanelRendererV2] 心跳检测脚本注入失败:', e.message);
    }

    logger.info('[LeftPanelRendererV2] 初始化完成');
  }

  async _detectLeftPanelAreaFromDOM() {
    try {
      const script = `
        (function() {
          // 方法1：通过评论区容器的前一个兄弟元素找左侧面板
          const commentSelectors = [
            '[class*="webcast-chatroom"]',
            '[id*="chatroom"]',
            '[class*="ChatRoom"]',
            '[class*="chat-room"]'
          ];

          let commentRoot = null;
          for (const sel of commentSelectors) {
            const el = document.querySelector(sel);
            if (el) {
              commentRoot = el;
              break;
            }
          }

          if (commentRoot && commentRoot.previousElementSibling) {
            const leftPanel = commentRoot.previousElementSibling;
            const rect = leftPanel.getBoundingClientRect();
            return {
              found: true,
              method: 'previousSibling',
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height
            };
          }

          // 方法2：直接查找左侧面板容器
          const leftPanelSelectors = [
            '[class*="LeftPanel"]',
            '[class*="left-panel"]',
            '[class*="LeftSide"]',
            '[class*="left-side"]',
            '[class*="RoomInfo"]',
            '[class*="room-info"]',
            '[class*="UserInfo"]',
            '[class*="user-info"]'
          ];

          for (const sel of leftPanelSelectors) {
            const el = document.querySelector(sel);
            if (el) {
              const rect = el.getBoundingClientRect();
              return {
                found: true,
                method: 'direct',
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height
              };
            }
          }

          return { found: false, method: 'none', x: 0, y: 0, width: 0, height: 0 };
        })();
      `;

      const result = await this.captureWindow.webContents.executeJavaScript(script);
      if (result && result.found && result.width > 80 && result.height > 100) {
        return {
          x: Math.round(result.x),
          y: Math.round(result.y),
          width: Math.round(result.width),
          height: Math.round(result.height)
        };
      }
    } catch (e) {
      logger.warn('[LeftPanelRendererV2] DOM探测异常:', e.message);
    }
    return null;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.frameIndex = 0;

    logger.info('[LeftPanelRendererV2] 开始捕获左侧面板帧');

    const interval = 1000 / this.fps;
    this.captureTimer = setInterval(async () => {
      if (this._isDestroyed || !this.captureWindow || this.captureWindow.isDestroyed()) {
        return;
      }

      try {
        const r = this._leftPanelRect;
        const image = await this.captureWindow.webContents.capturePage({
          x: r.x, y: r.y, width: r.width, height: r.height
        });

        const framePath = path.join(this.frameDir, `left_frame_${String(this.frameIndex).padStart(6, '0')}.jpg`);
        fs.writeFileSync(framePath, image.toJPEG(85));
        this.frameIndex++;
      } catch (e) {
        logger.warn('[LeftPanelRendererV2] 帧捕获失败:', e.message);
      }
    }, interval);
  }

  async stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }

    logger.info(`[LeftPanelRendererV2] 停止捕获，共 ${this.frameIndex} 帧`);
  }

  async destroy() {
    this._isDestroyed = true;
    await this.stop();

    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      this.captureWindow.destroy();
    }
    this.captureWindow = null;

    logger.info('[LeftPanelRendererV2] 已销毁');
  }

  getFramesDir() {
    return this.frameDir;
  }

  getFrameCount() {
    return this.frameIndex;
  }
}

module.exports = LeftPanelRendererV2;
