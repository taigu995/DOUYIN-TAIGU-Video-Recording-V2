/**
 * 评论区离屏渲染器
 * 使用 Electron 离屏窗口仅渲染直播间右侧评论区（弹幕+礼物特效）
 * 捕获评论区帧用于与流媒体直录视频拼接
 */
const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { getLogger } = require('./logger');

const logger = getLogger();

// 评论区渲染配置
const COMMENT_WIDTH = 360;   // 评论区宽度
const COMMENT_HEIGHT = 720;  // 评论区高度（与主视频对齐）
const CAPTURE_QUALITY = 85;  // JPEG 压缩质量 (1-100)

class CommentRenderer {
  constructor(options) {
    this.liveUrl = options.liveUrl;
    this.roomId = options.roomId;
    this.session = options.session || 'persist:douyin';
    this.outputDir = options.outputDir; // 帧保存目录
    this.targetFps = options.fps || 10; // 评论区帧率（不需要太高）

    this.captureWindow = null;
    this.capturing = false;
    this.frameCount = 0;
    this._captureTimer = null;
    this._startTime = null;
  }

  /**
   * 初始化离屏窗口并加载直播页面
   * 注入 CSS 仅显示右侧评论区
   */
  async init() {
    // 创建帧输出目录
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    // 创建离屏窗口 - 使用较宽的桌面分辨率，确保评论区在右侧
    const PAGE_WIDTH = 1920;
    const PAGE_HEIGHT = 1080;

    this.captureWindow = new BrowserWindow({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      show: false,
      enableLargerThanScreen: true,
      frame: false,
      webPreferences: {
        offscreen: true,
        javascript: true,
        plugins: true,
        nodeIntegration: false,
        contextIsolation: true,
        partition: this.session,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        additionalArguments: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
        audioPlaybackPolicy: 'never'
      }
    });

    // 加载直播页面
    logger.info(`[CommentRenderer] 加载直播页面: ${this.liveUrl}`);
    await this.captureWindow.loadURL(this.liveUrl, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    });

    // 等待页面完全加载
    logger.info('[CommentRenderer] 等待页面加载完成...');
    await new Promise(resolve => setTimeout(resolve, 8000));

    // 注入 CSS：隐藏视频播放器，保留评论区
    await this._injectCommentOnlyCSS();

    // 等待 CSS 生效和评论区渲染
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 探测评论区实际位置
    const commentRect = await this._detectCommentAreaPosition();
    if (commentRect) {
      this._commentRect = commentRect;
      logger.info(`[CommentRenderer] 评论区位置: x=${commentRect.x}, y=${commentRect.y}, w=${commentRect.width}, h=${commentRect.height}`);
    } else {
      // 默认：页面右侧 400px
      this._commentRect = { x: PAGE_WIDTH - 400, y: 0, width: 400, height: PAGE_HEIGHT };
      logger.warn('[CommentRenderer] 未探测到评论区位置，使用默认右侧区域 (x=1520, y=0, w=400, h=1080)');
    }

    // 诊断：捕获一帧用于调试
    try {
      const debugImage = await this.captureWindow.webContents.capturePage();
      const debugSize = debugImage.getSize();
      logger.info(`[CommentRenderer] 页面捕获尺寸: ${debugSize.width}x${debugSize.height}`);
    } catch (e) {
      logger.warn('[CommentRenderer] 诊断捕获失败:', e.message);
    }

