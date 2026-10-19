import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve(process.env.VIEWER_TEST_OUTPUT || '../../outputs');
mkdirSync(output, { recursive: true });
const base = 'http://127.0.0.1:5128';
const python = process.env.PYTHON || (process.platform === 'win32' ? '.venv/Scripts/python.exe' : 'python');
const server = spawn(python, ['app.py'], { env: { ...process.env, PORT: '5128', SUBFLOW_DB: resolve('../viewer-qa.sqlite3'), SECRET_KEY: 'viewer-test-only' } });
let logs = '';
server.stderr.on('data', d => { logs += d; });
server.stdout.on('data', d => { logs += d; });
const results = [];
let browser;
const errors = [];
async function check(name, fn) { if(process.env.TEST_FILTER&&!new RegExp(process.env.TEST_FILTER).test(name))return; await fn(); results.push(name); console.log('PASS', name); }
try {
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 3 });
  await context.addInitScript(() => {
    window.wakeTest = { requests: 0, reject: false, hold: false, releases: 0, visible: true };
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => wakeTest.visible ? 'visible' : 'hidden' });
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
      wakeTest.requests++;
      if (wakeTest.reject) throw new Error('Power saving');
      if (wakeTest.hold) await new Promise(r => { wakeTest.resolve = r; });
      const sentinel = new EventTarget();
      sentinel.released = false;
      sentinel.release = async () => { if (!sentinel.released) { sentinel.released = true; wakeTest.releases++; sentinel.dispatchEvent(new Event('release')); } };
      wakeTest.last = sentinel;
      return sentinel;
    } } });
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/view/VIEWER-QA');
  await check('automatic screen lock and mobile viewport', async () => {
    await page.waitForFunction(() => document.getElementById('wakeLockStatus').dataset.active === 'true');
    assert.equal(await page.evaluate(() => innerWidth), 390);
    assert.equal(await page.locator('.ql-editor').evaluate(el => getComputedStyle(el).fontSize), '60px');
    assert(await page.locator('#viewerFooter').isHidden());
    assert(await page.locator('#quickFullscreenButton').isVisible());
    assert(await page.locator('#showViewerToolbar').isVisible());
  });
  await check('footer and 44px controls fit portrait, landscape and desktop', async () => {
    await page.locator('#showViewerToolbar').click();
    for (const size of [{width:320,height:568},{width:390,height:844},{width:844,height:390},{width:1280,height:720}]) {
      await page.setViewportSize(size);
      const metrics = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, footer: document.getElementById('viewerFooter').getBoundingClientRect().bottom, editor: document.getElementById('viewerContainer').getBoundingClientRect().bottom, top: document.getElementById('viewerFooter').getBoundingClientRect().top, buttons: [...document.querySelectorAll('.btn-viewer')].filter(e => e.getClientRects().length > 0).map(e => e.getBoundingClientRect().height) }));
      assert(!metrics.overflow, JSON.stringify(size));
      assert(metrics.footer <= size.height + 1);
      assert(metrics.editor <= metrics.top + 1);
      assert(metrics.buttons.every(h => h >= 44));
    }
    await page.setViewportSize({width:390,height:844});
  });
  await check('viewer zoom persists without changing editor font or document', async () => {
    const editor = await context.newPage();
    await editor.goto(base + '/edit/VIEWER-QA');
    await editor.waitForFunction(() => document.querySelector('.ql-editor').getAttribute('contenteditable') === 'true');
    await editor.locator('.ql-editor').fill('手機觀眾大字測試 👏👏👏👏 ❤️ 🙂\n聽打與補字同步正常。');
    await page.waitForFunction(() => document.querySelector('.ql-editor').textContent.includes('👏👏👏👏'));
    await page.getByRole('button', {name:'放大文字',exact:true}).click();
    const size = await page.locator('.ql-editor').evaluate(el => getComputedStyle(el).fontSize);
    assert(parseFloat(size) > 60);
    assert.equal(await editor.locator('.ql-editor').evaluate(el => getComputedStyle(el).fontSize), '48px');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.ql-editor').textContent.includes('👏👏👏👏'));
    assert.equal(await page.locator('.ql-editor').evaluate(el => getComputedStyle(el).fontSize), size);
    await page.locator('#showViewerToolbar').click();
    await page.getByRole('button', {name:'還原跟隨',exact:true}).click();
    await page.screenshot({path:resolve(output,'觀眾頁手機版驗證.png')});
    await editor.close();
  });
  await check('background releases and returning reacquires the lock', async () => {
    const before = await page.evaluate(() => wakeTest.requests);
    await page.evaluate(() => { wakeTest.visible = false; document.dispatchEvent(new Event('visibilitychange')); });
    assert(await page.evaluate(() => wakeTest.last.released));
    await page.evaluate(() => { wakeTest.visible = true; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(n => wakeTest.requests > n && document.getElementById('wakeLockStatus').dataset.active === 'true', before);
  });
  await check('no brightness toggle and old off preference cannot disable auto wake', async () => {
    assert.equal(await page.locator('#wakeLockButton').count(), 0);
    await page.evaluate(() => localStorage.setItem('subflow-keep-screen-on', '0'));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('wakeLockStatus').dataset.active === 'true');
  });
  await check('system release and rejected request show truthful status and allow retry', async () => {
    await page.evaluate(() => wakeTest.last.release());
    assert((await page.locator('#wakeLockStatus').innerText()).includes('已中斷'));
    await page.evaluate(() => { wakeTest.reject = true; });
    await page.evaluate(() => requestScreen());
    assert((await page.locator('#wakeLockStatus').innerText()).includes('系統未允許'));
    assert.equal(await page.locator('#wakeLockStatus').getAttribute('data-active'), 'false');
    await page.evaluate(() => { wakeTest.reject = false; });
    await page.evaluate(() => requestScreen());
    await page.waitForFunction(() => document.getElementById('wakeLockStatus').dataset.active === 'true');
  });
  await check('system release automatically recovers without any brightness control', async () => {
    const before = await page.evaluate(() => wakeTest.requests);
    await page.evaluate(() => wakeTest.last.release());
    await page.waitForFunction(n => wakeTest.requests > n && document.getElementById('wakeLockStatus').dataset.active === 'true', before);
  });
  await check('late request cannot retain a lock after page becomes hidden', async () => {
    await page.evaluate(() => wakeTest.last.release());
    await page.evaluate(() => { wakeTest.hold = true; requestScreen(); });
    await page.evaluate(() => { wakeTest.visible = false; document.dispatchEvent(new Event('visibilitychange')); wakeTest.resolve(); });
    await page.waitForFunction(() => wakeTest.last.released);
    assert.equal(await page.locator('#wakeLockStatus').getAttribute('data-active'), 'false');
  });
  await check('unsupported browser remains readable and explains manual fallback', async () => {
    const unsupported = await browser.newContext();
    await unsupported.addInitScript(() => { delete Navigator.prototype.wakeLock; });
    const other = await unsupported.newPage();
    await other.goto(base + '/view/VIEWER-QA');
    await other.waitForFunction(() => document.querySelector('.ql-editor').textContent.includes('👏👏👏👏'));
    assert.equal(await other.locator('#wakeLockButton').count(), 0);
    assert((await other.locator('#wakeLockStatus').innerText()).includes('不支援'));
    await unsupported.close();
  });
  await check('simulated landscape safe area encloses text and controls on both sides', async () => {
    if (await page.locator('#viewerFooter').isHidden()) await page.locator('#showViewerToolbar').click();
    await page.setViewportSize({width:844,height:390});
    for (const [left,right] of [[59,0],[0,59]]) {
      await page.evaluate(({left,right}) => {
        document.documentElement.style.setProperty('--safe-left',left+'px');
        document.documentElement.style.setProperty('--safe-right',right+'px');
        document.documentElement.style.setProperty('--safe-top','0px');
        document.documentElement.style.setProperty('--safe-bottom','21px');
      },{left,right});
      const metrics=await page.evaluate(()=>({container:document.getElementById('viewerContainer').getBoundingClientRect().toJSON(),footer:document.getElementById('viewerFooter').getBoundingClientRect().toJSON()}));
      assert(metrics.container.left >= left);
      assert(metrics.container.right <= 844-right+1);
      assert(metrics.footer.bottom <= 390-21+1);
      await page.locator('#hideViewerToolbar').click();
      const recovery=await page.locator('#showViewerToolbar').boundingBox();
      assert(recovery.x+recovery.width <= 844-right-7);
      assert(recovery.y+recovery.height <= 390-21-7);
      await page.locator('#showViewerToolbar').click();
    }
    await page.evaluate(()=>['--safe-left','--safe-right','--safe-top','--safe-bottom'].forEach(k=>document.documentElement.style.removeProperty(k)));
    await page.setViewportSize({width:390,height:844});
  });
  await check('unsupported fullscreen offers browser controls without installation and preserves reading view', async () => {
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.addInitScript(()=>{Object.defineProperty(document,'fullscreenEnabled',{value:false});Object.defineProperty(document,'webkitFullscreenEnabled',{value:false});Element.prototype.webkitRequestFullscreen=undefined;});
    const phone=await context.newPage(); await phone.goto(base+'/view/VIEWER-QA');
    assert.equal(await phone.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute('content'),'yes');
    await phone.locator('#quickFullscreenButton').click();
    assert(await phone.locator('#mobileViewingHelp').isVisible());
    assert((await phone.locator('#mobileViewingHelp').innerText()).includes('隱藏工具列'));
    assert(!(await phone.locator('#mobileViewingHelp').innerText()).includes('加入主畫面'));
    assert.equal(await phone.locator('video,iframe').count(),0);
    await phone.locator('#expandReadingButton').click();
    assert(await phone.locator('#viewerFooter').isHidden());
    assert(await phone.locator('#showViewerToolbar').isVisible());
    await phone.locator('#showViewerToolbar').click();
    assert(await phone.locator('#viewerFooter').isVisible());
    await context.close();
  });
  await check('Home Screen mode expands reading without requesting native fullscreen', async () => {
    const context=await browser.newContext();
    await context.addInitScript(()=>Object.defineProperty(navigator,'standalone',{value:true}));
    const installed=await context.newPage();await installed.goto(base+'/view/VIEWER-QA');
    await installed.locator('#showViewerToolbar').click();
    assert.equal(await installed.locator('#fullscreenButton').innerText(),'展開閱讀');
    await installed.locator('#fullscreenButton').click();
    assert(await installed.locator('#viewerFooter').isHidden());
    await installed.locator('#showViewerToolbar').click();
    assert(await installed.locator('#viewerFooter').isVisible());
    await context.close();
  });
  await check('prefixed iPad fullscreen supports direct entry, settings recovery and exit', async () => {
    const context=await browser.newContext();
    await context.addInitScript(()=>{
      Object.defineProperty(document,'fullscreenEnabled',{value:false});
      Object.defineProperty(document,'webkitFullscreenEnabled',{value:true});
      window.prefixedRequests=0;
      Element.prototype.webkitRequestFullscreen=async()=>{
        prefixedRequests++;
        Object.defineProperty(document,'webkitFullscreenElement',{configurable:true,value:document.documentElement});
        document.dispatchEvent(new Event('webkitfullscreenchange'));
      };
      document.webkitExitFullscreen=async()=>{
        Object.defineProperty(document,'webkitFullscreenElement',{configurable:true,value:null});
        document.dispatchEvent(new Event('webkitfullscreenchange'));
      };
    });
    const tablet=await context.newPage();await tablet.goto(base+'/view/VIEWER-QA');
    assert.equal(await tablet.evaluate(()=>prefixedRequests),0,'no fullscreen request without viewer gesture');
    await tablet.locator('#quickFullscreenButton').click();
    assert.equal(await tablet.evaluate(()=>prefixedRequests),1);
    assert.equal(await tablet.locator('#quickFullscreenButton').innerText(),'離開全螢幕');
    await tablet.locator('#showViewerToolbar').click();
    assert(await tablet.locator('#viewerFooter').isVisible());
    await tablet.locator('#fullscreenButton').click();
    assert.equal(await tablet.evaluate(()=>document.webkitFullscreenElement),null);
    assert(await tablet.locator('#viewerFooter').isHidden());
    await context.close();
  });
  await check('rejected fullscreen stays truthful and needs no installation', async()=>{
    const context=await browser.newContext();
    await context.addInitScript(()=>{Element.prototype.requestFullscreen=async()=>{throw new Error('Not permitted');};});
    const denied=await context.newPage();await denied.goto(base+'/view/VIEWER-QA');
    await denied.locator('#quickFullscreenButton').click();
    assert(await denied.locator('#mobileViewingHelp').isVisible());
    assert(!await denied.evaluate(()=>!!document.fullscreenElement));
    assert(!(await denied.locator('#mobileViewingHelp').innerText()).includes('加入主畫面'));
    await denied.locator('#expandReadingButton').click();
    assert(await denied.locator('#viewerFooter').isHidden());
    await context.close();
  });
  await check('compact reading controls fit phone tablet and laptop without covering final text',async()=>{
    const context=await browser.newContext();const writer=await context.newPage(),reader=await context.newPage();
    await writer.goto(base+'/edit/COMPACT');await writer.waitForFunction(()=>quill.isEnabled());
    await writer.evaluate(()=>quill.setText(Array.from({length:50},(_,i)=>`第${i}行，直接觀看字幕。\n`).join(''),'user'));
    await reader.goto(base+'/view/COMPACT');await reader.waitForFunction(()=>quill.getText().includes('第49行'));
    await writer.evaluate(()=>{const el=document.getElementById('editorContainer');el.scrollTop=el.scrollHeight;});
    await reader.evaluate(()=>document.fonts.ready);
    for(const size of [{width:320,height:568},{width:844,height:390},{width:1024,height:768},{width:1366,height:768}]){
      await reader.setViewportSize(size);
      await reader.waitForFunction(()=>{
        const el=document.getElementById('viewerContainer');return el.scrollHeight-el.scrollTop-el.clientHeight<3;
      });
      const metrics=await reader.evaluate(()=>{
        const last=quill.getText().trimEnd().length-1;
        return {lastBottom:document.getElementById('editor').getBoundingClientRect().top+quill.getBounds(last,1).bottom,
          actions:document.getElementById('viewerQuickActions').getBoundingClientRect().toJSON(),overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert(!metrics.overflow);
      assert(metrics.actions.left>=0&&metrics.actions.right<=size.width);
      assert(metrics.lastBottom<metrics.actions.top-5,JSON.stringify({size,metrics}));
      assert(await reader.locator('#viewerFooter').isHidden());
    }
    await reader.screenshot({path:resolve(output,'免安裝觀眾閱讀版測試.png')});
    await context.close();
  });
  await check('connection interruption remains visible while reading settings are hidden',async()=>{
    const context=await browser.newContext();const reader=await context.newPage();await reader.goto(base+'/view/VIEWER-QA');
    await reader.waitForFunction(()=>document.getElementById('readingConnectionStatus').hidden);
    await reader.evaluate(()=>socket.disconnect());
    await reader.locator('#readingConnectionStatus').waitFor({state:'visible'});
    assert((await reader.locator('#readingConnectionStatus').innerText()).includes('離線'));
    assert(await reader.locator('#viewerFooter').isHidden());
    await reader.evaluate(()=>socket.connect());
    await reader.waitForFunction(()=>document.getElementById('readingConnectionStatus').hidden);
    await context.close();
  });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(output,'viewer-tests.json'), JSON.stringify({results,errors,note:'Wake Lock lifecycle uses a mock; actual phone power and lock-screen behavior requires device acceptance.'}, null, 2));
} catch (e) { console.error(e, logs.slice(-1500)); process.exitCode=1; }
finally { if(browser) await browser.close(); server.kill(); }
