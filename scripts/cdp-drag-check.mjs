#!/usr/bin/env node
/**
 * U11 (#213): real-browser check that drag reorder in the itinerary table really changes the order.
 * Drives headless Chrome through the DevTools Protocol (no extra npm packages: Node's global WebSocket).
 *
 *   npx vite apps/web --port 5202 --strictPort --host 127.0.0.1 &
 *   node scripts/cdp-drag-check.mjs [url] [--screenshot out.png]
 *
 * Steps (each asserts the stay order on screen changed as expected):
 *   1. mouse: drag row 1 below row 2      2. mouse: drag row 2 above row 1
 *   3. touch: row 1 onto row 2   4. keyboard: Enter, ArrowDown, Enter on row 1
 *   5. save (候補と差分を確認 → この案を保存する) and check the saved order is still the new one after reload of the trip.
 * Exit code 0 when every step passes.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const shotAt = args.indexOf('--screenshot');
const shotPath = shotAt >= 0 ? args[shotAt + 1] : null;
const url = args.find((a, i) => !a.startsWith('--') && i !== shotAt + 1) ?? 'http://127.0.0.1:5202/#/mock/trips/fx_trip_kanazawa/edit';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9300 + Math.floor(Math.random() * 500);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-drag-'))}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=500,1600', 'about:blank',
], { stdio: 'ignore' });

let ws; let seq = 0; const waits = new Map();
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => waits.set(id, { res, rej }));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
  return r.result.value;
}
async function waitFor(expr, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evaluate(expr)) return; await sleep(100); }
  throw new Error(`timeout waiting for ${expr}`);
}

const ORDER = `[...document.querySelectorAll('table.it-table tr.it-stay[data-stay-key]')].map(r => r.querySelector('.it-title')?.textContent?.replace('未保存','').trim())`;
const rect = (sel, i) => evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, h: r.height }; })()`);
const STAY = 'table.it-table tr.it-stay[data-stay-key]';
const HANDLE = 'table.it-table tr.it-stay[data-stay-key] .it-handle';

/** Scrolls the table to the top of the viewport (rows are measured afterwards, without scrolling in between). */
const scrollTable = () => evaluate(`(window.scrollTo(0, document.querySelector('table.it-table').getBoundingClientRect().top + window.scrollY - 140), true)`).then(() => sleep(150));

async function mouseDrag(from, toY) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let s = 1; s <= steps; s++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y + ((toY - from.y) * s) / steps, button: 'left', buttons: 1 });
    await sleep(30);
  }
  await sleep(100);
  const preview = await evaluate(ORDER);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x, y: toY, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(400);
  return preview;
}
async function touchDrag(from, toY) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  const steps = 12;
  for (let s = 1; s <= steps; s++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y + ((toY - from.y) * s) / steps }] });
    await sleep(30);
  }
  await sleep(100);
  const preview = await evaluate(ORDER);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
  return preview;
}
async function key(k, code, keyCode) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode, ...(k === 'Enter' ? { text: '\r' } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
  await sleep(150);
}

