import { CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { finalize, type Observable } from 'rxjs';

/** Keep the slot until the response drains or disconnects, not just until readFile ends. */
@Injectable()
export class RomResponseInterceptor implements NestInterceptor {
  private active = 0;

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    if (this.active >= 2) throw new HttpException({ message: 'Há duas ROMs sendo carregadas. Tente novamente.', retryAfterSeconds: 1 }, HttpStatus.TOO_MANY_REQUESTS);
    this.active += 1;
    let released = false;
    let processed = false;
    let drained = false;
    const release = () => {
      if (released || !processed || !drained) return;
      released = true;
      this.active -= 1;
      clearTimeout(timer);
      response.off('finish', onDrain);
      response.off('close', onDrain);
    };
    const onDrain = () => { drained = true; release(); };
    const timer = setTimeout(() => { response.destroy(); }, 60_000);
    timer.unref();
    response.once('finish', onDrain);
    response.once('close', onDrain);
    // A disconnected caller must still occupy a slot until its bounded read ends.
    return next.handle().pipe(finalize(() => { processed = true; release(); }));
  }
}
