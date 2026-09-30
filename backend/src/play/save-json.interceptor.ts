import { CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor, RequestTimeoutException } from '@nestjs/common';
import express, { type Response } from 'express';
import { finalize, type Observable } from 'rxjs';
import type { AuthRequest } from '../auth/session.js';
import { MAX_SAVE_JSON_BYTES } from './play-constants.js';

/** Route-scoped large JSON parser: all guards (including CSRF) run first. */
@Injectable()
export class SaveJsonInterceptor implements NestInterceptor {
  private active = 0;
  private readonly parse = express.json({ limit: MAX_SAVE_JSON_BYTES, strict: true, inflate: false });

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    if (this.active >= 2) throw new HttpException({ message: 'Há duas sincronizações em andamento. Tente novamente.', retryAfterSeconds: 1 }, HttpStatus.TOO_MANY_REQUESTS);
    this.active += 1;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.off('aborted', aborted);
          request.off('error', aborted);
          if (error) reject(error); else resolve();
        };
        const aborted = () => finish(new RequestTimeoutException('A sincronização foi interrompida.'));
        const timer = setTimeout(() => { finish(new RequestTimeoutException('A sincronização excedeu 30 segundos.')); request.destroy(); }, 30_000);
        timer.unref();
        request.once('aborted', aborted);
        request.once('error', aborted);
        try { this.parse(request, response, finish); } catch (error) { finish(error); }
      });
      return next.handle().pipe(finalize(() => { this.active -= 1; }));
    } catch (error) {
      this.active -= 1;
      throw error;
    }
  }
}
