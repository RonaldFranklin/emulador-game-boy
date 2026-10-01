import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { playableGbRom, playableGbaRom } from '../helpers/play-roms.mjs';

// Focused UI tests: real React/player/mGBA and synthetic cartridges. Every API
// response is local to the browser context; no database, account or network.
let vite, directory, origin;
const userA = 'b8bf4f16-8a67-4419-9116-c5c1c58529af', userB = '6b1f552a-d17a-47b2-b53b-05d8a02d0195';
const games = ['GB','GBA'].map((console, i) => ({ id: `e910d76f-2bc7-4859-a627-c2fdcf4377b${i}`, name: `Teste ${console}`, console, active:true, hasCover:false, coverUrl:null, createdAt:'2026-01-01',updatedAt:'2026-01-01' }));
const prefKey = id => `emulador-player-v1:${id}`;
const button = (page, name) => page.getByRole('button',{name,exact:true});
const canvas = page => page.getByLabel('Tela do jogo',{exact:true});
const bits = page => page.evaluate(() => window.__uxKeys ?? 0);
async function expectBits(page, value) { await expect.poll(() => bits(page)).toBe(value); }

// Transparent instrumentation of the real core's exported input/frame calls.
const instrumentation = `
const uxFactory = window.createMgbaModule;
window.createMgbaModule = async (...args) => {
  const module = await uxFactory(...args);
  const keys = module._mgbawasm_set_keys, frame = module._mgbawasm_run_frame;
  window.__uxKeys = 0; window.__uxFrames = 0;
  module._mgbawasm_set_keys = value => { window.__uxKeys = value; return keys(value); };
  module._mgbawasm_run_frame = () => { window.__uxFrames++; return frame(); };
  return module;
};`;

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(),'emulador-player-ux-'));
  vite = await createServer({ configFile:false,root:resolve('frontend'),plugins:[react()],cacheDir:directory,
    server:{host:'127.0.0.1',port:0},logLevel:'silent' });
  await vite.listen(); origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await mkdir('.local/screenshots',{recursive:true});
});
test.afterAll(async () => { await vite?.close(); if(directory) await rm(directory,{recursive:true,force:true}); });

const pageErrors = new WeakMap();
test.beforeEach(async ({page}) => { const errors=[]; pageErrors.set(page,errors); page.on('pageerror',error=>errors.push(error.message)); });
test.afterEach(async ({page}) => { expect(pageErrors.get(page)).toEqual([]); });

