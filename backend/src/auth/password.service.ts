import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { hashPassword, verifyPassword } from './password.js';

/** Bound Argon2 memory use even when many HTTP requests arrive at once. */
@Injectable()
export class PasswordService {
  private active = 0;

  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= 4) {
      throw new HttpException('Muitas operações simultâneas. Tente novamente em instantes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.active += 1;
    try { return await work(); } finally { this.active -= 1; }
  }

  hash(password: string) { return this.bounded(() => hashPassword(password)); }
  verify(hash: string, password: string) { return this.bounded(() => verifyPassword(hash, password)); }
}
