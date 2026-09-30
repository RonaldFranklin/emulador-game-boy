import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { csrfMatches, sessionToken, type AuthRequest } from './session.js';
import { SessionService } from './session.service.js';

export const Public = () => SetMetadata('public', true);
export const Master = () => SetMetadata('master', true);
export const AllowTemporaryPassword = () => SetMetadata('allowTemporary', true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = <T>(name: string) => this.reflector.getAllAndOverride<T>(name, [context.getHandler(), context.getClass()]);
    if (metadata<boolean>('public')) return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = sessionToken(request);
    if (!token) throw new UnauthorizedException('Entre para continuar.');
    request.identity = await this.sessions.find(token);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !csrfMatches(request.headers['x-csrf-token'], request.identity.csrfToken)) {
      throw new ForbiddenException('Token de segurança inválido. Recarregue a página.');
    }
    if (request.identity.user.must_change_password && !metadata<boolean>('allowTemporary')) {
      throw new ForbiddenException('Troque sua senha temporária para continuar.');
    }
    if (metadata<boolean>('master') && request.identity.user.role !== 'MASTER') throw new ForbiddenException('Acesso permitido somente ao master.');
    return true;
  }
}
