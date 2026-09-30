import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AppConfig } from '../config.js';
import { publicUser } from '../users/user.js';
import { AllowTemporaryPassword, Public } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { ChangePasswordDto, LoginDto } from './dto.js';
import { clearSessionCookie, CONFIG, setSessionCookie, type AuthRequest } from './session.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() input: LoginDto, @Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    const { token, user, csrfToken } = await this.auth.login(input.username, input.password, request.ip ?? 'unknown');
    setSessionCookie(response, token, this.config);
    return { user, csrfToken };
  }

  @AllowTemporaryPassword()
  @Get('me')
  me(@Req() request: AuthRequest) {
    return { user: publicUser(request.identity.user), csrfToken: request.identity.csrfToken };
  }

  @AllowTemporaryPassword()
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
