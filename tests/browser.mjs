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
const extraBrowsers = [];
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
  if (process.env.TEST_FILTER && !new RegExp(process.env.TEST_FILTER).test(name)) return;
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
    await a.evaluate(() => socket.emit('claim_master'));
    await a.waitForFunction(() => amIMaster);
    await a.bringToFront();
    await a.evaluate(() => { quill.focus(); quill.setSelection(quill.getLength() - 1, 0); });
    const input = await browser.newCDPSession(a);
    await input.send('Input.imeSetComposition', { text: 'ㄓㄨㄥ', selectionStart: 3, selectionEnd: 3 });
    await b.waitForFunction(() => document.querySelector('.remote-ime-preview')?.dataset.preview?.includes('ㄓㄨㄥ'));
    assert(!(await content(b)).includes('ㄓㄨㄥ'));
    assert(!(await content(viewer)).includes('ㄓㄨㄥ'));
    await viewer.waitForFunction(() => document.querySelector('.remote-ime-preview')?.dataset.preview === 'ㄓㄨㄥ');
    assert.equal(await a.locator('.remote-ime-preview').count(), 0);
    await input.send('Input.imeSetComposition', { text: 'ㄓㄨㄥˋ', selectionStart: 4, selectionEnd: 4 });
    await b.waitForFunction(() => document.querySelector('.remote-ime-preview')?.dataset.preview?.includes('ㄓㄨㄥˋ'));
    await b.evaluate(() => quill.insertText(0, '選字時校正', 'user'));
    await delay(250);
    assert(!(await content(a)).includes('選字時校正'));
    await input.send('Input.insertText', { text: '正式中文' });
    const value = await synced(pages);
    assert(value.includes('正式中文') && value.includes('選字時校正'));
    assert(!value.includes('ㄓㄨㄥ'));
    await b.waitForFunction(() => !document.querySelector('.remote-ime-preview'));
    await input.detach();
  });
  await check('cancelled native IME removes partner preview without changing draft', async () => {
    await a.bringToFront();
    await a.evaluate(() => { quill.focus(); quill.setSelection(quill.getLength() - 1, 0); });
    const before = await content(b);
    const input = await browser.newCDPSession(a);
    await input.send('Input.imeSetComposition', { text: 'ㄅㄆㄇ', selectionStart: 3, selectionEnd: 3 });
    await b.waitForFunction(() => document.querySelector('.remote-ime-preview')?.dataset.preview?.includes('ㄅㄆㄇ'));
    await input.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await b.waitForFunction(() => !document.querySelector('.remote-ime-preview'));
    await synced(pages);
    assert.equal(await content(b), before);
    await input.detach();
  });
  await check('uncommitted middle-of-sentence Zhuyin reflows following text without changing document or undo', async () => {
    const x = await browser.newPage(), y = await browser.newPage();
    await Promise.all([x.goto(`${base}/edit/INLINE`), y.goto(`${base}/edit/INLINE`)]);
    await synced([x,y]);
    await x.evaluate(() => quill.insertText(0, '今天我們一起開會。', 'user'));
    await synced([x,y]);
    const before = await y.evaluate(() => ({text:quill.getText(), delta:quill.getContents(),
      length:quill.getLength(), bounds:quill.getBounds(4,1), undo:collaboration.undo.undoStack.length}));
    await x.bringToFront();
    await x.evaluate(() => {quill.focus();quill.setSelection(4,0);});
    const input = await browser.newCDPSession(x);
    await input.send('Input.imeSetComposition',{text:'ㄓㄨㄥ',selectionStart:3,selectionEnd:3});
    await y.waitForFunction(() => document.querySelector('.ql-editor .remote-ime-preview')?.dataset.preview==='ㄓㄨㄥ');
    const during = await y.evaluate(() => ({text:quill.getText(), delta:quill.getContents(),
      length:quill.getLength(), bounds:quill.getBounds(4,1), undo:collaboration.undo.undoStack.length,
      css:getComputedStyle(document.querySelector('.remote-ime-preview'),'::before').content,
      size:getComputedStyle(document.querySelector('.remote-ime-preview')).fontSize,
      editorSize:getComputedStyle(quill.root).fontSize, html:quill.getSemanticHTML()}));
    assert.equal(during.text,before.text);
    assert.deepEqual(during.delta,before.delta);
    assert.equal(during.length,before.length);
    assert.equal(during.undo,before.undo);
    assert(during.bounds.left>before.bounds.left+90,'following character must actually move in text flow');
    assert(during.css.includes('ㄓㄨㄥ'));
    assert.equal(during.size,during.editorSize);
    assert(!during.html.includes('ㄓㄨㄥ') && !during.html.includes('remote-ime-preview'));
    await y.screenshot({path:resolve(dir,'inline-preedit.png')});
    await input.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
    await y.waitForFunction(() => !document.querySelector('.remote-ime-preview'));
    await synced([x,y]);
    const after=await y.evaluate(() => ({text:quill.getText(),bounds:quill.getBounds(4,1)}));
    assert.equal(after.text,before.text);
    assert(Math.abs(after.bounds.left-before.bounds.left)<1,'cancel restores original layout');
    await input.detach();await x.close();await y.close();
  });
  await check('real partner typing and deletion through inline preedit preserve cursor and converge', async () => {
    const peerBrowser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
    extraBrowsers.push(peerBrowser);
    const x=await browser.newPage(),y=await peerBrowser.newPage({viewport:{width:1365,height:900}});
    await Promise.all([x.goto(`${base}/edit/INLINEEDIT`),y.goto(`${base}/edit/INLINEEDIT`)]);
    await synced([x,y]);
    await x.evaluate(() => quill.insertText(0,'今天我們一起開會。','user'));
    await synced([x,y]);
    await x.bringToFront();await x.evaluate(() => {quill.focus();quill.setSelection(4,0);});
    const input=await browser.newCDPSession(x);
    await input.send('Input.imeSetComposition',{text:'ㄓㄨㄥ',selectionStart:3,selectionEnd:3});
    await y.waitForFunction(() => document.querySelector('.ql-editor .remote-ime-preview'));
    await y.bringToFront();await y.evaluate(() => {quill.focus();quill.setSelection(7,0);});
    await y.keyboard.type('B');
    assert.equal(await y.evaluate(() => quill.getSelection().index),8);
    assert.equal(await content(y),'今天我們一起開B會。\n');
    await y.evaluate(() => quill.setSelection(2,4));
    await y.keyboard.press('Backspace');
    assert.equal(await y.evaluate(() => quill.getSelection().index),2);
    await input.send('Input.insertText',{text:'中'});
    const value=await synced([x,y]);
    assert(value.includes('中') && value.includes('B') && !value.includes('ㄓㄨㄥ'),JSON.stringify(value));
    assert.equal(await y.locator('.remote-ime-preview').count(),0);
    await input.detach();await x.close();await peerBrowser.close();
  });
  await check('Enter hands off plain preedit to committed text without a blank or duplicate frame under latency', async () => {
    const peerBrowser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
    extraBrowsers.push(peerBrowser);
    const x=await browser.newPage(),y=await peerBrowser.newPage({viewport:{width:1365,height:900}});
    await Promise.all([x.goto(`${base}/edit/HANDOFF`),y.goto(`${base}/edit/HANDOFF`)]);
    await synced([x,y]);
    await x.evaluate(()=>quill.insertText(0,'甲尾字','user'));
    await synced([x,y]);
    await x.evaluate(()=>{quill.focus();quill.setSelection(1,0);});
    const input=await browser.newCDPSession(x);
    await input.send('Input.imeSetComposition',{text:'中',selectionStart:1,selectionEnd:1});
    await y.waitForFunction(()=>document.querySelector('.remote-ime-preview')?.dataset.preview==='中');
    const style=await y.locator('.remote-ime-preview').evaluate(el=>({background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderBottomWidth,color:getComputedStyle(el).color,parentColor:getComputedStyle(el.parentNode).color}));
    assert.equal(style.background,'rgba(0, 0, 0, 0)');assert.equal(style.border,'0px');assert.equal(style.color,style.parentColor);
    await y.evaluate(()=>{
      const handler=socket.listeners('document_update')[0];
      socket.off('document_update',handler);
      socket.on('document_update',data=>setTimeout(()=>handler(data),450));
      window.handoffFrames=[];
      window.sampleHandoff=()=>{
        const draft=[...document.querySelectorAll('.remote-ime-preview')].map(el=>el.dataset.preview).join('');
        const count=((quill.getText()+draft).match(/中/g)||[]).length;
        const tail=quill.getBounds(quill.getText().indexOf('尾'),1).left;
        window.handoffFrames.push({count,tail});
      };
      window.sampleHandoff();
      window.handoffTimer=setInterval(window.sampleHandoff,10);
      window.handoffRaf=()=>{window.sampleHandoff();window.handoffFrame=requestAnimationFrame(window.handoffRaf);};
      window.handoffFrame=requestAnimationFrame(window.handoffRaf);
    });
    await input.send('Input.insertText',{text:'中'});
    await y.waitForFunction(()=>[...collaboration.awareness.getStates().values()].some(s=>s.compositionCommit&&!s.composing));
    assert.equal(await content(y),'甲尾字\n','formal update intentionally still delayed');
    assert.equal(await y.locator('.remote-ime-preview').getAttribute('data-preview'),'中','keep preview until matching state arrives');
    await y.waitForFunction(()=>quill.getText()==='甲中尾字\n'&&!document.querySelector('.remote-ime-preview'));
    await delay(120);
    const frames=await y.evaluate(()=>{clearInterval(window.handoffTimer);cancelAnimationFrame(window.handoffFrame);return window.handoffFrames;});
    assert(frames.length>15);
    assert(frames.every(f=>f.count===1),'no sampled frame may be blank or show duplicate committed text');
    assert(frames.every(f=>Math.abs(f.tail-frames[0].tail)<1),'following text must not jump during handoff');
    await y.screenshot({path:resolve(dir,'plain-committed.png')});
    await input.detach();await x.close();await peerBrowser.close();
  });
  await check('inline preedit at empty paragraph allows partner to type and undo normally', async () => {
    const peerBrowser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
    extraBrowsers.push(peerBrowser);
    const x=await browser.newPage(),y=await peerBrowser.newPage();
    await Promise.all([x.goto(`${base}/edit/INLINEEMPTY`),y.goto(`${base}/edit/INLINEEMPTY`)]);
    await synced([x,y]);
    await x.bringToFront();await x.evaluate(() => {quill.focus();quill.setSelection(0,0);});
    const input=await browser.newCDPSession(x);
    await input.send('Input.imeSetComposition',{text:'ㄅㄆㄇ',selectionStart:3,selectionEnd:3});
    await y.waitForFunction(() => document.querySelector('.ql-editor .remote-ime-preview'));
    await y.bringToFront();await y.evaluate(() => {quill.focus();quill.setSelection(0,0);});
    await y.keyboard.type('abc');
    assert.equal(await y.evaluate(() => quill.getSelection().index),3);
    assert.equal(await content(y),'abc\n');
    await y.keyboard.press('Control+z');
    assert.equal(await content(y),'\n');
    await input.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
    assert.equal(await synced([x,y]),'\n');
    await input.detach();await x.close();await peerBrowser.close();
  });
  await check('starting the next IME session does not erase a previous commit still in transit', async () => {
    const peerBrowser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
    extraBrowsers.push(peerBrowser);
    const x=await browser.newPage(),y=await peerBrowser.newPage();
    await Promise.all([x.goto(`${base}/edit/NEXTHANDOFF`),y.goto(`${base}/edit/NEXTHANDOFF`)]);
    await synced([x,y]);await x.evaluate(()=>quill.insertText(0,'甲尾字','user'));await synced([x,y]);
    await x.evaluate(()=>{quill.focus();quill.setSelection(1,0);});
    const input=await browser.newCDPSession(x);
    await input.send('Input.imeSetComposition',{text:'中',selectionStart:1,selectionEnd:1});
    await y.waitForFunction(()=>document.querySelector('.remote-ime-preview')?.dataset.preview==='中');
    await y.evaluate(()=>{
      const handler=socket.listeners('document_update')[0];socket.off('document_update',handler);
      socket.on('document_update',data=>setTimeout(()=>handler(data),600));
    });
    await input.send('Input.insertText',{text:'中'});
    await y.waitForFunction(()=>[...collaboration.awareness.getStates().values()].some(s=>s.compositionCommit&&!s.composing));
    await x.evaluate(()=>quill.setSelection(2,0));
    await input.send('Input.imeSetComposition',{text:'ㄅ',selectionStart:1,selectionEnd:1});
    await y.waitForFunction(()=>[...collaboration.awareness.getStates().values()].some(s=>s.composing&&s.compositionPreview?.text==='ㄅ'));
    assert.equal(await content(y),'甲尾字\n');
    assert.equal(await y.locator('.remote-ime-preview').getAttribute('data-preview'),'中');
    await y.waitForFunction(()=>quill.getText()==='甲中尾字\n'&&document.querySelector('.remote-ime-preview')?.dataset.preview==='ㄅ');
    await input.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
    assert.equal(await synced([x,y]),'甲中尾字\n');
    await y.waitForFunction(()=>!document.querySelector('.remote-ime-preview'));
    await input.detach();await x.close();await peerBrowser.close();
  });
  await check('continuous rapid composition updates cannot starve partner preview', async () => {
    await a.evaluate(() => {
      quill.focus(); quill.setSelection(quill.getLength() - 1, 0);
      quill.root.dispatchEvent(new CompositionEvent('compositionstart'));
      let count = 0;
      window.fastCompositionTimer = setInterval(() => {
        quill.root.dispatchEvent(new CompositionEvent('compositionupdate', {data: `ㄓㄨㄥ${++count}`}));
      }, 5);
    });
    try {
      await b.waitForFunction(() => document.querySelector('.remote-ime-preview')?.dataset.preview?.includes('ㄓㄨㄥ'), null, {timeout: 1500, polling: 20});
    } finally {
      await a.evaluate(() => {
        clearInterval(window.fastCompositionTimer);
        quill.root.dispatchEvent(new CompositionEvent('compositionend'));
      });
    }
    await b.waitForFunction(() => !document.querySelector('.remote-ime-preview'));
    await synced(pages);
  });
  await check('multiple IME previews are text-only, track partner edits and clear on disconnect', async () => {
    await a.evaluate(() => {
      quill.focus(); quill.setSelection(3, 0);
      quill.root.dispatchEvent(new CompositionEvent('compositionstart'));
      quill.root.dispatchEvent(new CompositionEvent('compositionupdate', {data:'<img src=x onerror=alert(1)>ㄓ'}));
    });
    await b.waitForFunction(() => document.querySelector('.remote-ime-preview')?.dataset.preview?.includes('<img'));
    assert.equal(await b.locator('.remote-ime-preview img').count(), 0);
    await c.evaluate(() => {
      quill.focus(); quill.setSelection(5, 0);
      quill.root.dispatchEvent(new CompositionEvent('compositionstart'));
      quill.root.dispatchEvent(new CompositionEvent('compositionupdate', {data:'ㄅㄆ'}));
    });
    await b.waitForFunction(() => document.querySelectorAll('.remote-ime-preview').length === 2);
    const before = await b.locator('.remote-ime-preview').first().evaluate(el => el.getBoundingClientRect().left);
    await b.evaluate(() => quill.insertText(0, '前補', 'user'));
    await b.waitForFunction(before => document.querySelector('.remote-ime-preview').getBoundingClientRect().left !== before, before);
    await a.evaluate(() => socket.disconnect());
    await b.waitForFunction(() => document.querySelectorAll('.remote-ime-preview').length === 1);
    await a.evaluate(() => { quill.root.dispatchEvent(new CompositionEvent('compositionend')); socket.connect(); });
    await c.evaluate(() => quill.root.dispatchEvent(new CompositionEvent('compositionend')));
    await b.waitForFunction(() => !document.querySelector('.remote-ime-preview'));
    await synced(pages);
  });
  await check('preview remains visible when new composition follows an unsent completed edit', async () => {
    await a.evaluate(() => {
      quill.insertText(0, '剛完成', 'user');
      quill.focus(); quill.setSelection(2, 0);
      quill.root.dispatchEvent(new CompositionEvent('compositionstart'));
      quill.root.dispatchEvent(new CompositionEvent('compositionupdate', {data:'ㄓㄨㄥ'}));
    });
    try {
      await b.waitForFunction(() => document.querySelector('.remote-ime-preview')?.dataset.preview?.includes('ㄓㄨㄥ'), null, {timeout:1500,polling:20});
      assert((await content(b)).includes('剛完成'));
      assert(!(await content(b)).includes('ㄓㄨㄥ'));
    } finally {
      await a.evaluate(() => quill.root.dispatchEvent(new CompositionEvent('compositionend')));
    }
    await synced(pages);
  });
  await check('simultaneous IME keeps partner preview visible before its anchor text can be applied', async () => {
    const before = await content(b);
    await b.evaluate(() => {
      quill.focus(); quill.setSelection(0,0);
      quill.root.dispatchEvent(new CompositionEvent('compositionstart'));
      quill.root.dispatchEvent(new CompositionEvent('compositionupdate',{data:'ㄅㄆㄇ'}));
    });
    await a.evaluate(() => {
      quill.insertText(0,'先完成的新詞','user');
      quill.focus(); quill.setSelection(2,0);
      quill.root.dispatchEvent(new CompositionEvent('compositionstart'));
      quill.root.dispatchEvent(new CompositionEvent('compositionupdate',{data:'ㄓㄨㄥ'}));
      quill.insertText(quill.getLength()-1,'本次組字中的修改','user');
    });
    await b.waitForFunction(() => document.getElementById('peerImeStatus').textContent.includes('ㄓㄨㄥ'));
    assert.equal(await content(b),before);
    assert((await b.locator('#imePreviewStatus').innerText()).includes('ㄅㄆㄇ'));
    await b.evaluate(() => quill.root.dispatchEvent(new CompositionEvent('compositionend')));
    await b.waitForFunction(() => quill.getText().includes('先完成的新詞'));
    assert(!(await content(b)).includes('本次組字中的修改'));
    await a.evaluate(() => quill.root.dispatchEvent(new CompositionEvent('compositionend')));
    await synced(pages);
    await b.waitForFunction(() => document.getElementById('peerImeStatus').dataset.peerCount==='0');
  });
  await check('completed updates behind an in-flight save are sent during the next IME session', async () => {
    await a.evaluate(() => {
      const original=socket.emit;
      window.heldSave=false;
      socket.emit=function(event,...args) {
        if(event==='document_update') {
          socket.emit=original;
          const callback=args.pop(); window.heldSave=true;
          return original.call(this,event,...args,(...reply)=>setTimeout(()=>callback(...reply),350));
        }
        return original.call(this,event,...args);
      };
      quill.insertText(0,'前筆','user');
    });
    await a.waitForFunction(()=>window.heldSave);
    await a.evaluate(()=>{
      quill.insertText(0,'接續完成','user');
      quill.focus();quill.setSelection(2,0);
      quill.root.dispatchEvent(new CompositionEvent('compositionstart'));
      quill.root.dispatchEvent(new CompositionEvent('compositionupdate',{data:'ㄒㄧㄣ'}));
    });
    await b.waitForFunction(()=>quill.getText().includes('接續完成'));
    await b.waitForFunction(()=>document.querySelector('.remote-ime-preview')?.dataset.preview?.includes('ㄒㄧㄣ'));
    assert(!(await content(b)).includes('ㄒㄧㄣ'));
    await a.evaluate(()=>quill.root.dispatchEvent(new CompositionEvent('compositionend')));
    await synced(pages);
  });
  await check('native IME preview survives missing compositionupdate and null input data', async () => {
    for (const domFallback of [false, true]) {
      await a.bringToFront();
      await a.evaluate(domFallback => {
        quill.focus(); quill.setSelection(quill.getLength() - 1, 0);
        window.suppressComposition = event => event.stopImmediatePropagation();
        window.nullCompositionInput = event => { if (event.isComposing) Object.defineProperty(event, 'data', {value: null}); };
        quill.root.addEventListener('compositionupdate', window.suppressComposition, true);
        if (domFallback) {
          quill.root.addEventListener('beforeinput', window.suppressComposition, true);
          quill.root.addEventListener('input', window.nullCompositionInput, true);
        }
      }, domFallback);
      const input = await browser.newCDPSession(a);
      await input.send('Input.imeSetComposition', {text:'ㄅㄆㄇ',selectionStart:3,selectionEnd:3});
      await b.waitForFunction(() => document.querySelector('.remote-ime-preview')?.dataset.preview?.includes('ㄅㄆㄇ'));
      const source = await a.locator('#imePreviewStatus').getAttribute('data-source');
      assert.equal(source, domFallback ? 'input-dom' : 'input');
      assert(!(await content(b)).includes('ㄅㄆㄇ'));
      await input.send('Input.imeSetComposition', {text:'',selectionStart:0,selectionEnd:0});
      await a.evaluate(() => {
        quill.root.removeEventListener('compositionupdate', window.suppressComposition, true);
        quill.root.removeEventListener('beforeinput', window.suppressComposition, true);
        quill.root.removeEventListener('input', window.nullCompositionInput, true);
      });
      await b.waitForFunction(() => !document.querySelector('.remote-ime-preview'));
      await synced(pages);
      await input.detach();
    }
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
  await check('all editors share layout settings and new tabs load the same program version', async () => {
    const flags = await Promise.all(pages.map(p => p.evaluate(() => amIMaster)));
    const master = pages[flags.indexOf(true)];
    assert(master);
    await master.evaluate(() => {
      document.body.dataset.theme = 'green';
      document.getElementById('fontSizeInput').value = '54';
      document.getElementById('scaleInput').value = '115';
      document.getElementById('padXInput').value = '26';
      document.getElementById('padYInput').value = '22';
      applyAndSync();
    });
    for (const page of pages) await page.waitForFunction(() => document.querySelector('.ql-editor').style.fontSize === '54px' && document.body.dataset.theme === 'green');
    const expected = await master.evaluate(() => ({font:getComputedStyle(quill.root).fontFamily,size:quill.root.style.fontSize,zoom:quill.root.style.zoom,padding:quill.root.style.padding}));
    for (const page of pages) {
      assert.deepEqual(await page.evaluate(() => ({font:getComputedStyle(quill.root).fontFamily,size:quill.root.style.fontSize,zoom:quill.root.style.zoom,padding:quill.root.style.padding})),expected);
      assert.equal(await page.locator('#fontSizeInput').isDisabled(), page !== master);
    }
    const fresh=await browser.newPage();await fresh.goto(`${base}/edit/TEST`);
    await fresh.waitForFunction(() => document.querySelector('.ql-editor').style.fontSize==='54px');
    const health=await (await fetch(base+'/healthz')).json();
    assert((await fresh.locator('#clientVersionText').innerText()).includes(health.asset_version));
    assert((await fresh.locator('script[src*="collaboration.js"]').getAttribute('src')).includes('v='+health.asset_version));
    await fresh.close();
    await master.evaluate(() => {
      document.body.dataset.theme='dark';document.getElementById('fontSizeInput').value='48';
      document.getElementById('scaleInput').value='100';document.getElementById('padXInput').value='8';document.getElementById('padYInput').value='10';applyAndSync();
    });
  });
  await check('partner version mismatch is visible instead of silently using an old editor', async () => {
    await b.evaluate(() => collaboration.awareness.setLocalStateField('clientVersion','old-test-version'));
    await a.waitForFunction(() => document.getElementById('peerImeStatus').dataset.outdated==='true');
    assert((await a.locator('#peerImeStatus').innerText()).includes('舊版'));
    const health=await (await fetch(base+'/healthz')).json();
    await b.evaluate(version => collaboration.awareness.setLocalStateField('clientVersion',version),health.asset_version);
    await a.waitForFunction(() => document.getElementById('peerImeStatus').dataset.outdated==='false');
    const versions=JSON.parse(await a.locator('#peerImeStatus').getAttribute('data-peer-versions'));
    assert.equal(versions.length,2);
    assert(versions.every(peer=>peer.current));
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
  await Promise.all(extraBrowsers.map(item => item.close()));
  if (browser) await browser.close();
  if (server) server.kill();
}