async function setup(page) {
  const state = { userId:userA, failRenew:false, saves:new Map(), writes:0, unexpected:[] };
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/emulator/mgba.js',async route => {
    const response = await route.fetch(); await route.fulfill({response,body:(await response.text())+'\n'+instrumentation});
  });
  await page.route('**/api/**',async route => {
    const req = route.request(), path = new URL(req.url()).pathname, method=req.method();
    const json = (body,status=200) => route.fulfill({json:body,status});
    if(path==='/api/auth/me') return json({user:{id:state.userId,username:'teste',role:'JOGADOR',blocked:false,mustChangePassword:false},csrfToken:'synthetic'});
    if(path==='/api/games') return json({games});
    const game = games.find(g=>path.startsWith(`/api/play/${g.id}`));
    if(game) {
      const suffix = path.slice(`/api/play/${game.id}`.length), savedKey = `${state.userId}:${game.id}`;
      if(!suffix) return json({game,core:game.console==='GB'?'mgba-gb-v1':'mgba-gba-v1',romUrl:`/api/play/${game.id}/rom`});
      if(suffix==='/rom') return route.fulfill({body:game.console==='GB'?playableGbRom():playableGbaRom(),contentType:'application/octet-stream'});
      if(suffix==='/lease' && method==='POST') return json({leaseId:'adea4c01-74b9-4ba3-afee-1ce78df47f49',expiresAt:new Date(Date.now()+120000).toISOString(),save:state.saves.get(savedKey)??{version:0,dataBase64:null,sha256:null,updatedAt:null}},201);
      if(suffix==='/lease' && method==='DELETE') return route.fulfill({status:204});
      if(suffix==='/lease/renew') return state.failRenew?json({message:'Falha sintética de renovação'},409):json({expiresAt:new Date(Date.now()+120000).toISOString()});
      if(suffix==='/save') { const body=req.postDataJSON(); const save={dataBase64:body.dataBase64,sha256:body.sha256,version:body.baseVersion+1,updatedAt:new Date().toISOString()};state.saves.set(savedKey,save);state.writes++;return json({save}); }
    }
    state.unexpected.push(path); return json({message:'Fora do ensaio'},418);
  });
  await page.goto(origin); return state;
}
async function open(page, console='GBA', start=true) {
  await page.getByRole('article',{name:`Teste ${console}`,exact:true}).getByRole('button',{name:'Jogar',exact:true}).click();
  if(start) { await button(page,'Iniciar jogo').click(); await expect(button(page,'Pausar')).toBeVisible(); }
}
async function leave(page) { await button(page,'Salvar e voltar').click(); await page.getByRole('dialog').getByRole('button',{name:/^(Voltar à biblioteca|Sair sem save confirmado)$/}).click(); await expect(page.getByRole('heading',{name:'Biblioteca',exact:true})).toBeVisible(); }
async function geometry(page, console) {
  const box = await canvas(page).boundingBox(), stage = await page.locator('.player-screen').boundingBox();
  expect(box.width/box.height).toBeCloseTo(console==='GB'?160/144:240/160,2);
  expect(box.x).toBeGreaterThanOrEqual(stage.x-1); expect(box.y).toBeGreaterThanOrEqual(stage.y-1);
  expect(box.x+box.width).toBeLessThanOrEqual(stage.x+stage.width+1); expect(box.y+box.height).toBeLessThanOrEqual(stage.y+stage.height+1);
  expect(await canvas(page).evaluate(e=>getComputedStyle(e).imageRendering)).toBe('pixelated');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const controls = [];
  for(const item of await page.locator('.touch-key').all()) {
    const r = await item.boundingBox(); controls.push(r); expect(r.width).toBeGreaterThanOrEqual(44); expect(r.height).toBeGreaterThanOrEqual(44);
    expect(r.x).toBeGreaterThanOrEqual(stage.x);expect(r.x+r.width).toBeLessThanOrEqual(stage.x+stage.width+1);
    expect(r.y).toBeGreaterThanOrEqual(stage.y);expect(r.y+r.height).toBeLessThanOrEqual(stage.y+stage.height+1);
  }
  for(let i=0;i<controls.length;i++) for(let j=i+1;j<controls.length;j++) {
    const a=controls[i],b=controls[j];
    expect(Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x) && Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y)).toBe(false);
  }
  return box;
}

for(const console of ['GB','GBA']) test(`${console}: tamanhos, proporção, temas, responsividade e tela cheia`,async({page})=>{
  await page.setViewportSize({width:1440,height:1080}); await setup(page); await open(page,console);
  await expect(page.getByLabel('Tamanho da tela')).toHaveValue('fit');
  const fit=await geometry(page,console); const widths=[];
  for(const size of ['compact','medium','large','fit']) {
    await page.getByLabel('Tamanho da tela').selectOption(size); await page.waitForTimeout(80);
    widths.push((await geometry(page,console)).width);
  }
  expect(widths[1]).toBeGreaterThan(widths[0]);expect(widths[2]).toBeGreaterThan(widths[1]);expect(widths[3]).toBeGreaterThanOrEqual(widths[2]-1);
  expect(fit.width).toBeGreaterThan(console==='GB'?560:720);
  await expect(button(page,'Botão L')).toHaveCount(console==='GB'?0:1);
  await button(page,'Tela cheia').click(); await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
  await geometry(page,console);await button(page,'Mais controles').click();await button(page,'Configurações').click();await expect(page.getByRole('dialog')).toBeVisible();await button(page,'Concluir').click();
  await button(page,'Sair da tela cheia').click();
  for(const [width,height,theme] of [[390,844,'light'],[320,640,'dark'],[844,390,'dark']]) {
    await page.setViewportSize({width,height});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.waitForTimeout(100);
    await geometry(page,console);await page.screenshot({path:`.local/screenshots/player-ux-${console}-${width}.png`,fullPage:true});
  }
  await button(page,'Tela cheia').click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);await page.waitForTimeout(100);await geometry(page,console);
  expect(await page.locator('.player').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
  await page.screenshot({path:`.local/screenshots/player-ux-${console}-fullscreen-landscape.png`});
  await button(page,'Mais controles').click();await button(page,'Mostrar botões').click();await expect(page.locator('.touch-controls')).toHaveCount(0);
  await expect(button(page,'Configurações')).toBeVisible();await expect(button(page,'Salvar e voltar')).toBeVisible();
  await button(page,'Sair da tela cheia').click(); await leave(page);
});

