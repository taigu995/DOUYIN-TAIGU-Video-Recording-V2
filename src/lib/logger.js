/**
 * Logger - 错误日志输出模块
 * 将错误和关键信息写入日志文件，便于问题排查
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Logger {
  constructor() {
    this.logDir = path.join(app.getPath('userData'), 'logs');
    this.logFile = path.join(this.logDir, 'app.log');
    this.maxSize = 5 * 1024 * 1024; // 5MB max log size
    this.init();
  }

  init() {
    try {
      // 确保日志目录存在
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }

      // 检查日志文件大小，超过限制则轮转
      if (fs.existsSync(this.logFile)) {
        const stats = fs.statSync(this.logFile);
        if (stats.size > this.maxSize) {
          this.rotate();
        }
      }

      this.write('INFO', 'Logger initialized');
      this.write('INFO', `App version: ${app.getVersion()}`);
      this.write('INFO', `Electron: ${process.versions.electron}`);
      this.write('INFO', `Node: ${process.versions.node}`);
      this.write('INFO', `OS: ${process.platform} ${process.arch}`);
    } catch (err) {
      console.error('Failed to initialize logger:', err);
    }
  }

  rotate() {
    try {
      const backupFile = path.join(this.logDir, 'app.log.bak');
      if (fs.existsSync(backupFile)) {
        fs.unlinkSync(backupFile);
      }
      fs.renameSync(this.logFile, backupFile);
      this.write('INFO', 'Log file rotated');
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
      const formatted = this.formatMessage(level, message, meta);
      fs.appendFileSync(this.logFile, formatted, 'utf8');
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
        fileSize: this.getLogSize()
      };
    } catch (err) {
      return { totalLines: 0, errorCount: 0, warnCount: 0, infoCount: 0, fileSize: 0 };
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
