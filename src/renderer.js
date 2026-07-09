/**
 * 渲染进程 - UI 交互逻辑
 * 处理用户操作、更新界面状态
 */

// 检测是否在 Electron 环境
const isElectron = typeof window.electronAPI !== 'undefined';

// DOM 元素
// 全局账号列表
let accounts = [];

const elements = {
  inputRoomId: document.getElementById('input-room-id'),
  inputProfileUrl: document.getElementById('input-profile-url'),
  inputLiveUrl: document.getElementById('input-live-url'),
  btnAdd: document.getElementById('btn-add'),
  addError: document.getElementById('add-error'),
  streamsList: document.getElementById('streams-list'),
  emptyState: document.getElementById('empty-state'),
  streamCount: document.getElementById('stream-count'),
  statusText: document.getElementById('status-text'),
  recordingCount: document.getElementById('recording-count'),
  loginStatus: document.getElementById('login-status'),
  loginStatusName: document.getElementById('login-status__name'),
  loginStatusBadge: document.getElementById('login-status__badge'),
  btnLogin: document.getElementById('btn-login'),
  btnSettings: document.getElementById('btn-settings'),
  settingsPanel: document.getElementById('settings-panel'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  btnSaveSettings: document.getElementById('btn-save-settings'),
  btnBrowse: document.getElementById('btn-browse'),
  outputFolder: document.getElementById('output-folder'),
  checkInterval: document.getElementById('check-interval'),
  autoStart: document.getElementById('auto-start'),
  minimizeToTray: document.getElementById('minimize-to-tray'),
  launchAtLogin: document.getElementById('launch-at-login'),
  btnClearLogin: document.getElementById('btn-clear-login'),
  btnRelogin: document.getElementById('btn-relogin'),
  toastContainer: document.getElementById('toast-container'),
  btnLogs: document.getElementById('btn-logs'),
  logPanel: document.getElementById('log-panel'),
  btnCloseLogs: document.getElementById('btn-close-logs'),
  btnRefreshLogs: document.getElementById('btn-refresh-logs'),
  btnOpenLogFile: document.getElementById('btn-open-log-file'),
  btnExportLogs: document.getElementById('btn-export-logs'),
  btnClearLogs: document.getElementById('btn-clear-logs'),
  logSizeInfo: document.getElementById('log-size-info'),
  inputStreamerName: document.getElementById('input-streamer-name')
};

// 当前直播间数据
let streamsData = [];

// 合并进度开始时间追踪（用于计算预计剩余时间）
const mergeStartTimes = new Map(); // roomId -> timestamp

// 非阻塞确认弹窗（替代原生 confirm，避免阻塞渲染进程导致输入卡顿）
function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <p class="confirm-message">${message}</p>
        <div class="confirm-buttons">
          <button class="btn btn-secondary confirm-cancel">取消</button>
          <button class="btn btn-danger confirm-ok">确定</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('.confirm-ok').addEventListener('click', () => cleanup(true));
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });
  });
}

// ========== 登录状态 ==========
async function updateLoginStatus() {
  if (!isElectron) return;

  try {
    const status = await window.electronAPI.getLoginStatus();
    
    if (status.isLoggedIn) {
      elements.loginStatusName.textContent = status.username || '抖音用户';
      elements.loginStatusBadge.textContent = '已登录';
      elements.loginStatusBadge.className = 'login-status__badge login-status__badge--online';
      elements.loginStatus.className = 'login-status login-status--online';
      elements.btnLogin.style.display = 'none';
      
      // 如果有头像，替换图标
      if (status.avatar) {
        const avatarEl = elements.loginStatus.querySelector('.login-status__avatar');
        if (avatarEl) {
          avatarEl.innerHTML = `<img src="${status.avatar}" alt="avatar" style="width:32px;height:32px;border-radius:50%;">`;
        }
      }
    } else {
      elements.loginStatusName.textContent = '未登录';
      elements.loginStatusBadge.textContent = '未登录';
      elements.loginStatusBadge.className = 'login-status__badge login-status__badge--offline';
      elements.loginStatus.className = 'login-status';
      elements.btnLogin.style.display = '';
    }
  } catch (e) {
    // ignore
  }
}

// ========== 初始化 ==========
async function init() {
  // 加载配置
  if (isElectron) {
    const config = await window.electronAPI.getConfig();
    elements.outputFolder.value = config.outputFolder || '';
    elements.checkInterval.value = config.checkInterval || 30;
    elements.autoStart.checked = config.autoRecord !== false;
    elements.minimizeToTray.checked = config.minimizeToTray !== false;
    elements.launchAtLogin.checked = config.launchAtLogin === true;

    if (!config.outputFolder) {
      const defaultFolder = await window.electronAPI.getDefaultFolder();
      elements.outputFolder.placeholder = defaultFolder;
    }

    // 监听状态更新
    window.electronAPI.onStreamsUpdated((data) => {
      console.log('[Renderer] 收到状态更新:', data.map(s => ({ roomId: s.roomId, status: s.status, isLive: s.isLive })));
      streamsData = data;
      renderStreamsList(data);
    });

    // 监听登录状态变化
    window.electronAPI.onLoginStatusChanged(() => {
      updateLoginStatus();
      loadAccountList();
      showToast('登录状态已更新', 'success');
    });

    // 初始加载
    const status = await window.electronAPI.getAllStatus();
    streamsData = status || [];
    renderStreamsList(streamsData);

    // 检查登录状态
    updateLoginStatus();
  } else {
    // 非 Electron 环境（浏览器预览），显示模拟数据
    renderDemoMode();
  }

  // 绑定事件
  bindEvents();
  
  // 初始化合并工具
  if (isElectron) {
    initManualMerge();
  }
}

