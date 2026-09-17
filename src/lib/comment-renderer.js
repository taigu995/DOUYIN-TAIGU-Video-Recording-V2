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

// 礼物/连击/进场特效检测脚本（在直播页面内执行，返回是否有送礼特效）
const GIFT_DETECT_SCRIPT = `(() => {
  try {
    const b = document.body;
    if (!b || !b.innerText) return false;
    const txt = b.innerText.slice(-5000);
    // 送礼/连击/飞屏特征文字
    const hasGiftTxt = /送出[\\s\\S]{0,8}(×|x|X)?\\s*\\d*|\\b连击\\b|飞屏|打赏|礼物/.test(txt);
    // 可见的礼物/开屏/特效动画容器（宽度在 30~800 之间、有子元素即认为正在播放）
    let visibleAnim = false;
    const sel = '[class*="gift" i],[class*="Gift"],[class*="anim" i],[class*="Anim"],[class*="effect" i],[class*="Effect"],[class*="screen" i],[class*="Screen"]';
    const nodes = b.querySelectorAll(sel);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.children || !n.children.length || !n.getBoundingClientRect) continue;
      const r = n.getBoundingClientRect();
      if (r.width > 30 && r.height > 30 && r.width < 900 && r.height < 900) { visibleAnim = true; break; }
    }
    return hasGiftTxt || visibleAnim;
  } catch (e) { return false; }
})()`;

