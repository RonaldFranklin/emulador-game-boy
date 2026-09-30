import { BadRequestException, CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor, PayloadTooLargeException, RequestTimeoutException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { Response } from 'express';
import multer, { type StorageEngine } from 'multer';
import { finalize, type Observable } from 'rxjs';
import type { AuthRequest } from '../auth/session.js';
import { MAX_COVER_BYTES, MAX_MULTIPART_BYTES, MAX_ROM_BYTES } from './catalog-constants.js';

export interface CatalogRequest extends AuthRequest {
  files: { rom?: Express.Multer.File[]; cover?: Express.Multer.File[] };
}

const boundedMemory: StorageEngine = {
  _handleFile(_request, file, callback) {
    const limit = file.fieldname === 'cover' ? MAX_COVER_BYTES : MAX_ROM_BYTES;
    let chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const done = (error?: Error, info?: Partial<Express.Multer.File>) => {
      if (finished) return;
      finished = true;
      if (error) chunks = [];
      callback(error, info);
    };
    file.stream.on('data', (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) {
        chunks = [];
        done(new PayloadTooLargeException(file.fieldname === 'cover' ? 'A capa deve ter no máximo 2 MiB.' : 'A ROM deve ter no máximo 8 MiB para GB ou 32 MiB para GBA.'));
      } else { chunks.push(chunk); }
    });
    file.stream.once('error', done);
    file.stream.once('end', () => {
      if (finished) return;
      const buffer = Buffer.concat(chunks);
      chunks = [];
      done(undefined, { size, buffer });
    });
  },
  _removeFile(_request, file, callback) { file.buffer = Buffer.alloc(0); callback(null); },
};

/** Global auth/role/CSRF guards run before this route-scoped multipart parser. */
@Injectable()
export class CatalogUploadInterceptor implements NestInterceptor {
  private active = 0;

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<CatalogRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    if (!request.is('multipart/form-data')) throw new UnsupportedMediaTypeException('Envie os campos e arquivos como multipart/form-data.');
    if (this.active >= 2) throw new HttpException('Já existem dois envios de catálogo em andamento. Tente novamente.', HttpStatus.TOO_MANY_REQUESTS);
    const declaredLength = Number(request.headers['content-length'] ?? 0);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_MULTIPART_BYTES) {
      throw new PayloadTooLargeException('O envio ultrapassa o limite permitido.');
    }
    this.active += 1;
    try {
      const files = request.method === 'POST' ? [{ name: 'rom', maxCount: 1 }, { name: 'cover', maxCount: 1 }] : [{ name: 'cover', maxCount: 1 }];
      const parse = multer({
        storage: boundedMemory,
        limits: { fileSize: MAX_ROM_BYTES, files: files.length, fields: 3, parts: 5, fieldSize: 512, fieldNameSize: 32, headerPairs: 40, fieldNestingDepth: 0 },
        fileFilter: (_request, file, callback) => {
          if (file.originalname.length > 200) return callback(new BadRequestException('Nome de arquivo muito longo.'));
          callback(null, true);
        },
      }).fields(files);
      await new Promise<void>((resolve, reject) => {
        let bytes = 0;
        let settled = false;
        const timer = setTimeout(() => {
          finish(new RequestTimeoutException('O envio excedeu 60 segundos.'));
          request.destroy();
        }, 60_000);
        timer.unref();
        const onData = (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_MULTIPART_BYTES) {
            finish(new PayloadTooLargeException('O envio ultrapassa o limite permitido.'));
            request.destroy();
          }
        };
        const onAbort = () => finish(new BadRequestException('O envio foi interrompido.'));
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.off('data', onData);
          request.off('aborted', onAbort);
          request.off('error', onAbort);
          if (!error) { resolve(); return; }
          if (error instanceof HttpException) { reject(error); return; }
          if (error instanceof multer.MulterError && ['LIMIT_FILE_SIZE', 'LIMIT_FIELD_VALUE', 'LIMIT_PART_COUNT', 'LIMIT_FILE_COUNT', 'LIMIT_FIELD_COUNT'].includes(error.code)) {
            reject(new PayloadTooLargeException('O envio excede os limites de arquivos ou campos.'));
            return;
          }
          reject(new BadRequestException('Formulário de upload inválido ou com campos de arquivo inesperados.'));
        };
        request.on('data', onData);
        request.once('aborted', onAbort);
        request.once('error', onAbort);
        try { parse(request, response, finish); } catch (error) { finish(error); }
      });
      return next.handle().pipe(finalize(() => { this.active -= 1; }));
    } catch (error) {
      this.active -= 1;
      throw error;
    }
  }
}
