/**
 * 多账号管理模块
 * 支持登录多个抖音账号，每个账号使用独立的 Electron session partition
 */
const crypto = require('crypto');
const { getLogger } = require('./logger');
const { getAccounts: getConfigAccounts, setConfig } = require('./config');
const logger = getLogger();

// 账号列表（内存缓存，持久化由 config 管理）
let accounts = [];

// 初始化：从 config 加载账号列表
function init(savedAccounts) {
  accounts = savedAccounts || getConfigAccounts() || [];
  logger.info(`[AccountManager] 初始化，已加载 ${accounts.length} 个账号`);
}

// 持久化账号列表到 config
function _persistAccounts() {
  try {
    // 只保存可序列化的字段（排除 session 对象等）
    const serializable = accounts.map(a => ({
      id: a.id,
      nickname: a.nickname,
      avatar: a.avatar || '',
      createdAt: a.createdAt,
      partition: a.partition
    }));
    setConfig('accounts', serializable);
  } catch (err) {
    logger.warn(`[AccountManager] 持久化账号列表失败: ${err.message}`);
  }
}

// 获取所有账号
function getAccounts() {
  return accounts.map(a => ({
    id: a.id,
    nickname: a.nickname,
    avatar: a.avatar || '',
    createdAt: a.createdAt,
    partition: a.partition
  }));
}

// 获取指定账号信息
function getAccount(accountId) {
  return accounts.find(a => a.id === accountId);
}

// 获取账号的 session partition
function getPartition(accountId) {
  const account = accounts.find(a => a.id === accountId);
  return account ? account.partition : null;
}