// 礼物横幅注入脚本：常驻监听评论区礼物消息，提炼"谁送的什么礼物+图标"提示条
// 横幅作为 DOM 元素插入评论区顶部，天然被帧捕获录进画面
const GIFT_BANNER_SCRIPT = `(() => {
  try {
    if (window.__giftBannerInstalled) return 'already';
    window.__giftBannerInstalled = true;

    const lastKey = new Set();
    let lastMsgCount = 0;

    // 从一条礼物消息文本里解析 昵称/礼物名/数量
    function parseGiftText(text) {
      const t = (text || '').replace(/\\s+/g, ' ').trim();
      const m = t.match(/^([\\s\\S]{1,20}?)\\s*(送出|赠送|打赏|送出了)\\s*([\\s\\S]{1,20}?)\\s*(×|x|X)\\s*(\\d+)/);
      const m2 = t.match(/^([\\s\\S]{1,20}?)\\s*(送出|赠送|打赏|送出了)\\s*([\\s\\S]{1,20})$/);
      const hit = m || m2;
      if (!hit) return null;
      let nick = (hit[1] || '').trim();
      const gname = (hit[3] || '').trim();
      const num = hit[5] ? parseInt(hit[5], 10) : 1;
      if (!num) return null;
      return { nick, gift: gname || '礼物', num, count: num, raw: t };
    }

    function roundRect(r, p) {
      const o = Math.floor(p / 2);
      const b = p % 2;
      return { x: Math.round(r.x) + o, y: Math.round(r.y) + o, w: Math.floor(r.width - p) - b, h: Math.floor(r.height - p) - b };
    }

    // 创建横幅 DOM 并渲染到评论区容器顶部
    function renderBanner(data, iconSrc) {
      // 找到评论区容器（复用现有定位）
      const ct = window.__commentBannerRoot || (function(){
        const sels = ['[class*="chat-list"]','[class*="ChatList"]','[class*="message-list"]','[class*="MessageList"]','[class*="chat-container"]','[data-e2e="live-chat"]','[data-e2e="chat-room"]'];
        for (const s of sels) { const el = document.querySelector(s); if (el) return el; }
        return null;
      })();
      if (ct) { window.__commentBannerRoot = ct; } else { return; }

      // 复用或新建横幅容器
      let box = document.getElementById('dylive-gift-banner');
      if (!box) {
        box = document.createElement('div');
        box.id = 'dylive-gift-banner';
        box.style.cssText = 'position:relative;z-index:9999;padding:6px 0;flex:none;shrink:0;';
        const parent = ct.parentNode || ct;
        if (ct.nextSibling) parent.insertBefore(box, ct.nextSibling);
        else parent.appendChild(box);
      }

      // 清空并填充
      box.innerHTML = '';
      const inner = document.createElement('div');
      inner.style.cssText = 'display:flex;align-items:center;gap:8px;background:rgba(0,0,0,0.72);';
      inner.style.cssText += 'border:1px solid #ff3b57;border-radius:8px;padding:8px 12px;color:#fff;font-size:14px;box-shadow:0 2px 12px rgba(0,0,0,0.4);backdrop-filter:blur(2px);';

      const icon = document.createElement('img');
      icon.alt = '礼物';
      icon.style.cssText = 'width:28px;height:28px;border-radius:6px;object-fit:cover;background:#ff3b5718;flex:none;';
      icon.src = iconSrc || 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect width="28" height="28" rx="6" fill="#ff3b57"/><text x="14" y="20" font-size="16" fill="#fff" text-anchor="middle">🎁</text></svg>');

      const txt = document.createElement('div');
      txt.style.cssText = 'display:flex;flex-direction:column;justify-content:center;line-height:1.15;min-width:0;';
      const name = document.createElement('div');
      name.style.cssText = 'font-weight:700;color:#ffd24d;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px;';
      name.textContent = data.nick || '';
      const act = document.createElement('div');
      act.style.cssText = 'color:#fff;font-size:13px;';
      act.textContent = '送出 ' + (data.gift || '礼物') + (data.num > 1 ? ' ×' + data.num : '');

      inner.appendChild(icon);
      txt.appendChild(name);
      txt.appendChild(act);
      inner.appendChild(txt);
      box.appendChild(inner);

      // 动画：进入 + 3秒后淡出
      inner.style.transition = 'opacity .6s ease, transform .6s ease';
      inner.style.opacity = '0';
      inner.style.transform = 'translateY(-8px)';
      requestAnimationFrame(() => { inner.style.opacity = '1'; inner.style.transform = 'translateY(0)'; });

      if (data.__timer) clearTimeout(data.__timer);
      data.__timer = setTimeout(() => {
        inner.style.opacity = '0';
        inner.style.transform = 'translateY(-8px)';
        setTimeout(() => { if (box && box.parentNode) box.remove(); }, 650);
      }, 3000);
    }

    // 在礼物消息节点里找礼物图标
    function findIcon(node) {
      if (!node) return null;
      const imgs = node.querySelectorAll ? Array.from(node.querySelectorAll('img')) : [];
      for (const img of imgs) {
        const s = (img.src || '').toLowerCase();
        if (s && !s.startsWith('data:') && /gift|reward|anim|icon/.test(s)) return img.src;
      }
      return null;
    }

    // 扫描新增节点
    function scan(root) {
      const nodes = root ? Array.from(root.querySelectorAll('*')) : document.querySelectorAll('*');
      for (const n of nodes) {
        if (n.children && n.children.length) continue;
        const txt = (n.textContent || '').trim();
        if (!txt || txt.length > 80) continue;
        if (!/(送出|赠送|打赏|送出了)/.test(txt)) continue;
        const key = txt;
        if (lastKey.has(key)) continue;
        if (lastKey.size > 200) lastKey.clear();
        lastKey.add(key);
        const data = parseGiftText(txt);
        if (data) {
          const icon = findIcon(n);
          renderBanner(data, icon);
        }
      }
    }

    // MutationObserver 监听动态插入的礼物消息
    let mo = window.__giftBannerMO;
    if (!mo) {
      mo = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type !== 'childList' || !m.addedNodes) continue;
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) scan(node);
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      window.__giftBannerMO = mo;
    }

    // ---- 心跳诊断：每5秒统计评论区实时消息数，确认游客态评论区是否有实时流 ----
    function findChatContainer() {
      if (window.__commentBannerRoot) return window.__commentBannerRoot;
      const sels = ['[class*="chat-list"]','[class*="ChatList"]','[class*="message-list"]','[class*="MessageList"]','[class*="chat-container"]','[data-e2e="live-chat"]','[data-e2e="chat-room"]'];
      for (const s of sels) { const el = document.querySelector(s); if (el) { window.__commentBannerRoot = el; return el; } }
      return null;
    }
    if (!window.__giftHeartbeatTimer) {
      window.__giftHeartbeatTimer = setInterval(() => {
        try {
          const ct = findChatContainer();
          if (!ct) { console.log('[GiftHeartbeat] 评论区容器未找到(可能未登录导致不渲染/选择器变化)'); return; }
          // 统计容器内叶子文本节点消息
          let total = 0, gift = 0, sample = '';
          const leaves = ct.querySelectorAll('*');
          for (let i = 0; i < leaves.length; i++) {
            const el = leaves[i];
            if (el.children && el.children.length) continue;
            const t = (el.textContent || '').trim();
            if (!t || t.length > 80) continue;
            total++;
            if (/(送出|赠送|打赏)/.test(t)) {
              gift++;
              if (!sample) sample = t.slice(0, 30);
            }
          }
          const delta = total - (window.__hbLastTotal || 0);
          window.__hbLastTotal = total;
          console.log('[GiftHeartbeat] 评论区消息=' + total + ' 新增~' + delta + ' 礼物消息=' + gift + (sample ? ' 例:' + sample : ''));
        } catch (e) { console.log('[GiftHeartbeat] 统计异常: ' + e.message); }
      }, 5000);
    }

    // 暴露全局入口，供主进程 WS 礼物流外部注入（保底：渲染与提帧复用同一套）
    window.__showGiftBanner = function (gdata, iconSrc) {
      try {
        if (!gdata) return false;
        const gift = gdata.gift || gdata.giftName || '';
        if (!gift) return false;
        const num = gdata.num || gdata.count || 1;
        renderBanner({ nick: gdata.nick || '', gift: gift, num: num, __timer: null }, iconSrc);
        return true;
      } catch (e) { return false; }
    };
    // ---- 探测信息（用于日志定位，不影响功能） ----
    var probe = { pageLoaded: !!document.body, giftLikeNodes: 0, bannerMounted: !!window.__giftBannerMO };
    try {
      var all = document.querySelectorAll('*');
      for (var pi = 0; pi < all.length; pi++) {
        var el = all[pi];
        if (el.children && el.children.length) continue;
        var t = (el.textContent || '').trim();
        if (t && t.length < 80 && /(送出|赠送|打赏)/.test(t)) probe.giftLikeNodes++;
      }
    } catch (e) {}
    return 'installed|probe=' + JSON.stringify(probe);
  } catch (e) { return 'error:' + e.message; }
})()`;

