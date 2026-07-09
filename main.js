/**
 * 抖音直播录制工具V2 - 主进程
 * 基于 Electron 的桌面应用，支持多账号、多直播间录制
 */
const { app, BrowserWindow, Tray, Menu, dialog, session, shell, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { getLogger } = require('./src/lib/logger');
const logger = getLogger();
const { getConfig, setConfig, getAll, setAll, getStreams, addStream: configAddStream, removeStream: configRemoveStream, updateStream: configUpdateStream, getAccounts: configGetAccounts, addAccount, removeAccount: configRemoveAccount, updateAccount: configUpdateAccount } = require('./src/lib/config');
const { StreamManager } = require('./src/lib/stream-manager');
const accountManager = require('./src/lib/account-manager');

// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// 设置用户数据路径
const userDataPath = path.join(app.getPath('appData'), 'douyin-live-recorder');
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}
app.setPath('userData', userDataPath);

// 设置日志目录
logger.setLogDir(path.join(userDataPath, 'logs'));

// 全局变量
let mainWindow = null;
let tray = null;
let streamManager = null;
// accountManager 已通过 require 导入

// 初始化退出标志
app.isQuitting = false;

// 初始化账号管理器
function initAccountManager() {
  const savedAccounts = configGetAccounts();
  accountManager.init(savedAccounts);
  logger.info(`AccountManager initialized with ${savedAccounts.length} accounts`);
}

// 创建主窗口
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: '抖音直播录制工具V2',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  let windowShown = false;
  mainWindow.once('ready-to-show', () => {
    windowShown = true;
    mainWindow.show();
  });

  // 安全超时：如果 ready-to-show 5秒内未触发，强制显示窗口
  setTimeout(() => {
    if (!windowShown && mainWindow && !mainWindow.isDestroyed()) {
      logger.warn('ready-to-show 超时，强制显示窗口');
      mainWindow.show();
    }
  }, 5000);

  mainWindow.on('close', (event) => {
    const cfg = getConfig();
    const minimizeToTray = cfg.minimizeToTray;
    if (!app.isQuitting && minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      logger.info('窗口已隐藏到系统托盘');
    }
  });

  // 设置窗口级 Cookie（用于抖音 API 请求）
  setupWindowCookies();
}

// 设置窗口级 Cookie
async function setupWindowCookies() {
  try {
    const cookies = [
      { url: 'https://live.douyin.com', name: '__ac_nonce', value: 'dummy_nonce_0' },
      { url: 'https://live.douyin.com', name: '__ac_signature', value: 'dummy_signature_0' },
      { url: 'https://live.douyin.com', name: 'ttwid', value: 'dummy_ttwid_0' },
      { url: 'https://www.douyin.com', name: '__ac_nonce', value: 'dummy_nonce_0' },
      { url: 'https://www.douyin.com', name: 'ttwid', value: 'dummy_ttwid_0' }
    ];
    
    for (const cookie of cookies) {
      await mainWindow.webContents.session.cookies.set(cookie);
    }
    logger.info('窗口级 Cookie 已设置');
  } catch (error) {
    logger.warn(`设置窗口级 Cookie 失败: ${error.message}`);
  }
}

