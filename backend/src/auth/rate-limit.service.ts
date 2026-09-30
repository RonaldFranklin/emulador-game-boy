import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { hashToken } from './session.js';

@Injectable()
export class RateLimitService {
  constructor(private readonly database: DatabaseService) {}

  async claim(username: string, ip: string): Promise<void> {
    const keys = [hashToken(`username:${username}`), hashToken(`ip:${ip}`)];
    const counts = await this.database.transaction(async (client) => {
      // Both buckets persist across application restarts and are incremented atomically.
      const values: number[] = [];
      for (const key of keys) {
        const result = await client.query<{ attempts: number }>(
          `INSERT INTO login_attempts (key, attempts, window_start) VALUES ($1, 1, now())
           ON CONFLICT (key) DO UPDATE SET
             attempts = CASE WHEN login_attempts.window_start <= now() - interval '15 minutes' THEN 1 ELSE login_attempts.attempts + 1 END,
             window_start = CASE WHEN login_attempts.window_start <= now() - interval '15 minutes' THEN now() ELSE login_attempts.window_start END
           RETURNING attempts`, [key],
        );
        values.push(result.rows[0]!.attempts);
      }
      return values;
    });
    if (counts[0]! > 10 || counts[1]! > 100) {
      throw new HttpException('Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async clearUsername(username: string): Promise<void> {
    await this.database.pool.query('DELETE FROM login_attempts WHERE key = $1', [hashToken(`username:${username}`)]);
  }
}
