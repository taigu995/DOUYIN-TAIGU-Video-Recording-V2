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
const COMMENT_WIDTH = 500;   // 评论区宽度（捕获区域宽度）
const COMMENT_HEIGHT = 1080; // 评论区高度（与主视频对齐）
const CAPTURE_QUALITY = 92;  // JPEG 压缩质量 (1-100)

// 评论区心跳检测脚本：每5秒检测评论区容器是否存在，用于触发自愈刷新
const HEARTBEAT_SCRIPT = `(() => {
  try {
    if (window.__heartbeatInstalled) return 'already';
    window.__heartbeatInstalled = true;

    // 评论区容器定位（选择器必须与主进程 _detectCommentAreaFromDOM 保持同步）
    function findCommentRoot() {
      if (window.__commentRoot && window.__commentRoot.isConnected) return window.__commentRoot;
      const sels = [
        '[class*="webcast-chatroom"]',
        '[data-e2e="live-chat"]','[data-e2e="chat-room"]',
        '[class*="chat-list"]','[class*="ChatList"]',
        '[class*="chat-room"]','[class*="ChatRoom"]',
        '[class*="room-chat"]','[class*="RoomChat"]',
        '[class*="live-chat"]','[class*="LiveChat"]',
        '[class*="side-chat"]',
        '[class*="message-list"]','[class*="MessageList"]',
        '[class*="chat-container"]','[class*="ChatContainer"]',
        '[class*="comment-list"]','[class*="CommentList"]',
        '[class*="danmu-list"]','[class*="DanmuList"]',
        '[class*="interact-container"]','[class*="InteractContainer"]',
        '[class*="scaffold-right"]','[class*="ScaffoldRight"]',
        '[class*="right-side"]','[class*="RightSide"]',
        '[class*="side-panel"]','[class*="SidePanel"]',
        '[class*="live-side"]','[class*="LiveSide"]'
      ];
      for (const s of sels) { const el = document.querySelector(s); if (el) { window.__commentRoot = el; return el; } }
      return null;
    }

    // 心跳检测：每5秒统计评论区容器状态
    if (!window.__heartbeatTimer) {
      window.__heartbeatTimer = setInterval(() => {
        try {
          const ct = findCommentRoot();
          if (!ct) {
            let ended = false;
            try { ended = /直播已结束/.test((document.body && document.body.innerText) || ''); } catch (e2) {}
            let diag = '';
            try {
              window.__hbMissCount = (window.__hbMissCount || 0) + 1;
              if (window.__hbMissCount % 12 === 1) {
                diag = ' [诊断] url=' + (location.pathname || '') + ' title=' + String(document.title || '').slice(0, 30);
              }
            } catch (e3) {}
            console.log('[GiftHeartbeat] 评论区容器未找到' + (ended ? ' [直播已结束]' : ' [容器缺失]') + diag);
            return;
          }
          // 统计容器内消息数
          const els = ct.querySelectorAll('*');
          const seen = new Set();
          let total = 0;
          for (let i = 0; i < els.length; i++) {
            const t = (els[i].textContent || '').replace(/\\s+/g, ' ').trim();
            if (!t || t.length > 80) continue;
            if (seen.has(t)) continue;
            seen.add(t);
            total++;
          }
          const delta = total - (window.__hbLastTotal || 0);
          window.__hbLastTotal = total;
          console.log('[GiftHeartbeat] 评论区消息=' + total + ' 新增~' + delta);
        } catch (e) { console.log('[GiftHeartbeat] 统计异常: ' + e.message); }
      }, 5000);
    }

    return 'installed';
  } catch (e) { return 'error:' + e.message; }
})()`;

// 评论区时间戳显示脚本：在评论区顶部显示当前录制时间
const TIMESTAMP_SCRIPT = `(() => {
  try {
    if (window.__timestampInstalled) return 'already';
    window.__timestampInstalled = true;

    // 查找评论区容器
    const findCommentRoot = () => {
      const sels = [
        '[class*="webcast-chatroom"]',
        '[class*="chatroom"]',
        '[class*="comment"]'
      ];
      for (const s of sels) { const el = document.querySelector(s); if (el) return el; }
      return null;
    };

    const root = findCommentRoot();
    if (!root) return 'error:comment_root_not_found';

    // 创建时间显示元素
    const el = document.createElement('div');
    el.id = '__recorder_timestamp';
    el.style.cssText = \`
      position: sticky;
      top: 0;
      left: 0;
      right: 0;
      z-index: 999999;
      background: rgba(0, 0, 0, 0.85);
      color: #fff;
      font-size: 13px;
      font-family: 'Courier New', monospace;
      padding: 4px 8px;
      text-align: center;
      pointer-events: none;
      border-bottom: 1px solid rgba(255, 255, 255, 0.15);
      margin-bottom: 4px;
    \`;

    // 插入到评论区容器顶部
    root.insertBefore(el, root.firstChild);

    // 更新时间函数
    function updateTime() {
      const now = new Date();
      const y = now.getFullYear();
      const M = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      const h = String(now.getHours()).padStart(2, '0');
      const m = String(now.getMinutes()).padStart(2, '0');
      const s = String(now.getSeconds()).padStart(2, '0');
      el.textContent = y + '-' + M + '-' + d + ' ' + h + ':' + m + ':' + s;
    }

    // 立即更新一次
    updateTime();
    // 每秒更新
    window.__timestampTimer = setInterval(updateTime, 1000);

    return 'installed';
  } catch (e) { return 'error:' + e.message; }
})();`;