// 创建系统托盘
function createTray() {
  // 优先使用 16x16 小图标用于托盘（Windows 推荐尺寸）
  let iconPath = path.join(__dirname, 'assets', 'tray-icon-16.png');
  if (!fs.existsSync(iconPath)) {
    // 回退到 32x32 图标
    iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  }
  if (!fs.existsSync(iconPath)) {
    // 回退到原始图标
    iconPath = path.join(__dirname, 'assets', 'icon.png');
  }
  if (!fs.existsSync(iconPath)) {
    logger.warn(`图标文件不存在: ${iconPath}，无法创建系统托盘`);
    return;
  }

  try {
    // 使用 nativeImage 创建图标，从文件读取 buffer 更可靠
    const imageBuffer = fs.readFileSync(iconPath);
    const icon = nativeImage.createFromBuffer(imageBuffer);
    if (icon.isEmpty()) {
      logger.error(`图标文件为空或格式无效: ${iconPath}`);
      return;
    }
    tray = new Tray(icon);
    tray.setToolTip('抖音直播录制工具V2');
    logger.info(`系统托盘已创建，图标: ${iconPath}，尺寸: ${icon.getSize().width}x${icon.getSize().height}`);
  } catch (err) {
    logger.error(`创建系统托盘失败: ${err.message}`);
    logger.error(err.stack);
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '抖音直播录制工具V2',
      enabled: false
    },
    { type: 'separator' },
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

// 设置 CSP
function setupCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = "default-src 'self' 'unsafe-inline' 'unsafe-eval' https://* data: blob:; " +
                "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://* https://lf-cdn-tos.bytescm.com https://lf-cdn-tos.bytescm.com; " +
                "style-src 'self' 'unsafe-inline' https://*; " +
                "img-src 'self' data: blob: https://* http://*; " +
                "media-src 'self' data: blob: https://* http://*; " +
                "connect-src 'self' https://* wss://* ws://* http://*; " +
                "font-src 'self' data: https://*; " +
                "frame-src 'self' https://* http://*;";

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    });
  });
}

