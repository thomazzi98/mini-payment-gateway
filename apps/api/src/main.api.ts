import { buildApplicationContext } from './composition-root.js';
import { createServer } from './interface/http/create-server.js';

const context = buildApplicationContext();
const server = createServer(context);

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

for (const signal of SHUTDOWN_SIGNALS) {
  process.once(signal, () => {
    context.logger.info({ signal }, 'shutting down');
    void (async () => {
      await server.close();
      await context.shutdown();
      process.exit(0);
    })();
  });
}

try {
  await server.listen({
    host: context.environment.HTTP_HOST,
    port: context.environment.HTTP_PORT,
  });
} catch (error) {
  context.logger.fatal({ error }, 'failed to start the http server');
  await context.shutdown();
  process.exit(1);
}
