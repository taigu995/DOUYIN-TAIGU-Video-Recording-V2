/**
 * 左侧信息面板离屏渲染器
 * 使用 Electron 离屏窗口仅渲染直播间左侧信息面板（主播信息、礼物榜、观众列表等）
 * 捕获左侧面板帧用于与流媒体直录视频拼接
 */
const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { getLogger } = require('./logger');

const logger = getLogger();

// 左侧面板渲染配置
const LEFT_PANEL_WIDTH = 400;   // 左侧面板宽度（捕获区域宽度）
const LEFT_PANEL_HEIGHT = 1080; // 左侧面板高度（与主视频对齐）
const CAPTURE_QUALITY = 92;     // JPEG 压缩质量 (1-100)

// 左侧面板心跳检测脚本：每5秒检测左侧面板容器是否存在，用于触发自愈刷新
const HEARTBEAT_SCRIPT = `(() => {
  try {
    if (window.__leftPanelHeartbeatInstalled) return 'already';
    window.__leftPanelHeartbeatInstalled = true;

    // 左侧面板容器定位（选择器必须与主进程 _detectLeftPanelAreaFromDOM 保持同步）
    function findLeftPanelRoot() {
      if (window.__leftPanelRoot && window.__leftPanelRoot.isConnected) return window.__leftPanelRoot;
      const sels = [
        '[class*="webcast-left"]',
        '[class*="left-panel"]',
        '[class*="LeftPanel"]',
        '[class*="anchor-info"]',
        '[class*="AnchorInfo"]',
        '[class*="gift-rank"]',
        '[class*="GiftRank"]',
        '[class*="audience-list"]',
        '[class*="AudienceList"]',
        '[class*="user-list"]',
        '[class*="UserList"]',
        '[class*="side-left"]',
        '[class*="SideLeft"]',
        '[class*="left-side"]',
        '[class*="LeftSide"]'
      ];
      for (const s of sels) { const el = document.querySelector(s); if (el) { window.__leftPanelRoot = el; return el; } }
      return null;
    }

    // 心跳检测：每5秒统计左侧面板容器状态
    if (!window.__leftPanelHeartbeatTimer) {
      window.__leftPanelHeartbeatTimer = setInterval(() => {
        const root = findLeftPanelRoot();
        if (!root) {
          console.log('[LeftPanelHeartbeat] 左侧面板容器未找到');
        } else {
          const info = {
            width: root.offsetWidth,
            height: root.offsetHeight,
            visible: root.offsetParent !== null
          };
          console.log('[LeftPanelHeartbeat] 左侧面板容器存在: ' + JSON.stringify(info));
        }
      }, 5000);
    }

    return 'installed';
  } catch (e) {
    return 'error: ' + e.message;
  }
})()`;

class LeftPanelRenderer {
  constructor(options) {
    this.roomId = options.roomId;
    this.liveUrl = options.liveUrl;
    this.session = options.session;
    this.outputDir = options.outputDir || path.join(process.cwd(), 'output');
    this.debugDir = options.debugDir || path.join(this.outputDir, '.debug');
    this.targetFps = options.fps || 10; // 左侧面板固定帧率
    this.noAccountMode = options.noAccountMode || false;

    this.captureWindow = null;
    this.capturing = false;
    this._reloading = false;
    this._lastReloadAt = 0;
    this._reloadCount = 0;
    this._noContainerStreak = 0;
    this._leftPanelRect = null;
    this._captureTimer = null;
    this._frameCount = 0;
    this._onFrameSaved = options.onFrameSaved || (() => {});
    this._onAccountConflict = options.onAccountConflict || (() => {});
  }