// 设置 IPC 处理器
function setupIPC() {
  // ========== 账号管理 ==========
  ipcMain.handle('get-accounts', () => {
    return accountManager.getAccounts();
  });

  ipcMain.handle('login-account', async () => {
    try {
      const account = await accountManager.loginAccount(mainWindow);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('login-status-changed', {
          isLoggedIn: true,
          username: account.nickname,
          avatar: account.avatar,
          accountId: account.id
        });
      }
      return { success: true, account };
    } catch (error) {
      logger.error(`登录失败: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('logout-account', async (event, accountId) => {
    try {
      // 检查账号是否被某个直播间使用
      const streams = getStreams();
      const usedBy = streams.find(s => s.accountId === accountId);
      if (usedBy) {
        return { success: false, error: `账号正在被直播间「${usedBy.customName || usedBy.roomId}」使用，请先取消分配` };
      }
      
      await accountManager.removeAccount(accountId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('login-status-changed', {
          isLoggedIn: false,
          username: '',
          accountId: null
        });
      }
      return { success: true };
    } catch (error) {
      logger.error(`登出失败: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('check-account-status', async (event, accountId) => {
    const account = accountManager.getAccount(accountId);
    const isLoggedIn = account && account.cookies && account.cookies.length > 0;
    return {
      isLoggedIn,
      username: isLoggedIn ? account.nickname : '',
      accountId: accountId
    };
  });

  // 获取默认账号状态（向后兼容）
  ipcMain.handle('check-login-status', async () => {
    const accounts = accountManager.getAccounts();
    if (accounts.length > 0) {
      const defaultAccount = accounts[0];
      const isLoggedIn = !!defaultAccount.partition;
      return {
        isLoggedIn,
        username: isLoggedIn ? defaultAccount.nickname : '',
        avatar: isLoggedIn ? defaultAccount.avatar : '',
        accountId: defaultAccount.id
      };
    }
    return { isLoggedIn: false, username: '', accountId: null };
  });

  ipcMain.handle('logout', async () => {
    const accounts = accountManager.getAccounts();
    if (accounts.length > 0) {
      await accountManager.removeAccount(accounts[0].id);
    }
    return { success: true };
  });

  // ========== 直播间管理 ==========
  ipcMain.handle('get-streams', () => {
    return getStreams();
  });

  // 预览直播间信息（解析后返回，不添加）
  ipcMain.handle('preview-stream', async (event, { input, customName }) => {
    try {
      const { extractInput, extractNameFromText, resolveShortUrl, buildLiveUrl } = require('./src/lib/douyin-utils');
      
      // 1. 解析输入
      const parsed = extractInput(input);
      if (!parsed) {
        return { success: false, error: '未能识别有效的抖音直播间信息' };
      }

      // 2. 获取 roomId
      let roomId;
      if (parsed.type === 'roomId') {
        roomId = parsed.value;
      } else {
        const url = parsed.value;
        if (url.includes('v.douyin.com')) {
          const resolved = await resolveShortUrl(url);
          roomId = resolved.roomId;
        } else if (url.includes('live.douyin.com')) {
          const match = url.match(/live\.douyin\.com\/([A-Za-z0-9_]+)/);
          roomId = match ? match[1] : null;
        }
      }

      if (!roomId) {
        return { success: false, error: '无法解析直播间ID' };
      }

      // 3. 获取主播名称
      let streamerName = customName || extractNameFromText(input);
      if (!streamerName) {
        // 通过 API 获取主播名称
        try {
          streamerName = await streamManager.fetchStreamerNameFromAPI(roomId);
        } catch (e) {
          streamerName = `主播${roomId}`;
        }
      }

      return { success: true, data: { roomId, streamerName: streamerName || `主播${roomId}` } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('add-stream', async (event, { input, customName, accountId, commentFps, recordMode, streamerName }) => {
    try {
      logger.info(`[IPC] add-stream: input="${(input || '').substring(0, 50)}", streamerName="${streamerName || ''}", mode="${recordMode || ''}"`);
      if (!input) {
        return { success: false, error: '输入为空，无法解析直播间信息' };
      }
      const stream = await streamManager.addStreamByInput(input, customName, streamerName, recordMode);
      // 设置直播间专属配置
      if (accountId) stream.accountId = accountId;
      if (commentFps) stream.commentFps = commentFps;
      // recordMode 已经在 addStreamByInput 中设置，这里不再需要
      configUpdateStream(stream.roomId, stream);
      // 同步更新内存中的状态
      const state = streamManager.streams.get(stream.roomId);
      if (state) {
        state.info = { ...state.info, ...stream };
      }
      return { success: true, stream };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('remove-stream', (event, roomId) => {
    streamManager.removeStreamById(roomId);
    return { success: true };
  });

  ipcMain.handle('update-stream', (event, { roomId, updates }) => {
    // 如果更新 accountId，检查防呆
    if (updates.accountId) {
      const streams = getStreams();
      const conflict = streams.find(s => s.roomId !== roomId && s.accountId === updates.accountId);
      if (conflict) {
        const conflictName = conflict.customName || conflict.roomId;
        return { success: false, error: `该账号已被直播间「${conflictName}」使用` };
      }
    }
    streamManager.updateStreamInfo(roomId, updates);
    return { success: true };
  });

  ipcMain.handle('toggle-auto-record', (event, roomId) => {
    streamManager.toggleAutoRecord(roomId);
    return { success: true };
  });

  ipcMain.handle('start-recording', async (event, roomId) => {
    logger.info(`[IPC] start-recording: roomId=${roomId}`);
    try {
      // 不传 force=true，避免强制重置已有录制
      await streamManager.startRecording(roomId, false);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] start-recording 异常: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('stop-recording', async (event, roomId) => {
    try {
      await streamManager.stopRecording(roomId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 手动合并直播流和评论区视频
  ipcMain.handle('manual-merge', async (event, roomId) => {
    try {
      const result = await streamManager.manualMerge(roomId);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 选择文件对话框
  ipcMain.handle('select-file', async (event, { filters }) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: filters || [{ name: '视频文件', extensions: ['mp4', 'mkv', 'avi'] }]
    });
    if (result.canceled) {
      return { canceled: true };
    }
    return { canceled: false, filePaths: result.filePaths };
  });

  // 选择目录对话框
  ipcMain.handle('select-directory', async (event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: options.title || '选择目录'
    });
    if (result.canceled) {
      return { canceled: true };
    }
    return { canceled: false, filePaths: result.filePaths };
  });

  // 保存文件对话框
  ipcMain.handle('save-file', async (event, options = {}) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || '保存文件',
      defaultPath: options.defaultPath || 'output.mp4',
      filters: options.filters || [{ name: '视频文件', extensions: ['mp4'] }]
    });
    if (result.canceled) {
      return { canceled: true };
    }
    return { canceled: false, filePath: result.filePath };
  });

  // ========== 配置管理 ==========
  ipcMain.handle('get-config', () => {
    return getAll();
  });

  ipcMain.handle('save-config', (event, newConfig) => {
    setAll(newConfig);
    return { success: true };
  });

  // ========== 文件/目录操作 ==========
  ipcMain.handle('select-output-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    if (result.canceled) {
      return { success: false };
    }
    return { success: true, path: result.filePaths[0] };
  });

  ipcMain.handle('open-output-dir', async () => {
    const outputDir = getConfig().outputFolder;
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    await shell.openPath(outputDir);
    return { success: true };
  });

  ipcMain.handle('open-log-folder', async () => {
    const logDir = logger.getLogDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    await shell.openPath(logDir);
    return { success: true };
  });

  ipcMain.handle('open-in-browser', async (event, url) => {
    await shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle('get-version', () => {
    return app.getVersion();
  });

  // ========== 新增 IPC 处理器 ==========

  // 获取所有直播间状态
  ipcMain.handle('get-all-status', () => {
    return streamManager.getAllStatus();
  });

  // 获取录制历史
  ipcMain.handle('get-recording-history', (event, roomId) => {
    return streamManager.getRecordingHistory(roomId);
  });

  // 设置单个配置项
  ipcMain.handle('set-config', (event, { key, value }) => {
    setConfig(key, value);
    return { success: true };
  });

  // 获取默认保存路径
  ipcMain.handle('get-default-folder', () => {
    return path.join(app.getPath('videos'), '抖音直播录制工具V2');
  });

  // 获取日志内容
  ipcMain.handle('get-log-content', () => {
    return logger.getRecentLogs(500);
  });

  // 获取日志文件路径
  ipcMain.handle('get-log-path', () => {
    return { path: logger.getLogPath() };
  });

  // 导出日志
  ipcMain.handle('export-logs', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出日志',
      defaultPath: `douyin-recorder-logs-${Date.now()}.log`,
      filters: [{ name: 'Log Files', extensions: ['log'] }]
    });
    if (result.canceled) return { success: false };
    
    const content = logger.getRecentLogs(10000);
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { success: true, path: result.filePath };
  });

  // 清空日志
  ipcMain.handle('clear-logs', () => {
    logger.clear();
    return { success: true };
  });

  // ========== 手动合并工具 ==========
  const ManualMerger = require('./src/lib/manual-merger');
  const manualMerger = new ManualMerger();

  // 选择视频文件
  ipcMain.handle('manual-merge-select-video', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择直播流视频文件',
      properties: ['openFile'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'mkv', 'avi', 'flv', 'ts'] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false };
    }
    return { success: true, path: result.filePaths[0] };
  });

  // 选择评论区帧目录
  ipcMain.handle('manual-merge-select-frames', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择评论区帧目录',
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false };
    }
    return { success: true, path: result.filePaths[0] };
  });

  // 选择输出文件
  ipcMain.handle('manual-merge-select-output', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '选择输出文件位置',
      defaultPath: `merged_${Date.now()}.mp4`,
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    });
    if (result.canceled || !result.filePath) {
      return { success: false };
    }
    return { success: true, path: result.filePath };
  });

  // 分析视频文件
  ipcMain.handle('manual-merge-analyze-video', (event, filePath) => {
    try {
      const info = manualMerger.probeVideoInfo(filePath);
      return { success: true, data: info };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 分析评论区帧目录
  ipcMain.handle('manual-merge-analyze-frames', (event, framesDir) => {
    try {
      const info = manualMerger.analyzeCommentFrames(framesDir);
      return { success: true, data: info };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 开始合并
  ipcMain.handle('manual-merge-start', async (event, { videoFile, commentFramesDir, outputFile }) => {
    try {
      const result = await manualMerger.merge({
        videoFile,
        commentFramesDir,
        outputFile,
        onProgress: (progress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('manual-merge-progress', progress);
          }
        },
        onStatusChange: (status, message) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('manual-merge-status', { status, message });
          }
        }
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 取消合并
  ipcMain.handle('manual-merge-cancel', () => {
    manualMerger.cancel();
    return { success: true };
  });

  // 获取合并状态
  ipcMain.handle('manual-merge-status', () => {
    return { isMerging: manualMerger.isMerging };
  });

  // 开始手动合并（简化版，供独立手动合并工具使用）
  ipcMain.handle('start-manual-merge', async (event, options) => {
    const { streamPath, framesDir, outputPath, commentFps } = options;
    
    // 验证文件存在
    const fs = require('fs');
    if (!fs.existsSync(streamPath)) {
      return { success: false, error: '直播流视频文件不存在' };
    }
    if (!fs.existsSync(framesDir)) {
      return { success: false, error: '评论区帧目录不存在' };
    }

    // 生成输出路径
    const finalOutputPath = outputPath || streamPath.replace(/\.mp4$/i, '_merged.mp4');

    try {
      const result = await manualMerger.merge({
        videoFile: streamPath,
        commentFramesDir: framesDir,
        outputFile: finalOutputPath
      });

      if (result.success) {
        const stats = fs.statSync(finalOutputPath);
        return { 
          success: true, 
          outputFile: finalOutputPath,
          fileSize: stats.size
        };
      } else {
        return { success: false, error: result.error || '合并失败' };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// 应用就绪
app.whenReady().then(async () => {
  logger.info('App starting...');
  logger.info(`App version: ${app.getVersion()}`);
  logger.info(`Electron: ${process.versions.electron}`);
  logger.info(`Node: ${process.versions.node}`);
  logger.info(`OS: ${process.platform} ${process.arch}`);

  // 检查 FFmpeg
  try {
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    logger.info(`FFmpeg 路径: ${ffmpegPath}`);
  } catch (error) {
    logger.error(`FFmpeg 未找到: ${error.message}`);
  }

  // 初始化账号管理器
  initAccountManager();

  // 初始化 StreamManager
  streamManager = new StreamManager(getAll(), accountManager, (statusList) => {
    // 状态变化时推送最新列表到前端
    if (mainWindow && !mainWindow.isDestroyed()) {
      logger.debug(`[Main] 推送状态更新到 UI: ${statusList.length} 个直播间`);
      mainWindow.webContents.send('streams-update', statusList);
    } else {
      logger.warn(`[Main] 无法推送状态更新: mainWindow=${!!mainWindow}, isDestroyed=${mainWindow?.isDestroyed()}`);
    }
  });

  // 先创建主窗口和 IPC，让用户立即看到界面
  setupCSP();
  createWindow();
  createTray();
  setupIPC();

  // 后台恢复已保存的直播间（不阻塞主窗口）
  streamManager.restoreStreams().catch(err => {
    logger.error(`恢复直播间失败: ${err.message}`);
  });

  // 检查并恢复未完成的合并任务（崩溃恢复）
  setTimeout(() => {
    streamManager.checkAndResumeMerges().catch(err => {
      logger.error(`检查合并恢复失败: ${err.message}`);
    });
  }, 3000); // 延迟3秒，确保直播间恢复完成

  logger.info('App ready');
});

// 处理第二个实例
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// 所有窗口关闭时
app.on('window-all-closed', () => {
  // 不退出应用，保持托盘运行
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// 退出前清理
app.on('before-quit', () => {
  app.isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (streamManager) {
    streamManager.destroyAll();
  }
});

// 未捕获的异常
process.on('uncaughtException', (error) => {
  logger.error(`未捕获的异常: ${error.message}`);
  logger.error(error.stack);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`未处理的 Promise 拒绝: ${reason}`);
});
