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
 * 布局: [Stream 1920x1080 | Comment 420x1080] = 2340x1080
 */
const { spawn, execSync, execFileSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs');
const { generateFileName } = require('./douyin-utils');
const { getConfig } = require('./config');
const { getLogger } = require('./logger');
const { CommentRenderer, COMMENT_WIDTH, COMMENT_HEIGHT } = require('./comment-renderer');
const { LeftPanelRenderer, LEFT_PANEL_WIDTH, LEFT_PANEL_HEIGHT } = require('./left-panel-renderer');

const logger = getLogger();

// 主视频目标高度（用于缩放）
const TARGET_HEIGHT = 1080;

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
    this.recordMode = options.recordMode || 'with-account'; // 'with-account' | 'stream-only' | 'stream+comment-no-login'
    this.commentFps = options.commentFps || 30;
    this.sessionName = options.sessionName || 'persist:douyin';

    this.recording = false;
    this._startingUp = false; // 启动中（init/取流/FFmpeg启动阶段），供 stopRecording 识别"启动挂起被取消"
    // v2.13.30 收尾防重入：_finishRecording 可能耗时数分钟（大文件合并/标准化），
    // 期间 stopRecording 重入/FFmpeg close 回调/destroy 都可能再次触发收尾或清理，
    // 曾致合并输入（评论帧）被提前删除、合并失败只剩源视频。
    this._finishPromise = null;  // 进行中的收尾 Promise（单例，重入时返回同一 Promise）
    this._finishSettled = false; // 收尾是否已完成（destroy 据此决定是否需等待）
    this.ffmpegProcess = null;
    this.commentRenderer = null;
    this.leftPanelRenderer = null; // 左侧信息面板渲染器
    this.outputFile = '';
    this.startTime = null;
    this.hasAudio = false;

    // 临时文件路径
    this._tempDir = '';
    this._tempStreamFile = '';
    this._commentFramesDir = '';
    this._leftPanelFramesDir = ''; // 左侧面板帧目录

    // 状态
    this._streamUrl = null;
    this._mergeResult = null;
    this._lastRecordingResult = null;
    this._stallUrlRefresh = false; // 视频轨停滞后的 URL 刷新重启标志
    this._commentStartEpoch = 0; // 评论捕获起点墙钟(ms)（v2.13.26 三路时间轴对齐：与流首帧起点 this.startTime 配合计算偏移）

    // 合并进度持久化
    this._mergeProgressFile = ''; // 合并进度文件路径
    this._streamSegmentCount = 0; // 流重启分段计数（v2.13.29：重启直写stream_partN.mp4新文件，合并时concat拼接）
    this._isManualStop = false; // 手动停止标志，用于跳过5分钟合并延迟
    this._lastProgressSave = 0; // 上次保存进度的时间戳

    this.onStatusChange = options.onStatusChange || (() => {});
    this.onError = options.onError || (() => {});
    this.onProgress = options.onProgress || (() => {});
  }

  /**
   * 保存合并进度到文件（用于崩溃恢复）
   * @param {object} progressData - 进度数据
   */
  _saveMergeProgress(progressData) {
    if (!this._mergeProgressFile) return;
    try {
      const data = {
        ...progressData,
        roomId: this.roomId,
        streamerName: this.streamerName,
        outputFile: this.outputFile,
        tempDir: this._tempDir,
        tempStreamFile: this._tempStreamFile,
        commentFramesDir: this._commentFramesDir,
        leftPanelFramesDir: this._leftPanelFramesDir,
        leftPanelInfo: this._leftPanelInfo,
        timestamp: Date.now()
      };
      fs.writeFileSync(this._mergeProgressFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      logger.warn('[Recorder] 保存合并进度失败:', e.message);
    }
  }

  /**
   * 删除合并进度文件
   */
  _deleteMergeProgress() {
    if (!this._mergeProgressFile) return;
    try {
      if (fs.existsSync(this._mergeProgressFile)) {
        fs.unlinkSync(this._mergeProgressFile);
      }
    } catch (e) {
      logger.warn('[Recorder] 删除合并进度文件失败:', e.message);
    }
  }

  /**
   * 加载合并进度文件（静态方法，用于崩溃恢复）
   * @param {string} progressFilePath - 进度文件路径
   * @returns {object|null} 进度数据或null
   */
  static loadMergeProgress(progressFilePath) {
    try {
      if (!fs.existsSync(progressFilePath)) return null;
      const content = fs.readFileSync(progressFilePath, 'utf-8');
      return JSON.parse(content);
    } catch (e) {
      logger.warn('[Recorder] 加载合并进度文件失败:', e.message);
      return null;
    }
  }

  /**
   * 从保存的进度恢复合并（静态方法，用于崩溃恢复）
   * @param {object} progressData - 从 loadMergeProgress 加载的进度数据
   * @param {object} callbacks - 回调函数 { onProgress, onStatusChange, onComplete, onError }
   * @returns {Promise<boolean>} 是否成功恢复
   */
  static async resumeMerge(progressData, callbacks) {
    const { onProgress = () => {}, onStatusChange = () => {}, onComplete = () => {}, onError = () => {} } = callbacks;

    logger.info(`[Merge-Resume] 尝试恢复合并: ${progressData.outputFile}`);
    logger.info(`[Merge-Resume] 进度: phase=${progressData.phase}, progress=${progressData.progress}%, frames=${progressData.currentFrame}/${progressData.totalFrames}`);

    // 检查必要的文件是否存在
    if (!progressData.tempStreamFile || !fs.existsSync(progressData.tempStreamFile)) {
      logger.error('[Merge-Resume] 直播流临时文件不存在，无法恢复');
      return false;
    }
    if (!progressData.commentFramesDir || !fs.existsSync(progressData.commentFramesDir)) {
      logger.error('[Merge-Resume] 评论区帧目录不存在，无法恢复');
      return false;
    }

    // 计算实际帧数
    const frameFiles = fs.readdirSync(progressData.commentFramesDir).filter(f => f.endsWith('.jpg'));
    const actualFrameCount = frameFiles.length;
    if (actualFrameCount === 0) {
      logger.error('[Merge-Resume] 评论区帧目录为空，无法恢复');
      return false;
    }

    logger.info(`[Merge-Resume] 实际帧数: ${actualFrameCount}, 原始记录: ${progressData.totalFrames}`);

    // 创建临时 Recorder 实例来执行合并
    const tempRecorder = new Recorder({
      roomId: progressData.roomId || 'resume',
      streamerName: progressData.streamerName || '未知主播',
      outputFolder: path.dirname(progressData.outputFile),
      commentFps: progressData.fps || 30
    });

    // 设置临时路径
    tempRecorder._tempDir = progressData.tempDir;
    tempRecorder._tempStreamFile = progressData.tempStreamFile;
    tempRecorder._commentFramesDir = progressData.commentFramesDir;
    tempRecorder._leftPanelFramesDir = progressData.leftPanelFramesDir;
    tempRecorder.outputFile = progressData.outputFile;
    tempRecorder._mergeProgressFile = path.join(progressData.tempDir, 'merge_progress.json');
    tempRecorder.startTime = new Date(progressData.timestamp - (progressData.currentTimeMs || 0));

    // 设置回调
    tempRecorder.onProgress = onProgress;
    tempRecorder.onStatusChange = onStatusChange;

    try {
      onStatusChange('merging', {
        roomId: progressData.roomId,
        streamerName: progressData.streamerName,
        commentFrames: actualFrameCount,
        commentFps: progressData.fps,
        resuming: true
      });

      const commentInfo = {
        frameCount: actualFrameCount,
        fps: progressData.fps || 30,
        width: COMMENT_WIDTH,
        height: COMMENT_HEIGHT
      };

      // 恢复左侧面板信息（如果有）
      const leftPanelInfo = progressData.leftPanelInfo || null;

      await tempRecorder._mergeStreamAndComments(commentInfo, undefined, undefined, undefined, leftPanelInfo);

      logger.info(`[Merge-Resume] 合并恢复成功: ${progressData.outputFile}`);
      onComplete({ success: true, outputFile: progressData.outputFile, resumed: true });
      return true;
    } catch (err) {
      logger.error(`[Merge-Resume] 合并恢复失败: ${err.message}`);
      // 合并失败时，尝试兜底
      try {
        if (fs.existsSync(tempRecorder._tempStreamFile)) {
          await tempRecorder._normalizeStream(tempRecorder.outputFile);
          logger.info('[Merge-Resume] 已将原始直播流标准化为输出文件（恢复失败兜底）');
        }
      } catch (e) { logger.warn('[Merge-Resume] 标准化兜底失败:', e.message); }
      onError(err);
      return false;
    }
  }

  /**
   * 手动合并直播流和评论区视频（用于合并失败后重新合并）
   * @param {string} streamFile - 直播流文件路径 (_stream.mp4 或 stream.mp4)
   * @param {string} commentVideoFile - 评论区视频文件路径 (_comments.mp4 或 comment_video.mp4)
   * @param {string} outputFile - 输出文件路径
   * @param {object} callbacks - 回调函数 { onProgress, onStatusChange, onComplete, onError }
   * @returns {Promise<boolean>} 是否成功合并
   */
  static async manualMerge(streamFile, commentVideoFile, outputFile, callbacks = {}) {
    const { onProgress = () => {}, onStatusChange = () => {}, onComplete = () => {}, onError = () => {} } = callbacks;

    logger.info(`[Manual-Merge] 开始手动合并: ${streamFile} + ${commentVideoFile} -> ${outputFile}`);

    // 检查文件是否存在
    if (!fs.existsSync(streamFile)) {
      const err = new Error(`直播流文件不存在: ${streamFile}`);
      logger.error(`[Manual-Merge] ${err.message}`);
      onError(err);
      return false;
    }
    if (!fs.existsSync(commentVideoFile)) {
      const err = new Error(`评论区视频文件不存在: ${commentVideoFile}`);
      logger.error(`[Manual-Merge] ${err.message}`);
      onError(err);
      return false;
    }

    onStatusChange('merging', { streamFile, commentVideoFile, outputFile });

    try {
      // 获取直播流时长
      const streamDuration = await Recorder._getMediaDuration(streamFile);
      logger.info(`[Manual-Merge] 直播流时长: ${Math.round(streamDuration / 1000)}秒`);

      // 获取评论区视频时长
      const commentDuration = await Recorder._getMediaDuration(commentVideoFile);
      logger.info(`[Manual-Merge] 评论区视频时长: ${Math.round(commentDuration / 1000)}秒`);

      // 创建临时录制器实例用于执行合并
      const tempDir = path.dirname(streamFile);
      const tempRecorder = new Recorder({
        roomId: 'manual-merge',
        streamerName: '手动合并',
        outputFile: outputFile,
        outputDir: path.dirname(outputFile),
        tempDir: tempDir,
        onProgress: onProgress
      });

      // 设置临时文件路径
      tempRecorder._tempStreamFile = streamFile;
      tempRecorder._tempDir = tempDir;

      // 执行合并（使用已有的 _mergeStreamAndComments 逻辑，但直接传入文件路径）
      await tempRecorder._mergeStreamAndCommentFiles(streamFile, commentVideoFile, outputFile, streamDuration);

      logger.info(`[Manual-Merge] 合并成功: ${outputFile}`);
      onComplete({ success: true, outputFile });
      return true;
    } catch (err) {
      logger.error(`[Manual-Merge] 合并失败: ${err.message}`);
      onError(err);
      return false;
    }
  }

  /**
   * 合并直播流和评论区视频文件（用于手动合并）
   */
  async _mergeStreamAndCommentFiles(streamFile, commentVideoFile, outputFile, streamDurationMs) {
    const ffmpegPath = getFFmpegPath();
    const resolvedPath = ffmpegPath.resolvedPath || ffmpegPath;

    // 使用与 _mergeStreamAndComments 相同的滤镜
    const filterComplex = [
      '[0:v]setpts=PTS-STARTPTS,fps=30,scale=1920:1080,setsar=1[stream]',
      '[1:v]scale=420:1080,setsar=1[comments]',
      '[stream]pad=2342:1080:0:0:black[stream_padded]',
      '[stream_padded]drawbox=x=1920:y=0:w=2:h=1080:color=black@0.5:t=fill[stream_sep]',
      '[stream_sep][comments]overlay=1922:0:eof_action=repeat[out]'
    ].join(';');

    const args = [
      '-i', streamFile,
      '-i', commentVideoFile,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '15',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-y',
      outputFile
    ];

    await this._runFFmpeg(outputFile, args, 'Manual-Merge', streamDurationMs, '手动合并');
  }

  /**
   * 获取媒体文件时长（毫秒）
   */
  static async _getMediaDuration(filePath) {
    return new Promise((resolve) => {
      const ffmpegPath = getFFmpegPath();
      const resolvedPath = ffmpegPath.resolvedPath || ffmpegPath;
      const proc = spawn(resolvedPath, ['-i', filePath, '-f', 'null', '-']);

      // v2.13.30：Duration 在 FFmpeg 启动时的 stderr 头部即输出，收到立即解析并终止进程。
      // 旧实现等进程 close 才解析——等于把整段视频完整解码一遍（-f null 仍逐帧解码），
      // 9.2GB/3小时视频实测耗时 8 分钟，合并流程长时间"假死"并诱发停止流程重入踩踏。
      let stderr = '';
      let settled = false;
      const finish = (ms) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
        } catch (e) { /* ignore */ }
        resolve(ms);
      };
      const parseDuration = (text) => {
        const match = text.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (!match) return null;
        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const seconds = parseInt(match[3], 10);
        const centiseconds = parseInt(match[4], 10);
        return (hours * 3600 + minutes * 60 + seconds) * 1000 + centiseconds * 10;
      };

      // 30s 超时兜底：异常文件/磁盘卡顿时返回 0，由调用方回退墙钟估算
      const timer = setTimeout(() => {
        logger.warn(`[Recorder] 媒体时长探测超时(30s)，回退估算: ${path.basename(filePath)}`);
        finish(0);
      }, 30000);

      proc.stderr.on('data', (data) => {
        if (settled) return;
        stderr += data.toString();
        const ms = parseDuration(stderr);
        if (ms !== null) { finish(ms); return; }
        // 分片源（stream copy 未重写 moov）常报 Duration: N/A——继续等只会全解码，直接回退
        if (/Duration:\s*N\/A/.test(stderr)) finish(0);
      });

      proc.on('close', () => {
        const ms = parseDuration(stderr);
        finish(ms !== null ? ms : 0);
      });

      proc.on('error', () => finish(0));
    });
  }

  /**
   * 生成 FFmpeg concat demuxer 文件（v2.13.26 三路时间轴统一）：
   * 按逐帧真实捕获时间戳给出每帧 duration，替代"固定帧率均匀铺开"，
   * 消除 capturePage 耗时不均（礼物时更慢）造成的中间内容相对源视频漂移。
   * @param {string} dir 帧目录（concat 文件与帧同目录，file 用绝对路径条目——concat demuxer 的相对路径按进程 CWD 解析，Windows 实测失败）
   * @param {string} prefix 帧文件名前缀（frame_ / left_frame_）
   * @param {number} frameCount 帧数
   * @param {number[]} timestamps 每帧相对捕获起点的毫秒时间戳（长度可能不等于 frameCount，缺值按平均间隔外推）
   * @param {number} tailTargetSec 末帧需要延长到的目标总时长（秒，从 0 起算；不足则按平均间隔）
   * @param {string} outFile 输出 concat 文件路径
   */
  static _buildConcatFile(dir, prefix, frameCount, timestamps, tailTargetSec, outFile) {
    const ts = Array.isArray(timestamps) ? timestamps : [];
    const avgMs = (ts.length >= 2 && ts[ts.length - 1] > 0) ? ts[ts.length - 1] / (ts.length - 1) : 100;
    const tsAt = (i) => {
      if (i < ts.length && typeof ts[i] === 'number') return ts[i];
      // 外推：最后一个已知时间戳 + 平均间隔
      const lastIdx = ts.length - 1;
      return lastIdx >= 0 ? ts[lastIdx] + (i - lastIdx) * avgMs : i * avgMs;
    };
    const lines = ['ffconcat version 1.0'];
    // 绝对路径 + 正斜杠：与进程 CWD 解耦（concat demuxer 相对路径按 CWD 解析，Windows 下 .temp\comments\_concat.txt 实测打不开；正斜杠规避 Windows 反斜杠在 concat 内的解析坑）
    const name = (i) => path.join(dir, `${prefix}${String(i).padStart(6, '0')}.jpg`).replace(/\\/g, '/');
    for (let i = 0; i < frameCount; i++) {
      lines.push(`file '${name(i)}'`);
      let dur;
      if (i < frameCount - 1) {
        dur = (tsAt(i + 1) - tsAt(i)) / 1000;
        if (!(dur > 0)) dur = avgMs / 1000;
        // 单帧间隔上限钳制（异常长间隔按 2s 封顶，避免某帧卡死过久；真实长间隔由后续帧追赶对齐）
        if (dur > 2) dur = 2;
      } else {
        // 末帧：延长到目标总时长（对齐源视频/评论统一时长），至少保留一个平均间隔
        const elapsed = tsAt(i) / 1000;
        dur = Math.max(tailTargetSec - elapsed, avgMs / 1000, 0.04);
      }
      lines.push(`duration ${dur.toFixed(3)}`);
    }
    // concat demuxer 已知怪癖：末帧需再重复一次 file 行，duration 才会生效
    if (frameCount > 0) lines.push(`file '${name(frameCount - 1)}'`);
    fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
    return outFile;
  }

  /**
   * 开始录制
   */
  async startRecording() {
    if (this.recording) {
      throw new Error(`录制引擎已在运行中 (room: ${this.roomId})`);
    }

    logger.info(`[Recorder] 准备开始录制 - 房间: ${this.roomId}, 主播: ${this.streamerName}`);
    this._startingUp = true;

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
      const safeName = (this.streamerName || '未知主播').replace(/[<>:"/\\|?*]/g, '_').replace(/\.$/, '_');

      // 会话文件夹: 主播名称_年-月-日_时-分-秒（避免使用方括号，FFmpeg会将其解释为通配符）
      const sessionFolder = path.join(streamerFolder, `${safeName}_${dateStr}_${timeStrFull}`);
      if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, { recursive: true });
      }

      // 最终输出文件
      const fileName = `${safeName}_${dateStr}_${timeStrShort}`;
      this.outputFile = path.join(sessionFolder, `${fileName}.${config.fileFormat || 'mp4'}`);

      // 创建临时目录
      this._tempDir = path.join(sessionFolder, '.temp');
      this._tempStreamFile = path.join(this._tempDir, 'stream.mp4');
      this._commentFramesDir = path.join(this._tempDir, 'comments');
      this._leftPanelFramesDir = path.join(this._tempDir, 'left-panel');

      try {
        fs.mkdirSync(this._tempDir, { recursive: true });
        fs.mkdirSync(this._commentFramesDir, { recursive: true });
        fs.mkdirSync(this._leftPanelFramesDir, { recursive: true });
        // 验证目录是否创建成功
        if (!fs.existsSync(this._tempDir)) {
          throw new Error(`临时目录创建失败: ${this._tempDir}`);
        }
        if (!fs.existsSync(this._commentFramesDir)) {
          throw new Error(`评论帧目录创建失败: ${this._commentFramesDir}`);
        }
        if (!fs.existsSync(this._leftPanelFramesDir)) {
          throw new Error(`左侧面板帧目录创建失败: ${this._leftPanelFramesDir}`);
        }
        logger.info(`[Recorder] 临时目录已创建: ${this._tempDir}`);
        logger.info(`[Recorder] 评论帧目录已创建: ${this._commentFramesDir}`);
        logger.info(`[Recorder] 左侧面板帧目录已创建: ${this._leftPanelFramesDir}`);
      } catch (err) {
        logger.error(`[Recorder] 创建临时目录失败: ${err.message}`);
        throw err;
      }

      logger.info(`[Recorder] 输出文件: ${this.outputFile}`);
      logger.info(`[Recorder] 临时目录: ${this._tempDir}`);

      // Step 1: 初始化评论区渲染器（根据录制模式决定是否初始化）
      const useCommentRenderer = this.recordMode !== 'stream-only';
      // 左侧特效区仅在 'stream+comment+effect' 模式下启用（复用评论区同一个离屏窗口同时裁剪）

      if (useCommentRenderer) {
        // 特效区在 'stream+comment+effect' 及 '+rank' 模式下启用；团播榜单仅在 '+rank' 模式启用
        const useLeftPanel = this.recordMode === 'stream+comment+effect' || this.recordMode === 'stream+comment+effect+rank';
        const useRankPanel = this.recordMode === 'stream+comment+effect+rank';
        logger.info(`[Recorder] 初始化评论区渲染器... (模式: ${this.recordMode}, FPS: ${this.commentFps}, 左特效区: ${useLeftPanel}, 团播榜单: ${useRankPanel})`);
        this.commentRenderer = new CommentRenderer({
          liveUrl: this.liveUrl,
          roomId: this.roomId,
          session: this.session,
          outputDir: this._commentFramesDir,
          debugDir: path.dirname(this.outputFile),
          fps: this.commentFps,
          sessionName: this.sessionName,
          enableLeftPanel: useLeftPanel,
          leftPanelOutputDir: useLeftPanel ? this._leftPanelFramesDir : null,
          enableRankPanel: useRankPanel,
          noLoginMode: this.recordMode === 'stream+comment-no-login',
          onAccountConflict: () => {
            // 防呆：检测到评论区账号被同账号其它直播间顶下线时，自动回滚为无账号模式续帧录制
            this._rollbackCommentToNoLogin().catch((e) => {
              logger.error(`[Recorder] 防呆回滚失败: ${e.message}`);
            });
          }
        });
        try {
          await this.commentRenderer.init();
          logger.info('[Recorder] 评论区渲染器初始化成功');
        } catch (commentErr) {
          logger.error(`[Recorder] 评论区渲染器初始化失败: ${commentErr.message}`);
          this.commentRenderer = null;
          // 如果评论区渲染器初始化失败，回退到纯直播流模式
          logger.warn('[Recorder] 回退到纯直播流录制模式');
        }
      } else {
        logger.info('[Recorder] 纯直播流录制模式，跳过评论区渲染器');
      }

      // 说明：左侧特效区已在评论区渲染器中复用同一个离屏窗口同时裁剪捕获，
      // 无需再创建独立的左侧面板渲染器窗口（避免独立窗口 DOM 探测不到左特效区导致黑屏）

      // Step 2: 获取直播流URL
      let streamInfo;
      if (useCommentRenderer && this.commentRenderer && this.commentRenderer.captureWindow) {
        // 有评论区窗口时，从页面上下文中提取直播流URL
        this.captureWindow = this.commentRenderer.captureWindow;
        logger.info('[Recorder] 正在获取直播流URL...');
        streamInfo = await this._extractStreamUrl();
      } else {
        // 纯直播流模式，通过API或页面fetch获取
        logger.info('[Recorder] 正在获取直播流URL (纯流模式)...');
        streamInfo = await this._getStreamUrlWithoutRenderer();
      }

      if (!streamInfo || !streamInfo.url) {
        throw new Error('无法获取直播流URL，请确保已登录抖音且直播间正在直播');
      }

      this._streamUrl = streamInfo.url;
      logger.info(`[Recorder] 获取到直播流: ${streamInfo.type}, 来源: ${streamInfo.source}`);

      // 验证直播流 URL 是否有效（快速验证，避免启动后才发现 URL 过期）
      const isValid = await this._validateStreamUrl(this._streamUrl);
      if (!isValid) {
        logger.warn(`[Recorder] 直播流 URL 验证失败，尝试重新获取...`);
        // 尝试重新获取直播流 URL（最多重试 2 次）
        let retryCount = 0;
        let newStreamInfo = null;
        while (retryCount < 2 && !newStreamInfo) {
          retryCount++;
          logger.info(`[Recorder] 第 ${retryCount} 次重新获取直播流 URL...`);
          try {
            if (this.commentRenderer) {
              newStreamInfo = await this._getStreamUrl();
            } else {
              newStreamInfo = await this._getStreamUrlWithoutRenderer();
            }
            if (newStreamInfo && newStreamInfo.url) {
              const newIsValid = await this._validateStreamUrl(newStreamInfo.url);
              if (newIsValid) {
                this._streamUrl = newStreamInfo.url;
                logger.info(`[Recorder] 重新获取直播流成功: ${newStreamInfo.type}, 来源: ${newStreamInfo.source}`);
                break;
              } else {
                logger.warn(`[Recorder] 第 ${retryCount} 次重新获取的直播流 URL 仍无效`);
                newStreamInfo = null;
              }
            }
          } catch (retryErr) {
            logger.warn(`[Recorder] 第 ${retryCount} 次重新获取直播流失败: ${retryErr.message}`);
          }
        }
        if (!newStreamInfo) {
          throw new Error('直播流 URL 验证失败，且重新获取后仍无效，请检查网络连接或稍后重试');
        }
      }

      // Step 3: 启动 FFmpeg 录制直播流 (stream copy)
      logger.info('[Recorder] 启动 FFmpeg 流媒体直录...');
      this._startStreamRecording();

      // Step 4: 开始评论区帧捕获（仅评论区模式）
      if (this.commentRenderer) {
        // 记录评论捕获起点墙钟（v2.13.26）：与流录制首帧起点（this.startTime）对齐，
        // 合并时按偏移平移评论/左特效区时间轴，保证三路时间轴一致。
        // 仅首次记录——账号冲突回滚重建渲染器续帧时（2411行）保持首段基准不变。
        if (!this._commentStartEpoch) this._commentStartEpoch = Date.now();
        this.commentRenderer.startCapture();
      }

      // 录制状态 - 计时器将在 FFmpeg 输出第一帧时启动
      this.recording = true;
      this._startingUp = false;
      this.hasAudio = true;
      this._firstFrameReceived = false;

      logger.info(`[Recorder] FFmpeg 已启动，等待第一帧输出...`);
    } catch (err) {
      logger.error(`[Recorder] 启动录制失败: ${err.message}`, err);
      this.recording = false;
      this._startingUp = false;
      await this._cleanup();
      // 启动失败（多为直播流URL获取失败）时，若本次会话未产生任何有效录制内容，
      // 则删除刚创建的空会话文件夹，避免残留"生成了录制文件夹却无录制文件"的空目录。
      // 注意：Step1 会先创建 .temp/ 与 .temp/comments/，因此不能用"文件夹是否为空"判断，
      // 必须检测是否存在有效录制产出（输出文件 / 非空流文件 / 评论帧）。
      if (this.outputFile) {
        const sessionFolder = path.dirname(this.outputFile);
        try {
          const hasOutput = fs.existsSync(this.outputFile) && fs.statSync(this.outputFile).size > 0;
          const tempStream = path.join(sessionFolder, '.temp', 'stream.mp4');
          const hasTempStream = fs.existsSync(tempStream) && fs.statSync(tempStream).size > 0;
          const commentsDir = path.join(sessionFolder, '.temp', 'comments');
          let hasCommentFrames = false;
          if (fs.existsSync(commentsDir)) {
            hasCommentFrames = fs.readdirSync(commentsDir).some(f => /\.(jpe?g|png|webp)$/i.test(f));
          }
          if (!hasOutput && !hasTempStream && !hasCommentFrames) {
            fs.rmSync(sessionFolder, { recursive: true, force: true });
            logger.warn(`[Recorder] 启动失败且无录制产出，已清理空会话文件夹: ${sessionFolder}`);
          } else {
            logger.info(`[Recorder] 启动失败但检测到录制产出(输出=${hasOutput}, 流=${hasTempStream}, 帧=${hasCommentFrames})，保留: ${sessionFolder}`);
          }
        } catch (_) { /* ignore */ }
      }
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

    // 确保临时目录存在（FFmpeg 无法自动创建目录）
    if (!fs.existsSync(this._tempDir)) {
      logger.error(`[Recorder] 临时目录不存在: ${this._tempDir}`);
      fs.mkdirSync(this._tempDir, { recursive: true });
    }

    // v2.13.29：流重启分段直写——首次录 stream.mp4，每次停滞/回绕重启写新分段 stream_part{N}.mp4。
    // 旧版"归档(rename)再覆盖"在 Windows 上因句柄释放延迟 rename 报 EBUSY 导致旧内容仍被覆盖
    // （实测：梦华录·水月场前 56 分钟丢失）；直写新文件名彻底不碰旧文件，无句柄竞争。
    const segCount = this._streamSegmentCount || 0;
    const streamFile = segCount === 0
      ? path.join(this._tempDir, 'stream.mp4')
      : path.join(this._tempDir, `stream_part${segCount}.mp4`);
    if (streamFile !== this._tempStreamFile) {
      logger.warn(`[Recorder] 流重启分段直写新文件: ${path.basename(streamFile)}（第 ${segCount + 1} 段，旧段保留）`);
      this._tempStreamFile = streamFile;
    }

    const args = [
      // 网络超时设置（10秒，直播流无数据则报错退出并触发断流处理）
      '-rw_timeout', '10000000',
      '-timeout', '10000000',
      // HTTP/FLV 断流自动重连：抖音 CDN 会周期性回收长连接（FLV EOF 后进程 code:0 退出），
      // 开启后 EOF/网络错误由 FFmpeg 内部透明重连（退避上限5s），录制连续不中断，
      // 避免"整会话销毁重建"造成的碎片文件与重录间隙漏录。
      // 注：HTTP 4xx/5xx（如流地址签名过期）默认不触发重连，会报错退出，
      //     此时走上层 stream-interrupted 全量重录（重新取流地址），两层机制互补。
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_at_eof', '1',
      // 注意：不使用 -reconnect_on_network_error（FFmpeg 4.2+/2019-04 才加入），
      // @ffmpeg-installer 打包的 N-92722 (2019初) 无法识别会直接退出(code 1)。
      '-reconnect_delay_max', '5',
      '-multiple_requests', '1',
      // 输入: 直播流
      '-i', this._streamUrl,
      // 输出: stream copy（不重新编码）
      '-c', 'copy',
      // 分片 MP4：moov 从头写入，每关键帧一个 moof 分片。
      // 即使直播断流/进程被强杀，已录部分从开头到最后一片都可播放，
      // 避免 "+faststart"(仅正常结束时写 moov) 导致文件无索引而打不开。
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-avoid_negative_ts', 'make_zero',
      '-y',
      this._tempStreamFile
    ];

    logger.info(`[Recorder] FFmpeg 命令: ${resolvedPath} ${args.join(' ').substring(0, 200)}...`);

    this.ffmpegProcess = spawn(resolvedPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // FFmpeg 进程启动时间（用于判定"启动即失败"，如参数不兼容/地址失效导致秒退）
    this._launchTime = Date.now();
    // 最近一次有输出进展的时间（进度行），用于停滞看门狗
    this._lastProgressAt = Date.now();
    this._stallRestarting = false;
    // 流时间戳异常统计（Non-monotonous DTS：CDN 重连后时间轴回绕/视频轨停滞）
    this._dtsWarnCount = 0;
    this._dtsRewindCount = 0;
    this._dtsDupCount = 0;
    this._dtsWarnLastLogAt = 0;

    // 停滞看门狗：进程活着但长时间无任何输出进展（如流停滞/重连后假死），
    // 强制杀掉进程，走 close -> stream-interrupted 重录路径，避免"源视频只录了一半但状态显示录制中"
    this._stallWatchdog = setInterval(() => {
      try {
        if (!this.recording || !this.ffmpegProcess || this._stallRestarting) return;
        // 第一帧前用启动时间做宽限，第一帧后用最近进度时间
        const base = this._firstFrameReceived ? this._lastProgressAt : this._launchTime;
        const silentMs = Date.now() - (base || 0);
        if (silentMs > 60000) {
          this._stallRestarting = true;
          logger.warn(`[Recorder] 录制进程 ${Math.round(silentMs / 1000)}s 无任何输出进展（进程假死/流停滞），强制重启: ${this.streamerName}`);
          try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
        }
      } catch (e) { /* 看门狗自身异常不影响录制 */ }
    }, 10000);

    // 判断是否为 FFmpeg 高频进度统计行（录制 stream copy 时数小时持续刷屏）
    const isStreamProgressStat = (s) => /frame=\s*\d+/.test(s) || /(^|\s)time=\d{2}:\d{2}:\d{2}/.test(s) || /^(size|Lsize)=/.test(s);

    this.ffmpegProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg && !isStreamProgressStat(msg)) logger.info(`[FFmpeg-Stream] ${msg.slice(0, 1000)}`);
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      // FFmpeg 进度常以 \r 刷新，拆分逐条处理
      const raw = data.toString();
      const lines = raw.split(/[\r\n]/);
      for (const lineRaw of lines) {
        const msg = lineRaw.trim();
        if (!msg) continue;

        // 时间戳类噪声（CDN 流时间戳/元数据异常警告）：逐条内容不同，logger 重复抑制无效，
        // 曾致单场日志 140 万行/300MB，统一计数 + 每 60 秒汇总一条。
        // 两种损坏形态均需 kill 重录（产物播放画面卡住、合并解码失败导致评论区丢失）：
        //  ① 时间轴回绕：current 为负或回退超一半（CDN 重连后时间戳重置，如 142903018→1162928），累计 3 次
        //  ② 视频轨停滞：current == previous（CDN 重复发同一时间戳的视频包，画面卡住但连接活着，
        //     frame= 仍在增长使停滞看门狗失效），连续约 2 分钟（60 次×2s）无正常进展
        const isTsNoise = msg.includes('Non-monotonous DTS in output stream')
          || msg.includes('Application provided duration')
          || /^(DTS|PTS) -?\d+, next:-?\d+ st:-?\d+ invalid dropping/.test(msg)
          || /^changing to -?\d+\./.test(msg)
          || msg.includes('pts has no value');
        if (isTsNoise) {
          this._dtsWarnCount++;
          const m = msg.match(/Non-monotonous DTS in output stream \d+:(\d+); previous:\s*(-?\d+),\s*current:\s*(-?\d+)/);
          if (m && m[1] === '0') { // 只看视频轨（0:0），音频停滞不误判
            const prevTs = parseInt(m[2], 10);
            const curTs = parseInt(m[3], 10);
            if (curTs < 0 || curTs < prevTs / 2) {
              this._dtsRewindCount++;
              this._dtsDupCount = 0;
            } else if (curTs <= prevTs) {
              this._dtsDupCount++; // 重复/微倒退：视频轨无进展
            } else {
              this._dtsDupCount = 0; // 正常前进，重置停滞计数
            }
          }
          const now = Date.now();
          if (now - this._dtsWarnLastLogAt >= 60000) {
            this._dtsWarnLastLogAt = now;
            logger.warn(`[FFmpeg-Stream] 流时间戳异常警告累计 ${this._dtsWarnCount} 次（时间轴回绕 ${this._dtsRewindCount} 次，视频轨停滞连续 ${this._dtsDupCount} 次），样本: ${msg.slice(0, 160)}`);
          }
          const stallKill = this._dtsDupCount >= 60;
          const rewindKill = this._dtsRewindCount >= 3;
          if (this.recording && (stallKill || rewindKill) && !this._stallRestarting) {
            this._stallRestarting = true;
            const reason = rewindKill
              ? `流时间轴回绕损坏（DTS 大幅回退 ×${this._dtsRewindCount}）`
              : `视频轨停滞（DTS 连续 ${this._dtsDupCount} 次无进展，画面已卡死但连接未断）`;
            logger.warn(`[Recorder] ${reason}，尝试重新获取直播流 URL: ${this.streamerName}`);

            // 异步重新获取直播流 URL（视频轨停滞可能是 URL 过期导致）
            this._tryRefreshStreamUrl(stallKill, rewindKill);
          }
          continue; // 不进入常规逐条日志输出
        }

        if (!isStreamProgressStat(msg)) {
          logger.info(`[FFmpeg-Stream] ${msg.slice(0, 1000)}`);
        }

        // 有输出进展（进度行），刷新看门狗计时
        if (/frame=\s*\d+/.test(msg) || /(^|\s)time=\d{2}:\d{2}:\d{2}/.test(msg)) {
          this._lastProgressAt = Date.now();
        }

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
            mode: this.recordMode
          });
        }
      }
    });

    this.ffmpegProcess.on('close', (code) => {
      logger.info(`[FFmpeg-Stream] 进程退出, code: ${code}`);
      this.ffmpegProcess = null;
      if (this._stallWatchdog) { clearInterval(this._stallWatchdog); this._stallWatchdog = null; }

      // 如果是视频轨停滞后的 URL 刷新重启，不触发 stream-interrupted（已在 setTimeout 中重启）
      if (this._stallUrlRefresh) {
        logger.info('[Recorder] 视频轨停滞 URL 刷新重启，等待新 FFmpeg 进程启动...');
        return;
      }

      // 如果仍在录制中，流中断意味着录制结束
      if (this.recording) {
        logger.warn('[Recorder] 直播流中断，录制自动结束');
        this.recording = false;
        // 标记为流中断（网络波动等），区别于用户主动停止/下播停止，
        // _finishRecording 据此在合并前立即通知上层重启新录制，合并转后台执行
        this._stopReason = 'stream-interrupted';
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
    // 启动阶段被取消（init 挂起/超时等导致 recording 尚未置 true）：
    // 销毁评论窗口会令其内部挂起的 executeJavaScript reject，startRecording 进入 catch 统一清理并发 error 事件
    if (!this.recording && this._startingUp) {
      logger.warn(`[Recorder] 录制启动阶段被停止（初始化未完成），执行取消清理: ${this.streamerName}`);
      await this._cleanup();
      return;
    }
    if (!this.recording) {
      // v2.13.30：收尾（合并/标准化）可能仍在进行——重入停止必须等待其完成，
      // 否则上层（stream-manager）会误以为已结束而提前 destroy，删除合并输入帧。
      if (this._finishPromise && !this._finishSettled) {
        logger.info('[Recorder] 停止重入：收尾仍在进行，等待合并/清理完成...');
        try { await this._finishPromise; } catch (e) { /* 收尾错误已在其内部记录 */ }
      }
      return;
    }

    this.recording = false;
    this._isManualStop = true; // 标记为手动停止，跳过5分钟合并延迟
    if (this._stallWatchdog) { clearInterval(this._stallWatchdog); this._stallWatchdog = null; }
    // 主动停止（用户手动停止/检测到下播），走完整合并流程后再通知上层
    if (!this._stopReason) this._stopReason = 'manual';
    logger.info(`[Recorder] 停止录制: ${this.streamerName} (手动停止)`);

    await this._finishRecording();
  }

  /**
   * 完成录制流程：停止采集 → 合并 → 清理
   * v2.13.30 单例防重入：stopRecording / FFmpeg close 回调 / 下播检测可能并发触发，
   * 重入时返回同一 Promise，避免并发收尾互相删除对方的合并输入。
   */
  _finishRecording() {
    if (this._finishPromise) return this._finishPromise;
    this._finishPromise = (async () => {
      try {
        await this._doFinishRecording();
      } finally {
        this._finishSettled = true;
      }
    })();
    return this._finishPromise;
  }

  async _doFinishRecording() {
    // Step 1: 停止 FFmpeg 流录制
    await this._stopFFmpeg();

    // Step 2: 停止评论区捕获（v2.13.24起为async：需等待动态扩宽的旧帧补齐任务完成，保证合并时帧尺寸一致）
    let commentInfo = null;
    if (this.commentRenderer) {
      commentInfo = await this.commentRenderer.stopCapture();
    }

    // Step 2.5: 停止左侧面板捕获（复用评论区同一窗口产生，随 commentInfo.leftPanelInfo 返回）
    let leftPanelInfo = null;
    if (commentInfo && commentInfo.leftPanelInfo) {
      leftPanelInfo = commentInfo.leftPanelInfo;
      this._leftPanelInfo = leftPanelInfo;
    }
    if (this.leftPanelRenderer) {
      leftPanelInfo = this.leftPanelRenderer.stopCapture();
      this._leftPanelInfo = leftPanelInfo;
    }

    // Step 3: 合并直播流和评论区
    // v2.13.29 分段直写后 _tempStreamFile 指向最后一段；极端场景（停滞重启后立即下播）该文件可能
    // 尚未落盘而首段 stream.mp4 已有内容——流存在性改为扫描首段+所有分段任一非空。
    let streamFileExists = fs.existsSync(this._tempStreamFile);
    if (!streamFileExists && this._tempDir) {
      try {
        streamFileExists = fs.readdirSync(this._tempDir).some((f) =>
          /^stream(_part\d+)?\.mp4$/.test(f) && fs.statSync(path.join(this._tempDir, f)).size > 0);
      } catch (e) { /* ignore */ }
    }

    // 判定是否有关注区帧：优先扫描帧目录实际文件数，避免 commentRenderer 为 null（如回滚失败/初始化失败）时误判
    let commentFrameFiles = 0;
    try {
      if (this._commentFramesDir && fs.existsSync(this._commentFramesDir)) {
        commentFrameFiles = fs.readdirSync(this._commentFramesDir)
          .filter((f) => /^frame_\d{6}\.jpg$/.test(f)).length;
      }
    } catch (e) { /* 忽略扫描错误 */ }

    const commentInfoFrameCount = (commentInfo && commentInfo.frameCount) || 0;
    const hasCommentFrames = commentInfoFrameCount > 0 || commentFrameFiles > 0;

    // 判定是否有左侧面板帧（注意：左侧面板帧文件名前缀为 left_frame_）
    let leftPanelFrameFiles = 0;
    try {
      if (this._leftPanelFramesDir && fs.existsSync(this._leftPanelFramesDir)) {
        leftPanelFrameFiles = fs.readdirSync(this._leftPanelFramesDir)
          .filter((f) => /^left_frame_\d{6}\.jpg$/.test(f)).length;
      }
    } catch (e) { /* 忽略扫描错误 */ }

    const leftPanelInfoFrameCount = (leftPanelInfo && leftPanelInfo.frameCount) || 0;
    const hasLeftPanelFrames = leftPanelInfoFrameCount > 0 || leftPanelFrameFiles > 0;

    // 流中断（网络波动等）场景：直播间可能仍在直播。
    // 这里不再让上层干等合并完成（可能数分钟）才重启录制，而是：
    // 1) 提前销毁评论区渲染窗口（帧已保存到磁盘，合并不再需要窗口，避免与新录制的评论窗口冲突）
    // 2) 立即通知上层「流中断」，由上层马上检测并重启新一轮录制
    // 3) 本实例的合并/清理继续在后台执行，完成后照常发 'stopped'
    if (this._stopReason === 'stream-interrupted') {
      if (this.commentRenderer) {
        try { await this.commentRenderer.destroy(); } catch (e) { /* ignore */ }
        this.commentRenderer = null;
      }
      if (this.leftPanelRenderer) {
        try { await this.leftPanelRenderer.destroy(); } catch (e) { /* ignore */ }
        this.leftPanelRenderer = null;
      }
      logger.warn('[Recorder] 流中断：合并转后台执行，立即通知上层重启录制');
      this.onStatusChange('stream-interrupted', {
        roomId: this.roomId,
        streamerName: this.streamerName,
        outputFile: this.outputFile,
        // 启动失败熔断判定数据：FFmpeg 进程存活时长 + 是否输出过第一帧
        aliveMs: this._launchTime ? Date.now() - this._launchTime : null,
        hadFirstFrame: !!this._firstFrameReceived
      });
    }

    // 诊断：评论区渲染器可能因账号冲突回滚、页面容器缺失等未捕获到帧
    if (streamFileExists && !commentFrameFiles && !commentInfo) {
      logger.warn('[Recorder] 合并诊断: 直播间未捕获到任何评论区帧。commentRenderer状态=' +
        (this.commentRenderer ? '运行中' : '已销毁/未创建') + ', recordMode=' + this.recordMode +
        ', 帧目录=' + (this._commentFramesDir || 'N/A') + '. 将在输出中保留纯直播流。');
    }

    if (streamFileExists && hasCommentFrames) {
      // 有直播流 + 有评论区帧 → 根据停止原因决定是否延迟合并
      if (this._isManualStop) {
        logger.info(`[Recorder] 手动停止，立即开始合并直播流和评论区... (副本: commentInfo=${commentInfoFrameCount}帧, 实际帧文件=${commentFrameFiles})`);
      } else {
        logger.info(`[Recorder] 等待 5 分钟后开始合并直播流和评论区... (副本: commentInfo=${commentInfoFrameCount}帧, 实际帧文件=${commentFrameFiles})`);
        await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000)); // 5 分钟
      }
      logger.info('[Recorder] 开始合并直播流和评论区...');
      this.onStatusChange('merging', {
        roomId: this.roomId,
        streamerName: this.streamerName,
        commentFrames: commentFrameFiles || commentInfoFrameCount,
        commentFps: (commentInfo && commentInfo.fps) || this.commentFps
      });

      try {
        // commentInfo 为 null（渲染器已销毁）但帧目录仍有文件时，构造默认 commentInfo 以便触发合并。
        // v2.13.28：fps 不能直接用目标值 this.commentFps（capturePage 耗时使实际 fps 常低于目标，
        // 固定帧率兜底编码时长会失真）——优先从 timestamps.json 推算实际平均帧率。
        const fpsFromTimestamps = (dir, frameCount) => {
          try {
            const tsFile = path.join(dir, 'timestamps.json');
            if (frameCount > 1 && fs.existsSync(tsFile)) {
              const arr = JSON.parse(fs.readFileSync(tsFile, 'utf8'));
              if (Array.isArray(arr) && arr.length >= frameCount && arr[frameCount - 1] > 0) {
                return frameCount / (arr[frameCount - 1] / 1000);
              }
            }
          } catch (e) { /* ignore */ }
          return null;
        };
        const mergeCommentInfo = commentInfo || {
          frameCount: commentFrameFiles,
          outputDir: this._commentFramesDir,
          fps: fpsFromTimestamps(this._commentFramesDir, commentFrameFiles) || this.commentFps,
          duration: 0,
          timestamps: [],
          width: 0,
          height: 0
        };
        // 左侧面板信息（如果有）
        const mergeLeftPanelInfo = leftPanelInfo || (hasLeftPanelFrames ? {
          frameCount: leftPanelFrameFiles,
          outputDir: this._leftPanelFramesDir,
          fps: fpsFromTimestamps(this._leftPanelFramesDir, leftPanelFrameFiles) || this.commentFps,
          duration: 0,
          width: 0,
          height: 0
        } : null);
        await this._mergeStreamAndComments(mergeCommentInfo, undefined, undefined, undefined, mergeLeftPanelInfo);
        this._mergeResult = { success: true, outputFile: this.outputFile };
      } catch (mergeErr) {
        logger.error('[Recorder] 合并失败:', mergeErr.message);
        // 合并失败时，删除可能存在的部分合并文件，然后保留原始直播流文件作为兜底
        try {
          if (fs.existsSync(this.outputFile)) {
            fs.unlinkSync(this.outputFile);
            logger.info('[Recorder] 已删除部分合并文件');
          }
        } catch (unlinkErr) {
          logger.warn('[Recorder] 删除部分合并文件失败:', unlinkErr.message);
        }
        try {
          // 分片源 → 标准化 remux 为标准 MP4（保证可播放）
          await this._normalizeStream(this.outputFile);
          logger.info('[Recorder] 已将原始直播流标准化为输出文件（合并失败兜底）');
          this._mergeResult = { success: true, fallback: true, normalized: true };
        } catch (copyErr) {
          logger.error('[Recorder] 标准化兜底文件也失败:', copyErr.message);
        }
      }
    } else if (streamFileExists) {
      // 只有直播流，没有评论区 → 标准化为标准 MP4（分片源需重写 moov 才稳定可播）
      logger.warn('[Recorder] 无评论区帧，标准化直播流文件');
      try {
        await this._normalizeStream(this.outputFile);
      } catch (e) {
        logger.error('[Recorder] 标准化文件失败:', e.message);
      }
      this._mergeResult = { success: true, noComments: true };
    } else {
      logger.error('[Recorder] 直播流临时文件不存在');
      this._mergeResult = { success: false, error: '直播流临时文件不存在' };
    }

    // Step 4: 清理临时文件
    await this._cleanupTempFiles({ fromFinish: true });

    // Step 5: 销毁评论区渲染器
    if (this.commentRenderer) {
      await this.commentRenderer.destroy();
      this.commentRenderer = null;
    }

    // 通知完成
    const fileSize = this._getFileSize();
    const actualMerged = this._mergeResult && this._mergeResult.success === true;
    this._lastRecordingResult = {
      hasAudio: this.hasAudio,
      merged: actualMerged,
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
      merged: actualMerged,
      commentFrames: commentInfo ? commentInfo.frameCount : 0,
      mergeResult: this._mergeResult
    });
  }

  /**
   * 将分片 MP4 源标准化为普通 MP4（重写 moov 到文件头 +faststart）
   * 用于「无评论区」或「合并失败兜底」场景，保证最终文件在任意播放器可播
   * @param {string} outputFile 输出文件路径
   */
  /**
   * 获取完整流文件（v2.13.29 修订）：流分段直写语义——stream.mp4 为首段，
   * stream_part1..N 为后续段（停滞/回绕重启产生）。存在分段时按录制顺序 concat 拼接
   * （stream copy，不重编码）为 stream_full.mp4 返回；无分段直接返回当前流文件。
   * 段间 gap（重启耗时，通常数秒）在拼接后被压缩，对评论时间轴影响可忽略，但内容不再丢失。
   */
  async _getFullStreamFile() {
    if (!this._tempDir) return this._tempStreamFile;
    let segFiles = [];
    try {
      segFiles = fs.readdirSync(this._tempDir)
        .filter(f => /^stream_part\d+\.mp4$/.test(f))
        .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    } catch (e) { /* ignore */ }

    const parts = [];
    // v2.13.29 顺序：stream.mp4（首段）在前，stream_part1..N（重启后续段）升序在后
    const firstSeg = path.join(this._tempDir, 'stream.mp4');
    if (fs.existsSync(firstSeg) && fs.statSync(firstSeg).size > 0) {
      parts.push(firstSeg);
    }
    for (const f of segFiles) {
      const p = path.join(this._tempDir, f);
      try { if (fs.statSync(p).size > 0) parts.push(p); } catch (e) { /* ignore */ }
    }
    if (parts.length <= 1) return parts.length === 1 ? parts[0] : this._tempStreamFile;

    const fullFile = path.join(this._tempDir, 'stream_full.mp4');
    const listFile = path.join(this._tempDir, '_stream_concat.txt');
    const listContent = ['ffconcat version 1.0']
      .concat(parts.map(p => `file '${p.replace(/\\/g, '/')}'`))
      .join('\n');
    fs.writeFileSync(listFile, listContent, 'utf8');
    logger.warn(`[Recorder] 检测到 ${parts.length} 段流文件（流重启分段），concat 拼接为完整流: ${parts.map(p => path.basename(p)).join(' + ')}`);

    const resolvedPath = getFFmpegPath();
    await new Promise((resolve, reject) => {
      const args = [
        '-fflags', '+genpts',
        '-f', 'concat', '-safe', '0',
        '-i', listFile,
        '-c', 'copy',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-y', fullFile
      ];
      const proc = spawn(resolvedPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(fullFile) && fs.statSync(fullFile).size > 0) resolve();
        else reject(new Error(`流分段拼接失败 (code ${code}): ${stderr.slice(-300)}`));
      });
      proc.on('error', reject);
    }).catch((e) => {
      // 拼接失败兜底：用最后一段（行为同旧版，至少保留最近内容），日志明确提示
      logger.error(`[Recorder] 流分段拼接失败，回退使用最后一段（前 ${parts.length - 1} 段内容丢失）: ${e.message}`);
    });
    return (fs.existsSync(fullFile) && fs.statSync(fullFile).size > 0) ? fullFile : this._tempStreamFile;
  }

  async _normalizeStream(outputFile) {
    const resolvedPath = getFFmpegPath();
    // 多段流（流重启分段）先拼接为完整流再标准化（v2.13.28）
    const streamSrc = await this._getFullStreamFile();
    if (!fs.existsSync(streamSrc)) {
      throw new Error('直播流临时文件不存在，无法标准化');
    }
    logger.info(`[Recorder] 标准化直播流为普通MP4: ${outputFile}`);
    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-i', streamSrc,
        '-c', 'copy',               // 不重编码，仅 remux
        '-movflags', '+faststart',  // moov 移到文件头，便于快速起播
        outputFile
      ];
      const proc = spawn(resolvedPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this._mergeProcesses = this._mergeProcesses || new Set();
      this._mergeProcesses.add(proc);
      const unregisterProc = () => { try { this._mergeProcesses.delete(proc); } catch (e) {} };
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
      proc.on('close', (code) => {
        unregisterProc();
        if (code === 0 && fs.existsSync(outputFile)) {
          resolve();
        } else {
          reject(new Error(`标准化失败 (code ${code}): ${stderr.slice(-300)}`));
        }
      });
      proc.on('error', (err) => { unregisterProc(); reject(err); });
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
   * 探测视频文件分辨率
   */
  _probeVideoResolution(filePath) {
    try {
      // 使用 execFileSync 避免 Windows 路径中特殊字符(中文/emoji)的 shell 转义问题
      // ffmpeg -i 不指定输出会返回非零退出码，信息在 stderr 中
      execFileSync(getFFmpegPath(), ['-i', filePath], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true
      });
    } catch (e) {
      // ffmpeg -i 总是返回非零退出码，分辨率信息在 stderr 中
      // 注意：Video: 和分辨率可能不在同一行，需要用 [\s\S] 跨行匹配
      try {
        const errOutput = e.stderr || e.stdout || e.message || '';
        const match = errOutput.match(/Video:[\s\S]*?(\d{2,5})x(\d{2,5})/);
        if (match) {
          // 同时解析帧率: 形如 "30 tbr" 或 "30 fps"
          let fps = 30;
          const fpsMatch = errOutput.match(/Video:[\s\S]*?([\d.]+)\s*(?:tbr|fps)/);
          if (fpsMatch) {
            const v = parseFloat(fpsMatch[1]);
            if (v > 0 && v <= 240) fps = v;
          }
          return { width: parseInt(match[1]), height: parseInt(match[2]), fps };
        }
      } catch (e2) { /* ignore */ }
      logger.warn('[Recorder] 探测视频分辨率失败:', e.message?.substring(0, 200));
    }
    return { width: 1920, height: 1080, fps: 30 }; // 默认横屏
  }

  /**
   * 合并直播流视频和评论区帧序列（支持左侧面板/特效区）
   *
   * 流程:
   *   1. 探测直播流原始分辨率
   *   2. 将评论区 JPEG 帧编码为视频 (comment_video.mp4)
   *   3. 可选：将左侧面板 JPEG 帧编码为视频 (left_panel_video.mp4)
   *   4. 根据直播流方向（横屏/竖屏）计算布局，使用 overlay 拼接
   *   5. 音频从直播流直接复制
   * @param {object} commentInfo - 评论区信息
   * @param {string} [streamFileOverride] - 可选，直播流文件路径（用于手动合并）
   * @param {string} [commentFileOverride] - 可选，评论区视频文件路径（用于手动合并）
   * @param {string} [outputFileOverride] - 可选，输出文件路径（用于手动合并）
   * @param {object} [leftPanelInfo] - 可选，左侧面板信息（特效区模式）
   */
  async _mergeStreamAndComments(commentInfo, streamFileOverride, commentFileOverride, outputFileOverride, leftPanelInfo) {
    const resolvedPath = getFFmpegPath();
    // 多段流（流重启分段 stream_partN.mp4）先拼接为完整流再参与合并（v2.13.28）
    const streamFile = streamFileOverride || await this._getFullStreamFile();
    const commentVideoFile = commentFileOverride || path.join(this._tempDir, 'comment_video.mp4');
    const leftPanelVideoFile = path.join(this._tempDir, 'left_panel_video.mp4');
    const outputFile = outputFileOverride || this.outputFile;
    // 注意：必须用 let 而非 const——左侧特效区视频编码失败时（1274行）会降级置 false 走双区域合并，
    // 若用 const 重新赋值会抛 TypeError，导致本应降级的合并直接崩溃、丢失评论区与特效区
    let hasLeftPanel = !!leftPanelInfo && leftPanelInfo.frameCount > 0;
    
    // 设置合并进度文件路径
    const progressDir = streamFileOverride ? path.dirname(streamFile) : this._tempDir;
    this._mergeProgressFile = path.join(progressDir, 'merge_progress.json');

    // 探测直播流原始分辨率
    const streamRes = this._probeVideoResolution(streamFile);
    const isPortrait = streamRes.height > streamRes.width;

    // 保存初始合并进度
    this._saveMergeProgress({
      phase: 'init',
      phaseName: '初始化合并',
      totalFrames: commentInfo.frameCount,
      currentFrame: 0,
      fps: commentInfo.fps,
      progress: 0,
      commentVideoFile,
      streamRes,
      isPortrait
    });
    logger.info(`[Merge] 直播流分辨率: ${streamRes.width}x${streamRes.height}, 方向: ${isPortrait ? '竖屏' : '横屏'}`);

    // 计算缩放后的直播流尺寸（保持宽高比，以 TARGET_HEIGHT 为基准）
    // 宽度向上取偶数，确保 FFmpeg 编码兼容
    const streamScaleH = TARGET_HEIGHT;
    const streamScaleW = Math.ceil(TARGET_HEIGHT * streamRes.width / streamRes.height / 2) * 2;

    // 评论区高度与直播流对齐，宽度按评论帧原始宽高比缩放（而非固定比例）
    const commentScaleH = streamScaleH;
    const commentAspectW = commentInfo.width || COMMENT_WIDTH;
    const commentAspectH = commentInfo.height || COMMENT_HEIGHT;
    const commentScaleW = Math.ceil(commentAspectW * commentScaleH / commentAspectH / 2) * 2;

    // 左侧面板尺寸计算（如果有）
    let leftPanelScaleW = 0;
    let leftPanelScaleH = 0;
    if (hasLeftPanel) {
      leftPanelScaleH = streamScaleH;
      const leftPanelAspectW = leftPanelInfo.width || 400;
      const leftPanelAspectH = leftPanelInfo.height || 1080;
      leftPanelScaleW = Math.ceil(leftPanelAspectW * leftPanelScaleH / leftPanelAspectH / 2) * 2;
      logger.info(`[Merge] 左侧面板尺寸: ${leftPanelAspectW}x${leftPanelAspectH} -> ${leftPanelScaleW}x${leftPanelScaleH}`);
    }

    const separatorW = 2;
    const totalWidth = leftPanelScaleW > 0 
      ? leftPanelScaleW + separatorW + streamScaleW + separatorW + commentScaleW
      : streamScaleW + separatorW + commentScaleW;
    const outputHeight = streamScaleH;

    if (hasLeftPanel) {
      logger.info(`[Merge] 三区域布局: 左侧面板 ${leftPanelScaleW}x${leftPanelScaleH} + 直播 ${streamScaleW}x${streamScaleH} + 评论 ${commentScaleW}x${commentScaleH} = ${totalWidth}x${outputHeight}`);
    } else {
      logger.info(`[Merge] 布局: 直播 ${streamScaleW}x${streamScaleH} + 评论 ${commentScaleW}x${commentScaleH} = ${totalWidth}x${outputHeight}`);
    }

    // ===== 三路时间轴统一（v2.13.26）=====
    // 源视频真实起点 = 流录制首帧时刻（this.startTime，FFmpeg stderr 首次 frame= 输出）；
    // 评论/左特效区真实起点 = this._commentStartEpoch（首段捕获起点，回滚续帧时保持不变）。
    // 两路存在启动时间差（FFmpeg spawn 到首帧通常有数秒延迟，评论捕获立即开始），
    // 合并时评论/左侧视频按该偏移 setpts 平移对齐；输出统一 -t 截断，三路等长。
    let streamDurationMs = 0;
    try {
      streamDurationMs = await Recorder._getMediaDuration(streamFile);
    } catch (e) {
      logger.warn(`[Merge] 探测源视频时长失败，回退墙钟估算: ${e.message}`);
    }
    if (!streamDurationMs || streamDurationMs <= 0) {
      streamDurationMs = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    }
    const streamStartEpoch = this.startTime ? this.startTime.getTime() : 0;
    const commentStartEpoch = this._commentStartEpoch || commentInfo.startEpoch || 0;
    let timelineOffsetMs = (streamStartEpoch && commentStartEpoch) ? (commentStartEpoch - streamStartEpoch) : 0;
    if (!isFinite(timelineOffsetMs) || Math.abs(timelineOffsetMs) > 30000) {
      logger.warn(`[Merge] 时间轴偏移异常 (${timelineOffsetMs}ms)，按 0 处理`);
      timelineOffsetMs = 0;
    }
    const timelineOffsetSec = timelineOffsetMs / 1000;
    logger.info(`[Merge] 三路时间轴对齐: 源视频时长=${(streamDurationMs / 1000).toFixed(1)}s, 评论起点${timelineOffsetMs >= 0 ? '晚' : '早'}于流首帧 ${Math.abs(timelineOffsetMs)}ms`);

    // 读取评论逐帧真实时间戳（concat demuxer 精确控时，消除 capturePage 耗时不均造成的漂移）
    let commentTimestamps = null;
    const commentTsFile = path.join(this._commentFramesDir, 'timestamps.json');
    try {
      if (fs.existsSync(commentTsFile)) {
        const arr = JSON.parse(fs.readFileSync(commentTsFile, 'utf8'));
        // 严格校验：时间戳必须覆盖全部帧，否则 concat 中越界帧会退化为 0.001s 极速闪屏+末帧冻结，
        // 比固定帧率兜底更糟糕（v2.13.28）
        if (Array.isArray(arr) && arr.length >= commentInfo.frameCount) {
          commentTimestamps = arr;
        } else if (Array.isArray(arr)) {
          logger.warn(`[Merge] 评论 timestamps.json 长度不足(${arr.length}<${commentInfo.frameCount})，回退固定帧率编码`);
        }
      }
    } catch (e) {
      logger.warn(`[Merge] 读取评论 timestamps.json 失败，回退固定帧率编码: ${e.message}`);
    }

    // 评论区视频总时长（毫秒）：有时间戳时取末帧时间戳（真实捕获时长），否则按固定帧率估算
    let commentDurationMs = commentTimestamps
      ? Math.round(commentTimestamps[Math.min(commentInfo.frameCount, commentTimestamps.length) - 1])
      : Math.round((commentInfo.frameCount / commentInfo.fps) * 1000);

    // 统一目标时长：三路等长。源视频短则 tpad 末帧补齐；评论/左侧 concat 末帧延长 + 输出 -t 截断。
    const targetDurationMs = Math.max(streamDurationMs, timelineOffsetMs + commentDurationMs);
    const targetDurationSec = targetDurationMs / 1000;

    // Phase 1: 将评论区帧编码为视频
    logger.info(`[Merge] 编码评论区视频: ${commentInfo.frameCount} 帧 @ ${commentInfo.fps.toFixed(1)} fps${commentTimestamps ? '（concat 真实时间戳精确控时）' : '（固定帧率兜底）'}`);

    let commentEncodeCmd;
    if (commentTimestamps) {
      const concatFile = path.join(this._commentFramesDir, '_concat.txt');
      // 末帧延长目标：评论视角下的统一时长（扣除评论相对流的起点偏移）
      Recorder._buildConcatFile(
        this._commentFramesDir, 'frame_', commentInfo.frameCount, commentTimestamps,
        Math.max(1, targetDurationSec - timelineOffsetSec), concatFile
      );
      commentEncodeCmd = [
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        // 必须保留逐帧真实时间戳：默认 vsync=auto(cfr) 会把 VFR 按平均帧率重采样回均匀时间轴，
        // concat 的逐帧 duration 将失效（时间轴漂移修复白费）
        '-vsync', 'passthrough',
        '-vf', `scale=${commentScaleW}:${commentScaleH},setsar=1`,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '15',
        '-pix_fmt', 'yuv420p',
        '-y',
        commentVideoFile
      ];
    } else {
      commentEncodeCmd = [
        '-f', 'image2',
        '-framerate', String(commentInfo.fps),
        '-start_number', '0',
        '-i', path.join(this._commentFramesDir, 'frame_%06d.jpg'),
        '-vf', `scale=${commentScaleW}:${commentScaleH},setsar=1`,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '15',
        '-pix_fmt', 'yuv420p',
        '-y',
        commentVideoFile
      ];
    }

    // 保存评论区编码阶段的进度数据（供 _runFFmpeg 读取）
    this._mergeProgressData = {
      totalFrames: commentInfo.frameCount,
      fps: commentInfo.fps,
      phase: 'Merge-Comment'
    };
    this._saveMergeProgress({
      phase: 'Merge-Comment',
      phaseName: '编码评论区',
      totalFrames: commentInfo.frameCount,
      currentFrame: 0,
      fps: commentInfo.fps,
      progress: 0
    });

    if (commentTimestamps) {
      // concat 精确控时为主路径；失败自动降级 image2 固定帧率重试，杜绝合并失败丢评论区（v2.13.27）
      try {
        await this._runFFmpeg(resolvedPath, commentEncodeCmd, 'Merge-Comment', commentDurationMs, '编码评论区');
      } catch (e) {
        logger.warn(`[Merge] concat 精确控时编码失败，降级固定帧率 ${commentInfo.fps.toFixed(1)}fps 重试（${e.message || e}）`);
        commentEncodeCmd = [
          '-f', 'image2',
          '-framerate', String(commentInfo.fps),
          '-start_number', '0',
          '-i', path.join(this._commentFramesDir, 'frame_%06d.jpg'),
          '-vf', `scale=${commentScaleW}:${commentScaleH},setsar=1`,
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '15',
          '-pix_fmt', 'yuv420p',
          '-y',
          commentVideoFile
        ];
        commentDurationMs = Math.round((commentInfo.frameCount / commentInfo.fps) * 1000);
        await this._runFFmpeg(resolvedPath, commentEncodeCmd, 'Merge-Comment', commentDurationMs, '编码评论区(固定帧率降级)');
      }
    } else {
      await this._runFFmpeg(resolvedPath, commentEncodeCmd, 'Merge-Comment', commentDurationMs, '编码评论区');
    }

    if (!fs.existsSync(commentVideoFile)) {
      throw new Error('评论区视频编码失败');
    }

    // Phase 1.5: 编码左侧面板视频（如果有）
    if (hasLeftPanel) {
      logger.info(`[Merge] 编码左侧面板视频: ${leftPanelInfo.frameCount} 帧 @ ${leftPanelInfo.fps.toFixed(1)} fps`);

      // 左侧帧与评论帧同一次 capturePage 同时裁剪，共享同一时间戳（v2.13.26 起写入左侧目录），同样 concat 精确控时
      let leftTimestamps = null;
      const leftTsFile = path.join(this._leftPanelFramesDir, 'timestamps.json');
      try {
        if (fs.existsSync(leftTsFile)) {
          const arr = JSON.parse(fs.readFileSync(leftTsFile, 'utf8'));
          if (Array.isArray(arr) && arr.length >= leftPanelInfo.frameCount) {
            leftTimestamps = arr;
          } else if (Array.isArray(arr)) {
            logger.warn(`[Merge] 左侧 timestamps.json 长度不足(${arr.length}<${leftPanelInfo.frameCount})，回退固定帧率编码`);
          }
        }
      } catch (e) {
        logger.warn(`[Merge] 读取左侧 timestamps.json 失败，回退固定帧率编码: ${e.message}`);
      }
      // 左侧时间戳与评论共享，缺失时可复用评论的（同帧序列）
      if (!leftTimestamps && commentTimestamps && commentTimestamps.length >= leftPanelInfo.frameCount) {
        leftTimestamps = commentTimestamps;
        logger.info('[Merge] 左侧 timestamps.json 缺失，复用评论区时间戳（同帧序列）');
      }

      let leftPanelEncodeCmd;
      if (leftTimestamps) {
        const leftConcatFile = path.join(this._leftPanelFramesDir, '_concat.txt');
        Recorder._buildConcatFile(
          this._leftPanelFramesDir, 'left_frame_', leftPanelInfo.frameCount, leftTimestamps,
          Math.max(1, targetDurationSec - timelineOffsetSec), leftConcatFile
        );
        leftPanelEncodeCmd = [
          '-f', 'concat',
          '-safe', '0',
          '-i', leftConcatFile,
          // 保留逐帧真实时间戳（同评论区，防默认 cfr 重采样抹平）
          '-vsync', 'passthrough',
          '-vf', `scale=${leftPanelScaleW}:${leftPanelScaleH},setsar=1`,
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '15',
          '-pix_fmt', 'yuv420p',
          '-y',
          leftPanelVideoFile
        ];
      } else {
        leftPanelEncodeCmd = [
          '-f', 'image2',
          '-framerate', String(leftPanelInfo.fps),
          '-start_number', '0',
          '-i', path.join(this._leftPanelFramesDir, 'left_frame_%06d.jpg'),
          '-vf', `scale=${leftPanelScaleW}:${leftPanelScaleH},setsar=1`,
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '15',
          '-pix_fmt', 'yuv420p',
          '-y',
          leftPanelVideoFile
        ];
      }

      if (leftTimestamps) {
        // concat 精确控时为主路径；失败自动降级 image2 固定帧率重试（v2.13.27）
        try {
          await this._runFFmpeg(resolvedPath, leftPanelEncodeCmd, 'Merge-LeftPanel', commentDurationMs, '编码左侧面板');
        } catch (e) {
          logger.warn(`[Merge] 左侧面板 concat 编码失败，降级固定帧率 ${leftPanelInfo.fps.toFixed(1)}fps 重试（${e.message || e}）`);
          leftPanelEncodeCmd = [
            '-f', 'image2',
            '-framerate', String(leftPanelInfo.fps),
            '-start_number', '0',
            '-i', path.join(this._leftPanelFramesDir, 'left_frame_%06d.jpg'),
            '-vf', `scale=${leftPanelScaleW}:${leftPanelScaleH},setsar=1`,
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '15',
            '-pix_fmt', 'yuv420p',
            '-y',
            leftPanelVideoFile
          ];
          await this._runFFmpeg(resolvedPath, leftPanelEncodeCmd, 'Merge-LeftPanel', commentDurationMs, '编码左侧面板(固定帧率降级)');
        }
      } else {
        await this._runFFmpeg(resolvedPath, leftPanelEncodeCmd, 'Merge-LeftPanel', commentDurationMs, '编码左侧面板');
      }

      if (!fs.existsSync(leftPanelVideoFile)) {
        logger.warn('[Merge] 左侧面板视频编码失败，将使用双区域合并');
        hasLeftPanel = false;
      }
    }

    // Phase 1 完成，更新进度
    this._saveMergeProgress({
      phase: 'Merge-Comment-Done',
      phaseName: '编码评论区完成',
      totalFrames: commentInfo.frameCount,
      currentFrame: commentInfo.frameCount,
      fps: commentInfo.fps,
      progress: 100
    });

    // Phase 2: 合并直播流 + 评论区视频（+ 左侧面板视频）
    // 使用 pad 显式扩展画布到 totalWidth，再 overlay 评论区
    // 兼容旧版 FFmpeg（overlay 不会自动扩展画布的问题）
    const totalWithSep = totalWidth;

    // 进度分母使用统一目标时长（v2.13.26：streamDurationMs 已在 Phase 1 前探测完成）
    const mergeFinalDurationMs = targetDurationMs;

    // 源视频短于统一目标时长时，在源视频末尾 tpad 克隆末帧补齐（评论/左侧视频由 concat 末帧延长对齐，此处不再探测其时长）
    const durationDiffMs = targetDurationMs - streamDurationMs;
    const needsPadding = durationDiffMs > 1000; // 时长差超过 1 秒才需要补偿

    if (needsPadding) {
      logger.info(`[Merge] 源视频时长 (${(streamDurationMs / 1000).toFixed(1)}s) 小于统一目标时长 (${(targetDurationMs / 1000).toFixed(1)}s)，tpad 补偿 ${(durationDiffMs / 1000).toFixed(1)}s`);
    }

    // 评论/左特效区时间轴平移量（setpts，秒）：评论捕获起点相对流首帧起点的偏移
    const offsetPts = timelineOffsetSec.toFixed(3);

    // 保存最终合并阶段的进度数据
    this._mergeProgressData = {
      totalFrames: commentInfo.frameCount,
      fps: commentInfo.fps,
      phase: 'Merge-Final'
    };
    this._saveMergeProgress({
      phase: 'Merge-Final',
      phaseName: '合并视频',
      totalFrames: commentInfo.frameCount,
      currentFrame: 0,
      fps: commentInfo.fps,
      progress: 0
    });

    // 构建 FFmpeg 合并命令
    let mergeArgs;
    if (needsPadding) {
      // 源视频需要补偿：在源视频后面添加黑屏帧
      // 使用 tpad 滤镜在源视频末尾添加黑屏帧
      const paddingDurationSec = (durationDiffMs / 1000).toFixed(3);
      
      if (hasLeftPanel) {
        // 三区域合并：左侧面板 + 直播流 + 评论区
        mergeArgs = [
          '-fflags', '+genpts',
          '-err_detect', 'ignore_err',
          '-i', streamFile,
          '-i', commentVideoFile,
          '-i', leftPanelVideoFile,
          '-filter_complex',
            `[0:v]setpts=PTS-STARTPTS,fps=${streamRes.fps || 30},scale=${streamScaleW}:${streamScaleH},setsar=1,tpad=stop_mode=clone:stop_duration=${paddingDurationSec}[stream];` +
            `[1:v]setpts=PTS+(${offsetPts})/TB,scale=${commentScaleW}:${commentScaleH},setsar=1[comments];` +
            `[2:v]setpts=PTS+(${offsetPts})/TB,scale=${leftPanelScaleW}:${leftPanelScaleH},setsar=1[leftpanel];` +
            `[leftpanel]pad=${totalWithSep}:${streamScaleH}:0:0:black[canvas];` +
            `[canvas]drawbox=x=${leftPanelScaleW}:y=0:w=${separatorW}:h=${streamScaleH}:color=black@0.5:t=fill[c1];` +
            `[c1][stream]overlay=${leftPanelScaleW + separatorW}:0:eof_action=repeat[c2];` +
            `[c2]drawbox=x=${leftPanelScaleW + separatorW + streamScaleW}:y=0:w=${separatorW}:h=${streamScaleH}:color=black@0.5:t=fill[c3];` +
            `[c3][comments]overlay=${leftPanelScaleW + separatorW + streamScaleW + separatorW}:0:eof_action=repeat[out]`,
          '-map', '[out]',
          '-map', '0:a?',
          '-threads', Math.max(2, (require('os').cpus().length || 4) - 2),
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '15',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-movflags', '+faststart',
          // 统一输出时长（v2.13.26）：三路等长截断，防止评论/左侧 concat 末帧延长导致输出超长
          '-t', targetDurationSec.toFixed(3),
          '-y',
          outputFile
        ];
      } else {
        // 双区域合并：直播流 + 评论区
        mergeArgs = [
          '-fflags', '+genpts',
          '-err_detect', 'ignore_err',
          '-i', streamFile,
          '-i', commentVideoFile,
          '-filter_complex',
            `[0:v]setpts=PTS-STARTPTS,fps=${streamRes.fps || 30},scale=${streamScaleW}:${streamScaleH},setsar=1,tpad=stop_mode=clone:stop_duration=${paddingDurationSec}[stream];` +
            `[1:v]setpts=PTS+(${offsetPts})/TB,scale=${commentScaleW}:${commentScaleH},setsar=1[comments];` +
            `[stream]pad=${totalWithSep}:${streamScaleH}:0:0:black[stream_padded];` +
            `[stream_padded]drawbox=x=${streamScaleW}:y=0:w=${separatorW}:h=${streamScaleH}:color=black@0.5:t=fill[stream_sep];` +
            `[stream_sep][comments]overlay=${streamScaleW + separatorW}:0:eof_action=repeat[out]`,
          '-map', '[out]',
          '-map', '0:a?',
          '-threads', Math.max(2, (require('os').cpus().length || 4) - 2),
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '15',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-movflags', '+faststart',
          // 统一输出时长（v2.13.26）：三路等长截断，防止评论/左侧 concat 末帧延长导致输出超长
          '-t', targetDurationSec.toFixed(3),
          '-y',
          outputFile
        ];
      }
    } else {
      // 源视频和评论区视频时长一致，直接合并
      if (hasLeftPanel) {
        // 三区域合并：左侧面板 + 直播流 + 评论区
        mergeArgs = [
          '-fflags', '+genpts',
          '-err_detect', 'ignore_err',
          '-i', streamFile,
          '-i', commentVideoFile,
          '-i', leftPanelVideoFile,
          '-filter_complex',
            `[0:v]setpts=PTS-STARTPTS,fps=${streamRes.fps || 30},scale=${streamScaleW}:${streamScaleH},setsar=1[stream];` +
            `[1:v]setpts=PTS+(${offsetPts})/TB,scale=${commentScaleW}:${commentScaleH},setsar=1[comments];` +
            `[2:v]setpts=PTS+(${offsetPts})/TB,scale=${leftPanelScaleW}:${leftPanelScaleH},setsar=1[leftpanel];` +
            `[leftpanel]pad=${totalWithSep}:${streamScaleH}:0:0:black[canvas];` +
            `[canvas]drawbox=x=${leftPanelScaleW}:y=0:w=${separatorW}:h=${streamScaleH}:color=black@0.5:t=fill[c1];` +
            `[c1][stream]overlay=${leftPanelScaleW + separatorW}:0:eof_action=repeat[c2];` +
            `[c2]drawbox=x=${leftPanelScaleW + separatorW + streamScaleW}:y=0:w=${separatorW}:h=${streamScaleH}:color=black@0.5:t=fill[c3];` +
            `[c3][comments]overlay=${leftPanelScaleW + separatorW + streamScaleW + separatorW}:0:eof_action=repeat[out]`,
          '-map', '[out]',
          '-map', '0:a?',
          '-threads', Math.max(2, (require('os').cpus().length || 4) - 2),
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '15',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-movflags', '+faststart',
          // 统一输出时长（v2.13.26）：三路等长截断，防止评论/左侧 concat 末帧延长导致输出超长
          '-t', targetDurationSec.toFixed(3),
          '-y',
          outputFile
        ];
      } else {
        // 双区域合并：直播流 + 评论区
        mergeArgs = [
          '-fflags', '+genpts',
          '-err_detect', 'ignore_err',
          '-i', streamFile,
          '-i', commentVideoFile,
          '-filter_complex',
            `[0:v]setpts=PTS-STARTPTS,fps=${streamRes.fps || 30},scale=${streamScaleW}:${streamScaleH},setsar=1[stream];` +
            `[1:v]setpts=PTS+(${offsetPts})/TB,scale=${commentScaleW}:${commentScaleH},setsar=1[comments];` +
            `[stream]pad=${totalWithSep}:${streamScaleH}:0:0:black[stream_padded];` +
            `[stream_padded]drawbox=x=${streamScaleW}:y=0:w=${separatorW}:h=${streamScaleH}:color=black@0.5:t=fill[stream_sep];` +
            `[stream_sep][comments]overlay=${streamScaleW + separatorW}:0:eof_action=repeat[out]`,
        '-map', '[out]',
        '-map', '0:a?',
        '-threads', Math.max(2, (require('os').cpus().length || 4) - 2),
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '15',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        // 统一输出时长（v2.13.26）：三路等长截断
        '-t', targetDurationSec.toFixed(3),
        '-y',
        outputFile
      ];
      }
    }

    await this._runFFmpeg(resolvedPath, mergeArgs, 'Merge-Final', mergeFinalDurationMs, '合并视频');

    if (!fs.existsSync(outputFile)) {
      throw new Error('最终视频合并失败');
    }

    // 合并完成，删除进度文件
    this._deleteMergeProgress();

    const finalSize = fs.statSync(outputFile).size;
    logger.info(`[Merge] 合并完成: ${outputFile}, 大小: ${(finalSize / 1024 / 1024).toFixed(1)} MB`);
  }

  /**
   * 运行 FFmpeg 命令并等待完成
   * @param {string} ffmpegPath - FFmpeg 路径
   * @param {string[]} args - 命令参数
   * @param {string} tag - 日志标签
   * @param {number} [totalDurationMs] - 总时长(毫秒)，用于计算进度
   * @param {string} [phaseName] - 阶段名称，用于进度显示
   * @param {number} [timeoutMs] - 超时时间(毫秒)，默认根据时长动态计算
   */
  _runFFmpeg(ffmpegPath, args, tag, totalDurationMs = 0, phaseName = '', timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      logger.info(`[${tag}] 启动: ${ffmpegPath} ${args.slice(0, 6).join(' ')}...`);

      const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      // 注册合并进程，确保 destroy/应用退出时能统一终止，避免孤儿 FFmpeg 残留
      this._mergeProcesses = this._mergeProcesses || new Set();
      this._mergeProcesses.add(proc);
      const unregisterProc = () => { try { this._mergeProcesses.delete(proc); } catch (e) {} };

      let stderr = '';
      let lastProgressEmit = 0;
      let lastLoggedPercent = -1;
      // 判断是否为 FFmpeg 高频进度统计行（frame=... fps=... time=... bitrate=... speed=...）
      // 这类行每秒输出数十次，不写入日志（否则长时间合并会产生数百万行、上 GB 日志），只用于解析进度。
      const isProgressStat = (s) => /frame=\s*\d+/.test(s) || /(^|\s)time=\d{2}:\d{2}:\d{2}/.test(s) || /^(size|Lsize)=/.test(s);

      const parseProgress = (msg) => {
        // 解析 FFmpeg 进度输出
        if (totalDurationMs > 0 && phaseName) {
          const timeMatch = msg.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
          if (timeMatch) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            const seconds = parseInt(timeMatch[3], 10);
            const centiseconds = parseInt(timeMatch[4], 10);
            const currentTimeMs = ((hours * 3600 + minutes * 60 + seconds) * 1000) + (centiseconds * 10);
            const progress = Math.min(100, Math.round((currentTimeMs / totalDurationMs) * 100));

            // 根据阶段计算当前帧数（用于进度显示和崩溃恢复）
            let currentFrame = 0;
            let totalFrames = 0;
            if (tag === 'Merge-Comment') {
              // 评论区编码阶段：根据时间计算已编码帧数
              totalFrames = this._mergeProgressData?.totalFrames || 0;
              const fps = this._mergeProgressData?.fps || 30;
              currentFrame = Math.min(totalFrames, Math.round((currentTimeMs / 1000) * fps));
            } else if (tag === 'Merge-Final') {
              // 最终合并阶段：进度基于时间，帧数用评论区帧数表示
              totalFrames = this._mergeProgressData?.totalFrames || 0;
              currentFrame = Math.round(totalFrames * progress / 100);
            }

            // 每 500ms 最多发送一次进度更新（UI 刷新）
            const now = Date.now();
            if (now - lastProgressEmit > 500) {
              lastProgressEmit = now;
              const progressData = {
                roomId: this.roomId,
                streamerName: this.streamerName,
                phase: tag,
                phaseName: phaseName,
                progress: progress,
                currentTime: currentTimeMs,
                totalDuration: totalDurationMs,
                currentFrame,
                totalFrames
              };
              // 日志仅在进度跨越整 10% 或到 100% 时记录一条，避免逐帧刷屏
              if (progress === 100 || progress >= lastLoggedPercent + 10) {
                lastLoggedPercent = Math.floor(progress / 10) * 10;
                logger.info(`[Recorder] 合并进度: ${phaseName} ${progress}% (帧 ${currentFrame}/${totalFrames})`);
              }
              this.onProgress(progressData);

              // 持久化进度到文件（每2秒保存一次，避免频繁IO）
              if (now - this._lastProgressSave > 2000) {
                this._lastProgressSave = now;
                this._saveMergeProgress({
                  phase: tag,
                  phaseName,
                  progress,
                  currentTimeMs,
                  totalDurationMs,
                  currentFrame,
                  totalFrames
                });
              }
            }
          }
        }
      };

      // FFmpeg 的进度/诊断全部走 stderr；stdout 一般无内容。
      // 仅记录非进度统计的有意义输出（Input/Stream mapping/编码器信息/Error/Warning）。
      proc.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          if (!isProgressStat(msg)) logger.info(`[${tag}] ${msg.slice(0, 1000)}`);
          parseProgress(msg);
        }
      });

      proc.stderr.on('data', (data) => {
        const msg = data.toString();
        // 仅保留尾部片段用于错误诊断，避免长时间合并时字符串无限增长占用内存
        stderr = (stderr + msg).slice(-8000);
        // FFmpeg 进度常以 \r 刷新，按 \r 或 \n 拆分逐条处理
        const parts = msg.split(/[\r\n]/);
        for (const raw of parts) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          if (!isProgressStat(trimmed)) {
            logger.info(`[${tag}] ${trimmed.slice(0, 1000)}`);
          }
          parseProgress(trimmed);
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutTimer);
        unregisterProc();
        if (code === 0) {
          logger.info(`[${tag}] 完成`);
          resolve();
        } else {
          logger.error(`[${tag}] 退出码: ${code}`);
          reject(new Error(`${tag} 失败, exit code: ${code}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutTimer);
        unregisterProc();
        logger.error(`[${tag}] 进程错误:`, err);
        reject(err);
      });

      // 动态超时：如果未指定则根据媒体时长计算
      // 编码/合并速度通常 1x~3x，保守按 1x 计算再加 5 分钟缓冲
      const effectiveTimeout = timeoutMs > 0
        ? timeoutMs
        : (totalDurationMs > 0 ? totalDurationMs + 300000 : 600000);
      const timeoutMinutes = Math.round(effectiveTimeout / 60000);
      logger.info(`[${tag}] 超时保护: ${timeoutMinutes} 分钟`);

      const timeoutTimer = setTimeout(() => {
        if (proc.exitCode === null) {
          logger.warn(`[${tag}] 超时(${timeoutMinutes}分钟)，强制终止`);
          try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
          unregisterProc();
          reject(new Error(`${tag} 超时`));
        }
      }, effectiveTimeout);
    });
  }

  /**
   * 从已加载直播页面的窗口提取直播流 URL（优先从 <video> 元素的真实 src/currentSrc 提取）
   * 兼容抖音现网对流地址的加密/签名/明文 flv|m3u8 各类情况。
   * @param {BrowserWindow} win 已加载直播页面的 BrowserWindow
   * @returns {Promise<{url:string,type:string,source:string}|null>}
   */
  async _extractVideoSrcFromWindow(win) {
    if (!win || win.isDestroyed()) return null;
    try {
      const result = await win.webContents.executeJavaScript(`
        (function() {
          try {
            const videos = Array.from(document.querySelectorAll('video'));
            const diagnostics = videos.map(v => {
              const src = v.src || v.currentSrc || '';
              return { src: String(src).substring(0, 300), paused: v.paused, readyState: v.readyState };
            });
            // 按优先级收集所有可能的流地址
            const candidates = [];
            for (const v of videos) {
              const src = (v.currentSrc && v.currentSrc.trim()) || (v.src && v.src.trim()) || '';
              if (!src) continue;
              if (src.toLowerCase().startsWith('blob:') || src.toLowerCase().startsWith('http')) {
                candidates.push(src);
                // blob: 通常是对应 MediaSource，取可实际访问的 http 地址优先
                if (!src.toLowerCase().startsWith('blob:')) break;
              }
            }
            // 若 video.src 不可用，尝试 Network/performance 里抓到的流片段（m3u8/flv 关键片段）
            let textMatches = [];
            const html = document.documentElement ? document.documentElement.innerHTML : '';
            const allText = html;
            const flvM = (allText.match(/https?:\/\/[^"'\s]+\.(flv|m3u8)[^"'\s]*/g) || [])
              .map(u => u.replace(/&amp;/g, '&'));
            textMatches = textMatches.concat(flvM);
            // 抖音 web 端标准 alternate link (m3u8, rel=alternate / 移动端)
            const linkHrefs = Array.from(document.querySelectorAll('link[rel="alternate"], link[rel="stream"]'))
              .map(l => (l.getAttribute('href') || '').trim())
              .filter(h => h && (h.toLowerCase().includes('.m3u8') || h.toLowerCase().includes('.flv')))
              .map(h => h.startsWith('//') ? 'https:' + h : h);
            textMatches = textMatches.concat(linkHrefs);
            // 来源优先级: environment_dynamic 加密房间常用 -- 先 alternate link > video_element http > page_text
            const chosen = textMatches.length ? textMatches[0] : (candidates.length ? candidates[0] : null);
            const chosenSrc = textMatches.length ? 'alternate_link' : (candidates.length ? 'video_element' : null);
            // 返回视频元素诊断信息（供失败时定位）
            return {
              url: chosen,
              type: (chosen || '').includes('.m3u8') ? 'hls' : 'flv',
              source: chosenSrc,
              diagnostics
            };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `);
      if (result && result.url) {
        logger.info(`[Recorder] video元素/页面文本提取直播流成功 (来源: ${result.source})`);
        return { url: result.url, type: result.type, source: result.source || 'video_element' };
      }
      if (result) {
        const info = result.diagnostics && result.diagnostics.length
          ? `视频元素数=${result.diagnostics.length}, 样例=${JSON.stringify(result.diagnostics.slice(0, 3)).substring(0, 400)}`
          : `无video元素${result.error ? ', error=' + result.error : ''}`;
        logger.warn(`[Recorder] 页面video提取未拿到流: ${info}`);
      }
      return null;
    } catch (e) {
      logger.warn(`[Recorder] video提取异常: ${e.message}`);
      return null;
    }
  }

  /**
   * 视频轨停滞/时间轴回绕时，尝试重新获取直播流 URL 并重启 FFmpeg 进程
   * @param {boolean} isStall - 是否视频轨停滞
   * @param {boolean} isRewind - 是否时间轴回绕
   */
  async _tryRefreshStreamUrl(isStall, isRewind) {
    let newStreamUrl = null;
    try {
      logger.info('[Recorder] 重新获取直播流 URL...');
      // 优先使用评论区窗口提取（如果有），否则用无渲染模式
      if (this.commentRenderer && this.commentRenderer.captureWindow) {
        const streamInfo = await this._extractStreamUrl();
        if (streamInfo && streamInfo.url) {
          newStreamUrl = streamInfo.url;
          logger.info(`[Recorder] 重新获取直播流 URL 成功 (评论区窗口): ${newStreamUrl.slice(0, 80)}...`);
        }
      } else {
        const streamInfo = await this._getStreamUrlWithoutRenderer();
        if (streamInfo && streamInfo.url) {
          newStreamUrl = streamInfo.url;
          logger.info(`[Recorder] 重新获取直播流 URL 成功 (无渲染模式): ${newStreamUrl.slice(0, 80)}...`);
        }
      }
    } catch (e) {
      logger.warn(`[Recorder] 重新获取直播流 URL 失败: ${e.message}`);
    }

    if (newStreamUrl) {
      // 用新的 URL 重启 FFmpeg 进程（在同一个场次内，不触发 stream-interrupted）
      logger.info(`[Recorder] 用新 URL 重启 FFmpeg 进程: ${this.streamerName}`);
      // 标记为视频轨停滞重启（避免触发 stream-interrupted）
      this._stallUrlRefresh = true;
      // v2.13.29：不再归档(rename)旧流文件——Windows 下 kill 后句柄释放有延迟，同步 rename 报 EBUSY
      // 导致旧内容仍被覆盖。改为 kill 后递增分段计数，新进程直写 stream_part{N}.mp4，旧文件碰都不碰。
      this._streamSegmentCount = (this._streamSegmentCount || 0) + 1;
      try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
      // 更新 URL 并重置统计
      this._streamUrl = newStreamUrl;
      this._dtsDupCount = 0;
      this._dtsRewindCount = 0;
      this._dtsWarnCount = 0;
      // 延迟重启 FFmpeg 进程（等待旧进程完全退出）
      setTimeout(() => {
        if (this.recording && !this.ffmpegProcess) {
          logger.info(`[Recorder] 重启 FFmpeg 进程（新 URL）: ${this.streamerName}`);
          this._stallUrlRefresh = false;
          this._startStreamRecording();
        }
      }, 1000);
    } else {
      // 重新获取 URL 失败，强制重启录制（触发 stream-interrupted）
      logger.warn(`[Recorder] 重新获取直播流 URL 失败，强制重启录制: ${this.streamerName}`);
      try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
    }
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
        const cookieLen = cookies ? cookies.length : 0;
        logger.info(`[Recorder] 已获取 session cookies (长度: ${cookieLen})${cookieLen === 0 ? ' - 警告: cookie为空，可能未登录或登录已失效' : ''}`);
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
    let tempWin = null;
    try {
      const { BrowserWindow } = require('electron');
      tempWin = new BrowserWindow({
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

            // 放宽 video 提取：兼容加密/签名/blob 的流地址（现网 video.src 常含 blob: 或非 .flv/.m3u8 明文）
            const allVideos = Array.from(document.querySelectorAll('video'));
            for (const video of allVideos) {
              const src = (video.currentSrc && video.currentSrc.trim()) || (video.src && video.src.trim()) || '';
              if (!src) continue;
              const low = src.toLowerCase();
              if (low.startsWith('blob:') || low.startsWith('http')) {
                if (low.startsWith('blob:')) return { url: src, type: 'hls', source: 'video_blob' };
                return { url: src, type: low.includes('.m3u8') ? 'hls' : 'flv', source: 'video_element' };
              }
            }

            return null;
          } catch (e) {
            return { error: e.message };
          }
        })()
      `);

      if (domResult && domResult.url) {
        logger.info(`[Recorder] DOM提取直播流成功 (来源: ${domResult.source})`);
        return domResult;
      }
    } catch (domErr) {
      logger.warn('[Recorder] DOM方式提取直播流失败:', domErr.message);
    } finally {
      // 确保临时窗口始终被销毁，防止资源泄漏
      if (tempWin && !tempWin.isDestroyed()) {
        try { tempWin.destroy(); } catch (e) { /* ignore */ }
      }
    }

    // 从已登录的捕获窗口 video 元素直接提取（兼容加密/签名/blob 流地址）
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      const videoSrc = await this._extractVideoSrcFromWindow(this.captureWindow);
      if (videoSrc && videoSrc.url) {
        logger.info(`[Recorder] 捕获窗口video元素提取直播流成功 (来源: ${videoSrc.source})`);
        return videoSrc;
      }
    }

    // 汇总诊断：帮助快速区分"未登录/cookie失效"、"数据结构变化"、"直播间特殊加密"等失败方向
    const hasCaptureWin = !!(this.captureWindow && !this.captureWindow.isDestroyed());
    logger.warn(`[Recorder] 所有方式均未能提取到直播流URL - 诊断: 捕获窗口=${hasCaptureWin ? '存在' : '无'}, ` +
      `录制模式=${this.recordMode || '未知'}, roomId=${this.roomId}. ` +
      `提示: 若上方日志显示"cookie为空"则为未登录/登录失效；若显示"API返回数据中未找到stream_url"则为该直播间数据结构特殊。`);
    return null;
  }

  /**
   * 不依赖渲染进程获取直播流 URL（用于 stream-only / stream+comment-no-login 模式）
   * 通过 Douyin API 获取，无需登录 cookies
   */
  async _getStreamUrlWithoutRenderer() {
    const roomId = this.roomId;
    logger.info(`[Recorder] 无渲染模式获取直播流URL, roomId: ${roomId}`);

    // 60 秒总超时兜底，避免临时窗口加载/脚本注入永久挂起
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('无渲染模式获取流URL超时（60秒）')), 60000);
    });

    const impl = (async () => {

    // 方式1: 通过 Douyin API 获取（无需 cookies）
    try {
      const apiUrl = `https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=120.0.0.0&web_rid=${roomId}`;
      
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': `https://live.douyin.com/${roomId}`,
      };

      // 如果有 session，尝试获取 cookies
      if (this.session) {
        try {
          const { session } = require('electron');
          const ses = session.fromPartition(this.session);
          const cookies = await ses.cookies.get({ domain: '.douyin.com' });
          const cookieStr = cookies
            .filter(c => c.value && c.name)
            .map(c => `${c.name}=${c.value}`)
            .join('; ');
          if (cookieStr) headers.Cookie = cookieStr;
        } catch (e) {
          // ignore
        }
      }

      const response = await fetch(apiUrl, { headers });
      const data = await response.json();

      if (data && data.data && data.data.length > 0) {
        const roomData = data.data[0];
        const streamUrl = roomData.stream_url?.flv_pull_url?.FULL_HD1 ||
                         roomData.stream_url?.flv_pull_url?.HD1 ||
                         roomData.stream_url?.flv_pull_url?.SD1 ||
                         roomData.stream_url?.flv_pull_url?.SD2 ||
                         null;
        
        if (streamUrl) {
          logger.info(`[Recorder] API获取直播流成功 (无渲染模式)`);
          return { url: streamUrl, type: 'flv', source: 'api_no_renderer' };
        }
      }
    } catch (err) {
      logger.warn(`[Recorder] API获取直播流失败 (无渲染模式): ${err.message}`);
    }

    // 方式2: 创建临时窗口提取（回退方案）
    try {
      const { BrowserWindow, session } = require('electron');
      const tempSession = this.session ? session.fromPartition(this.session) : session.defaultSession;
      
      const tempWin = new BrowserWindow({
        show: false,
        webPreferences: {
          session: tempSession,
          nodeIntegration: false,
          contextIsolation: true,
          offscreen: true
        }
      });
      this._tempStreamWin = tempWin;

      try {
        await tempWin.loadURL(`https://live.douyin.com/${roomId}`, {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          httpReferrer: 'https://www.douyin.com/'
        });

        await new Promise(r => setTimeout(r, 5000));

        const result = await tempWin.webContents.executeJavaScript(`
          (function() {
            try {
              // 从 video 元素获取
              const videos = document.querySelectorAll('video');
              for (const video of videos) {
                const src = (video.currentSrc && video.currentSrc.trim()) || (video.src && video.src.trim()) || '';
                if (!src) continue;
                const low = src.toLowerCase();
                if (low.startsWith('blob:') || low.startsWith('http')) {
                  return { url: src, type: low.includes('.m3u8') ? 'hls' : 'flv', source: 'temp_win_video' };
                }
              }
              // 从页面源码搜索
              const pageText = document.documentElement.innerHTML;
              const flvMatch = pageText.match(/https?:\/\/[^"'\s]+\.flv[^"'\s]*/);
              if (flvMatch) return { url: flvMatch[0], type: 'flv', source: 'temp_win_page' };
              const m3u8Match = pageText.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
              if (m3u8Match) return { url: m3u8Match[0], type: 'hls', source: 'temp_win_page' };
              return null;
            } catch (e) {
              return { error: e.message };
            }
          })()
        `);

        if (result && result.url) {
          logger.info(`[Recorder] 临时窗口提取直播流成功 (来源: ${result.source})`);
          return result;
        }
      } finally {
        if (!tempWin.isDestroyed()) tempWin.destroy();
        this._tempStreamWin = null;
      }
    } catch (err) {
      logger.warn(`[Recorder] 临时窗口提取直播流失败 (无渲染模式): ${err.message}`);
    }

    logger.warn('[Recorder] 无渲染模式所有方式均未能提取到直播流URL');
    return null;
    })();

    return Promise.race([impl, timeoutPromise]);
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
   * 验证直播流 URL 是否有效（通过快速 HTTP 请求检查）
   * @param {string} url - 直播流 URL
   * @returns {Promise<boolean>} - URL 是否有效
   */
  async _validateStreamUrl(url) {
    try {
      logger.info(`[Recorder] 验证直播流 URL: ${url.substring(0, 100)}...`);
      
      // 使用 HEAD 请求快速验证 URL 是否有效
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 秒超时
      
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `https://live.douyin.com/${this.roomId}`,
        }
      });
      
      clearTimeout(timeoutId);
      
      // 检查响应状态码
      if (response.ok) {
        logger.info(`[Recorder] 直播流 URL 验证成功: HTTP ${response.status}`);
        return true;
      } else {
        logger.warn(`[Recorder] 直播流 URL 验证失败: HTTP ${response.status} ${response.statusText}`);
        return false;
      }
    } catch (err) {
      logger.warn(`[Recorder] 直播流 URL 验证异常: ${err.message}`);
      // 如果是网络错误，可能是临时问题，仍然认为 URL 可能有效
      if (err.name === 'AbortError') {
        logger.warn(`[Recorder] 直播流 URL 验证超时，可能网络较慢，继续尝试录制`);
        return true;
      }
      return false;
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
   * 清理临时文件（保留最终输出文件和中间文件）
   */
  async _cleanupTempFiles(options = {}) {
    if (!this._tempDir) return;
    // v2.13.30：收尾（合并）进行中时，非收尾自身的清理一律跳过——
    // 否则 destroy/_cleanup 会删除合并正在读取的评论/特效帧，导致合并失败只剩源视频。
    if (this._finishPromise && !this._finishSettled && !options.fromFinish) {
      logger.warn('[Recorder] 收尾进行中，跳过临时文件清理（保护合并输入）');
      return;
    }
    if (this._tempCleaned) return; // 幂等：避免 destroy 与收尾重复保存/清理
    this._tempCleaned = true;

    // 保存中间文件到输出目录
    await this._saveIntermediateFiles();

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
   * 保存中间文件（stream.mp4 和 comment_video.mp4）到输出目录
   */
  async _saveIntermediateFiles() {
    if (!this.outputFile || !this._tempDir) return;

    const outputDir = path.dirname(this.outputFile);
    const baseName = path.basename(this.outputFile, '.mp4');

    // 保存 stream.mp4（分片源 → 标准化为标准 MP4，保证可播放；多段流先拼接，v2.13.28）
    const streamSrc = await this._getFullStreamFile();
    const streamDst = path.join(outputDir, `${baseName}_stream.mp4`);
    if (streamSrc && fs.existsSync(streamSrc)) {
      try {
        if (streamSrc !== streamDst) {
          // 用标准化的副本来保存，避免分片源直接在播放器中打不开
          const normalizedTmp = path.join(this._tempDir, 'stream_normalized_tmp.mp4');
          await new Promise((resolve, reject) => {
            const args = ['-y', '-i', streamSrc, '-c', 'copy', '-movflags', '+faststart', normalizedTmp];
            const nproc = spawn(getFFmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
            let nerr = '';
            nproc.stderr.on('data', (d) => { nerr += d.toString(); });
            nproc.on('close', (c) => {
              if (c === 0 && fs.existsSync(normalizedTmp)) {
                fs.copyFileSync(normalizedTmp, streamDst);
                try { fs.unlinkSync(normalizedTmp); } catch (_) { /* ignore */ }
                resolve();
              } else reject(new Error('标准化失败'));
            });
            nproc.on('error', reject);
          });
          logger.info(`[Recorder] 已保存直播流文件(标准化): ${streamDst}`);
        } else {
          fs.copyFileSync(streamSrc, streamDst);
        }
      } catch (e) {
        logger.warn(`[Recorder] 保存直播流文件失败: ${e.message}`);
      }
    }

    // 保存 comment_video.mp4
    const commentVideoSrc = path.join(this._tempDir, 'comment_video.mp4');
    const commentVideoDst = path.join(outputDir, `${baseName}_comments.mp4`);
    if (fs.existsSync(commentVideoSrc)) {
      try {
        fs.copyFileSync(commentVideoSrc, commentVideoDst);
        logger.info(`[Recorder] 已保存评论区视频: ${commentVideoDst}`);
      } catch (e) {
        logger.warn(`[Recorder] 保存评论区视频失败: ${e.message}`);
      }
    }

    // 保存 left_panel_video.mp4（特效区视频，三区域模式下生成）
    const leftPanelVideoSrc = path.join(this._tempDir, 'left_panel_video.mp4');
    const leftPanelVideoDst = path.join(outputDir, `${baseName}_effect.mp4`);
    if (fs.existsSync(leftPanelVideoSrc)) {
      try {
        fs.copyFileSync(leftPanelVideoSrc, leftPanelVideoDst);
        logger.info(`[Recorder] 已保存特效区视频: ${leftPanelVideoDst}`);
      } catch (e) {
        logger.warn(`[Recorder] 保存特效区视频失败: ${e.message}`);
      }
    }
  }

  /**
   * 清理所有资源（错误恢复用）
   */
  /**
   * 防呆回滚：检测到评论区账号已被同一账号其它直播间顶下线时，
   * 将本直播间评论区从"有账号"模式自动回滚为"无账号+评论区"（游客）模式，并续帧继续录制，
   * 保证被顶下线直播间的评论区录制不断档、不与同账号其它直播间抢会话。
   */
  async _rollbackCommentToNoLogin() {
    if (this.recordMode === 'stream+comment-no-login') {
      logger.info('[Recorder] 已是无账号模式，无需回滚');
      return;
    }
    if (!this.commentRenderer || !this.recording) {
      logger.info('[Recorder] 评论区渲染器未在运行，跳过回滚');
      return;
    }

    logger.warn('[Recorder] 账号冲突，评论区回滚为无账号模式并续帧重启...');

    // 回滚前保存特效区/榜单启用状态，重建无账号渲染器时保持，避免特效区/榜单录制中断（v2.13.14 修复丢失问题）
    const wasLeftPanelEnabled = !!(this.commentRenderer && this.commentRenderer.enableLeftPanel);
    const wasRankPanelEnabled = !!(this.commentRenderer && this.commentRenderer.enableRankPanel);

    // 1. 停止当前渲染器，拿到已捕获的累计帧数（用于续帧编号，避免覆盖）
    let absoluteCount = 0;
    try {
      const info = await this.commentRenderer.stopCapture();
      absoluteCount = info.frameCount || 0;
      logger.info(`[Recorder] 已记录冲突前评论区帧数: ${absoluteCount}`);
    } catch (e) {
      logger.warn('[Recorder] 停止冲突前渲染器失败:', e.message);
    }

    // 2. 销毁旧渲染器
    try {
      await this.commentRenderer.destroy();
    } catch (e) {
      logger.warn('[Recorder] 销毁冲突渲染器失败:', e.message);
    }
    this.commentRenderer = null;

    // 3. 更新模式字段为无账号模式 + 干净 session
    const cleanSession = 'clean-session-' + this.roomId;
    this.recordMode = 'stream+comment-no-login';
    this.session = cleanSession;
    this.sessionName = cleanSession;

    // 4. 重建无账号评论区渲染器，从已捕获帧数续起
    try {
      this.commentRenderer = new CommentRenderer({
        liveUrl: this.liveUrl,
        roomId: this.roomId,
        session: this.session,
        outputDir: this._commentFramesDir,
        debugDir: path.dirname(this.outputFile),
        fps: this.commentFps,
        sessionName: this.sessionName,
        enableLeftPanel: wasLeftPanelEnabled,
        leftPanelOutputDir: wasLeftPanelEnabled ? this._leftPanelFramesDir : null,
        enableRankPanel: wasRankPanelEnabled,
        noLoginMode: true,
        frameStartIndex: absoluteCount,
        // v2.13.28：传入首段捕获起点作为全局时间轴基准，续帧段时间戳含回滚 gap，
        // 合并端评论时间轴与源视频不再因回滚空档压缩而错位
        globalCaptureStartEpoch: this._commentStartEpoch || null
      });
      await this.commentRenderer.init();
      this.captureWindow = this.commentRenderer.captureWindow;
      this.commentRenderer.startCapture();
      logger.info(`[Recorder] 评论区已回滚为无账号模式，续帧从 ${absoluteCount} 继续录制`);
    } catch (e) {
      logger.error('[Recorder] 回滚重建无账号评论区渲染器失败:', e.message);
      throw e;
    }

    // 5. 通知上层持久化回滚模式
    this.onStatusChange('mode-rolled-back', {
      roomId: this.roomId,
      recordMode: 'stream+comment-no-login',
      savedFrames: absoluteCount
    });
  }

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

    // 终止仍在运行的合并/标准化 FFmpeg 进程（后台合并中退出或销毁时，避免孤儿进程）
    if (this._mergeProcesses && this._mergeProcesses.size > 0) {
      for (const proc of this._mergeProcesses) {
        try {
          if (proc && proc.exitCode === null) {
            if (process.platform === 'win32') {
              execSync(`taskkill /pid ${proc.pid} /f /t 2>nul`, { stdio: 'ignore' });
            } else {
              proc.kill('SIGKILL');
            }
          }
        } catch (e) { /* ignore */ }
      }
      this._mergeProcesses.clear();
    }

    // 销毁 stream-only 模式的临时流提取窗口（避免挂起时泄漏）
    if (this._tempStreamWin) {
      try {
        if (!this._tempStreamWin.isDestroyed()) this._tempStreamWin.destroy();
      } catch (e) { /* ignore */ }
      this._tempStreamWin = null;
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
    this.recording = false;
    if (this._stallWatchdog) { clearInterval(this._stallWatchdog); this._stallWatchdog = null; }
    // v2.13.30：收尾（合并）进行中时被 destroy（如上层旧实例事件串台/重复停止），
    // 必须等收尾完成再清理——否则合并输入帧被删、合并进程被杀，整场评论区丢失。
    if (this._finishPromise && !this._finishSettled) {
      logger.warn('[Recorder] destroy 时收尾仍在进行，等待合并完成后再清理...');
      try { await this._finishPromise; } catch (e) { /* 收尾错误已在其内部记录 */ }
    }
    await this._cleanup();
  }

  /**
   * 获取默认输出文件夹
   */
  getDefaultOutputFolder() {
    const { app } = require('electron');
    return path.join(app.getPath('videos'), '抖音直播录制工具V2');
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
      mode: this.recordMode,
      commentStatus: this.commentRenderer ? this.commentRenderer.getStatus() : null,
      lastRecordingResult: this._lastRecordingResult || null,
      duration: this.startTime ? Date.now() - this.startTime.getTime() : 0
    };
  }

}

module.exports = { Recorder, getFFmpegPath };
