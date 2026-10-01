import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { playableGbRom, playableGbaRom } from '../helpers/play-roms.mjs';

// Real WASM; only RAF timestamps and the scheduling work budget are controlled.
// Assertions measure core frames, not how fast the test computer can run them.
let vite, directory, origin;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'emulador-speed-'));
  vite = await createServer({ configFile:false, root:resolve('frontend'), cacheDir:directory,
    server:{host:'127.0.0.1',port:0},logLevel:'silent' });
  await vite.listen(); origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
});
test.afterAll(async () => {await vite?.close(); if(directory) await rm(directory,{recursive:true,force:true});});

async function harness(page, console) {
  await page.addInitScript(() => {
    const callbacks=new Map(); let id=0;
    window.__time=0; window.__work=0; window.__cost=0;
    Object.defineProperty(performance,'now',{value:()=>window.__work});
    window.requestAnimationFrame=callback=>{callbacks.set(++id,callback);return id;};
    window.cancelAnimationFrame=id=>callbacks.delete(id);
    window.__step=ms=>{window.__time+=ms;window.__work+=ms;const jobs=[...callbacks.values()];callbacks.clear();jobs.forEach(fn=>fn(window.__time));};
    window.__loops=()=>callbacks.size;
    window.__messages=[]; window.__audio=[];
    const Context=window.AudioContext, Worklet=window.AudioWorkletNode;
    window.AudioContext=class extends Context {constructor(...args){super(...args);window.__audio.push(this);} createGain(){this.__gain=super.createGain();return this.__gain;}};
    window.AudioWorkletNode=class extends Worklet {constructor(...args){super(...args);const send=this.port.postMessage.bind(this.port);this.port.postMessage=(data,...rest)=>{window.__messages.push(data.clear?'clear':'samples');send(data,...rest);};}};
  });
  await page.route('**/harness',route=>route.fulfill({contentType:'text/html',body:'<button id="audio">Áudio</button><canvas></canvas>'}));
  await page.route('**/synthetic',route=>route.fulfill({body:console==='GB'?playableGbRom():playableGbaRom()}));
  await page.route('**/emulator/mgba.js',async route=>{
    const response=await route.fetch();await route.fulfill({response,body:await response.text()+`\nconst speedFactory=window.createMgbaModule;window.createMgbaModule=async(...args)=>{const core=await speedFactory(...args);window.__core=core;const run=core._mgbawasm_run_frame;core._mgbawasm_run_frame=()=>{const result=run();window.__work+=window.__cost;return result;};return core;};`});
  });
  await page.goto(origin+'/harness');
  await page.evaluate(async console=>{
    const {createEmulator}=await import('/src/emulation/adapter.ts');
    window.__engine=await createEmulator({canvas:document.querySelector('canvas'),console,rom:new Uint8Array(await(await fetch('/synthetic')).arrayBuffer()),save:null});
    document.querySelector('#audio').onclick=()=>window.__engine.setMuted(false);
  },console);
}

for(const console of ['GB','GBA']) test(`${console}: velocidade real, cadências, limites, pausa, suspensão e input`,async({page})=>{
  await harness(page,console);
  const result=await page.evaluate(async()=>{
    const e=window.__engine,c=window.__core;
    const fps=c._mgbawasm_framerate_micro()/1e6, count=()=>c._mgbawasm_frame_counter();
    const cases=[];
    for(const hz of [60,120,144]) for(const speed of [1,2,3,5,10]) {
      e.setPaused(true);await e.setSpeed(speed); e.setPaused(false);window.__step(0);
      const before=count();for(let i=0;i<hz;i++)window.__step(1000/hz);
      cases.push({hz,speed,frames:count()-before,expected:Math.floor(fps*speed+1e-7),loops:window.__loops()});
    }
    e.setPaused(true);const stopped=count();await e.setSpeed(3);window.__step(120000);const paused=count()===stopped;
    e.setPaused(false);window.__step(120000);const noResumeJump=count()===stopped;
    const beforeGap=count();window.__step(10000);const noGap=count()===beforeGap;
    await e.setSpeed(10);window.__step(0);const beforeCap=count();window.__step(100);const cap=count()-beforeCap;
    const afterCap=count();window.__step(0);const noDebt=count()===afterCap;
    window.__cost=9;window.__step(100);const slow=count()-afterCap;
    window.__cost=0;await e.setSpeed(1);window.__step(0);const normal=count();window.__step(1000/fps+0.01);const one=count()-normal;
    for(const speed of [2,10,3,5,1,10])await e.setSpeed(speed);
    const loops=window.__loops();window.__step(0);e.input('a',true);window.__step(20);e.input('a',false);
    const saved=e.readNativeSave();const input=saved[0];
    Object.defineProperty(document,'hidden',{configurable:true,value:true});const beforeHide=count();window.__step(20);
    const hidden=count()===beforeHide && window.__loops()===0;
    Object.defineProperty(document,'hidden',{configurable:true,value:false});e.setPaused(false);window.__step(120000);
    const noHiddenJump=count()===beforeHide;
    await e.destroy();return {cases,paused,noResumeJump,noGap,cap,noDebt,slow,one,loops,input,hidden,noHiddenJump,destroyed:window.__loops()===0};
  });
  for(const item of result.cases){expect(item.frames,JSON.stringify(item)).toBe(item.expected);expect(item.loops).toBe(1);}
  expect(result).toMatchObject({paused:true,noResumeJump:true,noGap:true,cap:12,noDebt:true,slow:1,one:1,loops:1,input:1,hidden:true,noHiddenJump:true,destroyed:true});
});

