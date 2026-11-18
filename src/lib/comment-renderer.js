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

// 团播"团员榜单"穿透展开脚本（Shadow DOM 穿透版）：
// 抖音团播组件用 Shadow DOM 封装，普通 querySelector 查不到"团员榜单"触发器（v2.13.13 曾 trigger_not_found），
// 因此递归穿透 shadowRoot 收集全部元素后再做文本定位。
// 功能：穿透定位"团员榜单"触发器并点击展开 → 穿透查找展开后的榜单面板并把其 rect 维护到 window.__rankPanelInfo
//       （供主进程探测计算评论区扩宽量）→ 定时保持展开（收起自动重新展开，8s 点击冷却防 toggle 抖动）。
const RANK_PANEL_SCRIPT = `(() => {
  try {
    if (window.__rankPanelScriptInstalled) return 'already';
    window.__rankPanelScriptInstalled = true;

    const KEYS = ['本场成员', '团员榜单', '团员榜', '成员榜单', '成员榜'];
    const KEY = KEYS[0]; // 面板识别主关键词
    // 触发器关键词优先级：团员榜单类优先（用户要的是团员贡献榜），本场成员最后（它展开的是在线观众面板，非团员榜）
    const PRIORITY = ['团员榜单', '团员榜', '成员榜单', '成员榜', '本场成员'];
    let panelRef = null;      // 展开后榜单面板的引用（用于判定是否仍展开）
    let clicking = false;     // 点击进行中，防并发
    let lastClickAt = 0;      // 上次点击时间（冷却）
    let diagDone = false;     // 首次诊断是否已执行
    let shadowCount = 0, iframeCount = 0; // 穿透统计（诊断用）
    let anchorProbe = null;   // Lynx 逻辑坐标不可信时的锚点竖直探测状态 {x, baseY, attempt}

    const norm = (s) => (s || '').replace(/\\s+/g, '');
    function clsOf(el) {
      try { const c = el.className; return (c && c.baseVal !== undefined ? c.baseVal : c || '').toString().slice(0, 40); } catch (e) { return ''; }
    }

    // iframe 坐标系换算（v2.13.25 关键修复）：collectAll 穿透同源 iframe 收集的元素，其 getBoundingClientRect
    // 返回 iframe 内文档坐标，而 elementFromPoint/sendInputEvent 使用主视口坐标——两坐标系错位会导致探测点击全落空
    // （实测江苏人艺直播间左侧"本场成员/团员榜单"整个由 Lynx hybrid iframe 承载，elementFromPoint 全命中 IFRAME）。
    // 沿 ownerDocument.defaultView.frameElement 链逐层累加 iframe 偏移，统一换算为主视口坐标。
    function toViewportRect(el) {
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
      let x = r.left, y = r.top;
      try {
        let doc = el.ownerDocument;
        let guard = 0;
        while (doc && doc !== document && guard < 5) {
          const fe = doc.defaultView && doc.defaultView.frameElement;
          if (!fe) break;
          const fr = fe.getBoundingClientRect();
          x += fr.left; y += fr.top;
          doc = fe.ownerDocument;
          guard++;
        }
      } catch (e) {}
      return { left: x, top: y, right: x + r.width, bottom: y + r.height, width: r.width, height: r.height };
    }
    function inIframe(el) {
      try { return el.ownerDocument !== document; } catch (e) { return false; }
    }

    // 穿透 Shadow DOM + 同源 iframe，递归收集 root 下所有元素（含 shadow 内部）
    function collectAll(root, acc, depth) {
      depth = depth || 0;
      if (!root || !root.querySelectorAll || depth > 25) return;
      let all;
      try { all = root.querySelectorAll('*'); } catch (e) { return; }
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        acc.push(el);
        try { if (el.shadowRoot) { shadowCount++; collectAll(el.shadowRoot, acc, depth + 1); } } catch (e) {}
        if (el.tagName === 'IFRAME') {
          iframeCount++;
          try { if (el.contentDocument) collectAll(el.contentDocument, acc, depth + 1); } catch (e) {}
        }
      }
    }
    function getAllElements() {
      shadowCount = 0; iframeCount = 0;
      const acc = [];
      collectAll(document, acc, 0);
      return acc;
    }

    // 首次全面诊断：打印穿透结构与含榜单关键词/"本场成员"的候选元素，便于定位触发器真实位置
    function diagnose(all) {
      if (diagDone) return; diagDone = true;
      try {
        const hits = [];
        for (const el of all) {
          if (!el || !el.getBoundingClientRect) continue;
          const t = norm(el.innerText || el.textContent);
          if (!t || t.length > 30) continue;
          let hit = null;
          for (const k of KEYS) { if (t.indexOf(k) >= 0) { hit = k; break; } }
          if (!hit && t.indexOf('本场成员') >= 0) hit = '本场成员';
          if (!hit) continue;
          const r = el.getBoundingClientRect();
          hits.push((el.tagName || '?') + ' | text=' + t.slice(0, 10) + ' | x=' + Math.round(r.left) + ',y=' + Math.round(r.top) + ',w=' + Math.round(r.width) + ',h=' + Math.round(r.height) + ' | vis=' + (visible(el) ? 1 : 0) + ' | cls=' + clsOf(el));
        }
        console.log('[RankPanel] 诊断 元素总数=' + all.length + ' shadowRoot=' + shadowCount + ' iframe=' + iframeCount + ' 关键词命中=' + hits.length);
        for (let i = 0; i < Math.min(hits.length, 12); i++) console.log('[RankPanel] 候选[' + i + '] ' + hits[i]);
      } catch (e) { console.log('[RankPanel] 诊断异常 ' + e.message); }
    }

    function visible(el) {
      try {
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch (e) { return false; }
    }

    // 穿透查找"已展开"的榜单面板：含榜单关键词、可见、高度明显增大或含多个团员头像的最内层可见容器
    // 注意：面板同样可能是 X-VIEW 自定义元素，不限 tagName；加宽度约束排除整页大容器
    function findPanel() {
      const els = getAllElements();
      const matched = [];
      for (const c of els) {
        if (!c || !c.getBoundingClientRect || !c.tagName) continue;
        if (c.tagName === 'BODY' || c.tagName === 'HTML') continue;
        const t = norm(c.innerText || c.textContent);
        if (!t) continue;
        // 面板识别需匹配任一关键词（完好"本场成员"/"团员榜单"两种团播 UI）
        let isKey = false;
        for (const k of KEYS) { if (t.indexOf(k) >= 0) { isKey = true; break; } }
        if (!isKey) continue;
        if (!visible(c)) continue;
        const r = c.getBoundingClientRect();
        if (r.width <= 0 || r.height < 120) continue; // 折叠态仅一两行(高<120)
        if (r.width > 1000) continue; // 排除整页宽的大容器
        let imgCount = 0;
        try { imgCount = c.querySelectorAll('img').length; } catch (e) {}
        // 展开特征：出现多个团员头像，或容器显著变高
        if (imgCount >= 2 || r.height >= 200) matched.push({ el: c, rect: r });
      }
      if (!matched.length) return null;
      // 取最内层（不包含其它匹配容器），避免误取包裹整区的大容器
      const inner = matched.filter((m) => !matched.some((o) => o !== m && m.el.contains(o.el)));
      return inner[0] || matched[matched.length - 1];
    }

    // 穿透定位"团员榜单"触发器（含榜单关键词的可见元素，取面积最小者=最内层）
    // 注意：抖音触发器是自定义元素 <X-VIEW>（cls=rank-header / rank-header-title），不能用 tagName 白名单；
    // 不查 childHas——X-VIEW 子元素 textContent 可能异常冗长（含关键词但长度>12），会误排最内层触发器；
    // 改用面积排序天然选中最内层（子元素面积必然小于父容器）
    function findTrigger() {
      const els = getAllElements();
      const candidates = [];
      for (const el of els) {
        if (!el || !el.getBoundingClientRect || !el.tagName) continue;
        if (el.tagName === 'BODY' || el.tagName === 'HTML') continue;
        const t = norm(el.innerText || el.textContent);
        if (!t || t.length > 30) continue; // 放宽到30：视觉按钮常含榜首名（如"团员榜单世一萌…14639"）
        let hit = null;
        for (const k of KEYS) { if (t.indexOf(k) >= 0) { hit = k; break; } }
        if (!hit) continue;
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.width > 500 || r.height > 200) continue; // 触发器是小按钮/小行，排除整页大容器
        candidates.push({ el: el, area: r.width * r.height, key: hit, text: t, rect: r, cls: clsOf(el) });
      }
      // 诊断：总是打印候选（区分 Lynx 逻辑节点与视觉按钮，定位真正可点击的元素）；vp=主视口换算坐标（v2.13.25）
      console.log('[RankPanel] 触发器候选数=' + candidates.length);
      for (let ci = 0; ci < Math.min(candidates.length, 8); ci++) {
        const c = candidates[ci];
        const vp = toViewportRect(c.el);
        console.log('[RankPanel] 候选[' + ci + '] ' + c.el.tagName + ' key=' + c.key + ' text=' + c.text.slice(0, 14) + ' rect=' + Math.round(c.rect.left) + ',' + Math.round(c.rect.top) + ',' + Math.round(c.rect.width) + 'x' + Math.round(c.rect.height) + ' vp=' + Math.round(vp.left) + ',' + Math.round(vp.top) + ' iframe=' + inIframe(c.el) + ' cls=' + c.cls);
      }
      if (!candidates.length) {
        // 诊断：输出每个含关键词元素被排除的原因（定位是文本过长/不可见/尺寸异常）
        let scanned = 0;
        for (const el of els) {
          if (!el || !el.tagName) continue;
          const t = norm(el.innerText || el.textContent);
          let hit = null;
          for (const k of KEYS) { if (t && t.indexOf(k) >= 0) { hit = k; break; } }
          if (!hit) continue;
          scanned++;
          if (scanned <= 6) {
            const r = (el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 });
            let why = 'OK';
            if (!t) why = 'empty-text';
            else if (t.length > 30) why = 'text-too-long(' + t.length + ')';
            else if (!visible(el)) why = 'invisible';
            else if (r.width <= 0 || r.height <= 0 || r.width > 500 || r.height > 200) why = 'size-out(' + Math.round(r.width) + 'x' + Math.round(r.height) + ')';
            console.log('[RankPanel] 排除分析 ' + el.tagName + ' | text=' + t.slice(0, 8) + ' | ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' | 原因=' + why);
          }
        }
        return null;
      }
      // 排序：先按关键词优先级（团员榜单优先于本场成员），同关键词取视觉位置更靠下的（避开页面顶部的 Lynx 逻辑节点），再取面积最小（最内层）
      candidates.sort((a, b) => {
        const pa = PRIORITY.indexOf(a.key), pb = PRIORITY.indexOf(b.key);
        const ra = pa < 0 ? 99 : pa, rb = pb < 0 ? 99 : pb;
        if (ra !== rb) return ra - rb;
        const ya = Math.round(a.rect.top), yb = Math.round(b.rect.top);
        if (ya !== yb) return yb - ya; // 视觉靠下优先：顶部 y≈4 多为 Lynx 逻辑节点，视觉按钮在内容区 y 较大
        return a.area - b.area;
      });
      return candidates[0].el;
    }

    // 更新面板信息到 window.__rankPanelInfo（供主进程探测计算扩宽量）
    function updatePanelInfo() {
      const p = findPanel();
      if (p) {
        panelRef = p.el;
        const r = toViewportRect(p.el); // 主视口坐标：面板可能在 iframe 内（江苏人艺），扩宽判断需视口坐标（v2.13.25）
        const tag = (p.el.tagName || '').toUpperCase();
        // Lynx 自定义元素(X-*)的 getBoundingClientRect 返回逻辑坐标——x/y 不可信(实测弹窗视觉x≈1135但rect.x=0)，width/height 可信
        window.__rankPanelInfo = {
          expanded: true,
          x: Math.round(r.left), y: Math.round(r.top),
          width: Math.round(r.width), height: Math.round(r.height),
          right: Math.round(r.right), tag: tag,
          lynx: tag.indexOf('X-') === 0, ts: Date.now()
        };
        if (!window.__rankPanelLoggedOpen) {
          window.__rankPanelLoggedOpen = true;
          console.log('[RankPanel] 榜单面板已展开: tag=' + tag + ', x=' + Math.round(r.left) + ', w=' + Math.round(r.width) + ', h=' + Math.round(r.height) + ', right=' + Math.round(r.right));
        }
      } else {
        window.__rankPanelInfo = { expanded: false, ts: Date.now() };
        if (window.__rankPanelLoggedOpen) {
          window.__rankPanelLoggedOpen = false;
          console.log('[RankPanel] 榜单面板已收起或未检测到');
        }
      }
      return p;
    }

    function isExpanded() {
      if (panelRef && panelRef.isConnected) {
        try {
          const r = panelRef.getBoundingClientRect();
          if (r.height >= 120 && visible(panelRef)) return true;
        } catch (e) {}
      }
      return !!updatePanelInfo();
    }

    // 穿透 shadow DOM + iframe 的 elementFromPoint：Lynx 组件常嵌套 shadowRoot，部分组件（江苏人艺榜单）在同源 iframe 内，
    // 需逐层深入最内层元素；iframe 层坐标需换算（主视口坐标 - iframe 偏移 = iframe 内文档坐标）
    function deepElementFromPoint(x, y) {
      let el = null;
      try { el = document.elementFromPoint(x, y); } catch (e) { return null; }
      let guard = 0;
      while (el && guard < 12) {
        if (el.tagName === 'IFRAME') {
          let inner = null;
          try {
            const fr = el.getBoundingClientRect();
            if (el.contentDocument) inner = el.contentDocument.elementFromPoint(x - fr.left, y - fr.top);
          } catch (e) { break; }
          if (!inner || inner === el) break;
          el = inner;
          guard++;
          continue;
        }
        if (el.shadowRoot) {
          let inner = null;
          try { inner = el.shadowRoot.elementFromPoint(x, y); } catch (e) { break; }
          if (!inner || inner === el) break;
          el = inner;
          guard++;
          continue;
        }
        break;
      }
      return el;
    }

    // 当 Lynx X-VIEW 的 getBoundingClientRect 为逻辑坐标（不可信）时，
    // 以候选中心 x 为基准垂直扫描 elementFromPoint，找含关键词的视觉位置（真实可点击点）
    function scanVisualPos(keyword, baseX) {
      // 扫描列：候选中心x 及左右各偏移，覆盖按钮宽度
      const cols = [Math.round(baseX), Math.round(baseX) - 15, Math.round(baseX) + 15, Math.round(baseX) - 30, Math.round(baseX) + 30];
      for (let ci = 0; ci < cols.length; ci++) {
        const x = cols[ci];
        if (x < 2) continue;
        for (let y = 40; y < 360; y += 3) {
          const el = deepElementFromPoint(x, y);
          if (!el || !el.tagName) continue;
          const t = norm(el.innerText || el.textContent);
          if (t && t.length <= 30 && t.indexOf(keyword) >= 0) {
            return { x: x, y: y, tag: el.tagName, cls: clsOf(el), text: t.slice(0, 12) };
          }
        }
      }
      return null;
    }

    // 找可信锚点：左侧特效区"本场成员"条目的最内层可见元素（普通 DOM DIV，getBoundingClientRect 为真实视觉坐标），
    // 用于在 Lynx X-VIEW 逻辑坐标不可信时，结合竖直探测定位位于其正下方的"团员榜单"视觉按钮
    function findTrustedAnchor() {
      const els = getAllElements();
      let best = null;
      for (const el of els) {
        if (!el || !el.getBoundingClientRect || !el.tagName) continue;
        if (/^X-[A-Z]/.test(el.tagName)) continue; // 排除 Lynx 元素（rect 可能是逻辑坐标）
        if (el.tagName === 'BODY' || el.tagName === 'HTML') continue;
        const t = norm(el.innerText || el.textContent);
        if (!t || t.length > 30) continue;
        if (t.indexOf('本场成员') < 0) continue;
        if (!visible(el)) continue;
        const r = toViewportRect(el); // 主视口坐标（iframe 内锚点自动换算，v2.13.25）
        if (r.width <= 0 || r.height <= 0 || r.width > 500 || r.height > 200) continue;
        if (r.top < 30) continue; // 排除页面顶部疑似 Lynx 干扰的逻辑节点，视觉锚点应在内容区
        const area = r.width * r.height;
        if (!best || area < best.area) best = { el: el, area: area, rect: r };
      }
      console.log('[RankPanel] 锚点探测 findTrustedAnchor=' + (best ? best.el.tagName + ' rect=' + Math.round(best.rect.left) + ',' + Math.round(best.rect.top) + ',' + Math.round(best.rect.width) + 'x' + Math.round(best.rect.height) + ' iframe=' + inIframe(best.el) + ' cls=' + clsOf(best.el) : 'null'));
      return best;
    }

    function expandOnce() {
      if (clicking) return 'clicking';
      const now = Date.now();
      if (now - lastClickAt < 2600) return 'cooldown'; // 探测冷却(2.6s)：过短会在弹窗动画期间二次点击造成toggle（点开又被关）
      const trigger = findTrigger();
      if (!trigger) {
        // 诊断：首次失败时输出全面诊断（穿透结构+候选元素），便于区分"穿透失效/触发器在iframe/非团播直播间"
        const all = getAllElements();
        diagnose(all); // 仅首次执行
        let keyHit = 0;
        for (const el of all) { const t = norm(el.innerText || el.textContent); for (const k of KEYS) { if (t.indexOf(k) >= 0) { keyHit++; break; } } }
        console.log('[RankPanel] 未找到触发器：穿透元素总数=' + all.length + ' shadowRoot=' + shadowCount + ' iframe=' + iframeCount + ' 含榜单文本元素=' + keyHit);
        return 'trigger_not_found';
      }
      const tr = toViewportRect(trigger); // 主视口坐标（iframe 内触发器自动换算，v2.13.25）
      let cx = Math.round(tr.left + tr.width / 2);
      let cy = Math.round(tr.top + tr.height / 2);
      const triggerText = norm(trigger.innerText || trigger.textContent).slice(0, 14);
      let triggerKey = null;
      for (const k of KEYS) { if (triggerText.indexOf(k) >= 0) { triggerKey = k; break; } }
      const isLynx = /^X-[A-Z]/.test(trigger.tagName);
      console.log('[RankPanel] 命中触发器 ' + trigger.tagName + ' key=' + (triggerKey || '?') + ' isLynx=' + isLynx + ' cls=' + clsOf(trigger) + ' text=' + triggerText + ' rect=' + Math.round(tr.left) + ',' + Math.round(tr.top) + ',' + Math.round(tr.width) + 'x' + Math.round(tr.height) + '，初始中心 (' + cx + ',' + cy + ')');

      // iframe 内触发器专项处理（v2.13.26）：v2.13.25 实测坐标已换算正确（vp=13,92 命中 LYNX-VIEW）但点击无响应，
      // 疑似 sendInputEvent 不能路由进 iframe 内 Lynx。此处：
      // ①挂 iframe 内事件监听（诊断 sendInputEvent 是否路由进 iframe，打印 trusted/坐标/target）
      // ②对触发器元素直接 dispatch 完整合成事件序列（元素级，不依赖视觉坐标，事件在 iframe 文档上下文内派生）
      if (inIframe(trigger)) {
        if (!window.__rankIframeEvtHooked) {
          window.__rankIframeEvtHooked = true;
          try {
            const idoc = trigger.ownerDocument;
            ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((ty) => {
              idoc.addEventListener(ty, (e) => {
                const t = e.target;
                console.log('[RankPanel] iframe内收到事件 ' + ty + ' @(' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ') target=' + (t && t.tagName) + ' trusted=' + e.isTrusted);
              }, true);
            });
            console.log('[RankPanel] iframe事件监听已挂载');
          } catch (he) { console.log('[RankPanel] iframe事件监听挂载失败 ' + he.message); }
        }
        try {
          const win = trigger.ownerDocument.defaultView;
          const evOpts = { bubbles: true, cancelable: true, view: win, composed: true };
          const seq = ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
          for (const ty of seq) {
            let ev;
            if (ty.indexOf('pointer') === 0 && win.PointerEvent) ev = new win.PointerEvent(ty, evOpts);
            else ev = new win.MouseEvent(ty, evOpts);
            trigger.dispatchEvent(ev);
          }
          try { if (typeof trigger.click === 'function') trigger.click(); } catch (ce) {}
          console.log('[RankPanel] iframe内触发器元素级合成点击已派发 tag=' + trigger.tagName);
        } catch (ee) { console.log('[RankPanel] 元素级合成点击异常 ' + ee.message); }
      }
      let rectTrusted = false;
      if (isLynx) {
        // Lynx 元素：getBoundingClientRect 可能是布局树逻辑坐标（视觉按钮另在 canvas 绘制，elementFromPoint 也命中不到）。
        // 先用 elementFromPoint 验证；若不可信，改用可信锚点"本场成员"+竖直探测（Lynx 的 x/width 可信仅 y 不可信）
        try {
          const hitEl = deepElementFromPoint(cx, cy);
          const hitText = norm((hitEl && (hitEl.innerText || hitEl.textContent)) || '');
          let hitKey = null;
          for (const k of KEYS) { if (hitText.indexOf(k) >= 0) { hitKey = k; break; } }
          console.log('[RankPanel] 点击点验证 elementFromPoint(' + cx + ',' + cy + ')=' + (hitEl ? hitEl.tagName : 'null') + ' key=' + (hitKey || 'none') + ' text=' + hitText.slice(0, 12) + ' cls=' + (hitEl ? clsOf(hitEl) : ''));
          rectTrusted = !!hitKey;
        } catch (ve) { console.log('[RankPanel] 点击点验证异常 ' + ve.message); }
        if (!rectTrusted) {
          // 锚点网格探测：以"本场成员"可信锚点（普通 DIV，位于团员榜单正上方约30px）为基准，
          // 横向多列×纵向多行依次探测。原因：不同直播间 Lynx canvas 绘制的视觉按钮位置有差异
          // （实测 Fire苏江095 单列x=23即命中，江苏人民艺术剧院同坐标7点全失败），单列扫描覆盖不足
          if (!anchorProbe) {
            anchorProbe = { xs: [cx], baseY: 80, attempt: 0 };
            const anchor = findTrustedAnchor();
            if (anchor) {
              const ar = anchor.rect; // 已是主视口坐标（v2.13.25）
              anchorProbe.baseY = Math.round(ar.bottom) + 15;
              // x 列：触发器逻辑中心x（可信，Fire实测有效）+ 锚点中心x + 左右偏移，去重后约3~4列
              const cand = [cx, Math.round(ar.left + ar.width / 2), cx + 25, cx - 13, Math.round(ar.right) + 8];
              const seen = {};
              anchorProbe.xs = [];
              for (const xv of cand) { const k = Math.round(xv / 4); if (!seen[k] && xv >= 3) { seen[k] = 1; anchorProbe.xs.push(xv); } }
            } else {
              console.log('[RankPanel] 未找到本场成员锚点，用默认 baseY=80, 单列探测');
            }
          }
          const xsLen = anchorProbe.xs.length;
          const xi = anchorProbe.attempt % xsLen;
          const yi = Math.floor(anchorProbe.attempt / xsLen);
          cx = Math.max(3, anchorProbe.xs[xi]);
          cy = anchorProbe.baseY + yi * 13;
          console.log('[RankPanel] Lynx探测点击候选 (' + cx + ',' + cy + ') attempt=' + anchorProbe.attempt + ' (列' + xi + '/' + xsLen + ',行' + yi + ') baseY=' + anchorProbe.baseY);
          // 探测点诊断：记录该点命中的最内层元素，便于实测区分"落在视频区/被遮挡/命中按钮容器"
          try {
            const probeEl = deepElementFromPoint(cx, cy);
            const probeText = norm((probeEl && (probeEl.innerText || probeEl.textContent)) || '');
            console.log('[RankPanel] 探测点诊断 elementFromPoint(' + cx + ',' + cy + ')=' + (probeEl ? probeEl.tagName : 'null') + ' text=' + probeText.slice(0, 12) + ' cls=' + (probeEl ? clsOf(probeEl) : ''));
          } catch (pe) {}
          anchorProbe.attempt++;
          if (anchorProbe.attempt >= 18) { console.log('[RankPanel] 锚点探测达到上限(' + anchorProbe.attempt + ')，重置'); anchorProbe = null; }
        } else {
          anchorProbe = null;
        }
      } else {
        // 普通 DOM：rect 可信，直接用中心，并重置锚点探测
        anchorProbe = null;
        rectTrusted = true;
        console.log('[RankPanel] 点击点(普通DOM rect可信) (' + cx + ',' + cy + ')');
      }
      console.log('[RankPanel] 记录待真实点击坐标 (' + cx + ',' + cy + ')');
      lastClickAt = now;
      // 记录待点击坐标，由主进程用 webContents.sendInputEvent 发送真实鼠标事件（isTrusted=true，绕过页面合成点击被忽略的问题）
      window.__rankClickPos = { x: cx, y: cy, ts: now };
      // 真实点击由主进程异步触发，延迟判定面板是否展开并缓存 rect
      // 2.2s 给弹窗打开动画留足时间，避免动画期间误判未展开而二次点击造成toggle
      setTimeout(() => { try { updatePanelInfo(); } catch (e) {} }, 2200);
      return 'need_click';
    }

    // 立即展开一次，随后每 2s 更新面板信息 + 保持展开（收起则重新展开）
    const first = expandOnce();
    window.__rankPanelTimer = setInterval(() => {
      try { if (!isExpanded()) expandOnce(); else updatePanelInfo(); } catch (e) {}
    }, 2000);

    return 'installed:' + first;
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
    // 全局捕获起点（v2.13.28）：回滚续帧场景由外层传入首段捕获起点墙钟，
    // 使本段帧时间戳直接落在全场绝对时间轴上（含回滚 gap），合并端时间轴与源视频不错位；
    // 为空则保持旧行为（本段起点为 0，stopCapture 时按历史末帧偏移拼接，gap 被压缩）
    this._globalCaptureStartEpoch = options.globalCaptureStartEpoch || null;
    // 左侧特效区捕获模式（stream+comment+effect）：复用本离屏窗口，在 capturePage() 时同时裁剪
    // 评论区（右侧）和左侧特效区（公屏聊天/礼物栏），帧分别写入两个目录，避免再开一个独立窗口去渲染页面
    this.enableLeftPanel = !!options.enableLeftPanel;
    this.leftPanelOutputDir = options.leftPanelOutputDir || null;
    this._leftPanelRect = null;         // 左侧特效区裁剪区域
    this._leftPanelFrameCount = 0;      // 左侧特效区累计帧数
    this._leftPanelFps = this.targetFps; // 左侧特效区帧率（与评论区一致）
    // 团播榜单模式（stream+comment+effect+rank）：在特效区基础上展开"团员榜单"并扩宽评论区捕获区域，
    // 使紧邻评论区左侧的榜单弹窗与评论区一并被录制
    this.enableRankPanel = !!options.enableRankPanel;
    // 团播榜单扩宽状态：_rankWidened=已扩宽（setup或录制期间动态扩宽成功后置位，避免重复扩宽）
    // _rankWatchTimer=录制期间榜单展开监听（榜单在捕获开始后才被脚本点开时动态扩宽+补齐旧帧）
    // _pendingFrameTasks=进行中的旧帧补齐/裁剪任务（stopCapture 需等待其完成，保证合并时帧尺寸一致）
    this._rankWidened = false;
    this._rankWatchTimer = null;
    this._rankWidening = false;
    this._pendingFrameTasks = [];
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
    // stopCapture 幂等状态（v2.13.28）：destroy() 会重复调用 stopCapture
    this._stopCaptureDone = false;
    this._lastStopResult = null;
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
          msg.includes('[RankPanel]') ||
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

    // 团播榜单模式：注入穿透展开脚本、等待榜单展开、扩宽评论区捕获区域，并保存调试截图
    // （榜单弹窗紧邻评论区左侧，扩宽评论区把榜单+评论区一并录制；非团播/展开失败自动降级不扩宽）
    if (this.enableRankPanel) {
      await this._setupRankPanelMode();
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

      // 团播榜单模式：刷新后页面脚本丢失且评论区 rect 被重置，需重新注入展开脚本并重新扩宽
      if (this.enableRankPanel && this.capturing && !this.captureWindow.isDestroyed()) {
        this._rankWidened = false; // 评论区rect已重置为未扩宽，允许setup/录制期间watcher重新扩宽（突变帧由stopCapture归一化兜底）
        await this._setupRankPanelMode();
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

          // 穿透 Shadow DOM + 同源 iframe，递归收集所有 video/canvas 元素
          // （抖音直播播放器用 Shadow DOM 封装，普通 querySelector 查不到内部 video；
          //   部分直播间如江苏人艺的页面区块由 Lynx hybrid iframe 承载，iframe 内媒体也需收集，v2.13.25）
          function collectMedia(root, acc) {
            if (!root || !root.querySelectorAll) return;
            try {
              const media = root.querySelectorAll('video, canvas');
              for (let i = 0; i < media.length; i++) acc.push(media[i]);
              const all = root.querySelectorAll('*');
              for (let i = 0; i < all.length; i++) {
                if (all[i].shadowRoot) collectMedia(all[i].shadowRoot, acc);
                if (all[i].tagName === 'IFRAME') {
                  try { if (all[i].contentDocument) collectMedia(all[i].contentDocument, acc); } catch(e) {}
                }
              }
            } catch(e) {}
          }

          // iframe 坐标系换算：iframe 内元素的 getBoundingClientRect 是 iframe 内文档坐标，需沿 frameElement 链累加偏移
          function toVpRect(el) {
            let r;
            try { r = el.getBoundingClientRect(); } catch(e) { return { left: 0, top: 0, width: 0, height: 0 }; }
            let x = r.left, y = r.top;
            try {
              let doc = el.ownerDocument, guard = 0;
              while (doc && doc !== document && guard < 5) {
                const fe = doc.defaultView && doc.defaultView.frameElement;
                if (!fe) break;
                const fr = fe.getBoundingClientRect();
                x += fr.left; y += fr.top;
                doc = fe.ownerDocument; guard++;
              }
            } catch(e) {}
            return { left: x, top: y, width: r.width, height: r.height };
          }

          // 穿透 Shadow DOM + iframe，判断元素内部是否包含 video/canvas
          function containsMediaDeep(el) {
            try {
              if (el.querySelector('video, canvas')) return true;
              const all = el.querySelectorAll('*');
              for (let i = 0; i < all.length; i++) {
                if (all[i].tagName === 'IFRAME') {
                  try {
                    const idoc = all[i].contentDocument;
                    if (idoc && idoc.querySelector('video, canvas')) return true;
                  } catch(e) {}
                }
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
          // 诊断信息收集（v2.13.26）：未命中时输出各元素详情与排除原因，便于定位穿透失效环节
          const diag = {
            mediaCount: mediaEls.length,
            mediaList: mediaEls.slice(0, 12).map((el) => {
              const r = toVpRect(el);
              let inIframe = false;
              try { inIframe = !!(el.ownerDocument && el.ownerDocument.defaultView && el.ownerDocument.defaultView.frameElement); } catch(e) {}
              return { tag: el.tagName, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], iframe: inIframe };
            }),
            filteredSmallMedia: 0,
            strategy1: '', strategy2: '', strategy3: ''
          };
          let mainMedia = null, maxArea = 0;
          for (const el of mediaEls) {
            const r = toVpRect(el); // 主视口坐标（iframe 内媒体自动换算，v2.13.25）
            if (r.width < 100 || r.height < pageH * 0.2) { diag.filteredSmallMedia++; continue; }
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
              return { x: 0, width: 0, strategy: 'video-fullscreen-no-leftpanel', diag };
            }
            diag.strategy1 = 'mainMedia左边界vLeft=' + vLeft + '>=页面中点' + Math.round(pageCenterX) + '，不视为左侧有特效区';
          } else {
            diag.strategy1 = mediaEls.length === 0 ? '未收集到任何video/canvas(含穿透)' : '收集到' + mediaEls.length + '个媒体元素但全部被尺寸过滤(排除' + diag.filteredSmallMedia + '个)';
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
            let sibChecked = 0;
            let node = commentRoot.previousElementSibling;
            while (node) {
              sibChecked++;
              const rect = node.getBoundingClientRect();
              if (rect.width > 80 && rect.width <= maxLeftW && !containsMediaDeep(node) && rect.right <= pageCenterX + 30) {
                return { x: Math.max(0, Math.round(rect.left)), width: Math.round(rect.width), strategy: 'prev-of-comment' };
              }
              node = node.previousElementSibling;
            }
            diag.strategy2 = '找到评论区容器但左侧兄弟链' + sibChecked + '个节点均不满足(宽度/含媒体/越界)';
          } else {
            diag.strategy2 = '未找到右侧评论区容器(webcast-chatroom等选择器未命中或不在右侧)';
          }

          // 策略3: 页面左侧文字密集的可见 div（弹幕区特征：文字多、相对紧凑，穿透排除视频容器）
          let best = null;
          let bestScore = 0;
          let s3Excluded = { size: 0, media: 0, header: 0, invisible: 0, text: 0, pos: 0 };
          const allDivs = document.querySelectorAll('div');
          for (const div of allDivs) {
            const rect = div.getBoundingClientRect();
            if (rect.left >= pageCenterX || rect.right <= 0) { s3Excluded.pos++; continue; }
            if (rect.width < 120 || rect.width > maxLeftW || rect.height < 150) { s3Excluded.size++; continue; }
            if (containsMediaDeep(div)) { s3Excluded.media++; continue; }
            if (div.closest('header, nav, [class*="header"], [class*="Header"], [class*="navbar"], [class*="Navbar"]')) { s3Excluded.header++; continue; }
            const style = window.getComputedStyle(div);
            if (style.display === 'none' || style.visibility === 'hidden') { s3Excluded.invisible++; continue; }
            const text = (div.innerText || '').trim();
            if (text.length < 15) { s3Excluded.text++; continue; } // 弹幕区必须有足够文字，排除纯视频背景容器
            const area = rect.width * rect.height;
            const density = text.length / area;
            // 以文字量为主、密度为辅（避免大面积视频容器胜出）
            const score = text.length * 10 + density * 200000;
            if (score > bestScore) {
              bestScore = score;
              best = { x: Math.max(0, Math.round(rect.left)), width: Math.round(rect.width), strategy: 'largest-left-div' };
            }
          }
          if (best) return best;
          diag.strategy3 = '共' + allDivs.length + '个div，排除: 位置' + s3Excluded.pos + '/尺寸' + s3Excluded.size + '/含媒体' + s3Excluded.media + '/头部' + s3Excluded.header + '/不可见' + s3Excluded.invisible + '/文字不足' + s3Excluded.text;
          return { x: 0, width: 0, strategy: 'no-hit', diag };
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
      // 未命中：输出收集诊断（v2.13.26），定位穿透/过滤环节
      if (raced && raced.diag) {
        const d = raced.diag;
        logger.warn(`[CommentRenderer] 左侧特效区DOM探测未命中诊断: media共${d.mediaCount}个(尺寸过滤排除${d.filteredSmallMedia}) ` +
          `mediaList=${JSON.stringify(d.mediaList)}`);
        logger.warn(`[CommentRenderer] 未命中原因: [策略1]${d.strategy1} [策略2]${d.strategy2} [策略3]${d.strategy3}`);
      } else if (raced && raced.strategy === 'video-fullscreen-no-leftpanel') {
        logger.info('[CommentRenderer] 视频几乎占满左侧，该直播间无独立特效区，回退对称估算');
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
   * 团播榜单模式编排：注入穿透展开脚本 → 等待榜单展开 → 扩宽评论区 → 保存调试截图
   * 非团播直播间或展开失败时自动降级为普通特效区模式（评论区不扩宽），不影响录制主流程
   */
  async _setupRankPanelMode() {
    if (!this.enableRankPanel) return;
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;
    try {
      logger.info('[CommentRenderer] 团播榜单模式：注入穿透展开脚本并等待榜单展开...');
      await this._injectRankPanelScript();
      // 启动真实点击泵：读取页面记录的待点击坐标，用 sendInputEvent 发送真实鼠标事件
      this._startRankClickPump();
      // 等待榜单展开（最多12s），非团播/展开失败则保持原评论区（降级普通特效区模式）
      const rankInfo = await this._waitRankPanelExpanded(12000);
      if (rankInfo) {
        const widened = this._applyRankPanelWiden(rankInfo);
        logger.info(`[CommentRenderer] 团播榜单已展开 (x=${rankInfo.x}, w=${rankInfo.width}, h=${rankInfo.height})，评论区扩宽: ${widened ? '是' : '否(面板未超出评论区左缘)'}`);
      } else {
        logger.warn('[CommentRenderer] 未检测到展开的团播榜单（非团播直播间或展开失败），按普通特效区模式录制，评论区不扩宽');
      }
      // 无论是否扩宽成功，均保存调试截图（整体界面 + 当前评论区裁切），便于后续调整
      await this._saveRankDebugScreenshots();
    } catch (e) {
      logger.warn('[CommentRenderer] 团播榜单模式初始化异常:', e && e.message);
    }
  }

  // 注入团播榜单穿透展开脚本
  async _injectRankPanelScript() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return false;
    try {
      const ret = await this.captureWindow.webContents.executeJavaScript(RANK_PANEL_SCRIPT);
      logger.info(`[CommentRenderer] 团员榜单穿透展开脚本注入结果: ${ret}`);
      return true;
    } catch (e) {
      logger.warn('[CommentRenderer] 团员榜单穿透展开脚本注入失败:', e && e.message);
      return false;
    }
  }

  // 读取页面维护的榜单面板信息（__rankPanelInfo，由 RANK_PANEL_SCRIPT 每2s更新）
  async _getRankPanelInfo() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return null;
    try {
      const info = await this.captureWindow.webContents.executeJavaScript(
        '((window.__rankPanelInfo && window.__rankPanelInfo.expanded) ? window.__rankPanelInfo : null)'
      );
      return info || null;
    } catch (e) {
      return null;
    }
  }

  // 启动团播榜单真实点击泵：读取页面记录的待点击坐标（window.__rankClickPos），用 sendInputEvent 发送真实鼠标事件（isTrusted=true，比注入脚本的合成 MouseEvent 更接近真实用户操作）
  _startRankClickPump() {
    this._stopRankClickPump();
    this._lastRankClickTs = 0;
    this._rankClickTimer = setInterval(async () => {
      try {
        if (!this.captureWindow || this.captureWindow.isDestroyed()) return;
        const pos = await this.captureWindow.webContents.executeJavaScript('window.__rankClickPos || null');
        if (pos && pos.ts && pos.ts !== this._lastRankClickTs && typeof pos.x === 'number' && typeof pos.y === 'number') {
          this._lastRankClickTs = pos.ts;
          const wc = this.captureWindow.webContents;
          // 完整真实鼠标事件序列：移动 -> 按下 -> 抬起
          wc.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
          wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
          logger.info(`[CommentRenderer] 团播榜单真实点击 @ (${pos.x},${pos.y})`);
          // 点击后自动保存全页面诊断截图（v2.13.26）：观察点击后页面实际变化（弹窗是否打开/被二次点击toggle关掉）
          this._scheduleRankClickScreenshot();
        }
      } catch (e) { /* 忽略点击泵异常，避免影响录制主流程 */ }
    }, 800);
  }

  _stopRankClickPump() {
    if (this._rankClickTimer) { clearInterval(this._rankClickTimer); this._rankClickTimer = null; }
    if (this._rankClickShotTimer) { clearTimeout(this._rankClickShotTimer); this._rankClickShotTimer = null; }
  }

  // 点击后延迟自动保存全页面诊断截图（v2.13.26）：直观察看点击后页面实际状态
  // 弹窗是否打开/是否被后续点击toggle关闭，截图命名 debug_rank_click_NN.png（最多8张防刷屏）
  _scheduleRankClickScreenshot() {
    if (!this.debugDir) return;
    this._rankClickShotCount = (this._rankClickShotCount || 0) + 1;
    if (this._rankClickShotCount > 8) return;
    const seq = this._rankClickShotCount;
    if (this._rankClickShotTimer) clearTimeout(this._rankClickShotTimer);
    this._rankClickShotTimer = setTimeout(async () => {
      try {
        if (!this.captureWindow || this.captureWindow.isDestroyed()) return;
        const img = await this.captureWindow.webContents.capturePage();
        const file = path.join(this.debugDir, `debug_rank_click_${String(seq).padStart(2, '0')}.png`);
        fs.writeFileSync(file, img.toPNG());
        logger.info(`[CommentRenderer] 榜单点击后诊断截图已保存: ${file}`);
      } catch (e) {
        logger.warn('[CommentRenderer] 榜单点击诊断截图失败:', e && e.message);
      }
    }, 1500);
  }

  // 轮询等待榜单展开，返回面板 rect 信息；超时返回 null
  async _waitRankPanelExpanded(timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.captureWindow || this.captureWindow.isDestroyed()) return null;
      const info = await this._getRankPanelInfo();
      if (info && info.expanded && info.width > 40 && info.height >= 120) return info;
      await new Promise((r) => setTimeout(r, 600));
    }
    return null;
  }

  // 根据榜单面板 rect 扩宽评论区捕获区域（x 左移、width 增大，右边缘保持不变）
  _applyRankPanelWiden(rankInfo) {
    if (!this._commentRect || !rankInfo) return false;
    const commentRight = this._commentRect.x + this._commentRect.width;
    const MARGIN = 6; // 余量，包含面板左边缘阴影/边框
    let newX;
    if (rankInfo.lynx) {
      // Lynx 面板：getBoundingClientRect 的 x/right 是布局树逻辑坐标（不可信，实测弹窗视觉x≈1135但rect.x=0），width 可信。
      // 团播榜单弹窗版式固定为"紧邻评论区左侧的居中弹窗"（弹窗右缘≈评论区左缘），故按 面板左缘=评论区左缘-面板宽 扩宽。
      newX = this._commentRect.x - Math.round(rankInfo.width) - MARGIN;
      logger.info(`[CommentRenderer] 团播榜单为Lynx面板(tag=${rankInfo.tag || 'X-?'})，rect.x=${rankInfo.x}为逻辑坐标不可信，按弹窗锚定评论区左缘扩宽: 面板宽=${rankInfo.width}`);
    } else {
      // 普通DOM面板：rect 可信。面板右缘明显小于评论区左缘的 80% -> 面板在页面左侧，由左特效区捕获，无需扩宽右侧（避免错把左侧榜单当弹窗扩宽）
      const panelRight = rankInfo.x + rankInfo.width;
      if (panelRight < this._commentRect.x * 0.8) return false;
      newX = Math.min(this._commentRect.x, Math.round(rankInfo.x) - MARGIN);
    }
    newX = Math.max(0, newX);
    let newWidth = commentRight - newX;
    // 防呆：扩宽后总宽不超过原评论宽度的 2.2 倍（避免误探测导致过度扩宽盖住中间画面）
    const maxW = Math.round(this._commentRect.width * 2.2);
    if (newWidth > maxW) {
      newWidth = maxW;
      newX = commentRight - newWidth;
    }
    // 面板右边缘在评论区左缘之右（未真正向左扩展），无需扩宽
    if (newWidth <= this._commentRect.width) return false;
    const oldX = this._commentRect.x;
    const oldW = this._commentRect.width;
    this._commentRect = {
      x: newX,
      y: this._commentRect.y,
      width: newWidth,
      height: this._commentRect.height
    };
    this._rankWidened = true;
    logger.info(`[CommentRenderer] 团播榜单扩宽评论区: x ${oldX} -> ${newX}, width ${oldW} -> ${newWidth} (面板x=${rankInfo.x}, w=${rankInfo.width}, lynx=${!!rankInfo.lynx})`);
    return true;
  }

  /**
   * 录制期间持续监听团播榜单展开状态（v2.13.24）
   * 背景：_setupRankPanelMode 只在录制初始化阶段等待12s，若榜单在捕获开始后才被页面脚本点开
   * （实测江苏人民艺术剧院直播间锚点探测整场未命中，偶尔捕获期间才点开），扩宽逻辑不会执行，
   * 导致整场评论区帧保持未扩宽宽度、榜单丢失，且榜单弹窗挤压布局使左特效区缩小。
   * 本监听每4s轮询 __rankPanelInfo，发现展开且未扩宽时动态扩宽并用 sharp 补齐已捕获旧帧。
   */
  _startRankWatch() {
    this._stopRankWatch();
    this._rankWatchTimer = setInterval(async () => {
      try {
        if (!this.capturing || !this.captureWindow || this.captureWindow.isDestroyed()) return;
        if (this._rankWidened || this._rankWidening) return;
        const info = await this._getRankPanelInfo();
        if (info && info.expanded && info.width > 40 && info.height >= 120) {
          await this._dynamicWidenDuringCapture(info);
        }
      } catch (e) { /* 忽略监听异常，避免影响录制主流程 */ }
    }, 4000);
  }

  _stopRankWatch() {
    if (this._rankWatchTimer) { clearInterval(this._rankWatchTimer); this._rankWatchTimer = null; }
  }

  // 捕获期间榜单展开：扩宽评论区捕获区域（后续帧立即用新区域），并后台补齐已捕获旧帧，保证帧序列宽度一致
  async _dynamicWidenDuringCapture(rankInfo) {
    this._rankWidening = true;
    try {
      const oldRect = this._commentRect ? { ...this._commentRect } : null;
      if (!oldRect) return;
      const widened = this._applyRankPanelWiden(rankInfo);
      if (!widened) return;
      const deltaW = this._commentRect.width - oldRect.width;
      const lastIdx = this.frameStartIndex + this.frameCount - 1;
      logger.info(`[CommentRenderer] 录制期间检测到榜单展开，评论区动态扩宽: width ${oldRect.width} -> ${this._commentRect.width}，后台补齐已捕获 ${lastIdx - this.frameStartIndex + 1} 帧旧帧(左扩${deltaW}px)...`);
      // 旧帧向左扩展 deltaW（评论区扩宽方向为向左），背景深色与评论区底色一致；任务登记到 _pendingFrameTasks，stopCapture 等待完成
      const padTask = this._padFramesLeft(this.outputDir, 'frame_', this.frameStartIndex, lastIdx, deltaW)
        .then((r) => logger.info(`[CommentRenderer] 评论区旧帧补齐完成: ${r.ok}帧成功, ${r.skip}帧跳过, ${r.fail}帧失败, 补齐宽度=${deltaW}`))
        .catch((e) => logger.warn('[CommentRenderer] 评论区旧帧补齐异常:', e && e.message));
      this._pendingFrameTasks.push(padTask);
      // 榜单弹窗展开会挤压页面布局（左侧特效区变窄），重新检测并统一左侧帧尺寸
      await this._resyncLeftPanelAfterRankOpen();
    } finally {
      this._rankWidening = false;
    }
  }

  // 用 sharp 把指定范围帧向左扩展 deltaW（深色背景），用于录制期间动态扩宽后补齐已捕获旧帧
  async _padFramesLeft(dir, prefix, fromIdx, toIdx, deltaW) {
    const result = { ok: 0, skip: 0, fail: 0 };
    if (!dir || deltaW <= 0) return result;
    let sharp;
    try { sharp = require('sharp'); } catch (e) {
      logger.warn('[CommentRenderer] sharp 不可用，跳过旧帧补齐（合并可能因帧宽度不一致失败）:', e && e.message);
      result.fail = -1;
      return result;
    }
    for (let i = fromIdx; i <= toIdx; i++) {
      const p = path.join(dir, `${prefix}${String(i).padStart(6, '0')}.jpg`);
      if (!fs.existsSync(p)) { result.skip++; continue; }
      try {
        const buf = await sharp(p).extend({ left: deltaW, background: '#101018' }).jpeg({ quality: 92 }).toBuffer();
        fs.writeFileSync(p, buf);
        result.ok++;
      } catch (e) { result.fail++; }
    }
    return result;
  }

  // 用 sharp 把指定范围帧从左侧裁剪为 newW（裁掉右侧多余画面），用于左特效区变窄后统一已捕获旧帧尺寸
  async _cropFramesRight(dir, prefix, fromIdx, toIdx, newW) {
    const result = { ok: 0, skip: 0, fail: 0 };
    if (!dir || newW <= 0) return result;
    let sharp;
    try { sharp = require('sharp'); } catch (e) {
      logger.warn('[CommentRenderer] sharp 不可用，跳过左特效区旧帧裁剪:', e && e.message);
      result.fail = -1;
      return result;
    }
    for (let i = fromIdx; i <= toIdx; i++) {
      const p = path.join(dir, `${prefix}${String(i).padStart(6, '0')}.jpg`);
      if (!fs.existsSync(p)) { result.skip++; continue; }
      try {
        const meta = await sharp(p).metadata();
        const w = Math.min(newW, meta.width || newW);
        if (w >= (meta.width || 0)) { result.skip++; continue; } // 已不宽于目标，无需裁剪
        const buf = await sharp(p).extract({ left: 0, top: 0, width: w, height: meta.height }).jpeg({ quality: 92 }).toBuffer();
        fs.writeFileSync(p, buf);
        result.ok++;
      } catch (e) { result.fail++; }
    }
    return result;
  }

  /**
   * 榜单展开后左特效区重同步：榜单弹窗挤压页面布局导致左侧特效区变窄（实测460->280），
   * 重新检测特效区实际宽度；若变窄则把已捕获旧帧从左侧裁剪（裁掉右侧混入的视频画面），保证左侧帧序列宽度一致
   */
  async _resyncLeftPanelAfterRankOpen() {
    if (!this.enableLeftPanel || !this._leftPanelRect || !this.leftPanelOutputDir) return;
    try {
      const detected = await this._detectLeftPanelAreaFromDOM();
      if (!detected || detected.width <= 40) {
        logger.warn('[CommentRenderer] 榜单展开后左特效区重检测未命中，保持原区域');
        return;
      }
      const oldW = this._leftPanelRect.width;
      const newW = Math.round(detected.width);
      if (Math.abs(newW - oldW) < 8) {
        logger.info(`[CommentRenderer] 榜单展开后左特效区宽度变化微小(${oldW}->${newW})，保持原区域`);
        return;
      }
      const pageH = this._leftPanelRect.height;
      const lastIdx = this._leftPanelFrameCount - 1;
      this._leftPanelRect = { x: 0, y: 0, width: newW, height: pageH };
      if (newW < oldW) {
        logger.info(`[CommentRenderer] 榜单展开后左特效区变窄: width ${oldW} -> ${newW}，后台裁剪已捕获 ${lastIdx + 1} 帧旧帧(去右侧混入画面)...`);
        const cropTask = this._cropFramesRight(this.leftPanelOutputDir, 'left_frame_', 0, lastIdx, newW)
          .then((r) => logger.info(`[CommentRenderer] 左特效区旧帧裁剪完成: ${r.ok}帧成功, ${r.skip}帧跳过, ${r.fail}帧失败`))
          .catch((e) => logger.warn('[CommentRenderer] 左特效区旧帧裁剪异常:', e && e.message));
        this._pendingFrameTasks.push(cropTask);
      } else {
        logger.info(`[CommentRenderer] 榜单展开后左特效区变宽: width ${oldW} -> ${newW}（少见），旧帧右侧待录制结束统一补齐`);
      }
    } catch (e) {
      logger.warn('[CommentRenderer] 左特效区重同步异常:', e && e.message);
    }
  }

  // 保存团播榜单调试截图：①榜单展开后的整体界面 ②榜单+评论区（扩宽后）单独裁切
  async _saveRankDebugScreenshots() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;
    try {
      fs.mkdirSync(this.debugDir, { recursive: true });
      // 1) 团播榜单展开后的整体界面截图
      const fullImage = await this.captureWindow.webContents.capturePage();
      const fullPath = path.join(this.debugDir, 'debug_rank_full_page.png');
      fs.writeFileSync(fullPath, fullImage.toPNG());
      logger.info(`[CommentRenderer] 团播榜单整体界面截图: ${fullPath}`);
      // 2) 团播榜单+评论区（扩宽后）单独裁切截图
      if (this._commentRect) {
        const size = fullImage.getSize();
        const r = this._commentRect;
        const safeW = Math.min(r.width, size.width - r.x);
        const safeH = Math.min(r.height, size.height - r.y);
        if (safeW > 0 && safeH > 0) {
          const crop = fullImage.crop({ x: r.x, y: r.y, width: safeW, height: safeH });
          const cropPath = path.join(this.debugDir, 'debug_rank_comment_area.png');
          fs.writeFileSync(cropPath, crop.toPNG());
          logger.info(`[CommentRenderer] 团播榜单+评论区裁切截图: ${cropPath} (x=${r.x}, w=${safeW}, h=${safeH})`);
        }
      }
    } catch (e) {
      logger.warn('[CommentRenderer] 团播榜单调试截图保存失败:', e && e.message);
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
    // 回滚续帧：有全局起点时帧时间戳直接基于首段起点（含回滚 gap），否则基于本段起点（v2.13.28）
    this._captureStartTime = this._globalCaptureStartEpoch || this._startTime;

    this._timestamps = [];

    // 页面自愈状态（容器缺失自愈刷新）：每个录制会话重置
    this._noContainerStreak = 0;
    this._reloadCount = 0;
    this._lastReloadAt = 0;
    this._reloading = false;
    this._reloadCapWarned = false;

    // 团播榜单扩宽状态：每个录制会话重置（setup阶段已扩宽则保持true，否则录制期间watcher可动态扩宽）
    this._rankWidening = false;
    this._pendingFrameTasks = [];

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
      // 回滚续帧（有全局起点）：首帧也记录真实偏移（含回滚 gap），保证合并端时间轴与源视频不错位（v2.13.28）
      this._timestamps.push(
        (this.frameCount === 0 && !this._globalCaptureStartEpoch) ? 0 : Date.now() - this._captureStartTime
      );

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

    // 团播榜单模式：启动录制期间榜单展开监听（榜单若在捕获开始后才被页面脚本点开，动态扩宽并补齐旧帧）
    if (this.enableRankPanel && !this._rankWidened) {
      this._startRankWatch();
    }

    // 启动捕获循环
    this._captureTimer = setTimeout(captureFrame, this._baseInterval);
  }

  /**
   * 停止捕获
   * @returns {{ frameCount: number, outputDir: string, fps: number, duration: number }}
   */
  async stopCapture() {
    // 幂等（v2.13.28）：destroy() 会再次调用本方法；_finishRecording 已 stop 过一次后，
    // 合并失败清理 .temp 目录再 destroy 会重复写 timestamps.json 报 ENOENT（脏日志），
    // 且回滚场景 stop→destroy 序列会二次触发时间戳合并写入。已停止则直接返回上次结果。
    if (this._stopCaptureDone) {
      return this._lastStopResult || null;
    }
    this.capturing = false;
    this._stopRankClickPump(); // 停止团播榜单真实点击泵
    this._stopRankWatch();     // 停止录制期间榜单展开监听

    if (this._captureTimer) {
      clearTimeout(this._captureTimer);
      this._captureTimer = null;
    }

    // 等待录制期间动态扩宽触发的旧帧补齐/裁剪任务完成，避免合并时帧尺寸不一致（v2.13.24）
    if (this._pendingFrameTasks && this._pendingFrameTasks.length) {
      logger.info(`[CommentRenderer] 等待 ${this._pendingFrameTasks.length} 个旧帧处理任务完成...`);
      try { await Promise.all(this._pendingFrameTasks); } catch (e) { /* 任务内部已记录日志 */ }
      this._pendingFrameTasks = [];
    }


    const duration = this._startTime ? Date.now() - this._startTime : 0;
    const actualFps = duration > 0 ? (this.frameCount / (duration / 1000)) : this.targetFps;
    const absoluteCount = this.frameStartIndex + this.frameCount;

    // 保存帧时间戳列表，供合并精确控时（动态帧率必需）
    // 续帧场景：已有历史 timestamps 时追加，保证时间轴连续、与帧号一一对应
    let mergedTimestamps = null;
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
              if (this._globalCaptureStartEpoch) {
                // v2.13.28：本段时间戳已基于全局起点（含回滚 gap），直接拼接即为完整绝对时间轴
                merged = tail.concat(this._timestamps);
              } else {
                // 旧行为兜底：本段从 0 起，按历史末帧偏移拼接（回滚 gap 被压缩，仅兼容场景）
                const lastT = tail.length ? tail[tail.length - 1] : 0;
                merged = tail.concat(this._timestamps.map((t) => t + lastT));
              }
            }
          } catch (e) {
            // 历史读取失败时直接使用本次（保持简单，避免覆盖坏数据）
          }
        }
        fs.writeFileSync(tsPath, JSON.stringify(merged), 'utf8');
        mergedTimestamps = merged;
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
        fps: actualFps, // 左侧帧与评论帧同一次 capturePage 同时裁剪，帧序列时间轴完全一致，必须用 actualFps（v2.13.26 修复：原误用 targetFps 致左侧视频时长与评论区不一致）
        duration: duration,
        width: this._leftPanelRect ? this._leftPanelRect.width : (this._commentRect ? this._commentRect.width : 400),
        height: this._leftPanelRect ? this._leftPanelRect.height : (this._commentRect ? this._commentRect.height : 720)
      };
      logger.info(`[CommentRenderer] 停止捕获, 左侧特效区帧数: ${leftPanelInfo.frameCount}, 目录: ${leftPanelInfo.outputDir}`);
      // 左侧帧与评论帧同帧序列（同一次 capturePage 同时裁剪），共享同一时间戳列表，写入左侧目录供合并端精确控时
      if (mergedTimestamps) {
        try {
          fs.writeFileSync(path.join(this.leftPanelOutputDir, 'timestamps.json'), JSON.stringify(mergedTimestamps), 'utf8');
        } catch (e) {
          logger.warn('[CommentRenderer] 写左侧 timestamps.json 失败:', e.message);
        }
      }
    }

    // 帧尺寸归一化兜底（v2.13.24）：自愈刷新重探测/录制期间动态扩宽等场景可能造成帧序列宽度突变，
    // FFmpeg image2 序列要求所有帧尺寸一致，故以最大宽度为准补齐窄帧。
    // 评论区扩宽方向为向左（x左移），窄帧左侧补齐；左特效区贴页面左缘，窄帧右侧补齐。
    if (this.outputDir && this.frameCount > 0) {
      await this._normalizeFramesWidth(this.outputDir, 'frame_', 'left', this.frameStartIndex, this.frameStartIndex + this.frameCount - 1);
    }
    if (leftPanelInfo && this.leftPanelOutputDir && this._leftPanelFrameCount > 0) {
      await this._normalizeFramesWidth(this.leftPanelOutputDir, 'left_frame_', 'right', 0, this._leftPanelFrameCount - 1);
    }

    const stopResult = {
      frameCount: absoluteCount,
      outputDir: this.outputDir,
      fps: actualFps,
      duration: duration,
      timestamps: this._timestamps || [],
      startEpoch: this._globalCaptureStartEpoch || this._startTime || 0, // 捕获起点墙钟（ms），供合并端与流录制起点对齐时间轴（v2.13.26；回滚续帧时为全局首段起点，v2.13.28）
      width: this._commentRect ? this._commentRect.width : COMMENT_WIDTH,
      height: this._commentRect ? this._commentRect.height : COMMENT_HEIGHT,
      leftPanelInfo: leftPanelInfo
    };
    // 幂等标记（v2.13.28）：destroy() 重复调用时直接返回本结果，避免重复写 timestamps/归一化帧
    this._stopCaptureDone = true;
    this._lastStopResult = stopResult;
    return stopResult;
  }

  /**
   * 帧尺寸归一化（v2.13.24）：扫描指定范围帧，宽度不一致时以最大宽度为准，窄帧用深色背景补齐。
   * align='left' 表示内容右对齐（评论区：扩宽是向左扩展，旧窄帧在左侧补）；align='right' 表示内容左对齐（左特效区）。
   * 先采样（首/中/尾帧）检查，全一致则跳过全量扫描，避免几千帧的无谓开销。
   */
  async _normalizeFramesWidth(dir, prefix, align, fromIdx, toIdx) {
    if (!dir || !fs.existsSync(dir) || toIdx < fromIdx) return;
    let sharp;
    try { sharp = require('sharp'); } catch (e) { return; } // sharp 不可用时跳过（动态扩宽路径已单独告警）
    const fileAt = (i) => path.join(dir, `${prefix}${String(i).padStart(6, '0')}.jpg`);
    const widthOf = async (i) => {
      try { const m = await sharp(fileAt(i)).metadata(); return m.width || 0; } catch (e) { return 0; }
    };
    // 采样检查：首/尾/中间帧宽度一致则认为全序列一致（突变只会发生在扩宽/刷新事件点，采样足以发现）
    const sampleIdx = [fromIdx, toIdx, Math.floor((fromIdx + toIdx) / 2)];
    const sampleW = [];
    for (const i of sampleIdx) { if (fs.existsSync(fileAt(i))) sampleW.push(await widthOf(i)); }
    if (sampleW.length >= 2 && sampleW.every((w) => w === sampleW[0])) return;
    // 全量扫描找最大宽度
    let maxW = 0;
    const widths = new Map();
    for (let i = fromIdx; i <= toIdx; i++) {
      const p = fileAt(i);
      if (!fs.existsSync(p)) continue;
      const w = await widthOf(i);
      widths.set(i, w);
      if (w > maxW) maxW = w;
    }
    if (maxW <= 0) return;
    let padded = 0;
    for (const [i, w] of widths) {
      if (w <= 0 || w >= maxW) continue;
      const p = fileAt(i);
      try {
        const extendOpt = align === 'left' ? { left: maxW - w, background: '#101018' } : { right: maxW - w, background: '#101018' };
        const buf = await sharp(p).extend(extendOpt).jpeg({ quality: 92 }).toBuffer();
        fs.writeFileSync(p, buf);
        padded++;
      } catch (e) { /* 单帧失败不阻塞 */ }
    }
    if (padded > 0) {
      logger.info(`[CommentRenderer] 帧尺寸归一化(${prefix}): 检测到宽度不一致，以最大宽度${maxW}为准补齐 ${padded} 帧 (align=${align})`);
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
   * 清理所有资源
   */
  async destroy() {
    await this.stopCapture();
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
