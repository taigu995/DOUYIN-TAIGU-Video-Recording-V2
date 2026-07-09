/**
 * 手动合并工具 - 独立于直播间管理的合并功能
 * 允许用户手动选择视频文件和评论区帧目录进行合并
 */

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getFFmpegPath } = require('./recorder');
const logger = require('./logger');

class ManualMerger {
  constructor() {
    this.currentProcess = null;
    this.isMerging = false;
    this.onProgress = null;
    this.onStatusChange = null;
  }

  /**
   * 探测视频文件信息
   */
  probeVideoInfo(filePath) {
    try {
      execFileSync(getFFmpegPath(), ['-i', filePath], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true
      });
    } catch (e) {
      const errOutput = e.stderr || e.stdout || e.message || '';
      
      // 解析分辨率
      const resMatch = errOutput.match(/Video:[\s\S]*?(\d{2,5})x(\d{2,5})/);
      const width = resMatch ? parseInt(resMatch[1]) : 1920;
      const height = resMatch ? parseInt(resMatch[2]) : 1080;
      
      // 解析时长
      const durationMatch = errOutput.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      let durationMs = 0;
      if (durationMatch) {
        durationMs = (
          parseInt(durationMatch[1]) * 3600000 +
          parseInt(durationMatch[2]) * 60000 +
          parseInt(durationMatch[3]) * 1000 +
          parseInt(durationMatch[4]) * 10
        );
      }
      
      return { width, height, durationMs };
    }
    return { width: 1920, height: 1080, durationMs: 0 };
  }

  /**
   * 统计评论区帧数量和帧率
   */
  analyzeCommentFrames(framesDir) {
    if (!fs.existsSync(framesDir)) {
      throw new Error('评论区帧目录不存在');
    }

    const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg') || f.endsWith('.jpeg'));
    if (frames.length === 0) {
      throw new Error('评论区帧目录为空');
    }

    // 尝试从目录名或文件中读取帧率信息
    // 默认使用 5fps 作为估计值
    let fps = 5;
    
    // 尝试读取 config.json 获取实际帧率
    const configPath = path.join(path.dirname(framesDir), 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.commentFps) {
          fps = config.commentFps;
        }
      } catch (e) { /* ignore */ }
    }

    // 尝试从 progress.json 读取帧率
    const progressPath = path.join(path.dirname(framesDir), 'merge_progress.json');
    if (fs.existsSync(progressPath)) {
      try {
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
        if (progress.fps) {
          fps = progress.fps;
        }
      } catch (e) { /* ignore */ }
    }

    const frameCount = frames.length;
    const durationMs = Math.round((frameCount / fps) * 1000);

    return { frameCount, fps, durationMs };
  }

  /**
   * 执行合并
   * @param {Object} options
   * @param {string} options.videoFile - 直播流视频文件路径
   * @param {string} options.commentFramesDir - 评论区帧目录路径
   * @param {string} options.outputFile - 输出文件路径
   * @param {Function} options.onProgress - 进度回调
   * @param {Function} options.onStatusChange - 状态变更回调
   */
  async merge(options) {
    const { videoFile, commentFramesDir, outputFile, onProgress, onStatusChange } = options;

    if (this.isMerging) {
      throw new Error('已有合并任务正在进行');
    }

    this.isMerging = true;
    this.onProgress = onProgress || (() => {});
    this.onStatusChange = onStatusChange || (() => {});

    try {
      // 验证输入文件
      if (!fs.existsSync(videoFile)) {
        throw new Error('视频文件不存在');
      }
      if (!fs.existsSync(commentFramesDir)) {
        throw new Error('评论区帧目录不存在');
      }

      // 分析输入
      this.onStatusChange('analyzing', '分析输入文件...');
      const videoInfo = this.probeVideoInfo(videoFile);
      const commentInfo = this.analyzeCommentFrames(commentFramesDir);

      logger.info(`[ManualMerger] 视频: ${videoInfo.width}x${videoInfo.height}, 时长: ${videoInfo.durationMs}ms`);
      logger.info(`[ManualMerger] 评论帧: ${commentInfo.frameCount} 帧, ${commentInfo.fps}fps, 时长: ${commentInfo.durationMs}ms`);

      // 确保输出目录存在
      const outputDir = path.dirname(outputFile);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 阶段1: 编码评论区帧为视频
      const tempDir = path.join(outputDir, '.temp_manual');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const commentVideoPath = path.join(tempDir, 'comment_video.mp4');
      
      this.onStatusChange('encoding_comments', '编码评论区视频...');
      await this._runFFmpeg(
        commentVideoPath,
        [
          '-f', 'image2',
          '-framerate', String(commentInfo.fps),
          '-start_number', '0',
          '-i', path.join(commentFramesDir, 'frame_%06d.jpg'),
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-preset', 'fast',
          '-crf', '15',
          '-vf', `scale=420:${videoInfo.height}`,
          '-y',
          commentVideoPath
        ],
        'Merge-Comment',
        commentInfo.durationMs,
        '编码评论区'
      );

      // 阶段2: 合并视频
      this.onStatusChange('merging', '合并视频与评论区...');
      
      // 构建滤镜链
      const filterComplex = [
        `[0:v]scale=${videoInfo.width}:${videoInfo.height},setsar=1[stream]`,
        `[1:v]scale=420:${videoInfo.height},setsar=1[comments]`,
        `[stream]pad=${videoInfo.width + 420 + 2}:${videoInfo.height}:0:0:black[stream_padded]`,
        `[stream_padded]drawbox=x=${videoInfo.width}:y=0:w=2:h=${videoInfo.height}:color=black@0.5:t=fill[stream_sep]`,
        `[stream_sep][comments]overlay=${videoInfo.width + 2}:0:shortest=1[out]`
      ].join(';');

      await this._runFFmpeg(
        outputFile,
        [
          '-i', videoFile,
          '-i', commentVideoPath,
          '-filter_complex', filterComplex,
          '-map', '[out]',
          '-map', '0:a?',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '15',
          '-c:a', 'copy',
          '-movflags', '+faststart',
          '-y',
          outputFile
        ],
        'Merge-Final',
        videoInfo.durationMs || commentInfo.durationMs,
        '合并视频'
      );

      // 清理临时文件
      try {
        fs.unlinkSync(commentVideoPath);
        fs.rmdirSync(tempDir, { recursive: true });
      } catch (e) {
        logger.warn('[ManualMerger] 清理临时文件失败:', e.message);
      }

      const outputSize = fs.existsSync(outputFile) ? fs.statSync(outputFile).size : 0;
      
      this.onStatusChange('completed', '合并完成');
      logger.info(`[ManualMerger] 合并完成: ${outputFile}, 大小: ${outputSize} bytes`);

      return {
        success: true,
        outputFile,
        outputSize,
        commentFrames: commentInfo.frameCount
      };

    } catch (err) {
      logger.error('[ManualMerger] 合并失败:', err.message);
      this.onStatusChange('failed', `合并失败: ${err.message}`);
      
      // 清理临时文件
      try {
        const tempDir = path.join(path.dirname(outputFile), '.temp_manual');
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (e) { /* ignore */ }

      throw err;
    } finally {
      this.isMerging = false;
      this.currentProcess = null;
    }
  }

  /**
   * 取消当前合并
   */
  cancel() {
    if (this.currentProcess) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /PID ${this.currentProcess.pid} /T`, { stdio: 'ignore' });
        } else {
          this.currentProcess.kill('SIGKILL');
        }
      } catch (e) { /* ignore */ }
      this.currentProcess = null;
      this.isMerging = false;
      this.onStatusChange('cancelled', '合并已取消');
    }
  }

  /**
   * 运行 FFmpeg 命令
   */
  _runFFmpeg(outputFile, args, tag, totalDurationMs, phaseName) {
    return new Promise((resolve, reject) => {
      const ffmpegPath = getFFmpegPath();
      logger.info(`[${tag}] 启动: ${ffmpegPath} ${args.join(' ')}`);

      const proc = spawn(ffmpegPath, args, {
        windowsHide: true
      });

      this.currentProcess = proc;

      let stderr = '';
      let lastProgressTime = 0;

      // 进度解析函数
      const parseProgress = (msg) => {
        if (totalDurationMs > 0 && phaseName) {
          const timeMatch = msg.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
          if (timeMatch) {
            const currentTimeMs = (
              parseInt(timeMatch[1]) * 3600000 +
              parseInt(timeMatch[2]) * 60000 +
              parseInt(timeMatch[3]) * 1000 +
              parseInt(timeMatch[4]) * 10
            );

            const progress = Math.min(100, Math.round((currentTimeMs / totalDurationMs) * 100));
            const now = Date.now();

            if (now - lastProgressTime > 500) {
              lastProgressTime = now;
              this.onProgress({
                phase: phaseName,
                phaseName,
                progress,
                currentTime: currentTimeMs,
                totalDuration: totalDurationMs
              });
            }
          }
        }
      };

      proc.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          logger.info(`[${tag}] ${msg}`);
          parseProgress(msg);
        }
      });

      proc.stderr.on('data', (data) => {
        const msg = data.toString();
        stderr += msg;
        const trimmed = msg.trim();
        if (trimmed) {
          logger.info(`[${tag}] ${trimmed}`);
          parseProgress(trimmed);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          logger.info(`[${tag}] 完成`);
          resolve();
        } else {
          logger.error(`[${tag}] 退出码: ${code}`);
          reject(new Error(`${tag} 失败, exit code: ${code}`));
        }
      });

      proc.on('error', (err) => {
        logger.error(`[${tag}] 进程错误:`, err);
        reject(err);
      });

      // 动态超时
      const effectiveTimeout = totalDurationMs > 0 ? totalDurationMs + 300000 : 600000;
      const timeoutMinutes = Math.round(effectiveTimeout / 60000);
      logger.info(`[${tag}] 超时保护: ${timeoutMinutes} 分钟`);

      setTimeout(() => {
        if (proc.exitCode === null) {
          logger.warn(`[${tag}] 超时(${timeoutMinutes}分钟)，强制终止`);
          try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
          reject(new Error(`${tag} 超时`));
        }
      }, effectiveTimeout);
    });
  }
}

module.exports = ManualMerger;
