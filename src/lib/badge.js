/**
 * 任务栏角标 PNG 生成器（纯 Node，不依赖 DOM/渲染进程）
 * 用 zlib 手写 PNG 编码，绘制"红色圆底 + 白色数字"角标，
 * 供主进程在最小化/后台时可靠生成并应用到 Windows 任务栏。
 */
const zlib = require('zlib');

// ========== CRC32（PNG chunk 校验） ==========
let crcTable = null;
function makeCrcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
}
function crc32(buf) {
  if (!crcTable) crcTable = makeCrcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ========== PNG 编码（RGBA 8bit） ==========
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type: RGBA
  ihdr[10] = 0;     // compression
  ihdr[11] = 0;     // filter
  ihdr[12] = 0;     // interlace

  // 原始像素 + 每行前置 filter byte 0
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });

  function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  }

  const ihdrChunk = chunk('IHDR', ihdr);
  const idatChunk = chunk('IDAT', idatData);
  const iendChunk = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// ========== 3x5 点阵数字字体（0-9、+, 空） ==========
// 每字符 5 行，每行 3 位（bit2..bit0 => 左..右）
const DIGITS = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b001, 0b011, 0b001, 0b001, 0b001],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b010, 0b010, 0b010],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
};

/**
 * 生成红色圆形角标 PNG 的 Buffer
 * @param {number} count 数量（>99 显示 9+）
 * @param {number} [size=32] 图像边长（px），任务栏 overlay 用 32，托盘用 16
 * @returns {Buffer} PNG buffer（可直接 nativeImage.createFromBuffer）
 */
function makeBadgePng(count, size) {
  const SIZE = size || 32;
  const px = makeBadgeRgba(count, SIZE);
  return encodePng(SIZE, SIZE, px);
}

/**
 * 生成红色圆形角标的原始 RGBA 像素 buffer（用于像素级合成到托盘图标）
 * @param {number} count 数量
 * @param {number} SIZE 边长
 * @returns {Buffer} RGBA buffer
 */
function makeBadgeRgba(count, SIZE) {
  const px = Buffer.alloc(SIZE * SIZE * 4); // RGBA，默认全透明

  const label = count > 9 ? '9+' : String(Math.max(1, count) | 0);

  // 圆心、半径与字号按尺寸等比缩放
  const cx = SIZE / 2 - 0.5, cy = SIZE / 2 - 0.5;
  const radius = SIZE * 0.375;
  const ringStroke = Math.max(1.5, SIZE * 0.045);
  const rColor = [0xFE, 0x2C, 0x55, 255]; // 抖音红

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  }
  // 抗锯齿圆（简单平滑）：白色描边 + 红色圆底
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
      const ringOuter = radius + ringStroke / 2;
      const ringInner = radius - ringStroke / 2;
      if (d <= ringInner) {
        setPixel(x, y, rColor[0], rColor[1], rColor[2], rColor[3]);
      } else if (d <= ringOuter) {
        setPixel(x, y, 255, 255, 255, 255); // 白描边
      }
    }
  }

  // 绘制白色数字居中（按尺寸自适应缩放）
  const scale = Math.max(1, Math.round(SIZE / 10));       // 32->3, 16->2
  const glyphW = 3 * scale, glyphH = 5 * scale, gap = scale;
  const totalW = label.length * glyphW + (label.length - 1) * gap;
  const startX = Math.round(cx - totalW / 2);
  const startY = Math.round(cy - glyphH / 2);
  for (let ci = 0; ci < label.length; ci++) {
    const glyph = DIGITS[label[ci]] || DIGITS['+'];
    const ox = startX + ci * (glyphW + gap);
    for (let row = 0; row < 5; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 3; col++) {
        if (bits & (1 << (2 - col))) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              setPixel(ox + col * scale + dx, startY + row * scale + dy, 255, 255, 255, 255);
            }
          }
        }
      }
    }
  }

  return px;
}

/**
 * 把角标 RGBA 像素合成到任意底图 buffer 的右下角（类似微信未读角标）。
 * 纯 alpha 混合，不依赖图像库。用于在主进程给托盘图标叠加红点。
 * @param {Buffer} base 底图 RGBA buffer
 * @param {number} baseW 底图宽
 * @param {number} baseH 底图高
 * @param {Buffer} badge 角标 RGBA buffer（badgeSize*badgeSize*4）
 * @param {number} badgeSize 角标边长
 * @returns {Buffer} 合成后的 RGBA buffer（同底图尺寸）
 */
function drawBadgeOnBuffer(base, baseW, baseH, badge, badgeSize) {
  const out = Buffer.from(base); // 拷贝
  // 角标放在右下角，约占底图的 60%
  const drawSize = Math.max(6, Math.round(Math.min(baseW, baseH) * 0.62));
  // 角标定位：右下角，略微超出以贴合边缘
  const offsetX = baseW - drawSize + Math.round(drawSize * 0.12);
  const offsetY = baseH - drawSize + Math.round(drawSize * 0.12);

  for (let by = 0; by < drawSize; by++) {
    for (let bx = 0; bx < drawSize; bx++) {
      // 角标源像素（按比例采样）
      const sx = Math.floor((bx / drawSize) * badgeSize);
      const sy = Math.floor((by / drawSize) * badgeSize);
      const si = (sy * badgeSize + sx) * 4;
      const sa = badge[si + 3];
      if (sa === 0) continue; // 透明像素跳过

      const dx = offsetX + bx;
      const dy = offsetY + by;
      if (dx < 0 || dx >= baseW || dy < 0 || dy >= baseH) continue;
      const di = (dy * baseW + dx) * 4;

      // alpha 混合
      const alpha = sa / 255;
      out[di]     = Math.round(badge[si]     * alpha + out[di]     * (1 - alpha));
      out[di + 1] = Math.round(badge[si + 1] * alpha + out[di + 1] * (1 - alpha));
      out[di + 2] = Math.round(badge[si + 2] * alpha + out[di + 2] * (1 - alpha));
      out[di + 3] = Math.max(out[di + 3], sa);
    }
  }
  return out;
}

module.exports = { makeBadgePng, makeBadgeRgba, drawBadgeOnBuffer };