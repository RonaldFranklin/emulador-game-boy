import { BadRequestException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import type { PoolClient } from 'pg';
import type { AppConfig } from '../config.js';
import { publicUser, type UserRow } from '../users/user.js';
import { CONFIG, csrfForToken, hashToken, type SessionIdentity } from './session.js';
import { SessionService } from './session.service.js';
import { PasswordService } from './password.service.js';
import { RateLimitService } from './rate-limit.service.js';

@Injectable()
export class MfaService {
 constructor(private readonly sessions:SessionService,private readonly passwords:PasswordService,private readonly limits:RateLimitService,@Inject(CONFIG)private readonly config:AppConfig){}
 private key(){if(!this.config.mfaEncryptionKey)throw new ServiceUnavailableException('MFA precisa ser configurado pelo operador antes de liberar administração.');return this.config.mfaEncryptionKey;}
 private encrypt(id:string,secret:string){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key(),iv);c.setAAD(Buffer.from(`emulador:mfa:v1:${id}`));const bytes=Buffer.concat([c.update(secret,'utf8'),c.final()]);return ['v1',iv.toString('base64url'),c.getAuthTag().toString('base64url'),bytes.toString('base64url')].join(':');}
 private decrypt(id:string,encrypted:string){const [version,iv,tag,bytes]=encrypted.split(':');if(version!=='v1'||!iv||!tag||!bytes)throw new ServiceUnavailableException('Não foi possível acessar o segundo fator. Contate o operador.');try{const c=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(iv,'base64url'));c.setAAD(Buffer.from(`emulador:mfa:v1:${id}`));c.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([c.update(Buffer.from(bytes,'base64url')),c.final()]).toString('utf8');}catch{throw new ServiceUnavailableException('Não foi possível acessar o segundo fator. Contate o operador.');}}
 private async limit(identity:SessionIdentity){if(identity.user.role!=='MASTER')throw new ForbiddenException('Acesso permitido somente ao master.');await this.limits.bucket('mfa-actor',identity.user.id,10,900);}
 private async password(user:UserRow,password:string){if(!await this.passwords.verify(user.password_hash,password))throw new BadRequestException('Não foi possível confirmar as credenciais.');}
 private async totp(user:UserRow,secret:string,code:string){
  if(!/^\d{6}$/.test(code))throw new BadRequestException('Código inválido, expirado ou já utilizado.');
  const result=await verify({strategy:'totp',secret,token:code,epochTolerance:[30,0],...(Number(user.mfa_last_step)>=0?{afterTimeStep:Number(user.mfa_last_step)}:{})});
  if(!result.valid||!('timeStep' in result))throw new BadRequestException('Código inválido, expirado ou já utilizado.');return result.timeStep;
 }
 async enroll(identity:SessionIdentity,password:string){await this.limit(identity);this.key();return this.sessions.withActor(identity,{master:true,mfaFlow:true},async(client,user)=>{
  if(user.mfa_secret)throw new BadRequestException('MFA já está ativo. Use a substituição de autenticador.');await this.password(user,password);
  const secret=generateSecret();await client.query("UPDATE users SET mfa_pending_secret=$2,mfa_pending_until=clock_timestamp()+interval '10 minutes',mfa_pending_session=$3 WHERE id=$1",[user.id,this.encrypt(user.id,secret),identity.tokenHash]);
  return {secret,uri:generateURI({issuer:'Emulador',label:user.username,secret}),expiresInSeconds:600};
 });}
 private async rotate(client:PoolClient,identity:SessionIdentity,user:UserRow,revokeAll=false){
  const token=randomBytes(32).toString('base64url');
  if(revokeAll)await client.query('DELETE FROM sessions WHERE user_id=$1',[user.id]);else await client.query('DELETE FROM sessions WHERE token_hash=$1',[identity.tokenHash]);
  await client.query("INSERT INTO sessions(token_hash,user_id,expires_at,mfa_verified_at,last_seen_at) VALUES($1,$2,clock_timestamp()+$3*interval '1 hour',clock_timestamp(),clock_timestamp())",[hashToken(token),user.id,this.config.masterTtlHours]);
  return {token,user:publicUser(user),csrfToken:csrfForToken(token),mfa:'verified' as const};
 }
 async confirm(identity:SessionIdentity,code:string){await this.limit(identity);return this.sessions.withActor(identity,{master:true,mfaFlow:true},async(client,user)=>{
  if(!user.mfa_pending_secret||!user.mfa_pending_until||user.mfa_pending_until.getTime()<=Date.now()||user.mfa_pending_session!==identity.tokenHash)throw new BadRequestException('Cadastro expirado ou de outra sessão. Inicie novamente.');
  const secret=this.decrypt(user.id,user.mfa_pending_secret), step=await this.totp({...user,mfa_last_step:'-1'},secret,code);
  const recoveryCodes=Array.from({length:10},()=>randomBytes(18).toString('base64url'));
  await client.query('UPDATE users SET mfa_secret=mfa_pending_secret,mfa_pending_secret=NULL,mfa_pending_until=NULL,mfa_pending_session=NULL,mfa_last_step=$2,mfa_recovery_hashes=$3 WHERE id=$1',[user.id,step,recoveryCodes.map(hashToken)]);
  return {...await this.rotate(client,identity,user,true),recoveryCodes};
 });}
 private async factor(client:PoolClient,user:UserRow,code:string){
  if(!user.mfa_secret)throw new BadRequestException('Cadastre o segundo fator primeiro.');
  if(/^[a-zA-Z0-9_-]{24}$/.test(code)&&user.mfa_recovery_hashes.includes(hashToken(code))){
   await client.query('UPDATE users SET mfa_recovery_hashes=array_remove(mfa_recovery_hashes,$2) WHERE id=$1',[user.id,hashToken(code)]);return true;
  }
  const step=await this.totp(user,this.decrypt(user.id,user.mfa_secret),code);await client.query('UPDATE users SET mfa_last_step=$2 WHERE id=$1',[user.id,step]);return false;
 }
 async authenticate(identity:SessionIdentity,code:string,password?:string){await this.limit(identity);return this.sessions.withActor(identity,{master:true,mfaFlow:true},async(client,user)=>{
  if(password!==undefined)await this.password(user,password);
  else if(identity.mfaVerifiedAt)throw new BadRequestException('Para reautenticar, confirme também sua senha.');
  const recovery=await this.factor(client,user,code);return this.rotate(client,identity,user,recovery);
 });}
 async replace(identity:SessionIdentity,password:string,code:string){await this.limit(identity);return this.sessions.withActor(identity,{master:true,mfaFlow:true},async(client,user)=>{
  await this.password(user,password);const recovered=await this.factor(client,user,code);
  if(recovered)await client.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[user.id,identity.tokenHash]);
  const secret=generateSecret();
  // Keep the old factor until confirmation; only this authorized session can confirm replacement.
  await client.query("UPDATE users SET mfa_pending_secret=$2,mfa_pending_until=clock_timestamp()+interval '10 minutes',mfa_pending_session=$3 WHERE id=$1",[user.id,this.encrypt(user.id,secret),identity.tokenHash]);
  return {secret,uri:generateURI({issuer:'Emulador',label:user.username,secret}),expiresInSeconds:600};
 });}
}
