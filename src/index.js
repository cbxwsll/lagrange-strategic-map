import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });

const { loadConfig } = await import('./config.js');
const { openDatabase } = await import('./db/index.js');
const { buildApp } = await import('./app.js');
const { setupWebSocket } = await import('./ws.js');

const config = loadConfig();
const db = openDatabase(config);
const app = buildApp({ config, db });
const server = http.createServer(app);
const wss = setupWebSocket(server, db, config);

server.listen(config.port, config.host, () => {
  console.log(`lagrange-strategic-map listening on ${config.host}:${config.port}`);
});

function shutdown() {
  wss.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
