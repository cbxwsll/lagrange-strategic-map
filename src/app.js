import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { optionalAuth } from './lib/auth.js';
import { optionalMemberAuth } from './lib/member-auth.js';
import { betaGate, createBetaRouter } from './lib/beta.js';
import { errorMiddleware } from './lib/errors.js';
import { createMailer } from './lib/mailer.js';
import { createAuthRouter } from './routes/auth.js';
import { createClientRouter } from './routes/client.js';
import { createDisplayRouter } from './routes/display.js';
import { createJoinRouter } from './routes/join.js';
import { createMapsRouter } from './routes/maps.js';
import { createPermissionsRouter } from './routes/permissions.js';

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function buildApp({ config, db, mailer }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.locals.config = config;
  app.locals.db = db;
  app.use(helmet());
  app.use(express.json({ limit: '2mb', strict: true }));
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      console.log(JSON.stringify({ time: new Date().toISOString(), method: req.method, path: req.path,
        status: res.statusCode, durationMs: Date.now() - started }));
    });
    next();
  });
  app.use(optionalAuth);
  app.use(optionalMemberAuth);
  app.use(betaGate(config));

  app.get('/healthz', (req, res) => {
    req.app.locals.db.prepare('SELECT 1').get();
    res.json({ ok: true, service: 'lagrange-strategic-map', protocolVersion: 1 });
  });
  app.use('/api/v1/beta/enter', createBetaRouter(config));
  app.use('/api/v1/auth', createAuthRouter(config, mailer || createMailer(config)));
  app.use('/api/v1/client', createClientRouter());
  app.use('/api/v1/maps', createJoinRouter(config));
  app.use('/api/v1/maps', createDisplayRouter());
  app.use('/api/v1/maps', createMapsRouter(config));
  app.use('/api/v1/maps', createPermissionsRouter());
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API 路径不存在' } }));

  app.get('/favicon.ico', (req, res) => res.status(204).end());
  const pages = { '/auth': 'auth.html', '/create': 'create.html', '/map': 'map.html', '/settings': 'settings.html' };
  for (const [route, file] of Object.entries(pages)) {
    app.get(route, (req, res) => res.sendFile(path.join(publicDirectory, file)));
  }
  app.use(express.static(publicDirectory, {
    index: 'index.html',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));
  app.use(errorMiddleware);
  return app;
}
