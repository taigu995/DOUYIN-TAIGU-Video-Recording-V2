/**
 * 视频编码器选择模块（v2.13.34）
 *
 * 合并视频（Merge-Final）是全量重编码，CPU 开销主要来自这里。
 * 本模块提供硬件加速编码（NVENC/QSV/AMF）自动实测探测与参数生成：
 * - auto：按 NVENC → QSV → AMF 顺序实测（真实试编码，不是只看 -encoders 列表），可用则用硬编
 * - 硬编运行中失败 → markFailed 标记，本次进程内不再使用，调用方回退 CPU 重试
 * - cpu：libx264（ preset/crf/threads 走用户配置）
 *
 * 说明：评论区/特效区等小尺寸低帧率编码仍固定走 CPU（硬编收益小、奇数尺寸兼容性差）。
 */
const { spawn } = require('child_process');
const { getLogger } = require('./logger');

const logger = getLogger();

// 硬编参数（兼容 @ffmpeg-installer 内置的旧版 FFmpeg N-92722，不使用 p1~p7 新预设）
// 硬编同画质下码率略高于 x264，质量参数按 crf+3 补偿
const HW_ENCODERS = {
  nvenc: {
    codec: 'h264_nvenc',
    label: 'NVIDIA NVENC',
    args: (crf) => ['-c:v', 'h264_nvenc', '-preset', 'medium', '-rc', 'vbr', '-cq', String(crf + 3), '-b:v', '0']
  },
  qsv: {
    codec: 'h264_qsv',
    label: 'Intel QSV',
    args: (crf) => ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(crf + 3), '-look_ahead', '0']
  },
  amf: {
    codec: 'h264_amf',
    label: 'AMD AMF',
    args: (crf) => ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(crf + 3), '-qp_p', String(crf + 3)]
  }
};

let _detectPromise = null;
const _runtimeFailed = new Set();

/** 实测单个硬编是否真正可用（真实试编码 12 帧，任何错误即不可用） */
function probeEncoder(ffmpegPath, name) {
  return new Promise((resolve) => {
    const enc = HW_ENCODERS[name];
    const args = [
      '-v', 'error', '-xerror',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=0.4',
      ...enc.args(18),
      '-frames:v', '12',
      '-f', 'null', '-'
    ];
    let proc;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { if (proc && proc.exitCode === null) proc.kill('SIGKILL'); } catch (e) {}
      resolve(ok);
    };
    try {
      proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish(false);
    }
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => finish(false));
    proc.on('close', (code) => {
      if (code === 0) {
        logger.info(`[Encoder] ${enc.label} 实测可用，合并视频将使用硬件加速`);
        finish(true);
      } else {
        logger.info(`[Encoder] ${enc.label} 不可用（${stderr.split('\n')[0] || '退出码 ' + code}）`);
        finish(false);
      }
    });
    setTimeout(() => finish(false), 12000);
  });
}

/** 进程内一次性并行实测三种硬编（结果缓存） */
function detect(ffmpegPath) {
  if (!_detectPromise) {
    _detectPromise = (async () => {
      const names = Object.keys(HW_ENCODERS);
      const results = await Promise.all(names.map((n) => probeEncoder(ffmpegPath, n)));
      const available = {};
      names.forEach((n, i) => { available[n] = results[i]; });
      const okList = names.filter((n) => available[n]).map((n) => HW_ENCODERS[n].label);
      logger.info(`[Encoder] 硬编探测完成: ${okList.length ? okList.join(', ') : '无可用硬编，使用 CPU 编码'}`);
      return available;
    })().catch(() => ({ nvenc: false, qsv: false, amf: false }));
  }
  return _detectPromise;
}

/** CPU(libx264) 编码参数 */
function cpuArgs(config) {
  const crf = config.mergeCrf || 15;
  const preset = config.mergePreset || 'medium';
  const threads = config.mergeThreads > 0 ? config.mergeThreads : Math.max(2, (require('os').cpus().length || 4) - 2);
  return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-threads:v', String(threads)];
}

/**
 * 选择合并主输出编码器
 * @param {string} ffmpegPath
 * @param {object} config - getConfig()（mergeEncoder: auto/cpu/nvenc/qsv/amf）
 * @returns {Promise<{encoder: string, label: string, args: string[]}>}
 */
async function resolve(ffmpegPath, config) {
  const pref = config.mergeEncoder || 'auto';
  if (pref === 'cpu') {
    return { encoder: 'cpu', label: 'CPU (libx264)', args: cpuArgs(config) };
  }
  const available = await detect(ffmpegPath);
  const order = pref === 'auto' ? ['nvenc', 'qsv', 'amf'] : [pref];
  for (const name of order) {
    if (available[name] && !_runtimeFailed.has(name)) {
      return { encoder: name, label: HW_ENCODERS[name].label, args: HW_ENCODERS[name].args(config.mergeCrf || 15) };
    }
  }
  if (pref !== 'auto' && !_runtimeFailed.has(pref)) {
    logger.warn(`[Encoder] 指定的 ${pref} 不可用，回退 CPU 编码`);
  }
  return { encoder: 'cpu', label: 'CPU (libx264)', args: cpuArgs(config) };
}

/** 运行中硬编失败时标记（进程内不再使用该硬编） */
function markFailed(name) {
  _runtimeFailed.add(name);
  logger.warn(`[Encoder] ${HW_ENCODERS[name] ? HW_ENCODERS[name].label : name} 运行失败，已标记，后续合并使用 CPU`);
}

/** 输出视频流选项线程数（解码/滤镜线程） */
function outputThreads(config) {
  if (config.mergeThreads > 0) return config.mergeThreads;
  return Math.max(2, (require('os').cpus().length || 4) - 2);
}

module.exports = { resolve, markFailed, cpuArgs, outputThreads, HW_ENCODERS };