test('multitouch real, fontes simultâneas e liberação em cancelamento, foco, ocultação e saída',async({page,context})=>{
  await page.setViewportSize({width:390,height:844});await setup(page);await open(page);
  const cdp=await context.newCDPSession(page);
  const point=async(name,id)=>{const r=await button(page,name).boundingBox();return{x:r.x+r.width/2,y:r.y+r.height/2,id};};
  const right=await point('Direcional direita',1), a=await point('Botão A',2);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[right,a]});await expectBits(page,17);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[right]});await expectBits(page,1);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await expectBits(page,0);
  await canvas(page).focus();await page.keyboard.down('x');await expectBits(page,1);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a]});await page.keyboard.up('x');await expectBits(page,1);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await expectBits(page,0);
  for(const trigger of ['blur','focus','hide']) {
    await canvas(page).focus();await page.keyboard.down('ArrowRight');await expectBits(page,16);
    if(trigger==='blur') await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    if(trigger==='focus') await button(page,'Ativar áudio').focus();
    if(trigger==='hide') await button(page,'Mostrar botões').click();
    await expectBits(page,0);await page.keyboard.up('ArrowRight');
  }
  await canvas(page).focus();await page.keyboard.down('ShiftLeft');await page.keyboard.down('ShiftRight');await expectBits(page,4);await page.keyboard.up('ShiftLeft');await expectBits(page,4);await page.keyboard.up('ShiftRight');await expectBits(page,0);
  await canvas(page).focus();await page.keyboard.down('x');await expectBits(page,1);
  await leave(page);await expectBits(page,0);await page.keyboard.up('x');
});