// 登录新账号：创建独立 session 的 BrowserWindow
function loginAccount(mainWindow) {
  return new Promise((resolve, reject) => {
    const accountId = crypto.randomUUID();
    const partition = `persist:account-${accountId}`;

    logger.info(`[AccountManager] 开始登录新账号，partition: ${partition}`);

    const loginWin = new BrowserWindow({
      width: 900,
      height: 700,
      title: '登录抖音账号',
      parent: mainWindow,
      modal: false,
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    loginWin.loadURL('https://www.douyin.com');

    // 轮询检测登录状态
    const checkInterval = setInterval(async () => {
      try {
        if (loginWin.isDestroyed()) {
          clearInterval(checkInterval);
          reject(new Error('登录窗口已关闭'));
          return;
        }

        const ses = session.fromPartition(partition);
        const cookies = await ses.cookies.get({ domain: '.douyin.com' });
        
        // 检查是否有登录 cookie（sessionid 或 passport_csrf_token）
        const hasLoginCookie = cookies.some(c => 
          c.name === 'sessionid' || c.name === 'sessionid_ss'
        );

        if (hasLoginCookie) {
          clearInterval(checkInterval);
          logger.info(`[AccountManager] 检测到登录成功，获取用户信息...`);

          // 获取用户昵称
          const nickname = await _fetchNickname(loginWin);
          
          // 获取头像
          const avatar = await _fetchAvatar(loginWin);

          // 保存账号信息
          const accountInfo = {
            id: accountId,
            nickname: nickname || '抖音用户',
            avatar: avatar || '',
            createdAt: Date.now(),
            partition: partition
          };

          accounts.push(accountInfo);
          _persistAccounts();
          logger.info(`[AccountManager] 账号登录成功: ${accountInfo.nickname} (${accountId})`);

          // 延迟关闭登录窗口
          setTimeout(() => {
            if (!loginWin.isDestroyed()) loginWin.close();
          }, 1000);

          resolve(accountInfo);
        }
      } catch (err) {
        logger.warn(`[AccountManager] 检测登录状态出错: ${err.message}`);
      }
    }, 2000);

    // 窗口关闭事件
    loginWin.on('closed', () => {
      clearInterval(checkInterval);
      // 如果窗口被关闭但还没登录成功
      if (!accounts.find(a => a.id === accountId)) {
        logger.info(`[AccountManager] 登录窗口已关闭，未完成登录`);
        // 清理 session
        const ses = session.fromPartition(partition);
        ses.clearStorageData().catch(() => {});
        reject(new Error('登录已取消'));
      }
    });
  });
}

// 从页面获取用户昵称
async function _fetchNickname(win) {
  try {
    const nickname = await win.webContents.executeJavaScript(`
      (function() {
        // 尝试多种选择器获取昵称
        const selectors = [
          '[class*="user-name"]',
          '[class*="nickname"]',
          '[data-e2e="user-info"] [class*="name"]',
          '.j5WYzOQs', // 抖音个人主页昵称选择器
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) return el.textContent.trim();
        }
        return null;
      })()
    `);
    return nickname;
  } catch (err) {
    logger.warn(`[AccountManager] 获取昵称失败: ${err.message}`);
    return null;
  }
}

// 从页面获取用户头像
async function _fetchAvatar(win) {
  try {
    const avatar = await win.webContents.executeJavaScript(`
      (function() {
        const selectors = [
          '[class*="avatar"] img',
          '[class*="user-avatar"] img',
          '[data-e2e="user-info"] img',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.src) return el.src;
        }
        return null;
      })()
    `);
    return avatar;
  } catch (err) {
    logger.warn(`[AccountManager] 获取头像失败: ${err.message}`);
    return null;
  }
}

// 通过 API 获取账号昵称（更可靠）
async function fetchNicknameFromAPI(accountId) {
  const account = accounts.find(a => a.id === accountId);
  if (!account) return null;

  try {
    const ses = session.fromPartition(account.partition);
    const result = await ses.cookies.get({ domain: '.douyin.com' });
    
    // 使用 API 获取用户信息
    const response = await _fetchWithSession(ses, 'https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&web_rid=0');
    
    if (response && response.data && response.data.user) {
      return response.data.user.nickname || response.data.user.display_id;
    }
  } catch (err) {
    logger.warn(`[AccountManager] API获取昵称失败: ${err.message}`);
  }
  return null;
}

// 使用指定 session 发起 fetch 请求
async function _fetchWithSession(ses, url) {
  try {
    const result = await ses.executeJavaScript(`
      fetch('${url}', { credentials: 'include' })
        .then(r => r.json())
        .catch(() => null)
    `);
    return result;
  } catch (err) {
    return null;
  }
}

// 删除账号
async function removeAccount(accountId) {
  const idx = accounts.findIndex(a => a.id === accountId);
  if (idx === -1) return false;

  const account = accounts[idx];
  logger.info(`[AccountManager] 删除账号: ${account.nickname} (${accountId})`);

  // 清理 session 数据
  try {
    const ses = session.fromPartition(account.partition);
    await ses.clearStorageData();
  } catch (err) {
    logger.warn(`[AccountManager] 清理 session 数据失败: ${err.message}`);
  }

  accounts.splice(idx, 1);
  _persistAccounts();
  return true;
}

// 更新账号信息（昵称、头像等）
function updateAccount(accountId, updates) {
  const account = accounts.find(a => a.id === accountId);
  if (!account) return false;
  
  Object.assign(account, updates);
  _persistAccounts();
  return true;
}

// 获取账号的 cookies（用于传递给录制引擎）
async function getAccountCookies(accountId) {
  const account = accounts.find(a => a.id === accountId);
  if (!account) return null;

  try {
    const ses = session.fromPartition(account.partition);
    const cookies = await ses.cookies.get({ domain: '.douyin.com' });
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (err) {
    logger.warn(`[AccountManager] 获取 cookies 失败: ${err.message}`);
    return null;
  }
}

// 检查账号是否已被某个直播间使用
function isAccountInUse(accountId) {
  // 这个检查由 stream-manager 负责，这里只提供账号列表
  return false;
}

// 获取账号被哪些直播间使用（由外部传入 streams 数据）
function getAccountUsedByRooms(accountId, streams) {
  return streams
    .filter(s => s.accountId === accountId)
    .map(s => s.info ? s.info.streamerName : s.roomId);
}

module.exports = {
  init,
  getAccounts,
  getAccount,
  getPartition,
  loginAccount,
  removeAccount,
  updateAccount,
  getAccountCookies,
  getAccountUsedByRooms,
  fetchNicknameFromAPI
};
