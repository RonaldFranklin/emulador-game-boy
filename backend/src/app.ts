import 'reflect-metadata';
import { BadRequestException, HttpException, Global, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type NextFunction, type Request, type Response } from 'express';
import { clientIp } from './common/client-ip.js';
import { RateLimitService } from './auth/rate-limit.service.js';
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
  const limits = app.get(RateLimitService);
  app.use(async (request: Request, response: Response, next: NextFunction) => {
    try {
      const ip = await clientIp(request, /^\/api\/health\/?$/i.test(request.path) ? undefined : config.trustedProxyHost);
      Object.defineProperty(request, 'ip', { value: ip, configurable: true });
      // Separate from failed-login policy; includes malformed bodies before parsing.
      await limits.bucket('requests', ip, 1200, 60);
      if (request.method === 'POST' && /^\/api\/auth\/login\/?$/i.test(request.path)) {
        await limits.bucket('login-burst', ip, 30, 60);
      }
      next();
    } catch (error) {
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
  app.enableShutdownHooks();
  const server = app.getHttpServer();
  server.headersTimeout = 15_000;
  server.requestTimeout = 65_000;
  await app.init();
  return app;
}