test('remapeamento, conflitos explícitos, cancelamento, reset e pausa sem vazar captura ao core',async({page})=>{
  await setup(page);await open(page);
  await canvas(page).focus();await page.keyboard.down('ArrowRight');await expectBits(page,16);
  await button(page,'Configurações').click();await expectBits(page,0);await page.keyboard.up('ArrowRight');
  const frames=await page.evaluate(()=>window.__uxFrames);await page.waitForTimeout(150);expect(await page.evaluate(()=>window.__uxFrames)).toBe(frames);
  await button(page,'Remapear A').click();await page.keyboard.press('z');
  await expect(page.getByRole('alert')).toContainText('já está vinculada a B');await expect(button(page,'Remapear A')).toContainText('X');
  await page.screenshot({path:'.local/screenshots/player-ux-controls-conflict.png'});
  await expectBits(page,0);await button(page,'Cancelar captura').click();
  await button(page,'Remapear A').click();await page.keyboard.press('z');await button(page,'Trocar vínculos').click();
  await expect(button(page,'Remapear A')).toContainText('Z');await expect(button(page,'Remapear B')).toContainText('X');
  await button(page,'Remapear Cima').click();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeVisible();
  await expect(button(page,'Remapear Cima')).toContainText('↑');
  await button(page,'Remapear A').click();await page.keyboard.press('c');await expectBits(page,0);
  await button(page,'Concluir').click();await expect(button(page,'Pausar')).toBeVisible();
  await canvas(page).focus();await page.keyboard.down('c');await expectBits(page,1);await page.keyboard.up('c');await expectBits(page,0);
  await page.keyboard.down('x');await expectBits(page,2);await page.keyboard.up('x');
  // Browser chords remain uncancelled; input in editable UI never reaches core.
  expect(await canvas(page).evaluate(e=>e.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyC',ctrlKey:true,bubbles:true,cancelable:true})))).toBe(true);await expectBits(page,0);
  await page.evaluate(()=>{const input=document.createElement('input');input.id='ux-field';document.querySelector('.player').append(input);input.focus();});
  await page.keyboard.type('c');await expectBits(page,0);await page.locator('#ux-field').evaluate(e=>e.remove());
  await button(page,'Pausar').click();await button(page,'Configurações').click();await button(page,'Restaurar padrão').click();await expect(button(page,'Remapear A')).toContainText('X');
  await button(page,'Concluir').click();await expect(button(page,'Retomar')).toBeVisible();
  await button(page,'Retomar').click();await button(page,'Configurações').click();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await button(page,'Concluir').click();await expect(button(page,'Retomar')).toBeVisible();
  await leave(page);
});

test('preferências persistem por conta; storage inválido/indisponível usa fallback',async({page})=>{
  const state=await setup(page);await open(page,'GB',false);
  await page.getByLabel('Tamanho da tela').selectOption('compact');await button(page,'Mostrar botões').click();
  await button(page,'Configurações').click();await button(page,'Remapear A').click();await page.keyboard.press('c');await button(page,'Concluir').click();
  await button(page,'Voltar à biblioteca').click();await page.reload();await open(page,'GBA',false);
  await expect(page.getByLabel('Tamanho da tela')).toHaveValue('compact');await expect(button(page,'Mostrar botões')).toHaveAttribute('aria-pressed','false');
  await button(page,'Configurações').click();await expect(button(page,'Remapear A')).toContainText('C');await button(page,'Concluir').click();
  state.userId=userB;await page.reload();await open(page,'GB',false);await expect(page.getByLabel('Tamanho da tela')).toHaveValue('fit');await expect(button(page,'Mostrar botões')).toHaveAttribute('aria-pressed','true');
  state.userId=userA;await page.reload();await open(page,'GB',false);await expect(page.getByLabel('Tamanho da tela')).toHaveValue('compact');
  const stored = await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),prefKey(userA));
  for(const invalid of ['broken',JSON.stringify({version:2}),JSON.stringify({version:1,size:'fit',showButtons:true,bindings:{}}), JSON.stringify({...stored,bindings:{...stored.bindings,a:stored.bindings.b}}), JSON.stringify({...stored,bindings:{...stored.bindings,a:['F5']}})]) {
    await page.evaluate(({key,invalid})=>localStorage.setItem(key,invalid),{key:prefKey(userA),invalid});await page.reload();await open(page,'GB',false);await expect(page.getByLabel('Tamanho da tela')).toHaveValue('fit');
  }
  await page.addInitScript(()=>{Storage.prototype.getItem=()=>{throw new Error('unavailable')};Storage.prototype.setItem=()=>{throw new Error('unavailable')};});
  await page.reload();await open(page,'GB',false);await page.getByLabel('Tamanho da tela').selectOption('large');await expect(page.getByLabel('Tamanho da tela')).toHaveValue('large');
});

test('smoke: teclado remapeado altera cartucho e saída confirma save; erro impede retomada automática',async({page})=>{
  const state=await setup(page);await open(page);
  await button(page,'Configurações').click();await button(page,'Remapear A').click();await page.keyboard.press('c');await button(page,'Concluir').click();
  await expect(button(page,'Pausar')).toBeVisible();await canvas(page).focus();await page.keyboard.down('c');await page.waitForTimeout(150);await page.keyboard.up('c');
  await expect.poll(()=>{const save=[...state.saves.values()][0];return save?Buffer.from(save.dataBase64,'base64')[0]:null;}).toBe(1);
  await button(page,'Configurações').click();state.failRenew=true;await button(page,'Concluir').click();
  await expect(page.getByRole('alert')).toContainText('Falha sintética');await expect(button(page,'Retomar')).toBeVisible();await expectBits(page,0);
  state.failRenew=false;await button(page,'Tentar sincronizar').click();await leave(page);expect(state.unexpected).toEqual([]);
});


