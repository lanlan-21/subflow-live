import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5130';
const server = spawn(process.env.PYTHON || '.venv/Scripts/python.exe', ['app.py'], {env:{...process.env, PORT:'5130', SUBFLOW_DB:resolve('../projection-test.sqlite3'), SECRET_KEY:'projection-test'}});
let browser, logs='';
server.stderr.on('data', d=>logs+=d);
const results=[];
async function check(name, fn) { await fn(); results.push(name); console.log('PASS',name); }
async function move(page, index) {
  await page.evaluate(index => { const el=document.getElementById('editorContainer'); el.scrollTop += document.getElementById('editor').getBoundingClientRect().top - el.getBoundingClientRect().top + quill.getBounds(index).top; }, index);
}
async function atAnchor(page, index) {
  await page.waitForFunction(index => { const el=document.getElementById('viewerContainer'); const offset=document.getElementById('editor').getBoundingClientRect().top-el.getBoundingClientRect().top; return Math.abs(offset+quill.getBounds(index).top)<3; },index);
}
try {
  for(let n=0;n<100;n++) { try { if((await fetch(base+'/healthz')).ok)break; }catch{} await new Promise(r=>setTimeout(r,100)); }
  browser=await chromium.launch({channel:'chrome',headless:true});
  const desk=await browser.newContext({viewport:{width:1100,height:750}});
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true});
  const editor=await desk.newPage(), viewer=await mobile.newPage();
  const errors=[];
  for(const p of [editor,viewer])p.on('pageerror',e=>errors.push(e.message));
  await editor.goto(base+'/edit/PROJECTION');
  await editor.waitForFunction(()=>document.getElementById('syncStatus').textContent.startsWith('所有修改'));
  const text=Array.from({length:100},(_,i)=>`第${String(i).padStart(3,'0')}行：聽打內容與夥伴補字👏，不同螢幕也跟隨同一段文字。\n`).join('');
  const anchor=text.indexOf('第037行'), next=text.indexOf('第060行');
  await editor.evaluate(text=>quill.setText(text),text);
  await viewer.goto(base+'/view/PROJECTION');
  await viewer.waitForFunction(()=>document.querySelector('.ql-editor').textContent.includes('第099行'));
  await Promise.all([editor.evaluate(()=>document.fonts.ready),viewer.evaluate(()=>document.fonts.ready)]);
  await check('phone follows master text anchor rather than document bottom',async()=>{ await move(editor,anchor); await atAnchor(viewer,anchor); });
  await check('manual reading pauses following and button resumes latest projection',async()=>{
    await viewer.locator('#viewerContainer').hover(); await viewer.mouse.wheel(0,-400);
    await viewer.waitForFunction(()=>document.getElementById('followMasterButton').getAttribute('aria-pressed')==='false');
    const before=await viewer.locator('#viewerContainer').evaluate(e=>e.scrollTop);
    await move(editor,next); await editor.waitForTimeout(400);
    assert.equal(await viewer.locator('#viewerContainer').evaluate(e=>e.scrollTop),before);
    await viewer.locator('#followMasterButton').click(); await atAnchor(viewer,next);
  });
  await check('reload joins current projection and defaults to following',async()=>{ await viewer.reload(); await viewer.waitForFunction(()=>document.querySelector('.ql-editor').textContent.includes('第099行')); await viewer.evaluate(()=>document.fonts.ready); await atAnchor(viewer,next); });
  await check('master zoom and viewer font zoom keep same text anchor',async()=>{
    await editor.locator('#scaleInput').fill('150'); await editor.locator('#scaleInput').dispatchEvent('change');
    await move(editor,anchor); await atAnchor(viewer,anchor);
    await viewer.getByRole('button',{name:'放大文字',exact:true}).click(); await atAnchor(viewer,anchor);
  });
  await check('partner cannot move audience until becoming projection master',async()=>{
    const partner=await desk.newPage(); await partner.goto(base+'/edit/PROJECTION');
    await partner.waitForFunction(()=>document.querySelector('.ql-editor').textContent.includes('第099行'));
    await partner.evaluate(()=>document.fonts.ready); await move(partner,next); await partner.waitForTimeout(400); await atAnchor(viewer,anchor);
    await partner.locator('#masterToggleBtn').click(); await atAnchor(viewer,next); await partner.close();
  });
  await check('both screens load the same bundled Kai font',async()=>{
    for(const p of [editor,viewer])assert(await p.evaluate(()=>document.fonts.check('48px "TW-Kai"','聽打')));
  });
  await check('fullscreen hides toolbar but visible recovery restores controls and exits',async()=>{
    const full=await desk.newPage(); await full.goto(base+'/view/PROJECTION');
    await full.locator('#fullscreenButton').click();
    await full.waitForFunction(()=>!!document.fullscreenElement);
    assert(await full.locator('#viewerFooter').isHidden()); assert(await full.locator('#showViewerToolbar').isVisible());
    await full.locator('#showViewerToolbar').click(); assert(await full.locator('#viewerFooter').isVisible());
    await full.locator('#fullscreenButton').click(); await full.waitForFunction(()=>!document.fullscreenElement);
    assert(await full.locator('#viewerFooter').isVisible()); await full.close();
  });
  assert.deepEqual(errors,[]);
  writeFileSync('../../outputs/projection-tests.json',JSON.stringify({results,errors},null,2));
} catch(e) {console.error(e,logs.slice(-1000));process.exitCode=1;}
finally {if(browser)await browser.close();server.kill();}