// ========== 事件绑定 ==========
function bindEvents() {
  elements.btnAdd.addEventListener('click', handleAddStream);
  // Enter 键添加
  [elements.inputRoomId, elements.inputProfileUrl, elements.inputLiveUrl].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleAddStream();
      }
    });
  });

  elements.btnLogin.addEventListener('click', async () => {
    if (isElectron) {
      const result = await window.electronAPI.openLogin();
      if (result && result.success) {
        showToast(`登录成功：${result.account.nickname || '抖音用户'}`, 'success');
        await updateLoginStatus();
      } else if (result && result.error) {
        showToast(`登录失败：${result.error}`, 'error');
      }
    } else {
      showToast('登录功能仅在桌面应用中可用', 'warning');
    }
  });

  elements.btnSettings.addEventListener('click', () => {
    elements.settingsPanel.style.display = 'flex';
  });

  elements.btnCloseSettings.addEventListener('click', () => {
    elements.settingsPanel.style.display = 'none';
  });

  // 预览确认弹窗事件
  const previewCancelBtn = document.getElementById('preview-cancel');
  const previewConfirmBtn = document.getElementById('preview-confirm');
  const previewCloseBtn = document.getElementById('preview-close');
  if (previewCancelBtn) previewCancelBtn.addEventListener('click', hidePreviewModal);
  if (previewConfirmBtn) previewConfirmBtn.addEventListener('click', confirmAddStream);
  if (previewCloseBtn) previewCloseBtn.addEventListener('click', hidePreviewModal);
  // 录制模式切换
  document.querySelectorAll('input[name="record-mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => handlePreviewModeChange(e.target.value));
  });

  elements.btnSaveSettings.addEventListener('click', handleSaveSettings);

  elements.btnBrowse.addEventListener('click', async () => {
    if (isElectron) {
      const result = await window.electronAPI.selectFolder();
      if (!result.canceled) {
        elements.outputFolder.value = result.path;
      }
    }
  });

  // 账号管理
  const btnAddAccount = document.getElementById('btn-add-account');
  if (btnAddAccount) {
    btnAddAccount.addEventListener('click', async () => {
      if (!isElectron) {
        showToast('此功能仅在桌面应用中可用', 'warning');
        return;
      }
      const result = await window.electronAPI.openLogin();
      if (result && result.success) {
        showToast(`登录成功：${result.account.nickname || '抖音用户'}`, 'success');
        await updateLoginStatus();
        loadAccountList();
      } else if (result && result.error) {
        showToast(`登录失败：${result.error}`, 'error');
      }
    });
  }

  // 加载账号列表
  loadAccountList();

  // 日志查看器事件
  elements.btnLogs.addEventListener('click', showLogPanel);
  elements.btnCloseLogs.addEventListener('click', hideLogPanel);
  elements.btnRefreshLogs.addEventListener('click', loadLogs);
  elements.btnOpenLogFile.addEventListener('click', openLogFolder);
  elements.btnExportLogs.addEventListener('click', exportLogs);
  elements.btnClearLogs.addEventListener('click', clearLogs);

  // 功能介绍按钮
  const btnAbout = document.getElementById('btn-about');
  if (btnAbout) {
    btnAbout.addEventListener('click', () => {
      document.getElementById('about-modal').style.display = 'flex';
    });
  }

  // GitHub 链接 - 使用系统浏览器打开
  const githubLink = document.getElementById('about-github-link');
  if (githubLink) {
    githubLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (isElectron) {
        window.electronAPI.openInBrowser('https://github.com/taigu995/DOUYIN-TAIGU-Video-Recording-V2');
      } else {
        window.open('https://github.com/taigu995/DOUYIN-TAIGU-Video-Recording-V2', '_blank');
      }
    });
  }

  const bilibiliLink = document.getElementById('about-bilibili-link');
  if (bilibiliLink) {
    bilibiliLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (isElectron) {
        window.electronAPI.openInBrowser('https://space.bilibili.com/130118337?spm_id_from=333.1007.0.0');
      } else {
        window.open('https://space.bilibili.com/130118337?spm_id_from=333.1007.0.0', '_blank');
      }
    });
  }
}

// ========== 添加直播间（预览确认流程） ==========
let pendingPreviewData = null;

async function showPreviewModal(data) {
  // 保留 inputText 和 customName（由 handleAddStream 设置）
  pendingPreviewData = { ...pendingPreviewData, ...data };
  console.log('[Renderer] showPreviewModal: data=', JSON.stringify(data), 'pendingPreviewData=', JSON.stringify(pendingPreviewData));
  const modal = document.getElementById('preview-modal');
  if (!modal) {
    console.error('[Renderer] showPreviewModal: preview-modal 元素不存在!');
    return;
  }
  // 填充信息
  const nameEl = document.getElementById('preview-streamer-name');
  const idEl = document.getElementById('preview-room-id');
  if (nameEl) nameEl.textContent = data.streamerName || '未知';
  if (idEl) idEl.textContent = data.roomId || '未知';
  // 填充账号列表
  const accountSelect = document.getElementById('preview-account-select');
  if (accountSelect) {
    accountSelect.innerHTML = '<option value="">不选择账号</option>';
    try {
      const accounts = await window.electronAPI.getAccounts();
      if (accounts && accounts.length > 0) {
        accounts.forEach(acc => {
          const opt = document.createElement('option');
          opt.value = acc.id;
          opt.textContent = acc.nickname || '抖音用户';
          accountSelect.appendChild(opt);
        });
      }
    } catch (e) { /* ignore */ }
  }
  // 默认选择有账号模式（如果有账号）
  const radios = document.querySelectorAll('input[name="record-mode"]');
  try {
    const accounts = await window.electronAPI.getAccounts();
    if (accounts && accounts.length > 0) {
      radios.forEach(r => { r.checked = (r.value === 'with-account'); });
      handlePreviewModeChange('with-account');
    } else {
      radios.forEach(r => { r.checked = (r.value === 'stream-only'); });
      handlePreviewModeChange('stream-only');
    }
  } catch (e) {
    console.warn('[Renderer] showPreviewModal: 设置录制模式失败', e);
    radios.forEach(r => { r.checked = (r.value === 'stream-only'); });
    handlePreviewModeChange('stream-only');
  }
  modal.style.display = 'flex';
  console.log('[Renderer] showPreviewModal: 弹窗已显示 (display=flex)');
}

function hidePreviewModal() {
  const modal = document.getElementById('preview-modal');
  if (modal) modal.style.display = 'none';
  pendingPreviewData = null;
}