const results = [];
function check(name, before, after, expected) {
  const ok = JSON.stringify(after.slice(0, expected.length)) === JSON.stringify(expected);
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n  before: ${before.join(' / ')}\n  after:  ${after.join(' / ')}${ok ? '' : `\n  expected start: ${expected.join(' / ')}`}`);
}

try {
  let wsUrl = null;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? null; } catch { /* starting */ }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('Chrome did not start');
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = m => { const d = JSON.parse(m.data); const w = waits.get(d.id); if (w) { waits.delete(d.id); d.error ? w.rej(new Error(d.error.message)) : w.res(d.result); } };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 500, height: 1600, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url });
  await waitFor(`document.querySelectorAll(${JSON.stringify(HANDLE)}).length >= 2`);
  await sleep(300);

  // 1. mouse: row 1 onto the upper part of row 2 (the case reported on #34: released before the middle of row 2)
  await scrollTable();
  let before = await evaluate(ORDER);
  let h = await rect(HANDLE, 0); let r2 = await rect(STAY, 1);
  await mouseDrag(h, r2.top + r2.h * 0.25);
  let after = await evaluate(ORDER);
  check('mouse: row 1 dropped on the upper part of row 2', before, after, [before[1], before[0]]);

  // 2. mouse: row 2 above row 1 (undoes step 1)
  before = after;
  h = await rect(HANDLE, 1); let r1 = await rect(STAY, 0);
  await mouseDrag(h, r1.bottom - r1.h * 0.25);
  after = await evaluate(ORDER);
  check('mouse: row 2 dropped on the lower part of row 1', before, after, [before[1], before[0]]);

  // 3. touch: row 1 below row 2
  before = after;
  h = await rect(HANDLE, 0); r2 = await rect(STAY, 1);
  await touchDrag(h, r2.top + r2.h * 0.25);
  after = await evaluate(ORDER);
  check('touch: row 1 dropped on the upper part of row 2', before, after, [before[1], before[0]]);

  // 4. keyboard: row 1 one down
  before = after;
  await evaluate(`document.querySelectorAll(${JSON.stringify(HANDLE)})[0].focus()`);
  await key('Enter', 'Enter', 13); await key('ArrowDown', 'ArrowDown', 40); await key('Enter', 'Enter', 13);
  after = await evaluate(ORDER);
  check('keyboard: Enter, ArrowDown, Enter on row 1', before, after, [before[1], before[0]]);

  // 5-9. longer drags, released inside the target row before its middle: the order after the drop must be the order
  // shown while dragging (the reported bug: rows move while dragging but the order does not change).
  const move = (list, from, to) => { const l = list.filter((_, i) => i !== from); l.splice(to, 0, list[from]); return l; };
  for (const [from, to, how] of [[2, 4, 'mouse'], [4, 1, 'mouse'], [0, 1, 'mouse'], [3, 5, 'touch'], [5, 2, 'touch']]) {
    await scrollTable();
    before = await evaluate(ORDER);
    h = await rect(HANDLE, from); const t = await rect(STAY, to);
    const y = to > from ? t.top + t.h * 0.3 : t.bottom - t.h * 0.3;
    const preview = how === 'mouse' ? await mouseDrag(h, y) : await touchDrag(h, y);
    after = await evaluate(ORDER);
    check(`${how}: row ${from + 1} dragged to row ${to + 1} (shown while dragging: ${preview.join(' / ')})`, before, after, move(before, from, to));
  }

  // 8. persistence. The unified screen (U11) saves a drag at once (K10 PATCH, mock: the in-memory server): leave the
  // tab and come back, the order must still be the dragged one. The older edit screen kept drags pending: save there.
  const expectedSaved = after;
  if (await evaluate(`document.body.textContent.includes('並べ替えを保存しました')`)) {
    const back = await evaluate('location.hash');
    await evaluate(`location.hash = location.hash.replace(/\\/(edit|map)$/, '/travel')`);
    await sleep(600);
    await evaluate(`location.hash = ${JSON.stringify('__BACK__')}`.replace('"__BACK__"', JSON.stringify(back)));
    await waitFor(`document.querySelectorAll(${JSON.stringify(HANDLE)}).length >= 2`);
    await sleep(300);
    check('persist: after leaving the tab and coming back, the saved order is the dragged order', expectedSaved, await evaluate(ORDER), expectedSaved);
  } else {
    const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('候補と差分を確認')); if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (clicked) {
      await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('この案を保存する') && !b.disabled)`);
      await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('この案を保存する') && !b.disabled).click()`);
      await waitFor(`document.body.textContent.includes('保存しました')`);
      await sleep(300);
      check('save: saved order equals the dragged order', expectedSaved, await evaluate(ORDER), expectedSaved);
    } else {
      results.push({ name: 'save', ok: false }); console.log('FAIL save: neither saved at once nor 候補と差分を確認 available');
    }
  }

  // 9. a stay with children (近江町市場エリア) opens and lists them (time + name).
  const kids = await evaluate(`(() => { const r = [...document.querySelectorAll('tr.it-stay')].find(r => r.textContent.includes('近江町市場')); if (!r) return null; r.querySelector('.it-rowbtn').click(); return true; })()`);
  await sleep(300);
  const childRows = kids ? await evaluate(`[...document.querySelectorAll('.it-subtable tr.it-child')].map(r => r.textContent)`) : [];
  results.push({ name: 'children', ok: childRows.length > 0 });
  console.log(`${childRows.length > 0 ? 'PASS' : 'FAIL'} children of 近江町市場エリア shown when opened: ${childRows.join(' / ')}`);

  if (shotPath) {
    await evaluate('window.scrollTo(0, 0)'); await sleep(200);
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(shotPath, Buffer.from(s.data, 'base64'));
    console.log(`screenshot: ${shotPath}`);
  }
} catch (e) {
  results.push({ name: 'run', ok: false });
  console.error('ERROR', e.message);
} finally {
  ws?.close();
  chrome.kill();
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
