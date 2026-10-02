import { useState, type FormEvent } from 'react';
import { errorMessage, type Request, type Session } from './api';
import { Alert } from './ui';

export function Mfa({session,request,onVerified}:{session:Session;request:Request;onVerified:(next:Session,codes?:string[])=>void}){
 const [password,setPassword]=useState(''),[code,setCode]=useState(''),[secret,setSecret]=useState('');
 const [replace,setReplace]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const enrolling=session.mfa==='enroll'||replace;
 async function submit(event:FormEvent){event.preventDefault();if(busy)return;setBusy(true);setError('');setNotice('');
  try{
   if(enrolling&&!secret){const result=await request<{secret:string}>(`/auth/mfa/${replace?'replace':'enroll'}`,{method:'POST',body:{password,...(replace?{code}:{})}});setSecret(result.secret);setPassword('');setCode('');}
   else {const result=await request<Session&{recoveryCodes?:string[]}>(`/auth/mfa/${secret?'confirm':session.mfa==='verify'?'verify':'reauth'}`,{method:'POST',body:{code,...(!secret&&session.mfa!=='verify'?{password}:{})}});setPassword('');setCode('');setSecret('');setReplace(false);onVerified(result,result.recoveryCodes);setNotice('Autenticação confirmada. Ações administrativas liberadas por 10 minutos.');}
  }catch(reason){setError(errorMessage(reason));}finally{setBusy(false);}
 }
 return <section className="card password-card"><h1>Segurança do master</h1>
  <p>{session.mfa==='enroll'?'Cadastre um autenticador TOTP para liberar sua conta master.':session.mfa==='verify'?'Confirme seu segundo fator para entrar.':'Ações administrativas exigem confirmação recente da senha e do segundo fator.'}</p>
  {error&&<Alert>{error}</Alert>}{notice&&<Alert kind="success">{notice}</Alert>}
  {secret&&<><p>No autenticador, adicione uma conta manualmente: nome Emulador, tipo por tempo (TOTP), 6 dígitos, período 30 segundos, SHA-1. Guarde a chave somente no autenticador.</p><label className="field">Chave de cadastro<input readOnly value={secret} aria-label="Chave de cadastro" autoComplete="off" /></label><p>Digite um código gerado para confirmar. O cadastro expira em 10 minutos.</p></>}
  <form onSubmit={event=>void submit(event)}><fieldset disabled={busy}>
   {!secret&&session.mfa!=='verify'&&<div className="field"><label htmlFor="mfa-password">Senha atual</label><input id="mfa-password" type="password" autoComplete="current-password" maxLength={128} required value={password} onChange={e=>setPassword(e.target.value)}/></div>}
   {(!enrolling||replace||!!secret)&&<div className="field"><label htmlFor="mfa-code">{secret?'Código do novo autenticador':'Código do autenticador ou de recuperação'}</label><input id="mfa-code" autoComplete="one-time-code" spellCheck={false} autoCapitalize="none" maxLength={24} required value={code} onChange={e=>setCode(e.target.value.trim())}/></div>}
   <button className="button primary" type="submit">{busy?'Confirmando…':enrolling&&!secret?'Iniciar cadastro':'Confirmar autenticação'}</button>
  </fieldset></form>
  {session.mfa==='verified'&&!secret&&<button className="button secondary" disabled={busy} onClick={()=>{setReplace(!replace);setCode('');setPassword('');}}>{replace?'Cancelar substituição':'Substituir autenticador e códigos de recuperação'}</button>}
  <p>Um código TOTP já usado não pode ser repetido: aguarde o próximo. Cada código de recuperação funciona uma única vez; seu uso para entrar encerra as outras sessões. Sem autenticador e sem códigos, não há recuperação pública ou senha mestra.</p>
 </section>;
}

export function RecoveryCodes({codes,onDone}:{codes:string[];onDone:()=>void}){
 const [saved,setSaved]=useState(false);
 return <section className="card password-card"><h1>Guarde seus códigos de recuperação</h1><p>Exibidos somente agora. Cada código substitui o segundo fator uma única vez, junto da senha. Guarde-os em lugar seguro, separado do autenticador; não envie por chat.</p><ul>{codes.map(code=><li key={code}><code>{code}</code></li>)}</ul><label><input type="checkbox" checked={saved} onChange={e=>setSaved(e.target.checked)}/> Guardei os códigos em lugar seguro</label><p><button className="button primary" disabled={!saved} onClick={onDone}>Continuar</button></p></section>;
}
