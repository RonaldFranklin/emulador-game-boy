import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import type { UserRow } from '../users/user.js';
import { csrfForToken, hashToken, type SessionIdentity } from './session.js';

@Injectable()
export class SessionService {
  constructor(private readonly database: DatabaseService) {}

  async find(token: string): Promise<SessionIdentity> {
    const tokenHash = hashToken(token);
    const result = await this.database.pool.query<UserRow>(
      `SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.blocked = false`, [tokenHash],
    );
    const user = result.rows[0];
    if (!user) throw new UnauthorizedException('Sessão inválida ou expirada. Entre novamente.');
    return { user, tokenHash, csrfToken: csrfForToken(token) };
  }

  /** Recheck authorization under a user row lock to serialize against revocation. */
  async withActor<T>(identity: SessionIdentity, options: { master?: boolean; allowTemporary?: boolean }, work: (client: PoolClient, user: UserRow) => Promise<T>): Promise<T> {
    return this.database.transaction(async (client) => {
      const locked = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [identity.user.id]);
      const user = locked.rows[0];
      const session = await client.query('SELECT 1 FROM sessions WHERE token_hash = $1 AND user_id = $2 AND expires_at > now()', [identity.tokenHash, identity.user.id]);
      if (!user || user.blocked || session.rowCount !== 1) throw new UnauthorizedException('Sessão inválida ou expirada. Entre novamente.');
      if (!options.allowTemporary && user.must_change_password) throw new ForbiddenException('Troque sua senha temporária para continuar.');
      if (options.master && user.role !== 'MASTER') throw new ForbiddenException('Acesso permitido somente ao master.');
      return work(client, user);
    });
  }
}
