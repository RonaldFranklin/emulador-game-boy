import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { AuditService } from './common/audit.service.js';
import type { AuthRequest } from './auth/session.js';
import { BadRequestException, HttpException, Global, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type NextFunction, type Request, type Response } from 'express';
import { clientIp } from './common/client-ip.js';
import { Admission } from './common/admission.js';
import { AdmissionInterceptor } from './common/admission.interceptor.js';
import { AuthModule } from './auth/auth.module.js';
import { CONFIG } from './auth/session.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { readConfig } from './config.js';
import { DatabaseModule } from './database/database.module.js';
import { GamesModule } from './games/games.module.js';
import { HealthModule } from './health/health.module.js';
import { PlayModule } from './play/play.module.js';
import { UsersModule } from './users/users.module.js';

@Global()
@Module({ providers: [{ provide: CONFIG, useFactory: readConfig }], exports: [CONFIG] })
class ConfigModule {}

@Module({ imports: [ConfigModule, DatabaseModule, AuthModule, UsersModule, GamesModule, PlayModule, HealthModule] })
class AppModule {}

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: ['error', 'warn', 'log'] });
  const config = app.get<ReturnType<typeof readConfig>>(CONFIG);
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const audit=app.get(AuditService);
  app.use((request: Request,response: Response,next: NextFunction)=>{
    const correlation=randomUUID();response.setHeader('X-Request-ID',correlation);
    response.once('finish',()=>audit.capture(request as AuthRequest,response,correlation));next();
  });
  const admission = new Admission();
  // Applied even before proxy DNS, guards, parsers and database access.
  app.use((request: Request,response: Response,next: NextFunction) => {
    try {
      admission.take('global',6000,60_000);
      const login=/^\/api\/auth\/login\/?$/i.test(request.path);
      admission.take(login?'route-login':'route-general',login?120:6000,60_000);
      const release=admission.enter(login); response.locals.releaseAdmission=release; response.once('finish',release);
      next();
    } catch(error) {
      const body=(error as HttpException).getResponse() as {message:string;retryAfterSeconds:number};
      response.setHeader('Retry-After',body.retryAfterSeconds);response.status(429).json({statusCode:429,message:body.message});
    }
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers.origin !== config.origin || request.headers['x-requested-with'] !== 'XMLHttpRequest') {
        response.status(403).json({ statusCode: 403, message: 'Origem da requisição não permitida.' });
        return;
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') {
        response.status(403).json({ statusCode: 403, message: 'Origem da requisição não permitida.' });
        return;
      }
      const catalogMutation = (request.method === 'POST' && /^\/api\/games\/?$/.test(request.path)) ||
        (request.method === 'PATCH' && /^\/api\/games\/[^/]+\/?$/.test(request.path));
      if (!request.is('application/json') && !(catalogMutation && request.is('multipart/form-data'))) {
        response.status(415).json({ statusCode: 415, message: 'Use JSON ou multipart/form-data nas rotas de catálogo.' });
        return;
      }
    }
    next();
  });
  app.use(async (request: Request, response: Response, next: NextFunction) => {
    try {
      const ip = await clientIp(request, /^\/api\/health\/?$/i.test(request.path) ? undefined : config.trustedProxyHost);
      if(request.aborted||response.destroyed){response.locals.releaseAdmission?.();return;}
      Object.defineProperty(request, 'ip', { value: ip, configurable: true });
      // Separate from failed-login policy; includes malformed bodies before parsing.
      admission.take(`requests:${ip}`,1200,60_000);
      if (request.method === 'POST' && /^\/api\/auth\/login\/?$/i.test(request.path)) {
        admission.take(`login-burst:${ip}`,30,60_000);
      }
      next();
    } catch (error) {
      response.locals.releaseAdmission?.();
      if(response.destroyed)return;
      if (error instanceof HttpException) {
        const body = error.getResponse() as { message: string; retryAfterSeconds: number };
        response.setHeader('Retry-After', body.retryAfterSeconds);
        response.status(error.getStatus()).json({ statusCode: error.getStatus(), message: body.message });
      } else {
        response.status(503).json({ statusCode: 503, message: 'Não foi possível validar a origem da conexão. Tente novamente em instantes.' });
      }
    }
  });
  const json = express.json({ limit: '16kb', strict: true });
  app.use((request: Request, response: Response, next: NextFunction) => {
    // The save route parses its larger body in an interceptor after auth/CSRF guards.
    if (request.method === 'PUT' && /^\/api\/play\/[^/]+\/(?:save|states\/[0-3])\/?$/.test(request.path)) { next(); return; }
    json(request, response, next);
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: false,
    validationError: { target: false, value: false },
    exceptionFactory: () => new BadRequestException('Dados inválidos. Confira os campos enviados.'),
  }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new AdmissionInterceptor());
  app.enableShutdownHooks();
  const server = app.getHttpServer();
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.headersTimeout = 15_000;
  server.requestTimeout = 65_000;
  await app.init();
  return app;
}