function handlePreviewModeChange(mode) {
  const accountSection = document.getElementById('preview-account-section');
  if (accountSection) {
    accountSection.style.display = mode === 'with-account' ? 'block' : 'none';
  }
}

async function confirmAddStream() {
  if (!pendingPreviewData) {
    console.error('[Renderer] confirmAddStream: pendingPreviewData 为空!');
    return;
  }
  console.log('[Renderer] confirmAddStream: pendingPreviewData=', JSON.stringify(pendingPreviewData));
  const mode = document.querySelector('input[name="record-mode"]:checked')?.value || 'stream-only';
  const accountId = document.getElementById('preview-account-select')?.value || null;
  const commentFps = parseInt(document.querySelector('input[name="preview-fps"]:checked')?.value) || 15;
  console.log('[Renderer] confirmAddStream: mode=' + mode + ', accountId=' + accountId + ', fps=' + commentFps + ', inputText=' + pendingPreviewData.inputText);
  try {
    console.log('[Renderer] 调用 addStream...');
    const result = await window.electronAPI.addStream(
      pendingPreviewData.inputText,
      pendingPreviewData.customName,
      mode === 'with-account' ? accountId : null,
      commentFps,
      mode,
      pendingPreviewData.streamerName
    );
    console.log('[Renderer] addStream 返回:', JSON.stringify(result));
    if (!result || !result.success) {
      showToast('添加失败: ' + (result?.error || '未知错误'), 'error');
      return;
    }
    showToast('直播间添加成功', 'success');
    hidePreviewModal();
    elements.inputRoomId.value = '';
    elements.inputProfileUrl.value = '';
    elements.inputLiveUrl.value = '';
    loadStreams();
  } catch (err) {
    console.error('[Renderer] confirmAddStream 错误:', err);
    showToast('添加失败: ' + err.message, 'error');
  }
}

async function handleAddStream() {
  const roomId = elements.inputRoomId.value.trim();
  const profileUrl = elements.inputProfileUrl.value.trim();
  const liveUrl = elements.inputLiveUrl.value.trim();
  const customName = elements.inputStreamerName.value.trim();

  let inputText = '';
  if (roomId) inputText = roomId;
  else if (profileUrl) inputText = profileUrl;
  else if (liveUrl) inputText = liveUrl;

  console.log('[Renderer] handleAddStream: inputText=' + inputText + ', customName=' + customName);

  if (!inputText) {
    showError('请至少输入一个房间号或链接');
    return;
  }

  elements.btnAdd.disabled = true;
  elements.btnAdd.innerHTML = '<span class="spinner"></span> 解析中...';
  hideError();

  try {
    if (isElectron) {
      console.log('[Renderer] 调用 previewStream...');
      const previewResult = await window.electronAPI.previewStream(inputText, customName);
      console.log('[Renderer] previewStream 返回:', JSON.stringify(previewResult));
      if (!previewResult.success) {
        showError(previewResult.error);
        return;
      }
      pendingPreviewData = { inputText, customName, ...previewResult.data };
      console.log('[Renderer] pendingPreviewData:', JSON.stringify(pendingPreviewData));
      await showPreviewModal(previewResult.data);
      console.log('[Renderer] 预览弹窗已显示');
    } else {
      showToast('添加功能仅在桌面应用中可用', 'warning');
    }
  } catch (err) {
    console.error('[Renderer] handleAddStream 错误:', err);
    showError('解析失败: ' + err.message);
  } finally {
    elements.btnAdd.disabled = false;
    elements.btnAdd.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> 添加`;
  }
}

// ========== 保存设置 ==========
async function handleSaveSettings() {
  if (isElectron) {
    await window.electronAPI.setConfig('outputFolder', elements.outputFolder.value);
    await window.electronAPI.setConfig('checkInterval', parseInt(elements.checkInterval.value) || 30);
    await window.electronAPI.setConfig('autoRecord', elements.autoStart.checked);
    await window.electronAPI.setConfig('minimizeToTray', elements.minimizeToTray.checked);
    await window.electronAPI.setConfig('launchAtLogin', elements.launchAtLogin.checked);
    showToast('设置已保存', 'success');
  }
  elements.settingsPanel.style.display = 'none';
}

// ========== 日志查看器 ==========
async function showLogPanel() {
  elements.logPanel.style.display = 'flex';
  await loadLogs();
}

function hideLogPanel() {
  elements.logPanel.style.display = 'none';
}

async function loadLogs() {
  const logContent = document.getElementById('log-content');
  const logFilePath = document.getElementById('log-file-path');
  
  if (!isElectron) {
    logContent.innerHTML = '<p class="log-loading">日志功能仅在桌面应用中可用</p>';
    return;
  }

  logContent.innerHTML = '<p class="log-loading">加载中...</p>';
  
  try {
    const result = await window.electronAPI.getLogContent();
    
    // 兼容新旧格式
    const content = typeof result === 'object' ? result.content : result;
    const logPath = typeof result === 'object' ? result.path : '';
    
    if (logFilePath) {
      logFilePath.textContent = logPath || '';
    }
    
    // 显示日志文件大小信息
    if (elements.logSizeInfo) {
      try {
        const pathInfo = await window.electronAPI.getLogPath();
        elements.logSizeInfo.textContent = `日志路径: ${pathInfo}`;
      } catch (e) {
        elements.logSizeInfo.textContent = '';
      }
    }
    
    if (!content || content === 'No log file found.') {
      logContent.innerHTML = '<p class="log-loading">暂无日志记录</p>';
      return;
    }

    // Parse and colorize log lines
    const lines = content.split('\n');
    let totalLines = 0;
    let errorCount = 0;
    let warnCount = 0;
    
    const html = lines.map(line => {
      if (!line.trim()) return '';
      totalLines++;
      let cls = 'info';
      if (line.includes('[ERROR]')) { cls = 'error'; errorCount++; }
      else if (line.includes('[WARN]')) { cls = 'warn'; warnCount++; }
      return `<div class="log-line ${cls}">${escapeHtml(line)}</div>`;
    }).filter(Boolean).join('');
    
    // 添加统计信息到顶部
    const statsHtml = `
      <div class="log-stats">
        <span>共 ${totalLines} 行</span>
        <span class="log-stat-error">错误: ${errorCount}</span>
        <span class="log-stat-warn">警告: ${warnCount}</span>
      </div>
    `;
    
    logContent.innerHTML = statsHtml + html;
    // Scroll to bottom
    logContent.scrollTop = logContent.scrollHeight;
  } catch (err) {
    logContent.innerHTML = `<p class="log-loading">加载日志失败: ${escapeHtml(err.message)}</p>`;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function openLogFolder() {
  if (isElectron) {
    try {
      await window.electronAPI.openLogFolder();
    } catch (e) {
      showToast('打开日志目录失败: ' + e.message, 'error');
    }
  }
}

async function exportLogs() {
  if (!isElectron) {
    showToast('导出功能仅在桌面应用中可用', 'warning');
    return;
  }
  try {
    const result = await window.electronAPI.exportLogs();
    if (result.success) {
      showToast(`日志已导出到: ${result.path}`, 'success');
    } else if (!result.canceled) {
      showToast('导出失败: ' + result.error, 'error');
    }
  } catch (err) {
    showToast('导出出错: ' + err.message, 'error');
  }
}

async function clearLogs() {
  if (!isElectron) return;
  if (!await showConfirm('确定要清空所有日志吗？此操作不可恢复。')) return;
  try {
    const result = await window.electronAPI.clearLogs();
    if (result.success) {
      showToast('日志已清空', 'success');
      await loadLogs();
    } else {
      showToast('清空失败', 'error');
    }
  } catch (err) {
    showToast('清空出错: ' + err.message, 'error');
  }
}

// ========== 渲染直播间列表 ==========
async function loadStreams() {
  try {
    const status = await window.electronAPI.getAllStatus();
    streamsData = status || [];
    renderStreamsList(streamsData);
  } catch (e) {
    console.error('加载直播间列表失败:', e);
  }
}

async function loadAccountList() {
  const listEl = document.getElementById('account-list');
  if (!listEl) return;

  try {
    const accounts = await window.electronAPI.getAccounts();
    if (!accounts || accounts.length === 0) {
      listEl.innerHTML = '<p class="account-empty-hint">暂无登录账号</p>';
      return;
    }

    listEl.innerHTML = accounts.map(acc => `
      <div class="account-item" data-id="${acc.id}">
        <div class="account-info">
          <div class="account-avatar">
            ${acc.avatar 
              ? `<img src="${acc.avatar}" alt="avatar" style="width:28px;height:28px;border-radius:50%;">`
              : `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`
            }
          </div>
          <div class="account-detail">
            <span class="account-nickname">${acc.nickname || '抖音用户'}</span>
            <span class="account-id">ID: ${acc.id.substring(0, 8)}...</span>
          </div>
        </div>
        <button class="btn btn-danger btn-sm account-remove-btn" onclick="handleRemoveAccount('${acc.id}')" title="移除账号">移除</button>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<p class="account-empty-hint">加载账号列表失败</p>';
  }
}

