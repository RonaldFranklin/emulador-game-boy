import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/auth.guard.js';
import { DatabaseService } from '../database/database.service.js';

@Controller('health')
class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Public()
  @Get()
  async health() {
    try {
      await this.database.pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Banco indisponível ou migrações pendentes.');
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
