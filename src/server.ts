import { app } from './app';
import { pool } from './db';
import { migrate } from './migrate';

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // Creates the tables if they are not there yet, so a fresh database just works.
  await migrate();

  const server = app.listen(PORT, () => {
    console.log(`ledger api listening on http://localhost:${PORT}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[api] failed to start', err);
  process.exit(1);
});
