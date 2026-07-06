/**
 * 抖音直播录制工具 - Electron 主进程
 * 负责窗口管理、IPC通信、系统托盘
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, session, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { StreamManager } = require('./src/lib/stream-manager');
const { getConfig, setConfig } = require('./src/lib/config');
const { getLogger } = require('./src/lib/logger');

// 初始化日志
const logger = getLogger();

// 全局错误处理
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

let mainWindow = null;
let tray = null;
let streamManager = null;

// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

/**
 * 创建主窗口
 */
function createMainWindow() {
  const iconPath = path.join(__dirname, 'build', 'icon.jpeg');
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 750,
    minHeight: 500,
    title: '抖音直播录制工具',
    icon: iconPath,
    resizable: true,
    autoHideMenuBar: true,
    skipTaskbar: false,  // 确保在任务栏显示
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 最小化时保持在任务栏显示
  mainWindow.on('minimize', () => {
    mainWindow.setSkipTaskbar(false);
  });

  // 关闭时最小化到托盘
  mainWindow.on('close', (e) => {
    const config = getConfig();
    if (config.minimizeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 创建系统托盘
 */
function createTray() {
  // 使用应用图标作为托盘图标
  const trayIconPath = path.join(__dirname, 'build', 'icon.jpeg');
  const icon = nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip('抖音直播录制工具');

  const contextMenu = Menu.buildFromTemplate([
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
      click: async () => {
        // 停止所有录制并等待清理完成
        if (streamManager) {
          await streamManager.destroyAll();
        }
        // 强制清理可能残留的 FFmpeg 进程
        try {
          const { execSync } = require('child_process');
          if (process.platform === 'win32') {
            execSync('taskkill /F /IM ffmpeg.exe /T 2>nul', { stdio: 'ignore' });
          }
        } catch (e) { /* 忽略 */ }
        tray.destroy();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/**
 * 注册 IPC 处理
 */
function setupIPC() {
  // 添加直播间
  ipcMain.handle('add-stream', async (event, inputText, customName) => {
    try {
      const result = await streamManager.addStreamByInput(inputText, customName);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 修改直播间信息
  ipcMain.handle('update-stream', async (event, roomId, updates) => {
    try {
      streamManager.updateStreamInfo(roomId, updates);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 删除直播间
  ipcMain.handle('remove-stream', async (event, roomId) => {
    try {
      await streamManager.removeStreamById(roomId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 切换自动录制开关
  ipcMain.handle('toggle-auto-record', async (event, roomId) => {
    try {
      const autoRecord = streamManager.toggleAutoRecord(roomId);
      return { success: true, autoRecord };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 获取录制记录
  ipcMain.handle('get-recording-history', async (event, roomId) => {
    try {
      const historyData = streamManager.getRecordingHistory(roomId);
      return { success: true, ...historyData };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 开始录制
  ipcMain.handle('start-recording', async (event, roomId) => {
    try {
      await streamManager.startRecording(roomId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 停止录制
  ipcMain.handle('stop-recording', async (event, roomId) => {
    try {
      const result = await streamManager.stopRecording(roomId);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 获取所有直播间状态
  ipcMain.handle('get-all-status', async () => {
    return streamManager.getAllStatus();
  });

  // 获取配置
  ipcMain.handle('get-config', async () => {
    return getConfig();
  });

  // 设置配置
  ipcMain.handle('set-config', async (event, key, value) => {
    setConfig(key, value);

    // 如果修改了开机自启动设置，同步应用到系统
    if (key === 'launchAtLogin') {
      app.setLoginItemSettings({
        openAtLogin: value === true,
        path: app.getPath('exe')
      });
    }

    return { success: true };
  });

  // 选择输出文件夹
  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择录制文件保存位置'
    });
    if (result.canceled) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  // 获取登录状态和用户信息
  ipcMain.handle('get-login-status', async () => {
    try {
      const douyinSession = session.fromPartition('persist:douyin');
      const cookies = await douyinSession.cookies.get({ domain: '.douyin.com' });
      
      // 检查是否有登录相关的cookie
      const hasLoginCookie = cookies.some(c => 
        c.name === 'sessionid' || c.name === 'sessionid_ss' || c.name === 'login_status' || c.name === 'passport_auth_status'
      );
      
      if (!hasLoginCookie) {
        return { loggedIn: false, name: '未登录', avatar: null };
      }

      let name = '';
      
      // 方法1: 使用抖音用户信息API获取真实用户名
      try {
        const cookieStr = cookies
          .filter(c => c.value && c.name)
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        
        const apiResult = await new Promise((resolve) => {
          const https = require('https');
          const url = 'https://www.douyin.com/passport/web/account/info/';
          const options = {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
              'Cookie': cookieStr,
              'Accept': 'application/json',
              'Referer': 'https://www.douyin.com/'
            }
          };
          
          https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                if (json && json.data) {
                  resolve({
                    name: json.data.nickname || json.data.screen_name || json.data.name || '',
                    avatar: json.data.avatar_url || ''
                  });
                } else {
                  resolve(null);
                }
              } catch (e) {
                resolve(null);
              }
            });
          }).on('error', () => resolve(null));
          
          // 超时5秒
          setTimeout(() => resolve(null), 5000);
        });
        
        if (apiResult && apiResult.name) {
          name = apiResult.name;
          logger.info(`登录状态: 从API获取用户名成功: ${name}`);
        }
      } catch (e) {
        logger.warn(`API获取用户名失败: ${e.message}`);
      }

      // 方法2: 如果API失败，尝试从cookie中获取
      if (!name) {
        const nameCookies = [
          'passport_fe_name',
          'login_name', 
          'uid_tt_name',
          'passport_uid_name',
        ];
        
        for (const cookieName of nameCookies) {
          const cookie = cookies.find(c => c.name === cookieName && c.value);
          if (cookie) {
            try {
              const decoded = decodeURIComponent(cookie.value);
              if (decoded.startsWith('{') || decoded.startsWith('[')) {
                const parsed = JSON.parse(decoded);
                name = parsed.name || parsed.nickname || parsed.screen_name || '';
                if (name) break;
              } else if (decoded && decoded !== 'null' && decoded !== 'undefined' && decoded.length < 50 && !/^[0-9]+$/.test(decoded)) {
                name = decoded;
                break;
              }
            } catch (e) { /* ignore */ }
          }
        }
      }

      // 方法3: 如果还是没获取到，创建临时窗口从DOM获取
      if (!name) {
        try {
          const tempWindow = new BrowserWindow({
            show: false,
            width: 800,
            height: 600,
            webPreferences: {
              partition: 'persist:douyin',
              contextIsolation: true,
              nodeIntegration: false,
              additionalArguments: ['--mute-audio'],
              audioPlaybackPolicy: 'never'
            }
          });
          
          await tempWindow.loadURL('https://www.douyin.com');
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          if (!tempWindow.isDestroyed()) {
            const userInfo = await tempWindow.webContents.executeJavaScript(`
              (function() {
                // 尝试从头像旁边的用户名获取
                const selectors = [
                  '[data-e2e="user-info"] [class*="name"]',
                  '[data-e2e="user-info"] span',
                  '.avatar-wrapper [class*="name"]',
                  'header [class*="user-name"]',
                  'header [class*="UserName"]',
                  '[class*="nickname"]',
                  '[class*="NickName"]',
                  '[class*="user-name"]',
                  '[class*="username"]',
                  'a[href*="/user/"] [class*="name"]'
                ];
                
                for (const sel of selectors) {
                  const el = document.querySelector(sel);
                  if (el && el.textContent && el.textContent.trim()) {
                    const text = el.textContent.trim();
                    if (text && text !== '登录' && text !== '注册' && text.length < 30 && text.length > 0) {
                      return text;
                    }
                  }
                }
                
                // 从页面标题获取
                const title = document.title;
                if (title && title.includes('@')) {
                  const match = title.match(/@([^\\s]+)/);
                  if (match) return match[1];
                }
                
                return '';
              })()
            `);
            
            if (userInfo) {
              name = userInfo;
            }
            tempWindow.close();
          }
        } catch (e) {
          logger.warn(`从页面获取用户名失败: ${e.message}`);
        }
      }

      // 如果还是没获取到，使用默认名称
      if (!name) {
        name = '抖音用户';
      }

      logger.info(`登录状态: 已登录, 用户名: ${name}`);
      return { loggedIn: true, name, avatar: null };
    } catch (e) {
      logger.error(`获取登录状态失败: ${e.message}`);
      return { loggedIn: false, name: '未登录', avatar: null };
    }
  });

  // 打开登录窗口（用于首次登录抖音）
  ipcMain.handle('open-login', async () => {
    const loginWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      title: '登录抖音',
      icon: path.join(__dirname, 'build', 'icon.jpeg'),
      parent: mainWindow,
      modal: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:douyin',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      }
    });

    loginWindow.loadURL('https://www.douyin.com', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    });

    // 监听登录窗口关闭，通知主界面刷新登录状态
    loginWindow.on('closed', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('login-status-changed');
      }
    });

    return { success: true };
  });

  // 清除登录数据
  ipcMain.handle('clear-login', async () => {
    try {
      const { session } = require('electron');
      const ses = session.fromPartition('persist:douyin');
      
      // 清除所有 cookies
      await ses.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage', 'indexeddb', 'websql', 'cachestorage']
      });
      
      logger.info('已清除登录数据');
      return { success: true, message: '登录数据已清除，请重新登录' };
    } catch (e) {
      logger.error('清除登录数据失败:', e);
      return { success: false, error: e.message };
    }
  });

  // 在浏览器中打开直播间（用于调试）
  ipcMain.handle('open-in-browser', async (event, url) => {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
  });

  // 获取输出文件夹路径
  ipcMain.handle('get-default-folder', async () => {
    const { app } = require('electron');
    return path.join(app.getPath('videos'), '抖音直播录制');
  });

  // 获取日志文件路径
  ipcMain.handle('get-log-path', async () => {
    return logger.getLogPath();
  });

  // 获取最近的日志内容
  ipcMain.handle('get-recent-logs', async () => {
    return logger.getRecentLogs(200);
  });

  // 获取日志文件内容（兼容旧接口）
  ipcMain.handle('get-log-content', async () => {
    const content = logger.getRecentLogs(500);
    return { path: logger.getLogPath(), content };
  });

  // 导出日志到指定位置
  ipcMain.handle('export-logs', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出日志文件',
      defaultPath: `douyin-recorder-logs-${new Date().toISOString().slice(0, 10)}.log`,
      filters: [
        { name: '日志文件', extensions: ['log', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    
    try {
      const logPath = logger.getLogPath();
      if (fs.existsSync(logPath)) {
        fs.copyFileSync(logPath, result.filePath);
        return { success: true, path: result.filePath };
      } else {
        return { success: false, error: '日志文件不存在' };
      }
    } catch (err) {
      logger.error('导出日志失败:', err);
      return { success: false, error: err.message };
    }
  });

  // 打开日志文件所在目录
  ipcMain.handle('open-log-folder', async () => {
    const logDir = logger.getLogDir();
    await shell.openPath(logDir);
    return { success: true };
  });

  // 打开日志文件（用系统默认编辑器）
  ipcMain.handle('open-log-file', async () => {
    const logPath = logger.getLogPath();
    await shell.openPath(logPath);
    return { success: true };
  });

  // 清空日志
  ipcMain.handle('clear-logs', async () => {
    const success = logger.clear();
    return { success };
  });
}

/**
 * 应用启动
 */
app.whenReady().then(async () => {
  // 配置 session
  const douyinSession = session.fromPartition('persist:douyin');
  douyinSession.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

  // 初始化流管理器
  streamManager = new StreamManager();
  streamManager.setUpdateCallback((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('streams-updated', status);
    }
  });

  // 创建窗口
  createMainWindow();
  createTray();
  setupIPC();

  // 应用开机自启动设置
  const config = getConfig();
  app.setLoginItemSettings({
    openAtLogin: config.launchAtLogin === true,
    path: app.getPath('exe')
  });

  // 恢复已保存的直播间
  await streamManager.restoreStreams();
});

// macOS 点击 dock 图标时重新显示窗口
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

// 其他实例尝试启动时，聚焦当前窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// 退出前清理
app.on('before-quit', async (event) => {
  // 阻止默认退出行为，等待清理完成
  event.preventDefault();
  
  if (streamManager) {
    await streamManager.destroyAll();
  }
  // 强制清理可能残留的 FFmpeg 进程
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM ffmpeg.exe /T 2>nul', { stdio: 'ignore' });
    }
  } catch (e) { /* 忽略 */ }
  
  // 等待一小段时间确保所有进程已终止
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // 强制退出
  app.exit(0);
});

app.on('window-all-closed', () => {
  // Windows 下不退出，保持托盘运行
  if (process.platform !== 'darwin' && !tray) {
    app.quit();
  }
});