class CommentRenderer {
  constructor(options) {
    this.liveUrl = options.liveUrl;
    this.roomId = options.roomId;
    this.session = options.session || 'persist:douyin';
    this.outputDir = options.outputDir; // 帧保存目录
    this.debugDir = options.debugDir || options.outputDir; // 调试截图保存目录
    this.targetFps = options.fps || 10; // 评论区基础帧率（平时）
    this.giftFps = options.giftFps || 24;      // 礼物特效高帧率档
    this.giftHoldMs = options.giftHoldMs || 1500; // 检测到礼物后保持高帧率的时长
    this.giftCheckMs = options.giftCheckMs || 300; // 礼物检测轮询间隔
    this._giftActive = false;
    this._giftActiveUntil = 0;
    this._giftTimer = null;
    this._timestamps = []; // 帧时间戳(ms)，供合并端精确控制时间轴

    // 续帧起始编号：录制中检测到账号冲突回滚重建渲染器时，从已有帧数继续编号，避免覆盖已录帧
    this.frameStartIndex = options.frameStartIndex || 0;
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
    try { this.captureWindow.webContents.setFrameRate(Math.max(this.targetFps, 30)); } catch (e) {}

    // 静音窗口，防止直播音频外放
    this.captureWindow.webContents.setAudioMuted(true);
    logger.info('[CommentRenderer] 窗口音频已静音');

    // 透传离屏页面 console 日志，便于诊断评论区/礼物检测是否正常工作
    this.captureWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      try {
        const msg = String(message || '').slice(0, 500);
        if (
          msg.includes('[GiftBanner]') ||
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
    let pageLoadSuccess = false;
    const maxRetries = 3;
    const loadTimeout = 30000; // 30秒超时
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 使用 Promise.race 实现超时控制
        const loadPromise = this.captureWindow.loadURL(this.liveUrl, {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        });
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`页面加载超时 (${loadTimeout/1000}s)`)), loadTimeout);
        });
        
        await Promise.race([loadPromise, timeoutPromise]);
        pageLoadSuccess = true;
        logger.info(`[CommentRenderer] 页面加载成功 (尝试 ${attempt}/${maxRetries})`);
        break;
      } catch (loadErr) {
        logger.warn(`[CommentRenderer] 页面加载失败 (尝试 ${attempt}/${maxRetries}): ${loadErr.message}`);
        
        // 检查窗口是否仍然有效
        if (!this.captureWindow || this.captureWindow.isDestroyed()) {
          logger.error('[CommentRenderer] 窗口已被销毁，无法继续加载');
          break;
        }
        
        // 如果是 ERR_FAILED 错误或超时，页面可能仍在后台加载，等待一下再检查
        if (loadErr.message && (loadErr.message.includes('ERR_FAILED') || loadErr.message.includes('超时'))) {
          logger.info('[CommentRenderer] 等待页面后台加载...');
          // 等待页面可能完成加载
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // 检查页面是否已加载（通过执行简单 JS 测试）
          try {
            if (this.captureWindow && !this.captureWindow.isDestroyed()) {
              const isLoaded = await this.captureWindow.webContents.executeJavaScript(
                'document.readyState === "complete" || document.readyState === "interactive"'
              );
              if (isLoaded) {
                logger.info('[CommentRenderer] 页面已在后台加载完成');
                pageLoadSuccess = true;
                break;
              }
            }
          } catch (checkErr) {
            logger.warn('[CommentRenderer] 检查页面状态失败:', checkErr.message);
          }
        }
        
        // 如果还有重试机会，等待后重试
        if (attempt < maxRetries) {
          logger.info(`[CommentRenderer] 等待 2 秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    if (!pageLoadSuccess) {
      throw new Error(`页面加载失败，已重试 ${maxRetries} 次`);
    }

    // 加载后再次确保静音（某些页面可能会重置静音状态）
    this.captureWindow.webContents.setAudioMuted(true);

    // 等待页面完全加载（额外等待确保动态内容渲染完成）
    logger.info('[CommentRenderer] 等待页面加载完成...');
    await new Promise(resolve => setTimeout(resolve, 8000));

    // 通过 DOM 探测评论区实际位置（不注入CSS，保持页面自然布局）
    let detectedRect = await this._detectCommentAreaFromDOM();
    if (detectedRect) {
      logger.info(`[CommentRenderer] DOM探测评论区: x=${detectedRect.x}, y=${detectedRect.y}, w=${detectedRect.width}, h=${detectedRect.height}`);
    } else {
      logger.info('[CommentRenderer] DOM探测失败，使用右侧区域估算');
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
    } catch (e) {
      logger.warn('[CommentRenderer] 调试截图保存失败:', e.message);
    }

    logger.info('[CommentRenderer] 初始化完成');

    // 注入礼物横幅常驻脚本：评论区顶部显示"谁送了礼物+图标"提示条
    await this.injectGiftBanner();
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

  // 注入礼物横幅常驻脚本：监听评论区礼物消息 → 在评论区顶部插入"谁送了什么礼物"提示条
  async injectGiftBanner() {
    try {
      if (!this.captureWindow || this.captureWindow.isDestroyed()) {
        logger.warn('[CommentRenderer] 注入礼物横幅失败: 窗口不可用');
        return;
      }
      const ret = await this.captureWindow.webContents.executeJavaScript(GIFT_BANNER_SCRIPT);
      logger.info(`[CommentRenderer] 礼物横幅脚本注入结果: ${ret}`);
      // 解析探测信息
      const pm = String(ret || '').match(/probe=(\{.*\})/);
      if (pm) {
        try {
          const p = JSON.parse(pm[1]);
          logger.info(`[CommentRenderer] 页面检查: 页面已加载=${p.pageLoaded}, 含礼物文字节点数=${p.giftLikeNodes}, 横幅已挂载=${p.bannerMounted}`);
          if (!p.pageLoaded) { logger.warn('[CommentRenderer] 页面body未加载，评论区可能为空/未登录'); }
          if (p.giftLikeNodes === 0) { logger.warn('[CommentRenderer] 未检测到任何"送出/赠送/打赏"文字，确认页面是否有实时礼物消息(可能未登录)'); }
        } catch (e) {}
      }
    } catch (e) {
      logger.warn('[CommentRenderer] 注入礼物横幅失败:', e.message);
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
   * 通过 DOM 探测评论区容器的实际位置（不依赖 CSS 注入）
   * 策略：查找页面右侧的聊天/评论容器元素
   */
  async _detectCommentAreaFromDOM() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return null;

    try {
      const result = await this.captureWindow.webContents.executeJavaScript(`
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

    // 动态帧率状态（礼物特效检测）
    this._giftActive = false;
    this._giftActiveUntil = 0;
    this._timestamps = [];

    logger.info(`[CommentRenderer] 开始捕获评论区帧, 基准FPS: ${this.targetFps}, 礼物FPS: ${this.giftFps}, 输出目录: ${this.outputDir}`);
    logger.info(`[CommentRenderer] 裁剪区域: x=${this._commentRect.x}, y=${this._commentRect.y}, w=${this._commentRect.width}, h=${this._commentRect.height}`);

    // 基准帧间隔 vs 礼物动画帧间隔
    this._baseInterval = Math.floor(1000 / this.targetFps);
    this._giftInterval = Math.floor(1000 / this.giftFps);
    let capturing = false;

    const captureFrame = async () => {
      if (!this.capturing || !this.captureWindow || this.captureWindow.isDestroyed()) {
        return;
      }

      // 防止重入
      if (capturing) {
        if (this.capturing) {
          const _inGift = this._giftActive && Date.now() < this._giftActiveUntil;
          this._captureTimer = setTimeout(captureFrame, _inGift ? this._giftInterval : this._baseInterval);
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

      // 安排下一次捕获：礼物动画期间提升帧率，结束后回落基准帧率
      if (this.capturing) {
        const elapsed = Date.now() - now;
        const inGift = this._giftActive && Date.now() < this._giftActiveUntil;
        const curInterval = inGift ? this._giftInterval : this._baseInterval;
        const nextDelay = Math.max(0, curInterval - elapsed);
        this._captureTimer = setTimeout(captureFrame, nextDelay);
      }
    };

    // 启动礼物检测（后台轮询，不影响帧捕获）
    this._startGiftDetection();

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

    // 停止礼物检测
    this._stopGiftDetection();

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

    return {
      frameCount: absoluteCount,
      outputDir: this.outputDir,
      fps: actualFps,
      duration: duration,
      timestamps: this._timestamps || [],
      width: this._commentRect ? this._commentRect.width : COMMENT_WIDTH,
      height: this._commentRect ? this._commentRect.height : COMMENT_HEIGHT
    };
  }

  /**
   * 启动礼物特效检测（轮询页面，检测到礼物/连击/飞屏动画时临时提升保存帧率）
   */
  _startGiftDetection() {
    this._stopGiftDetection();
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    this._giftActive = false;
    this._giftActiveUntil = 0;
    this._giftTimer = setInterval(() => {
      if (!this.capturing || !this.captureWindow || this.captureWindow.isDestroyed()) {
        this._stopGiftDetection();
        return;
      }
      this.captureWindow.webContents
        .executeJavaScript(GIFT_DETECT_SCRIPT, true)
        .then((active) => {
          if (active) {
            this._giftActive = true;
            this._giftActiveUntil = Date.now() + this.giftHoldMs;
          } else if (Date.now() > this._giftActiveUntil) {
            this._giftActive = false;
          }
        })
        .catch(() => {});
    }, this.giftCheckMs);
  }

  /**
   * 停止礼物特效检测
   */
  _stopGiftDetection() {
    if (this._giftTimer) {
      clearInterval(this._giftTimer);
      this._giftTimer = null;
    }
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
   * 外部礼物注入接口（供 WS 礼物流等调用，完全与内部 DOM 检测解耦）
   * @param {object} data - { nick, giftName, count, iconUrl }
   * 说明：任何异常都静默吞掉，绝不影响评论区录制与源画面录制主流程。
   */
  async injectExternalGift(data) {
    try {
      if (!data || (!data.nick && !data.giftName)) return;
      // 1) 提帧：触发礼物高帧率档，提升这几秒的评论区帧率
      if (this.capturing) {
        this._giftActive = true;
        this._giftActiveUntil = Date.now() + this.giftHoldMs;
      }
      // 2) 横幅：调用离屏页面里已暴露的全局函数渲染礼物横幅
      await this._showExternalBanner(data);
      logger.info(`[GiftStream] 外部礼物已注入: ${data.nick} 送出 ${data.giftName} x${data.count || 1}`);
    } catch (e) {
      // 保底：绝不让外部礼物流的异常影响录制主链路
      if (e && (e.code === 'ERR_OFFSCREEN' || /destroyed|destroy|Object has been/i.test(e.message || ''))) {
        logger.debug('[GiftStream] 渲染器已销毁，忽略外部礼物注入');
      } else {
        logger.warn('[GiftStream] 外部礼物注入失败(不影响录制):', e && e.message);
      }
    }
  }

  /**
   * 在离屏页面渲染礼物横幅（调用页面暴露的 window.__showGiftBanner）
   */
  async _showExternalBanner(data) {
    if (!this.captureWindow || this.captureWindow.isDestroyed() || this.captureWindow.webContents.isDestroyed()) {
      return;
    }
    const icon = data.iconUrl ? `'${String(data.iconUrl).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : 'null';
    const nick = String(data.nick || '');
    const gift = String(data.giftName || '');
    const cnt = Number(data.count) || 1;
    const src = `(()=>{try{
      if (typeof window.__showGiftBanner === 'function') {
        window.__showGiftBanner({ nick: ${JSON.stringify(nick)}, giftName: ${JSON.stringify(gift)}, count: ${cnt} }, ${icon});
        return 'ok';
      }
      // 兜底：横幅函数未就绪时，直接注入一条模拟礼物消息触发 MutationObserver 路径
      if (window.__commentBannerRoot) {
        const el = document.createElement('li');
        el.textContent = ${JSON.stringify(nick + ' 送出 ' + gift + ' x' + cnt)};
        el.setAttribute('data-gift-banner', '1');
        window.__commentBannerRoot.appendChild(el);
        return 'fallback';
      }
      return 'noop';
    }catch(err){ return 'err'; }})()`;
    await this.captureWindow.webContents.executeJavaScript(src, true);
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
