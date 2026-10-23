import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5130';
const testDir = mkdtempSync(resolve('../projection-'));
const server = spawn(process.env.PYTHON || '.venv/Scripts/python.exe', ['app.py'], {env:{...process.env, PORT:'5130', SUBFLOW_DB:resolve(testDir,'test.sqlite3'), SECRET_KEY:'projection-test'}});
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
    await viewer.locator('#showViewerToolbar').click(); await viewer.locator('#followMasterButton').click(); await viewer.locator('#hideViewerToolbar').click(); await atAnchor(viewer,next);
  });
  await check('reload joins current projection and defaults to following',async()=>{ await viewer.reload(); await viewer.waitForFunction(()=>document.querySelector('.ql-editor').textContent.includes('第099行')); await viewer.evaluate(()=>document.fonts.ready); await atAnchor(viewer,next); });
  await check('master zoom and viewer font zoom keep same text anchor',async()=>{
    await editor.locator('#scaleInput').fill('150'); await editor.locator('#scaleInput').dispatchEvent('change');
    await move(editor,anchor); await atAnchor(viewer,anchor);
    await viewer.locator('#showViewerToolbar').click(); await viewer.getByRole('button',{name:'放大文字',exact:true}).click(); await viewer.locator('#hideViewerToolbar').click(); await atAnchor(viewer,anchor);
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
  await check('tablet follows the last visible text at the same viewport height despite trailing blank lines',async()=>{
    const source=await desk.newPage(), tablet=await mobile.newPage();
    await source.goto(base+'/edit/TABLET'); await source.waitForFunction(()=>quill.isEnabled());
    const script=Array.from({length:40},(_,i)=>`段落${i}：比賽時間與賽後檢討會，觀眾跟隨主控。\n`).join('')+'下午比賽時間\n13:00–15:15\n比賽後\n會有簡單的檢討會\n可以留下來參與'+ '\n'.repeat(6);
    await source.evaluate(t=>quill.insertText(0,t,'user'),script);
    await tablet.setViewportSize({width:1024,height:768});
    await tablet.goto(base+'/view/TABLET'); await tablet.waitForFunction(()=>quill.getText().includes('可以留下來參與'));
    await Promise.all([source.evaluate(()=>document.fonts.ready),tablet.evaluate(()=>document.fonts.ready)]);
    await source.evaluate(()=>{const c=document.getElementById('editorContainer');c.scrollTop=c.scrollHeight;});
    const expectPosition=async()=>{
      await tablet.waitForFunction(()=>{
        if(!projection?.anchor||!Number.isFinite(projection.viewport_y))return false;
        const i=collaboration.resolveProjectionAnchor(projection.anchor);if(i==null)return false;
        const c=document.getElementById('viewerContainer');const y=quill.container.getBoundingClientRect().top-c.getBoundingClientRect().top+quill.getBounds(i).top;
        return y>=-1&&y<c.clientHeight&&Math.abs(y-projection.viewport_y*c.clientHeight)<3;
      });
    };
    await expectPosition();
    const anchor=await tablet.evaluate(()=>collaboration.resolveProjectionAnchor(projection.anchor));
    assert.equal(await tablet.evaluate(i=>quill.getText(i-2,3),anchor), '來參與');
    await tablet.setViewportSize({width:768,height:1024});await expectPosition();
    await tablet.setViewportSize({width:390,height:844});await expectPosition();
    await tablet.reload();await tablet.waitForFunction(()=>quill.getText().includes('可以留下來參與'));await tablet.evaluate(()=>document.fonts.ready);await expectPosition();
    await tablet.setViewportSize({width:1024,height:768});await expectPosition();
    await source.screenshot({path:'../../outputs/定位修正主控測試.png'});await tablet.screenshot({path:'../../outputs/定位修正觀眾測試.png'});
    await source.evaluate(()=>quill.insertText(quill.getLength()-1,'\n'.repeat(30),'user'));
    await source.evaluate(()=>{const c=document.getElementById('editorContainer');c.scrollTop=c.scrollHeight;});
    await expectPosition();
    await source.close();await tablet.close();
  });
  await check('delayed document delivery does not clamp a new projection anchor to old text',async()=>{
    const source=await desk.newPage(), reader=await mobile.newPage();
    await source.goto(base+'/edit/ORDER');await source.waitForFunction(()=>quill.isEnabled());
    await source.evaluate(()=>quill.insertText(0,'第一段\n'.repeat(80),'user'));
    await reader.goto(base+'/view/ORDER');await reader.waitForFunction(()=>quill.getText().includes('第一段'));await reader.evaluate(()=>document.fonts.ready);
    await reader.evaluate(()=>{const original=socket.onevent.bind(socket);socket.onevent=packet=>packet.data?.[0]==='document_update'?setTimeout(()=>original(packet),350):original(packet);});
    await source.evaluate(()=>{quill.insertText(quill.getLength()-1,'最新稿件，投影訊息可能先到。','user');const c=document.getElementById('editorContainer');c.scrollTop=c.scrollHeight;});
    await reader.waitForFunction(()=>quill.getText().includes('最新稿件，投影訊息可能先到。'));
    await reader.waitForFunction(()=>{const i=collaboration.resolveProjectionAnchor(projection?.anchor);if(i==null)return false;const c=document.getElementById('viewerContainer');const y=quill.container.getBoundingClientRect().top-c.getBoundingClientRect().top+quill.getBounds(i).top;return y>=0&&y<c.clientHeight;});
    await source.close();await reader.close();
  });
  await check('new collaborator waits for the shared font before applying initial viewport',async()=>{
    const source=await desk.newPage();await source.goto(base+'/edit/FONT-JOIN');await source.waitForFunction(()=>quill.isEnabled());
    const script='共同稿件與標楷字型對齊。'.repeat(800);await source.evaluate(t=>quill.insertText(0,t,'user'),script);await source.evaluate(()=>document.fonts.ready);
    await move(source,4000);
    const cold=await browser.newContext({viewport:{width:1100,height:750}});
    await cold.route('**/moe-kai.ttf',async route=>{await new Promise(r=>setTimeout(r,600));await route.continue();});
    const peer=await cold.newPage();await peer.goto(base+'/edit/FONT-JOIN');await peer.waitForFunction(()=>initialViewportApplied);
    await peer.waitForFunction(()=>{if(!initialProjection)return false;const i=collaboration.resolveProjectionAnchor(initialProjection.anchor);if(i==null)return false;const c=document.getElementById('editorContainer');const y=quill.container.getBoundingClientRect().top-c.getBoundingClientRect().top+quill.getBounds(i).top;return Math.abs(y-initialProjection.viewport_y*c.clientHeight)<3;});
    assert(await peer.evaluate(()=>document.fonts.check('48px "TW-Kai"','共筆')));await cold.close();await source.close();
  });
  await check('fullscreen hides toolbar but visible recovery restores controls and exits',async()=>{
    const full=await desk.newPage(); await full.goto(base+'/view/PROJECTION');
    await full.locator('#quickFullscreenButton').click();
    await full.waitForFunction(()=>!!document.fullscreenElement);
    assert(await full.locator('#viewerFooter').isHidden()); assert(await full.locator('#showViewerToolbar').isVisible());
    await full.locator('#showViewerToolbar').click(); assert(await full.locator('#viewerFooter').isVisible());
    await full.locator('#fullscreenButton').click(); await full.waitForFunction(()=>!document.fullscreenElement);
    assert(await full.locator('#viewerFooter').isHidden()); assert(await full.locator('#quickFullscreenButton').isVisible()); await full.close();
  });
  assert.deepEqual(errors,[]);
  writeFileSync('../../outputs/projection-tests.json',JSON.stringify({results,errors},null,2));
} catch(e) {console.error(e,logs.slice(-1000));process.exitCode=1;}
finally {if(browser)await browser.close();server.kill();}
