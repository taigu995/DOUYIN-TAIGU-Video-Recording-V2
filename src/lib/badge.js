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
 * @returns {Buffer} PNG buffer（可直接 nativeImage.createFromBuffer）
 */
function makeBadgePng(count) {
  const SIZE = 32;
  const px = Buffer.alloc(SIZE * SIZE * 4); // RGBA，默认全透明

  const label = count > 9 ? '9+' : String(Math.max(1, count) | 0);

  // 计算底部白色描边 -> 红色圆底
  const cx = 15, cy = 15, radius = 12;
  const rColor = [0xFE, 0x2C, 0x55, 255]; // 抖音红

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  }
  // 抗锯齿圆（简单平滑）
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
      const ringOuter = radius + 1.5;
      const ringInner = radius - 1.5;
      if (d <= ringInner) {
        setPixel(x, y, rColor[0], rColor[1], rColor[2], rColor[3]);
      } else if (d <= ringOuter) {
        // 白描边
        setPixel(x, y, 255, 255, 255, 255);
      }
    }
  }

  // 绘制白色数字居中
  const scale = 3;                       // 3x5 字模放大 3 -> 9x15/字符
  const glyphW = 3 * scale, glyphH = 5 * scale, gap = scale;
  const totalW = label.length * glyphW + (label.length - 1) * gap;
  const startX = Math.round((cx - totalW / 2));
  const startY = Math.round(cy - glyphH / 2);
  for (let ci = 0; ci < label.length; ci++) {
    const glyph = DIGITS[label[ci]] || DIGITS['+'];
    const ox = startX + ci * (glyphW + gap);
    for (let row = 0; row < 5; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 3; col++) {
        if (bits & (1 << (2 - col))) {
          // 填充 scale x scale 矩形
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              setPixel(ox + col * scale + dx, startY + row * scale + dy, 255, 255, 255, 255);
            }
          }
        }
      }
    }
  }

  return encodePng(SIZE, SIZE, px);
}

module.exports = { makeBadgePng };