test('áudio real drena sem enfileirar acelerado e restaura mute/ganho sem nós extras',async({page})=>{
  await harness(page,'GBA');
  await page.evaluate(()=>{window.__engine.setVolume(36);window.__engine.setPaused(false);});
  // Genuine browser gesture for AudioContext.resume.
  // CDP delivers a trusted pointer gesture without RAF actionability waits.
  const cdp=await page.context().newCDPSession(page);
  const box=await page.locator('#audio').boundingBox();
  const point={x:box.x+box.width/2,y:box.y+box.height/2,button:'left',clickCount:1};
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...point});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point});
  await expect.poll(()=>page.evaluate(()=>window.__audio[0].state)).toBe('running');
  const result=await page.evaluate(async()=>{
    const e=window.__engine,a=window.__audio[0],gain=()=>a.__gain.gain.value;
    window.__step(0);window.__step(20);const normalMessages=window.__messages.filter(x=>x==='samples').length;
    await e.setSpeed(10);const silent=gain()===0 && a.state==='suspended';window.__messages=[];
    window.__step(0);for(let i=0;i<60;i++)window.__step(1000/60);
    const fastSamples=window.__messages.filter(x=>x==='samples').length;
    await e.setSpeed(1);const restored=gain();const cleared=window.__messages.at(-1)==='clear';
    window.__messages=[];window.__step(0);const noOldQueue=window.__messages.length===0;
    window.__step(20);const newSamples=window.__messages.filter(x=>x==='samples').length;
    await Promise.all([10,1,3,1,5,1].map(speed=>e.setSpeed(speed)));
    const rapidRunning=a.state==='running' && window.__loops()===1;
    await e.setMuted(true);await e.setSpeed(5);e.setVolume(22);await e.setSpeed(1);const staysMuted=gain()===0;
    await e.setMuted(false);const newVolume=gain();e.setPaused(true);await e.setSpeed(10);await e.setSpeed(1);const pausedSilent=gain()===0;
    e.setVolume(0);e.setPaused(false);const zero=gain()===0;
    // Exercise the unchanged processor's queue clear with non-silent synthetic PCM.
    const source=await(await fetch('/src/emulation/audio-worklet.js')).text();let Processor;
    new Function('AudioWorkletProcessor','registerProcessor','sampleRate',source)(class {constructor(){this.port={};}},(_name,Type)=>{Processor=Type;},48000);
    const processor=new Processor(), outputs=[[new Float32Array(128),new Float32Array(128)]];
    processor.port.onmessage({data:{samples:new Int16Array(2048).fill(32000),rate:48000}});
    processor.process([],outputs);const signal=outputs[0][0].some(value=>value>0);
    processor.port.onmessage({data:{clear:true}});processor.process([],outputs);
    const bufferCleared=signal && outputs[0].every(channel=>channel.every(value=>value===0)) && processor.writePosition===0 && processor.readPosition===0;
    await e.destroy();return {normalMessages,silent,fastSamples,restored,cleared,noOldQueue,newSamples,staysMuted,newVolume,pausedSilent,zero,bufferCleared,rapidRunning,contexts:window.__audio.length,closed:a.state==='closed'};
  });
  expect(result.normalMessages).toBeGreaterThan(0);expect(result.fastSamples).toBe(0);expect(result.newSamples).toBe(1);
  expect(result.restored).toBeCloseTo(.36);expect(result.newVolume).toBeCloseTo(.22);
  expect(result).toMatchObject({silent:true,cleared:true,noOldQueue:true,staysMuted:true,pausedSilent:true,zero:true,bufferCleared:true,rapidRunning:true,contexts:1,closed:true});
});