  /**
   * 注入 CSS 仅显示左侧信息面板
   */
  async _injectCSS() {
    if (!this.captureWindow) return;

    const css = `
      /* 隐藏右侧评论区 */
      [class*="webcast-chatroom"],
      [class*="chat-list"],
      [class*="ChatList"],
      [class*="chat-room"],
      [class*="ChatRoom"],
      [class*="right-side"],
      [class*="RightSide"],
      [class*="side-panel"],
      [class*="SidePanel"],
      [class*="live-side"],
      [class*="LiveSide"] {
        display: none !important;
      }

      /* 隐藏中间视频播放区域 */
      [class*="video-container"],
      [class*="VideoContainer"],
      [class*="player-container"],
      [class*="PlayerContainer"],
      [class*="live-player"],
      [class*="LivePlayer"],
      canvas,
      video {
        display: none !important;
      }

      /* 确保左侧面板可见 */
      [class*="webcast-left"],
      [class*="left-panel"],
      [class*="LeftPanel"],
      [class*="anchor-info"],
      [class*="AnchorInfo"],
      [class*="gift-rank"],
      [class*="GiftRank"],
      [class*="audience-list"],
      [class*="AudienceList"] {
        display: block !important;
        position: fixed !important;
        left: 0 !important;
        top: 0 !important;
        width: ${LEFT_PANEL_WIDTH}px !important;
        height: 100vh !important;
        z-index: 9999 !important;
        background: #1a1a1a !important;
        overflow-y: auto !important;
      }
    `;

    try {
      await this.captureWindow.webContents.insertCSS(css);
      logger.info('[LeftPanelRenderer] CSS 注入完成');
    } catch (e) {
      logger.warn('[LeftPanelRenderer] CSS 注入失败:', e.message);
    }
  }

  /**
   * 初始化左侧面板渲染器
   */
  async init() {
    logger.info(`[LeftPanelRenderer] 初始化: ${this.liveUrl}`);

    // 创建离屏窗口 - 使用较宽的桌面分辨率，确保左侧面板在左侧
    this.captureWindow = new BrowserWindow({
      width: 1920,
      height: 1080,
      show: false,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
        session: this.session,
        backgroundThrottling: false,     // 不节流后台页面，确保左侧面板正常渲染
        webSecurity: false,              // 允许跨域，确保页面正常加载
        allowRunningInsecureContent: true // 允许不安全内容，避免 HTTPS 页面加载 HTTP 资源被阻止
      }
    });

    // 提高离屏绘制帧率：捕获到的帧更新更及时
    this.captureWindow.webContents.setFrameRate(this.targetFps);

    // 透传离屏页面 console 日志，便于诊断左侧面板检测是否正常工作
    this.captureWindow.webContents.on('console-message', (event, level, message) => {
      const msg = String(message || '');
      if (msg.includes('[LeftPanelHeartbeat]')) {
        logger.info(`[LeftPanelRenderer] ${msg}`);
        if (msg.includes('未找到')) {
          this._noContainerStreak = (this._noContainerStreak || 0) + 1;
          this._maybeReloadDeadPage();
        } else {
          this._noContainerStreak = 0;
        }
      }
    });