class CommentRenderer {
  constructor(options) {
    this.liveUrl = options.liveUrl;
    this.roomId = options.roomId;
    this.session = options.session || 'persist:douyin';
    this.outputDir = options.outputDir; // 帧保存目录
    this.debugDir = options.debugDir || options.outputDir; // 调试截图保存目录
    this.targetFps = options.fps || 10; // 评论区固定帧率（全程使用，不因礼物变化）
    // 取消"检测到礼物后自动提帧"：礼物档与基准帧率保持一致，评论区全程以设置的固定帧率录制，
    // 以消除动态提帧造成的帧时间轴偏移，缩小评论区视频与源视频的时长不一致。
    this._timestamps = []; // 帧时间戳(ms)，供合并端精确控制时间轴

    // 续帧起始编号：录制中检测到账号冲突回滚重建渲染器时，从已有帧数继续编号，避免覆盖已录帧
    this.frameStartIndex = options.frameStartIndex || 0;
    // 左侧特效区捕获模式（stream+comment+effect）：复用本离屏窗口，在 capturePage() 时同时裁剪
    // 评论区（右侧）和左侧特效区（公屏聊天/礼物栏），帧分别写入两个目录，避免再开一个独立窗口去渲染页面
    this.enableLeftPanel = !!options.enableLeftPanel;
    this.leftPanelOutputDir = options.leftPanelOutputDir || null;
    this._leftPanelRect = null;         // 左侧特效区裁剪区域
    this._leftPanelFrameCount = 0;      // 左侧特效区累计帧数
    this._leftPanelFps = this.targetFps; // 左侧特效区帧率（与评论区一致）
    // 无账号模式标识：无账号+评论区时不需要账号冲突检测/回滚
    this.noLoginMode = !!options.noLoginMode;
    // 账号冲突回调：检测到评论区提示"已在其它设备登录"（被同账号顶下线）时触发，供外部回滚录制模式
    this.onAccountConflict = options.onAccountConflict || null;
    this._conflictTimer = null;        // 账号冲突检测定时器
    this._conflictSkip = 0;            // 连续触发去抖计数器

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
        paintWhenInitiallyHidden: true, // 窗口隐藏也持续绘制，保证离屏能捕获到动画特效
        backgroundThrottling: false,     // 不节流后台页面，礼物动画不被拖慢
        javascript: true,
        plugins: true,
        nodeIntegration: false,
        contextIsolation: true,
        partition: this.session,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        autoplayPolicy: 'document-user-activation-required',
        audioPlaybackPolicy: 'never'
      }
    });

    // 提高离屏绘制帧率：捕获到的帧更新更及时，礼物特效更平滑
    try { this.captureWindow.webContents.setFrameRate(this.targetFps); } catch (e) {}

    // 静音窗口，防止直播音频外放
    this.captureWindow.webContents.setAudioMuted(true);
    logger.info('[CommentRenderer] 窗口音频已静音');

    // 透传离屏页面 console 日志，便于诊断评论区/礼物检测是否正常工作
    // 同时统计"评论区容器未找到"的连续心跳，持续缺失(约60s)时自动刷新页面自愈
    this.captureWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      try {
        const msg = String(message || '').slice(0, 500);
        if (msg.includes('[GiftHeartbeat]')) {
          if (msg.includes('容器未找到')) {
            this._noContainerStreak = (this._noContainerStreak || 0) + 1;
            this._maybeReloadDeadPage(msg.includes('[直播已结束]'));
          } else if (msg.includes('评论区消息=')) {
            // 容器正常，页面健康
            this._noContainerStreak = 0;
          }
        }
        if (
          msg.includes('[CommentProbe]') ||
          msg.includes('[BannerInfo]') ||
          msg.includes('[GiftHeartbeat]') ||
          msg.includes('gift') ||
          msg.includes('Gift')
        ) {
          logger.info(`[CommentRenderer-Page] ${msg}`);
        }
      } catch (e) {}
    });

    // 归档：把已登录的主窗口 cookies 同步到离屏评论窗口，确保评论区有实时弹幕/礼物
    try {
      const targetSession = this.captureWindow.webContents.session;
      if (targetSession) {
        let mainWin = null;
        const allWins = BrowserWindow.getAllWindows();
        for (const w of allWins) {
          if (w && !w.webContents.isOffscreen()) { mainWin = w; break; }
        }
        if (mainWin && mainWin.webContents && mainWin.webContents.session) {
          const srcSession = mainWin.webContents.session;
          const cookies = await srcSession.cookies.get({});
          let synced = 0;
          for (const c of cookies) {
            try {
              const targetCookies = await targetSession.cookies.get({ name: c.name, domain: c.domain, path: c.path });
              if (targetCookies.length === 0) {
                const urlDomain = (c.domain || '').replace(/^\./, '');
                targetSession.cookies.set({
                  url: 'https://' + urlDomain + (c.path || '/'),
                  name: c.name,
                  value: c.value,
                  domain: c.domain,
                  path: c.path || '/',
                  secure: !!c.secure,
                  httpOnly: !!c.httpOnly,
                  expirationDate: c.expirationDate
                }).then(() => { synced++; }).catch(() => {});
              }
            } catch (e) {}
          }
          // 等待少量同步完成
          await new Promise(r => setTimeout(r, 800));
          logger.info(`[CommentRenderer] 已从主窗口同步登录Cookie到离屏评论窗口 (共${cookies.length}条, 已同步${synced}条)`);
        } else {
          logger.warn('[CommentRenderer] 未找到主窗口，跳过Cookie同步');
        }
      }
    } catch (e) {
      logger.warn('[CommentRenderer] Cookie同步失败: ' + (e && e.message));
    }

    // 加载直播页面（带超时、重试和容错机制）
    logger.info(`[CommentRenderer] 加载直播页面: ${this.liveUrl}`);
    const maxRetries = 3;
    const loadTimeout = 30000;    // 单次 loadURL 超时 30s
    const probeTimeout = 4000;    // readyState 探测超时（防止导航 pending 时 executeJavaScript 永久挂起）
    const totalDeadline = 180000; // 整体加载兜底超时（从 150s 增加到 180s），杜绝任何意外路径的永久挂起
    const loadStartedAt = Date.now();

    logger.info(`[CommentRenderer] 加载超时设置: 单次=${loadTimeout / 1000}s, 探测=${probeTimeout / 1000}s, 总超时=${totalDeadline / 1000}s, 最大重试=${maxRetries}`);

    const winAlive = () => !!(this.captureWindow && !this.captureWindow.isDestroyed());
    // 超时后必须主动终止导航：页面停留在 pending 时，后续 executeJavaScript 会无限挂起
    const stopLoading = () => {
      try { if (winAlive()) this.captureWindow.webContents.stop(); } catch (e) {}
    };
    // 带超时的 readyState 探测，永不 reject、永不无限挂起
    const probeReady = (waitMs) => new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => finish(false), waitMs);
      if (!winAlive()) { clearTimeout(timer); return finish(false); }
      this.captureWindow.webContents.executeJavaScript(
        'document.readyState === "complete" || document.readyState === "interactive"'
      ).then((v) => { clearTimeout(timer); finish(!!v); })
       .catch(() => { clearTimeout(timer); finish(false); });
    });

    let pageLoadSuccess = false;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // 整体兜底：超过总时限直接失败，确保上层 startRecording 能进 catch 清理
      if (Date.now() - loadStartedAt > totalDeadline) {
        logger.error(`[CommentRenderer] 页面加载总耗时超过 ${totalDeadline / 1000}s，放弃等待`);
        break;
      }
      if (!winAlive()) {
        logger.error('[CommentRenderer] 窗口已被销毁，无法继续加载');
        break;
      }
      try {
        const loadPromise = this.captureWindow.loadURL(this.liveUrl, {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        });
        // race 超时后 loadPromise 仍 pending，吞掉其后续 reject（stop 触发的 ERR_ABORTED）
        loadPromise.catch(() => {});
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`页面加载超时 (${loadTimeout / 1000}s)`)), loadTimeout);
        });

        await Promise.race([loadPromise, timeoutPromise]);
        pageLoadSuccess = true;
        logger.info(`[CommentRenderer] 页面加载成功 (尝试 ${attempt}/${maxRetries})`);
        break;
      } catch (loadErr) {
        logger.warn(`[CommentRenderer] 页面加载失败 (尝试 ${attempt}/${maxRetries}): ${loadErr.message}`);
        logger.warn(`[CommentRenderer] 加载失败详情: 错误类型=${loadErr.name || 'Unknown'}, 错误代码=${loadErr.code || 'N/A'}, 窗口存活=${winAlive()}`);
        if (!winAlive()) {
          logger.error('[CommentRenderer] 窗口已被销毁，无法继续加载');
          break;
        }

        // 超时/ERR_FAILED 时页面可能仍在后台加载：先终止挂起的导航，再带超时地探测 readyState
        logger.info('[CommentRenderer] 等待页面后台加载...');
        stopLoading();
        await new Promise(resolve => setTimeout(resolve, 1500));
        const isLoaded = await probeReady(probeTimeout);
        if (isLoaded) {
          logger.info('[CommentRenderer] 页面已在后台加载完成');
          pageLoadSuccess = true;
          break;
        }
        logger.warn(`[CommentRenderer] 后台加载探测未就绪 (尝试 ${attempt}/${maxRetries})`);

        // 还有重试机会：确保导航已停止后等待重试
        stopLoading();
        if (attempt < maxRetries) {
          logger.info(`[CommentRenderer] 等待 2 秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    if (!pageLoadSuccess) {
      throw new Error(`页面加载失败，已重试 ${maxRetries} 次（直播页持续加载超时，可能网络受限或触发风控）`);
    }

    // 开播捕捉前强制刷新一次页面（忽略缓存）：
    // 首次加载可能命中 session/磁盘缓存中的"直播已结束"旧快照（尤其下播后复播场景），
    // 强制刷新确保拿到开播后的实时页面，再进行评论区探测与捕捉
    logger.info('[CommentRenderer] 开播捕捉前强制刷新页面（忽略缓存），获取实时直播页面...');
    let refreshFinished = false;
    try {
      const reloaded = new Promise((resolve) => {
        const timer = setTimeout(resolve, 20000);
        this.captureWindow.webContents.once('did-finish-load', () => { clearTimeout(timer); refreshFinished = true; resolve(); });
      });
      this.captureWindow.webContents.reloadIgnoringCache();
      await reloaded;
      if (!this.captureWindow || this.captureWindow.isDestroyed()) {
        throw new Error('评论窗口已在刷新期间被销毁');
      }
      if (!refreshFinished) {
        // 20s 超时：页面导航仍 pending，必须主动终止——否则后续 executeJavaScript 会无限挂起（曾致整场 init 挂死、无任何录制产出）
        logger.warn('[CommentRenderer] 强制刷新20秒内未完成加载，终止挂起导航后等待页面渲染...');
        try { this.captureWindow.webContents.stop(); } catch (e) {}
        // 超时后页面可能还在渲染，额外等待 5 秒确保渲染完成（曾致整场弹幕区黑屏）
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } catch (e) {
      if (e && e.message === '评论窗口已在刷新期间被销毁') throw e;
      logger.warn('[CommentRenderer] 强制刷新页面异常（按当前页面继续初始化）:', e && e.message);
      try { if (this.captureWindow && !this.captureWindow.isDestroyed()) this.captureWindow.webContents.stop(); } catch (e2) {}
    }

    // 加载后再次确保静音（某些页面可能会重置静音状态）
    this.captureWindow.webContents.setAudioMuted(true);

    // 等待页面完全加载（额外等待确保动态内容渲染完成）
    logger.info('[CommentRenderer] 等待页面加载完成...');
    await new Promise(resolve => setTimeout(resolve, 10000)); // 从 8000ms 增加到 10000ms

    // 通过 DOM 探测评论区实际位置（不注入CSS，保持页面自然布局）
    let detectedRect = await this._detectCommentAreaFromDOM();
    if (detectedRect) {
      logger.info(`[CommentRenderer] DOM探测评论区: x=${detectedRect.x}, y=${detectedRect.y}, w=${detectedRect.width}, h=${detectedRect.height}`);
      
      // 验证评论区容器是否有内容（不是"直播已结束"状态）
      try {
        const hasContent = await this.captureWindow.webContents.executeJavaScript(`
          (function() {
            try {
              const ct = document.querySelector('[class*="webcast-chatroom"]') || 
                         document.querySelector('[data-e2e="live-chat"]') ||
                         document.querySelector('[class*="chat-list"]');
              if (!ct) return false;
              
              // 检查容器内是否有消息元素
              const messages = ct.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="danmu"]');
              if (messages.length > 0) return true;
              
              // 检查容器内是否有文本内容
              const text = (ct.innerText || '').trim();
              if (text.length > 10) return true;
              
              return false;
            } catch (e) {
              return false;
            }
          })()
        `);
        
        if (!hasContent) {
          logger.warn('[CommentRenderer] 评论区容器无内容，可能仍在加载中，等待 8 秒后重新检测...');
          await new Promise(resolve => setTimeout(resolve, 8000));
          detectedRect = await this._detectCommentAreaFromDOM();
          if (detectedRect) {
            logger.info(`[CommentRenderer] 重新检测后DOM探测评论区: x=${detectedRect.x}, y=${detectedRect.y}, w=${detectedRect.width}, h=${detectedRect.height}`);
          }
        }
      } catch (e) {
        logger.warn('[CommentRenderer] 评论区内容验证失败:', e && e.message);
      }
    } else {
      // 开播瞬间页面可能仍是"直播已结束"快照（服务端/CDN缓存延迟），
      // 若继续按右侧估算裁剪，整场录制右侧会停留在"猜你喜欢"推荐页。
      // 快速刷新重试最多3次（每次约15秒），争取录制一开始就拿到直播页
      for (let attempt = 1; attempt <= 3 && !detectedRect; attempt++) {
        if (!this.captureWindow || this.captureWindow.isDestroyed()) break;
        let pageEnded = false;
        try {
          pageEnded = await this.captureWindow.webContents.executeJavaScript(
            '/直播已结束/.test((document.body && document.body.innerText) || "")'
          );
        } catch (e) { break; }
        if (!pageEnded) break; // 非结束页：可能是结构变化，交给心跳自愈机制处理
        logger.warn(`[CommentRenderer] 页面仍显示"直播已结束"（开播快照延迟），快速刷新重试 (${attempt}/3)`);
        try {
          const reloaded = new Promise((resolve) => {
            const timer = setTimeout(resolve, 20000);
            this.captureWindow.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
          });
          this.captureWindow.webContents.reload();
          await reloaded;
          await new Promise((r) => setTimeout(r, 15000)); // 从 10000ms 增加到 15000ms
          if (!this.captureWindow || this.captureWindow.isDestroyed()) break;
          detectedRect = await this._detectCommentAreaFromDOM();
        } catch (e) {
          logger.warn('[CommentRenderer] 快速刷新重试异常:', e && e.message);
          break;
        }
      }
      if (detectedRect) {
        logger.info(`[CommentRenderer] 快速刷新后DOM探测成功: x=${detectedRect.x}, y=${detectedRect.y}, w=${detectedRect.width}, h=${detectedRect.height}`);
      } else {
        logger.info('[CommentRenderer] DOM探测失败，使用右侧区域估算');
      }
    }

    // 捕获页面尺寸
    let capturedSize = { width: 1920, height: 1040 };
    try {
      const probeImage = await this.captureWindow.webContents.capturePage();
      capturedSize = probeImage.getSize();
      logger.info(`[CommentRenderer] 页面捕获尺寸: ${capturedSize.width}x${capturedSize.height}`);
    } catch (e) {
      logger.warn('[CommentRenderer] 页面尺寸探测失败，使用默认值:', e.message);
    }

    // 计算裁剪区域：优先用 DOM 探测结果，否则用右侧估算
    if (detectedRect && detectedRect.width > 80 && detectedRect.height > 100) {
      // DOM 探测成功：使用探测到的评论区位置，扩展到页面底部
      this._commentRect = {
        x: detectedRect.x,
        y: 0,
        width: detectedRect.width,
        height: capturedSize.height
      };
    } else {
      // 回退：估算页面右侧区域（排除视频播放器）
      // 抖音直播页面布局：视频约占左侧60-70%，评论区在右侧30-40%
      const estimatedCommentWidth = Math.round(capturedSize.width * 0.30);
      const cropW = Math.max(300, Math.min(estimatedCommentWidth, 600));
      const cropX = capturedSize.width - cropW;
      this._commentRect = {
        x: cropX,
        y: 0,
        width: cropW,
        height: capturedSize.height
      };
    }
    logger.info(`[CommentRenderer] 评论区裁剪区域: x=${this._commentRect.x}, y=${this._commentRect.y}, w=${this._commentRect.width}, h=${this._commentRect.height}`);

    // 左侧特效区模式：在同一个离屏窗口中探测左侧特效区（公屏聊天/礼物栏）区域
    if (this.enableLeftPanel && this.leftPanelOutputDir) {
      if (!fs.existsSync(this.leftPanelOutputDir)) {
        fs.mkdirSync(this.leftPanelOutputDir, { recursive: true });
      }
      let leftDetected = null;
      try {
        leftDetected = await this._detectLeftPanelAreaFromDOM();
      } catch (e) {
        logger.warn('[CommentRenderer] 左侧特效区DOM探测异常:', e && e.message);
      }
      if (leftDetected && leftDetected.strategy === 'video-fullscreen-no-leftpanel') {
        // 直播画面占满左侧（vLeft<100）：该直播间左侧无独立特效区，禁用特效区捕获（回退双区域录制）
        this._leftPanelRect = null;
        logger.warn('[CommentRenderer] 检测到直播画面占满左侧，该直播间无独立特效区，已禁用特效区捕获');
      } else if (leftDetected && leftDetected.width > 80 && leftDetected.height > 100) {
        this._leftPanelRect = {
          x: leftDetected.x,
          y: 0,
          width: leftDetected.width,
          height: capturedSize.height
        };
        logger.info(`[CommentRenderer] 左侧特效区DOM探测成功: x=${leftDetected.x}, w=${leftDetected.width}, h=${this._leftPanelRect.height}`);
      } else {
        // 回退：布局与评论区左右对称，左侧特效区取页面最左侧与评论区同宽区域
        this._leftPanelRect = {
          x: 0,
          y: 0,
          width: Math.min(this._commentRect.width, Math.round(capturedSize.width * 0.4)),
          height: capturedSize.height
        };
        logger.info(`[CommentRenderer] 左侧特效区DOM探测未命中，使用对称估算: x=0, w=${this._leftPanelRect.width}, h=${this._leftPanelRect.height}`);
      }
    }

    // 保存调试截图
    try {
      const fs = require('fs');
      fs.mkdirSync(this.debugDir, { recursive: true });

      const debugImage = await this.captureWindow.webContents.capturePage();
      const debugPath = path.join(this.debugDir, 'debug_full_page.png');
      fs.writeFileSync(debugPath, debugImage.toPNG());
      logger.info(`[CommentRenderer] 完整页面截图已保存: ${debugPath}`);

      const r = this._commentRect;
      const safeW = Math.min(r.width, capturedSize.width - r.x);
      const safeH = Math.min(r.height, capturedSize.height - r.y);
      if (safeW > 0 && safeH > 0) {
        const commentCrop = await this.captureWindow.webContents.capturePage({
          x: r.x, y: r.y, width: safeW, height: safeH
        });
        const commentPath = path.join(this.debugDir, 'debug_comment_area.png');
        fs.writeFileSync(commentPath, commentCrop.toPNG());
        logger.info(`[CommentRenderer] 评论区截图已保存: ${commentPath}`);
      }

      // 左侧特效区调试截图
      if (this.enableLeftPanel && this._leftPanelRect) {
        const lp = this._leftPanelRect;
        const safeLpW = Math.min(lp.width, capturedSize.width - lp.x);
        const safeLpH = Math.min(lp.height, capturedSize.height - lp.y);
        if (safeLpW > 0 && safeLpH > 0) {
          const lpCrop = await this.captureWindow.webContents.capturePage({
            x: lp.x, y: lp.y, width: safeLpW, height: safeLpH
          });
          const lpPath = path.join(this.debugDir, 'debug_left_panel_area.png');
          fs.writeFileSync(lpPath, lpCrop.toPNG());
          logger.info(`[CommentRenderer] 左侧特效区截图已保存: ${lpPath}`);
        }
      }
    } catch (e) {
      logger.warn('[CommentRenderer] 调试截图保存失败:', e.message);
    }

    // 注入评论区心跳检测脚本：每5秒检测容器是否存在，用于触发自愈刷新
    try {
      const hbRet = await this.captureWindow.webContents.executeJavaScript(HEARTBEAT_SCRIPT);
      logger.info(`[CommentRenderer] 心跳检测脚本注入结果: ${hbRet}`);
    } catch (e) {
      logger.warn('[CommentRenderer] 心跳检测脚本注入失败:', e.message);
    }

    // 注入评论区时间戳显示脚本：在评论区顶部显示当前录制时间
    try {
      const tsRet = await this.captureWindow.webContents.executeJavaScript(TIMESTAMP_SCRIPT);
      logger.info(`[CommentRenderer] 时间戳脚本注入结果: ${tsRet}`);
    } catch (e) {
      logger.warn('[CommentRenderer] 时间戳脚本注入失败:', e.message);
    }

    logger.info('[CommentRenderer] 初始化完成');

  }

  /**
   * 评论区容器持续缺失时判断是否触发自愈刷新
   * - 容器连续 12 次心跳(约60s)未找到 → 认为页面失效（典型场景：页面卡在"直播已结束"，主播实际在播）
   * - 限频：两次刷新间隔 >= 90s；单场录制最多刷新 10 次；仅在捕获中执行
   */
  _maybeReloadDeadPage(pageShowsEnded) {
    try {
      if (!this.capturing) return;
      if (this._reloading) return;
      if ((this._noContainerStreak || 0) < 12) return;
      const now = Date.now();
      if (this._lastReloadAt && now - this._lastReloadAt < 90000) return;
      if ((this._reloadCount || 0) >= 10) {
        if (!this._reloadCapWarned) {
          this._reloadCapWarned = true;
          logger.warn('[CommentRenderer] 本场自愈刷新已达10次上限，后续容器缺失不再自动刷新（可停止录制后重新开始以重置）');
        }
        return;
      }
      logger.warn(`[CommentRenderer] 评论区容器持续缺失约60s${pageShowsEnded ? '（页面显示直播已结束）' : ''}，触发页面刷新自愈`);
      this._reloadPageForRecovery().catch((e) => {
        logger.warn('[CommentRenderer] 页面自愈刷新异常:', e && e.message);
      });
    } catch (e) {}
  }

  /**
   * 刷新评论页面并恢复捕获状态：
   * reload → 等待加载完成 → 等待动态渲染 → 重注入礼物横幅/心跳脚本 → 重新 DOM 探测评论区并更新裁剪区域
   */
  async _reloadPageForRecovery() {
    if (this._reloading) return;
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;
    this._reloading = true;
    this._noContainerStreak = 0;
    this._lastReloadAt = Date.now();
    this._reloadCount = (this._reloadCount || 0) + 1;
    const wc = this.captureWindow.webContents;
    try {
      logger.warn(`[CommentRenderer] 刷新评论页面（第${this._reloadCount}次）以恢复评论区渲染`);
      // 先注册加载完成监听再 reload，避免快速缓存页面在注册前触发事件导致等到超时
      const reloaded = new Promise((resolve) => {
        const timer = setTimeout(resolve, 20000);
        wc.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
      });
      wc.reload();
      // 等待本次加载完成（带超时，防止导航挂起）
      await reloaded;
      // 等待动态内容渲染（评论区为异步渲染）
      await new Promise((r) => setTimeout(r, 8000));
      if (!this.capturing || this.captureWindow.isDestroyed()) return;

      // 刷新后页面脚本与样式全部丢失，需恢复与 init 一致的状态：
      // 1) 重新注入评论区隐藏 CSS（否则视频播放器/导航重新渲染，布局漂移且浪费资源）
      await this._injectCommentOnlyCSS();
      // 2) 重新注入心跳检测脚本
      try {
        const hbRet = await this.captureWindow.webContents.executeJavaScript(HEARTBEAT_SCRIPT);
        logger.info(`[CommentRenderer] 自愈刷新后心跳检测脚本注入结果: ${hbRet}`);
      } catch (e) {
        logger.warn('[CommentRenderer] 自愈刷新后心跳检测脚本注入失败:', e.message);
      }
      // 3) 重新注入时间戳显示脚本
      try {
        const tsRet = await this.captureWindow.webContents.executeJavaScript(TIMESTAMP_SCRIPT);
        logger.info(`[CommentRenderer] 自愈刷新后时间戳脚本注入结果: ${tsRet}`);
      } catch (e) {
        logger.warn('[CommentRenderer] 自愈刷新后时间戳脚本注入失败:', e.message);
      }

      // 重新探测评论区位置，更新裁剪区域（页面布局可能变化）
      let detectedRect = await this._detectCommentAreaFromDOM();
      if ((!detectedRect || detectedRect.width <= 80 || detectedRect.height <= 100)
          && this.capturing && !this.captureWindow.isDestroyed()) {
        // 评论区异步渲染可能慢于8秒等待，延迟10秒重试一次，避免整场沿用过期裁剪区
        logger.info('[CommentRenderer] 刷新后首次探测未命中，10秒后重试探测...');
        await new Promise((r) => setTimeout(r, 10000));
        if (this.capturing && !this.captureWindow.isDestroyed()) {
          detectedRect = await this._detectCommentAreaFromDOM();
        }
      }
      if (detectedRect && detectedRect.width > 80 && detectedRect.height > 100) {
        let pageH = this._commentRect ? this._commentRect.height : 1040;
        try {
          const img = await wc.capturePage();
          pageH = img.getSize().height || pageH;
        } catch (e) {}
        this._commentRect = {
          x: detectedRect.x,
          y: 0,
          width: detectedRect.width,
          height: pageH
        };
        logger.info(`[CommentRenderer] 刷新后重新探测评论区: x=${this._commentRect.x}, w=${this._commentRect.width}, h=${this._commentRect.height}`);
      } else {
        logger.warn('[CommentRenderer] 刷新后评论区探测仍失败，保持原裁剪区域，等待下一轮心跳判定');
      }
    } catch (e) {
      logger.warn('[CommentRenderer] 页面自愈刷新失败:', e && e.message);
    } finally {
      this._reloading = false;
    }
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

            /* 不隐藏 canvas：礼物特效（火箭/跑车/连击/全屏动画等）渲染在 canvas/WebGL 上，
               隐藏会直接抹掉礼物动画。视频区域已随父容器隐藏，其内部 canvas 自动不可见 */

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
   * 探测左侧特效区（公屏聊天）位置
   * 抖音竖屏直播页面为左-中-右三栏：左侧=公屏聊天/礼物栏，中间=视频，右侧=评论区
   */
  async _detectLeftPanelAreaFromDOM() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return null;
    try {
      const jsPromise = this.captureWindow.webContents.executeJavaScript(`
        (function() {
          const pageW = document.documentElement.clientWidth || window.innerWidth;
          const pageH = document.documentElement.clientHeight || window.innerHeight;
          const pageCenterX = pageW / 2;

          // 穿透 Shadow DOM，递归收集所有 video/canvas 元素
          // （抖音直播播放器用 Shadow DOM 封装，普通 querySelector 查不到内部 video）
          function collectMedia(root, acc) {
            if (!root || !root.querySelectorAll) return;
            try {
              const media = root.querySelectorAll('video, canvas');
              for (let i = 0; i < media.length; i++) acc.push(media[i]);
              const all = root.querySelectorAll('*');
              for (let i = 0; i < all.length; i++) {
                if (all[i].shadowRoot) collectMedia(all[i].shadowRoot, acc);
              }
            } catch(e) {}
          }

          // 穿透 Shadow DOM，判断元素内部是否包含 video/canvas
          function containsMediaDeep(el) {
            try {
              if (el.querySelector('video, canvas')) return true;
              const all = el.querySelectorAll('*');
              for (let i = 0; i < all.length; i++) {
                const sr = all[i].shadowRoot;
                if (sr) {
                  if (sr.querySelector('video, canvas')) return true;
                  const deep = sr.querySelectorAll('*');
                  for (let j = 0; j < deep.length; j++) {
                    if (deep[j].shadowRoot && deep[j].shadowRoot.querySelector('video, canvas')) return true;
                  }
                }
              }
            } catch(e) {}
            return false;
          }

          // 参考：右侧评论区宽度（限制特效区宽度上限，避免把中间直播画面包进来）
          let commentRefW = 0;
          try {
            const cr = document.querySelector('[class*="webcast-chatroom"], [id*="chatroom"], [class*="ChatRoom"], [class*="chat-room"]');
            if (cr) { const rr = cr.getBoundingClientRect(); if (rr.left > pageCenterX && rr.width > 80) commentRefW = rr.width; }
          } catch(e) {}
          if (!commentRefW) commentRefW = Math.round(pageW * 0.21);
          // 特效区宽度上限：不超过评论区宽度的1.4倍，且不超过页面34%
          const maxLeftW = Math.min(Math.round(commentRefW * 1.4), Math.round(pageW * 0.34));

          // 策略1: 直播主画面（穿透 Shadow DOM 找到面积最大的 video/canvas）的左边界 = 特效区右边界
          // 竖屏直播画面在中间，其左边界即左侧公屏弹幕区的右边界，最精确
          const mediaEls = [];
          collectMedia(document, mediaEls);
          let mainMedia = null, maxArea = 0;
          for (const el of mediaEls) {
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < pageH * 0.2) continue;
            const area = r.width * r.height;
            if (area > maxArea) { maxArea = area; mainMedia = r; }
          }
          if (mainMedia) {
            const vLeft = Math.round(mainMedia.left);
            // 视频左边界在页面中部偏左：左侧存在独立特效区，取 [0, vLeft]
            if (vLeft >= 100 && vLeft < pageCenterX) {
              if (vLeft <= maxLeftW) return { x: 0, width: vLeft, strategy: 'video-left-bound' };
              // 视频左边界超出上限，按上限收敛（防止误包直播画面）
              return { x: 0, width: maxLeftW, strategy: 'video-left-bound-clamped' };
            }
            // 视频几乎占满左侧（vLeft < 100）：该直播间左侧无独立特效区（视频即背景）
            // 返回 width=0，让上层走对称估算回退，避免误选整屏视频容器
            if (vLeft < 100) {
              return { x: 0, width: 0, strategy: 'video-fullscreen-no-leftpanel' };
            }
          }

          // 策略2: 沿评论区左侧兄弟链取最左侧非视频节点（穿透排除视频容器）
          const roomSelectors = [
            '[class*="webcast-chatroom"]',
            '[id*="chatroom"]',
            '[class*="chat-room"]',
            '[class*="ChatRoom"]'
          ];
          let commentRoot = null;
          for (const sel of roomSelectors) {
            try {
              const els = document.querySelectorAll(sel);
              for (const el of els) {
                const rect = el.getBoundingClientRect();
                if (rect.left > pageCenterX) { commentRoot = el; break; }
              }
            } catch(e) {}
            if (commentRoot) break;
          }
          if (commentRoot) {
            let node = commentRoot.previousElementSibling;
            while (node) {
              const rect = node.getBoundingClientRect();
              if (rect.width > 80 && rect.width <= maxLeftW && !containsMediaDeep(node) && rect.right <= pageCenterX + 30) {
                return { x: Math.max(0, Math.round(rect.left)), width: Math.round(rect.width), strategy: 'prev-of-comment' };
              }
              node = node.previousElementSibling;
            }
          }

          // 策略3: 页面左侧文字密集的可见 div（弹幕区特征：文字多、相对紧凑，穿透排除视频容器）
          let best = null;
          let bestScore = 0;
          const allDivs = document.querySelectorAll('div');
          for (const div of allDivs) {
            const rect = div.getBoundingClientRect();
            if (rect.left >= pageCenterX) continue;
            if (rect.right <= 0) continue;
            if (rect.width < 120 || rect.width > maxLeftW || rect.height < 150) continue;
            if (containsMediaDeep(div)) continue;
            if (div.closest('header, nav, [class*="header"], [class*="Header"], [class*="navbar"], [class*="Navbar"]')) continue;
            const style = window.getComputedStyle(div);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const text = (div.innerText || '').trim();
            if (text.length < 15) continue; // 弹幕区必须有足够文字，排除纯视频背景容器
            const area = rect.width * rect.height;
            const density = text.length / area;
            // 以文字量为主、密度为辅（避免大面积视频容器胜出）
            const score = text.length * 10 + density * 200000;
            if (score > bestScore) {
              bestScore = score;
              best = { x: Math.max(0, Math.round(rect.left)), width: Math.round(rect.width), strategy: 'largest-left-div' };
            }
          }
          return best;
        })();
      `);
      jsPromise.catch(() => {});
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('__PROBE_TIMEOUT__'), 8000));
      const raced = await Promise.race([jsPromise, timeoutPromise]);
      if (raced === '__PROBE_TIMEOUT__') {
        logger.warn('[CommentRenderer] 左侧特效区DOM探测超时(8s)');
        return null;
      }
      if (raced && raced.width > 80) {
        logger.info(`[CommentRenderer] 左侧特效区DOM探测策略: ${raced.strategy || 'unknown'}`);
        return { x: raced.x, y: 0, width: raced.width, height: 1040 };
      }
    } catch (e) {
      logger.warn('[CommentRenderer] 左侧特效区DOM探测失败:', e && e.message);
    }
    return null;
  }

  /**
   * 通过 DOM 探测评论区容器的实际位置（不依赖 CSS 注入）
   * 策略：查找页面右侧的聊天/评论容器元素
   */
  async _detectCommentAreaFromDOM() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return null;

    try {
      // 超时兜底：页面导航 pending 时 executeJavaScript 会无限挂起（曾致 init 挂死整场无产出），8s 未返回按探测失败处理
      const jsPromise = this.captureWindow.webContents.executeJavaScript(`
        (function() {
          const pageW = document.documentElement.clientWidth || window.innerWidth;
          const pageH = document.documentElement.clientHeight || window.innerHeight;
          const pageCenterX = pageW / 2;

          // 策略1: 通过常见评论区选择器查找
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
            '[class*="interact-container"]', '[class*="InteractContainer"]',
            '[class*="scaffold-right"]', '[class*="ScaffoldRight"]',
            '[class*="right-side"]', '[class*="RightSide"]',
            '[class*="side-panel"]', '[class*="SidePanel"]',
            '[class*="live-side"]', '[class*="LiveSide"]'
          ];

          for (const sel of commentSelectors) {
            try {
              const els = document.querySelectorAll(sel);
              for (const el of els) {
                const rect = el.getBoundingClientRect();
                // 评论区应在页面右侧、宽度>80、高度>200
                if (rect.left > pageCenterX && rect.width > 80 && rect.height > 200) {
                  return {
                    x: Math.round(rect.left),
                    y: 0,
                    width: Math.round(rect.width),
                    height: pageH,
                    selector: sel,
                    strategy: 'selector'
                  };
                }
              }
            } catch(e) {}
          }

          // 策略2: 查找页面右侧面积最大的可见 div（排除 video 和 canvas）
          let best = null;
          let bestArea = 0;
          const allDivs = document.querySelectorAll('div');
          for (const div of allDivs) {
            const rect = div.getBoundingClientRect();
            // 必须在页面右侧
            if (rect.left < pageCenterX) continue;
            if (rect.width < 80 || rect.height < 200) continue;
            // 排除过大的元素（可能是 body 容器）
            const area = rect.width * rect.height;
            if (area > pageW * pageH * 0.85) continue;
            // 排除 video/canvas 元素
            if (div.querySelector('video') || div.querySelector('canvas')) continue;
            // 排除 display:none 的元素
            const style = window.getComputedStyle(div);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            if (area > bestArea) {
              bestArea = area;
              best = {
                x: Math.round(rect.left),
                y: 0,
                width: Math.round(rect.width),
                height: pageH,
                strategy: 'largest-right-div'
              };
            }
          }
          if (best) return best;

          // 策略3: 查找页面右侧包含聊天消息文本的元素
          const chatKeywords = ['欢迎来到', '直播间', '聊天', '消息'];
          for (const div of allDivs) {
            const rect = div.getBoundingClientRect();
            if (rect.left < pageCenterX || rect.width < 80 || rect.height < 200) continue;
            const text = div.textContent || '';
            const hasChatText = chatKeywords.some(kw => text.includes(kw));
            if (hasChatText) {
              const area = rect.width * rect.height;
              if (area < pageW * pageH * 0.7) {
                return {
                  x: Math.round(rect.left),
                  y: 0,
                  width: Math.round(rect.width),
                  height: pageH,
                  strategy: 'chat-text'
                };
              }
            }
          }

          return null;
        })();
      `);
      jsPromise.catch(() => {}); // race 超时后吞掉其后续 reject
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('__PROBE_TIMEOUT__'), 8000));
      const raced = await Promise.race([jsPromise, timeoutPromise]);
      if (raced === '__PROBE_TIMEOUT__') {
        logger.warn('[CommentRenderer] DOM探测超时(8s, 页面导航可能仍pending)，按探测失败处理');
        try { this.captureWindow.webContents.stop(); } catch (e) {}
        return null;
      }
      const result = raced;

      if (result && result.width > 80 && result.height > 100) {
        logger.info(`[CommentRenderer] DOM探测策略: ${result.strategy || 'unknown'}, selector: ${result.selector || 'N/A'}`);
        return { x: result.x, y: result.y, width: result.width, height: result.height };
      }
    } catch (e) {
      logger.warn('[CommentRenderer] DOM探测失败:', e.message);
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

    this._timestamps = [];

    // 页面自愈状态（容器缺失自愈刷新）：每个录制会话重置
    this._noContainerStreak = 0;
    this._reloadCount = 0;
    this._lastReloadAt = 0;
    this._reloading = false;
    this._reloadCapWarned = false;

    logger.info(`[CommentRenderer] 开始捕获评论区帧, 固定FPS: ${this.targetFps}（全程固定，不因礼物提帧）, 输出目录: ${this.outputDir}`);
    logger.info(`[CommentRenderer] 裁剪区域: x=${this._commentRect.x}, y=${this._commentRect.y}, w=${this._commentRect.width}, h=${this._commentRect.height}`);

    // 基准帧间隔 vs 礼物动画帧间隔
    this._baseInterval = Math.floor(1000 / this.targetFps);
    let capturing = false;

    const captureFrame = async () => {
      if (!this.capturing || !this.captureWindow || this.captureWindow.isDestroyed()) {
        return;
      }

      // 防止重入
      if (capturing) {
        if (this.capturing) {
          this._captureTimer = setTimeout(captureFrame, this._baseInterval);
        }
        return;
      }

      capturing = true;
      const now = Date.now();

      try {
        // 捕获完整页面
        const image = await this.captureWindow.webContents.capturePage();
        const imgSize = image.getSize();

        // 使用前10帧记录裁剪信息
        if (this.frameCount < 10) {
          logger.info(`[CommentRenderer] 帧#${this.frameCount + 1} 页面尺寸: ${imgSize.width}x${imgSize.height}, 裁剪区域: x=${this._commentRect?.x || 'N/A'}, y=${this._commentRect?.y || 'N/A'}, w=${this._commentRect?.width || 'N/A'}, h=${this._commentRect?.height || 'N/A'}`);
        }

        // 使用探测到的评论区位置进行裁剪
        let cropX, cropY, cropW, cropH;
        if (this._commentRect) {
          const r = this._commentRect;
          cropX = Math.max(0, r.x);
          cropY = Math.max(0, r.y);
          cropW = Math.min(r.width, imgSize.width - cropX);
          cropH = Math.min(r.height, imgSize.height - cropY);
        } else {
          // 兜底：取页面右侧 500px
          const fallbackW = 500;
          cropX = Math.max(0, imgSize.width - fallbackW);
          cropY = 0;
          cropW = fallbackW;
          cropH = imgSize.height;
        }

        let croppedImage;
        if (cropW <= 10 || cropH <= 10 || cropX >= imgSize.width) {
          // 裁剪区域无效，使用整个页面
          logger.warn(`[CommentRenderer] 裁剪区域无效 (cropW=${cropW}, cropH=${cropH}, cropX=${cropX}, imgW=${imgSize.width})，使用整个页面`);
          croppedImage = image;
        } else {
          croppedImage = image.crop({
            x: cropX,
            y: cropY,
            width: cropW,
            height: cropH
          });
        }

        // 保存为 JPEG（编号从 frameStartIndex 续起，避免覆盖续帧前的历史帧）
        const absFrame = this.frameStartIndex + this.frameCount;
        const jpegData = croppedImage.toJPEG(CAPTURE_QUALITY);
        const framePath = path.join(
          this.outputDir,
          `frame_${String(absFrame).padStart(6, '0')}.jpg`
        );
        
        // 确保目录存在（防御性检查）
        if (!fs.existsSync(this.outputDir)) {
          fs.mkdirSync(this.outputDir, { recursive: true });
        }
        
        fs.writeFileSync(framePath, jpegData);

        // 左侧特效区模式：对同一帧页面图像裁剪左侧特效区并保存
        if (this.enableLeftPanel && this._leftPanelRect && this.leftPanelOutputDir) {
          try {
            const lp = this._leftPanelRect;
            const lpCropW = Math.min(lp.width, imgSize.width - lp.x);
            const lpCropH = Math.min(lp.height, imgSize.height - lp.y);
            let lpImage = image;
            if (lpCropW > 10 && lpCropH > 10 && lp.x < imgSize.width) {
              lpImage = image.crop({ x: lp.x, y: lp.y, width: lpCropW, height: lpCropH });
            }
            const lpFrame = String(this._leftPanelFrameCount).padStart(6, '0');
            const lpPath = path.join(this.leftPanelOutputDir, `left_frame_${lpFrame}.jpg`);
            if (!fs.existsSync(this.leftPanelOutputDir)) {
              fs.mkdirSync(this.leftPanelOutputDir, { recursive: true });
            }
            fs.writeFileSync(lpPath, lpImage.toJPEG(CAPTURE_QUALITY));
            this._leftPanelFrameCount++;
          } catch (lpErr) {
            if (!lpErr.message.includes('destroyed')) {
              logger.warn('[CommentRenderer] 捕获左侧特效区帧出错:', lpErr.message);
            }
          }
        }

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

      // 记录帧时间戳（相对捕获开始，供合并精确控时）
      this._timestamps.push(this.frameCount ? Date.now() - this._captureStartTime : 0);

      // 安排下一次捕获：全程使用固定帧率
      if (this.capturing) {
        const elapsed = Date.now() - now;
        const nextDelay = Math.max(0, this._baseInterval - elapsed);
        this._captureTimer = setTimeout(captureFrame, nextDelay);
      }
    };

    // 启动账号冲突检测（仅对有账号模式且注册了回调时启用）
    if (this.onAccountConflict && !this.noLoginMode) {
      this._startAccountConflictDetection();
    }

    // 启动捕获循环
    this._captureTimer = setTimeout(captureFrame, this._baseInterval);
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
    const absoluteCount = this.frameStartIndex + this.frameCount;

    // 保存帧时间戳列表，供合并精确控时（动态帧率必需）
    // 续帧场景：已有历史 timestamps 时追加，保证时间轴连续、与帧号一一对应
    if (this.outputDir && this._timestamps && this._timestamps.length) {
      try {
        const fs = require('fs');
        const tsPath = path.join(this.outputDir, 'timestamps.json');
        let merged = this._timestamps;
        if (this.frameStartIndex > 0) {
          // 读入续帧前已保存的历史时间戳，若长度不小于续帧起点则保持（历史已含在绝对时间轴上）
          try {
            const prevRaw = fs.readFileSync(tsPath, 'utf8');
            const prev = JSON.parse(prevRaw);
            if (Array.isArray(prev)) {
              // 历史帧数为 frameStartIndex，若历史长度匹配则以历史为基准追加本次增量
              const tail = prev.length >= this.frameStartIndex ? prev.slice(0, this.frameStartIndex) : prev;
              const lastT = tail.length ? tail[tail.length - 1] : 0;
              merged = tail.concat(this._timestamps.map((t) => t + lastT));
            }
          } catch (e) {
            // 历史读取失败时直接使用本次（保持简单，避免覆盖坏数据）
          }
        }
        fs.writeFileSync(tsPath, JSON.stringify(merged), 'utf8');
      } catch (e) {
        logger.warn('[CommentRenderer] 写 timestamps.json 失败:', e.message);
      }
    }

    logger.info(
      `[CommentRenderer] 停止捕获, 本期帧数: ${this.frameCount}, 累计帧数: ${absoluteCount}, ` +
      `时长: ${(duration / 1000).toFixed(1)}s, 实际FPS: ${actualFps.toFixed(1)}`
    );

    // 左侧特效区信息（供合并端使用）
    let leftPanelInfo = null;
    if (this.enableLeftPanel && this._leftPanelFrameCount > 0 && this.leftPanelOutputDir) {
      leftPanelInfo = {
        frameCount: this._leftPanelFrameCount,
        outputDir: this.leftPanelOutputDir,
        fps: this.targetFps,
        duration: duration,
        width: this._leftPanelRect ? this._leftPanelRect.width : (this._commentRect ? this._commentRect.width : 400),
        height: this._leftPanelRect ? this._leftPanelRect.height : (this._commentRect ? this._commentRect.height : 720)
      };
      logger.info(`[CommentRenderer] 停止捕获, 左侧特效区帧数: ${leftPanelInfo.frameCount}, 目录: ${leftPanelInfo.outputDir}`);
    }

    return {
      frameCount: absoluteCount,
      outputDir: this.outputDir,
      fps: actualFps,
      duration: duration,
      timestamps: this._timestamps || [],
      width: this._commentRect ? this._commentRect.width : COMMENT_WIDTH,
      height: this._commentRect ? this._commentRect.height : COMMENT_HEIGHT,
      leftPanelInfo: leftPanelInfo
    };
  }


  /**
   * 启动账号冲突检测（防呆）：周期性检查评论区页面是否提示"已在其它设备登录"
   * 若检测到（两个直播间用同一账号先后开播，后开播的会把先开播的顶下线），
   * 触发 onAccountConflict 回调，供外部将本直播间评论区回滚为无账号模式，避免评论区录制断档。
   * 检测有连续次数去抖，避免页面初次加载抖动导致误触发。
   */
  _startAccountConflictDetection() {
    this._stopAccountConflictDetection();
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    const ACCOUNT_CONFLICT_SCRIPT = `(() => {
      try {
        const txt = (document.body && document.body.innerText) || '';
        // 匹配抖音"账号已在其它设备登录/被顶下线"典型提示语
        if (/(已在其他?设备登录|已在其它设备登录|在其他?设备（上|)登录|账号.{0,6}下线|登录.{0,4}失效|当前账号在.{0,10}登录|session.{0,10}expire|账号被挤下线)/i.test(txt)) return true;
        // 抖音被同账号其它端顶下线时的实际弹层文案
        if (/(账号已在其他?地方进入直播间|账号已在其它地方进入直播间|已退出直播间|无法评论)/.test(txt)) return true;
        // 检测页面出现引导重新登录/二维码覆盖等被强制登出特征
        if (/(请重新登录|登录已过期|重新登录\.{0,3}扫码)/.test(txt)) return true;
        return false;
      } catch (e) { return false; }
    })()`;

    this._conflictHit = 0;
    this._conflictTimer = setInterval(() => {
      if (!this.capturing || !this.captureWindow || this.captureWindow.isDestroyed()) {
        this._stopAccountConflictDetection();
        return;
      }
      this.captureWindow.webContents
        .executeJavaScript(ACCOUNT_CONFLICT_SCRIPT, true)
        .then((hit) => {
          if (!hit) {
            this._conflictHit = 0; // 恢复，取消累积
            return;
          }
          this._conflictHit = (this._conflictHit || 0) + 1;
          // 连续检测到 2 次（约 2×5s）才判定冲突，降低误报
          if (this._conflictHit >= 2) {
            logger.warn('[CommentRenderer] 检测到评论区账号已被其它设备登录（账号冲突），执行防呆回滚');
            this._stopAccountConflictDetection();
            if (typeof this.onAccountConflict === 'function') {
              try { this.onAccountConflict(); } catch (e) { logger.error('[CommentRenderer] onAccountConflict 回调异常:', e.message); }
            }
          }
        })
        .catch(() => {});
    }, 5000);
  }

  _stopAccountConflictDetection() {
    if (this._conflictTimer) {
      clearInterval(this._conflictTimer);
      this._conflictTimer = null;
    }
  }



  /**
   * 清理所有资源
   */
  async destroy() {
    this.stopCapture();
    this._stopAccountConflictDetection();

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
