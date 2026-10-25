/**
 * Logger - 错误日志输出模块
 * 将错误和关键信息写入日志文件，便于问题排查
 * 
 * 功能：
 * - 按日期自动轮转日志文件
 * - 保留最近 7 天的日志
 * - 崩溃时自动保存日志
 * - 自动备份日志到固定目录
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Logger {
  constructor() {
    this._initialized = false;
    this.logDir = null;
    this.autoBackupDir = null;
    this.maxSize = 10 * 1024 * 1024; // 10MB max log size per file
    this.keepDays = 7; // 保留最近 7 天的日志
    this.flushInterval = 5000; // 每 5 秒刷新一次日志缓冲区
    this.logBuffer = [];
    this.currentDate = this._getDateStr();
    this.logFile = null;
    this._initPromise = null;
  }

  /**
   * 延迟初始化（等待 app 就绪）
   */
  async _ensureInitialized() {
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;
    
    this._initPromise = (async () => {
      try {
        // 等待 app 就绪
        const { app } = require('electron');
        await app.whenReady();
        
        // 只在 logDir 未设置时才设置（避免覆盖 setLogDir 的设置）
        if (!this.logDir) {
          this.logDir = path.join(app.getPath('userData'), 'logs');
        }
        this.autoBackupDir = path.join(app.getPath('documents'), '抖音直播录制工具V2', 'logs');
        this.logFile = this._getLogFilePath();
        this._initialized = true;
        
        // 执行初始化
        this.init();
      } catch (err) {
        console.error('Logger initialization failed:', err);
      }
    })();
    
    return this._initPromise;
  }

  /**
   * 获取当前日期字符串 (YYYY-MM-DD)
   */
  _getDateStr(date = new Date()) {
    return date.toISOString().split('T')[0];
  }

  /**
   * 获取日志文件路径（按日期命名）
   */
  _getLogFilePath(date = this.currentDate) {
    return path.join(this.logDir, `app-${date}.log`);
  }

  /**
   * 初始化日志系统
   */
  init() {
    try {
      // 确保日志目录存在
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }

      // 确保自动备份目录存在
      if (!fs.existsSync(this.autoBackupDir)) {
        fs.mkdirSync(this.autoBackupDir, { recursive: true });
      }

      // 检查是否需要轮转日志（日期变化）
      this._checkRotation();

      // 注册崩溃处理
      this._registerCrashHandlers();

      // 启动定时刷新
      this._startFlushTimer();

      this.write('INFO', 'Logger initialized');
      this.write('INFO', `App version: ${app.getVersion()}`);
      this.write('INFO', `Electron: ${process.versions.electron}`);
      this.write('INFO', `Node: ${process.versions.node}`);
      this.write('INFO', `OS: ${process.platform} ${process.arch}`);
      this.write('INFO', `Log directory: ${this.logDir}`);
      this.write('INFO', `Auto backup directory: ${this.autoBackupDir}`);
    } catch (err) {
      console.error('Failed to initialize logger:', err);
    }
  }

  /**
   * 检查是否需要轮转日志
   */
  _checkRotation() {
    const today = this._getDateStr();
    if (today !== this.currentDate) {
      this.currentDate = today;
      this.logFile = this._getLogFilePath(today);
      this.write('INFO', `Log rotated to ${this.logFile}`);
      
      // 备份昨天的日志到自动备份目录
      this._backupYesterdayLog();
    }
  }

  /**
   * 备份昨天的日志到自动备份目录
   */
  _backupYesterdayLog() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = this._getDateStr(yesterday);
      const yesterdayLogFile = this._getLogFilePath(yesterdayStr);
      
      if (fs.existsSync(yesterdayLogFile)) {
        const backupFile = path.join(this.autoBackupDir, `app-${yesterdayStr}.log`);
        fs.copyFileSync(yesterdayLogFile, backupFile);
        this.write('INFO', `Backed up yesterday's log to ${backupFile}`);
      }
    } catch (err) {
      console.error('Failed to backup yesterday log:', err);
    }
  }

  /**
   * 注册崩溃处理
   * 注意：uncaughtException/unhandledRejection 已在 main.js 中处理
   * 这里只注册 SIGTERM/SIGINT 和 Electron 事件
   */
  _registerCrashHandlers() {
    // 处理进程退出信号
    process.on('SIGTERM', () => {
      this.write('INFO', 'Received SIGTERM signal, shutting down...');
      this._flushSync();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      this.write('INFO', 'Received SIGINT signal, shutting down...');
      this._flushSync();
      process.exit(0);
    });
  }

  /**
   * 保存崩溃转储
   */
  _saveCrashDump(type, err) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const crashFile = path.join(this.logDir, `crash-${timestamp}.log`);
      
      let content = `=== CRASH DUMP ===\n`;
      content += `Time: ${new Date().toISOString()}\n`;
      content += `Type: ${type}\n`;
      content += `Error: ${err?.message || String(err)}\n`;
      content += `Stack: ${err?.stack || 'N/A'}\n`;
      content += `\n=== RECENT LOGS ===\n`;
      content += this.getRecentLogs(200);
      
      fs.writeFileSync(crashFile, content, 'utf8');
      
      // 同时复制到自动备份目录
      const backupCrashFile = path.join(this.autoBackupDir, `crash-${timestamp}.log`);
      fs.copyFileSync(crashFile, backupCrashFile);
      
      console.error(`Crash dump saved to: ${crashFile}`);
    } catch (e) {
      console.error('Failed to save crash dump:', e);
    }
  }

  /**
   * 启动定时刷新
   */
  _startFlushTimer() {
    setInterval(() => {
      this._flush();
    }, this.flushInterval);
  }

  /**
   * 刷新日志缓冲区
   */
  _flush() {
    if (this.logBuffer.length === 0) return;
    
    try {
      // 确保已初始化
      if (!this._initialized) {
        this._ensureInitialized().catch(err => {
          console.error('Logger flush initialization failed:', err);
        });
        return; // 如果未初始化，跳过本次刷新
      }
      
      const content = this.logBuffer.join('');
      this.logBuffer = [];
      
      // 检查日期是否变化
      this._checkRotation();
      
      fs.appendFileSync(this.logFile, content, 'utf8');
      
      // 检查文件大小，超过限制则轮转
      const stats = fs.statSync(this.logFile);
      if (stats.size > this.maxSize) {
        this._rotateCurrentLog();
      }
    } catch (err) {
      console.error('Failed to flush log buffer:', err);
    }
  }

  /**
   * 同步刷新日志缓冲区（用于崩溃时）
   */
  _flushSync() {
    if (this.logBuffer.length === 0) return;
    
    try {
      const content = this.logBuffer.join('');
      this.logBuffer = [];
      fs.appendFileSync(this.logFile, content, 'utf8');
    } catch (err) {
      console.error('Failed to flush log buffer sync:', err);
    }
  }

  /**
   * 公开方法：立即刷新日志缓冲区到磁盘
   */
  flush() {
    this._flushSync();
  }

  /**
   * 轮转当前日志文件
   */
  _rotateCurrentLog() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedFile = path.join(this.logDir, `app-${this.currentDate}-${timestamp}.log`);
      fs.renameSync(this.logFile, rotatedFile);
      this.write('INFO', `Log file rotated to ${rotatedFile}`);
    } catch (err) {
      console.error('Failed to rotate log:', err);
    }
  }

  formatMessage(level, message, meta) {
    const timestamp = new Date().toISOString();
    let formatted = `[${timestamp}] [${level}] ${message}`;
    
    if (meta) {
      if (meta instanceof Error) {
        formatted += `\n  Stack: ${meta.stack}`;
      } else if (typeof meta === 'object') {
        formatted += `\n  Data: ${JSON.stringify(meta, null, 2)}`;
      } else {
        formatted += `\n  ${meta}`;
      }
    }
    
    return formatted + '\n';
  }

  write(level, message, meta) {
    try {
      // 确保已初始化
      if (!this._initialized) {
        this._ensureInitialized();
      }
      
      const formatted = this.formatMessage(level, message, meta);
      this.logBuffer.push(formatted);
      
      // 如果是错误级别，立即刷新
      if (level === 'ERROR' || level === 'FATAL') {
        this._flush();
      }
    } catch (err) {
      console.error('Failed to write log:', err);
    }
  }

  info(message, meta) {
    this.write('INFO', message, meta);
  }

  warn(message, meta) {
    this.write('WARN', message, meta);
  }

  error(message, meta) {
    this.write('ERROR', message, meta);
    // 同时输出到控制台
    console.error(message, meta);
  }

  debug(message, meta) {
    this.write('DEBUG', message, meta);
  }

  fatal(message, meta) {
    this.write('FATAL', message, meta);
    this._flushSync();
  }

  /**
   * 获取日志文件路径
   */
  getLogPath() {
    return this.logFile;
  }

  /**
   * 获取日志目录路径
   */
  getLogDir() {
    return this.logDir;
  }

  /**
   * 获取自动备份目录路径
   */
  getAutoBackupDir() {
    return this.autoBackupDir;
  }

  /**
   * 设置日志目录路径
   */
  setLogDir(dir) {
    this.logDir = dir;
    this.logFile = this._getLogFilePath();
    // 确保新目录存在
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * 获取日志文件大小
   */
  getLogSize() {
    try {
      if (!fs.existsSync(this.logFile)) return 0;
      const stats = fs.statSync(this.logFile);
      return stats.size;
    } catch (err) {
      return 0;
    }
  }

  /**
   * 获取所有日志文件列表
   */
  getLogFiles() {
    try {
      if (!this.logDir || !fs.existsSync(this.logDir)) {
        return [];
      }
      const files = fs.readdirSync(this.logDir);
      return files
        .filter(f => f.startsWith('app-') && f.endsWith('.log'))
        .sort()
        .reverse()
        .map(f => ({
          name: f,
          path: path.join(this.logDir, f),
          size: fs.statSync(path.join(this.logDir, f)).size,
          date: f.match(/app-(\d{4}-\d{2}-\d{2})/)?.[1] || 'unknown'
        }));
    } catch (err) {
      return [];
    }
  }

  /**
   * 获取日志统计信息
   */
  getStats() {
    try {
      const content = this.getRecentLogs(10000);
      const lines = content.split('\n');
      let errorCount = 0;
      let warnCount = 0;
      let infoCount = 0;
      lines.forEach(line => {
        if (line.includes('[ERROR]')) errorCount++;
        else if (line.includes('[WARN]')) warnCount++;
        else if (line.includes('[INFO]')) infoCount++;
      });
      return {
        totalLines: lines.length,
        errorCount,
        warnCount,
        infoCount,
        fileSize: this.getLogSize(),
        logFiles: this.getLogFiles().length
      };
    } catch (err) {
      return { totalLines: 0, errorCount: 0, warnCount: 0, infoCount: 0, fileSize: 0, logFiles: 0 };
    }
  }

  /**
   * 读取最近的日志内容
   */
  getRecentLogs(lines = 100) {
    try {
      if (!fs.existsSync(this.logFile)) {
        return 'No log file found.';
      }
      
      const content = fs.readFileSync(this.logFile, 'utf8');
      const allLines = content.split('\n');
      return allLines.slice(-lines).join('\n');
    } catch (err) {
      return `Failed to read log: ${err.message}`;
    }
  }

  /**
   * 读取指定日期的日志
   */
  getLogsByDate(dateStr) {
    try {
      const logFile = this._getLogFilePath(dateStr);
      if (!fs.existsSync(logFile)) {
        return `No log file found for date ${dateStr}`;
      }
      return fs.readFileSync(logFile, 'utf8');
    } catch (err) {
      return `Failed to read log: ${err.message}`;
    }
  }

  /**
   * 导出所有日志到指定路径
   */
  exportLogs(targetPath) {
    try {
      const logFiles = this.getLogFiles();
      const exportDir = path.join(targetPath, `logs-export-${this._getDateStr()}`);
      
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }
      
      logFiles.forEach(file => {
        fs.copyFileSync(file.path, path.join(exportDir, file.name));
      });
      
      return exportDir;
    } catch (err) {
      this.error('Failed to export logs', err);
      return null;
    }
  }

  /**
   * 合并导出「当天日志 + 全部历史备份日志」为一个文件
   * 解决旧版导出仅包含当天日志、无法获取历史日志的问题。
   * 优先从自动备份目录(autoBackupDir)读取历史，其次回退到 logDir 按日期文件。
   * @param {string} targetFile - 目标导出文件路径(单文件合并)
   * @returns {Promise<string|null>} 合并后文件路径；失败返回 null
   */
  async exportCombinedLogs(targetFile) {
    try {
      if (!this.autoBackupDir && !this.logDir) {
        this.error('Failed to export combined logs: no log dir configured');
        return null;
      }

      // 收集所有日志文件: 自动备份目录 + 当天日志目录
      const seenByName = new Set();
      const sources = [];

      const collectDir = (dir) => {
        if (!dir || !fs.existsSync(dir)) return;
        let names = [];
        try { names = fs.readdirSync(dir); } catch (_) { return; }
        names
          .filter(f => f.startsWith('app-') && f.endsWith('.log'))
          .sort() // 按日期升序
          .forEach(f => {
            // 按文件名去重（同一 app-日期.log 在自动备份目录与 logDir 各有一份同内容副本）
            if (seenByName.has(f)) return;
            seenByName.add(f);
            sources.push({ full: path.join(dir, f), name: f });
          });
      };

      // 历史日志优先走自动备份目录(更完整、不易被清理)
      collectDir(this.autoBackupDir);
      // 再补充 logDir(含当天，可能含备份目录没有的最新文件)
      collectDir(this.logDir);

      if (sources.length === 0) {
        this.warn('No log files found for combined export');
        return null;
      }

      // 流式逐行写入并过滤高频监控噪声，控制导出文件体积
      // 历史日志 99% 是监控采样，合并导出曾达 1.6GB，无法用于排查。
      // 过滤策略：纯心跳噪声直接丢弃；直播状态轮询按房间状态去重（仅在状态变化时保留），保留排查价值。
      const readline = require('readline');
      // 高频监控噪声（实测占日志约99%）：匹配后按"日期+去时间戳内容"去重，每天每种仅保留首条样本，
      // 既大幅减小体积，又保留"当日监控确在运行/状态曾变化"的排查线索。
      const NOISE_PATTERNS = [
        /\[Monitor\] 检查直播状态/,   // 直播状态轮询（每30秒×房间）
        /updateStatusBadges/,          // 角标刷新
        /推送状态更新到 UI/,            // UI 状态推送
        /notifyUpdate: 推送状态更新/,
        /notifyUpdate: 推送 \d+ 个直播间/,
      ];
      const seenNoise = new Set();
      const stripTs = (line) => line.replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();

      const out = fs.createWriteStream(targetFile, { encoding: 'utf8' });
      let keptLines = 0, filteredLines = 0;

      for (const s of sources) {
        if (!fs.existsSync(s.full)) continue;
        if (!out.write(`\n========== 日志文件: ${s.name} ==========\n`)) {
          await new Promise(r => out.once('drain', r));
        }
        const rl = readline.createInterface({
          input: fs.createReadStream(s.full, { encoding: 'utf8' }),
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          // 高频噪声：按"日期+去时间戳内容"去重，每种仅保留首条样本
          if (NOISE_PATTERNS.some(re => re.test(line))) {
            const key = `${s.name}|${stripTs(line)}`;
            if (seenNoise.has(key)) { filteredLines++; continue; }
            seenNoise.add(key);
          }
          if (!out.write(line + '\n')) {
            await new Promise(r => out.once('drain', r));
          }
          keptLines++;
        }
      }
      await new Promise((resolve, reject) => { out.end(err => (err ? reject(err) : resolve())); });

      const totalBytes = fs.statSync(targetFile).size;
      this.info(`Exported combined logs to ${targetFile} (${sources.length} files, kept ${keptLines} lines, filtered ${filteredLines} noise lines, ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
      return targetFile;
    } catch (err) {
      this.error('Failed to export combined logs', err);
      return null;
    }
  }

  /**
   * 设置自动轮转和清理
   * @param {number} retentionDays - 保留天数，默认30天
   */
  setupAutoRotation(retentionDays = 30) {
    this.retentionDays = retentionDays;
    
    // 延迟清理，等待初始化完成
    this._ensureInitialized().then(() => {
      // 启动时立即清理一次旧日志
      this._cleanupOldLogs();
      
      // 每小时检查一次是否需要清理
      this._cleanupTimer = setInterval(() => {
        this._cleanupOldLogs();
      }, 60 * 60 * 1000); // 1小时
      
      this.info(`Auto rotation setup: retention=${retentionDays} days`);
    }).catch(err => {
      console.error('Failed to setup auto rotation:', err);
    });
  }

  /**
   * 清理过期日志文件
   */
  _cleanupOldLogs() {
    try {
      if (!this.logDir || !fs.existsSync(this.logDir)) {
        return; // 日志目录不存在，跳过清理
      }
      const logFiles = this.getLogFiles();
      const now = Date.now();
      const retentionMs = (this.retentionDays || 30) * 24 * 60 * 60 * 1000;
      
      logFiles.forEach(file => {
        const fileDate = new Date(file.date);
        if (isNaN(fileDate.getTime())) return;
        
        const fileAge = now - fileDate.getTime();
        if (fileAge > retentionMs) {
          fs.unlinkSync(file.path);
          this.info(`Deleted old log file: ${file.name} (age: ${Math.floor(fileAge / (24 * 60 * 60 * 1000))} days)`);
        }
      });
    } catch (err) {
      console.error('Failed to cleanup old logs:', err);
    }
  }

  /**
   * 清空日志
   */
  clear() {
    try {
      fs.writeFileSync(this.logFile, '', 'utf8');
      this.write('INFO', 'Log cleared');
      return true;
    } catch (err) {
      this.error('Failed to clear log', err);
      return false;
    }
  }
}

// 创建单例
let loggerInstance = null;

function getLogger() {
  if (!loggerInstance) {
    loggerInstance = new Logger();
  }
  return loggerInstance;
}

module.exports = { getLogger };
