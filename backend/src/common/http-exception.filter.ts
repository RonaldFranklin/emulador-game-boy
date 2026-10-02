import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response.locals.releaseAdmission?.();
    if(response.destroyed)return;
    const parserError = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
    const status = error instanceof HttpException ? error.getStatus()
      : parserError === 'entity.parse.failed' ? 400 : parserError === 'entity.too.large' ? 413 : parserError === 'encoding.unsupported' ? 415 : 500;
    let message: string | string[] = 'Falha interna. Tente novamente em instantes.';
    if (error instanceof HttpException) {
      const body = error.getResponse();
      if (typeof body === 'string') message = body;
      else if (typeof body === 'object' && body !== null && 'message' in body) {
        const detail = body.message;
        if (typeof detail === 'string' || (Array.isArray(detail) && detail.every((item) => typeof item === 'string'))) message = detail;
      }
    } else if (status === 400 || status === 413 || status === 415) {
      message = status === 400 ? 'JSON inválido.' : status === 413 ? 'Corpo da requisição muito grande.' : 'Codificação do corpo não suportada.';
    } else {
      // Do not log request bodies, cookie values, hashes, SQL arguments or secrets.
      this.logger.error('Erro inesperado ao processar requisição.');
    }
    if (status === 429) {
      const body = error instanceof HttpException ? error.getResponse() : undefined;
      const retry = typeof body === 'object' && body !== null && 'retryAfterSeconds' in body ? body.retryAfterSeconds : undefined;
      response.setHeader('Retry-After', typeof retry === 'number' && Number.isInteger(retry) && retry > 0 && retry <= 7200 ? retry : 900);
    }
    const body = error instanceof HttpException ? error.getResponse() : undefined;
    const challenge = status === 428 && typeof body === 'object' && body !== null && 'challenge' in body ? body.challenge : undefined;
    const code = typeof body==='object'&&body!==null&&'code' in body&&['MFA_REQUIRED','MFA_REAUTH_REQUIRED'].includes(String(body.code))?body.code:undefined;
    response.status(status).json({ statusCode: status, message, ...(challenge ? {challenge} : {}),...(code?{code}:{}) });
  }
}
