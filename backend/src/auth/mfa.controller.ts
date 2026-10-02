import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';
import type { Response } from 'express';
import type { AppConfig } from '../config.js';
import { Master, MfaFlow } from './auth.guard.js';
import { CONFIG, setSessionCookie, type AuthRequest } from './session.js';
import { MfaService } from './mfa.service.js';
class PasswordDto { @IsString() @Length(1,128) password!:string; }
class CodeDto { @IsString() @Matches(/^(?:\d{6}|[a-zA-Z0-9_-]{24})$/) code!:string; }
class ReauthDto extends PasswordDto { @IsString() @Matches(/^(?:\d{6}|[a-zA-Z0-9_-]{24})$/) code!:string; }
@Master()
@MfaFlow()
@Controller('auth/mfa')
export class MfaController {
 constructor(private readonly mfa:MfaService,@Inject(CONFIG)private readonly config:AppConfig){}
 @Post('enroll') @HttpCode(200)
 enroll(@Req() req:AuthRequest,@Body() body:PasswordDto){return this.mfa.enroll(req.identity,body.password);}
 @Post('replace') @HttpCode(200)
 replace(@Req() req:AuthRequest,@Body() body:ReauthDto){return this.mfa.replace(req.identity,body.password,body.code);}
 @Post('confirm') @HttpCode(200)
 async confirm(@Req() req:AuthRequest,@Body() body:CodeDto,@Res({passthrough:true}) res:Response){return this.respond(res,await this.mfa.confirm(req.identity,body.code));}
 @Post('verify') @HttpCode(200)
 async verify(@Req() req:AuthRequest,@Body() body:CodeDto,@Res({passthrough:true}) res:Response){return this.respond(res,await this.mfa.authenticate(req.identity,body.code));}
 @Post('reauth') @HttpCode(200)
 async reauth(@Req() req:AuthRequest,@Body() body:ReauthDto,@Res({passthrough:true}) res:Response){return this.respond(res,await this.mfa.authenticate(req.identity,body.code,body.password));}
 private respond(res:Response,result:{token:string;user:unknown;csrfToken:string;mfa:string;recoveryCodes?:string[]}){const {token,...body}=result;setSessionCookie(res,token,this.config,this.config.masterTtlHours);return body;}
}