    // 加载直播间页面
    await this.captureWindow.loadURL(this.liveUrl, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // 等待页面加载完成
    await new Promise(resolve => setTimeout(resolve, 8000));

    // 注入 CSS 隐藏右侧评论区和中间视频区域
    await this._injectCSS();

    // 等待 CSS 生效
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 通过 DOM 探测左侧面板实际位置
    const detectedRect = await this._detectLeftPanelAreaFromDOM();

    if (detectedRect && detectedRect.width > 80 && detectedRect.height > 100) {
      // DOM 探测成功：使用探测到的左侧面板位置
      this._leftPanelRect = {
        x: detectedRect.x,
        y: 0,
        width: detectedRect.width,
        height: detectedRect.height
      };
      logger.info(`[LeftPanelRenderer] DOM探测左侧面板: x=${detectedRect.x}, y=${detectedRect.y}, w=${detectedRect.width}, h=${detectedRect.height}`);
    } else {
      // 回退：估算页面左侧区域
      const capturedSize = await this.captureWindow.webContents.executeJavaScript(`
        ({ width: window.innerWidth, height: window.innerHeight })
      `);
      const estimatedLeftWidth = Math.round(capturedSize.width * 0.20); // 左侧约占20%
      const cropW = Math.max(250, Math.min(estimatedLeftWidth, 500));
      this._leftPanelRect = {
        x: 0,
        y: 0,
        width: cropW,
        height: capturedSize.height
      };
      logger.warn(`[LeftPanelRenderer] DOM探测失败，使用估算区域: x=0, y=0, w=${cropW}, h=${capturedSize.height}`);
    }

    // 保存调试截图
    try {
      fs.mkdirSync(this.debugDir, { recursive: true });

      const debugImage = await this.captureWindow.webContents.capturePage();
      const debugPath = path.join(this.debugDir, 'debug_left_panel_full_page.png');
      fs.writeFileSync(debugPath, debugImage.toPNG());
      logger.info(`[LeftPanelRenderer] 完整页面截图已保存: ${debugPath}`);

      const r = this._leftPanelRect;
      const safeW = Math.min(r.width, 1920 - r.x);
      const safeH = Math.min(r.height, 1080 - r.y);
      if (safeW > 0 && safeH > 0) {
        const panelCrop = await this.captureWindow.webContents.capturePage({
          x: r.x, y: r.y, width: safeW, height: safeH
        });
        const panelPath = path.join(this.debugDir, 'debug_left_panel_area.png');
        fs.writeFileSync(panelPath, panelCrop.toPNG());
        logger.info(`[LeftPanelRenderer] 左侧面板截图已保存: ${panelPath}`);
      }
    } catch (e) {
      logger.warn('[LeftPanelRenderer] 调试截图保存失败:', e.message);
    }

    // 注入左侧面板心跳检测脚本
    try {
      const hbRet = await this.captureWindow.webContents.executeJavaScript(HEARTBEAT_SCRIPT);
      logger.info(`[LeftPanelRenderer] 心跳检测脚本注入结果: ${hbRet}`);
    } catch (e) {
      logger.warn('[LeftPanelRenderer] 心跳检测脚本注入失败:', e.message);
    }

    logger.info('[LeftPanelRenderer] 初始化完成');
  }

  /**
   * 通过 DOM 探测左侧面板实际位置
   */
  async _detectLeftPanelAreaFromDOM() {
    if (!this.captureWindow) return null;

    try {
      const result = await Promise.race([
        this.captureWindow.webContents.executeJavaScript(`
          (function() {
            const sels = [
              '[class*="webcast-left"]',
              '[class*="left-panel"]',
              '[class*="LeftPanel"]',
              '[class*="anchor-info"]',
              '[class*="AnchorInfo"]',
              '[class*="gift-rank"]',
              '[class*="GiftRank"]',
              '[class*="audience-list"]',
              '[class*="AudienceList"]',
              '[class*="user-list"]',
              '[class*="UserList"]',
              '[class*="side-left"]',
              '[class*="SideLeft"]',
              '[class*="left-side"]',
              '[class*="LeftSide"]'
            ];

            for (const sel of sels) {
              const el = document.querySelector(sel);
              if (el) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 80 && rect.height > 100) {
                  return {
                    x: Math.round(rect.left),
                    y: Math.round(rect.top),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                  };
                }
              }
            }
            return null;
          })()
        `),
        new Promise(resolve => setTimeout(() => resolve(null), 8000))
      ]);

      return result;
    } catch (e) {
      logger.warn('[LeftPanelRenderer] DOM探测异常:', e.message);
      return null;
    }
  }

  /**
   * 左侧面板容器持续缺失时判断是否触发自愈刷新
   */
  _maybeReloadDeadPage() {
    try {
      if (!this.capturing) return;
      if (this._reloading) return;
      if ((this._noContainerStreak || 0) < 12) return;
      const now = Date.now();
      if (this._lastReloadAt && now - this._lastReloadAt < 90000) return;
      if ((this._reloadCount || 0) >= 10) {
        logger.warn('[LeftPanelRenderer] 本场自愈刷新已达10次上限，后续容器缺失不再自动刷新');
        return;
      }
      logger.warn(`[LeftPanelRenderer] 左侧面板容器持续缺失约60s，触发页面刷新自愈`);
      this._reloadPageForRecovery().catch((e) => {
        logger.warn('[LeftPanelRenderer] 页面自愈刷新异常:', e && e.message);
      });
    } catch (e) {}
  }

