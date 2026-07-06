/**
 * 录制引擎模块
 * 使用 Electron 离屏渲染 + FFmpeg 编码实现直播录制
 * 捕获完整的浏览器渲染输出（视频画面 + 弹幕 + 礼物特效）
 */
const { BrowserWindow } = require('electron');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { generateFileName } = require('./douyin-utils');
const { getConfig } = require('./config');
const { getLogger } = require('./logger');

const logger = getLogger();

// 获取 FFmpeg 可执行文件路径（处理 asar 打包情况）
function getFFmpegPath() {
  let ffmpegPath = ffmpegInstaller.path;
  
  // 在 asar 打包后，二进制文件在 app.asar.unpacked 目录
  if (ffmpegPath.includes('app.asar') && !ffmpegPath.includes('app.asar.unpacked')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
  
  // 验证路径是否存在
  if (!fs.existsSync(ffmpegPath)) {
    logger.error(`FFmpeg 路径不存在: ${ffmpegPath}`);
    // 尝试在应用目录查找
    const appDir = path.dirname(process.execPath);
    const possiblePaths = [
      path.join(appDir, 'resources', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'ffmpeg'),
      path.join(appDir, 'resources', 'app', 'node_modules', '@ffmpeg-installer', 'ffmpeg')
    ];
    
    for (const p of possiblePaths) {
      try {
        const altPath = require(path.join(p, 'package.json'));
        if (altPath && altPath.path) {
          const resolved = path.resolve(p, altPath.path);
          if (fs.existsSync(resolved)) {
            logger.info(`找到备用 FFmpeg 路径: ${resolved}`);
            return resolved;
          }
        }
      } catch (e) { /* ignore */ }
    }
  }
  
  logger.info(`FFmpeg 路径: ${ffmpegPath}`);
  return ffmpegPath;
}

const ffmpegPath = getFFmpegPath();
ffmpeg.setFfmpegPath(ffmpegPath);

class Recorder {
  constructor(options) {
    this.roomId = options.roomId;
    this.streamerName = options.streamerName || '未知主播';
    this.liveUrl = options.liveUrl;
    this.outputFolder = options.outputFolder;
    this.session = options.session; // Electron session (用于共享登录态)

    this.recording = false;
    this.ffmpegProcess = null;
    this.captureWindow = null;
    this.outputFile = '';
    this.startTime = null;
    this.frameCount = 0;
    this.hasAudio = false; // 是否包含音频
    this._streamUrl = null; // 直播流URL（方案A：用于音频输入）
    
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onError = options.onError || (() => {});
  }

  /**
   * 创建用于捕获的离屏浏览器窗口
   */
  async createCaptureWindow() {
    const config = getConfig();

    // 固定捕获分辨率为 1280x720 - 降低分辨率以提高捕获帧率
    const CAPTURE_WIDTH = 1280;
    const CAPTURE_HEIGHT = 720;

    this.captureWindow = new BrowserWindow({
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      show: false,            // 不显示窗口
      enableLargerThanScreen: true,
      frame: false,           // 无边框
      webPreferences: {
        offscreen: true,      // 启用离屏渲染
        javascript: true,
        plugins: true,
        nodeIntegration: false,
        contextIsolation: true,
        partition: this.session || 'persist:douyin', // 共享登录态
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        // 自动播放视频但静音，防止音频从扬声器输出
        additionalArguments: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
        audioPlaybackPolicy: 'never'
      }
    });

    // 设置窗口始终置顶以避免渲染暂停
    this.captureWindow.setAlwaysOnTop(false);

    // 加载直播间页面
    await this.captureWindow.loadURL(this.liveUrl, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    });

    // 等待页面完全加载
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 尝试启动视频播放
    await this.tryStartVideoPlayback();

    // 设置最高画质
    await this.setMaxQuality();

    // 保留弹幕显示（录制时需要捕获弹幕画面）

    // 注入 CSS 防止页面滚动，确保捕获区域固定
    await this.injectNoScrollCSS();

    // 等待 CSS 生效和视频开始播放
    await new Promise(resolve => setTimeout(resolve, 2000));

    return this.captureWindow;
  }

  /**
   * 尝试启动视频播放
   */
  async tryStartVideoPlayback() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    try {
      await this.captureWindow.webContents.executeJavaScript(`
        (function() {
          // 尝试找到视频元素并播放（离屏模式下静音，防止音频从扬声器输出）
          const videos = document.querySelectorAll('video');
          for (const video of videos) {
            video.muted = true; // 静音，防止音频从系统扬声器输出
            if (video.paused) {
              video.play().catch(() => {});
            }
          }
          
          // 尝试点击播放按钮
          const playBtns = document.querySelectorAll('[class*="play"], [class*="Play"], button[aria-label*="播放"], button[aria-label*="play"]');
          for (const btn of playBtns) {
            btn.click();
          }
        })();
      `);
      logger.info('[Recorder] 已尝试启动视频播放（最大音量）');
    } catch (e) {
      logger.warn('[Recorder] 启动视频播放失败:', e.message);
    }
  }

  /**
   * 关闭直播画面区域的弹幕
   */
  async hideDanmaku() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    try {
      await this.captureWindow.webContents.executeJavaScript(`
        (function() {
          // 方法1: 尝试点击弹幕开关按钮（关闭弹幕）
          const toggleBtns = document.querySelectorAll(
            '[class*="danmu-toggle"], [class*="barrage-toggle"], ' +
            '[class*="danmaku-switch"], [class*="dm-toggle"], ' +
            '[data-e2e="danmaku-switch"], [class*="DanmakuSwitch"]'
          );
          for (const btn of toggleBtns) {
            // 如果弹幕开关是开启状态，点击关闭
            if (btn.checked || btn.classList.contains('active') || btn.classList.contains('on')) {
              btn.click();
            }
          }

          // 方法2: 直接隐藏弹幕相关元素
          const danmakuSelectors = [
            '[class*="danmu"]', '[class*="barrage"]',
            '[class*="Danmu"]', '[class*="Barrage"]',
            '[class*="danmaku"]', '[class*="Danmaku"]',
            'canvas[class*="dm"]', '[class*="dm-container"]'
          ];
          for (const selector of danmakuSelectors) {
            document.querySelectorAll(selector).forEach(el => {
              // 只隐藏视频画面区域内的弹幕，不影响其他功能
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                el.style.display = 'none';
                el.style.visibility = 'hidden';
              }
            });
          }

          // 方法3: 通过 MutationObserver 持续移除动态创建的弹幕元素
          if (window._danmakuObserver) {
            window._danmakuObserver.disconnect();
          }
          window._danmakuObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) {
                  const cls = (node.className || '').toString().toLowerCase();
                  if (cls.includes('danmu') || cls.includes('barrage') || cls.includes('danmaku')) {
                    node.style.display = 'none';
                    node.style.visibility = 'hidden';
                  }
                }
              }
            }
          });
          window._danmakuObserver.observe(document.body, { childList: true, subtree: true });
        })();
      `);
      logger.info('[Recorder] 已关闭弹幕显示');
    } catch (e) {
      logger.warn('[Recorder] 关闭弹幕失败:', e.message);
    }
  }

  /**
   * 注入 CSS 防止页面滚动，确保捕获区域固定
   * 使用 clip 方式确保捕获区域严格限制在视口范围
   */
  async injectNoScrollCSS() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    try {
      await this.captureWindow.webContents.executeJavaScript(`
        (function() {
          // 移除旧样式
          document.querySelectorAll('style[data-recorder]').forEach(s => s.remove());
          
          const style = document.createElement('style');
          style.setAttribute('data-recorder', 'true');
          style.textContent = \`
            /* 严格限制页面尺寸，禁止溢出 */
            html {
              width: 100vw !important;
              height: 100vh !important;
              overflow: hidden !important;
              margin: 0 !important;
              padding: 0 !important;
              border: none !important;
            }
            body {
              width: 100vw !important;
              height: 100vh !important;
              max-height: 100vh !important;
              overflow: hidden !important;
              margin: 0 !important;
              padding: 0 !important;
            }
            /* 隐藏滚动条 */
            ::-webkit-scrollbar { display: none !important; }
            * { scrollbar-width: none !important; }
            /* 关闭直播画面区域的弹幕滚动（浮动弹幕层） */
            [class*="danmu"], [class*="barrage"], [class*="Danmu"], [class*="Barrage"] {
              display: none !important;
              visibility: hidden !important;
              opacity: 0 !important;
              pointer-events: none !important;
            }
            canvas[class*="danmu"], canvas[class*="barrage"] {
              display: none !important;
            }
            /* 保留右侧评论区，不隐藏 */
          \`;
          document.head.appendChild(style);
          
          // 强制滚动到顶部
          window.scrollTo(0, 0);
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;
          
          // 持续阻止滚动
          if (window._recorderScrollHandler) {
            window.removeEventListener('scroll', window._recorderScrollHandler);
            window.removeEventListener('wheel', window._recorderScrollHandler);
            window.removeEventListener('touchmove', window._recorderScrollHandler);
          }
          
          window._recorderScrollHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.scrollTo(0, 0);
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;
            return false;
          };
          
          window.addEventListener('scroll', window._recorderScrollHandler, { passive: false, capture: true });
          window.addEventListener('wheel', window._recorderScrollHandler, { passive: false, capture: true });
          window.addEventListener('touchmove', window._recorderScrollHandler, { passive: false, capture: true });
          
          // 定时重置滚动位置
          if (window._recorderScrollInterval) clearInterval(window._recorderScrollInterval);
          window._recorderScrollInterval = setInterval(() => {
            if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0) {
              window.scrollTo(0, 0);
            }
          }, 200);
        })();
      `);
      logger.info('[Recorder] 已注入防滚动 CSS');
    } catch (e) {
      logger.warn('[Recorder] 注入防滚动 CSS 失败:', e.message);
    }
  }

  /**
   * 尝试设置直播间为最高画质
   */
  async setMaxQuality() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    // 多次重试，确保页面完全加载后能设置画质
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const result = await this.captureWindow.webContents.executeJavaScript(`
          (function() {
            // ===== 方法1: 查找画质/清晰度按钮（通过文本内容匹配） =====
            const allElements = document.querySelectorAll('span, div, button, a, p');
            let qualityBtn = null;
            const btnKeywords = ['画质', '清晰度', '蓝光', '原画', '超清', '1080P', '1080p', '720P'];
            
            for (const el of allElements) {
              const text = (el.textContent || '').trim();
              // 匹配短文本（按钮文字通常很短）
              if (text.length <= 10 && text.length >= 2) {
                for (const kw of btnKeywords) {
                  if (text.includes(kw)) {
                    qualityBtn = el;
                    break;
                  }
                }
              }
              if (qualityBtn) break;
            }
            
            // 方法1b: 通过 class 属性匹配
            if (!qualityBtn) {
              const classSelectors = [
                '[class*="quality"]', '[class*="Quality"]',
                '[class*="definition"]', '[class*="Definition"]',
                '[class*="clarity"]', '[class*="Clarity"]',
                '[data-e2e="quality"]', '[class*="resolution"]',
                '[class*="xgplayer-quality"]', '[class*="xg-player-quality"]'
              ];
              for (const sel of classSelectors) {
                const els = document.querySelectorAll(sel);
                if (els.length > 0) {
                  qualityBtn = els[0];
                  break;
                }
              }
            }
            
            if (!qualityBtn) {
              return { success: false, reason: '未找到画质按钮, attempt=' + ${attempt} };
            }
            
            // 点击画质按钮打开菜单
            qualityBtn.click();
            
            // 等待菜单弹出后选择最高画质
            return new Promise((resolve) => {
              setTimeout(() => {
                // 查找画质选项列表
                const optionSelectors = [
                  '[class*="quality-item"]', '[class*="QualityItem"]',
                  '[class*="quality_item"]', '[class*="definition-item"]',
                  '[class*="DefinitionItem"]', '[class*="definition_item"]',
                  '[class*="quality-option"]', '[class*="QualityOption"]',
                  '[class*="xgplayer-quality"] li',
                  '[class*="menu-item"]', '[class*="MenuItem"]',
                  'li[class*="item"]', '[class*="option"]',
                  '[data-quality]', '[data-definition]'
                ];
                
                let options = [];
                for (const sel of optionSelectors) {
                  const found = document.querySelectorAll(sel);
                  if (found.length >= 2) {
                    options = found;
                    break;
                  }
                }
                
                // 如果通过选择器找不到，尝试查找所有包含画质关键词的 li/div/span
                if (options.length === 0) {
                  const allItems = document.querySelectorAll('li, div[class*="item"], span[class*="item"]');
                  const qualityItems = [];
                  const qualityKws = ['蓝光', '原画', '超清', '高清', '标清', '1080', '720', '480', '4K', 'HDR', '流畅'];
                  for (const item of allItems) {
                    const t = (item.textContent || '').trim();
                    if (t.length <= 20 && qualityKws.some(kw => t.includes(kw))) {
                      qualityItems.push(item);
                    }
                  }
                  if (qualityItems.length >= 2) {
                    options = qualityItems;
                  }
                }
                
                if (options.length === 0) {
                  resolve({ success: false, reason: '未找到画质选项列表' });
                  return;
                }
                
                // 按优先级选择最高画质
                const priorityKeywords = ['蓝光', '原画', '4K', 'HDR', '1080P', '1080p', '1080', '超清', '720P', '720p', '720'];
                let bestOption = null;
                
                for (const kw of priorityKeywords) {
                  for (const opt of options) {
                    const text = (opt.textContent || '').trim();
                    if (text.includes(kw)) {
                      bestOption = opt;
                      break;
                    }
                  }
                  if (bestOption) break;
                }
                
                // 如果没找到关键词匹配的，选第一个（通常是最高画质）
                if (!bestOption) bestOption = options[0];
                
                const selectedText = (bestOption.textContent || '').trim();
                bestOption.click();
                resolve({ success: true, quality: selectedText });
              }, 1000);
            });
          })();
        `);
        
        if (result && result.success) {
          logger.info(`[Recorder] 已设置最高画质: ${result.quality}`);
          return;
        } else {
          logger.warn(`[Recorder] 设置画质未成功 (尝试 ${attempt}/5): ${result ? result.reason : 'unknown'}`);
        }
      } catch (e) {
        logger.warn(`[Recorder] 设置画质时出错 (尝试 ${attempt}/5): ${e.message}`);
      }
      
      // 等待后重试
      if (attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    logger.warn('[Recorder] 5次尝试后仍未成功设置画质');
  }

  /**
   * 从抖音直播页面提取直播流URL
   * 优先使用API方式，回退到DOM解析
   */
  async extractStreamUrl() {
    // 方法1: 通过抖音API获取直播流URL（最可靠）
    try {
      const apiUrl = `https://live.douyin.com/webcast/room/web/enter/?aid=6383&live_id=1&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=120.0.0.0&web_rid=${this.roomId}`;
      
      logger.info(`[Recorder] 尝试通过API获取直播流URL, roomId: ${this.roomId}`);
      
      // 获取session cookies
      let cookies = '';
      try {
        cookies = await this._getSessionCookies('live.douyin.com');
      } catch (cookieErr) {
        logger.warn(`[Recorder] 获取cookies失败: ${cookieErr.message}`);
      }
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `https://live.douyin.com/${this.roomId}`,
        'Accept': 'application/json, text/plain, */*',
      };
      if (cookies) {
        headers['Cookie'] = cookies;
      }

      const https = require('https');
      const http = require('http');
      const urlModule = require('url');
      
      const apiResult = await new Promise((resolve) => {
        const parsedUrl = urlModule.parse(apiUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        
        const req = client.get(apiUrl, { headers, timeout: 10000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve({ success: true, data: json });
            } catch (e) {
              resolve({ success: false, error: 'JSON解析失败', raw: data.substring(0, 200) });
            }
          });
        });
        req.on('error', (e) => resolve({ success: false, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ success: false, error: '请求超时' }); });
      });

      if (apiResult.success && apiResult.data) {
        const roomData = apiResult.data.data || apiResult.data;
        // 尝试从API响应中提取流URL
        const roomInfo = roomData.data && roomData.data[0] ? roomData.data[0] : roomData;
        
        // 查找 stream_url
        let streamUrl = null;
        const findStreamUrl = (obj, depth = 0) => {
          if (!obj || typeof obj !== 'object' || depth > 10) return null;
          if (obj.stream_url && (obj.stream_url.flv_pull_url || obj.stream_url.hls_pull_url_map)) {
            return obj.stream_url;
          }
          for (const key of Object.keys(obj)) {
            const result = findStreamUrl(obj[key], depth + 1);
            if (result) return result;
          }
          return null;
        };

        streamUrl = findStreamUrl(roomInfo);
        
        if (!streamUrl && roomData.data) {
          // 尝试遍历 data 数组
          const dataArray = Array.isArray(roomData.data) ? roomData.data : [roomData.data];
          for (const item of dataArray) {
            streamUrl = findStreamUrl(item);
            if (streamUrl) break;
          }
        }

        if (streamUrl) {
          const flvUrls = streamUrl.flv_pull_url || {};
          const hlsUrls = streamUrl.hls_pull_url_map || {};
          
          // 按清晰度选择最高画质
          const qualityOrder = ['FULL_HD1', 'HD1', 'SD1', 'SD2', 'LD1'];
          let flvUrl = null;
          for (const q of qualityOrder) {
            if (flvUrls[q]) { flvUrl = flvUrls[q]; break; }
          }
          if (!flvUrl) flvUrl = Object.values(flvUrls)[0];
          
          let hlsUrl = null;
          for (const q of qualityOrder) {
            if (hlsUrls[q]) { hlsUrl = hlsUrls[q]; break; }
          }
          if (!hlsUrl) hlsUrl = Object.values(hlsUrls)[0];

          const finalUrl = flvUrl || hlsUrl;
          if (finalUrl) {
            logger.info(`[Recorder] API获取直播流成功 (类型: ${flvUrl ? 'flv' : 'hls'}, 画质: ${Object.keys(flvUrls).join(',') || Object.keys(hlsUrls).join(',')})`);
            return { url: finalUrl, type: flvUrl ? 'flv' : 'hls', source: 'API' };
          }
        }
        
        logger.warn(`[Recorder] API返回数据中未找到stream_url, keys: ${JSON.stringify(Object.keys(roomInfo || {})).substring(0, 200)}`);
      } else {
        logger.warn(`[Recorder] API请求失败: ${apiResult.error || '未知错误'}, raw: ${(apiResult.raw || '').substring(0, 100)}`);
      }
    } catch (apiErr) {
      logger.warn(`[Recorder] API方式获取直播流失败: ${apiErr.message}`);
    }

    // 方法1.5: 通过页面上下文fetch API获取（自动携带cookies）
    try {
      if (this.captureWindow && !this.captureWindow.isDestroyed()) {
        logger.info('[Recorder] 尝试通过页面fetch获取直播流URL...');
        const fetchResult = await this.captureWindow.webContents.executeJavaScript(`
          (async () => {
            try {
              const resp = await fetch('/webcast/room/web/enter/?aid=6383&live_id=1&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true&web_rid=${this.roomId}', {
                credentials: 'include',
                headers: { 'Accept': 'application/json' }
              });
              const json = await resp.json();
              const findStreamUrl = (obj, depth) => {
                if (!obj || typeof obj !== 'object' || depth > 10) return null;
                if (obj.stream_url && (obj.stream_url.flv_pull_url || obj.stream_url.hls_pull_url_map)) {
                  return obj.stream_url;
                }
                for (const key of Object.keys(obj)) {
                  const result = findStreamUrl(obj[key], depth + 1);
                  if (result) return result;
                }
                return null;
              };
              const roomData = json.data || json;
              const dataArray = Array.isArray(roomData.data) ? roomData.data : [roomData];
              for (const item of dataArray) {
                const streamUrl = findStreamUrl(item);
                if (streamUrl) {
                  const flvUrl = streamUrl.flv_pull_url && Object.values(streamUrl.flv_pull_url)[0];
                  const hlsUrl = streamUrl.hls_pull_url_map && Object.values(streamUrl.hls_pull_url_map)[0];
                  return { url: flvUrl || hlsUrl, type: flvUrl ? 'flv' : 'hls', source: 'page_fetch' };
                }
              }
              return null;
            } catch (e) {
              return { error: e.message };
            }
          })()
        `);
        if (fetchResult && fetchResult.url) {
          logger.info(`[Recorder] 页面fetch获取直播流成功 (来源: ${fetchResult.source}, 类型: ${fetchResult.type})`);
          return fetchResult;
        } else if (fetchResult && fetchResult.error) {
          logger.warn(`[Recorder] 页面fetch获取直播流出错: ${fetchResult.error}`);
        }
      }
    } catch (fetchErr) {
      logger.warn(`[Recorder] 页面fetch方式失败: ${fetchErr.message}`);
    }

    // 方法2: 从页面DOM中提取（回退方案）
    try {
      if (this.captureWindow && !this.captureWindow.isDestroyed()) {
        logger.info('[Recorder] 尝试从页面DOM提取直播流URL...');
        const domResult = await this.captureWindow.webContents.executeJavaScript(`
          (async () => {
            try {
              // 从 RENDER_DATA 中提取
              const renderScript = document.getElementById('RENDER_DATA');
              if (renderScript) {
                const data = JSON.parse(decodeURIComponent(renderScript.textContent));
                const findStreamUrl = (obj, depth) => {
                  if (!obj || typeof obj !== 'object' || depth > 10) return null;
                  if (obj.stream_url && (obj.stream_url.flv_pull_url || obj.stream_url.hls_pull_url_map)) {
                    return obj.stream_url;
                  }
                  for (const key of Object.keys(obj)) {
                    const result = findStreamUrl(obj[key], depth + 1);
                    if (result) return result;
                  }
                  return null;
                };
                const streamUrl = findStreamUrl(data, 0);
                if (streamUrl) {
                  const flvUrl = streamUrl.flv_pull_url && Object.values(streamUrl.flv_pull_url)[0];
                  const hlsUrl = streamUrl.hls_pull_url_map && Object.values(streamUrl.hls_pull_url_map)[0];
                  return { url: flvUrl || hlsUrl, type: flvUrl ? 'flv' : 'hls', source: 'RENDER_DATA' };
                }
              }

              // 从 __NEXT_DATA__ 中提取
              const nextDataScript = document.getElementById('__NEXT_DATA__');
              if (nextDataScript) {
                const data = JSON.parse(nextDataScript.textContent);
                const findStreamUrl = (obj, depth) => {
                  if (!obj || typeof obj !== 'object' || depth > 10) return null;
                  if (obj.stream_url) return obj.stream_url;
                  for (const key of Object.keys(obj)) {
                    const result = findStreamUrl(obj[key], depth + 1);
                    if (result) return result;
                  }
                  return null;
                };
                const streamUrl = findStreamUrl(data, 0);
                if (streamUrl) {
                  const flvUrl = streamUrl.flv_pull_url && Object.values(streamUrl.flv_pull_url)[0];
                  const hlsUrl = streamUrl.hls_pull_url_map && Object.values(streamUrl.hls_pull_url_map)[0];
                  return { url: flvUrl || hlsUrl, type: flvUrl ? 'flv' : 'hls', source: '__NEXT_DATA__' };
                }
              }

              // 从 video 元素获取 src
              const videos = document.querySelectorAll('video');
              for (const video of videos) {
                const src = video.src || video.currentSrc;
                if (src && (src.includes('.flv') || src.includes('live') || src.includes('.m3u8'))) {
                  return { url: src, type: src.includes('.m3u8') ? 'hls' : 'flv', source: 'video_element' };
                }
              }

              // 从页面源码中搜索流URL
              const pageText = document.documentElement.innerHTML;
              const flvMatch = pageText.match(/https?:\/\/[^"'\s]+\.flv[^"'\s]*/);
              if (flvMatch) {
                return { url: flvMatch[0], type: 'flv', source: 'page_text' };
              }
              const m3u8Match = pageText.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
              if (m3u8Match) {
                return { url: m3u8Match[0], type: 'hls', source: 'page_text' };
              }

              return null;
            } catch (e) {
              return { error: e.message };
            }
          })()
        `);

        if (domResult && domResult.url) {
          logger.info(`[Recorder] 从DOM提取到直播流URL (来源: ${domResult.source}, 类型: ${domResult.type})`);
          return domResult;
        } else if (domResult && domResult.error) {
          logger.warn(`[Recorder] DOM提取直播流URL出错: ${domResult.error}`);
        }
      }
    } catch (domErr) {
      logger.warn(`[Recorder] DOM方式提取直播流失败: ${domErr.message}`);
    }

    logger.warn('[Recorder] 所有方式均未能提取到直播流URL');
    return null;
  }

  /**
   * 开始直播流直接录制（含音频）
   */
  startStreamRecording(streamInfo) {
    const resolvedPath = getFFmpegPath();
    const { spawn } = require('child_process');

    const streamUrl = streamInfo.url;
    logger.info(`[Recorder] 使用直播流直接录制: ${streamUrl.substring(0, 80)}...`);

    // 提前设置模式标记，避免 FFmpeg 进程快速退出时的竞态条件
    this.hasAudio = true;
    this._isStreamMode = true;

    const args = [
      '-rw_timeout', '10000000',
      '-timeout', '10000000',
      '-fflags', '+genpts+igndts',
      '-i', streamUrl,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-avoid_negative_ts', 'make_zero',
      '-y',
      this.outputFile
    ];

    logger.info(`[Recorder] 启动 FFmpeg 流录制: ${resolvedPath}`);
    this.ffmpegProcess = spawn(resolvedPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.ffmpegProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) logger.info(`[FFmpeg-Stream] ${msg}`);
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) logger.info(`[FFmpeg-Stream] ${msg}`);
    });

    this.ffmpegProcess.on('close', (code) => {
      logger.info(`[FFmpeg-Stream] 进程退出, code: ${code}`);
      this.ffmpegProcess = null;
      // 如果是流录制模式，进程退出意味着录制结束
      if (this.recording && this._isStreamMode) {
        this.recording = false;
        this.onStatusChange('stopped', {
          roomId: this.roomId,
          streamerName: this.streamerName,
          outputFile: this.outputFile,
          fileSize: this._getFileSize(),
          duration: Date.now() - (this.startTime ? this.startTime.getTime() : Date.now()),
          frameCount: 0
        });
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      logger.error(`[FFmpeg-Stream] 进程错误:`, err);
      this.onError(this.roomId, err);
    });
  }

  /**
   * 从 Electron session 中获取指定域名的 cookies 字符串
   */
  async _getSessionCookies(domain) {
    try {
      const { session } = require('electron');
      const douyinSession = session.fromPartition(this.session || 'persist:douyin');
      const cookies = await douyinSession.cookies.get({ domain: `.${domain}` });
      return cookies
        .filter(c => c.value && c.name)
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
    } catch (e) {
      logger.warn(`[Recorder] 获取 session cookies 失败: ${e.message}`);
      return '';
    }
  }


  /**
   * 获取输出文件大小
   */
  _getFileSize() {
    try {
      if (this.outputFile && fs.existsSync(this.outputFile)) {
        return fs.statSync(this.outputFile).size;
      }
    } catch (e) { /* ignore */ }
    return 0;
  }

  /**
   * 开始录制
   */
  async startRecording() {
    if (this.recording) {
      const errMsg = `录制引擎已在运行中 (room: ${this.roomId})，请先停止再重试`;
      logger.warn(errMsg);
      throw new Error(errMsg);
    }

    logger.info(`[Recorder] 准备开始录制 - 房间: ${this.roomId}, 主播: ${this.streamerName}, URL: ${this.liveUrl}`);

    try {
      const config = getConfig();
      const baseOutputFolder = this.outputFolder || config.outputFolder || this.getDefaultOutputFolder();

      // 按主播名称创建子文件夹
      const streamerFolder = path.join(baseOutputFolder, this.streamerName);

      // 生成时间戳
      const now = new Date();
      this.startTime = now;
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const timeStrFull = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const timeStrShort = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
      const safeName = (this.streamerName || '未知主播').replace(/[<>:"/\\|?*]/g, '_');

      // 子文件夹: [主播名称][年-月-日][时-分-秒]
      const sessionFolder = path.join(streamerFolder, `[${safeName}][${dateStr}][${timeStrFull}]`);
      if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, { recursive: true });
      }

      // 输出文件: [主播名称][年-月-日][时-分].mp4
      const fileName = `[${safeName}][${dateStr}][${timeStrShort}]`;
      this.outputFile = path.join(sessionFolder, `${fileName}.${config.fileFormat || 'mp4'}`);
      this.frameCount = 0;
      this._isStreamMode = false;

      logger.info(`[Recorder] 输出文件: ${this.outputFile}`);

      // 创建捕获窗口（如果还没创建）
      if (!this.captureWindow || this.captureWindow.isDestroyed()) {
        logger.info('[Recorder] 正在创建捕获窗口...');
        await this.createCaptureWindow();
        logger.info('[Recorder] 捕获窗口创建成功');
      }

      // 等待页面加载
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 尝试提取直播流URL（用于音频捕获）
      logger.info('[Recorder] 尝试提取直播流URL...');
      const streamInfo = await this.extractStreamUrl();

      // 始终使用离屏渲染录制视频（含弹幕画面）
      this.hasAudio = false;
      this._isStreamMode = false;

      // 方案A：单FFmpeg进程同时处理视频和音频，实现天然同步
      if (streamInfo && streamInfo.url) {
        logger.info('[Recorder] 使用方案A：单FFmpeg进程同时处理视频和音频');
        this.hasAudio = true;
        
        // 启动单FFmpeg进程（视频+音频）
        logger.info(`[Recorder] 启动 FFmpeg 进程 (视频+音频), FPS: ${config.fps || 30}`);
        this._streamUrl = streamInfo.url;
        this.startFFmpegProcess(config.fps || 30, streamInfo.url);
      } else {
        logger.warn('[Recorder] 未能提取直播流URL，仅录制视频（无音频）');
        this.hasAudio = false;
        this.startFFmpegProcess(config.fps || 30, null);
      }
      
      this.startCapture();

      this.recording = true;

      logger.info(`[Recorder] 录制已开始: ${this.streamerName} -> ${this.outputFile}`);

      this.onStatusChange('recording', {
        roomId: this.roomId,
        streamerName: this.streamerName,
        outputFile: this.outputFile,
        startTime: this.startTime,
        hasAudio: this.hasAudio,
        isStreamMode: this._isStreamMode
      });
    } catch (err) {
      logger.error(`[Recorder] 启动录制失败: ${err.message}`, err);
      // 彻底清理状态
      this.recording = false;
      if (this._captureTimer) {
        clearTimeout(this._captureTimer);
        this._captureTimer = null;
      }
      if (this.ffmpegProcess) {
        try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
        this.ffmpegProcess = null;
      }
      if (this.captureWindow && !this.captureWindow.isDestroyed()) {
        try { this.captureWindow.destroy(); } catch (e) { /* ignore */ }
        this.captureWindow = null;
      }
      this.onStatusChange('error', {
        roomId: this.roomId,
        error: err.message
      });
      throw err;
    }
  }

  /**
   * 启动 FFmpeg 编码进程
   * @param {number} fps - 帧率
   * @param {string|null} streamUrl - 直播流URL（用于音频输入），null则无音频
   */
  startFFmpegProcess(fps, streamUrl) {
    const resolvedPath = getFFmpegPath();
    const { spawn } = require('child_process');

    // 捕获分辨率（用于FFmpeg输入尺寸）
    // 降低分辨率以提高捕获帧率，确保达到30fps
    const captureWidth = 1280;
    const captureHeight = 720;
    
    const args = [];

    // 如果有直播流URL，先添加音频输入（作为第一个输入）
    if (streamUrl) {
      args.push(
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', streamUrl,  // 音频输入（直播流）
      );
      logger.info(`[Recorder] 音频源: 直播流 (${streamUrl.substring(0, 60)}...)`);
    }

    // 视频输入（从管道读取原始帧）- 作为第二个输入
    // 使用实际帧率模式：不强制指定输入帧率，让FFmpeg根据实际数据自适应
    args.push(
      '-f', 'rawvideo',
      '-pix_fmt', 'bgra',
      '-s', `${captureWidth}x${captureHeight}`,
      '-framerate', String(fps),  // 使用-framerate而不是-r，作为提示而非强制
      '-i', 'pipe:0',
    );

    // 音视频编码参数
    args.push(
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '15',
      '-pix_fmt', 'yuv420p',
      '-vsync', 'vfr',  // 可变帧率模式，根据实际输入自适应
    );

    // 如果有音频，添加音频编码和映射
    if (streamUrl) {
      args.push(
        '-map', '0:a',     // 第一个输入(直播流)的音频
        '-map', '1:v',     // 第二个输入(pipe)的视频
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',       // 以最短的流为准
      );
    }

    args.push(
      '-movflags', '+faststart',
      '-y',
      this.outputFile
    );

    logger.info(`[Recorder] 启动 FFmpeg: ${resolvedPath}, 输入格式: bgra`);
    this.ffmpegProcess = spawn(resolvedPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.ffmpegProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) logger.info(`[FFmpeg] ${msg}`);
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) logger.info(`[FFmpeg] ${msg}`);
    });

    this.ffmpegProcess.on('close', (code) => {
      logger.info(`[FFmpeg] 进程退出, code: ${code}`);
      this.ffmpegProcess = null;
    });

    this.ffmpegProcess.on('error', (err) => {
      logger.error(`[FFmpeg] 进程错误:`, err);
      this.onError(this.roomId, err);
    });
  }

  /**
   * 同步检测可用的音频捕获设备
   */
  _detectAudioDeviceSync() {
    const resolvedPath = getFFmpegPath();
    const { execSync } = require('child_process');
    try {
      const output = execSync(`"${resolvedPath}" -f dshow -list_devices true -i dummy 2>&1`, {
        timeout: 5000,
        encoding: 'utf-8'
      });
      // 解析输出，找到第一个音频设备
      const lines = output.split('\n');
      let inAudioSection = false;
      let audioDevice = null;
      for (const line of lines) {
        if (line.includes('DirectShow audio devices')) {
          inAudioSection = true;
          continue;
        }
        if (inAudioSection) {
          // 匹配形如 "Stereo Mix (Realtek Audio)" 的设备名
          const match = line.match(/"([^"]+)"/);
          if (match) {
            audioDevice = match[1];
            break;
          }
        }
      }
      return audioDevice;
    } catch (e) {
      logger.warn('[Recorder] 检测音频设备失败:', e.message);
      return null;
    }
  }

  /**
   * 开始帧捕获循环
   * 使用自适应捕获策略：根据实际捕获能力动态调整，避免帧堆积
   */
  startCapture() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    const config = getConfig();
    const targetFps = config.fps || 30;
    // 捕获分辨率：降低到1280x720以提高捕获速度，确保达到30fps
    const CAPTURE_WIDTH = 1280;
    const CAPTURE_HEIGHT = 720;
    const targetInterval = Math.floor(1000 / targetFps);

    let lastCaptureTime = 0;
    let capturing = false;

    const captureFrame = async () => {
      if (!this.recording || !this.captureWindow || this.captureWindow.isDestroyed()) {
        return;
      }

      // 防止重入：如果上一次捕获还没完成，跳过这次
      if (capturing) {
        // 安排下一次捕获
        if (this.recording) {
          this._captureTimer = setTimeout(captureFrame, targetInterval);
        }
        return;
      }

      capturing = true;
      const now = Date.now();

      try {
        // 捕获完整页面区域（包含视频+右侧评论区）
        const image = await this.captureWindow.webContents.capturePage();
        
        // 获取图像实际尺寸并验证
        const imgSize = image.getSize();
        let bitmap;
        
        if (imgSize.width !== CAPTURE_WIDTH || imgSize.height !== CAPTURE_HEIGHT) {
          // 如果尺寸不匹配，裁剪到正确大小
          const croppedImage = image.crop({
            x: 0,
            y: 0,
            width: Math.min(imgSize.width, CAPTURE_WIDTH),
            height: Math.min(imgSize.height, CAPTURE_HEIGHT)
          });
          bitmap = croppedImage.getBitmap();
          
          // 如果裁剪后仍然小于预期，用黑色填充
          const expectedSize = CAPTURE_WIDTH * CAPTURE_HEIGHT * 4;
          if (bitmap.length < expectedSize) {
            const paddedBuffer = Buffer.alloc(expectedSize, 0);
            for (let row = 0; row < Math.min(imgSize.height, CAPTURE_HEIGHT); row++) {
              const srcOffset = row * imgSize.width * 4;
              const dstOffset = row * CAPTURE_WIDTH * 4;
              const rowBytes = Math.min(imgSize.width, CAPTURE_WIDTH) * 4;
              bitmap.copy(paddedBuffer, dstOffset, srcOffset, srcOffset + rowBytes);
            }
            bitmap = paddedBuffer;
          }
        } else {
          bitmap = image.getBitmap();
        }

        // 检查 FFmpeg 进程是否仍在运行且 stdin 可写
        if (this.ffmpegProcess && this.ffmpegProcess.stdin && !this.ffmpegProcess.stdin.destroyed) {
          try {
            // 检查 stdin 是否可写（防止 write after end 错误）
            if (this.ffmpegProcess.stdin.writable) {
              this.ffmpegProcess.stdin.write(bitmap);
              this.frameCount++;
            }
          } catch (writeErr) {
            // 忽略写入错误，可能是进程正在关闭
            if (writeErr.code !== 'ERR_STREAM_WRITE_AFTER_END' && 
                writeErr.code !== 'ERR_STREAM_DESTROYED') {
              logger.warn('[Recorder] 写入帧数据出错:', writeErr.message);
            }
          }
        }
      } catch (err) {
        if (err.message && !err.message.includes('destroyed')) {
          logger.error('Frame capture error:', err.message);
        }
      } finally {
        capturing = false;
      }

      // 计算下一次捕获的延迟，确保稳定的帧率
      const elapsed = Date.now() - now;
      const nextDelay = Math.max(0, targetInterval - elapsed);
      
      // 安排下一次捕获
      if (this.recording) {
        this._captureTimer = setTimeout(captureFrame, nextDelay);
      }
    };

    // 启动捕获循环
    this._captureTimer = setTimeout(captureFrame, targetInterval);
  }

  /**
   * 停止录制
   */
  async stopRecording() {
    if (!this.recording) return;

    this.recording = false;
    logger.info(`Stopping recording: ${this.streamerName}, total frames: ${this.frameCount}, stream mode: ${this._isStreamMode}`);

    // 停止帧捕获（离屏模式）
    if (this._captureInterval) {
      clearInterval(this._captureInterval);
      this._captureInterval = null;
    }

    // 流模式：通过 stdin 发送 'q' 让 FFmpeg 优雅退出（Windows 兼容）
    if (this._isStreamMode && this.ffmpegProcess) {
      return new Promise((resolve) => {
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;
          
          const fileSize = this._getFileSize();
          
          this.onStatusChange('stopped', {
            roomId: this.roomId,
            streamerName: this.streamerName,
            outputFile: this.outputFile,
            fileSize: fileSize,
            duration: Date.now() - (this.startTime ? this.startTime.getTime() : Date.now()),
            frameCount: 0
          });
          resolve();
        };
        
        // Windows: 通过 stdin 发送 'q' 让 FFmpeg 优雅退出
        // 其他平台: 使用 SIGINT
        try {
          if (process.platform === 'win32') {
            // Windows 上 SIGINT 等同于 TerminateProcess，必须用 stdin 'q'
            if (this.ffmpegProcess.stdin && !this.ffmpegProcess.stdin.destroyed) {
              this.ffmpegProcess.stdin.write('q\n');
              this.ffmpegProcess.stdin.end();
            } else {
              // stdin 不可用时用 taskkill 发送 WM_CLOSE
              const { exec } = require('child_process');
              exec(`taskkill /PID ${this.ffmpegProcess.pid} /T`);
            }
          } else {
            this.ffmpegProcess.kill('SIGINT');
          }
        } catch (e) {
          try { this.ffmpegProcess.kill('SIGINT'); } catch (e2) { /* ignore */ }
        }
        
        this.ffmpegProcess.on('close', done);

        // 超时强制结束
        setTimeout(() => {
          if (this.ffmpegProcess) {
            try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
          }
          done();
        }, 15000);
      });
    }

    // 离屏模式：关闭 stdin 让 FFmpeg 完成编码
    if (this.ffmpegProcess && this.ffmpegProcess.stdin) {
      return new Promise(async (resolve) => {
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;

          const fileSize = this._getFileSize();
          
          // 方案A：单FFmpeg进程直接输出带音频的视频，无需合并
          this._lastRecordingResult = {
            hasAudio: this.hasAudio,
            merged: true,
            saved: true,
            outputFile: this.outputFile,
            timestamp: Date.now()
          };

          this.onStatusChange('stopped', {
            roomId: this.roomId,
            streamerName: this.streamerName,
            outputFile: this.outputFile,
            fileSize: fileSize,
            duration: Date.now() - (this.startTime ? this.startTime.getTime() : Date.now()),
            frameCount: this.frameCount,
            hasAudio: this.hasAudio,
            merged: true
          });
          resolve();
        };
        
        this.ffmpegProcess.stdin.end();
        this.ffmpegProcess.on('close', done);

        // 超时强制结束
        setTimeout(() => {
          if (this.ffmpegProcess) {
            try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
          }
          done();
        }, 15000);
      });
    }

    this.onStatusChange('stopped', {
      roomId: this.roomId,
      streamerName: this.streamerName,
      outputFile: this.outputFile,
      fileSize: 0
    });
  }

  /**
   * 销毁录制器，强制终止所有进程
   */
  async destroy() {
    // 停止帧捕获
    if (this._captureTimer) {
      clearTimeout(this._captureTimer);
      this._captureTimer = null;
    }
    if (this._captureInterval) {
      clearInterval(this._captureInterval);
      this._captureInterval = null;
    }

    // 强制终止 FFmpeg 进程（方案A：单进程，无音频进程）
    if (this.ffmpegProcess) {
      try {
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${this.ffmpegProcess.pid} /f /t 2>nul`, { stdio: 'ignore' });
        } else if (!this.ffmpegProcess.killed) {
          this.ffmpegProcess.kill('SIGKILL');
        }
      } catch (e) { /* ignore */ }
      this.ffmpegProcess = null;
    }

    // 等待进程完全退出
    await new Promise(r => setTimeout(r, 500));

    // 销毁捕获窗口
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      try { this.captureWindow.destroy(); } catch (e) { /* ignore */ }
      this.captureWindow = null;
    }

    this.recording = false;
  }

  /**
   * 获取默认输出文件夹
   */
  getDefaultOutputFolder() {
    const { app } = require('electron');
    return path.join(app.getPath('videos'), '抖音直播录制');
  }

  /**
   * 获取录制状态
   */
  getStatus() {
    return {
      recording: this.recording,
      streamerName: this.streamerName,
      roomId: this.roomId,
      outputFile: this.outputFile,
      frameCount: this.frameCount,
      startTime: this.startTime,
      hasAudio: this.hasAudio,
      lastRecordingResult: this._lastRecordingResult || null,
      duration: this.startTime ? Date.now() - this.startTime.getTime() : 0
    };
  }
}

module.exports = { Recorder };
