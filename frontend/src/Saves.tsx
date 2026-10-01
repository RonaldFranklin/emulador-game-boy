import { useEffect, useState } from 'react';
import type { Request } from './api';
import { errorMessage } from './api';
import { Alert, Dialog } from './ui';
interface Saved {epoch:string|null;user_id:string;game_id:string;username:string;game:string;console:string;kind:string;version:number;label:string;updatedAt:string;compatible:boolean;}
export function Saves({request,admin=false}:{request:Request;admin?:boolean}) {
 const [rows,setRows]=useState<Saved[]>([]),[user,setUser]=useState(''),[game,setGame]=useState(''),[offset,setOffset]=useState(0);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<Saved>(),[confirmation,setConfirmation]=useState('');
 async function refresh(){setBusy(true);try{const data=await request<{saves:Saved[]}>(`/saves?${new URLSearchParams({admin:admin?'true':'',user,game,offset:String(offset)})}`);setRows(data.saves);setError('');}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 useEffect(()=>{void refresh();},[admin,offset]);
 const type=(row:Saved)=>row.kind==='native'?'Save nativo':row.kind==='0'?'Save rápido':`Slot ${row.kind}`;
 async function remove(){if(!selected)return;setBusy(true);try{await request(`/saves/${selected.user_id}/${selected.game_id}/${selected.kind}`,{method:'DELETE',body:{version:selected.version,confirmation,epoch:selected.epoch}});setSelected(undefined);await refresh();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 return <section><h1>{admin?'Administração de saves':'Meus saves'}</h1><p>{admin?'Gerenciamento administrativo não permite carregar estados de outra conta.':'Save nativo e estados são independentes. Para salvar/carregar estados, abra o jogo e escolha Saves.'}</p>
  <form className="player-actions" onSubmit={e=>{e.preventDefault();if(offset)setOffset(0);else void refresh();}}>{admin&&<label>Usuário<input value={user} maxLength={80} onChange={e=>setUser(e.target.value)}/></label>}<label>Jogo<input value={game} maxLength={100} onChange={e=>setGame(e.target.value)}/></label><button className="button secondary" disabled={busy}>Filtrar</button></form>
  {error&&<Alert>{error}</Alert>}{!rows.length&&!busy&&<p>Nenhum save encontrado.</p>}
  {rows.map(row=><section className="card state-slot" key={`${row.user_id}:${row.game_id}:${row.kind}`}><h2>{row.game} · {row.console}</h2><p>{row.username} · {type(row)} · {row.label||'Sem rótulo'} · {new Date(row.updatedAt).toLocaleString('pt-BR')} · {row.compatible?'Disponível':'Incompatível'}</p><button className="button secondary" disabled={busy} onClick={()=>{setSelected(row);setConfirmation('');setError('');}}>Excluir {type(row)}</button></section>)}
  <div className="player-actions"><button className="button secondary" disabled={busy||!offset} onClick={()=>setOffset(Math.max(0,offset-100))}>Anterior</button><button className="button secondary" disabled={busy||rows.length<100} onClick={()=>setOffset(offset+100)}>Próxima</button></div>
  {selected&&<Dialog title="Excluir progresso?" busy={busy} onDismiss={()=>setSelected(undefined)}><p>Dono: <strong>{selected.username}</strong>. Jogo: <strong>{selected.game}</strong>. Tipo: <strong>{type(selected)}</strong>.</p><p>{selected.kind==='native'?'Exclui o save nativo e reinicia o progresso no próximo início. Reservas ativas impedem a exclusão; encerre o jogo antes. Pendências anteriores serão bloqueadas. States existentes permanecem e podem restaurar um ponto antigo mediante confirmação.':'Exclui somente este slot, sem apagar save nativo, ROM, conta ou outros slots.'}</p><label>Digite EXCLUIR<input aria-label="Digite EXCLUIR" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>{error&&<Alert>{error}</Alert>}<button className="button secondary" disabled={busy} onClick={()=>setSelected(undefined)}>Cancelar</button><button className="button primary" disabled={busy||confirmation!=='EXCLUIR'} onClick={()=>void remove()}>Confirmar exclusão</button></Dialog>}
 </section>;
}
