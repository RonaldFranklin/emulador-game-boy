export interface LoginChallenge { token: string; zeros: number; }
export function solveLoginProof(challenge: LoginChallenge, signal: AbortSignal): Promise<string> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted) {reject(new Error('Verificação cancelada.'));return;}
    const worker=new Worker(new URL('./login-proof.worker.ts',import.meta.url),{type:'module'});
    const stop=()=>{worker.terminate();signal.removeEventListener('abort',abort);};
    const abort=()=>{stop();reject(new Error('Verificação cancelada.'));};
    worker.onmessage=({data})=>{stop();typeof data==='string'?resolve(data):reject(new Error('A verificação demorou demais. Tente novamente.'));};
    worker.onerror=()=>{stop();reject(new Error('Não foi possível verificar este navegador. Tente novamente.'));};
    signal.addEventListener('abort',abort,{once:true});worker.postMessage(challenge);
  });
}
