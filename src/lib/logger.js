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
        
        this.logDir = path.join(app.getPath('userData'), 'logs');
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

      // 清理旧日志
      this._cleanupOldLogs();

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
   * 清理旧日志（保留最近 keepDays 天）
   */
  _cleanupOldLogs() {
    try {
      const files = fs.readdirSync(this.logDir);
      const logFiles = files.filter(f => f.startsWith('app-') && f.endsWith('.log'));
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.keepDays);
      const cutoffStr = this._getDateStr(cutoffDate);
      
      logFiles.forEach(file => {
        const match = file.match(/app-(\d{4}-\d{2}-\d{2})\.log/);
        if (match) {
          const fileDate = match[1];
          if (fileDate < cutoffStr) {
            const filePath = path.join(this.logDir, file);
            fs.unlinkSync(filePath);
            console.log(`Deleted old log file: ${file}`);
          }
        }
      });

      // 同时清理自动备份目录的旧日志
      if (fs.existsSync(this.autoBackupDir)) {
        const backupFiles = fs.readdirSync(this.autoBackupDir);
        const backupLogFiles = backupFiles.filter(f => f.startsWith('app-') && f.endsWith('.log'));
        
        backupLogFiles.forEach(file => {
          const match = file.match(/app-(\d{4}-\d{2}-\d{2})\.log/);
          if (match) {
            const fileDate = match[1];
            if (fileDate < cutoffStr) {
              const filePath = path.join(this.autoBackupDir, file);
              fs.unlinkSync(filePath);
              console.log(`Deleted old backup log file: ${file}`);
            }
          }
        });
      }
    } catch (err) {
      console.error('Failed to cleanup old logs:', err);
    }
  }

  /**
   * 注册崩溃处理
   */
  _registerCrashHandlers() {
    // 处理未捕获的异常
    process.on('uncaughtException', (err) => {
      this.write('FATAL', 'Uncaught Exception', err);
      this._flushSync();
      this._saveCrashDump('uncaughtException', err);
      console.error('Uncaught Exception:', err);
      // 给一点时间让日志写入完成
      setTimeout(() => process.exit(1), 1000);
    });

    // 处理未处理的 Promise 拒绝
    process.on('unhandledRejection', (reason, promise) => {
      this.write('ERROR', 'Unhandled Rejection at Promise', { reason: String(reason) });
      this._flushSync();
      console.error('Unhandled Rejection at Promise:', promise, 'reason:', reason);
    });

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

    // Electron 崩溃处理
    if (app) {
      app.on('before-quit', () => {
        this.write('INFO', 'App is about to quit, flushing logs...');
        this._flushSync();
      });

      app.on('window-all-closed', () => {
        this.write('INFO', 'All windows closed');
        this._flushSync();
      });
    }
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
      if (!this.initialized) {
        this._ensureInitialized();
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
      if (!this.initialized) {
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
