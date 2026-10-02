import { documentCsp } from '../../frontend/csp.ts';
import { playableGbRom, playableGbaRom } from '../helpers/play-roms.mjs';
import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let vite,directory,origin;
test.beforeAll(async()=>{
 directory=await mkdtemp(join(tmpdir(),'emulador-security-ui-'));
 vite=await createServer({configFile:false,root:resolve('frontend'),plugins:[react(),documentCsp()],cacheDir:directory,server:{host:'127.0.0.1',port:0},logLevel:'silent'});
 await vite.listen();origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
});
test.afterAll(async()=>{await vite?.close();if(directory)await rm(directory,{recursive:true,force:true});});
test('SEC-01: navegador resolve desafio em worker e envia prova, sem armazenar senha',async({page})=>{
 const token='A'.repeat(43);let attempts=0;
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/auth/me')return route.fulfill({status:401,json:{message:'Entre para continuar.'}});
  if(path==='/api/auth/login'){
   const b=route.request().postDataJSON();attempts++;
   if(attempts===1)return route.fulfill({status:428,json:{message:'Verificação adicional',challenge:{token,zeros:4}}});
   expect(b.proofToken).toBe(token);expect(createHash('sha256').update(`${token}:${b.proofNonce}`).digest('hex').startsWith('0000')).toBe(true);
   return route.fulfill({json:{user:{id:'a6e77c81-fbe5-49b5-afac-7030d22acf36',username:'synthetic',role:'JOGADOR',mustChangePassword:false},csrfToken:'test'}});
  }
  if(path==='/api/games')return route.fulfill({json:{games:[]}});
  return route.fulfill({status:404,json:{message:'Fora do ensaio'}});
 });
 await page.goto(origin);await page.getByLabel('Nome de usuário').fill('synthetic');await page.getByLabel('Senha',{exact:true}).fill('isolated-password');
 await page.getByRole('button',{name:'Entrar',exact:true}).click();await expect(page.getByRole('heading',{name:'Biblioteca',exact:true})).toBeVisible();expect(attempts).toBe(2);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage}))).not.toContain('isolated-password');
});
test('SEC-05: cadastro MFA, confirmação e códigos efêmeros antes de liberar biblioteca',async({page})=>{
 const user={id:'a6e77c81-fbe5-49b5-afac-7030d22acf36',username:'synthetic_master',role:'MASTER',mustChangePassword:false};
 let mfa='enroll';const secret='SYNTHETICTOTPKEY',codes=Array.from({length:10},(_,i)=>`synthetic-recovery-${i}`);
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/auth/me')return route.fulfill({json:{user,csrfToken:'fixture',mfa}});
  if(path==='/api/auth/mfa/enroll'){expect(route.request().postDataJSON().password).toBe('synthetic-password');return route.fulfill({json:{secret}});}
  if(path==='/api/auth/mfa/confirm'){expect(route.request().postDataJSON().code).toBe('123456');mfa='verified';return route.fulfill({json:{user,csrfToken:'rotated',mfa,recoveryCodes:codes}});}
  if(path==='/api/games')return route.fulfill({json:{games:[]}});
  return route.fulfill({status:404,json:{message:'Fora do ensaio'}});
 });
 await page.goto(origin);await expect(page.getByRole('heading',{name:'Segurança do master'})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Biblioteca',exact:true})).toHaveCount(0);
 await page.getByLabel('Senha atual').fill('synthetic-password');await page.getByRole('button',{name:'Iniciar cadastro'}).click();
 await expect(page.getByLabel('Chave de cadastro')).toHaveValue(secret);
 await page.getByLabel('Código do novo autenticador').fill('123456');await page.getByRole('button',{name:'Confirmar autenticação'}).click();
 await expect(page.getByRole('heading',{name:'Guarde seus códigos de recuperação'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Continuar',exact:true})).toBeDisabled();
 const stored=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));
 for(const value of [secret,'synthetic-password',...codes])expect(stored).not.toContain(value);
 await page.getByRole('checkbox',{name:'Guardei os códigos em lugar seguro'}).check();await page.getByRole('button',{name:'Continuar',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Biblioteca',exact:true})).toBeVisible();await expect(page.getByText(codes[0],{exact:true})).toHaveCount(0);
});

for(const console of ['GB','GBA'])test(`SEC-04: CSP no HTML, tema, WASM e worklet reais ${console}`,async({page})=>{
 await page.addInitScript(()=>{window.__violations=[];document.addEventListener('securitypolicyviolation',event=>window.__violations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));});
 await page.route('**/api/auth/me',route=>route.fulfill({status:401,json:{message:'Entre'}}));
 await page.route('**/synthetic',route=>route.fulfill({body:console==='GB'?playableGbRom():playableGbaRom()}));
 const response=await page.goto(origin);expect(response.headers()['content-security-policy-report-only']).toContain("'wasm-unsafe-eval'");
 expect(response.headers()['content-security-policy-report-only']).not.toContain("script-src 'unsafe-inline'");
 await expect(page.getByLabel('Nome de usuário')).toBeVisible();
 await page.evaluate(async console=>{
  const {createEmulator}=await import('/src/emulation/adapter.ts');const canvas=document.createElement('canvas');document.body.append(canvas);
  window.__engine=await createEmulator({canvas,console,rom:new Uint8Array(await(await fetch('/synthetic')).arrayBuffer()),save:null});
  const button=document.createElement('button');button.textContent='Áudio de ensaio';button.onclick=()=>{window.__engine.setPaused(false);void window.__engine.setMuted(false);};document.body.append(button);
 },console);
 await page.getByRole('button',{name:'Áudio de ensaio'}).click();
 await expect.poll(()=>page.evaluate(()=>window.__engine.readNativeSave()?.[0])).toBe(0);
 const result=await page.evaluate(async()=>{window.__engine.setPaused(true);const state=window.__engine.captureState();await window.__engine.destroy();return {size:state.data.length,violations:window.__violations};});
 expect(result.size).toBe(console==='GB'?71680:397312);expect(result.violations).toEqual([]);
});