window.handleRemoveAccount = async function (accountId) {
  if (!await showConfirm('确定要移除该账号吗？移除后需要重新登录。')) return;
  try {
    await window.electronAPI.removeAccount(accountId);
    showToast('账号已移除', 'success');
    await updateLoginStatus();
    loadAccountList();
  } catch (e) {
    showToast('移除失败: ' + e.message, 'error');
  }
};

function renderStreamsList(streams) {
  if (!streams || streams.length === 0) {
    elements.streamsList.innerHTML = '';
    elements.streamsList.appendChild(createEmptyState());
    elements.streamCount.textContent = '0 个直播间';
    elements.recordingCount.textContent = '录制中: 0';
    return;
  }

  elements.streamCount.textContent = `${streams.length} 个直播间`;
  const recordingCount = streams.filter(s => s.status === 'recording' || s.status === 'merging').length;
  elements.recordingCount.textContent = `录制中: ${recordingCount}`;

  elements.streamsList.innerHTML = '';
  streams.forEach(stream => {
    elements.streamsList.appendChild(createStreamCard(stream));
  });
}

function createEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
      <polygon points="23 7 16 12 23 17 23 7"></polygon>
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
    </svg>
    <p>暂无直播间，请粘贴抖音直播链接添加</p>
  `;
  return div;
}

function createStreamCard(stream) {
  const card = document.createElement('div');
  card.className = 'stream-card';
  card.dataset.roomId = stream.roomId;

  const statusMap = {
    checking: { text: '检测中...', dotClass: 'checking', textClass: '' },
    live: { text: '直播中', dotClass: 'live', textClass: 'live' },
    offline: { text: '未开播', dotClass: '', textClass: '' },
    recording: { text: '录制中', dotClass: 'recording', textClass: 'recording' },
    merging: { text: '合并中...', dotClass: 'recording', textClass: 'recording' },
    error: { text: '异常', dotClass: 'error', textClass: '' }
  };

  const status = statusMap[stream.status] || statusMap.checking;
  const initial = (stream.streamerName || '?')[0];
  const isRecording = stream.status === 'recording' || stream.status === 'merging';
  const isLive = stream.isLive || stream.status === 'live' || stream.status === 'recording' || stream.status === 'merging';

  // 录制时长
  let durationText = '';
  if (isRecording && stream.recorder && stream.recorder.startTime) {
    const duration = Date.now() - new Date(stream.recorder.startTime).getTime();
    durationText = formatDuration(duration);
  }

  // 音频/视频状态指示器（录制中）
  let recordingIndicator = '';
  if (isRecording && stream.recorder) {
    const hasAudio = stream.recorder.hasAudio;
    recordingIndicator = `
      <span class="recording-indicator">
        <span class="indicator-item video-active" title="正在录制视频">🎬 视频</span>
        <span class="indicator-item ${hasAudio ? 'audio-active' : 'audio-inactive'}" title="${hasAudio ? '正在录制音频' : '未检测到音频源'}">
          ${hasAudio ? '🔊 音频' : '🔇 无声'}
        </span>
      </span>
    `;
  }

  // 上次录制结果（停止后显示）
  let lastResultHtml = '';
  if (!isRecording && stream.recorder && stream.recorder.lastRecordingResult) {
    const result = stream.recorder.lastRecordingResult;
    const timeSince = formatTimeAgo(result.timestamp);
    let mergeStatusHtml = '';
    if (result.mergeResult === true) {
      mergeStatusHtml = '<span class="merge-status merge-success" title="视频和音频已成功合并">✅ 已合并</span>';
    } else if (result.mergeResult === false) {
      mergeStatusHtml = '<span class="merge-status merge-failed" title="合并失败，已保留纯视频文件">⚠️ 合并失败</span>';
    } else {
      mergeStatusHtml = '<span class="merge-status merge-none" title="未检测到音频，仅录制视频">📹 仅视频</span>';
    }
    lastResultHtml = `
      <div class="last-recording-result">
        <span class="result-label">上次录制 (${timeSince}):</span>
        <span class="result-item ${result.hasAudio ? 'result-ok' : 'result-warn'}" title="${result.hasAudio ? '成功录制到音频' : '未录制到音频'}">
          ${result.hasAudio ? '🔊 有音频' : '🔇 无音频'}
        </span>
        ${mergeStatusHtml}
        <span class="result-file" title="${result.outputFile || ''}">📁 已保存</span>
      </div>
    `;
  }

  // 合并进度（合并中时显示）
  let mergeProgressHtml = '';
  if (stream.status === 'merging' && stream.mergeProgress) {
    const progress = stream.mergeProgress.progress || 0;
    const phase = stream.mergeProgress.phase || '';
    const phaseName = stream.mergeProgress.phaseName || phase;
    const currentFrame = stream.mergeProgress.currentFrame || 0;
    const totalFrames = stream.mergeProgress.totalFrames || 0;
    const currentTime = stream.mergeProgress.currentTime || 0;
    const totalDuration = stream.mergeProgress.totalDuration || 0;

    // 追踪合并开始时间
    if (!mergeStartTimes.has(stream.roomId)) {
      mergeStartTimes.set(stream.roomId, Date.now());
    }
    const mergeStartTime = mergeStartTimes.get(stream.roomId);

    // 格式化时间
    const formatDuration = (ms) => {
      const seconds = Math.floor(ms / 1000);
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      return `${m}:${String(s).padStart(2, '0')}`;
    };

    // 计算预计剩余时间
    let etaText = '';
    if (progress > 0 && progress < 100) {
      const elapsedMs = Date.now() - mergeStartTime;
      const remainingMs = (elapsedMs / progress) * (100 - progress);
      if (remainingMs > 0 && remainingMs < 86400000) { // 小于24小时才显示
        etaText = ` | 预计剩余: ${formatDuration(remainingMs)}`;
      }
    }

    // 帧数信息
    let frameText = '';
    if (totalFrames > 0) {
      frameText = ` | 帧: ${currentFrame.toLocaleString()}/${totalFrames.toLocaleString()}`;
    }

    // 时间进度
    let timeText = '';
    if (totalDuration > 0) {
      timeText = ` | ${formatDuration(currentTime)}/${formatDuration(totalDuration)}`;
    }

    // 是否恢复中的合并
    const resumeTag = stream.mergeProgress.resuming ? '<span class="merge-resume-tag">恢复中</span>' : '';

    mergeProgressHtml = `
      <div class="merge-progress">
        <div class="merge-progress-bar" style="width: ${progress}%"></div>
        <span class="merge-progress-text">
          ${resumeTag}${phaseName} ${progress}%${timeText}${frameText}${etaText}
        </span>
      </div>
    `;
  } else if (stream.status === 'merging') {
    // 合并中但没有进度信息时显示简单的加载动画
    mergeProgressHtml = `
      <div class="merge-progress">
        <div class="merge-progress-bar indeterminate"></div>
        <span class="merge-progress-text">合并中...</span>
      </div>
    `;
  } else {
    // 非合并状态时清除开始时间追踪
    mergeStartTimes.delete(stream.roomId);
  }

  card.innerHTML = `
    <div class="stream-card-header">
      <div class="stream-info">
        <div class="stream-avatar ${isLive ? 'live' : ''}">${initial}</div>
        <div class="stream-meta">
          <div class="stream-name">
            <span title="${stream.streamerName || '未知主播'}">${stream.streamerName || '未知主播'}</span>
            <button class="btn-edit-name" onclick="handleEditStreamerName('${stream.roomId}')" title="修改主播名称">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
            </button>
          </div>
          <div class="stream-room-id">房间号: ${stream.roomId}</div>
        <div class="stream-mode-row">
          <select class="stream-record-mode" data-room-id="${stream.roomId}" title="录制模式">
            <option value="with-account"${stream.recordMode === 'with-account' ? ' selected' : ''}>有账号录制</option>
            <option value="stream-only"${stream.recordMode === 'stream-only' ? ' selected' : ''}>仅录制直播流</option>
            <option value="stream+comment"${stream.recordMode === 'stream+comment' ? ' selected' : ''}>有账号+评论区</option>
            <option value="stream+comment-no-login"${stream.recordMode === 'stream+comment-no-login' ? ' selected' : ''}>无账号+评论区</option>
          </select>
          <select class="stream-comment-fps" data-room-id="${stream.roomId}" title="评论区帧率">
            <option value="30"${stream.commentFps == 30 ? ' selected' : ''}>30fps</option>
            <option value="15"${stream.commentFps == 15 ? ' selected' : ''}>15fps</option>
            <option value="10"${stream.commentFps == 10 ? ' selected' : ''}>10fps</option>
            <option value="5"${stream.commentFps == 5 ? ' selected' : ''}>5fps</option>
          </select>
        </div>
        </div>
      </div>
      <div class="stream-actions">
        <button class="btn btn-sm ${stream.autoRecord !== false ? 'btn-success' : 'btn-ghost'}" onclick="handleToggleAutoRecord('${stream.roomId}')" title="${stream.autoRecord !== false ? '点击关闭自动录制' : '点击开启自动录制'}">
          ${stream.autoRecord !== false ? '自动录制: 开' : '自动录制: 关'}
        </button>
        ${isRecording
          ? `<button class="btn btn-danger btn-sm" onclick="handleStopRecording('${stream.roomId}')">停止录制</button>`
          : `<button class="btn btn-success btn-sm" onclick="handleStartRecording('${stream.roomId}')" ${!isLive ? 'disabled title="未开播"' : ''}>开始录制</button>`
        }
        ${stream.canManualMerge ? `<button class="btn btn-warning btn-sm" onclick="handleManualMerge('${stream.roomId}')" title="手动合并直播流和评论区视频">手动合并</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="handleViewHistory('${stream.roomId}')" title="查看录制记录">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
          </svg>
        </button>
        <button class="btn btn-ghost btn-sm" onclick="handleRemoveStream('${stream.roomId}')" title="删除">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>
    <div class="stream-card-body">
      <div class="stream-status">
        <span class="status-dot ${status.dotClass}"></span>
        <span class="status-text ${status.textClass}">${status.text}</span>
        ${durationText ? `<span class="stream-duration">${durationText}</span>` : ''}
        ${recordingIndicator}
      </div>
      ${mergeProgressHtml}
      ${lastResultHtml}
      ${stream.lastCheck ? `<span style="font-size:11px;color:var(--text-muted)">上次检测: ${formatTime(stream.lastCheck)}</span>` : ''}
    </div>
  `;

  // 录制模式切换
  const modeSelect = card.querySelector('.stream-record-mode');
  if (modeSelect) {
    modeSelect.addEventListener('change', async (e) => {
      const mode = e.target.value;
      try {
        const result = await window.electronAPI.updateStream(stream.roomId, { recordMode: mode });
        if (result && result.success) {
          showToast(`录制模式已切换: ${e.target.options[e.target.selectedIndex].text}`, 'success');
        } else {
          showToast('切换失败: ' + (result?.error || '未知错误'), 'error');
        }
      } catch (err) {
        showToast('切换失败: ' + err.message, 'error');
      }
    });
  }

  // 评论区帧率切换
  const fpsSelect = card.querySelector('.stream-comment-fps');
  if (fpsSelect) {
    fpsSelect.addEventListener('change', async (e) => {
      const fps = parseInt(e.target.value);
      try {
        const result = await window.electronAPI.updateStream(stream.roomId, { commentFps: fps });
        if (result && result.success) {
          showToast(`评论区帧率已切换: ${fps}fps`, 'success');
        } else {
          showToast('切换失败: ' + (result?.error || '未知错误'), 'error');
        }
      } catch (err) {
        showToast('切换失败: ' + err.message, 'error');
      }
    });
  }

  return card;
}

