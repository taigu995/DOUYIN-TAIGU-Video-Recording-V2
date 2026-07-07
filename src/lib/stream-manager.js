/**
 * 直播间管理模块
 * 管理直播间的添加、删除、状态监听和录制控制
 */
const { BrowserWindow } = require('electron');
const https = require('https');
const { Recorder } = require('./recorder');
const { extractUrl, extractInput, extractNameFromText, resolveShortUrl, buildLiveUrl } = require('./douyin-utils');
const { getConfig, addStream, removeStream, updateStream, getStreams } = require('./config');
const { getLogger } = require('./logger');

const logger = getLogger();

class StreamManager {
  constructor(config, accountManager, onUpdate) {
    // roomId -> { info, recorder, monitorWindow, status, timer }
    this.streams = new Map();
    this.accountManager = accountManager;
    this.onUpdate = onUpdate || null; // UI 更新回调
    logger.info('StreamManager initialized');
  }

  /**
   * 设置 UI 更新回调
   */
  setUpdateCallback(callback) {
    this.onUpdate = callback;
  }

  /**
   * 通知 UI 更新
   */
  notifyUpdate() {
    if (this.onUpdate) {
      this.onUpdate(this.getAllStatus());
    }
  }

  /**
   * 添加直播间
   * @param {string} inputText - 用户输入（房间号、链接或分享文本）
   */
  async addStreamByInput(inputText, customName, streamerNameFromPreview) {
    if (!inputText || typeof inputText !== 'string') {
      throw new Error('输入为空，无法解析直播间信息');
    }
    logger.info(`Adding stream, input: "${inputText.substring(0, 50)}...", customName: "${customName || ''}", streamerNameFromPreview: "${streamerNameFromPreview || 'none'}"`);
    
    // 1. 智能解析输入
    const parsed = extractInput(inputText);
    if (!parsed) {
      logger.warn(`Failed to parse input: "${inputText}"`);
      throw new Error('未能识别有效的抖音直播间信息\n支持：房间号(如123456)、分享链接、分享文本');
    }

    // 2. 尝试从文本中提取主播名称
    let streamerName = extractNameFromText(inputText);

    // 3. 根据输入类型获取 roomId
    let roomId, realUrl;

    if (parsed.type === 'roomId') {
      // 直接输入的房间号
      roomId = parsed.value;
      realUrl = buildLiveUrl(roomId);
      logger.info(`Direct room ID: ${roomId}`);
    } else {
      // URL 类型，需要解析
      const url = parsed.value;
      if (url.includes('v.douyin.com')) {
        const resolved = await resolveShortUrl(url);
        roomId = resolved.roomId;
        realUrl = resolved.realUrl;
        logger.info(`Resolved short URL to roomId: ${roomId}`);
      } else if (url.includes('live.douyin.com')) {
        const match = url.match(/live\.douyin\.com\/([A-Za-z0-9_]+)/);
        roomId = match ? match[1] : null;
        realUrl = url;
      }
    }

    if (!roomId) {
      logger.error('Failed to extract roomId from input');
      throw new Error('无法解析直播间ID，请检查输入是否正确');
    }

    // 检查是否已添加
    if (this.streams.has(roomId)) {
      logger.warn(`Stream already exists: ${roomId}`);
      throw new Error(`直播间 ${roomId} 已在列表中`);
    }

    // 4. 构建直播间URL
    const liveUrl = buildLiveUrl(roomId);

    // 5. 获取主播名称（预览已获取则跳过）
    if (streamerNameFromPreview) {
      streamerName = streamerNameFromPreview;
      logger.info(`Using streamer name from preview: ${streamerName}`);
    } else if (!streamerName && !customName) {
      logger.info(`Fetching streamer name for roomId: ${roomId}`);
      try {
        streamerName = await this.fetchStreamerName(roomId, liveUrl);
      } catch (e) {
        logger.warn(`Failed to fetch streamer name: ${e.message}`);
      }
    }

    // 6. 构建最终主播名称：自定义名称优先
    const finalName = customName || streamerName || `主播${roomId}`;

    // 7. 创建流信息（包含每直播间独立设置）
    const streamInfo = {
      roomId,
      liveUrl,
      streamerName: finalName,
      originalUrl: parsed.type === 'roomId' ? liveUrl : parsed.value,
      addedAt: Date.now(),
      // 每直播间独立设置
      accountId: null,       // 录制的账号ID（null=无账号）
      commentFps: 15,        // 评论区帧率
      recordMode: 'with-account' // with-account | stream-only | stream+comment-no-login
    };

    // 7. 保存到配置
    addStream(streamInfo);

    // 8. 创建监控和录制实例
    const streamState = {
      info: streamInfo,
      recorder: null,
      monitorWindow: null,
      status: 'checking',    // checking | live | offline | recording
      isLive: false,
      lastCheck: null
    };

    this.streams.set(roomId, streamState);

    // 9. 创建监控窗口（非阻塞，不等待页面加载完成）
    this.createMonitorWindow(streamState).catch(e => {
      logger.warn(`Failed to create monitor window: ${e.message}`);
    });

    // 10. 开始状态监听
    this.startMonitoring(streamState);

    this.notifyUpdate();
    return streamInfo;
  }

