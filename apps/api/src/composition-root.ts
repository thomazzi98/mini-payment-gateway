import { loadEnvironment } from './infrastructure/configuration/environment.js';
import type { Environment } from './infrastructure/configuration/environment.js';
import { createLogger } from './infrastructure/logging/logger.js';
import type { Logger } from './infrastructure/logging/logger.js';
import { createDatabase } from './infrastructure/persistence/database.js';
import type { Database } from './infrastructure/persistence/database.js';

export interface ApplicationContext {
  readonly environment: Environment;
  readonly logger: Logger;
  readonly database: Database;
  shutdown(): Promise<void>;
}

/**
 * Everything this process uses is constructed here, explicitly, in dependency order.
 * There is no container and no runtime resolution step, so the wiring is greppable
 * and a missing dependency is a compile error rather than a boot-time surprise.
 */
export function buildApplicationContext(): ApplicationContext {
  const environment = loadEnvironment();
  const logger = createLogger(environment);
  const database = createDatabase(environment);

  return {
    environment,
    logger,
    database,
    async shutdown(): Promise<void> {
      await database.close();
    },
  };
}