// ========== 操作处理 ==========
window.handleStartRecording = async function (roomId) {
  if (!isElectron) {
    showToast('录制功能仅在桌面应用中可用', 'warning');
    return;
  }
  try {
    const result = await window.electronAPI.startRecording(roomId);
    if (result.success) {
      showToast('开始录制', 'success');
    } else {
      // 如果是"正在录制中"的错误，提供更友好的提示
      const errorMsg = result.error || '未知错误';
      if (errorMsg.includes('录制中') || errorMsg.includes('已在运行')) {
        showToast('该直播间已在录制中，请先停止当前录制或刷新列表', 'warning');
      } else {
        showToast('录制失败: ' + errorMsg, 'error');
      }
    }
  } catch (err) {
    showToast('录制出错: ' + err.message, 'error');
  }
};

window.handleStopRecording = async function (roomId) {
  if (!isElectron) return;
  try {
    showToast('正在停止录制并处理文件...', 'info');
    const result = await window.electronAPI.stopRecording(roomId);
    if (result.success) {
      const data = result.data || {};
      if (data.mergeResult === true) {
        showToast('录制完成，视频和音频已成功合并', 'success');
      } else if (data.mergeResult === false) {
        showToast('录制完成，但合并失败，已保留纯视频文件。可使用"手动合并"按钮重新合并', 'warning');
      } else if (data.hasAudio === false) {
        showToast('录制完成（未检测到音频，仅保存视频）', 'warning');
      } else {
        showToast('已停止录制', 'success');
      }
    } else {
      showToast('停止失败: ' + result.error, 'error');
    }
  } catch (err) {
    showToast('停止出错: ' + err.message, 'error');
  }
};

