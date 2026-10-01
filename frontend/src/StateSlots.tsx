import { useEffect, useState } from 'react';
import type { Request } from './api';
import { errorMessage } from './api';
import { Alert, Dialog } from './ui';
import { STATE_CORE, type CartridgeState } from './emulation/state';
import { fromBase64, saveHash, toBase64 } from './save-recovery';
interface Slot {slot:number;version:number;label:string;occupied:boolean;updatedAt:string;coreId:string;romHash:string;format:number;}
export function StateSlots({gameId,userId,request,token,capture,load,onClose,nativeInfo}: {gameId:string;userId:string;request:Request;token:string;capture:()=>Promise<CartridgeState>;load:(state:CartridgeState)=>Promise<void>;onClose:()=>void;nativeInfo:string}) {
 const [slots,setSlots]=useState<Slot[]>([]),[romHash,setRomHash]=useState(''),[labels,setLabels]=useState<Record<number,string>>({});
 const [busy,setBusy]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [confirm,setConfirm]=useState<{slot:number;action:'save'|'load'|'delete'}>();
 async function refresh(){const result=await request<{slots:Slot[];romHash:string}>(`/play/${gameId}/states`);setSlots(result.slots);setRomHash(result.romHash);setLabels(Object.fromEntries(result.slots.map(s=>[s.slot,s.label])));}
 useEffect(()=>{void refresh().catch(e=>setError(errorMessage(e))).finally(()=>setBusy(false));},[gameId]);
 async function run(slot:number,action:'save'|'load'|'delete') {
  setConfirm(undefined);setBusy(true);setError('');setNotice('');const current=slots.find(s=>s.slot===slot),version=current?.version??0;
  try {
   if(action==='save') {
    const state=await capture();
    await request(`/play/${gameId}/states/${slot}`,{method:'PUT',signal:AbortSignal.timeout(30000),body:{leaseId:token,version,label:labels[slot]??'',coreId:STATE_CORE,romHash,format:1,dataBase64:toBase64(state.data),nativeBase64:toBase64(state.native),sha256:await saveHash(state.data),nativeSha256:await saveHash(state.native)}});
    setNotice('Estado confirmado no servidor.');
   } else if(action==='load') {
    const {state}=await request<{state:Slot&{dataBase64:string;nativeBase64:string;sha256:string;nativeSha256:string}}>(`/play/${gameId}/states/${slot}/load`,{method:'POST',body:{leaseId:token,version}});
    const data=fromBase64(state.dataBase64),native=fromBase64(state.nativeBase64);
    if(state.coreId!==STATE_CORE||state.romHash!==romHash||state.format!==1||await saveHash(data)!==state.sha256||await saveHash(native)!==state.nativeSha256)throw Error('Estado incompatível/corrompido. Jogo atual preservado.');
    await load({data,native});setNotice('Estado e cartucho restaurados. Feche Saves e use Retomar.');
   } else {await request(`/saves/${userId}/${gameId}/${slot}`,{method:'DELETE',body:{version,confirmation:'EXCLUIR'}});setNotice('Slot excluído.');}
   await refresh();
  }catch(e){setError(errorMessage(e)); // Lost response: refresh shows the committed revision; never silently retry replacement.
   try{await refresh();}catch{ /* Preserve the original error. */ }
  }finally{setBusy(false);}
 }
 return <Dialog title="Saves" busy={busy} onDismiss={onClose}>
  <p>Save nativo: {nativeInfo}. Para excluir/reiniciar, encerre o jogo e abra Meus saves.</p>
  <p>Estados são pontos exatos compatíveis com esta ROM/core. Carregar também volta o cartucho ao ponto escolhido. Salve o instante atual em um slot antes de carregar outro, se quiser mantê-lo.</p>
  {error&&<Alert>{error}</Alert>}{notice&&<Alert kind="success">{notice}</Alert>}
  {[0,1,2,3].map(slot=>{const value=slots.find(s=>s.slot===slot),name=slot===0?'Save rápido':`Slot ${slot}`,compatible=!value?.occupied||(value.coreId===STATE_CORE&&value.romHash===romHash&&value.format===1);return <section className="card state-slot" key={slot} aria-label={name}>
   <h3>{name}</h3><p>{!value?.occupied?'Vazio':compatible?'Ocupado':'Incompatível'}{value?.occupied?` — ${new Date(value.updatedAt).toLocaleString('pt-BR')}`:''}</p>
   <label>Rótulo opcional<input aria-label={`Rótulo ${name}`} maxLength={80} value={labels[slot]??''} disabled={busy} onChange={e=>setLabels({...labels,[slot]:e.target.value})}/></label>
   <div className="player-actions"><button className="button secondary" disabled={busy||!romHash} onClick={()=>value?.occupied?setConfirm({slot,action:'save'}):void run(slot,'save')}>{slot===0?'Salvar rápido':'Salvar estado'}</button>
   <button className="button secondary" disabled={busy||!value?.occupied||!compatible} onClick={()=>setConfirm({slot,action:'load'})}>{slot===0?'Carregar rápido':'Carregar estado'}</button><button className="button secondary" disabled={busy||!value?.occupied} onClick={()=>setConfirm({slot,action:'delete'})}>Excluir slot</button></div>
  </section>;})}
  <p>Exclusão e gerenciamento dos pontos: Meus saves, fora do player.</p>
  <button className="button primary" disabled={busy} onClick={onClose}>Fechar Saves</button>
  {confirm&&<Dialog title={confirm.action==='save'?'Substituir estado?':confirm.action==='delete'?'Excluir slot?':'Carregar ponto anterior?'} busy={busy} onDismiss={()=>setConfirm(undefined)}>
   <p>{confirm.action==='save'?'O conteúdo anterior deste slot será substituído.':confirm.action==='delete'?'Somente este slot deste jogo da sua conta será excluído.':'O instante atual será substituído e o save nativo voltará ao cartucho deste estado. Preferências não mudam. Salve um slot antes se desejar manter o instante atual.'}</p>
   <button className="button secondary" onClick={()=>setConfirm(undefined)}>Cancelar</button><button className="button primary" onClick={()=>void run(confirm.slot,confirm.action)}>Confirmar</button>
  </Dialog>}
 </Dialog>;
}
