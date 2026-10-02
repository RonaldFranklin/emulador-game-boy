import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { finalize } from 'rxjs';
import type { Response } from 'express';

// Client disconnect does not cancel database/hash work. Keep its permit until
// the actual handler settles; otherwise aborted requests bypass concurrency.
export class AdmissionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(finalize(() => response.locals.releaseAdmission?.()));
  }
}
