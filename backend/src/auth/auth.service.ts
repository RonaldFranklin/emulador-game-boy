import { BadRequestException, Inject, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { DatabaseService } from '../database/database.service.js';
import { publicUser, type UserRow } from '../users/user.js';
import { CONFIG, csrfForToken, hashToken, type SessionIdentity } from './session.js';
import { PasswordService } from './password.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { SessionService } from './session.service.js';

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash!: string;

  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly limits: RateLimitService,
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() { this.dummyHash = await this.passwords.hash(randomBytes(32).toString('hex')); }

  async login(username: string, password: string, ip: string) {
    await this.limits.claim(username, ip);
    const found = await this.database.pool.query<UserRow>('SELECT * FROM users WHERE username = $1', [username]);
    const candidate = found.rows[0];
    const correct = await this.passwords.verify(candidate?.password_hash ?? this.dummyHash, password);
    if (!candidate || !correct || candidate.blocked) throw this.loginError();
    const token = randomBytes(32).toString('base64url');
    const user = await this.database.transaction(async (client) => {
      const locked = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [candidate.id]);
      const current = locked.rows[0];
      // Reset/block may have committed during Argon2 verification: never revive that login.
      if (!current || current.blocked || current.password_hash !== candidate.password_hash) throw this.loginError();
      await client.query('DELETE FROM sessions WHERE expires_at <= now()');
      await client.query('DELETE FROM login_attempts WHERE window_start < now() - interval \'1 day\'');
      await client.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 hour')`,
        [hashToken(token), current.id, this.config.sessionTtlHours],
      );
      return publicUser(current);
    });
    await this.limits.clearUsername(username);
    return { token, user, csrfToken: csrfForToken(token) };
  }

  async logout(identity: SessionIdentity) {
    await this.sessions.withActor(identity, { allowTemporary: true }, async (client) => {
      await client.query('DELETE FROM sessions WHERE token_hash = $1', [identity.tokenHash]);
    });
  }

  async changePassword(identity: SessionIdentity, currentPassword: string, newPassword: string, ip: string) {
    await this.limits.claim(identity.user.username, ip);
    if (currentPassword === newPassword) throw new BadRequestException('A nova senha deve ser diferente da senha atual.');
    const hash = await this.passwords.hash(newPassword);
    await this.sessions.withActor(identity, { allowTemporary: true }, async (client, user) => {
      if (!await this.passwords.verify(user.password_hash, currentPassword)) throw new BadRequestException('Senha atual incorreta.');
      await client.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [hash, user.id]);
      await client.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
    });
    await this.limits.clearUsername(identity.user.username);
  }

  private loginError() { return new UnauthorizedException('Usuário ou senha inválidos.'); }
}
