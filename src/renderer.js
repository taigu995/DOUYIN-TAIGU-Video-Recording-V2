/**
 * 渲染进程 - UI 交互逻辑
 * 处理用户操作、更新界面状态
 */

// 检测是否在 Electron 环境
const isElectron = typeof window.electronAPI !== 'undefined';

// DOM 元素
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
  fps: document.getElementById('fps'),
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
    
    if (status.loggedIn) {
      elements.loginStatusName.textContent = status.name || '抖音用户';
      elements.loginStatusBadge.textContent = '已登录';
      elements.loginStatusBadge.className = 'login-status__badge login-status__badge--online';
      elements.loginStatus.className = 'login-status login-status--online';
      elements.btnLogin.style.display = 'none';
      
      // 如果有头像，替换图标
      if (status.avatar) {
        const avatarEl = elements.loginStatus.querySelector('.login-status__avatar');
        avatarEl.innerHTML = `<img src="${status.avatar}" alt="avatar" onerror="this.parentElement.innerHTML='<svg width=\\'16\\' height=\\'16\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\'><path d=\\'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\\'></path><circle cx=\\'12\\' cy=\\'7\\' r=\\'4\\'></circle></svg>'">`;
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
    elements.fps.value = config.fps || 30;
    elements.autoStart.checked = config.autoStart !== false;
    elements.minimizeToTray.checked = config.minimizeToTray !== false;
    elements.launchAtLogin.checked = config.launchAtLogin === true;

    if (!config.outputFolder) {
      const defaultFolder = await window.electronAPI.getDefaultFolder();
      elements.outputFolder.placeholder = defaultFolder;
    }

    // 监听状态更新
    window.electronAPI.onStreamsUpdated((data) => {
      streamsData = data;
      renderStreamsList(data);
    });

    // 监听登录状态变化
    window.electronAPI.onLoginStatusChanged(() => {
      updateLoginStatus();
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
      await window.electronAPI.openLogin();
      showToast('已打开登录窗口，请在弹出的窗口中登录抖音', 'info');
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

  elements.btnSaveSettings.addEventListener('click', handleSaveSettings);

  elements.btnBrowse.addEventListener('click', async () => {
    if (isElectron) {
      const result = await window.electronAPI.selectFolder();
      if (!result.canceled) {
        elements.outputFolder.value = result.path;
      }
    }
  });

  // 清除登录数据
  if (elements.btnClearLogin) {
    elements.btnClearLogin.addEventListener('click', async () => {
      if (!isElectron) {
        showToast('此功能仅在桌面应用中可用', 'warning');
        return;
      }
      if (!await showConfirm('确定要清除登录数据吗？清除后需要重新登录抖音账号。')) {
        return;
      }
      const result = await window.electronAPI.clearLogin();
      if (result.success) {
        showToast(result.message || '登录数据已清除', 'success');
        // 刷新登录状态
        setTimeout(updateLoginStatus, 500);
      } else {
        showToast('清除失败: ' + (result.error || '未知错误'), 'error');
      }
    });
  }

  // 重新登录
  if (elements.btnRelogin) {
    elements.btnRelogin.addEventListener('click', async () => {
      if (!isElectron) {
        showToast('此功能仅在桌面应用中可用', 'warning');
        return;
      }
      await window.electronAPI.openLogin();
      showToast('已打开登录窗口，请重新登录抖音', 'info');
    });
  }

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
        window.electronAPI.openInBrowser('https://github.com/taigu995/DOUYIN-TAIGU-TEST');
      } else {
        window.open('https://github.com/taigu995/DOUYIN-TAIGU-TEST', '_blank');
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

// ========== 添加直播间 ==========
async function handleAddStream() {
  const roomId = elements.inputRoomId.value.trim();
  const profileUrl = elements.inputProfileUrl.value.trim();
  const liveUrl = elements.inputLiveUrl.value.trim();
  const customName = elements.inputStreamerName.value.trim();

  // 确定使用哪个输入
  let inputText = '';
  let inputType = '';

  if (roomId) {
    inputText = roomId;
    inputType = 'roomId';
  } else if (profileUrl) {
    inputText = profileUrl;
    inputType = 'profileUrl';
  } else if (liveUrl) {
    inputText = liveUrl;
    inputType = 'liveUrl';
  }

  if (!inputText) {
    showError('请至少输入一个房间号或链接');
    return;
  }

  elements.btnAdd.disabled = true;
  elements.btnAdd.innerHTML = '<span class="spinner"></span> 添加中...';
  hideError();

  try {
    if (isElectron) {
      const result = await window.electronAPI.addStream(inputText, customName);
      if (result.success) {
        showToast(`已添加直播间: ${result.data.streamerName}`, 'success');
        // 清空输入框
        elements.inputRoomId.value = '';
        elements.inputProfileUrl.value = '';
        elements.inputLiveUrl.value = '';
        elements.inputStreamerName.value = '';
        // 刷新列表
        const status = await window.electronAPI.getAllStatus();
        streamsData = status || [];
        renderStreamsList(streamsData);
      } else {
        showError(result.error);
      }
    } else {
      // Demo 模式
      showToast('添加功能仅在桌面应用中可用', 'warning');
    }
  } catch (err) {
    showError('添加失败: ' + err.message);
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
    await window.electronAPI.setConfig('fps', parseInt(elements.fps.value) || 30);
    await window.electronAPI.setConfig('autoStart', elements.autoStart.checked);
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
function renderStreamsList(streams) {
  if (!streams || streams.length === 0) {
    elements.streamsList.innerHTML = '';
    elements.streamsList.appendChild(createEmptyState());
    elements.streamCount.textContent = '0 个直播间';
    elements.recordingCount.textContent = '录制中: 0';
    return;
  }

  elements.streamCount.textContent = `${streams.length} 个直播间`;
  const recordingCount = streams.filter(s => s.status === 'recording').length;
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
    error: { text: '异常', dotClass: 'error', textClass: '' }
  };

  const status = statusMap[stream.status] || statusMap.checking;
  const initial = (stream.streamerName || '?')[0];
  const isRecording = stream.status === 'recording';
  const isLive = stream.isLive || stream.status === 'live' || stream.status === 'recording';

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

  // 合并进度（录制中且正在合并时显示）
  let mergeProgressHtml = '';
  if (isRecording && stream.recorder && stream.recorder.mergeProgress > 0 && stream.recorder.mergeProgress < 100) {
    mergeProgressHtml = `
      <div class="merge-progress">
        <div class="merge-progress-bar" style="width: ${stream.recorder.mergeProgress}%"></div>
        <span class="merge-progress-text">合并中 ${stream.recorder.mergeProgress}%</span>
      </div>
    `;
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
        showToast('录制完成，但合并失败，已保留纯视频文件', 'warning');
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
  const recordingStreams = streamsData.filter(s => s.status === 'recording');
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