test('todas as ações remapeadas chegam ao core GBA e tecla capturada não fica presa',async({page})=>{
  await setup(page);await open(page);await button(page,'Configurações').click();
  const mappings=[['Cima','i',64],['Baixo','k',128],['Esquerda','j',32],['Direita','l',16],['A','c',1],['B','v',2],['Start','p',8],['Select','o',4],['L','u',512],['R','y',256]];
  for(const [action,key] of mappings) { await button(page,`Remapear ${action}`).click();await page.keyboard.press(key); }
  await button(page,'Concluir').click();await expect(button(page,'Pausar')).toBeVisible();
  for(const [,key,mask] of mappings) { await canvas(page).focus();await page.keyboard.down(key);await expectBits(page,mask);await page.keyboard.up(key);await expectBits(page,0); }
  await button(page,'Configurações').click();await button(page,'Remapear A').click();await page.keyboard.down('h');
  await button(page,'Concluir').click();await expect(button(page,'Pausar')).toBeVisible();
  await page.keyboard.down('h');await expectBits(page,0); // repeat while physically held
  await page.keyboard.up('h');await page.keyboard.down('h');await expectBits(page,1);await page.keyboard.up('h');await expectBits(page,0);
  await leave(page);
});

test('velocidade: preferência antiga, isolamento, fallback e controles acessíveis',async({page})=>{
  const state=await setup(page);
  await page.evaluate(async key=>{
    const {defaults}=await import('/src/player-preferences.ts'); const old=defaults();delete old.speed;
    old.volume=33;old.size='compact';old.showButtons=false;old.bindings.a=['KeyC'];
    localStorage.setItem(key,JSON.stringify(old));
  },prefKey(userA));
  await open(page,'GBA',false);
  const speed=page.getByRole('combobox',{name:'Velocidade',exact:true});
  await expect(speed).toHaveValue('1');await expect(page.getByLabel('Tamanho da tela')).toHaveValue('compact');
  await speed.selectOption('10');await button(page,'Iniciar jogo').click();await expect(button(page,'Pausar')).toBeVisible();
  await expect(page.getByRole('slider',{name:'Volume'})).toHaveValue('33');await expect(button(page,'Mostrar botões')).toHaveAttribute('aria-pressed','false');
  await expect(page.getByText('Áudio temporariamente silenciado durante aceleração.',{exact:true})).toBeVisible();
  await button(page,'Configurações').click();await expect(button(page,'Remapear A')).toContainText('C');await button(page,'Concluir').click();
  await page.setViewportSize({width:375,height:720});await expect(speed).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await button(page,'Tela cheia').click();await button(page,'Mais controles').click();await expect(speed).toBeVisible();await speed.selectOption('5');
  await button(page,'Sair da tela cheia').click();await leave(page);
  await page.reload();await open(page,'GBA',false);await expect(speed).toHaveValue('5');
  state.userId=userB;await page.reload();await open(page,'GB',false);await expect(speed).toHaveValue('1');
  state.userId=userA;
  for(const invalid of [0,4,11,'10',null]) {
    await page.evaluate(({key,invalid})=>{const value=JSON.parse(localStorage.getItem(key));value.speed=invalid;localStorage.setItem(key,JSON.stringify(value));},{key:prefKey(userA),invalid});
    await page.reload();await open(page,'GB',false);await expect(speed).toHaveValue('1');
    await expect(page.getByLabel('Tamanho da tela')).toHaveValue('compact');
  }
  await page.addInitScript(()=>{Storage.prototype.getItem=()=>{throw Error('offline storage')};Storage.prototype.setItem=()=>{throw Error('offline storage')};});
  await page.reload();await open(page,'GB',false);await expect(speed).toHaveValue('1');await speed.selectOption('3');await expect(speed).toHaveValue('3');
});

