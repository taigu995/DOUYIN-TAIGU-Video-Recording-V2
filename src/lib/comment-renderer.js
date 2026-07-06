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

    // 创建离屏窗口 - 尺寸设为直播间完整页面，评论区在右侧
    // 窗口宽度需要足够大以包含完整页面（视频区+评论区）
    const PAGE_WIDTH = 1640;
    const PAGE_HEIGHT = 720;

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
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 注入 CSS：仅显示右侧评论区
    await this._injectCommentOnlyCSS();

    // 等待 CSS 生效
    await new Promise(resolve => setTimeout(resolve, 1000));

    logger.info('[CommentRenderer] 初始化完成，仅显示评论区');
  }

  /**
   * 注入 CSS，隐藏除右侧评论区以外的所有内容
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
              width: 100vw !important;
              height: 100vh !important;
              background: #000 !important;
            }

            /* 隐藏顶部导航栏 */
            header, nav, [class*="header"], [class*="Header"],
            [class*="navbar"], [class*="NavBar"], [class*="top-bar"],
            [class*="TopBar"], [data-e2e="top-nav"] {
              display: none !important;
              visibility: hidden !important;
            }

            /* 隐藏左侧视频播放区域 */
            [class*="video-container"], [class*="VideoContainer"],
            [class*="player-container"], [class*="PlayerContainer"],
            [class*="live-player"], [class*="LivePlayer"],
            [class*="video-area"], [class*="VideoArea"],
            [class*="main-content"], [class*="MainContent"],
            [data-e2e="live-player"], [data-e2e="live-video"],
            video, [class*="xgplayer"], [class*="xg-player"] {
              display: none !important;
              visibility: hidden !important;
            }

            /* 隐藏底部工具栏 */
            [class*="toolbar"], [class*="ToolBar"],
            [class*="bottom-bar"], [class*="BottomBar"],
            [class*="footer"], [class*="Footer"],
            [class*="input-area"], [class*="InputArea"],
            [class*="chat-input"], [class*="ChatInput"] {
              display: none !important;
              visibility: hidden !important;
            }

            /* 隐藏浮动弹幕层（视频上方的弹幕） */
            [class*="danmu"]:not([class*="chat"]):not([class*="comment"]),
            [class*="barrage"]:not([class*="chat"]):not([class*="comment"]),
            [class*="Danmu"]:not([class*="chat"]):not([class*="comment"]),
            canvas[class*="dm"] {
              display: none !important;
              visibility: hidden !important;
            }

            /* 隐藏滚动条 */
            ::-webkit-scrollbar { display: none !important; }
            * { scrollbar-width: none !important; }

            /* 强制页面不滚动 */
            * { overflow: hidden !important; }
          \`;
          document.head.appendChild(style);

          // 尝试通过 JS 进一步隐藏非评论区元素
          // 保留评论区相关的元素
          const commentSelectors = [
            '[class*="chat"]', '[class*="Chat"]',
            '[class*="comment"]', '[class*="Comment"]',
            '[class*="danmu-list"]', '[class*="message-list"]',
            '[class*="MessageList"]', '[class*="chat-list"]',
            '[class*="ChatList"]', '[class*="room-chat"]',
            '[class*="RoomChat"]', '[class*="side-chat"]',
            '[class*="live-chat"]', '[class*="LiveChat"]',
            '[class*="chat-room"]', '[class*="ChatRoom"]',
            '[class*="interact"]', '[class*="Interact"]',
            '[class*="gift"]', '[class*="Gift"]',
            '[class*="rank"]', '[class*="Rank"]',
            '[class*="audience"]', '[class*="Audience"]',
            '[class*="viewer"]', '[class*="Viewer"]',
            '[class*="right-side"]', '[class*="RightSide"]',
            '[class*="sidebar"]', '[class*="Sidebar"]'
          ];

          // 找到评论区容器并移到最右侧
          let commentContainer = null;
          for (const sel of commentSelectors) {
            const el = document.querySelector(sel);
            if (el && el.getBoundingClientRect().width > 100) {
              commentContainer = el;
              break;
            }
          }

          // 如果找到了评论区容器，确保它可见
          if (commentContainer) {
            // 向上找到最外层的右侧容器
            let parent = commentContainer;
            while (parent.parentElement && parent.parentElement !== document.body) {
              const rect = parent.parentElement.getBoundingClientRect();
              if (rect.width > 500) break; // 找到了包含评论区的父容器
              parent = parent.parentElement;
            }
          }

          // 强制滚动到顶部
          window.scrollTo(0, 0);

          // 阻止滚动
          window.addEventListener('scroll', () => {
            window.scrollTo(0, 0);
          }, { passive: true });

          // 使用 MutationObserver 持续清理不需要的元素
          if (window._commentObserver) {
            window._commentObserver.disconnect();
          }
          window._commentObserver = new MutationObserver(() => {
            // 持续隐藏视频播放器（抖音可能会动态创建）
            document.querySelectorAll('video').forEach(v => {
              v.style.display = 'none';
              v.pause();
            });
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

        // 裁剪到评论区区域（页面右侧）
        // 页面宽度 1640，评论区从 x=1280 开始，宽度 360
        const cropX = Math.max(0, imgSize.width - COMMENT_WIDTH);
        const cropY = 0;
        const cropW = Math.min(COMMENT_WIDTH, imgSize.width - cropX);
        const cropH = Math.min(COMMENT_HEIGHT, imgSize.height);

        let croppedImage;
        if (cropX >= imgSize.width || cropW <= 0 || cropH <= 0) {
          // 如果裁剪区域无效，使用整个页面
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
      duration: duration
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
