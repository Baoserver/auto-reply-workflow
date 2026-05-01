import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const sourcePath = process.argv[2] || path.resolve('assets/分镜.png');
const outPath = process.argv[3] || path.resolve('assets/guard-storyboard-sprite.png');
const frameSize = 256;
const frameCount = Number(process.argv[4]) || 240;

const source = PNG.sync.read(fs.readFileSync(sourcePath));
const sleepIcon = PNG.sync.read(fs.readFileSync(path.resolve('assets/sleep-bot.png')));
const activeIcon = PNG.sync.read(fs.readFileSync(path.resolve('assets/bot-tubiao.png')));
const sprite = new PNG({ width: frameSize, height: frameSize * frameCount, colorType: 6 });

const uiLayout = {
  offSize: 190,
  flightOnSize: 180,
  activeSize: 135,
  activeRight: -24,
  flightOnRight: -32,
};

const phases = [
  { start: 0, frames: 30, x: 130, y: 18, width: 1386, height: 339, cols: 10, rows: 3, labelCut: 24 },
  { start: 30, frames: 30, x: 130, y: 372, width: 1386, height: 278, cols: 15, rows: 2, labelCut: 24 },
  { start: 60, frames: 30, x: 130, y: 664, width: 1386, height: 303, cols: 15, rows: 2, labelCut: 24 },
];

const getPixel = (png, x, y) => {
  const clampedX = Math.max(0, Math.min(png.width - 1, x));
  const clampedY = Math.max(0, Math.min(png.height - 1, y));
  const index = (clampedY * png.width + clampedX) * 4;
  return [png.data[index], png.data[index + 1], png.data[index + 2], png.data[index + 3]];
};

const setPixel = (png, x, y, rgba) => {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const index = (y * png.width + x) * 4;
  png.data[index] = rgba[0];
  png.data[index + 1] = rgba[1];
  png.data[index + 2] = rgba[2];
  png.data[index + 3] = rgba[3];
};

const isBackground = (r, g, b) => (
  r > 235 && g > 224 && b > 205 && Math.abs(r - g) < 28 && Math.abs(g - b) < 42
);

const sampleBilinear = (png, x, y) => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const tx = x - x0;
  const ty = y - y0;
  const p00 = getPixel(png, x0, y0);
  const p10 = getPixel(png, x1, y0);
  const p01 = getPixel(png, x0, y1);
  const p11 = getPixel(png, x1, y1);
  return [0, 1, 2, 3].map((channel) => {
    const top = p00[channel] * (1 - tx) + p10[channel] * tx;
    const bottom = p01[channel] * (1 - tx) + p11[channel] * tx;
    return Math.round(top * (1 - ty) + bottom * ty);
  });
};

const sampleBilinearFrame = (png, x, y) => sampleBilinear(png, x, y);

const findBounds = (png) => {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (y * png.width + x) * 4;
      if (png.data[index + 3] > 20) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
      }
    }
  }
  if (count < 3000) return null;
  return { minX, minY, maxX, maxY, count, cx: (minX + maxX) / 2 };
};

const boundsToBox = (bounds) => ({
  minX: bounds.minX,
  minY: bounds.minY,
  maxX: bounds.maxX,
  maxY: bounds.maxY,
  width: bounds.maxX - bounds.minX + 1,
  height: bounds.maxY - bounds.minY + 1,
  cx: (bounds.minX + bounds.maxX) / 2,
  bottom: bounds.maxY,
});

const normalizeFrame = (raw) => {
  const bounds = findBounds(raw);
  if (!bounds) return null;
  const normalized = new PNG({ width: frameSize, height: frameSize, colorType: 6 });
  const dx = Math.round(frameSize / 2 - bounds.cx);
  const dy = Math.round(236 - bounds.maxY);

  for (let y = 0; y < frameSize; y += 1) {
    for (let x = 0; x < frameSize; x += 1) {
      const index = (y * frameSize + x) * 4;
      const alpha = raw.data[index + 3];
      if (alpha === 0) continue;
      setPixel(normalized, x + dx, y + dy, [
        raw.data[index],
        raw.data[index + 1],
        raw.data[index + 2],
        alpha,
      ]);
    }
  }
  return normalized;
};

const renderIconContain = (icon, box) => {
  const frame = new PNG({ width: frameSize, height: frameSize, colorType: 6 });
  const scale = Math.min(box.size / icon.width, box.size / icon.height);
  const drawW = icon.width * scale;
  const drawH = icon.height * scale;
  const drawX = box.x + (box.size - drawW) / 2;
  const drawY = box.y + (box.size - drawH) / 2;
  const frameScale = frameSize / box.containerSize;

  for (let y = 0; y < frameSize; y += 1) {
    for (let x = 0; x < frameSize; x += 1) {
      const boxX = x / frameScale;
      const boxY = y / frameScale;
      const sourceX = (boxX - drawX) / scale;
      const sourceY = (boxY - drawY) / scale;
      if (sourceX < 0 || sourceY < 0 || sourceX >= icon.width || sourceY >= icon.height) continue;
      const pixel = sampleBilinear(icon, sourceX, sourceY);
      if (pixel[3] > 0) setPixel(frame, x, y, pixel);
    }
  }
  return frame;
};

