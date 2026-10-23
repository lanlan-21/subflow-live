import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const dir=mkdtempSync(resolve('../join-')),base='http://127.0.0.1:5134';
const server=spawn('.venv/Scripts/python.exe',['app.py'],{env:{...process.env,PORT:'5134',SUBFLOW_DB:resolve(dir,'test.sqlite3'),SECRET_KEY:'join-tests'}});
let browser,logs='';server.stderr.on('data',v=>logs+=v);
const results=[],errors=[],navs=new Map();
async function page(context,path){const p=await context.newPage();navs.set(p,0);p.on('framenavigated',f=>{if(f===p.mainFrame())navs.set(p,navs.get(p)+1);});p.on('pageerror',e=>errors.push(e.message));await p.goto(base+path);return p;}
async function check(name,fn){await fn();results.push(name);console.log('PASS',name);}
async function clean(p){await p.waitForFunction(()=>document.getElementById('syncStatus')?.textContent==='所有修改已儲存');}
try{
 for(let i=0;i<100;i++){try{if((await fetch(base+'/healthz')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({channel:'chrome',headless:true});
 const ctx=await browser.newContext({viewport:{width:1200,height:800}});
 await ctx.addInitScript(()=>{Object.defineProperty(document,'visibilityState',{get:()=> 'visible'});window.wakeRequests=0;Object.defineProperty(navigator,'wakeLock',{value:{request:async()=>{wakeRequests++;const s=new EventTarget();s.released=false;s.release=async()=>{s.released=true;s.dispatchEvent(new Event('release'));};return s;}}});});
 const writer=await page(ctx,'/edit/FRESH');await clean(writer);
 const text=Array.from({length:90},(_,i)=>`第${String(i).padStart(3,'0')}行：已有的聽打稿與校稿內容 👏𠮷。\n`).join(''),anchor=text.indexOf('第030行');
 await writer.evaluate(t=>quill.setText(t,'user'),text);await clean(writer);
 await writer.evaluate(i=>{const el=document.getElementById('editorContainer');el.scrollTop+=document.getElementById('editor').getBoundingClientRect().top-el.getBoundingClientRect().top+quill.getBounds(i).top;socket.emit('projection_scroll',{index:i,bottom:false});},anchor);
 let viewer,partner;
 await check('late audience and editor load the complete latest document and working section without refresh',async()=>{
  viewer=await page(ctx,'/view/FRESH');partner=await page(ctx,'/edit/FRESH');
  for(const p of[viewer,partner])await p.waitForFunction(t=>quill.getText()===t,text+'\n');
  // Quill preserves one terminal newline; normalize only that implicit newline.
 });
 await check('audience defaults to following and wake request; newcomer opens at master section once',async()=>{
  assert.equal(await viewer.locator('#followMasterButton').getAttribute('aria-pressed'),'true');
  assert(await viewer.evaluate(()=>wakeRequests>0));
  for(const p of[viewer,partner]){
   await p.evaluate(()=>document.fonts.ready);
   await p.waitForFunction(i=>{const el=document.getElementById('viewerContainer')||document.getElementById('editorContainer');return Math.abs(document.getElementById('editor').getBoundingClientRect().top-el.getBoundingClientRect().top+quill.getBounds(i).top)<3;},anchor);
   assert.equal(navs.get(p),1);
  }
 });
 await check('compatible cached interface hash never blocks initial document synchronization',async()=>{
  const old=await ctx.newPage();navs.set(old,0);old.on('framenavigated',f=>{if(f===old.mainFrame())navs.set(old,navs.get(old)+1);});
  await old.route('**/edit/FRESH',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace(/collaboration\.js\?v=[0-9a-f]+/,'collaboration.js?v=compatible-cached-interface')});});
  await old.goto(base+'/edit/FRESH');await old.waitForFunction(t=>quill.isEnabled()&&quill.getText()===t,text+'\n');assert.equal(navs.get(old),1);await old.close();
 });
 await check('continuous typing is published during the stream and late join sees it immediately',async()=>{
  const stream=await page(ctx,'/edit/STREAM');await clean(stream);const watch=await page(ctx,'/view/STREAM');
  await stream.evaluate(()=>{window.streamCount=0;window.streamTimer=setInterval(()=>quill.insertText(quill.getLength()-1,`連續${++streamCount} `,'user'),20);});
  await watch.waitForFunction(()=>quill.getText().includes('連續5'),null,{timeout:2000});
  const late=await page(ctx,'/edit/STREAM');await late.waitForFunction(()=>quill.isEnabled()&&quill.getText().includes('連續5'),null,{timeout:2500});
  assert(await stream.evaluate(()=>streamCount>5&&!!streamTimer));assert.equal(navs.get(late),1);
  await stream.evaluate(()=>{clearInterval(streamTimer);streamTimer=null;});await clean(stream);await late.close();await watch.close();await stream.close();
 });
 await check('missed broadcasts repair automatically for audience and editor without reload or data replacement',async()=>{
  for(const p of[viewer,partner])await p.evaluate(()=>{const fn=socket.listeners('document_update')[0];socket.off('document_update',fn);window.droppedUpdates=0;socket.on('document_update',()=>{droppedUpdates++;});});
  await writer.evaluate(()=>quill.insertText(quill.getLength()-1,'漏接後自動補回','user'));
  await partner.evaluate(()=>quill.insertText(0,'夥伴本機保留','user'));
  for(const p of[viewer,partner]){
   await p.waitForFunction(()=>quill.getText().includes('漏接後自動補回')&&quill.getText().includes('夥伴本機保留'),null,{timeout:8000});
   assert(await p.evaluate(()=>droppedUpdates>0));assert.equal(navs.get(p),1);
  }
 });
 await check('expired session renews and reconnects without page refresh or losing offline edits',async()=>{
  let renewals=0;await partner.route('**/api/rooms/FRESH/session',async route=>{renewals++;await route.continue();});
  await partner.evaluate(()=>{
   socket.disconnect();quill.insertText(0,'離線未送仍保留','user');
   const original=socket.emit;
   socket.emit=function(event,...args){if(event==='join'){socket.emit=original;args[0]={...args[0],token:'expired-token'};}return original.call(this,event,...args);};socket.connect();
  });
  await clean(partner);await writer.waitForFunction(()=>quill.getText().includes('離線未送仍保留'));
  assert.equal(renewals,1);assert.equal(navs.get(partner),1);
 });
 await check('lost join acknowledgement retries even while local typing continues',async()=>{
  await partner.evaluate(()=>{
   socket.disconnect();window.joinAttempts=0;const original=socket.emit;
   socket.emit=function(event,...args){if(event==='join'){joinAttempts++;if(joinAttempts===1){const callback=args.pop();return original.call(this,event,...args,()=>callback(new Error('lost join ACK')));}}return original.call(this,event,...args);};
   window.retryTimer=setInterval(()=>quill.insertText(quill.getLength()-1,'持續補字','user'),20);socket.connect();
  });
  await writer.waitForFunction(()=>quill.getText().includes('持續補字'),null,{timeout:6000});
  assert(await partner.evaluate(()=>joinAttempts>=2));assert.equal(navs.get(partner),1);
  await partner.evaluate(()=>clearInterval(retryTimer));await clean(partner);
 });
 assert.deepEqual(errors,[]);writeFileSync('../../outputs/join-tests.json',JSON.stringify({results,errors,navigationCounts:[navs.get(viewer),navs.get(partner)]},null,2));
}catch(e){console.error(e,logs.slice(-1300));process.exitCode=1;}
finally{if(browser)await browser.close();server.kill();}
