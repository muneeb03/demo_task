// Express wiring. Order matters: routes, then the 404 catch-all, then the error handler.
// Exports a ready-made app so the tests can drive it in-process without binding a port.
import { join } from 'node:path';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { authRouter } from './authRoutes';
import { ApiError } from './errors';
import { router } from './routes';

// Resolves to <repo>/public from both src/ (ts-node) and dist/ (compiled), the same way
// migrate.ts finds the schema.
const PUBLIC_DIR = join(__dirname, '..', 'public');

const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Cannot ${req.method} ${req.path}.` },
  });
};

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      },
    });
    return;
  }

  // Thrown by express.json() on a malformed body.
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' },
    });
    return;
  }

  console.error('[api] unhandled error', err);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
  });
};

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(router);
  app.use(authRouter);
  // Last, so a static file can never shadow an API route. index.html is served at /.
  app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
