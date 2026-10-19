import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
const dir=mkdtempSync(resolve('../viewer-live-')),base='http://127.0.0.1:5132';
const server=spawn('.venv/Scripts/python.exe',['app.py'],{env:{...process.env,PORT:'5132',SUBFLOW_DB:resolve(dir,'test.sqlite3'),SECRET_KEY:'viewer-live-test'}});
let logs='',main,other;const results=[],errors=[];
server.stderr.on('data',v=>logs+=v);
async function check(name,fn){await fn();results.push(name);console.log('PASS',name);}
try{
 for(let i=0;i<100;i++){try{if((await fetch(base+'/healthz')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 main=await chromium.launch({channel:'chrome',headless:true});other=await chromium.launch({channel:'chrome',headless:true});
 const a=await main.newPage({viewport:{width:1200,height:800}}),b=await other.newPage({viewport:{width:1200,height:800}});
 const mobile=await main.newContext({viewport:{width:390,height:844},isMobile:true});const v=await mobile.newPage();
 for(const p of[a,b,v])p.on('pageerror',e=>errors.push(e.message));
 await a.goto(base+'/edit/MIRROR');await a.waitForFunction(()=>quill.isEnabled());
 await b.goto(base+'/edit/MIRROR');await b.waitForFunction(()=>quill.isEnabled());
 await a.evaluate(()=>quill.setText('主持人：今天一起開會。','user'));
 await b.waitForFunction(()=>quill.getText().includes('主持人'));
 await v.goto(base+'/view/MIRROR');await v.waitForFunction(()=>quill.getText().includes('主持人'));
 const ca=await a.context().newCDPSession(a),cb=await b.context().newCDPSession(b);
 await a.evaluate(()=>{quill.focus();quill.setSelection(4,0);});
 await check('audience sees projection master Zhuyin before Enter at 60px',async()=>{
  await ca.send('Input.imeSetComposition',{text:'ㄓㄨㄥ',selectionStart:3,selectionEnd:3});
  await v.waitForFunction(()=>document.querySelector('.remote-ime-preview')?.dataset.preview==='ㄓㄨㄥ');
  assert.equal(await v.locator('.ql-editor').evaluate(el=>getComputedStyle(el).fontSize),'60px');
  assert.equal(await v.evaluate(()=>quill.isEnabled()),false);
  assert(!(await v.evaluate(()=>quill.getText())).includes('ㄓㄨㄥ'));
  await v.screenshot({path:'../../outputs/觀眾即時組字手機測試.png'});
 });
 await check('long unfinished composition streams continuously and scrolls into view',async()=>{
  const text='即時聽打的內容不必等待整串確認。'.repeat(18)+'ㄅㄆㄇ';
  await ca.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});
  await v.waitForFunction(t=>document.querySelector('.remote-ime-preview')?.dataset.preview===t,text);
  // Force the master to its projection bottom, as in a live transcription session.
  await a.evaluate(()=>{const el=document.getElementById('editorContainer');el.scrollTop=el.scrollHeight;});
  await v.waitForFunction(()=>{const el=document.getElementById('viewerContainer');return el.scrollTop>100&&el.scrollHeight-el.scrollTop-el.clientHeight<3;});
  assert(text.length>160);
 });
 await check('manual audience scroll pauses following while preedit keeps updating',async()=>{
  await v.locator('#viewerContainer').hover();await v.mouse.wheel(0,-400);
  await v.waitForFunction(()=>document.getElementById('followMasterButton').getAttribute('aria-pressed')==='false');
  const before=await v.locator('#viewerContainer').evaluate(el=>el.scrollTop);
  await ca.send('Input.imeSetComposition',{text:'更新中的主投影文字。'.repeat(30),selectionStart:300,selectionEnd:300});
  await v.waitForFunction(()=>document.querySelector('.remote-ime-preview')?.dataset.preview.startsWith('更新中'));
  assert(Math.abs(await v.locator('#viewerContainer').evaluate(el=>el.scrollTop)-before)<2);
  await v.locator('#showViewerToolbar').click();await v.locator('#followMasterButton').click();await v.locator('#hideViewerToolbar').click();
 });
 await check('corrector preedit is excluded until server-authorized projection takeover',async()=>{
  await b.evaluate(()=>{quill.focus();quill.setSelection(4,0);});
  await cb.send('Input.imeSetComposition',{text:'校稿尚未送出',selectionStart:6,selectionEnd:6});
  await a.waitForFunction(()=>document.getElementById('peerImeStatus').textContent.includes('校稿尚未送出'));
  assert.equal(await v.locator('.remote-ime-preview').count(),1);
  assert((await v.locator('.remote-ime-preview').getAttribute('data-preview')).startsWith('更新中'));
  await b.evaluate(()=>socket.emit('claim_master'));
  await v.waitForFunction(()=>document.querySelector('.remote-ime-preview')?.dataset.preview==='校稿尚未送出');
 });
 await check('late audience joins active composition and master disconnect returns to prior master',async()=>{
  const late=await mobile.newPage();await late.goto(base+'/view/MIRROR');
  await late.waitForFunction(()=>document.querySelector('.remote-ime-preview')?.dataset.preview==='校稿尚未送出');
  await b.evaluate(()=>socket.disconnect());
  await v.waitForFunction(()=>document.querySelector('.remote-ime-preview')?.dataset.preview.startsWith('更新中'));
  await late.close();
  await cb.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
  await ca.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
  await v.waitForFunction(()=>!document.querySelector('.remote-ime-preview'));
 });
 await check('audience Enter handoff has no blank or duplicate frame under delayed document delivery',async()=>{
  await a.evaluate(()=>{quill.focus();quill.setSelection(4,0);});
  await ca.send('Input.imeSetComposition',{text:'中',selectionStart:1,selectionEnd:1});
  await v.waitForFunction(()=>document.querySelector('.remote-ime-preview')?.dataset.preview==='中');
  await v.evaluate(()=>{
   const handler=socket.listeners('document_update')[0];socket.off('document_update',handler);socket.on('document_update',d=>setTimeout(()=>handler(d),450));
   window.samples=[];window.sampleTimer=setInterval(()=>{const text=quill.getText()+[...document.querySelectorAll('.remote-ime-preview')].map(e=>e.dataset.preview).join('');samples.push((text.match(/中/g)||[]).length);},10);
  });
  await ca.send('Input.insertText',{text:'中'});
  await v.waitForFunction(()=>quill.getText().includes('中')&&!document.querySelector('.remote-ime-preview'));
  const samples=await v.evaluate(()=>{clearInterval(sampleTimer);return samples;});assert(samples.length>15&&samples.every(n=>n===1));
 });
 assert.deepEqual(errors,[]);
 writeFileSync('../../outputs/viewer-live-tests.json',JSON.stringify({results,errors,nativeWindowsImeVerified:false},null,2));
} catch(e){console.error(e,logs.slice(-1500));process.exitCode=1;}
finally{if(main)await main.close();if(other)await other.close();server.kill();}
