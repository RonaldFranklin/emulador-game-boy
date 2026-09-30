import { IsBoolean, IsString, Length } from 'class-validator';
import { UsernameDto } from '../auth/dto.js';

export class CreateUserDto extends UsernameDto {
  @IsString()
  @Length(12, 128, { message: 'A senha deve ter entre 12 e 128 caracteres.' })
  password!: string;
}

export class SetStatusDto {
  @IsBoolean({ message: 'blocked deve ser verdadeiro ou falso.' })
  blocked!: boolean;
}

export class ResetPasswordDto {
  @IsString()
  @Length(12, 128, { message: 'A senha deve ter entre 12 e 128 caracteres.' })
  password!: string;
}
