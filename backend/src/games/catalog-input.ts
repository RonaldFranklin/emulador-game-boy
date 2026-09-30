import { BadRequestException } from '@nestjs/common';

export interface CatalogInput { name?: string; active?: boolean; removeCover: boolean; }

export function catalogInput(body: unknown, create: boolean): CatalogInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Formulário inválido.');
  const fields = body as Record<string, unknown>;
  const allowed = create ? ['name', 'active'] : ['name', 'active', 'removeCover'];
  if (Object.keys(fields).some((key) => !allowed.includes(key))) throw new BadRequestException('O formulário contém campos não permitidos.');
  let name: string | undefined;
  if ('name' in fields) {
    if (typeof fields.name !== 'string') throw new BadRequestException('Nome do jogo inválido.');
    name = fields.name.trim();
    if (!name || Array.from(name).length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
      throw new BadRequestException('O nome deve ter de 1 a 120 caracteres, sem caracteres de controle.');
    }
  }
  let active: boolean | undefined;
  if ('active' in fields) {
    if (fields.active !== 'true' && fields.active !== 'false') throw new BadRequestException('Informe active como true ou false.');
    active = fields.active === 'true';
  }
  if (create && (name === undefined || active === undefined)) throw new BadRequestException('Informe o nome e a disponibilidade do jogo.');
  if ('removeCover' in fields && fields.removeCover !== 'true') throw new BadRequestException('Informe removeCover somente como true.');
  return { name, active, removeCover: fields.removeCover === 'true' };
}