window.handleManualMerge = async function (roomId) {
  if (!isElectron) return;
  if (!await showConfirm('确定要手动合并直播流和评论区视频吗？这可能会覆盖已有的输出文件。')) return;
  try {
    showToast('开始手动合并...', 'info');
    const result = await window.electronAPI.manualMerge(roomId);
    if (result.success) {
      showToast('手动合并完成', 'success');
    } else {
      showToast('手动合并失败: ' + (result.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('手动合并出错: ' + err.message, 'error');
  }
};

window.handleRemoveStream = async function (roomId) {
  if (!await showConfirm('确定要删除这个直播间吗？')) return;
  if (!isElectron) return;
  try {
    const result = await window.electronAPI.removeStream(roomId);
    if (result.success) {
      showToast('已删除', 'success');
      const status = await window.electronAPI.getAllStatus();
      streamsData = status || [];
      renderStreamsList(streamsData);
    }
  } catch (err) {
    showToast('删除出错: ' + err.message, 'error');
  }
};

window.handleToggleAutoRecord = async function (roomId) {
  if (!isElectron) return;
  
  // 先本地立即更新UI（乐观更新）
  const stream = streamsData.find(s => s.roomId === roomId);
  if (stream) {
    stream.autoRecord = stream.autoRecord === false ? true : false;
    renderStreamsList(streamsData);
  }
  
  try {
    const result = await window.electronAPI.toggleAutoRecord(roomId);
    if (result.success) {
      showToast(result.autoRecord ? '已开启自动录制' : '已关闭自动录制', 'success');
      // 同步服务端状态
      if (stream) {
        stream.autoRecord = result.autoRecord;
        renderStreamsList(streamsData);
      }
    } else {
      // 回滚
      if (stream) {
        stream.autoRecord = !stream.autoRecord;
        renderStreamsList(streamsData);
      }
      showToast('切换失败: ' + result.error, 'error');
    }
  } catch (err) {
    // 回滚
    if (stream) {
      stream.autoRecord = !stream.autoRecord;
      renderStreamsList(streamsData);
    }
    showToast('切换出错: ' + err.message, 'error');
  }
};

// 修改主播名称
window.handleEditStreamerName = async function (roomId) {
  const stream = streamsData.find(s => s.roomId === roomId);
  const currentName = stream?.streamerName || '';
  
  const newName = prompt('请输入主播名称:', currentName);
  if (newName === null || newName.trim() === '') return;
  if (newName.trim() === currentName) return;

  if (isElectron) {
    try {
      const result = await window.electronAPI.updateStream(roomId, { streamerName: newName.trim() });
      if (result.success) {
        showToast(`主播名称已更新为: ${newName.trim()}`, 'success');
        // 刷新列表
        const status = await window.electronAPI.getAllStatus();
        streamsData = status || [];
        renderStreamsList(streamsData);
      } else {
        showToast('修改失败: ' + result.error, 'error');
      }
    } catch (err) {
      showToast('修改失败: ' + err.message, 'error');
    }
  } else {
    // Demo 模式
    if (stream) {
      stream.streamerName = newName.trim();
      renderStreamsList(streamsData);
      showToast(`主播名称已更新为: ${newName.trim()}`, 'success');
    }
  }
};

// 查看录制记录
window.handleViewHistory = async function (roomId) {
  if (!isElectron) {
    // 预览环境模拟数据
    const stream = streamsData.find(s => s.roomId === roomId);
    showHistoryModal({
      streamerName: stream?.streamerName || '未知主播',
      roomId: roomId,
      currentRecording: stream?.isRecording ? { startTime: new Date().toISOString() } : null,
      history: [
        { startTime: '2026-07-05T10:00:00.000Z', endTime: '2026-07-05T12:30:00.000Z', fileSize: 156000000 },
        { startTime: '2026-07-04T19:00:00.000Z', endTime: '2026-07-04T21:15:00.000Z', fileSize: 89500000 }
      ]
    });
    return;
  }
  try {
    const result = await window.electronAPI.getRecordingHistory(roomId);
    showHistoryModal(result);
  } catch (err) {
    showToast('获取记录出错: ' + err.message, 'error');
  }
};

// 显示录制记录弹窗
function showHistoryModal(data) {
  // 移除已存在的弹窗
  const existing = document.getElementById('history-modal');
  if (existing) existing.remove();

  const { streamerName, roomId, currentRecording, history } = data;

  // 格式化文件大小
  const formatSize = (bytes) => {
    if (!bytes) return '-';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  };

  // 格式化时间
  const formatTime = (timestamp) => {
    if (!timestamp) return '-';
    const d = new Date(timestamp);
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  };

  // 当前录制信息
  let currentHtml = '';
  if (currentRecording) {
    const startTime = formatTime(currentRecording.startTime);
    currentHtml = `
      <div class="history-current">
        <div class="history-current-title">
          <span class="recording-dot"></span>
          正在录制中
        </div>
        <div class="history-current-info">
          <span>开始时间: ${startTime}</span>
          <span id="current-duration">已录制: 00:00:00</span>
        </div>
      </div>
    `;
  }

  // 历史记录列表
  let historyHtml = '';
  if (history && history.length > 0) {
    historyHtml = history.map((record, index) => `
      <div class="history-record">
        <div class="history-record-index">#${history.length - index}</div>
        <div class="history-record-info">
          <div class="history-record-time">
            <span>开始: ${formatTime(record.startTime)}</span>
            <span>结束: ${formatTime(record.endTime)}</span>
          </div>
          <div class="history-record-size">文件大小: ${formatSize(record.fileSize)}</div>
        </div>
      </div>
    `).join('');
  } else {
    historyHtml = '<div class="history-empty">暂无录制记录</div>';
  }

  const modal = document.createElement('div');
  modal.id = 'history-modal';
  modal.className = 'history-modal';
  modal.innerHTML = `
    <div class="modal-content history-modal-content">
      <div class="modal-header">
        <h3>${streamerName} - 录制记录</h3>
        <button class="modal-close" onclick="closeHistoryModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="history-room-info">房间号: ${roomId}</div>
        ${currentHtml}
        <div class="history-list-title">历史录制记录 (${history ? history.length : 0})</div>
        <div class="history-list">
          ${historyHtml}
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // 点击遮罩关闭
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeHistoryModal();
  });

  // 更新录制时长
  if (currentRecording) {
    updateCurrentDuration(currentRecording.startTime);
  }
}

// 更新当前录制时长
function updateCurrentDuration(startTime) {
  const durationEl = document.getElementById('current-duration');
  if (!durationEl) return;

  const update = () => {
    if (!document.getElementById('history-modal')) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    durationEl.textContent = `已录制: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    requestAnimationFrame(update);
  };
  update();
}

// 关闭录制记录弹窗
window.closeHistoryModal = function () {
  const modal = document.getElementById('history-modal');
  if (modal) modal.remove();
};

// ========== 工具函数 ==========
function showError(msg) {
  elements.addError.textContent = msg;
  elements.addError.style.display = 'block';
}

function hideError() {
  elements.addError.style.display = 'none';
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = '0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${Math.floor(diff / 86400000)}天前`;
}

// ========== Demo 模式（浏览器预览） ==========
function renderDemoMode() {
  const demoStreams = [
    {
      roomId: '7459644624701',
      streamerName: '刘桐桐',
      status: 'recording',
      isLive: true,
      lastCheck: Date.now(),
      recorder: { startTime: new Date(Date.now() - 3661000).toISOString(), frameCount: 108000 }
    },
    {
      roomId: '8392017463820',
      streamerName: '小明同学',
      status: 'live',
      isLive: true,
      lastCheck: Date.now() - 15000,
      recorder: null
    },
    {
      roomId: '6283910475621',
      streamerName: '旅行日记',
      status: 'offline',
      isLive: false,
      lastCheck: Date.now() - 30000,
      recorder: null
    }
  ];

  streamsData = demoStreams;
  renderStreamsList(demoStreams);
  elements.statusText.textContent = '演示模式 - 桌面应用功能完整可用';
}

// 定时更新录制时长
setInterval(() => {
  const recordingStreams = streamsData.filter(s => s.status === 'recording' || s.status === 'merging');
  if (recordingStreams.length > 0) {
    recordingStreams.forEach(stream => {
      const card = document.querySelector(`[data-room-id="${stream.roomId}"]`);
      if (card && stream.recorder && stream.recorder.startTime) {
        const durationEl = card.querySelector('.stream-duration');
        if (durationEl) {
          const duration = Date.now() - new Date(stream.recorder.startTime).getTime();
          durationEl.textContent = formatDuration(duration);
        }
      }
    });
  }
}, 1000);

// 启动
document.addEventListener('DOMContentLoaded', init);

// ========== 手动合并工具 ==========
let manualMergeProgressInterval = null;

function initManualMerge() {
  const btnManualMerge = document.getElementById('btn-manual-merge');
  const modal = document.getElementById('manual-merge-modal');
  const btnClose = document.getElementById('manual-merge-close');
  const btnCancel = document.getElementById('manual-merge-cancel');
  const btnStart = document.getElementById('manual-merge-start');
  const btnBrowseStream = document.getElementById('manual-merge-browse-stream');
  const btnBrowseFrames = document.getElementById('manual-merge-browse-frames');
  const btnBrowseOutput = document.getElementById('manual-merge-browse-output');
  const inputStream = document.getElementById('manual-merge-stream-path');
  const inputFrames = document.getElementById('manual-merge-frames-path');
  const inputOutput = document.getElementById('manual-merge-output-path');
  const progressEl = document.getElementById('manual-merge-progress');
  const progressFill = progressEl?.querySelector('.manual-merge-progress-fill');
  const progressText = progressEl?.querySelector('.manual-merge-progress-text');
  const resultEl = document.getElementById('manual-merge-result');

  if (!btnManualMerge || !modal) return;

  // 打开弹窗
  btnManualMerge.addEventListener('click', () => {
    modal.style.display = 'flex';
    resetManualMergeUI();
  });

  // 关闭弹窗
  const closeModal = () => {
    modal.style.display = 'none';
    resetManualMergeUI();
  };
  btnClose?.addEventListener('click', closeModal);
  btnCancel?.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // 浏览文件
  btnBrowseStream?.addEventListener('click', async () => {
    const result = await window.electronAPI.selectFile({
      title: '选择直播流视频文件',
      filters: [{ name: '视频文件', extensions: ['mp4'] }]
    });
    if (result && !result.canceled && result.filePaths[0]) {
      inputStream.value = result.filePaths[0];
    }
  });

  btnBrowseFrames?.addEventListener('click', async () => {
    const result = await window.electronAPI.selectDirectory({ title: '选择评论区帧目录' });
    if (result && !result.canceled && result.filePaths[0]) {
      inputFrames.value = result.filePaths[0];
    }
  });

  btnBrowseOutput?.addEventListener('click', async () => {
    const result = await window.electronAPI.saveFile({
      title: '选择输出文件路径',
      defaultPath: 'merged_output.mp4',
      filters: [{ name: '视频文件', extensions: ['mp4'] }]
    });
    if (result && !result.canceled && result.filePath) {
      inputOutput.value = result.filePath;
    }
  });

  // 拖拽支持
  [inputStream, inputFrames].forEach(input => {
    input?.addEventListener('dragover', (e) => {
      e.preventDefault();
      input.parentElement.classList.add('dragover');
    });
    input?.addEventListener('dragleave', () => {
      input.parentElement.classList.remove('dragover');
    });
    input?.addEventListener('drop', async (e) => {
      e.preventDefault();
      input.parentElement.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        // Electron 拖拽获取路径
        const path = files[0].path;
        if (path) {
          input.value = path;
        }
      }
    });
  });

  // 开始合并
  btnStart?.addEventListener('click', async () => {
    const streamPath = inputStream.value.trim();
    const framesDir = inputFrames.value.trim();
    const outputPath = inputOutput.value.trim();
    const fps = parseInt(document.querySelector('input[name="manual-merge-fps"]:checked')?.value || '10');

    if (!streamPath) {
      showToast('请选择直播流视频文件', 'error');
      return;
    }
    if (!framesDir) {
      showToast('请选择评论区帧目录', 'error');
      return;
    }

    // 禁用按钮，显示进度
    btnStart.disabled = true;
    btnStart.textContent = '合并中...';
    progressEl.style.display = 'block';
    resultEl.style.display = 'none';
    progressFill.style.width = '0%';
    progressText.textContent = '准备中...';

    try {
      const result = await window.electronAPI.startManualMerge({
        streamPath,
        framesDir,
        outputPath: outputPath || null,
        commentFps: fps
      });

      if (result.success) {
        progressFill.style.width = '100%';
        progressText.textContent = '合并完成!';
        resultEl.className = 'manual-merge-result success';
        resultEl.querySelector('.manual-merge-result-icon').textContent = '✓';
        resultEl.querySelector('.manual-merge-result-text').textContent = 
          `合并完成: ${result.outputFile}\n大小: ${(result.fileSize / 1024 / 1024).toFixed(1)} MB`;
        resultEl.style.display = 'block';
        showToast('合并完成!', 'success');
      } else {
        throw new Error(result.error || '合并失败');
      }
    } catch (err) {
      resultEl.className = 'manual-merge-result error';
      resultEl.querySelector('.manual-merge-result-icon').textContent = '✗';
      resultEl.querySelector('.manual-merge-result-text').textContent = `合并失败: ${err.message}`;
      resultEl.style.display = 'block';
      showToast(`合并失败: ${err.message}`, 'error');
    } finally {
      btnStart.disabled = false;
      btnStart.textContent = '开始合并';
      // 停止进度轮询
      if (manualMergeProgressInterval) {
        clearInterval(manualMergeProgressInterval);
        manualMergeProgressInterval = null;
      }
    }
  });

  function resetManualMergeUI() {
    progressEl.style.display = 'none';
    resultEl.style.display = 'none';
    btnStart.disabled = false;
    btnStart.textContent = '开始合并';
    if (manualMergeProgressInterval) {
      clearInterval(manualMergeProgressInterval);
      manualMergeProgressInterval = null;
    }
  }
}
