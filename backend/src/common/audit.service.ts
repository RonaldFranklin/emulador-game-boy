import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/session.js';
import { hashToken } from '../auth/session.js';
import { DatabaseService } from '../database/database.service.js';
import { Admission } from './admission.js';
interface Event { event:string;actor:string|null;target:string|null;game:string|null;state_slot:number|null;outcome:number;correlation:string;origin_hash:string|null;dropped:number; }
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Allowlisted metadata only. Never pass request bodies, headers, errors or upload names. */
@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private queue: Event[]=[];
  private dropped=0;
  private busy=false;
  private timer?: ReturnType<typeof setInterval>;
  private admission=new Admission(undefined,1024);
  private ticks=0;
  constructor(private readonly database:DatabaseService){}
  onModuleInit(){this.timer=setInterval(()=>{void this.flush().catch(()=>{});},1000);this.timer.unref();}
  async onModuleDestroy(){clearInterval(this.timer);await this.flush().catch(()=>{});}
  get pending(){return this.queue.length;}
  capture(request:AuthRequest,response:Response,correlation:string){
    const p=request.path.toLowerCase(), method=request.method;
    let event:string|undefined;
    if(/^\/api\/auth\/(login|logout|password|mfa\/(?:enroll|replace|confirm|verify|reauth))\/?$/.test(p)&&method==='POST')event=p.slice(5).replaceAll('/','.');
    else if(/^\/api\/users(?:\/[^/]+\/(?:status|reset-password))?\/?$/.test(p)&&['POST','PATCH'].includes(method))event=p.includes('reset-password')?'users.reset':p.includes('/status')?'users.status':'users.create';
    else if(/^\/api\/games(?:\/[^/]+)?\/?$/.test(p)&&['POST','PATCH'].includes(method))event=method==='POST'?'games.create':'games.update';
    else if(/^\/api\/saves\/[^/]+\/[^/]+\/[^/]+\/?$/.test(p)&&method==='DELETE')event=`saves.delete.${p.split('/').filter(Boolean).at(-1)==='native'?'native':'state'}`;
    else if(/^\/api\/play\/[^/]+\/states\/[0-3](?:\/load)?\/?$/.test(p)&&['PUT','POST'].includes(method))event=method==='PUT'?'states.write':'states.read';
    else if(/^\/api\/play\/[^/]+\/lease\/?$/.test(p)&&method==='POST'&&typeof request.body?.expectedGeneration==='string')event='play.takeover';
    if(!event)return;
    const actor=request.identity?.user.id??response.locals.auditActor;
    const ids=p.split('/').filter(part=>uuid.test(part));
    const target=(typeof response.locals.auditTarget==='string'&&uuid.test(response.locals.auditTarget)?response.locals.auditTarget:ids[0])??(event==='auth.login'&&typeof request.body?.username==='string'&&/^[a-z0-9_]{3,32}$/.test(request.body.username)?hashToken(request.body.username):null);
    const game=event.startsWith('states.')||event==='play.takeover'?ids[0]??null:event.startsWith('saves.')?ids[1]??null:null;
    const slotMatch=p.match(/\/states\/([0-3])(?:\/load)?\/?$/);
    const slot=slotMatch?Number(slotMatch[1]):event==='saves.delete.state'?Number(p.split('/').filter(Boolean).at(-1)):null;
    try {
      this.admission.take(actor?'authenticated':'anonymous',actor?600:60,60_000);
      if(!actor)this.admission.take(`ip:${request.ip}`,6,60_000);
      if(this.queue.length>=128)throw new Error('full');
      this.queue.push({event,actor:typeof actor==='string'&&uuid.test(actor)?actor:null,target,game,state_slot:slot!==null&&Number.isInteger(slot)&&slot>=0&&slot<=3?slot:null,outcome:response.statusCode,correlation,origin_hash:request.ip?hashToken(request.ip):null,dropped:0});
    }catch {this.dropped=Math.min(this.dropped+1,2147483647);}
  }
  async flush(){
    if(this.busy)return;this.busy=true;
    const batch=this.queue.splice(0,128);
    try{
      if(++this.ticks%60===0){
        if(this.dropped){batch.push({event:'audit.sampled',actor:null,target:null,game:null,state_slot:null,outcome:200,correlation:randomUUID(),origin_hash:null,dropped:this.dropped});this.dropped=0;}
        await this.database.pool.query("DELETE FROM security_audit WHERE occurred_at<clock_timestamp()-interval '30 days'");
      }
      if(batch.length)await this.database.pool.query(`INSERT INTO security_audit(event,actor,target,game,state_slot,outcome,correlation,origin_hash,dropped)
        SELECT event,actor,target,game,state_slot,outcome,correlation,origin_hash,dropped FROM jsonb_to_recordset($1::jsonb)
        AS e(event varchar(48),actor uuid,target varchar(64),game uuid,state_slot smallint,outcome integer,correlation uuid,origin_hash char(64),dropped integer)
        ON CONFLICT(slot) DO UPDATE SET occurred_at=clock_timestamp(),event=excluded.event,actor=excluded.actor,target=excluded.target,game=excluded.game,state_slot=excluded.state_slot,outcome=excluded.outcome,correlation=excluded.correlation,origin_hash=excluded.origin_hash,dropped=excluded.dropped`,[JSON.stringify(batch)]);
    }catch{this.dropped=Math.min(this.dropped+batch.length,2147483647);}finally{this.busy=false;}
  }
}
