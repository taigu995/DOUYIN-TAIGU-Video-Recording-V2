/**
 * 抖音直播录制工具V2 - 主进程
 * 基于 Electron 的桌面应用，支持多账号、多直播间录制
 */
const { app, BrowserWindow, Tray, Menu, dialog, session, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { getLogger } = require('./src/lib/logger');
const logger = getLogger();
const { config } = require('./src/lib/config');
const { StreamManager } = require('./src/lib/stream-manager');
const { AccountManager } = require('./src/lib/account-manager');

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
let accountManager = null;

// 初始化账号管理器
function initAccountManager() {
  accountManager = new AccountManager();
  logger.info('AccountManager initialized');
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
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
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  if (!fs.existsSync(iconPath)) {
    logger.warn(`图标文件不存在: ${iconPath}`);
    return;
  }

  tray = new Tray(iconPath);
  tray.setToolTip('抖音直播录制工具V2');

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
    return accountManager.getAllAccounts();
  });

  ipcMain.handle('login-account', async () => {
    try {
      const account = await accountManager.login();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('login-status-changed', {
          isLoggedIn: true,
          username: account.nickname,
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
      const streams = config.getStreams();
      const usedBy = streams.find(s => s.accountId === accountId);
      if (usedBy) {
        return { success: false, error: `账号正在被直播间「${usedBy.customName || usedBy.roomId}」使用，请先取消分配` };
      }
      
      await accountManager.logout(accountId);
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
    const isLoggedIn = await accountManager.isLoggedIn(accountId);
    const account = accountManager.getAccount(accountId);
    return {
      isLoggedIn,
      username: isLoggedIn && account ? account.nickname : '',
      accountId: accountId
    };
  });

  // 获取默认账号状态（向后兼容）
  ipcMain.handle('check-login-status', async () => {
    const accounts = accountManager.getAllAccounts();
    if (accounts.length > 0) {
      const defaultAccount = accounts[0];
      const isLoggedIn = await accountManager.isLoggedIn(defaultAccount.id);
      return {
        isLoggedIn,
        username: isLoggedIn ? defaultAccount.nickname : '',
        accountId: defaultAccount.id
      };
    }
    return { isLoggedIn: false, username: '', accountId: null };
  });

  ipcMain.handle('logout', async () => {
    const accounts = accountManager.getAllAccounts();
    if (accounts.length > 0) {
      await accountManager.logout(accounts[0].id);
    }
    return { success: true };
  });

  // ========== 直播间管理 ==========
  ipcMain.handle('get-streams', () => {
    return config.getStreams();
  });

  // 预览直播间信息（解析后返回，不添加）
  ipcMain.handle('preview-stream', async (event, input) => {
    try {
      const { extractRoomId, fetchStreamerName } = require('./src/lib/douyin-utils');
      const roomId = await extractRoomId(input);
      if (!roomId) {
        return { success: false, error: '无法解析直播间链接' };
      }
      const streamerName = await fetchStreamerName(roomId);
      return { success: true, roomId, streamerName };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('add-stream', async (event, { input, customName, accountId, commentFps, recordMode }) => {
    try {
      const stream = await streamManager.addStream(input, customName);
      // 设置直播间专属配置
      if (accountId) stream.accountId = accountId;
      if (commentFps) stream.commentFps = commentFps;
      if (recordMode) stream.recordMode = recordMode;
      config.updateStream(stream.roomId, stream);
      return { success: true, stream };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('remove-stream', (event, roomId) => {
    streamManager.removeStream(roomId);
    return { success: true };
  });

  ipcMain.handle('update-stream', (event, { roomId, updates }) => {
    // 如果更新 accountId，检查防呆
    if (updates.accountId) {
      const streams = config.getStreams();
      const conflict = streams.find(s => s.roomId !== roomId && s.accountId === updates.accountId);
      if (conflict) {
        const conflictName = conflict.customName || conflict.roomId;
        return { success: false, error: `该账号已被直播间「${conflictName}」使用` };
      }
    }
    streamManager.updateStream(roomId, updates);
    return { success: true };
  });

  ipcMain.handle('toggle-auto-record', (event, roomId) => {
    streamManager.toggleAutoRecord(roomId);
    return { success: true };
  });

  ipcMain.handle('start-recording', async (event, roomId) => {
    try {
      await streamManager.startRecording(roomId, true);
      return { success: true };
    } catch (error) {
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

  // ========== 配置管理 ==========
  ipcMain.handle('get-config', () => {
    return config.getAll();
  });

  ipcMain.handle('save-config', (event, newConfig) => {
    config.setAll(newConfig);
    streamManager.updateConfig(newConfig);
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
    const outputDir = config.outputDir;
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
  streamManager = new StreamManager(config.getAll(), (streams) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('streams-updated', streams);
    }
  });

  // 恢复已保存的直播间
  const savedStreams = config.getStreams();
  for (const stream of savedStreams) {
    await streamManager.addStream(stream.roomId, stream.customName);
    // 恢复直播间专属配置
    if (stream.accountId || stream.commentFps || stream.recordMode) {
      const updates = {};
      if (stream.accountId) updates.accountId = stream.accountId;
      if (stream.commentFps) updates.commentFps = stream.commentFps;
      if (stream.recordMode) updates.recordMode = stream.recordMode;
      streamManager.updateStream(stream.roomId, updates);
    }
  }

  setupCSP();
  createWindow();
  createTray();
  setupIPC();

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
  if (streamManager) {
    streamManager.destroy();
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
