import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/session.js';
import { GamesModule } from '../games/games.module.js';
import { PlayService } from './play.service.js';
import { RomResponseInterceptor } from './rom-response.interceptor.js';
import { SaveJsonInterceptor } from './save-json.interceptor.js';

const gameId = new ParseUUIDPipe({ version: '4', exceptionFactory: () => new BadRequestException('Identificador de jogo inválido.') });

@Controller('play')
class PlayController {
  constructor(private readonly play: PlayService) {}

  @Get(':id')
  manifest(@Param('id', gameId) id: string, @Req() request: AuthRequest) { return this.play.manifest(id, request.identity); }

  @UseInterceptors(RomResponseInterceptor)
  @Get(':id/rom')
  async rom(@Param('id', gameId) id: string, @Req() request: AuthRequest, @Res() response: Response) {
    const bytes = await this.play.rom(id, request.identity);
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Disposition', 'inline');
    response.setHeader('Cache-Control', 'no-store');
    response.send(bytes);
  }

  @Post(':id/lease')
  acquire(@Param('id', gameId) id: string, @Req() request: AuthRequest, @Body() body: unknown) {
    return this.play.acquire(id, request.identity, body);
  }

  @HttpCode(200)
  @Post(':id/lease/renew')
  renew(@Param('id', gameId) id: string, @Req() request: AuthRequest, @Body() body: unknown) {
    return this.play.renew(id, request.identity, body);
  }

  @HttpCode(204)
  @Delete(':id/lease')
  release(@Param('id', gameId) id: string, @Req() request: AuthRequest, @Body() body: unknown) {
    return this.play.release(id, request.identity, body);
  }

  @UseInterceptors(SaveJsonInterceptor)
  @Put(':id/save')
  save(@Param('id', gameId) id: string, @Req() request: AuthRequest, @Body() body: unknown) {
    return this.play.save(id, request.identity, body);
  }
}

@Module({ imports: [GamesModule], controllers: [PlayController], providers: [PlayService, RomResponseInterceptor, SaveJsonInterceptor] })
export class PlayModule {}
