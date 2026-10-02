import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AppConfig } from '../config.js';
import { publicUser } from '../users/user.js';
import { AllowTemporaryPassword, MfaFlow, Public } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { ChangePasswordDto, LoginDto } from './dto.js';
import { clearSessionCookie, CONFIG, mfaStatus, setSessionCookie, type AuthRequest } from './session.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() input: LoginDto, @Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    const { token, user, csrfToken, mfa } = await this.auth.login(input.username, input.password, request.ip ?? 'unknown', input.proofToken && input.proofNonce ? {token:input.proofToken,nonce:input.proofNonce} : undefined);
    response.locals.auditActor=user.id;
    setSessionCookie(response, token, this.config,user.role==='MASTER'?1/12:this.config.sessionTtlHours);
    return { user, csrfToken, mfa };
  }

  @AllowTemporaryPassword()
  @MfaFlow()
  @Get('me')
  me(@Req() request: AuthRequest) {
    return { user: publicUser(request.identity.user), csrfToken: request.identity.csrfToken, mfa:mfaStatus(request.identity) };
  }

  @AllowTemporaryPassword()
  @MfaFlow()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(request.identity);
    clearSessionCookie(response, this.config);
  }

  @AllowTemporaryPassword()
  @Post('password')
  @HttpCode(204)
  async password(@Body() input: ChangePasswordDto, @Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    await this.auth.changePassword(request.identity, input.currentPassword, input.newPassword, request.ip ?? 'unknown');
    clearSessionCookie(response, this.config);
  }
}
