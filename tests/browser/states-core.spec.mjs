import {test,expect} from '@playwright/test';
import {createServer} from 'vite';
import {playableGbRom,playableGbaRom,playableGbaFlashRom} from '../helpers/play-roms.mjs';
let server,origin;
test.beforeAll(async()=>{server=await createServer({configFile:false,root:'frontend',server:{host:'127.0.0.1',port:0},logLevel:'silent'});await server.listen();origin=`http://127.0.0.1:${server.httpServer.address().port}`;});
test.afterAll(async()=>{await server?.close();});
for(const [name,rom,platform] of [['GB',playableGbRom(),1],['GBA',playableGbaRom(),0],['Flash128',playableGbaFlashRom(),0]])test(`state ABI real ${name}`,async({page})=>{
 await page.route('**/probe',route=>route.fulfill({contentType:'text/html',body:'<canvas></canvas>'}));
 await page.route('**/fixture',route=>route.fulfill({body:rom}));
 await page.goto(origin+'/probe');await page.addScriptTag({url:origin+'/emulator/mgba.js'});
 const result=await page.evaluate(async platform=>{
  const m=await window.createMgbaModule({locateFile:p=>'/emulator/'+p,print:()=>{},printErr:()=>{}});
  const bytes=new Uint8Array(await(await fetch('/fixture')).arrayBuffer());
  const alloc=b=>{const p=m._malloc(b.length);m.HEAPU8.set(b,p);return p;};
  const native=()=>{const n=m._mgbawasm_sram_save();return m.HEAPU8.slice(m._mgbawasm_sram_ptr(),m._mgbawasm_sram_ptr()+n);};
  m._mgbawasm_init();m._mgbawasm_set_log_level(0);const r=alloc(bytes),model=alloc(new Uint8Array([68,77,71,0]));
  if(!m._mgbawasm_load(r,bytes.length,0,0,platform,model,1))throw Error('load');
  m._free(r);m._free(model);m._mgbawasm_set_keys(1);for(let i=0;i<30;i++)m._mgbawasm_run_frame();m._mgbawasm_set_keys(0);
  const frame=m._mgbawasm_frame_counter(),size=m._mgbawasm_state_size(),p=m._malloc(size);
  const captured=m._mgbawasm_state_save(p),saved=native();
  m._mgbawasm_set_keys(2);for(let i=0;i<20;i++)m._mgbawasm_run_frame();m._mgbawasm_set_keys(0);const changed=native()[0];
  const sp=alloc(saved);const nativeLoaded=m._mgbawasm_sram_load(sp,saved.length);m._free(sp);
  const loaded=m._mgbawasm_state_load(p),restoredFrame=m._mgbawasm_frame_counter();
  const restored=native();m._mgbawasm_run_frame();const after=native()[0];
  m._free(p);m._mgbawasm_unload();return {size,frame,captured,changed,nativeSize:saved.length,nativeLoaded,loaded,restoredFrame,equal:restored.length===saved.length&&restored.every((b,i)=>b===saved[i]),after};
 },platform);
 console.log(name,JSON.stringify(result));expect(result).toMatchObject({captured:1,changed:0,nativeLoaded:1,loaded:1,frame:30,restoredFrame:30,equal:true,after:1});
});
