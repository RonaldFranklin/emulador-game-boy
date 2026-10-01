import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Query, Post, Put, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/session.js';
import { GamesModule } from '../games/games.module.js';
import { PlayService } from './play.service.js';
import { RomResponseInterceptor } from './rom-response.interceptor.js';
import { StatesService, slotNumber } from './states.service.js';
import { SaveJsonInterceptor, StateJsonInterceptor } from './save-json.interceptor.js';

const gameId = new ParseUUIDPipe({ version: '4', exceptionFactory: () => new BadRequestException('Identificador de jogo inválido.') });

@Controller('play')
class PlayController {
  constructor(private readonly play: PlayService, private readonly states: StatesService) {}

  @Get(':id/states')
  slots(@Param('id',gameId) id:string,@Req() req:AuthRequest){return this.states.slots(id,req.identity);}
  @Post(':id/states/:slot/load')
  loadState(@Param('id',gameId) id:string,@Param('slot') slot:string,@Req() req:AuthRequest,@Body() body:unknown){return this.states.read(id,slotNumber(slot),req.identity,body);}
  @UseInterceptors(StateJsonInterceptor)
  @Put(':id/states/:slot')
  saveState(@Param('id',gameId) id:string,@Param('slot') slot:string,@Req() req:AuthRequest,@Body() body:unknown){return this.states.write(id,slotNumber(slot),req.identity,body);}

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

  @Get(':id/lease')
  reservation(@Param('id', gameId) id: string, @Req() request: AuthRequest) { return this.play.reservation(id, request.identity); }

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

@Controller('saves')
class SavesController {
 constructor(private readonly states:StatesService){}
 @Get()
 list(@Req() req:AuthRequest,@Query('admin') admin='',@Query('user') user='',@Query('game') game='',@Query('offset') offset='0'){
  if(!['','true'].includes(admin)||typeof user!=='string'||typeof game!=='string'||!/^\d{1,7}$/.test(offset))throw new BadRequestException('Filtro inválido.');
  return this.states.list(req.identity,admin==='true',user,game,Number(offset));
 }
 @HttpCode(204)
 @Delete(':owner/:id/:kind')
 remove(@Param('owner',gameId) owner:string,@Param('id',gameId) id:string,@Param('kind') kind:string,@Req() req:AuthRequest,@Body() body:unknown){return this.states.delete(owner,id,kind,req.identity,body);}
}

@Module({ imports: [GamesModule], controllers: [PlayController, SavesController], providers: [PlayService, StatesService, RomResponseInterceptor, SaveJsonInterceptor, StateJsonInterceptor] })
export class PlayModule {}
