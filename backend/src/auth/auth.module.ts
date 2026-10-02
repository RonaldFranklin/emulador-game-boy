import { AuditService } from '../common/audit.service.js';
import { MfaController } from './mfa.controller.js';
import { MfaService } from './mfa.service.js';
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { SessionService } from './session.service.js';

@Global()
@Module({
  controllers: [AuthController, MfaController],
  providers: [MfaService, AuditService, AuthService, PasswordService, RateLimitService, SessionService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [PasswordService, SessionService, RateLimitService, AuditService],
})
export class AuthModule {}