  /**
   * 通过API获取主播名称（携带session cookies）
   */
  async fetchStreamerNameFromAPI(roomId) {
    return new Promise((resolve) => {
      const { session } = require('electron');
      const douyinSession = session.fromPartition('persist:douyin');
      
      // 获取cookies用于API请求
      douyinSession.cookies.get({ domain: '.douyin.com' }).then(cookies => {
        const cookieStr = cookies
          .filter(c => c.value && c.name)
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        
        const url = `https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&web_rid=${roomId}`;
        
        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Referer': `https://live.douyin.com/${roomId}`,
            'Cookie': cookieStr || ''
          }
        };

        https.get(url, options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              // 尝试从多个可能的路径获取主播名称
              const roomInfo = json?.data?.data?.[0];
              const owner = roomInfo?.owner;
              const name = owner?.nickname || owner?.name || roomInfo?.nickname;
              if (name) {
                logger.info(`[API] 获取主播名称成功: ${name}`);
                resolve(name);
              } else {
                // 尝试其他路径
                const altName = json?.data?.user?.nickname || json?.data?.owner?.nickname;
                if (altName) {
                  logger.info(`[API] 获取主播名称成功(alt): ${altName}`);
                  resolve(altName);
                } else {
                  logger.warn(`[API] 未找到主播名称，响应: ${data.substring(0, 300)}`);
                  resolve(null);
                }
              }
            } catch (e) {
              logger.warn(`[API] 解析响应失败: ${e.message}, 原始数据: ${data.substring(0, 200)}`);
              resolve(null);
            }
          });
        }).on('error', (e) => {
          logger.warn(`[API] 请求失败: ${e.message}`);
          resolve(null);
        });
        
        // 超时10秒
        setTimeout(() => {
          logger.warn(`[API] 请求超时`);
          resolve(null);
        }, 10000);
      }).catch(e => {
        logger.warn(`[API] 获取cookies失败: ${e.message}`);
        resolve(null);
      });
    });
  }

  /**
   * 获取主播名称（通过加载页面获取）
   */
  async fetchStreamerName(roomId, liveUrl) {
    // 首先尝试API方式
    const apiName = await this.fetchStreamerNameFromAPI(roomId);
    if (apiName) {
      return apiName;
    }

    // API失败，使用DOM方式
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: 'persist:douyin',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          additionalArguments: ['--mute-audio'],
          audioPlaybackPolicy: 'never'
        }
      });

      const timeout = setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
        resolve(null);
      }, 15000);

      win.loadURL(liveUrl).then(() => {
        setTimeout(async () => {
          try {
            // 从页面标题或DOM获取主播名称（使用更多选择器）
            const name = await win.webContents.executeJavaScript(`
              (function() {
                // 尝试多种选择器获取主播名称
                const selectors = [
                  // 直播间主播名称
                  '[data-e2e="live-room-streamer-name"]',
                  '[class*="streamer-name"]',
                  '[class*="StreamerName"]',
                  '[class*="anchor-name"]',
                  '[class*="AnchorName"]',
                  '[class*="host-name"]',
                  '[class*="HostName"]',
                  // 通用用户名称
                  '[class*="nickname"]',
                  '[class*="NickName"]',
                  '[class*="author"]',
                  '[class*="Author"]',
                  '[class*="userName"]',
                  '[class*="UserName"]',
                  '[class*="user-name"]',
                  // 头部信息
                  'header [class*="name"]',
                  'header [class*="title"]',
                  // 直播间信息区域
                  '[class*="live-info"] [class*="name"]',
                  '[class*="room-info"] [class*="name"]',
                  '[class*="streamer"] [class*="name"]'
                ];
                
                for (const sel of selectors) {
                  const el = document.querySelector(sel);
                  if (el && el.textContent && el.textContent.trim()) {
                    const text = el.textContent.trim();
                    // 排除一些常见的非名称文本
                    if (text && text !== '关注' && text !== '粉丝' && text.length < 30) {
                      return text;
                    }
                  }
                }

                // 从title获取（格式通常是"xxx的直播间 - 抖音"）
                const title = document.title;
                if (title) {
                  // 尝试匹配"xxx的直播间"
                  const match = title.match(/^(.+?)的直播间/);
                  if (match) return match[1].trim();
                  
                  // 尝试匹配"@xxx"
                  const atMatch = title.match(/@([^\\s]+)/);
                  if (atMatch) return atMatch[1].trim();
                }

                // 从meta标签获取
                const meta = document.querySelector('meta[property="og:title"]');
                if (meta && meta.content) {
                  const content = meta.content.trim();
                  const match = content.match(/^(.+?)的直播间/);
                  if (match) return match[1].trim();
                  if (content && content.length < 50) return content;
                }
                
                // 从meta description获取
                const descMeta = document.querySelector('meta[name="description"]');
                if (descMeta && descMeta.content) {
                  const content = descMeta.content;
                  // 尝试从描述中提取主播名
                  const nameMatch = content.match(/主播[：:]\\s*([^\\s,，]+)/);
                  if (nameMatch) return nameMatch[1].trim();
                }

                return null;
              })();
            `);
            clearTimeout(timeout);
            if (!win.isDestroyed()) win.destroy();
            resolve(name);
          } catch (e) {
            clearTimeout(timeout);
            if (!win.isDestroyed()) win.destroy();
            resolve(null);
          }
        }, 3000);
      }).catch(() => {
        clearTimeout(timeout);
        if (!win.isDestroyed()) win.destroy();
        resolve(null);
      });
    });
  }

  /**
   * 创建监控窗口（用于检测直播状态）
   */
  async createMonitorWindow(streamState) {
    const win = new BrowserWindow({
      show: false,
      width: 1920,
      height: 1080,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:douyin',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        additionalArguments: ['--mute-audio'],
        audioPlaybackPolicy: 'never'
      }
    });

    streamState.monitorWindow = win;

    try {
      // 15秒超时，避免页面加载卡死
      await Promise.race([
        win.loadURL(streamState.info.liveUrl, {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('页面加载超时(15s)')), 15000))
      ]);
    } catch (e) {
      logger.warn(`[Monitor] 加载页面出错: ${e.message}`);
    }
  }

  /**
   * 开始定时监控直播状态
   */
  startMonitoring(streamState) {
    const config = getConfig();
    const interval = (config.checkInterval || 30) * 1000;

    // 立即检查一次
    this.checkLiveStatus(streamState);

    // 定时检查
    streamState.timer = setInterval(() => {
      this.checkLiveStatus(streamState);
    }, interval);
  }

  /**
   * 通过API检查直播状态（轻量级，不依赖BrowserWindow）
   * @returns {{ isLive: boolean, streamerName: string|null }}
   */
  async checkLiveStatusFromAPI(roomId) {
    return new Promise((resolve) => {
      const { session } = require('electron');
      const douyinSession = session.fromPartition('persist:douyin');
      
      douyinSession.cookies.get({ domain: '.douyin.com' }).then(cookies => {
        const cookieStr = cookies
          .filter(c => c.value && c.name)
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        
        const url = `https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&web_rid=${roomId}`;
        
        const https = require('https');
        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Referer': `https://live.douyin.com/${roomId}`,
            'Cookie': cookieStr || ''
          }
        };

        https.get(url, options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              const roomInfo = json?.data?.data?.[0];
              
              // status: 2 = 直播中, 其他 = 未开播
              const status = roomInfo?.status;
              const isLive = status === 2;
              
              // 获取主播名称
              const owner = roomInfo?.owner;
              const streamerName = owner?.nickname || owner?.name || roomInfo?.nickname 
                || json?.data?.user?.nickname || null;
              
              resolve({ isLive, streamerName });
            } catch (e) {
              logger.warn(`[API] 状态检查解析失败: ${e.message}`);
              resolve(null);
            }
          });
        }).on('error', (e) => {
          logger.warn(`[API] 状态检查请求失败: ${e.message}`);
          resolve(null);
        });
        
        // 超时10秒
        setTimeout(() => {
          logger.warn(`[API] 状态检查请求超时`);
          resolve(null);
        }, 10000);
      }).catch(e => {
        logger.warn(`[API] 获取cookies失败: ${e.message}`);
        resolve(null);
      });
    });
  }

  /**
   * 检查直播状态（优先使用API，失败时回退到页面方式）
   */
  async checkLiveStatus(streamState) {
    // 防止并发检查
    if (streamState._checking) {
      return;
    }
    streamState._checking = true;

    try {
      const { info } = streamState;
      logger.info(`[Monitor] 检查直播状态: ${info.streamerName} (${info.roomId})`);

      // 优先使用API方式检查（轻量、可靠）
      const apiResult = await this.checkLiveStatusFromAPI(info.roomId);
      
      if (apiResult) {
        // API成功，使用API结果
        let isLive = apiResult.isLive;
        
        // 更新主播名称（如果有新名称且旧名称是默认的）
        if (apiResult.streamerName && (!info.streamerName || info.streamerName.startsWith('主播'))) {
          info.streamerName = apiResult.streamerName;
          updateStream(info.roomId, { streamerName: apiResult.streamerName });
        }

        const wasLive = streamState.isLive;
        streamState.isLive = isLive;
        streamState.lastCheck = Date.now();
        streamState.status = isLive ? 'live' : 'offline';

        // 状态变化处理
        if (isLive && !wasLive) {
          logger.info(`[Monitor] ${info.streamerName} (${info.roomId}) 开播了!`);
          streamState.status = 'live';

          // 自动开始录制（检查全局开关和单个直播间开关）
          const config = getConfig();
          if (config.autoRecord && streamState.info.autoRecord !== false) {
            logger.info(`[Monitor] 自动录制已开启，开始录制: ${info.streamerName}`);
            this.startRecording(info.roomId);
          }
        } else if (!isLive && wasLive) {
          logger.info(`[Monitor] ${info.streamerName} (${info.roomId}) 下播了`);
          streamState.status = 'offline';

          // 录制中则停止
          if (streamState.recorder && streamState.recorder.recording) {
            logger.info(`[Monitor] 直播结束，停止录制: ${info.streamerName}`);
            this.stopRecording(info.roomId);
          }
          
          // 自动录制开启时，直播结束后立即重新检测
          const config = getConfig();
          if (config.autoRecord && streamState.info.autoRecord !== false) {
            logger.info(`[Monitor] ${info.streamerName} (${info.roomId}) 直播结束，自动录制开启，立即重新检测...`);
            setTimeout(() => {
              if (streamState.info.autoRecord !== false) {
                this.checkLiveStatus(streamState).then(() => {
                  this.notifyUpdate();
                }).catch(err => {
                  logger.warn(`[Monitor] 重新检测失败: ${err.message}`);
                });
              }
            }, 2000);
          }
        }

        this.notifyUpdate();
        return;
      }

      // API失败，回退到页面方式
      logger.info(`[Monitor] API检查失败，回退到页面方式: ${info.roomId}`);
      await this._checkLiveStatusFromPage(streamState);

    } catch (err) {
      logger.warn(`[Monitor] 检查状态异常: ${err.message}`);
    } finally {
      streamState._checking = false;
    }
  }

  /**
   * 通过页面方式检查直播状态（备用方案）
   */
  async _checkLiveStatusFromPage(streamState) {
    const { monitorWindow, info } = streamState;

    if (!monitorWindow || monitorWindow.isDestroyed()) {
      logger.warn(`[Monitor] 监控窗口已销毁，重新创建: ${info.roomId}`);
      await this.createMonitorWindow(streamState);
      return;
    }

    // 重新加载页面以获取最新状态
    await monitorWindow.loadURL(info.liveUrl, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    });

    // 等待页面加载
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 再次检查窗口是否仍然可用
    if (monitorWindow.isDestroyed()) {
      return;
    }

    // 检测是否在直播
    const isLive = await monitorWindow.webContents.executeJavaScript(`
      (function() {
        const video = document.querySelector('video');
        if (video && !video.paused && video.readyState >= 2) {
          return true;
        }
        const body = document.body.innerText || '';
        if (body.includes('直播中') || body.includes('正在直播')) {
          return true;
        }
        const liveBadge = document.querySelector('[class*="living"], [class*="is-live"], [class*="on-live"]');
        if (liveBadge) return true;
        const title = document.title || '';
        if (title.includes('直播') && !title.includes('未开播') && !title.includes('回放')) {
          return true;
        }
        return false;
      })();
    `);

    // 尝试获取主播名称（如果还没有）
    if (!streamState.info.streamerName || streamState.info.streamerName.startsWith('主播')) {
      try {
        if (!monitorWindow.isDestroyed()) {
          const name = await monitorWindow.webContents.executeJavaScript(`
            (function() {
              const selectors = [
                '[class*="nickname"]',
                '[class*="author-name"]',
                '[class*="anchor-name"]',
                '[data-e2e="live-anchor-name"]',
                '.room-info .name'
              ];
              for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim()) {
                  return el.textContent.trim();
                }
              }
              const title = document.title;
              if (title && title.includes('的直播间')) {
                return title.split('的直播间')[0].trim();
              }
              return null;
            })();
          `);
          if (name) {
            streamState.info.streamerName = name;
            updateStream(info.roomId, { streamerName: name });
          }
        }
      } catch (e) {
        logger.warn(`[Monitor] 获取主播名称失败: ${e.message}`);
      }
    }

    const wasLive = streamState.isLive;
    streamState.isLive = isLive;
    streamState.lastCheck = Date.now();
    streamState.status = isLive ? 'live' : 'offline';

    // 状态变化处理
    if (isLive && !wasLive) {
      logger.info(`[Monitor] ${info.streamerName} (${info.roomId}) 开播了!`);
      streamState.status = 'live';

      const config = getConfig();
      if (config.autoRecord && streamState.info.autoRecord !== false) {
        logger.info(`[Monitor] 自动录制已开启，开始录制: ${info.streamerName}`);
        this.startRecording(info.roomId);
      }
    } else if (!isLive && wasLive) {
      logger.info(`[Monitor] ${info.streamerName} (${info.roomId}) 下播了`);
      streamState.status = 'offline';

      if (streamState.recorder && streamState.recorder.recording) {
        logger.info(`[Monitor] 直播结束，停止录制: ${info.streamerName}`);
        this.stopRecording(info.roomId);
      }
      
      const config = getConfig();
      if (config.autoRecord && streamState.info.autoRecord !== false) {
        setTimeout(() => {
          if (streamState.info.autoRecord !== false) {
            this.checkLiveStatus(streamState).then(() => {
              this.notifyUpdate();
            }).catch(err => {
              logger.warn(`[Monitor] 重新检测失败: ${err.message}`);
            });
          }
        }, 2000);
      }
    }

    this.notifyUpdate();
  }

  /**
   * 开始录制指定直播间
   */
  async startRecording(roomId, force = false) {
    const streamState = this.streams.get(roomId);
    if (!streamState) throw new Error('直播间不存在');

    // 如果已有录制实例且正在录制
    if (streamState.recorder && streamState.recorder.recording) {
      if (force) {
        // 强制重置：先停止现有录制
        logger.warn(`[StreamManager] 强制重置录制: ${streamState.info.streamerName} (${roomId})`);
        try {
          await streamState.recorder.stopRecording();
          streamState.recorder.destroy();
        } catch (e) {
          logger.warn(`[StreamManager] 强制重置时清理旧录制出错: ${e.message}`);
        }
        streamState.recorder = null;
      } else {
        logger.warn(`[StreamManager] 已在录制中: ${streamState.info.streamerName} (${roomId})`);
        throw new Error('该直播间正在录制中，请先停止当前录制');
      }
    }

    // 清理残留的录制实例（状态异常的情况）
    if (streamState.recorder && !streamState.recorder.recording) {
      logger.info(`[StreamManager] 清理残留录制实例: ${roomId}`);
      try { streamState.recorder.destroy(); } catch (e) { /* ignore */ }
      streamState.recorder = null;
    }

    const config = getConfig();
    logger.info(`[StreamManager] 开始录制: ${streamState.info.streamerName} (${roomId}), URL: ${streamState.info.liveUrl}`);

    // 确定录制模式和session
    const recordMode = streamState.info.recordMode || 'with-account';
    let sessionName = 'persist:douyin'; // 默认session

    if (recordMode === 'with-account' && streamState.info.accountId) {
      // 有账号模式：使用指定账号的session
      sessionName = this.accountManager.getSessionName(streamState.info.accountId);
      logger.info(`[StreamManager] 使用账号session: ${sessionName}`);
    } else if (recordMode === 'stream-only') {
      // 纯直播流模式：不需要评论区
      logger.info(`[StreamManager] 纯直播流录制模式`);
    } else if (recordMode === 'stream+comment-no-login') {
      // 无账号+评论区模式：使用干净的临时session，不携带任何登录Cookie
      sessionName = 'clean-session-' + streamState.info.roomId;
      logger.info(`[StreamManager] 无账号评论区录制模式（使用干净session，自动关闭登录弹窗）`);
    }

    const recorder = new Recorder({
      roomId: streamState.info.roomId,
      streamerName: streamState.info.streamerName,
      liveUrl: streamState.info.liveUrl,
      outputFolder: config.outputFolder,
      session: sessionName,
      recordMode: recordMode,
      commentFps: streamState.info.commentFps || config.commentFps || 30,
      sessionName: sessionName,
      onStatusChange: (status, data) => {
        if (status === 'recording') {
          streamState.status = 'recording';
          streamState.currentRecordingStart = Date.now();
          logger.info(`[StreamManager] 录制状态变更 -> recording: ${streamState.info.streamerName} (模式: ${data.mode || 'stream+comment'})`);
        } else if (status === 'merging') {
          streamState.status = 'merging';
          logger.info(`[StreamManager] 正在合并视频和评论区: ${streamState.info.streamerName}, 评论帧数: ${data.commentFrames}, FPS: ${data.commentFps ? data.commentFps.toFixed(1) : 'N/A'}`);
        } else if (status === 'stopped') {
          streamState.status = streamState.isLive ? 'live' : 'offline';
          // 保存录制记录
          if (streamState.currentRecordingStart && data && data.outputFile) {
            const record = {
              startTime: streamState.currentRecordingStart,
              endTime: Date.now(),
              outputFile: data.outputFile,
              fileSize: data.fileSize || 0,
              streamerName: streamState.info.streamerName,
              merged: data.merged || false,
              commentFrames: data.commentFrames || 0,
              hasAudio: data.hasAudio || false
            };
            if (!streamState.info.recordingHistory) {
              streamState.info.recordingHistory = [];
            }
            streamState.info.recordingHistory.unshift(record);
            // 只保留最近50条记录
            if (streamState.info.recordingHistory.length > 50) {
              streamState.info.recordingHistory = streamState.info.recordingHistory.slice(0, 50);
            }
            updateStream(streamState.info.roomId, { recordingHistory: streamState.info.recordingHistory });
            logger.info(`[StreamManager] 录制完成: ${data.outputFile}, 大小: ${data.fileSize} bytes, 合并: ${data.merged}, 评论帧: ${data.commentFrames}`);
          }
          streamState.currentRecordingStart = null;

          // 录制结束后，如果自动录制开启且直播在线，立即重新检测并录制
          if (streamState.info.autoRecord && streamState.isLive) {
            logger.info(`[StreamManager] 录制结束，自动录制开启，立即重新检测直播状态: ${streamState.info.streamerName}`);
            setTimeout(() => {
              // 重新检测直播状态
              this.checkLiveStatus(streamState).then(() => {
                if (streamState.isLive && streamState.info.autoRecord && !streamState.recorder) {
                  logger.info(`[StreamManager] 直播仍在进行中，自动重新录制: ${streamState.info.streamerName}`);
                  this.startRecording(streamState.info.roomId);
                }
              }).catch(err => {
                logger.error(`[StreamManager] 重新检测直播状态失败: ${err.message}`);
              });
            }, 2000);
          }
        } else if (status === 'error') {
          streamState.status = 'error';
          logger.error(`[StreamManager] 录制错误 (${streamState.info.streamerName}): ${data && data.error}`);
        }
        this.notifyUpdate();
      },
      onError: (id, err) => {
        logger.error(`[StreamManager] 录制引擎错误 (${streamState.info.streamerName}): ${err.message}`);
        streamState.status = 'error';
        this.notifyUpdate();
      }
    });

    streamState.recorder = recorder;
    streamState.status = 'checking';
    this.notifyUpdate();

    try {
      await recorder.startRecording();
      streamState.status = 'recording';
      streamState.currentRecordingStart = Date.now();
      logger.info(`[StreamManager] 录制启动成功: ${streamState.info.streamerName}`);
      this.notifyUpdate();
    } catch (err) {
      logger.error(`[StreamManager] 录制启动失败 (${streamState.info.streamerName}): ${err.message}`);
      streamState.status = 'error';
      streamState.recorder = null;
      try { recorder.destroy(); } catch (e) { /* ignore */ }
      this.notifyUpdate();
      throw err;
    }
  }

  /**
   * 停止录制指定直播间
   */
  async stopRecording(roomId) {
    const streamState = this.streams.get(roomId);
    if (!streamState || !streamState.recorder) return null;

    const recorder = streamState.recorder;
    const outputFile = recorder.outputFile;
    const startTime = streamState.currentRecordingStart || recorder.startTime;
    const hasAudio = recorder.hasAudio || false;
    
    await recorder.stopRecording();
    
    // 获取合并结果
    const lastResult = recorder._lastRecordingResult;
    
    // 确保录制记录被保存（即使 onStatusChange 回调未触发）
    if (startTime && outputFile) {
      if (!streamState.info.recordingHistory) {
        streamState.info.recordingHistory = [];
      }
      // 检查是否已经保存过（避免重复）
      const alreadySaved = streamState.info.recordingHistory.some(
        r => r.outputFile === outputFile
      );
      if (!alreadySaved) {
        let fileSize = 0;
        try {
          const fs = require('fs');
          if (fs.existsSync(outputFile)) {
            fileSize = fs.statSync(outputFile).size;
          }
        } catch (e) { /* ignore */ }
        
        const record = {
          startTime: typeof startTime === 'string' ? new Date(startTime).getTime() : (startTime instanceof Date ? startTime.getTime() : startTime),
          endTime: Date.now(),
          outputFile: outputFile,
          fileSize: fileSize,
          streamerName: streamState.info.streamerName,
          hasAudio: hasAudio,
          merged: lastResult ? lastResult.merged : false,
          commentFrames: lastResult ? (lastResult.commentFrames || 0) : 0,
          mergeResult: lastResult ? lastResult.mergeResult : null
        };
        streamState.info.recordingHistory.unshift(record);
        if (streamState.info.recordingHistory.length > 50) {
          streamState.info.recordingHistory = streamState.info.recordingHistory.slice(0, 50);
        }
        updateStream(streamState.info.roomId, { recordingHistory: streamState.info.recordingHistory });
        logger.info(`[StreamManager] 录制记录已保存: ${outputFile}, 大小: ${fileSize} bytes, 合并: ${record.merged}`);
      }
    }
    
    streamState.currentRecordingStart = null;
    
    // 在销毁 recorder 之前读取结果
    const resultData = {
      hasAudio,
      merged: lastResult ? lastResult.merged : false,
      commentFrames: lastResult ? (lastResult.commentFrames || 0) : 0,
      mergeResult: lastResult ? lastResult.mergeResult : null,
      outputFile
    };
    
    try { recorder.destroy(); } catch (e) { /* ignore */ }
    streamState.recorder = null;
    streamState.status = streamState.isLive ? 'live' : 'offline';
    this.notifyUpdate();

    // 停止录制后，如果自动录制开启且直播在线，立即重新录制
    if (streamState.info.autoRecord && streamState.isLive) {
      logger.info(`[StreamManager] 自动录制开启，直播在线，自动重新录制: ${streamState.info.streamerName}`);
      // 延迟1秒再重新录制，确保上一次录制完全清理
      setTimeout(() => {
        if (streamState.info.autoRecord && streamState.isLive && !streamState.recorder) {
          this.startRecording(streamState.info.roomId);
        }
      }, 1000);
    }

    return resultData;
  }

  /**
   * 删除直播间
   */
  async removeStreamById(roomId) {
    const streamState = this.streams.get(roomId);
    if (!streamState) return;

    // 停止录制
    if (streamState.recorder) {
      await streamState.recorder.stopRecording();
      streamState.recorder.destroy();
    }

    // 停止监控
    if (streamState.timer) {
      clearInterval(streamState.timer);
    }

    // 销毁监控窗口
    if (streamState.monitorWindow && !streamState.monitorWindow.isDestroyed()) {
      streamState.monitorWindow.destroy();
    }

    this.streams.delete(roomId);
    removeStream(roomId);
    this.notifyUpdate();
  }

  /**
   * 切换自动录制开关
   */
  toggleAutoRecord(roomId) {
    const state = this.streams.get(roomId);
    if (!state) return null;

    const current = state.info.autoRecord !== false; // 默认为 true
    state.info.autoRecord = !current;

    // 更新配置
    updateStream(roomId, { autoRecord: state.info.autoRecord });

    logger.info(`[StreamManager] 切换自动录制: ${roomId} -> ${state.info.autoRecord}`);
    this.notifyUpdate();

    // 如果开启自动录制，立即重新检测直播状态
    if (state.info.autoRecord) {
      logger.info(`[StreamManager] 自动录制已开启，立即检测直播状态: ${roomId}`);
      this.checkLiveStatus(state).then(() => {
        // 检测完成后，如果直播中且未在录制，立即开始录制
        if (state.info.autoRecord && state.isLive && !state.recorder) {
          logger.info(`[StreamManager] 检测到直播中，立即开始录制: ${roomId}`);
          this.startRecording(roomId);
        }
      }).catch(err => {
        logger.error(`[StreamManager] 自动录制状态检测失败: ${err.message}`);
      });
    }

    return state.info.autoRecord;
  }

  /**
   * 设置直播间录制账号
   * @param {string} roomId - 直播间ID
   * @param {string|null} accountId - 账号ID，null表示无账号模式
   * @returns {object} 更新后的流信息
   */
  setRoomAccount(roomId, accountId) {
    const state = this.streams.get(roomId);
    if (!state) return null;

    // 防呆机制：检查账号是否已被其他直播间使用
    if (accountId) {
      for (const [rid, s] of this.streams.entries()) {
        if (rid !== roomId && s.info.accountId === accountId) {
          const account = this.accountManager.getAccount(accountId);
          const usedByAccount = s.info.streamerName || rid;
          throw new Error(`账号「${account ? account.nickname : accountId}」已被直播间「${usedByAccount}」使用，每个账号只能同时用于一个直播间录制`);
        }
      }
    }

    state.info.accountId = accountId;
    updateStream(roomId, { accountId });
    logger.info(`[StreamManager] 设置直播间账号: ${roomId} -> ${accountId || '无账号'}`);
    this.notifyUpdate();
    return state.info;
  }

  /**
   * 设置直播间评论区帧率
   * @param {string} roomId - 直播间ID
   * @param {number} fps - 帧率 (5/10/15/20/25/30)
   */
  setRoomCommentFps(roomId, fps) {
    const state = this.streams.get(roomId);
    if (!state) return null;

    state.info.commentFps = fps;
    updateStream(roomId, { commentFps: fps });
    logger.info(`[StreamManager] 设置评论区帧率: ${roomId} -> ${fps}fps`);
    this.notifyUpdate();
    return state.info;
  }

  /**
   * 设置直播间录制模式
   * @param {string} roomId - 直播间ID
   * @param {string} mode - 录制模式: 'with-account' | 'stream-only' | 'stream+comment-no-login'
   */
  setRoomRecordMode(roomId, mode) {
    const state = this.streams.get(roomId);
    if (!state) return null;

    state.info.recordMode = mode;
    updateStream(roomId, { recordMode: mode });
    logger.info(`[StreamManager] 设置录制模式: ${roomId} -> ${mode}`);
    this.notifyUpdate();
    return state.info;
  }

  /**
   * 更新直播间信息（如主播名称）
   */
  updateStreamInfo(roomId, updates) {
    const state = this.streams.get(roomId);
    if (!state) {
      throw new Error(`直播间 ${roomId} 不存在`);
    }

    // 合并更新
    if (updates.streamerName) {
      state.info.streamerName = updates.streamerName;
    }
    if (updates.autoRecord !== undefined) {
      state.info.autoRecord = updates.autoRecord;
    }
    if (updates.recordMode !== undefined) {
      state.info.recordMode = updates.recordMode;
    }
    if (updates.commentFps !== undefined) {
      state.info.commentFps = updates.commentFps;
    }
    if (updates.accountId !== undefined) {
      state.info.accountId = updates.accountId;
    }

    // 持久化到配置
    updateStream(roomId, updates);

    logger.info(`[StreamManager] 更新直播间信息: ${roomId}`, updates);
    this.notifyUpdate();
    return state.info;
  }

  /**
   * 获取录制历史记录
   * @param {string} roomId 房间ID
   * @returns {object} 录制历史数据
   */
  getRecordingHistory(roomId) {
    const state = this.streams.get(roomId);
    if (!state) {
      return {
        roomId: roomId,
        streamerName: '未知主播',
        currentRecording: null,
        history: []
      };
    }

    // 获取当前录制信息（如果正在录制）
    let currentRecording = null;
    if (state.recorder && state.recorder.recording) {
      const startTime = state.recorder.startTime;
      const startTimeStr = startTime instanceof Date ? startTime.toISOString() : (startTime || new Date().toISOString());
      currentRecording = {
        startTime: startTimeStr,
        duration: startTime 
          ? Math.floor((Date.now() - new Date(startTime).getTime()) / 1000)
          : 0
      };
    }

    // 获取历史记录
    const history = state.info.recordingHistory || [];

    return {
      roomId: state.info.roomId,
      streamerName: state.info.streamerName || '未知主播',
      currentRecording: currentRecording,
      history: history
    };
  }

  /**
   * 获取所有直播间状态
   */
  getAllStatus() {
    const result = [];
    for (const [roomId, state] of this.streams) {
      result.push({
        roomId: state.info.roomId,
        streamerName: state.info.streamerName,
        liveUrl: state.info.liveUrl,
        status: state.status,
        isLive: state.isLive,
        lastCheck: state.lastCheck,
        autoRecord: state.info.autoRecord !== false, // 默认为 true
        recordMode: state.info.recordMode || 'stream+comment',
        commentFps: state.info.commentFps || 15,
        recorder: state.recorder ? state.recorder.getStatus() : null
      });
    }
    return result;
  }

  /**
   * 从持久化配置恢复直播间列表
   */
  async restoreStreams() {
    const savedStreams = getStreams();
    for (const streamInfo of savedStreams) {
      try {
        const streamState = {
          info: streamInfo,
          recorder: null,
          monitorWindow: null,
          status: 'checking',
          isLive: false,
          lastCheck: null
        };

        this.streams.set(streamInfo.roomId, streamState);
        // 非阻塞创建监控窗口
        this.createMonitorWindow(streamState).catch(e => {
          logger.warn(`[Restore] 创建监控窗口失败: ${e.message}`);
        });
        this.startMonitoring(streamState);
      } catch (e) {
        console.error(`[StreamManager] 恢复直播间失败 (${streamInfo.roomId}):`, e.message);
      }
    }
    this.notifyUpdate();
  }

  /**
   * 销毁所有资源
   */
  async destroyAll() {
    for (const [roomId, state] of this.streams) {
      // 停止监控定时器
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      // 强制销毁录制器（终止FFmpeg进程）
      if (state.recorder) {
        try { 
          await state.recorder.destroy(); 
        } catch (e) { /* ignore */ }
        state.recorder = null;
      }
      // 销毁监控窗口
      if (state.monitorWindow && !state.monitorWindow.isDestroyed()) {
        try { state.monitorWindow.destroy(); } catch (e) { /* ignore */ }
        state.monitorWindow = null;
      }
    }
    this.streams.clear();
  }
}

module.exports = { StreamManager };
