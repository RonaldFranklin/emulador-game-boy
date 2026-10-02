import { IsString, IsOptional, Length, Matches } from 'class-validator';

export class UsernameDto {
  @IsString()
  @Matches(/^[a-z0-9_]{3,32}$/, { message: 'Use um nome com 3 a 32 letras minúsculas, números ou sublinhado.' })
  username!: string;
}

export class LoginDto extends UsernameDto {
  @IsString()
  @Length(1, 128, { message: 'Informe uma senha de até 128 caracteres.' })
  password!: string;

  @IsOptional() @IsString() @Matches(/^[a-zA-Z0-9_-]{43}$/)
  proofToken?: string;

  @IsOptional() @IsString() @Matches(/^\d{1,10}$/)
  proofNonce?: string;
}

export class ChangePasswordDto {
  @IsString()
  @Length(1, 128, { message: 'Informe a senha atual de até 128 caracteres.' })
  currentPassword!: string;

  @IsString()
  @Length(12, 128, { message: 'A nova senha deve ter entre 12 e 128 caracteres.' })
  newPassword!: string;
}