test('velocidade: modal, pausa e perda de reserva congelam core; intervalos usam tempo real',async({page})=>{
  await page.addInitScript(()=>{
    window.__intervals=[];const original=window.setInterval;
    window.setInterval=(fn,delay,...args)=>{window.__intervals.push(delay);return original(fn,delay,...args);};
  });
  const state=await setup(page);await open(page,'GBA',false);
  await page.evaluate(()=>{window.__intervals=[];});
  await button(page,'Iniciar jogo').click();await expect(button(page,'Pausar')).toBeVisible();
  const speed=page.getByRole('combobox',{name:'Velocidade',exact:true});
  for(const value of ['10','2','5','3','1','10'])await speed.selectOption(value);
  const timers=await page.evaluate(()=>window.__intervals.filter(ms=>ms===2000||ms===30000));
  expect(timers.sort((a,b)=>a-b)).toEqual([2000,30000]);
  const frames=()=>page.evaluate(()=>window.__uxFrames);
  await button(page,'Pausar').click();const paused=await frames();await speed.selectOption('5');await page.waitForTimeout(120);expect(await frames()).toBe(paused);
  await button(page,'Retomar').click();await expect.poll(frames).toBeGreaterThan(paused);
  await button(page,'Configurações').click();const modal=await frames();await page.waitForTimeout(120);expect(await frames()).toBe(modal);
  state.failRenew=true;await button(page,'Concluir').click();await expect(page.getByRole('alert')).toContainText('Falha sintética');
  const lost=await frames();await speed.selectOption('10');await page.waitForTimeout(120);expect(await frames()).toBe(lost);
  expect(await page.evaluate(()=>window.__intervals.filter(ms=>ms===2000||ms===30000))).toHaveLength(2);
});

test('volume: extremos visuais, interação e ganho real em temas/desktop/toque',async({page,context})=>{
  await page.addInitScript(()=>{
    const Original=window.AudioContext;window.__volumeAudio=[];
    window.AudioContext=class extends Original {
      constructor(...args){super(...args);window.__volumeAudio.push(this);}
      createGain(){const gain=super.createGain();this.__gain=gain;return gain;}
    };
  });
  await setup(page);await open(page,'GB');
  const slider=page.getByRole('slider',{name:'Volume',exact:true});
  const gain=()=>page.evaluate(()=>window.__volumeAudio.at(-1).__gain.gain.value);
  await button(page,'Ativar áudio').click();
  for(const [width,height,theme] of [[1280,900,'dark'],[1280,900,'light'],[390,844,'dark'],[390,844,'light']]){
    await page.setViewportSize({width,height});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    for(const value of [0,50,100]){
      await slider.fill(String(value));await expect(page.locator('.player-volume')).toContainText(`Volume ${value}%`);
      expect(await gain()).toBeCloseTo(value/100);await expectBits(page,0);
      await page.locator('.player-volume').screenshot({path:`.local/screenshots/volume-${width}-${theme}-${value}.png`});
    }
    const style=await slider.evaluate(e=>{const s=getComputedStyle(e);return {padding:s.padding,border:s.borderWidth,height:e.getBoundingClientRect().height};});
    expect(style.padding).toBe('0px');expect(style.border).toBe('0px');expect(style.height).toBeGreaterThanOrEqual(44);
    await slider.scrollIntoViewIfNeeded();const box=await slider.boundingBox(),y=box.y+box.height/2;
    await page.mouse.click(box.x+box.width/2,y);await expect(slider).toHaveValue('50');expect(await gain()).toBeCloseTo(.5);
    await page.mouse.move(box.x+box.width/2,y);await page.mouse.down();await page.mouse.move(box.x+box.width-1,y,{steps:8});await page.mouse.up();await expect(slider).toHaveValue('100');
    await page.mouse.move(box.x+box.width-8,y);await page.mouse.down();await page.mouse.move(box.x+1,y,{steps:8});await page.mouse.up();await expect(slider).toHaveValue('0');
    await slider.press('End');await expect(slider).toHaveValue('100');expect(await gain()).toBe(1);
    await slider.press('Home');await expect(slider).toHaveValue('0');expect(await gain()).toBe(0);
    await slider.press('ArrowRight');await expect(slider).toHaveValue('1');await slider.press('ArrowLeft');await expect(slider).toHaveValue('0');
  }
  const cdp=await context.newCDPSession(page);const box=await slider.boundingBox(),y=box.y+box.height/2;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+8,y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+box.width-1,y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await expect(slider).toHaveValue('100');expect(await gain()).toBe(1);
  await slider.fill('50');await button(page,'Silenciar').click();expect(await gain()).toBe(0);await expect(slider).toHaveValue('50');
  await button(page,'Ativar áudio').click();expect(await gain()).toBeCloseTo(.5);
  await slider.fill('0');await button(page,'Silenciar').click();await button(page,'Ativar áudio').click();expect(await gain()).toBe(0);
  await button(page,'Tela cheia').click(); await button(page,'Mais controles').click();
  for(const value of [0,50,100]) { await slider.fill(String(value)); expect(await gain()).toBeCloseTo(value/100); }
  await slider.fill('0'); await button(page,'Sair da tela cheia').click();
  await expectBits(page,0);expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).volume,prefKey(userA))).toBe(0);
});


