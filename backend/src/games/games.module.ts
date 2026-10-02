import { BadRequestException, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { Master } from '../auth/auth.guard.js';
import type { AuthRequest } from '../auth/session.js';
import { CatalogStorageService } from './catalog-storage.service.js';
import { CatalogUploadInterceptor, type CatalogRequest } from './catalog-upload.interceptor.js';
import { GamesService } from './games.service.js';

const gameId = new ParseUUIDPipe({ version: '4', exceptionFactory: () => new BadRequestException('Identificador de jogo inválido.') });

@Controller('games')
class GamesController {
  constructor(private readonly games: GamesService) {}

  @Get()
  list(@Req() request: AuthRequest) { return this.games.list(request.identity); }

  @Master()
  @UseInterceptors(CatalogUploadInterceptor)
  @Post()
  async create(@Req() request: CatalogRequest, @Res({passthrough:true}) response:Response) { const result=await this.games.create(request);response.locals.auditTarget=result.game.id;return result; }

  @Master()
  @UseInterceptors(CatalogUploadInterceptor)
  @Patch(':id')
  update(@Param('id', gameId) id: string, @Req() request: CatalogRequest) { return this.games.update(id, request); }

  @Get(':id/cover')
  async cover(@Param('id', gameId) id: string, @Req() request: AuthRequest, @Res() response: Response) {
    const buffer = await this.games.cover(id, request.identity);
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Content-Disposition', 'inline');
    response.send(buffer);
  }
}

@Module({ controllers: [GamesController], providers: [GamesService, CatalogStorageService, CatalogUploadInterceptor], exports: [CatalogStorageService] })
export class GamesModule {}
