import { CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor, RequestTimeoutException } from '@nestjs/common';
import express, { type Response } from 'express';
import { finalize, type Observable } from 'rxjs';
import type { AuthRequest } from '../auth/session.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { MAX_SAVE_JSON_BYTES } from './play-constants.js';

/** Route-scoped large JSON parser: all guards (including CSRF) run first. */
@Injectable()
export class SaveJsonInterceptor implements NestInterceptor {
  private active = 0;
  protected readonly parse = express.json({ limit: MAX_SAVE_JSON_BYTES, strict: true, inflate: false });

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

@Injectable()
export class StateJsonInterceptor extends SaveJsonInterceptor {
 protected override readonly parse = express.json({limit:2100000,strict:true,inflate:false});
 constructor(private readonly limits:RateLimitService){super();}
 override async intercept(context:ExecutionContext,next:CallHandler){
   const req=context.switchToHttp().getRequest<AuthRequest>();
   // Request count also bounds ingress bytes: each body is at most 2.1 MB.
   // Kept separate from committed-write budgets so a lost ACK can be retried.
   await this.limits.bucket('states-ingress-global','global',120,60);
   await this.limits.bucket('states-ingress',req.identity.user.id,20,60);
   return super.intercept(context,next);
 }
}