for (const console of ['GB', 'GBA']) test(`${console}: maximizar mobile, fallback, orientação e D-pad em cruz`, async ({page, context}) => {
  await page.setViewportSize({width:390,height:844}); await setup(page); await open(page,console);
  await page.evaluate(() => { Element.prototype.requestFullscreen = undefined; });
  await button(page,'Tela cheia').click();
  await expect(page.locator('.player-expanded')).toBeVisible();
  await expect(page.getByText('Tela cheia indisponível. Modo expandido: a interface do navegador permanece.')).toBeVisible();
  for (const [width,height,theme] of [[390,844,'light'],[844,390,'dark'],[667,320,'light'],[568,256,'dark'],[1440,900,'dark']]) {
    await page.setViewportSize({width,height}); await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    await page.waitForTimeout(100); await geometry(page,console);
    const player = await page.locator('.player').boundingBox();
    expect(player.height).toBeLessThanOrEqual(height); expect(player.y).toBe(0);
    expect(await page.locator('.player').evaluate(e=>e.scrollHeight<=e.clientHeight)).toBe(true);
    await page.screenshot({path:`.local/screenshots/player-max-${console}-${width}.png`});
  }
  await page.setViewportSize({width:844,height:390}); await page.waitForTimeout(100);
  const rect=async name=>button(page,name).boundingBox();
  const up=await rect('Direcional cima'),left=await rect('Direcional esquerda'),down=await rect('Direcional baixo'),right=await rect('Direcional direita');
  expect(up.x).toBe(down.x); expect(left.y).toBe(right.y);
  expect(up.y+up.height).toBe(left.y); expect(left.y+left.height).toBe(down.y);
  expect(left.x+left.width).toBe(up.x); expect(up.x+up.width).toBe(right.x);
  await page.locator('.touch-center').click(); await expectBits(page,0);
  const cdp=await context.newCDPSession(page);
  const point=(r,id)=>({x:r.x+r.width/2,y:r.y+r.height/2,id});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(up,1),point(right,2),point(await rect('Botão A'),3)]});
  await expectBits(page,81);
  await expect(button(page,'Direcional cima')).toHaveAttribute('data-pressed','true');
  await expect(button(page,'Direcional direita')).toHaveAttribute('data-pressed','true');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]}); await expectBits(page,0);
  await button(page,'Mais controles').click(); await geometry(page,console);
  await page.screenshot({path:`.local/screenshots/player-max-${console}-menu.png`});
  await button(page,'Mostrar botões').click();
  await page.getByLabel('Tamanho da tela').selectOption('compact');
  await expect(button(page,'Configurações')).toBeVisible();
  await button(page,'Menos controles').click(); await geometry(page,console);
  await page.keyboard.press('Escape'); await expect(page.locator('.player-expanded')).toHaveCount(0);
  await expect(page.getByLabel('Tamanho da tela')).toHaveValue('compact');
  await expect(page.locator('.touch-controls')).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>document.body.style.overflow)).toBe('');
  // Rejection follows the same path; browser Back removes only expanded mode.
  await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('denied')); });
  await button(page,'Tela cheia').click(); await expect(page.locator('.player-expanded')).toBeVisible();
  await page.goBack(); await expect(page.locator('.player-expanded')).toHaveCount(0);
  await expect(button(page,'Pausar')).toBeVisible();
  await button(page,'Tela cheia').click(); await button(page,'Sair da tela cheia').click();
  await expect(page.locator('.player-expanded')).toHaveCount(0);
});
