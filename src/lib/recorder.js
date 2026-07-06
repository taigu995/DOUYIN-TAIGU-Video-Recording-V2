/**
 * 录制引擎模块 (v2 - 流媒体直录 + 评论区拼接)
 *
 * 架构：
 *   Phase 1 (录制中):
 *     - FFmpeg 直接录制直播流 (stream copy) → temp_stream.mp4 (高质量音视频)
 *     - Electron 离屏窗口仅渲染右侧评论区 → JPEG 帧序列
 *   Phase 2 (录制结束后):
 *     - FFmpeg overlay 拼接: 左侧直播画面 + 右侧评论区 → 最终 MP4
 *
 * 布局: [Stream 1280x720 | Comment 360x720] = 1640x720
 */
const { spawn, execSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs');
const { generateFileName } = require('./douyin-utils');
const { getConfig } = require('./config');
const { getLogger } = require('./logger');
const { CommentRenderer, COMMENT_WIDTH, COMMENT_HEIGHT } = require('./comment-renderer');

const logger = getLogger();

// 主视频分辨率
const STREAM_WIDTH = 1280;
const STREAM_HEIGHT = 720;

// 获取 FFmpeg 可执行文件路径（处理 asar 打包情况）
function getFFmpegPath() {
  let ffmpegPath = ffmpegInstaller.path;

  if (ffmpegPath.includes('app.asar') && !ffmpegPath.includes('app.asar.unpacked')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }

  if (!fs.existsSync(ffmpegPath)) {
    logger.error(`FFmpeg 路径不存在: ${ffmpegPath}`);
    const appDir = path.dirname(process.execPath);
    const possiblePaths = [
      path.join(appDir, 'resources', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'ffmpeg'),
      path.join(appDir, 'resources', 'app', 'node_modules', '@ffmpeg-installer', 'ffmpeg')
    ];

    for (const p of possiblePaths) {
      try {
        const altPath = require(path.join(p, 'package.json'));
        if (altPath && altPath.path) {
          const resolved = path.resolve(p, altPath.path);
          if (fs.existsSync(resolved)) {
            logger.info(`找到备用 FFmpeg 路径: ${resolved}`);
            return resolved;
          }
        }
      } catch (e) { /* ignore */ }
    }
  }

  logger.info(`FFmpeg 路径: ${ffmpegPath}`);
  return ffmpegPath;
}

const ffmpegPath = getFFmpegPath();
ffmpeg.setFfmpegPath(ffmpegPath);

class Recorder {
  constructor(options) {
    this.roomId = options.roomId;
    this.streamerName = options.streamerName || '未知主播';
    this.liveUrl = options.liveUrl;
    this.outputFolder = options.outputFolder;
    this.session = options.session;

    this.recording = false;
    this.ffmpegProcess = null;
    this.commentRenderer = null;
    this.outputFile = '';
    this.startTime = null;
    this.hasAudio = false;

    // 临时文件路径
    this._tempDir = '';
    this._tempStreamFile = '';
    this._commentFramesDir = '';

    // 状态
    this._streamUrl = null;
    this._mergeResult = null;
    this._lastRecordingResult = null;

    this.onStatusChange = options.onStatusChange || (() => {});
    this.onError = options.onError || (() => {});
  }

  /**
   * 开始录制
   */
  async startRecording() {
    if (this.recording) {
      throw new Error(`录制引擎已在运行中 (room: ${this.roomId})`);
    }

    logger.info(`[Recorder] 准备开始录制 - 房间: ${this.roomId}, 主播: ${this.streamerName}`);

    try {
      const config = getConfig();
      const baseOutputFolder = this.outputFolder || config.outputFolder || this.getDefaultOutputFolder();

      // 创建输出目录结构
      const streamerFolder = path.join(baseOutputFolder, this.streamerName);
      const now = new Date();
      this.startTime = now;
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const timeStrFull = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const timeStrShort = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
      const safeName = (this.streamerName || '未知主播').replace(/[<>:"/\\|?*]/g, '_');

      // 会话文件夹: [主播名称][年-月-日][时-分-秒]
      const sessionFolder = path.join(streamerFolder, `[${safeName}][${dateStr}][${timeStrFull}]`);
      if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, { recursive: true });
      }

      // 最终输出文件
      const fileName = `[${safeName}][${dateStr}][${timeStrShort}]`;
      this.outputFile = path.join(sessionFolder, `${fileName}.${config.fileFormat || 'mp4'}`);

      // 创建临时目录
      this._tempDir = path.join(sessionFolder, '.temp');
      this._tempStreamFile = path.join(this._tempDir, 'stream.mp4');
      this._commentFramesDir = path.join(this._tempDir, 'comments');
      fs.mkdirSync(this._tempDir, { recursive: true });
      fs.mkdirSync(this._commentFramesDir, { recursive: true });

      logger.info(`[Recorder] 输出文件: ${this.outputFile}`);
      logger.info(`[Recorder] 临时目录: ${this._tempDir}`);

      // Step 1: 初始化评论区渲染器（加载直播页面，共享登录态）
      logger.info('[Recorder] 初始化评论区渲染器...');
      this.commentRenderer = new CommentRenderer({
        liveUrl: this.liveUrl,
        roomId: this.roomId,
        session: this.session,
        outputDir: this._commentFramesDir,
        fps: Math.min(config.fps || 10, 15)
      });
      await this.commentRenderer.init();

      // Step 2: 从页面上下文中提取直播流URL（利用已加载的页面和登录态）
      // 将评论区窗口设为 captureWindow，供 _extractStreamUrl 的页面fetch方式使用
      this.captureWindow = this.commentRenderer.captureWindow;
      logger.info('[Recorder] 正在获取直播流URL...');
      const streamInfo = await this._extractStreamUrl();

      if (!streamInfo || !streamInfo.url) {
        throw new Error('无法获取直播流URL，请确保已登录抖音且直播间正在直播');
      }

      this._streamUrl = streamInfo.url;
      logger.info(`[Recorder] 获取到直播流: ${streamInfo.type}, 来源: ${streamInfo.source}`);

      // Step 3: 启动 FFmpeg 录制直播流 (stream copy)
      logger.info('[Recorder] 启动 FFmpeg 流媒体直录...');
      this._startStreamRecording();

      // Step 4: 开始评论区帧捕获
      this.commentRenderer.startCapture();

      // 录制状态 - 计时器将在 FFmpeg 输出第一帧时启动
      this.recording = true;
      this.hasAudio = true;
      this._firstFrameReceived = false;

      logger.info(`[Recorder] FFmpeg 已启动，等待第一帧输出...`);
    } catch (err) {
      logger.error(`[Recorder] 启动录制失败: ${err.message}`, err);
      this.recording = false;
      await this._cleanup();
      this.onStatusChange('error', {
        roomId: this.roomId,
        error: err.message
      });
      throw err;
    }
  }

  /**
   * 启动 FFmpeg 流媒体直录（stream copy，保留原始音视频质量）
   */
  _startStreamRecording() {
    const resolvedPath = getFFmpegPath();

    const args = [
      // 网络超时设置
      '-rw_timeout', '10000000',
      '-timeout', '10000000',
      // 输入: 直播流
      '-i', this._streamUrl,
      // 输出: stream copy（不重新编码）
      '-c', 'copy',
      '-movflags', '+faststart',
      '-avoid_negative_ts', 'make_zero',
      '-y',
      this._tempStreamFile
    ];

    logger.info(`[Recorder] FFmpeg 命令: ${resolvedPath} ${args.join(' ').substring(0, 200)}...`);

    this.ffmpegProcess = spawn(resolvedPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.ffmpegProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) logger.info(`[FFmpeg-Stream] ${msg}`);
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) logger.info(`[FFmpeg-Stream] ${msg}`);

      // 检测第一帧输出，此时才真正开始录制和计时
      if (!this._firstFrameReceived && /frame=\s*\d+/.test(msg)) {
        this._firstFrameReceived = true;
        this.startTime = new Date(); // 从第一帧开始计时
        logger.info(`[Recorder] 录制实际开始（第一帧已输出）: ${this.streamerName} -> ${this.outputFile}`);
        this.onStatusChange('recording', {
          roomId: this.roomId,
          streamerName: this.streamerName,
          outputFile: this.outputFile,
          startTime: this.startTime,
          hasAudio: this.hasAudio,
          mode: 'stream+comment'
        });
      }
    });

    this.ffmpegProcess.on('close', (code) => {
      logger.info(`[FFmpeg-Stream] 进程退出, code: ${code}`);
      this.ffmpegProcess = null;

      // 如果仍在录制中，流中断意味着录制结束
      if (this.recording) {
        logger.warn('[Recorder] 直播流中断，录制自动结束');
        this.recording = false;
        this._finishRecording().catch(err => {
          logger.error('[Recorder] 完成录制出错:', err.message);
        });
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      logger.error('[FFmpeg-Stream] 进程错误:', err);
      this.onError(this.roomId, err);
    });
  }

  /**
   * 停止录制
   */
  async stopRecording() {
    if (!this.recording) return;

    this.recording = false;
    logger.info(`[Recorder] 停止录制: ${this.streamerName}`);

    await this._finishRecording();
  }

  /**
   * 完成录制流程：停止采集 → 合并 → 清理
   */
  async _finishRecording() {
    // Step 1: 停止 FFmpeg 流录制
    await this._stopFFmpeg();

    // Step 2: 停止评论区捕获
    let commentInfo = null;
    if (this.commentRenderer) {
      commentInfo = this.commentRenderer.stopCapture();
    }

    // Step 3: 合并直播流和评论区
    const streamFileExists = fs.existsSync(this._tempStreamFile);
    const hasCommentFrames = commentInfo && commentInfo.frameCount > 0;

    if (streamFileExists && hasCommentFrames) {
      // 有直播流 + 有评论区帧 → 合并
      logger.info('[Recorder] 开始合并直播流和评论区...');
      this.onStatusChange('merging', {
        roomId: this.roomId,
        streamerName: this.streamerName,
        commentFrames: commentInfo.frameCount,
        commentFps: commentInfo.fps
      });

      try {
        await this._mergeStreamAndComments(commentInfo);
        this._mergeResult = { success: true, outputFile: this.outputFile };
      } catch (mergeErr) {
        logger.error('[Recorder] 合并失败:', mergeErr.message);
        // 合并失败时，保留原始直播流文件作为兜底
        try {
          fs.copyFileSync(this._tempStreamFile, this.outputFile);
          logger.info('[Recorder] 已将原始直播流复制为输出文件（合并失败兜底）');
        } catch (copyErr) {
          logger.error('[Recorder] 复制兜底文件也失败:', copyErr.message);
        }
        this._mergeResult = { success: false, error: mergeErr.message, fallback: true };
      }
    } else if (streamFileExists) {
      // 只有直播流，没有评论区 → 直接复制
      logger.warn('[Recorder] 无评论区帧，直接使用直播流文件');
      try {
        fs.copyFileSync(this._tempStreamFile, this.outputFile);
      } catch (e) {
        logger.error('[Recorder] 复制文件失败:', e.message);
      }
      this._mergeResult = { success: true, noComments: true };
    } else {
      logger.error('[Recorder] 直播流临时文件不存在');
      this._mergeResult = { success: false, error: '直播流临时文件不存在' };
    }

    // Step 4: 清理临时文件
    await this._cleanupTempFiles();

    // Step 5: 销毁评论区渲染器
    if (this.commentRenderer) {
      await this.commentRenderer.destroy();
      this.commentRenderer = null;
    }

    // 通知完成
    const fileSize = this._getFileSize();
    this._lastRecordingResult = {
      hasAudio: this.hasAudio,
      merged: hasCommentFrames && streamFileExists,
      mergeResult: this._mergeResult,
      saved: true,
      outputFile: this.outputFile,
      timestamp: Date.now()
    };

    this.onStatusChange('stopped', {
      roomId: this.roomId,
      streamerName: this.streamerName,
      outputFile: this.outputFile,
      fileSize: fileSize,
      duration: this.startTime ? Date.now() - this.startTime.getTime() : 0,
      hasAudio: this.hasAudio,
      merged: hasCommentFrames && streamFileExists,
      commentFrames: commentInfo ? commentInfo.frameCount : 0,
      mergeResult: this._mergeResult
    });
  }

  /**
   * 停止 FFmpeg 进程（优雅退出）
   */
  async _stopFFmpeg() {
    if (!this.ffmpegProcess) return;

    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      this.ffmpegProcess.on('close', done);

      try {
        if (process.platform === 'win32') {
          // Windows: 通过 stdin 发送 'q' 让 FFmpeg 优雅退出
          if (this.ffmpegProcess.stdin && !this.ffmpegProcess.stdin.destroyed) {
            this.ffmpegProcess.stdin.write('q\n');
            this.ffmpegProcess.stdin.end();
          } else {
            execSync(`taskkill /PID ${this.ffmpegProcess.pid} /T`, { stdio: 'ignore' });
          }
        } else {
          this.ffmpegProcess.kill('SIGINT');
        }
      } catch (e) {
        try { this.ffmpegProcess.kill('SIGINT'); } catch (e2) { /* ignore */ }
      }

      // 超时强制结束
      setTimeout(() => {
        if (this.ffmpegProcess) {
          try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
        done();
      }, 15000);
    });
  }

  /**
   * 合并直播流视频和评论区帧序列
   *
   * 流程:
   *   1. 将评论区 JPEG 帧编码为视频 (comment_video.mp4)
   *   2. 使用 overlay 滤镜将评论区叠加到直播流右侧
   *   3. 音频从直播流直接复制
   */
  async _mergeStreamAndComments(commentInfo) {
    const resolvedPath = getFFmpegPath();
    const commentVideoFile = path.join(this._tempDir, 'comment_video.mp4');

    // Phase 1: 将评论区帧编码为视频
    logger.info(`[Merge] 编码评论区视频: ${commentInfo.frameCount} 帧 @ ${commentInfo.fps.toFixed(1)} fps`);

    await this._runFFmpeg(resolvedPath, [
      '-f', 'image2',
      '-framerate', String(commentInfo.fps),
      '-start_number', '0',
      '-i', path.join(this._commentFramesDir, 'frame_%06d.jpg'),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-s', `${COMMENT_WIDTH}x${COMMENT_HEIGHT}`,
      '-y',
      commentVideoFile
    ], 'Merge-Comment');

    if (!fs.existsSync(commentVideoFile)) {
      throw new Error('评论区视频编码失败');
    }

    // Phase 2: 合并直播流 + 评论区视频
    const totalWidth = STREAM_WIDTH + COMMENT_WIDTH;
    const outputHeight = STREAM_HEIGHT;

    logger.info(`[Merge] 合并视频: ${STREAM_WIDTH}x${outputHeight} + ${COMMENT_WIDTH}x${outputHeight} = ${totalWidth}x${outputHeight}`);

    await this._runFFmpeg(resolvedPath, [
      '-i', this._tempStreamFile,
      '-i', commentVideoFile,
      '-filter_complex',
        `[0:v]scale=${STREAM_WIDTH}:${STREAM_HEIGHT}[stream];` +
        `[1:v]scale=${COMMENT_WIDTH}:${COMMENT_HEIGHT}[comments];` +
        `[stream][comments]overlay=${STREAM_WIDTH}:0:shortest=1[out]`,
      '-map', '[out]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '15',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-y',
      this.outputFile
    ], 'Merge-Final');

    if (!fs.existsSync(this.outputFile)) {
      throw new Error('最终视频合并失败');
    }

    const finalSize = fs.statSync(this.outputFile).size;
    logger.info(`[Merge] 合并完成: ${this.outputFile}, 大小: ${(finalSize / 1024 / 1024).toFixed(1)} MB`);
  }

  /**
   * 运行 FFmpeg 命令并等待完成
   */
  _runFFmpeg(ffmpegPath, args, tag) {
    return new Promise((resolve, reject) => {
      logger.info(`[${tag}] 启动: ${ffmpegPath} ${args.slice(0, 6).join(' ')}...`);

      const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      let stderr = '';
      proc.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) logger.info(`[${tag}] ${msg}`);
      });

      proc.stderr.on('data', (data) => {
        const msg = data.toString();
        stderr += msg;
        const trimmed = msg.trim();
        if (trimmed) logger.info(`[${tag}] ${trimmed}`);
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

      // 超时保护 (10 分钟)
      setTimeout(() => {
        if (proc.exitCode === null) {
          logger.warn(`[${tag}] 超时，强制终止`);
          try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
          reject(new Error(`${tag} 超时`));
        }
      }, 600000);
    });
  }

  /**
   * 从抖音直播页面提取直播流URL
   * 优先使用API方式，回退到页面内fetch，最后DOM解析
   * @param {BrowserWindow} existingWindow - 可选，已加载直播页面的窗口
   */
  async _extractStreamUrl(existingWindow = null) {
    // 方法1: 通过抖音API获取直播流URL
    try {
      const apiUrl = `https://live.douyin.com/webcast/room/web/enter/?aid=6383&live_id=1&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=120.0.0.0&web_rid=${this.roomId}`;

      logger.info(`[Recorder] 尝试通过API获取直播流URL, roomId: ${this.roomId}`);

      let cookies = '';
      try {
        cookies = await this._getSessionCookies('live.douyin.com');
      } catch (cookieErr) {
        logger.warn(`[Recorder] 获取cookies失败: ${cookieErr.message}`);
      }

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `https://live.douyin.com/${this.roomId}`,
        'Accept': 'application/json, text/plain, */*',
      };
      if (cookies) {
        headers['Cookie'] = cookies;
      }

      const https = require('https');
      const http = require('http');
      const urlModule = require('url');

      const apiResult = await new Promise((resolve) => {
        const parsedUrl = urlModule.parse(apiUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const req = client.get(apiUrl, { headers, timeout: 10000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve({ success: true, data: json });
            } catch (e) {
              resolve({ success: false, error: 'JSON解析失败', raw: data.substring(0, 200) });
            }
          });
        });
        req.on('error', (e) => resolve({ success: false, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ success: false, error: '请求超时' }); });
      });

      if (apiResult.success && apiResult.data) {
        const roomData = apiResult.data.data || apiResult.data;
        const roomInfo = roomData.data && roomData.data[0] ? roomData.data[0] : roomData;

        // 递归查找 stream_url
        const findStreamUrl = (obj, depth = 0) => {
          if (!obj || typeof obj !== 'object' || depth > 10) return null;
          if (obj.stream_url && (obj.stream_url.flv_pull_url || obj.stream_url.hls_pull_url_map)) {
            return obj.stream_url;
          }
          for (const key of Object.keys(obj)) {
            const result = findStreamUrl(obj[key], depth + 1);
            if (result) return result;
          }
          return null;
        };

        let streamUrl = findStreamUrl(roomInfo);

        if (!streamUrl && roomData.data) {
          const dataArray = Array.isArray(roomData.data) ? roomData.data : [roomData.data];
          for (const item of dataArray) {
            streamUrl = findStreamUrl(item);
            if (streamUrl) break;
          }
        }

        if (streamUrl) {
          const flvUrls = streamUrl.flv_pull_url || {};
          const hlsUrls = streamUrl.hls_pull_url_map || {};

          // 按清晰度选择最高画质
          const qualityOrder = ['FULL_HD1', 'HD1', 'SD1', 'SD2', 'LD1'];
          let flvUrl = null;
          for (const q of qualityOrder) {
            if (flvUrls[q]) { flvUrl = flvUrls[q]; break; }
          }
          if (!flvUrl) flvUrl = Object.values(flvUrls)[0];

          let hlsUrl = null;
          for (const q of qualityOrder) {
            if (hlsUrls[q]) { hlsUrl = hlsUrls[q]; break; }
          }
          if (!hlsUrl) hlsUrl = Object.values(hlsUrls)[0];

          const finalUrl = flvUrl || hlsUrl;
          if (finalUrl) {
            logger.info(`[Recorder] API获取直播流成功 (类型: ${flvUrl ? 'flv' : 'hls'})`);
            return { url: finalUrl, type: flvUrl ? 'flv' : 'hls', source: 'API' };
          }
        }

        logger.warn('[Recorder] API返回数据中未找到stream_url');
      } else {
        logger.warn(`[Recorder] API请求失败: ${apiResult.error || '未知错误'}`);
      }
    } catch (apiErr) {
      logger.warn('[Recorder] API方式获取直播流失败:', apiErr.message);
    }

    // 方法1.5: 通过页面内fetch提取（利用页面cookies，最可靠）
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      try {
        logger.info('[Recorder] 尝试通过页面fetch获取直播流URL...');
        const pageResult = await this.captureWindow.webContents.executeJavaScript(`
          (async () => {
            try {
              const resp = await fetch('https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true&datak=0&web_rid=${this.roomId}', {
                credentials: 'include',
                headers: { 'Accept': 'application/json' }
              });
              const json = await resp.json();
              const roomData = json.data || json;
              const roomInfo = roomData.data && roomData.data[0] ? roomData.data[0] : roomData;

              const findStreamUrl = (obj, depth) => {
                if (!obj || typeof obj !== 'object' || depth > 10) return null;
                if (obj.stream_url && (obj.stream_url.flv_pull_url || obj.stream_url.hls_pull_url_map)) {
                  return obj.stream_url;
                }
                for (const key of Object.keys(obj)) {
                  const result = findStreamUrl(obj[key], depth + 1);
                  if (result) return result;
                }
                return null;
              };

              let streamUrl = findStreamUrl(roomInfo);
              if (!streamUrl && roomData.data) {
                const arr = Array.isArray(roomData.data) ? roomData.data : [roomData.data];
                for (const item of arr) {
                  streamUrl = findStreamUrl(item);
                  if (streamUrl) break;
                }
              }

              if (streamUrl) {
                const flvUrls = streamUrl.flv_pull_url || {};
                const hlsUrls = streamUrl.hls_pull_url_map || {};
                const qualityOrder = ['FULL_HD1', 'HD1', 'SD1', 'SD2', 'LD1'];
                let flvUrl = null;
                for (const q of qualityOrder) { if (flvUrls[q]) { flvUrl = flvUrls[q]; break; } }
                if (!flvUrl) flvUrl = Object.values(flvUrls)[0];
                let hlsUrl = null;
                for (const q of qualityOrder) { if (hlsUrls[q]) { hlsUrl = hlsUrls[q]; break; } }
                if (!hlsUrl) hlsUrl = Object.values(hlsUrls)[0];
                const finalUrl = flvUrl || hlsUrl;
                if (finalUrl) {
                  return { url: finalUrl, type: flvUrl ? 'flv' : 'hls', source: 'page_fetch' };
                }
              }
              return null;
            } catch (e) {
              return { error: e.message };
            }
          })()
        `);

        if (pageResult && pageResult.url && !pageResult.error) {
          logger.info(`[Recorder] 页面fetch获取直播流成功 (来源: ${pageResult.source || 'page_fetch'}, 类型: ${pageResult.type})`);
          return pageResult;
        } else {
          logger.warn(`[Recorder] 页面fetch失败: ${pageResult ? pageResult.error || '无数据' : 'null'}`);
        }
      } catch (pageErr) {
        logger.warn('[Recorder] 页面fetch获取直播流失败:', pageErr.message);
      }
    }

    // 方法2: 通过页面DOM提取（回退方案）
    try {
      const { BrowserWindow } = require('electron');
      const tempWin = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: this.session || 'persist:douyin',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          additionalArguments: ['--mute-audio'],
          audioPlaybackPolicy: 'never'
        }
      });

      await tempWin.loadURL(this.liveUrl, {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      });
      await new Promise(resolve => setTimeout(resolve, 5000));

      const domResult = await tempWin.webContents.executeJavaScript(`
        (async () => {
          try {
            // 从 RENDER_DATA 中提取
            const renderScript = document.getElementById('RENDER_DATA');
            if (renderScript) {
              const data = JSON.parse(decodeURIComponent(renderScript.textContent));
              const findStreamUrl = (obj, depth) => {
                if (!obj || typeof obj !== 'object' || depth > 10) return null;
                if (obj.stream_url && (obj.stream_url.flv_pull_url || obj.stream_url.hls_pull_url_map)) {
                  return obj.stream_url;
                }
                for (const key of Object.keys(obj)) {
                  const result = findStreamUrl(obj[key], depth + 1);
                  if (result) return result;
                }
                return null;
              };
              const streamUrl = findStreamUrl(data, 0);
              if (streamUrl) {
                const flvUrl = streamUrl.flv_pull_url && Object.values(streamUrl.flv_pull_url)[0];
                const hlsUrl = streamUrl.hls_pull_url_map && Object.values(streamUrl.hls_pull_url_map)[0];
                return { url: flvUrl || hlsUrl, type: flvUrl ? 'flv' : 'hls', source: 'RENDER_DATA' };
              }
            }

            // 从 video 元素获取
            const videos = document.querySelectorAll('video');
            for (const video of videos) {
              const src = video.src || video.currentSrc;
              if (src && (src.includes('.flv') || src.includes('live') || src.includes('.m3u8'))) {
                return { url: src, type: src.includes('.m3u8') ? 'hls' : 'flv', source: 'video_element' };
              }
            }

            // 从页面源码搜索
            const pageText = document.documentElement.innerHTML;
            const flvMatch = pageText.match(/https?:\/\/[^"'\s]+\.flv[^"'\s]*/);
            if (flvMatch) return { url: flvMatch[0], type: 'flv', source: 'page_text' };
            const m3u8Match = pageText.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
            if (m3u8Match) return { url: m3u8Match[0], type: 'hls', source: 'page_text' };

            return null;
          } catch (e) {
            return { error: e.message };
          }
        })()
      `);

      if (!tempWin.isDestroyed()) tempWin.destroy();

      if (domResult && domResult.url) {
        logger.info(`[Recorder] DOM提取直播流成功 (来源: ${domResult.source})`);
        return domResult;
      }
    } catch (domErr) {
      logger.warn('[Recorder] DOM方式提取直播流失败:', domErr.message);
    }

    logger.warn('[Recorder] 所有方式均未能提取到直播流URL');
    return null;
  }

  /**
   * 从 Electron session 中获取 cookies 字符串
   */
  async _getSessionCookies(domain) {
    try {
      const { session } = require('electron');
      const douyinSession = session.fromPartition(this.session || 'persist:douyin');
      const cookies = await douyinSession.cookies.get({ domain: `.${domain}` });
      return cookies
        .filter(c => c.value && c.name)
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
    } catch (e) {
      logger.warn('[Recorder] 获取 session cookies 失败:', e.message);
      return '';
    }
  }

  /**
   * 获取输出文件大小
   */
  _getFileSize() {
    try {
      if (this.outputFile && fs.existsSync(this.outputFile)) {
        return fs.statSync(this.outputFile).size;
      }
    } catch (e) { /* ignore */ }
    return 0;
  }

  /**
   * 清理临时文件（保留最终输出文件）
   */
  async _cleanupTempFiles() {
    if (!this._tempDir) return;

    try {
      if (fs.existsSync(this._tempDir)) {
        fs.rmSync(this._tempDir, { recursive: true, force: true });
        logger.info('[Recorder] 临时文件已清理');
      }
    } catch (e) {
      logger.warn('[Recorder] 清理临时文件失败:', e.message);
    }
  }

  /**
   * 清理所有资源（错误恢复用）
   */
  async _cleanup() {
    // 停止 FFmpeg
    if (this.ffmpegProcess) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${this.ffmpegProcess.pid} /f /t 2>nul`, { stdio: 'ignore' });
        } else if (!this.ffmpegProcess.killed) {
          this.ffmpegProcess.kill('SIGKILL');
        }
      } catch (e) { /* ignore */ }
      this.ffmpegProcess = null;
    }

    // 销毁评论区渲染器
    if (this.commentRenderer) {
      try {
        await this.commentRenderer.destroy();
      } catch (e) { /* ignore */ }
      this.commentRenderer = null;
    }

    // 清理临时文件
    await this._cleanupTempFiles();

    await new Promise(r => setTimeout(r, 300));
  }

  /**
   * 销毁录制器
   */
  async destroy() {
    if (this.recording) {
      this.recording = false;
      await this._cleanup();
    } else {
      await this._cleanup();
    }
  }

  /**
   * 获取默认输出文件夹
   */
  getDefaultOutputFolder() {
    const { app } = require('electron');
    return path.join(app.getPath('videos'), '抖音直播录制');
  }

  /**
   * 获取录制状态
   */
  getStatus() {
    return {
      recording: this.recording,
      streamerName: this.streamerName,
      roomId: this.roomId,
      outputFile: this.outputFile,
      startTime: this.startTime,
      hasAudio: this.hasAudio,
      mode: 'stream+comment',
      commentStatus: this.commentRenderer ? this.commentRenderer.getStatus() : null,
      lastRecordingResult: this._lastRecordingResult || null,
      duration: this.startTime ? Date.now() - this.startTime.getTime() : 0
    };
  }
}

module.exports = { Recorder };
