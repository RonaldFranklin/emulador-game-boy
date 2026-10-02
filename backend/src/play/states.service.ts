import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { SessionIdentity } from '../auth/session.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { SessionService } from '../auth/session.service.js';
import { CATALOG_LOCK_KEY } from '../games/catalog-constants.js';
import { leaseInput } from './play-input.js';
import { PlayService } from './play.service.js';
export const STATE_CORE = 'wasm:6d9f5c0b7819bd16267a8c8ad1737ef58ad539065c52ad6ae3fabf574f0b5fa8';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const columns = 'slot,version,label,console,rom_sha256 AS "romHash",core_id AS "coreId",format,sha256,native_sha256 AS "nativeSha256",updated_at AS "updatedAt",(data IS NOT NULL) AS occupied';
export function slotNumber(value: string) { if (!/^[0-3]$/.test(value)) throw new BadRequestException('Slot inválido.'); return Number(value); }
function version(value: unknown): number { if (!Number.isInteger(value) || (value as number)<0 || (value as number)>=2147483647) throw new BadRequestException('Versão inválida.'); return value as number; }
function object(body: unknown, fields: string[]): any {
 if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>!fields.includes(k))) throw new BadRequestException('Campos de estado inválidos.'); return body;
}
function decode(value: unknown, max: number, empty=false): Buffer {
 if (typeof value!=='string' || value.length>Math.ceil(max/3)*4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new BadRequestException('Estado inválido ou acima do limite.');
 const bytes=Buffer.from(value,'base64');if(bytes.length>max || (!empty&&!bytes.length) || bytes.toString('base64')!==value) throw new BadRequestException('Estado inválido.');return bytes;
}
@Injectable()
export class StatesService {
 constructor(private readonly sessions: SessionService, private readonly play: PlayService, private readonly limits:RateLimitService) {}
 async slots(id: string, identity: SessionIdentity) {await this.limits.bucket('states-list',identity.user.id,60,60);return this.play.withGame(id,identity,false,async(client,game)=>({coreId:STATE_CORE,romHash:game.rom_sha256,slots:(await client.query(`SELECT ${columns} FROM save_states WHERE user_id=$1 AND game_id=$2 ORDER BY slot`,[identity.user.id,id])).rows}));}
 async read(id: string, slot: number, identity: SessionIdentity, input: unknown) {
  const b=object(input,['leaseId','version']);const v=version(b.version);leaseInput({leaseId:b.leaseId});
  await this.limits.prepareBudget('states-read',identity.user.id);
  return this.play.withGame(id,identity,true,async(client,game)=>{
   await this.play.requireLease(client,id,identity,b.leaseId);
   const row=(await client.query(`SELECT ${columns},data,native FROM save_states WHERE user_id=$1 AND game_id=$2 AND slot=$3`,[identity.user.id,id,slot])).rows[0];
   if(!row?.occupied)throw new NotFoundException('Slot vazio.');if(row.version!==v)throw new ConflictException('O slot mudou. Atualize antes de carregar.');
   if(row.coreId!==STATE_CORE||row.romHash!==game.rom_sha256||row.console!==game.console||row.format!==1||hash(row.data)!==row.sha256||hash(row.native)!==row.nativeSha256)throw new ConflictException('Estado incompatível ou corrompido; progresso atual preservado.');
   await this.limits.budget('states-read','global',1,row.data.length+row.native.length,240,128*1024**2,client);
   await this.limits.budget('states-read',identity.user.id,1,row.data.length+row.native.length,20,32*1024**2,client);
   const {data,native,...meta}=row;return {state:{...meta,dataBase64:data.toString('base64'),nativeBase64:native.toString('base64')}};
  });
 }
 async write(id: string,slot: number,identity:SessionIdentity,input:unknown) {
  const b=object(input,['leaseId','version','label','coreId','romHash','format','dataBase64','nativeBase64','sha256','nativeSha256']);const v=version(b.version);leaseInput({leaseId:b.leaseId});
  if(typeof b.label!=='string'||b.label.length>80||b.coreId!==STATE_CORE||b.format!==1)throw new BadRequestException('Rótulo ou formato/core incompatível.');
  const data=decode(b.dataBase64,524288),native=decode(b.nativeBase64,1048576,true);
  if(hash(data)!==b.sha256||hash(native)!==b.nativeSha256)throw new BadRequestException('Checksum do estado inválido.');
  await this.limits.prepareBudget('states-write',identity.user.id);
  return this.play.withGame(id,identity,true,async(client,game)=>{
   await this.play.requireLease(client,id,identity,b.leaseId);
   if(b.romHash!==game.rom_sha256||data.length!==(game.console==='GB'?71680:397312))throw new BadRequestException('Estado não corresponde à ROM/console/tamanho esperado.');
   const old=(await client.query('SELECT * FROM save_states WHERE user_id=$1 AND game_id=$2 AND slot=$3 FOR UPDATE',[identity.user.id,id,slot])).rows[0];
   // Same payload+label at v+1 is an idempotent retry after a lost response.
   if(old?.version===v+1&&old.sha256===b.sha256&&old.native_sha256===b.nativeSha256&&old.label===b.label)return {version:old.version};
   if((old?.version??0)!==v)throw new ConflictException('O slot mudou. Atualize e confirme novamente.');
   await this.limits.budget('states-write','global',1,data.length+native.length,120,64*1024**2,client);
   await this.limits.budget('states-write',identity.user.id,1,data.length+native.length,10,8*1024**2,client);
   const quota=(await client.query('SELECT coalesce(sum(octet_length(data)+octet_length(native)),0)::bigint AS total,coalesce(sum(octet_length(data)+octet_length(native)) FILTER(WHERE user_id=$1),0)::bigint AS own FROM save_states',[identity.user.id])).rows[0];
   const delta=data.length+native.length-(old?.data?.length??0)-(old?.native?.length??0);
   if(Number(quota.total)+delta>256*1024**2||Number(quota.own)+delta>32*1024**2)throw new HttpException('Quota de estados atingida (32 MiB por usuário / 256 MiB global).',507);
   await client.query(`INSERT INTO save_states(user_id,game_id,slot,version,label,console,rom_sha256,core_id,format,data,native,sha256,native_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12)
    ON CONFLICT(user_id,game_id,slot) DO UPDATE SET version=excluded.version,label=excluded.label,console=excluded.console,rom_sha256=excluded.rom_sha256,core_id=excluded.core_id,format=1,data=excluded.data,native=excluded.native,sha256=excluded.sha256,native_sha256=excluded.native_sha256,updated_at=clock_timestamp()`,[identity.user.id,id,slot,v+1,b.label,game.console,game.rom_sha256,STATE_CORE,data,native,b.sha256,b.nativeSha256]);
   return {version:v+1};
  });
 }
 list(identity:SessionIdentity,admin:boolean,user:string,game:string,offset:number) {
  return this.sessions.withActor(identity,{master:admin},async client=>({saves:(await client.query(`SELECT s.*,u.username,g.name AS game,g.console,r.epoch FROM (
   SELECT user_id,game_id,'native' AS kind,version,'' AS label,updated_at AS "updatedAt",true AS compatible FROM game_saves
   UNION ALL SELECT user_id,game_id,slot::text,version,label,updated_at,(core_id=$5 AND format=1 AND rom_sha256=(SELECT rom_sha256 FROM games WHERE id=game_id)) FROM save_states WHERE data IS NOT NULL
   ) s JOIN users u ON u.id=s.user_id JOIN games g ON g.id=s.game_id LEFT JOIN save_resets r ON r.user_id=s.user_id AND r.game_id=s.game_id
   WHERE ($1::uuid IS NULL OR s.user_id=$1) AND u.username ILIKE $2 AND g.name ILIKE $3 ORDER BY u.username,g.name,s.kind LIMIT 100 OFFSET $4`,[admin?null:identity.user.id,`%${user.slice(0,80)}%`,`%${game.slice(0,100)}%`,offset,STATE_CORE])).rows}));
 }
 delete(owner:string,id:string,kind:string,identity:SessionIdentity,input:unknown) {
  const b=object(input,['version','confirmation','epoch']);const v=version(b.version);if(b.confirmation!=='EXCLUIR')throw new BadRequestException('Confirmação necessária.');
  const slot=kind==='native'?null:slotNumber(kind);
  return this.sessions.withActor(identity,{master:owner!==identity.user.id},async client=>{
   // Lock the referenced owner before the catalogue lock. NOWAIT prevents a
   // cross-account deletion from deadlocking a writer holding its own user lock.
   try { await client.query('SELECT id FROM users WHERE id=$1 FOR KEY SHARE NOWAIT',[owner]); }
   catch(error){if((error as {code?:string}).code==='55P03')throw new ConflictException('O dono está atualizando o progresso. Tente novamente.');throw error;}
   await client.query('SELECT pg_advisory_xact_lock($1)',[CATALOG_LOCK_KEY]);
   if(slot===null){
    const epoch=(await client.query('SELECT epoch FROM save_resets WHERE user_id=$1 AND game_id=$2',[owner,id])).rows[0]?.epoch??null;
    if((b.epoch??null)!==epoch)throw new ConflictException('O progresso foi reiniciado. Atualize a lista e confirme novamente.');
    if((await client.query('SELECT 1 FROM play_leases WHERE user_id=$1 AND game_id=$2 AND expires_at>clock_timestamp()',[owner,id])).rowCount)throw new ConflictException('Encerre a sessão de jogo antes de excluir o save nativo. Uma reserva ativa protege o progresso.');
    const deleted=await client.query('DELETE FROM game_saves WHERE user_id=$1 AND game_id=$2 AND version=$3 RETURNING version',[owner,id,v]);
    if(!deleted.rowCount)throw new ConflictException('O save mudou ou já foi excluído. Atualize a lista.');
    await client.query('INSERT INTO save_resets(user_id,game_id,epoch) VALUES($1,$2,$3) ON CONFLICT(user_id,game_id) DO UPDATE SET epoch=excluded.epoch,deleted_at=clock_timestamp()',[owner,id,randomUUID()]);
   }else{
    const deleted=await client.query('UPDATE save_states SET data=NULL,native=NULL,sha256=NULL,native_sha256=NULL,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND game_id=$2 AND slot=$3 AND version=$4 AND data IS NOT NULL RETURNING version',[owner,id,slot,v]);
    if(!deleted.rowCount)throw new ConflictException('O slot mudou ou já foi excluído. Atualize a lista.');
   }
  });
 }
}
