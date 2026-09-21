import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './env.js';
import { admin } from './supabase.js';
import { errorHandler, notFound } from './middleware/error.js';
import { authenticate } from './middleware/auth.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { startPushWorker, stopPushWorker } from './services/push.js';
import { meRouter } from './routes/me.routes.js';
import { contactsRouter } from './routes/contacts.routes.js';
import { emergenciesRouter } from './routes/emergencies.routes.js';
import { policeRouter } from './routes/police.routes.js';
import { adminRouter } from './routes/admin.routes.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.length ? env.corsOrigins : true,
      credentials: false,
    }),
  );
  app.use(express.json({ limit: '256kb' }));

  // Trust one proxy hop so express-rate-limit sees the real client address when
  // deployed behind Render/Fly/Nginx. More hops than that and the header is
  // forgeable, so this is deliberately not `true`.
  app.set('trust proxy', 1);

  app.get('/health', async (_req, res) => {
    const { error } = await admin.from('system_config').select('key').limit(1);
    res.status(error ? 503 : 200).json({
      status: error ? 'degraded' : 'ok',
      database: error ? 'unreachable' : 'ok',
      time: new Date().toISOString(),
    });
  });

  // The blanket limiter is keyed on the caller, so it runs after authenticate.
  app.use('/api/v1', authenticate, generalLimiter);

  app.use('/api/v1/me', meRouter);
  app.use('/api/v1/contacts', contactsRouter);
  app.use('/api/v1/emergencies', emergenciesRouter);
  app.use('/api/v1/police', policeRouter);
  app.use('/api/v1/admin', adminRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`Sakhi API listening on :${env.PORT} (${env.NODE_ENV})`);
    console.log(`Supabase project: ${env.SUPABASE_URL}`);
  });

  startPushWorker();

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down.`);
    stopPushWorker();
    server.close(() => process.exit(0));
    // Don't let a hung connection keep an emergency service "up" forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