  /**
   * 刷新左侧面板页面并恢复捕获状态
   */
  async _reloadPageForRecovery() {
    if (this._reloading) return;
    this._reloading = true;
    this._lastReloadAt = Date.now();
    this._reloadCount = (this._reloadCount || 0) + 1;

    try {
      logger.info(`[LeftPanelRenderer] 开始刷新页面自愈 (第${this._reloadCount}次)`);

      // 重新加载页面
      await this.captureWindow.reload();

      // 等待页面加载完成
      await new Promise(resolve => setTimeout(resolve, 10000));

      // 重新注入 CSS
      await this._injectCSS();

      // 等待 CSS 生效
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 重新 DOM 探测左侧面板并更新裁剪区域
      const detectedRect = await this._detectLeftPanelAreaFromDOM();
      if (detectedRect && detectedRect.width > 80 && detectedRect.height > 100) {
        this._leftPanelRect = {
          x: detectedRect.x,
          y: 0,
          width: detectedRect.width,
          height: detectedRect.height
        };
        logger.info(`[LeftPanelRenderer] 刷新后重新探测左侧面板: x=${detectedRect.x}, y=${detectedRect.y}, w=${detectedRect.width}, h=${detectedRect.height}`);
      }

      logger.info('[LeftPanelRenderer] 页面刷新自愈完成');
    } catch (e) {
      logger.error('[LeftPanelRenderer] 页面刷新自愈失败:', e.message);
    } finally {
      this._reloading = false;
    }
  }

  /**
   * 开始捕获左侧面板帧
   */
  async startCapture() {
    if (this.capturing) return;
    this.capturing = true;
    this._frameCount = 0;

    logger.info(`[LeftPanelRenderer] 开始捕获左侧面板帧, 固定FPS: ${this.targetFps}, 输出目录: ${this.outputDir}`);

    const frameInterval = 1000 / this.targetFps;
    let lastCaptureTime = Date.now();

    this._captureTimer = setInterval(async () => {
      if (!this.capturing || !this.captureWindow) return;

      try {
        const now = Date.now();
        const elapsed = now - lastCaptureTime;

        // 确保按固定帧率捕获
        if (elapsed < frameInterval) return;

        lastCaptureTime = now;

        const r = this._leftPanelRect;
        if (!r) return;

        const safeW = Math.min(r.width, 1920 - r.x);
        const safeH = Math.min(r.height, 1080 - r.y);

        if (safeW <= 0 || safeH <= 0) return;

        const image = await this.captureWindow.webContents.capturePage({
          x: r.x, y: r.y, width: safeW, height: safeH
        });

        const framePath = path.join(this.outputDir, `left_frame_${String(this._frameCount).padStart(6, '0')}.jpg`);
        fs.writeFileSync(framePath, image.toJPEG(CAPTURE_QUALITY));

        this._frameCount++;
        this._onFrameSaved(this._frameCount, framePath);

        if (this._frameCount % 100 === 0) {
          logger.info(`[LeftPanelRenderer] 已捕获 ${this._frameCount} 帧`);
        }
      } catch (e) {
        logger.error('[LeftPanelRenderer] 捕获帧失败:', e.message);
      }
    }, 100); // 检查间隔 100ms
  }

  /**
   * 停止捕获
   */
  stopCapture() {
    this.capturing = false;
    if (this._captureTimer) {
      clearInterval(this._captureTimer);
      this._captureTimer = null;
    }
    logger.info(`[LeftPanelRenderer] 停止捕获，共捕获 ${this._frameCount} 帧`);
  }

  /**
   * 获取捕获信息
   */
  getCaptureInfo() {
    return {
      frameCount: this._frameCount,
      fps: this.targetFps,
      width: this._leftPanelRect?.width || LEFT_PANEL_WIDTH,
      height: this._leftPanelRect?.height || LEFT_PANEL_HEIGHT
    };
  }

  /**
   * 销毁渲染器
   */
  async destroy() {
    this.stopCapture();
    if (this.captureWindow) {
      try {
        this.captureWindow.destroy();
      } catch (e) {}
      this.captureWindow = null;
    }
    logger.info('[LeftPanelRenderer] 已销毁');
  }
}

module.exports = { LeftPanelRenderer, LEFT_PANEL_WIDTH, LEFT_PANEL_HEIGHT };
