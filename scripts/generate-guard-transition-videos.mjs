import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';

const sourcePath = process.argv[2] || path.resolve('assets/guard-storyboard-sprite.png');
const outDir = process.argv[3] || path.resolve('assets');
const frameRate = Number(process.argv[4]) || 60;
const frameSize = 256;

const sprite = PNG.sync.read(fs.readFileSync(sourcePath));
const frameCount = Math.floor(sprite.height / frameSize);
if (sprite.width !== frameSize || frameCount < 2) {
  throw new Error(`Unexpected sprite dimensions: ${sprite.width}x${sprite.height}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-transition-'));
const upDir = path.join(tmpDir, 'up');
const downDir = path.join(tmpDir, 'down');
fs.mkdirSync(upDir);
fs.mkdirSync(downDir);

const writeFrame = (targetDir, outIndex, sourceFrame) => {
  const frame = new PNG({ width: frameSize, height: frameSize, colorType: 6 });
  for (let y = 0; y < frameSize; y += 1) {
    const sourceStart = ((sourceFrame * frameSize + y) * frameSize) * 4;
    const targetStart = (y * frameSize) * 4;
    sprite.data.copy(frame.data, targetStart, sourceStart, sourceStart + frameSize * 4);
  }
  fs.writeFileSync(path.join(targetDir, `frame_${String(outIndex).padStart(4, '0')}.png`), PNG.sync.write(frame));
};

for (let frame = 0; frame < frameCount; frame += 1) {
  writeFrame(upDir, frame, frame);
  writeFrame(downDir, frame, frameCount - 1 - frame);
}

const encode = (inputDir, outputPath) => {
  const result = spawnSync('/opt/homebrew/bin/ffmpeg', [
    '-y',
    '-framerate', String(frameRate),
    '-i', path.join(inputDir, 'frame_%04d.png'),
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-auto-alt-ref', '0',
    '-b:v', '0',
    '-crf', '24',
    outputPath,
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${outputPath}`);
};

fs.mkdirSync(outDir, { recursive: true });
encode(upDir, path.join(outDir, 'guard-transition-up.webm'));
encode(downDir, path.join(outDir, 'guard-transition-down.webm'));
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`Wrote ${frameCount} frame transition videos to ${outDir}`);
