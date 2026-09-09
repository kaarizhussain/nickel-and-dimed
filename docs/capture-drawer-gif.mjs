// Regenerates docs/drawer.gif: drives the running app over the Chrome DevTools
// Protocol and captures the vendor drill-down as a frame sequence.
//
//   node docs/capture-drawer-gif.mjs     # prints the frame dir and ffmpeg line
//
// Needs `npm run api` and `npm run dev` up first. Headless, so the capture
// contains the page and nothing else — no browser chrome, no desktop.
// Override the browser with CHROME=/path/to/chrome.
//
// Frames and the throwaway Chrome profile go to the system temp dir, never
// inside the repo: Vite watches the project tree, and it dies with EBUSY on
// Chrome's locked profile files — and writing frames under the project would
// trigger HMR reloads that close the drawer mid-capture.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const CHROME = process.env.CHROME
  ?? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const OUT = fs.mkdtempSync(`${os.tmpdir()}/nd-gif-`);
const FRAMES = `${OUT}/frames`;
const APP = process.env.APP_URL ?? 'http://localhost:5173';
const PORT = 9334;
const VW = 1280, VH = 720;
const N = 86;          // ~5s at the ~17fps a headless screenshot loop sustains
const CLICK_AT = 18;   // hold on the flagged cards first, so the target is seen
const SCROLL_AT = 54;  // then ease down the invoice list once the drawer settles

const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/.chrome-gif`,
  `--window-size=${VW},${VH}`, 'about:blank',
], { stdio: 'ignore' });

let ws;
const pending = new Map();
let msgId = 0;
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const waitFor = async (expr, label, timeout = 45000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expr)) return;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const TONYS = `[...document.querySelectorAll('[role=button],button')]
  .find(e => /Tony's Pizza.*View evidence/.test(e.getAttribute('aria-label')||''))`;

try {
  let wsUrl;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
      wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl;
    } catch { /* devtools not up yet */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('chrome devtools never came up');

  ws = new WebSocket(wsUrl);
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m);
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride',
    { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: APP });
  await waitFor(`/Tony's Pizza/.test(document.body.innerText)`, 'dashboard data');
  await sleep(1500);
  await evaluate(`${TONYS}?.scrollIntoView({ block: 'center' }); 1`);
  await sleep(800);

  const times = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    if (i === CLICK_AT) await evaluate(`${TONYS}?.click(); 1`);
    if (i >= SCROLL_AT) {
      await evaluate(`(() => {
        const b = document.querySelector('.drawer-body');
        if (b) b.scrollTop = Math.min(b.scrollTop + 13, b.scrollHeight);
      })()`);
    }
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${FRAMES}/f${String(i).padStart(3, '0')}.png`,
      Buffer.from(r.result.data, 'base64'));
    times.push(Date.now() - t0);
  }
  const mean = times.slice(1).reduce((a, t, i) => a + (t - times[i]), 0) / (N - 1);
  const fps = Math.round(1000 / mean);
  console.log(`captured ${N} frames (${fps} fps, ${(times[N - 1] / 1000).toFixed(1)}s)\n`);
  console.log('encode with:\n');
  console.log(`  ffmpeg -framerate ${fps} -i ${FRAMES}/f%03d.png \\
    -vf "fps=${fps},split[a][b];[a]palettegen=stats_mode=diff:max_colors=192[p];\\
[b][p]paletteuse=dither=none:diff_mode=rectangle" \\
    -loop 0 -y docs/drawer.gif\n`);
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  chrome.kill();
}
