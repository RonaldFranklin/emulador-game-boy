import { test,expect } from '@playwright/test';
import { preview } from 'vite';
import { documentCsp } from '../../frontend/csp.ts';
import { playableGbRom,playableGbaRom } from '../helpers/play-roms.mjs';
let server,origin;
test.beforeAll(async()=>{server=await preview({configFile:false,root:'frontend',plugins:[documentCsp()],preview:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'silent'});origin=`http://127.0.0.1:${server.httpServer.address().port}`;});
test.afterAll(async()=>{await new Promise(resolve=>server?.httpServer.close(resolve));});
for(const console of ['GB','GBA'])test(`SEC-04: build real ${console} sem violações CSP em tema/player/áudio`,async({page})=>{
 const game={id:'e910d76f-2bc7-4859-a627-c2fdcf4377b0',name:'Synthetic',console,active:true,hasCover:false};
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.setItem('emulador-theme','dark');window.__violations=[];document.addEventListener('securitypolicyviolation',e=>window.__violations.push({directive:e.effectiveDirective,blocked:e.blockedURI,disposition:e.disposition}));});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,json=(body,status=200)=>route.fulfill({json:body,status});
  if(path==='/api/auth/me')return json({user:{id:'b8bf4f16-8a67-4419-9116-c5c1c58529af',username:'synthetic',role:'JOGADOR',mustChangePassword:false},csrfToken:'synthetic'});
  if(path==='/api/games')return json({games:[game]});
  const base=`/api/play/${game.id}`;
  if(path===base)return json({game,core:console==='GB'?'mgba-gb-v1':'mgba-gba-v1',romUrl:base+'/rom'});
  if(path===base+'/rom')return route.fulfill({body:console==='GB'?playableGbRom():playableGbaRom(),contentType:'application/octet-stream'});
  if(path===base+'/lease/renew')return json({expiresAt:new Date(Date.now()+120000).toISOString()});
  if(path===base+'/lease')return json({leaseId:'adea4c01-74b9-4ba3-afee-1ce78df47f49',expiresAt:new Date(Date.now()+120000).toISOString(),save:{version:0,dataBase64:null,sha256:null,updatedAt:null}},201);
  globalThis.console.log('Unexpected fixture route',path,route.request().method());return json({message:'Fora do ensaio'},418);
 });
 const response=await page.goto(origin),csp=response.headers()['content-security-policy-report-only'];expect(csp).toContain("wasm-unsafe-eval");expect(csp).not.toContain('script-src \'unsafe-inline\'');expect(csp).not.toContain('data:text');
 await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.getByRole('article',{name:'Synthetic',exact:true}).getByRole('button',{name:'Jogar',exact:true}).click();await page.getByRole('button',{name:'Iniciar jogo',exact:true}).click();
 await expect(page.getByRole('button',{name:'Pausar',exact:true})).toBeVisible().catch(async e=>{globalThis.console.log((await page.locator('body').innerText()).slice(-2200),errors);throw e;});await page.getByRole('button',{name:'Pausar',exact:true}).click();
 expect(errors).toEqual([]);expect(await page.evaluate(()=>window.__violations)).toEqual([]);
 // Positive control: Report-Only detects an unauthorized inline script without blocking it.
 await page.evaluate(()=>{const script=document.createElement('script');script.textContent='window.__cspProbe = true';document.head.append(script);});
 await expect.poll(()=>page.evaluate(()=>window.__violations.length)).toBeGreaterThan(0);
 expect(await page.evaluate(()=>window.__violations.every(e=>e.disposition==='report'))).toBe(true);
});
