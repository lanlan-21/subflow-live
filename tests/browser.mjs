// Runs a real server and three editors plus one audience page in Chrome.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = mkdtempSync(resolve(process.env.TEST_WORK || tmpdir(), 'subflow-'));
const python = process.env.PYTHON || (process.platform === 'win32' ? '.venv/Scripts/python.exe' : 'python');
const port = 5124;
let logs = '';
let server;
let browser;
const errors = [];
const results = [];
function startServer() {
  server = spawn(python, ['app.py'], { env: { ...process.env, PORT: String(port), SUBFLOW_DB: resolve(dir, 'test.sqlite3'), SECRET_KEY: 'automated-test-only-secret' } });
  server.stderr.on('data', data => { logs += data; });
  server.stdout.on('data', data => { logs += data; });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = `http://127.0.0.1:${port}`;
async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('Server not ready: ' + logs.slice(-1500));
}
const content = page => page.evaluate(() => quill.getText());
async function synced(pages) {
  for (const page of pages) await page.waitForFunction(() => document.getElementById('syncStatus')?.textContent === '所有修改已儲存');
  const expected = await content(pages[0]);
  for (const page of pages) await page.waitForFunction(value => quill.getText() === value, expected);
  return expected;
}
async function check(name, fn) {
  const started = Date.now();
  await fn();
  results.push({ name, ms: Date.now() - started });
  console.log('PASS', name);
}
try {
  startServer();
  await waitServer();
  browser = await chromium.launchPersistentContext(resolve(dir, 'profile'), {
    channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, viewport: { width: 1365, height: 900 }
  });
  const pages = await Promise.all([1, 2, 3].map(() => browser.newPage()));
  const [a, b, c] = pages;
  const viewer = await browser.newPage();
  for (const page of [...pages, viewer]) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
  }
  await Promise.all(pages.map(page => page.goto(`${base}/edit/TEST`)));
  await viewer.goto(`${base}/view/TEST`);
  await check('three tabs have unique identities and editor count', async () => {
    await synced(pages);
    const ids = await Promise.all(pages.map(page => page.evaluate(() => collaboration.doc.clientID)));
    assert.equal(new Set(ids).size, 3);
    await a.waitForFunction(() => document.getElementById('onlineCountText').textContent.includes('3'));
  });
  await check('concurrent transcription, correction and Unicode converge', async () => {
    await a.evaluate(() => quill.insertText(0, '現場口語🙂𠮷字\n第二段內容\n', 'user'));
    await synced(pages);
    await Promise.all([
      a.evaluate(() => quill.insertText(quill.getLength() - 1, '持續聽打', 'user')),
      b.evaluate(() => { quill.deleteText(0, 2, 'user'); quill.insertText(0, '主持人現場', 'user'); }),
      c.evaluate(() => quill.insertText(2, '補充詞', 'user'))
    ]);
    const value = await synced(pages);
    assert(value.includes('持續聽打'));
    assert(value.includes('🙂𠮷字'));
    await viewer.waitForFunction(value => quill.getText() === value, value);
  });
  await check('local selection follows its text when partner inserts earlier', async () => {
    await a.bringToFront();
    const before = await a.evaluate(() => { const i = quill.getLength() - 1; quill.focus(); quill.setSelection(i, 0); return i; });
    await b.evaluate(() => quill.insertText(0, '前補', 'user'));
    await synced(pages);
    assert.equal(await a.evaluate(() => quill.getSelection()?.index), before + 2);
  });
  await check('remote named cursor and selection are visible', async () => {
    await b.evaluate(() => { collaboration.setName('校稿夥伴乙'); quill.focus(); quill.setSelection(3, 2); });
    await a.waitForFunction(() => [...document.querySelectorAll('.ql-cursor-name')].some(el => el.textContent === '校稿夥伴乙'));
    assert(await a.locator('.ql-cursor-selection-block').count() > 0);
  });
  await check('own undo preserves partner correction', async () => {
    await a.evaluate(() => { collaboration.undo.stopCapturing(); quill.insertText(quill.getLength() - 1, '甲獨有', 'user'); collaboration.undo.stopCapturing(); });
    await synced(pages);
    await b.evaluate(() => quill.insertText(0, '乙保留', 'user'));
    await synced(pages);
    await a.evaluate(() => quill.getModule('history').undo());
    const value = await synced(pages);
    assert(!value.includes('甲獨有'));
    assert(value.includes('乙保留'));
    await a.bringToFront();
    await a.evaluate(() => quill.focus());
    await a.keyboard.press('Control+Shift+z');
    const redone = await synced(pages);
    assert(redone.includes('甲獨有') && redone.includes('乙保留'));
    await a.keyboard.press('Control+z');
    await synced(pages);
  });
  await check('IME defers remote changes until composition finishes', async () => {
    await a.evaluate(() => quill.root.dispatchEvent(new CompositionEvent('compositionstart', { data: 'ㄓ' })));
    const before = await content(a);
    await b.evaluate(() => quill.insertText(0, '組字時補詞', 'user'));
    await b.waitForFunction(() => document.getElementById('syncStatus').textContent === '所有修改已儲存');
    await delay(250);
    assert.equal(await content(a), before);
    await a.evaluate(() => {
      quill.insertText(quill.getLength() - 1, '中文選字', 'user');
      quill.root.dispatchEvent(new CompositionEvent('compositionend', { data: '中文選字' }));
    });
    const value = await synced(pages);
    assert(value.includes('中文選字') && value.includes('組字時補詞'));
  });
  await check('browser IME input pipeline commits Chinese while partner corrects', async () => {
    await a.bringToFront();
    await a.evaluate(() => { quill.focus(); quill.setSelection(quill.getLength() - 1, 0); });
    const input = await browser.newCDPSession(a);
    await input.send('Input.imeSetComposition', { text: 'ㄓㄨㄥ', selectionStart: 3, selectionEnd: 3 });
    await b.evaluate(() => quill.insertText(0, '選字時校正', 'user'));
    await delay(250);
    assert(!(await content(a)).includes('選字時校正'));
    await input.send('Input.insertText', { text: '正式中文' });
    const value = await synced(pages);
    assert(value.includes('正式中文') && value.includes('選字時校正'));
    assert(!value.includes('ㄓㄨㄥ'));
    await input.detach();
  });
  await check('real keyboard insertion and deletion sync to partners', async () => {
    await a.bringToFront();
    await a.evaluate(() => { quill.focus(); quill.setSelection(quill.getLength() - 1, 0); });
    await a.keyboard.insertText('鍵盤輸入測試');
    await a.keyboard.press('Backspace');
    const value = await synced(pages);
    assert(value.includes('鍵盤輸入測') && !value.includes('鍵盤輸入測試'));
  });
  await check('offline edits merge with partner and survive page reload', async () => {
    await a.evaluate(() => socket.disconnect());
    await a.evaluate(() => quill.insertText(quill.getLength() - 1, '離線甲保留', 'user'));
    await b.evaluate(() => quill.insertText(0, '在線乙保留', 'user'));
    await delay(300);
    await a.reload();
    const value = await synced(pages);
    assert(value.includes('離線甲保留') && value.includes('在線乙保留'));
  });
  await check('lost save acknowledgement retries without duplicating text', async () => {
    await a.evaluate(() => {
      const original = socket.emit;
      socket.emit = function (event, ...args) {
        if (event === 'document_update') {
          socket.emit = original;
          const callback = args.pop();
          return original.call(this, event, ...args, () => callback(new Error('simulated lost acknowledgement')));
        }
        return original.call(this, event, ...args);
      };
      quill.insertText(quill.getLength() - 1, '重送不可重複', 'user');
    });
    const value = await synced(pages);
    assert.equal(value.split('重送不可重複').length - 1, 1);
  });
  await check('server restart restores durable draft and reconnects editors', async () => {
    const expected = await synced(pages);
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    startServer();
    await waitServer();
    await synced(pages);
    assert.equal(await content(a), expected);
    const fresh = await browser.newPage();
    await fresh.goto(`${base}/view/TEST`);
    await fresh.waitForFunction(value => quill.getText() === value, expected);
    await fresh.close();
  });
  await check('long draft with repeated concurrent edits remains consistent', async () => {
    await a.evaluate(() => quill.insertText(quill.getLength() - 1, '\n' + '這是長篇現場逐字稿，用來確認持續編輯與校正。'.repeat(2500), 'user'));
    await synced(pages);
    for (let i = 0; i < 40; i++) {
      await Promise.all([
        a.evaluate(i => quill.insertText(quill.getLength() - 1, `聽打${i}。`, 'user'), i),
        b.evaluate(i => quill.insertText(10 + i, '補', 'user'), i),
        c.evaluate(i => { quill.deleteText(100 + i, 1, 'user'); quill.insertText(100 + i, '改', 'user'); }, i)
      ]);
    }
    const value = await synced(pages);
    assert(value.length > 50000);
    await viewer.waitForFunction(value => quill.getText() === value, value);
  });
  await check('revision list and QR viewer link work', async () => {
    const versions = await a.evaluate(() => collaboration.revisions());
    assert(versions.length > 0);
    assert((await a.evaluate(id => collaboration.revision(id), versions[0].id)).length > 0);
    await a.evaluate(() => openQrModal());
    assert(await a.locator('#modalQrBox canvas').count() > 0);
    await a.evaluate(() => closeQrModal());
  });
  await check('editing earlier text preserves independent scroll position', async () => {
    await b.bringToFront();
    const before = await b.evaluate(() => {
      quill.focus(); quill.setSelection(3000, 0);
      editorContainer.scrollTop = 1000;
      return editorContainer.scrollTop;
    });
    await a.evaluate(() => quill.insertText(quill.getLength() - 1, '持續稿尾', 'user'));
    await synced(pages);
    assert(Math.abs(await b.evaluate(() => editorContainer.scrollTop) - before) < 5);
  });
  await check('five editors across isolated browsers converge with network latency', async () => {
    const isolated = await Promise.all([1, 2].map(() => browser.browser().newContext()));
    const extra = await Promise.all(isolated.map(context => context.newPage()));
    for (const page of extra) page.on('pageerror', error => errors.push(error.message));
    await Promise.all(extra.map(page => page.goto(`${base}/edit/TEST`)));
    const all = [...pages, ...extra];
    await synced(all);
    const network = await browser.newCDPSession(a);
    await network.send('Network.enable');
    await network.send('Network.emulateNetworkConditions', { offline: false, latency: 180, downloadThroughput: 1000000, uploadThroughput: 1000000 });
    const until = Date.now() + Number(process.env.SOAK_SECONDS || 60) * 1000;
    let count = 0;
    while (Date.now() < until) {
      await Promise.all(all.map((page, n) => page.evaluate(({ n, count }) => {
        if (n === 0) quill.insertText(quill.getLength() - 1, `發言${count}。`, 'user');
        else { const pos = 100 + n * 100; quill.deleteText(pos, 1, 'user'); quill.insertText(pos, `補${n}`, 'user'); }
      }, { n, count })));
      count++;
      await delay(100);
    }
    await network.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await network.detach();
    const value = await synced(all);
    assert(value.includes(`發言${count - 1}。`));
    console.log('SOAK edit rounds', count, 'five editors');
    await Promise.all(isolated.map(context => context.close()));
  });
  await check('clearing creates a downloadable pre-clear version', async () => {
    await synced(pages);
    const before = await content(a);
    await a.evaluate(() => collaboration.clear());
    assert.equal(await synced(pages), '\n');
    const versions = await a.evaluate(() => collaboration.revisions());
    const saved = await a.evaluate(id => collaboration.revision(id), versions[0].id);
    // Quill owns its mandatory terminal newline; Y.Text may omit it.
    assert(saved.replace(/\n$/, '') === before.replace(/\n$/, ''), 'Pre-clear revision matches original draft');
    await a.evaluate(() => quill.getModule('history').undo());
    assert((await synced(pages)) === before, 'Undo restores only the clear operation');
  });
  await a.screenshot({ path: resolve(dir, 'editor.png') });
  await check('Render free mode does not claim permanent server storage', async () => {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    process.env.SUBFLOW_DURABLE_STORAGE = '0';
    startServer();
    await waitServer();
    for (const page of pages) await page.waitForFunction(() => document.getElementById('syncStatus').textContent.includes('伺服器僅暫存'));
    await viewer.waitForFunction(() => document.getElementById('viewerStatus').textContent.includes('伺服器僅暫存'));
  });
  assert.deepEqual(errors, [], 'Browser runtime errors');
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log('RESULTS', resolve(dir, 'results.json'));
} catch (error) {
  console.error(error);
  console.error('SERVER LOG TAIL', logs.slice(-2500));
  console.error('BROWSER ERRORS', errors);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
