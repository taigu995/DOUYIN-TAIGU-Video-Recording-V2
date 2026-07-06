/**
 * 配置管理模块
 * 使用 electron-store 持久化用户设置
 */
const Store = require('electron-store');

const defaults = {
  outputFolder: '',       // 录制文件保存路径（空则使用默认）
  checkInterval: 30,      // 直播状态检测间隔（秒）
  videoQuality: 'origin', // 画质：origin=原画
  fps: 30,                // 录制帧率
  fileFormat: 'mp4',      // 输出格式
  autoStart: true,        // 检测到开播自动开始录制
  launchAtLogin: false,   // 开机自启动
  minimizeToTray: true,   // 关闭时最小化到托盘
  streams: []             // 已添加的直播间列表
};

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
    fps: s.get('fps'),
    fileFormat: s.get('fileFormat'),
    autoStart: s.get('autoStart'),
    launchAtLogin: s.get('launchAtLogin'),
    minimizeToTray: s.get('minimizeToTray'),
    streams: s.get('streams')
  };
}

function setConfig(key, value) {
  const s = initStore();
  s.set(key, value);
}

function getStreams() {
  const s = initStore();
  return s.get('streams') || [];
}

function addStream(stream) {
  const s = initStore();
  const streams = s.get('streams') || [];
  streams.push(stream);
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

module.exports = {
  getConfig,
  setConfig,
  getStreams,
  addStream,
  removeStream,
  updateStream,
  initStore
};
