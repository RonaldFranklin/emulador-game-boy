import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { Master } from '../auth/auth.guard.js';
import type { AuthRequest } from '../auth/session.js';
import { CreateUserDto, ResetPasswordDto, SetStatusDto } from './dto.js';
import { UsersService } from './users.service.js';

@Master()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Req() request: AuthRequest) { return this.users.list(request.identity); }

  @Post()
  create(@Body() input: CreateUserDto, @Req() request: AuthRequest) {
    return this.users.create(request.identity, input.username, input.password);
  }

  @Patch(':id/status')
  status(@Param('id', new ParseUUIDPipe({ version: '4', exceptionFactory: () => new BadRequestException('Identificador de usuário inválido.') })) id: string, @Body() input: SetStatusDto, @Req() request: AuthRequest) {
    return this.users.status(request.identity, id, input.blocked);
  }

  @Post(':id/reset-password')
  @HttpCode(204)
  resetPassword(@Param('id', new ParseUUIDPipe({ version: '4', exceptionFactory: () => new BadRequestException('Identificador de usuário inválido.') })) id: string, @Body() input: ResetPasswordDto, @Req() request: AuthRequest) {
    return this.users.resetPassword(request.identity, id, input.password);
  }
}
