import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PasswordService } from '../auth/password.service.js';
import type { SessionIdentity } from '../auth/session.js';
import { SessionService } from '../auth/session.service.js';
import { publicUser, type UserRow } from './user.js';

@Injectable()
export class UsersService {
  constructor(private readonly sessions: SessionService, private readonly passwords: PasswordService) {}

  async list(actor: SessionIdentity) {
    return this.sessions.withActor(actor, { master: true }, async (client) => {
      const result = await client.query<UserRow>('SELECT * FROM users ORDER BY created_at, username');
      return { users: result.rows.map(publicUser) };
    });
  }

  async create(actor: SessionIdentity, username: string, password: string) {
    const hash = await this.passwords.hash(password);
    try {
      return await this.sessions.withActor(actor, { master: true }, async (client) => {
        const result = await client.query<UserRow>(
          `INSERT INTO users (id, username, password_hash, role, must_change_password)
           VALUES ($1, $2, $3, 'JOGADOR', true) RETURNING *`, [randomUUID(), username, hash],
        );
        return { user: publicUser(result.rows[0]!) };
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new ConflictException('Este nome de usuário já está em uso.');
      }
      throw error;
    }
  }

  async status(actor: SessionIdentity, id: string, blocked: boolean) {
    return this.sessions.withActor(actor, { master: true }, async (client) => {
      await this.player(client, id);
      const result = await client.query<UserRow>('UPDATE users SET blocked = $1 WHERE id = $2 RETURNING *', [blocked, id]);
      // Also revoke on unblocking so an old cookie cannot regain access.
      await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      return { user: publicUser(result.rows[0]!) };
    });
  }

  async resetPassword(actor: SessionIdentity, id: string, password: string) {
    const hash = await this.passwords.hash(password);
    await this.sessions.withActor(actor, { master: true }, async (client) => {
      await this.player(client, id);
      await client.query('UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2', [hash, id]);
      await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    });
  }

  private async player(client: PoolClient, id: string): Promise<UserRow> {
    const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    const user = result.rows[0];
    if (!user) throw new NotFoundException('Jogador não encontrado.');
    if (user.role !== 'JOGADOR') throw new ConflictException('Contas master não podem ser alteradas pela administração de jogadores.');
    return user;
  }
}
