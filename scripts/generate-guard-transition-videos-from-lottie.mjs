import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const sourcePath = process.argv[2] || '/Users/bao/Downloads/zhihuifu_final_lottie_fixed.json';
const outDir = process.argv[3] || path.resolve('assets');
const outputFrames = Number(process.argv[4]) || 240;
const frameRate = Number(process.argv[5]) || 60;
const frameSize = 256;

const animationData = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const lottieSource = fs.readFileSync(require.resolve('lottie-web/build/player/lottie.min.js'), 'utf8');
const fallbackChromium = path.join(
  process.env.HOME || '',
  'Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell',
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-lottie-video-'));
const upDir = path.join(tmpDir, 'up');
const downDir = path.join(tmpDir, 'down');
fs.mkdirSync(upDir);
fs.mkdirSync(downDir);

const browser = await chromium.launch({
  headless: true,
  executablePath: fs.existsSync(fallbackChromium) ? fallbackChromium : undefined,
});
const page = await browser.newPage({
  viewport: { width: frameSize, height: frameSize },
  deviceScaleFactor: 1,
});

await page.setContent(`
  <!doctype html>
  <html>
    <head>
      <style>
        html, body, #stage {
          width: ${frameSize}px;
          height: ${frameSize}px;
          margin: 0;
          padding: 0;
          background: transparent;
          overflow: hidden;
        }
        svg { display: block; }
      </style>
    </head>
    <body>
      <div id="stage"></div>
      <script>${lottieSource}</script>
      <script>
        window.animationReady = new Promise((resolve) => {
          window.guardAnimation = lottie.loadAnimation({
            container: document.getElementById('stage'),
            renderer: 'svg',
            loop: false,
            autoplay: false,
            animationData: ${JSON.stringify(animationData)}
          });
          window.guardAnimation.addEventListener('DOMLoaded', resolve);
        });
      </script>
    </body>
  </html>
`);
await page.evaluate(() => window.animationReady);

const sourceStart = Number(animationData.ip || 0);
const sourceEnd = Number(animationData.op || 90) - 1;

const writeLottieFrame = async (targetDir, outIndex, progress) => {
  const sourceFrame = sourceStart + progress * (sourceEnd - sourceStart);
  await page.evaluate((frame) => {
    window.guardAnimation.goToAndStop(frame, true);
  }, sourceFrame);
  await page.waitForTimeout(6);
  const buffer = await page.screenshot({
    omitBackground: true,
    clip: { x: 0, y: 0, width: frameSize, height: frameSize },
  });
  fs.writeFileSync(path.join(targetDir, `frame_${String(outIndex).padStart(4, '0')}.png`), buffer);
};

for (let frame = 0; frame < outputFrames; frame += 1) {
  const progress = frame / (outputFrames - 1);
  await writeLottieFrame(upDir, frame, progress);
  await writeLottieFrame(downDir, frame, 1 - progress);
}
await browser.close();

const encode = (inputDir, outputPath) => {
  const result = spawnSync('/opt/homebrew/bin/ffmpeg', [
    '-y',
    '-framerate', String(frameRate),
    '-i', path.join(inputDir, 'frame_%04d.png'),
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-auto-alt-ref', '0',
    '-b:v', '0',
    '-crf', '20',
    outputPath,
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${outputPath}`);
};

fs.mkdirSync(outDir, { recursive: true });
encode(upDir, path.join(outDir, 'guard-transition-up.webm'));
encode(downDir, path.join(outDir, 'guard-transition-down.webm'));
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`Wrote ${outputFrames} generated Lottie frames to ${outDir}`);