const renderCell = (cell) => {
  const cropX = cell.x + 3;
  const cropY = cell.y + 3;
  const cropW = cell.width - 6;
  const cropH = cell.height - cell.labelCut - 6;
  const scale = Math.min((frameSize - 18) / cropW, (frameSize - 18) / cropH);
  const drawW = cropW * scale;
  const drawH = cropH * scale;
  const offsetX = (frameSize - drawW) / 2;
  const offsetY = (frameSize - drawH) / 2;
  const raw = new PNG({ width: frameSize, height: frameSize, colorType: 6 });

  for (let y = 0; y < frameSize; y += 1) {
    for (let x = 0; x < frameSize; x += 1) {
      const sourceX = cropX + (x - offsetX) / scale;
      const sourceY = cropY + (y - offsetY) / scale;
      if (sourceX < cropX || sourceX >= cropX + cropW || sourceY < cropY || sourceY >= cropY + cropH) {
        setPixel(raw, x, y, [0, 0, 0, 0]);
        continue;
      }
      const [r, g, b, a] = sampleBilinear(source, sourceX, sourceY);
      const alpha = isBackground(r, g, b) ? 0 : a;
      setPixel(raw, x, y, [r, g, b, alpha]);
    }
  }
  return normalizeFrame(raw);
};

const validFrames = [];
for (const phase of phases) {
  const cellW = phase.width / phase.cols;
  const cellH = phase.height / phase.rows;
  for (let i = 0; i < phase.frames; i += 1) {
    const col = i % phase.cols;
    const row = Math.floor(i / phase.cols);
    const frame = renderCell({
      x: Math.round(phase.x + col * cellW),
      y: Math.round(phase.y + row * cellH),
      width: Math.round(cellW),
      height: Math.round(cellH),
      labelCut: phase.labelCut,
    });
    if (frame) validFrames.push(frame);
  }
}

if (validFrames.length < 2) {
  throw new Error(`Only found ${validFrames.length} usable storyboard frames`);
}

const startFrame = renderIconContain(sleepIcon, {
  x: 0,
  y: 0,
  size: uiLayout.offSize,
  containerSize: uiLayout.offSize,
});
const activeOffsetX = (uiLayout.flightOnRight - uiLayout.activeRight) + (uiLayout.flightOnSize - uiLayout.activeSize);
const endFrame = renderIconContain(activeIcon, {
  x: activeOffsetX,
  y: 0,
  size: uiLayout.activeSize,
  containerSize: uiLayout.flightOnSize,
});
const startBox = boundsToBox(findBounds(startFrame));
const endBox = boundsToBox(findBounds(endFrame));
const sourceFrames = [startFrame, ...validFrames, endFrame];

const drawFittedFrame = (targetFrame, sourceFrame, targetBox) => {
  const sourceBounds = findBounds(sourceFrame);
  if (!sourceBounds) return;
  for (let y = 0; y < frameSize; y += 1) {
    for (let x = 0; x < frameSize; x += 1) {
      const sourceX = sourceBounds.minX + ((x - targetBox.minX) / targetBox.width) * (sourceBounds.maxX - sourceBounds.minX + 1);
      const sourceY = sourceBounds.minY + ((y - targetBox.minY) / targetBox.height) * (sourceBounds.maxY - sourceBounds.minY + 1);
      const outIndex = ((targetFrame * frameSize + y) * frameSize + x) * 4;
      if (
        sourceX < sourceBounds.minX ||
        sourceX > sourceBounds.maxX ||
        sourceY < sourceBounds.minY ||
        sourceY > sourceBounds.maxY
      ) {
        sprite.data[outIndex + 3] = 0;
        continue;
      }
      const pixel = sampleBilinearFrame(sourceFrame, sourceX, sourceY);
      sprite.data[outIndex] = pixel[0];
      sprite.data[outIndex + 1] = pixel[1];
      sprite.data[outIndex + 2] = pixel[2];
      sprite.data[outIndex + 3] = pixel[3];
    }
  }
};

const interpolate = (start, end, t) => start + (end - start) * t;

for (let frame = 0; frame < frameCount; frame += 1) {
  const t = frame / (frameCount - 1);
  const position = t * (sourceFrames.length - 1);
  const sourceFrame = sourceFrames[Math.round(position)];
  const width = interpolate(startBox.width, endBox.width, t);
  const height = interpolate(startBox.height, endBox.height, t);
  const cx = interpolate(startBox.cx, endBox.cx, t);
  const bottom = interpolate(startBox.bottom, endBox.bottom, t);
  drawFittedFrame(frame, sourceFrame, {
    width,
    height,
    minX: cx - width / 2,
    maxX: cx + width / 2,
    minY: bottom - height,
    maxY: bottom,
  });
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, PNG.sync.write(sprite));
console.log(`Wrote ${frameCount} fitted frames from ${validFrames.length} usable storyboard cells to ${outPath}`);
