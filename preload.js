/**
 * 预加载脚本 - 安全的 IPC 桥接
 * 通过 contextBridge 暴露有限 API 给渲染进程
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ========== 账号管理 ==========
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  loginAccount: () => ipcRenderer.invoke('login-account'),
  logoutAccount: (accountId) => ipcRenderer.invoke('logout-account', accountId),
  checkAccountStatus: (accountId) => ipcRenderer.invoke('check-account-status', accountId),
  checkLoginStatus: () => ipcRenderer.invoke('check-login-status'),
  logout: () => ipcRenderer.invoke('logout'),

  // ========== 直播间管理 ==========
  addStream: (input, customName, accountId, commentFps, recordMode) => 
    ipcRenderer.invoke('add-stream', { input, customName, accountId, commentFps, recordMode }),
  removeStream: (roomId) => ipcRenderer.invoke('remove-stream', roomId),
  updateStream: (roomId, updates) => ipcRenderer.invoke('update-stream', { roomId, updates }),
  toggleAutoRecord: (roomId) => ipcRenderer.invoke('toggle-auto-record', roomId),
  startRecording: (roomId) => ipcRenderer.invoke('start-recording', roomId),
  stopRecording: (roomId) => ipcRenderer.invoke('stop-recording', roomId),
  getStreams: () => ipcRenderer.invoke('get-streams'),

  // ========== 配置管理 ==========
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // ========== 文件/目录操作 ==========
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  openOutputDir: () => ipcRenderer.invoke('open-output-dir'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  openInBrowser: (url) => ipcRenderer.invoke('open-in-browser', url),
  getVersion: () => ipcRenderer.invoke('get-version'),

  // ========== 事件监听 ==========
  onStreamsUpdated: (callback) => {
    ipcRenderer.on('streams-updated', (event, data) => callback(data));
  },
  onLoginStatusChanged: (callback) => {
    ipcRenderer.on('login-status-changed', (event, data) => callback(data));
  }
});
