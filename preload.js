/**
 * 预加载脚本 - 安全的 IPC 桥接
 * 通过 contextBridge 暴露有限 API 给渲染进程
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 添加直播间
  addStream: (inputText, customName) => ipcRenderer.invoke('add-stream', inputText, customName),

  // 删除直播间
  removeStream: (roomId) => ipcRenderer.invoke('remove-stream', roomId),

  // 切换自动录制开关
  toggleAutoRecord: (roomId) => ipcRenderer.invoke('toggle-auto-record', roomId),

  // 修改直播间信息
  updateStream: (roomId, updates) => ipcRenderer.invoke('update-stream', roomId, updates),

  // 获取录制记录
  getRecordingHistory: (roomId) => ipcRenderer.invoke('get-recording-history', roomId),

  // 开始录制
  startRecording: (roomId) => ipcRenderer.invoke('start-recording', roomId),

  // 停止录制
  stopRecording: (roomId) => ipcRenderer.invoke('stop-recording', roomId),

  // 获取所有直播间状态
  getAllStatus: () => ipcRenderer.invoke('get-all-status'),

  // 获取配置
  getConfig: () => ipcRenderer.invoke('get-config'),

  // 设置配置
  setConfig: (key, value) => ipcRenderer.invoke('set-config', key, value),

  // 选择文件夹
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // 打开登录窗口
  openLogin: () => ipcRenderer.invoke('open-login'),

  // 清除登录数据
  clearLogin: () => ipcRenderer.invoke('clear-login'),

  // 获取登录状态
  getLoginStatus: () => ipcRenderer.invoke('get-login-status'),

  // 在浏览器中打开
  openInBrowser: (url) => ipcRenderer.invoke('open-in-browser', url),

  // 获取默认文件夹
  getDefaultFolder: () => ipcRenderer.invoke('get-default-folder'),

  // 监听直播间状态更新
  onStreamsUpdated: (callback) => {
    ipcRenderer.on('streams-updated', (event, data) => {
      callback(data);
    });
  },

  // 监听登录状态变化
  onLoginStatusChanged: (callback) => {
    ipcRenderer.on('login-status-changed', () => {
      callback();
    });
  },

  // 日志相关
  getLogContent: () => {
    return ipcRenderer.invoke('get-log-content');
  },
  openLogFile: () => {
    return ipcRenderer.invoke('open-log-file');
  },
  exportLogs: () => {
    return ipcRenderer.invoke('export-logs');
  },
  getRecentLogs: () => {
    return ipcRenderer.invoke('get-recent-logs');
  },
  getLogPath: () => {
    return ipcRenderer.invoke('get-log-path');
  },
  openLogFolder: () => {
    return ipcRenderer.invoke('open-log-folder');
  },
  clearLogs: () => {
    return ipcRenderer.invoke('clear-logs');
  }
});
