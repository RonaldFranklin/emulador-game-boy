import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import type { UserRow } from '../users/user.js';
import type { AppConfig } from '../config.js';
import { CONFIG, csrfForToken, hashToken, type SessionIdentity } from './session.js';

@Injectable()
export class SessionService {
  constructor(private readonly database: DatabaseService, @Inject(CONFIG) private readonly config:AppConfig) {}

  async find(token: string): Promise<SessionIdentity> {
    const tokenHash = hashToken(token);
    const result = await this.database.pool.query<UserRow & {mfa_verified_at:Date|null}>(
      `SELECT u.*,s.mfa_verified_at FROM users u JOIN sessions s ON s.user_id = u.id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.blocked = false
       AND (u.role<>'MASTER' OR (s.created_at>now()-$2*interval '1 hour' AND s.last_seen_at>now()-$3*interval '1 minute'
       AND (s.mfa_verified_at IS NOT NULL OR s.created_at>now()-interval '5 minutes')))`, [tokenHash,this.config.masterTtlHours,this.config.masterIdleMinutes],
    );
    const user = result.rows[0];
    if (!user) throw new UnauthorizedException('Sessão inválida ou expirada. Entre novamente.');
    if(user.role==='MASTER')await this.database.pool.query('UPDATE sessions SET last_seen_at=clock_timestamp() WHERE token_hash=$1',[tokenHash]);
    return { user, tokenHash, csrfToken: csrfForToken(token),mfaVerifiedAt:user.mfa_verified_at };
  }

  /** Recheck authorization under a user row lock to serialize against revocation. */
  async withActor<T>(identity: SessionIdentity, options: { master?: boolean; allowTemporary?: boolean; mfaFlow?:boolean }, work: (client: PoolClient, user: UserRow) => Promise<T>): Promise<T> {
    return this.database.transaction(async (client) => {
      const locked = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [identity.user.id]);
      const user = locked.rows[0];
      const session = await client.query<{mfa_verified_at:Date|null;recent:boolean}>(`SELECT mfa_verified_at,mfa_verified_at>clock_timestamp()-interval '10 minutes' AS recent FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()
       AND ($3::boolean=false OR (created_at>now()-$4*interval '1 hour' AND last_seen_at>now()-$5*interval '1 minute' AND (mfa_verified_at IS NOT NULL OR created_at>now()-interval '5 minutes')))`,[identity.tokenHash,identity.user.id,user?.role==='MASTER',this.config.masterTtlHours,this.config.masterIdleMinutes]);
      if (!user || user.blocked || session.rowCount !== 1) throw new UnauthorizedException('Sessão inválida ou expirada. Entre novamente.');
      if (!options.allowTemporary && user.must_change_password) throw new ForbiddenException('Troque sua senha temporária para continuar.');
      if (options.master && user.role !== 'MASTER') throw new ForbiddenException('Acesso permitido somente ao master.');
      if(user.role==='MASTER'&&!options.mfaFlow){
        if(!user.mfa_secret||!session.rows[0]!.mfa_verified_at)throw new ForbiddenException({message:'Confirme a autenticação em duas etapas para continuar.',code:'MFA_REQUIRED'});
        if(options.master&&!session.rows[0]!.recent)throw new ForbiddenException({message:'Confirme novamente sua senha e segundo fator em Segurança do master.',code:'MFA_REAUTH_REQUIRED'});
      }
      return work(client, user);
    });
  }
}
