/**
 * 配置管理模块
 * 使用 electron-store 持久化用户设置
 */
const Store = require('electron-store');

const defaults = {
  outputFolder: '',       // 录制文件保存路径（空则使用默认）
  checkInterval: 30,      // 直播状态检测间隔（秒）
  videoQuality: 'origin', // 画质：origin=原画
  fileFormat: 'mp4',      // 输出格式
  autoStart: true,        // 检测到开播自动开始录制
  launchAtLogin: false,   // 开机自启动
  minimizeToTray: true,   // 关闭时最小化到托盘
  // 评论区拼接设置（全局默认值，可被每直播间设置覆盖）
  commentWidth: 360,      // 评论区宽度（像素）
  commentHeight: 720,     // 评论区高度（像素，与主视频对齐）
  commentFps: 15,         // 评论区帧率（全局默认）
  commentJpegQuality: 92, // 评论区帧 JPEG 压缩质量
  // 合并设置
  mergeCrf: 15,           // 合并视频 CRF（越低质量越高）
  mergePreset: 'medium',  // 合并视频编码预设
  // 账号列表
  accounts: [],           // [{ id, nickname, cookies: [{name, value, domain, path, ...}] }]
  streams: []             // 已添加的直播间列表
};

/**
 * 直播间数据结构:
 * {
 *   roomId: string,           // 房间ID
 *   streamerName: string,     // 主播名称
 *   customName: string,       // 自定义名称
 *   autoRecord: boolean,      // 自动录制
 *   accountId: string|null,   // 绑定的录制账号ID（null=无账号）
 *   commentFps: number|null,  // 评论区帧率（null=使用全局默认）
 *   recordMode: string        // 录制模式：'with-account' | 'no-account-stream-only' | 'no-account-stream+comment'
 * }
 */

let store;

function initStore() {
  if (!store) {
    store = new Store({ defaults, name: 'config' });
  }
  return store;
}

function getConfig() {
  const s = initStore();
  return {
    outputFolder: s.get('outputFolder'),
    checkInterval: s.get('checkInterval'),
    videoQuality: s.get('videoQuality'),
    fileFormat: s.get('fileFormat'),
    autoStart: s.get('autoStart'),
    launchAtLogin: s.get('launchAtLogin'),
    minimizeToTray: s.get('minimizeToTray'),
    commentFps: s.get('commentFps'),
    commentJpegQuality: s.get('commentJpegQuality'),
    mergeCrf: s.get('mergeCrf'),
    mergePreset: s.get('mergePreset'),
    accounts: s.get('accounts') || [],
    streams: s.get('streams') || []
  };
}

function setConfig(key, value) {
  const s = initStore();
  s.set(key, value);
}

// ============ 直播间管理 ============

function getStreams() {
  const s = initStore();
  return s.get('streams') || [];
}

function addStream(stream) {
  const s = initStore();
  const streams = s.get('streams') || [];
  // 确保新直播间有默认设置
  const streamWithDefaults = {
    autoRecord: true,
    accountId: null,
    commentFps: null,
    recordMode: 'with-account',
    ...stream
  };
  streams.push(streamWithDefaults);
  s.set('streams', streams);
}

function removeStream(roomId) {
  const s = initStore();
  const streams = (s.get('streams') || []).filter(item => item.roomId !== roomId);
  s.set('streams', streams);
}

function updateStream(roomId, updates) {
  const s = initStore();
  const streams = s.get('streams') || [];
  const idx = streams.findIndex(item => item.roomId === roomId);
  if (idx !== -1) {
    streams[idx] = { ...streams[idx], ...updates };
    s.set('streams', streams);
  }
}

// ============ 账号管理 ============

function getAccounts() {
  const s = initStore();
  return s.get('accounts') || [];
}

function addAccount(account) {
  const s = initStore();
  const accounts = s.get('accounts') || [];
  accounts.push(account);
  s.set('accounts', accounts);
}

function removeAccount(accountId) {
  const s = initStore();
  const accounts = (s.get('accounts') || []).filter(a => a.id !== accountId);
  s.set('accounts', accounts);
  // 同时清除所有引用该账号的直播间的 accountId
  const streams = s.get('streams') || [];
  let streamsChanged = false;
  for (let i = 0; i < streams.length; i++) {
    if (streams[i].accountId === accountId) {
      streams[i].accountId = null;
      streamsChanged = true;
    }
  }
  if (streamsChanged) {
    s.set('streams', streams);
  }
}

function updateAccount(accountId, updates) {
  const s = initStore();
  const accounts = s.get('accounts') || [];
  const idx = accounts.findIndex(a => a.id === accountId);
  if (idx !== -1) {
    accounts[idx] = { ...accounts[idx], ...updates };
    s.set('accounts', accounts);
  }
}

function getAccountById(accountId) {
  const accounts = getAccounts();
  return accounts.find(a => a.id === accountId) || null;
}

/**
 * 检查账号是否已被某个直播间使用
 * @returns {string|null} 正在使用该账号的 roomId，或 null
 */
function getAccountUsage(accountId) {
  const streams = getStreams();
  const stream = streams.find(s => s.accountId === accountId);
  return stream ? stream.roomId : null;
}

/**
 * 获取全部配置（同 getConfig）
 */
function getAll() {
  return getConfig();
}

/**
 * 批量更新配置
 */
function setAll(newConfig) {
  const s = initStore();
  for (const key of Object.keys(newConfig)) {
    if (key !== 'streams' && key !== 'accounts') {
      s.set(key, newConfig[key]);
    }
  }
}

module.exports = {
  getConfig,
  setConfig,
  getAll,
  setAll,
  getStreams,
  addStream,
  removeStream,
  updateStream,
  getAccounts,
  addAccount,
  removeAccount,
  updateAccount,
  getAccountById,
  getAccountUsage,
  initStore
};
