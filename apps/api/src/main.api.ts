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
  // `err`, not `error`: pino serializes the former and renders the latter as {},
  // so the message and stack of the one error that matters most were lost.
  context.logger.fatal({ err: error }, 'failed to start the http server');
  await context.shutdown();
  process.exit(1);
}