    logger.info('[CommentRenderer] 初始化完成，仅显示评论区');
  }

  /**
   * 注入 CSS，隐藏视频播放器和无关区域，保留评论区自然显示
   * 策略：只隐藏视频播放器/导航/工具栏，评论区保持页面自然布局
   */
  async _injectCommentOnlyCSS() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    try {
      await this.captureWindow.webContents.executeJavaScript(`
        (function() {
          // 移除旧样式
          document.querySelectorAll('style[data-comment-renderer]').forEach(s => s.remove());

          const style = document.createElement('style');
          style.setAttribute('data-comment-renderer', 'true');
          style.textContent = \`
            /* 基础重置 */
            html, body {
              margin: 0 !important;
              padding: 0 !important;
              overflow: hidden !important;
              background: #121212 !important;
            }

            /* 隐藏顶部导航栏 */
            header, nav,
            [class*="header"], [class*="Header"],
            [class*="navbar"], [class*="NavBar"],
            [class*="top-bar"], [class*="TopBar"],
            [data-e2e="top-nav"] {
              display: none !important;
              height: 0 !important;
              min-height: 0 !important;
              max-height: 0 !important;
              overflow: hidden !important;
            }

            /* 隐藏视频播放器区域 - 使用多种选择器覆盖 */
            [class*="video"], [class*="Video"],
            [class*="player"], [class*="Player"],
            [data-e2e="live-player"], [data-e2e="live-video"],
            video, [class*="xgplayer"], [class*="xg-player"],
            [class*="scaffold-left"], [class*="scaffold-main"] {
              display: none !important;
            }

            /* 隐藏底部工具栏和输入框 */
            [class*="toolbar"], [class*="ToolBar"],
            [class*="bottom-bar"], [class*="BottomBar"],
            [class*="footer"], [class*="Footer"],
            [class*="chat-input"], [class*="ChatInput"],
            [class*="input-area"], [class*="InputArea"],
            [class*="gift-panel"], [class*="GiftPanel"],
            [class*="gift-enter"], [class*="GiftEnter"] {
              display: none !important;
            }

            /* 隐藏浮动弹幕层（视频上方的canvas弹幕） */
            canvas {
              display: none !important;
            }

            /* 隐藏左侧推荐区域 */
            [class*="recommend"], [class*="Recommend"],
            [class*="related"], [class*="Related"] {
              display: none !important;
            }

            /* 隐藏滚动条 */
            ::-webkit-scrollbar { display: none !important; }
            * { scrollbar-width: none !important; }
          \`;
          document.head.appendChild(style);

          // 通过 JS 持续隐藏视频播放器（动态创建的元素）
          document.querySelectorAll('video').forEach(v => {
            v.style.setProperty('display', 'none', 'important');
            try { v.pause(); } catch(e) {}
          });

          // 查找评论区容器（用于确定裁剪区域）
          const commentSelectors = [
            '[class*="chat-list"]', '[class*="ChatList"]',
            '[class*="chat-room"]', '[class*="ChatRoom"]',
            '[class*="room-chat"]', '[class*="RoomChat"]',
            '[class*="live-chat"]', '[class*="LiveChat"]',
            '[class*="side-chat"]', '[class*="chat-container"]',
            '[class*="ChatContainer"]',
            '[class*="message-list"]', '[class*="MessageList"]',
            '[class*="webcast-chatroom"]',
            '[data-e2e="live-chat"]', '[data-e2e="chat-room"]',
            '[class*="comment-list"]', '[class*="CommentList"]',
            '[class*="danmu-list"]',
            '[class*="interact"]', '[class*="Interact"]'
          ];

          let commentContainer = null;
          for (const sel of commentSelectors) {
            try {
              const els = document.querySelectorAll(sel);
              for (const el of els) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 80 && rect.height > 100) {
                  commentContainer = el;
                  break;
                }
              }
            } catch(e) {}
            if (commentContainer) break;
          }

          // 如果通过 class 没找到，尝试找页面右侧最大的可见 div
          if (!commentContainer) {
            const allDivs = document.querySelectorAll('div');
            let bestDiv = null;
            let bestArea = 0;
            const pageCenterX = window.innerWidth / 2;
            for (const div of allDivs) {
              const rect = div.getBoundingClientRect();
              if (rect.left < pageCenterX) continue;
              if (rect.width < 80 || rect.height < 100) continue;
              const area = rect.width * rect.height;
              if (area > window.innerWidth * window.innerHeight * 0.8) continue;
              if (area > bestArea) {
                bestArea = area;
                bestDiv = div;
              }
            }
            if (bestDiv) commentContainer = bestDiv;
          }

          if (commentContainer) {
            const rect = commentContainer.getBoundingClientRect();
            window.__commentRect = {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            };
            window.__commentRendererFound = true;
          } else {
            window.__commentRendererFound = false;
          }

          // MutationObserver 持续隐藏视频播放器
          if (window._commentObserver) {
            window._commentObserver.disconnect();
          }
          window._commentObserver = new MutationObserver(() => {
            document.querySelectorAll('video').forEach(v => {
              v.style.setProperty('display', 'none', 'important');
              try { v.pause(); } catch(e) {}
            });
            // 更新评论区位置
            if (commentContainer && commentContainer.isConnected) {
              const rect = commentContainer.getBoundingClientRect();
              window.__commentRect = {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              };
            }
          });
          window._commentObserver.observe(document.body, {
            childList: true,
            subtree: true
          });
        })();
      `);
      logger.info('[CommentRenderer] 已注入评论区 CSS');
    } catch (e) {
      logger.warn('[CommentRenderer] 注入 CSS 失败:', e.message);
    }
  }

  /**
   * 探测评论区在页面中的实际位置
   */
  async _detectCommentAreaPosition() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return null;

    try {
      const rect = await this.captureWindow.webContents.executeJavaScript(`
        window.__commentRect || null
      `);
      if (rect && rect.width > 50 && rect.height > 50) {
        return rect;
      }
    } catch (e) {
      logger.warn('[CommentRenderer] 探测评论区位置失败:', e.message);
    }
    return null;
  }

  /**
   * 开始捕获评论区帧
   * 帧保存为 JPEG 文件，用于后续 FFmpeg 合并
   */
  startCapture() {
    if (this.capturing) return;
    if (!this.captureWindow || this.captureWindow.isDestroyed()) {
      logger.error('[CommentRenderer] 捕获窗口未初始化或已销毁');
      return;
    }

    this.capturing = true;
    this.frameCount = 0;
    this._startTime = Date.now();
    this._captureStartTime = this._startTime;

    logger.info(`[CommentRenderer] 开始捕获评论区帧, FPS: ${this.targetFps}, 输出目录: ${this.outputDir}`);

    const targetInterval = Math.floor(1000 / this.targetFps);
    let capturing = false;

    const captureFrame = async () => {
      if (!this.capturing || !this.captureWindow || this.captureWindow.isDestroyed()) {
        return;
      }

      // 防止重入
      if (capturing) {
        if (this.capturing) {
          this._captureTimer = setTimeout(captureFrame, targetInterval);
        }
        return;
      }

      capturing = true;
      const now = Date.now();

      try {
        // 捕获完整页面
        const image = await this.captureWindow.webContents.capturePage();
        const imgSize = image.getSize();

        // 使用探测到的评论区位置进行裁剪
        let cropX, cropY, cropW, cropH;
        if (this._commentRect) {
          const r = this._commentRect;
          cropX = Math.max(0, r.x);
          cropY = Math.max(0, r.y);
          cropW = Math.min(r.width, imgSize.width - cropX);
          cropH = Math.min(r.height, imgSize.height - cropY);
        } else {
          // 兜底：取页面右侧 400px
          const fallbackW = 400;
          cropX = Math.max(0, imgSize.width - fallbackW);
          cropY = 0;
          cropW = fallbackW;
          cropH = imgSize.height;
        }

        let croppedImage;
        if (cropW <= 10 || cropH <= 10 || cropX >= imgSize.width) {
          // 裁剪区域无效，使用整个页面
          croppedImage = image;
        } else {
          croppedImage = image.crop({
            x: cropX,
            y: cropY,
            width: cropW,
            height: cropH
          });
        }

        // 保存为 JPEG
        const jpegData = croppedImage.toJPEG(CAPTURE_QUALITY);
        const framePath = path.join(
          this.outputDir,
          `frame_${String(this.frameCount).padStart(6, '0')}.jpg`
        );
        fs.writeFileSync(framePath, jpegData);

        this.frameCount++;

        // 每 100 帧输出一次进度
        if (this.frameCount % 100 === 0) {
          const elapsed = ((Date.now() - this._captureStartTime) / 1000).toFixed(1);
          logger.info(`[CommentRenderer] 已捕获 ${this.frameCount} 帧 (${elapsed}s)`);
        }
      } catch (err) {
        if (!err.message.includes('destroyed')) {
          logger.warn('[CommentRenderer] 捕获帧出错:', err.message);
        }
      } finally {
        capturing = false;
      }

      // 安排下一次捕获
      if (this.capturing) {
        const elapsed = Date.now() - now;
        const nextDelay = Math.max(0, targetInterval - elapsed);
        this._captureTimer = setTimeout(captureFrame, nextDelay);
      }
    };

    // 启动捕获循环
    this._captureTimer = setTimeout(captureFrame, targetInterval);
  }

  /**
   * 停止捕获
   * @returns {{ frameCount: number, outputDir: string, fps: number, duration: number }}
   */
  stopCapture() {
    this.capturing = false;

    if (this._captureTimer) {
      clearTimeout(this._captureTimer);
      this._captureTimer = null;
    }

    const duration = this._startTime ? Date.now() - this._startTime : 0;
    const actualFps = duration > 0 ? (this.frameCount / (duration / 1000)) : this.targetFps;

    logger.info(
      `[CommentRenderer] 停止捕获, 总帧数: ${this.frameCount}, ` +
      `时长: ${(duration / 1000).toFixed(1)}s, 实际FPS: ${actualFps.toFixed(1)}`
    );

    return {
      frameCount: this.frameCount,
      outputDir: this.outputDir,
      fps: actualFps,
      duration: duration,
      width: this._commentRect ? this._commentRect.width : COMMENT_WIDTH,
      height: this._commentRect ? this._commentRect.height : COMMENT_HEIGHT
    };
  }

  /**
   * 清理所有资源
   */
  async destroy() {
    this.stopCapture();

    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      try {
        this.captureWindow.destroy();
      } catch (e) {
        logger.warn('[CommentRenderer] 销毁窗口出错:', e.message);
      }
      this.captureWindow = null;
    }

    logger.info('[CommentRenderer] 已销毁');
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      capturing: this.capturing,
      frameCount: this.frameCount,
      outputDir: this.outputDir,
      duration: this._startTime ? Date.now() - this._startTime : 0
    };
  }
}

module.exports = { CommentRenderer, COMMENT_WIDTH, COMMENT_HEIGHT };
