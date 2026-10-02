import { sha256 } from '@noble/hashes/sha2.js';
// Work stays off the UI thread. Termination cancels all CPU work when leaving login.
self.onmessage = ({data}:{data:{token:string;zeros:number}}) => {
  if (!/^[a-zA-Z0-9_-]{43}$/.test(data.token) || ![4,5].includes(data.zeros)) return;
  const encoder=new TextEncoder(), deadline=performance.now()+90_000;
  for(let nonce=0;nonce<100_000_000;nonce++) {
    const digest=sha256(encoder.encode(`${data.token}:${nonce}`));
    if(digest[0]===0 && digest[1]===0 && (data.zeros===4 || digest[2]!<16)) { self.postMessage(String(nonce));return; }
    if(nonce%4096===0 && performance.now()>deadline) break;
  }
  self.postMessage(null);
};
