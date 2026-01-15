import express from 'express';
import { initTRPC } from '@trpc/server';
import * as trpcExpress from '@trpc/server/adapters/express';
import { createLogger, attachMetadata, attachTrpcMetadata } from '../src/logger';

// ============================================================================
// Create the logger (single instance for both Express and tRPC)
// ============================================================================

const logger = createLogger('./logs/app.log', {
  maxSizeBytes: 10 * 1024 * 1024, // 10MB, then truncate to 25%
  redact: ['password', 'token', 'secret', 'authorization'],
});

// ============================================================================
// Express Setup
// ============================================================================

const app = express();
app.use(express.json());

// Add logging middleware - that's it!
app.use(logger.express());

// Regular endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Endpoint with metadata
app.get('/api/users/:id', (req, res) => {
  // Attach arbitrary metadata to the log entry
  attachMetadata(req, {
    userId: req.params.id,
    source: 'user-service',
    cacheHit: false,
  });

  res.json({ id: req.params.id, name: 'John Doe' });
});

// POST endpoint with metadata
app.post('/api/orders', (req, res) => {
  const orderId = Math.random().toString(36).slice(2);

  // Attach order-specific metadata
  attachMetadata(req, {
    orderId,
    itemCount: req.body.items?.length ?? 0,
    totalAmount: req.body.total,
    region: 'us-east-1',
  });

  res.json({ orderId, status: 'created' });
});

// SSE streaming endpoint with metadata
app.get('/api/stream', (req, res) => {
  // Attach metadata before streaming starts
  attachMetadata(req, {
    streamType: 'events',
    clientId: req.query.clientId || 'anonymous',
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let count = 0;
  const interval = setInterval(() => {
    count++;
    res.write(`data: ${JSON.stringify({ count, message: `Event ${count}` })}\n\n`);

    if (count >= 5) {
      res.write('data: [DONE]\n\n');
      clearInterval(interval);
      res.end();
    }
  }, 100);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// ============================================================================
// tRPC Setup
// ============================================================================

// Define context type with logMetadata
interface Context {
  logMetadata?: Record<string, unknown>;
}

const t = initTRPC.context<Context>().create();

// Create a logged procedure using the same logger
const loggedProcedure = t.procedure.use(logger.trpc<Context>());

const appRouter = t.router({
  hello: loggedProcedure
    .input((val: unknown) => val as { name: string })
    .query(({ input, ctx }) => {
      // Attach metadata in tRPC
      attachTrpcMetadata(ctx, {
        greeted: input.name,
        locale: 'en-US',
      });

      return { greeting: `Hello, ${input.name}!` };
    }),

  createUser: loggedProcedure
    .input((val: unknown) => val as { email: string; password: string })
    .mutation(({ input, ctx }) => {
      const userId = Math.random().toString(36).slice(2);

      // Attach user creation metadata
      attachTrpcMetadata(ctx, {
        newUserId: userId,
        emailDomain: input.email.split('@')[1],
        signupSource: 'api',
      });

      return { id: userId, email: input.email, created: true };
    }),

  processOrder: loggedProcedure
    .input((val: unknown) => val as { items: string[]; priority: boolean })
    .mutation(({ input, ctx }) => {
      // Attach processing metadata
      attachTrpcMetadata(ctx, {
        itemCount: input.items.length,
        priority: input.priority,
        processingQueue: input.priority ? 'high' : 'normal',
      });

      return { processed: true, items: input.items.length };
    }),
});

// Mount tRPC
app.use(
  '/trpc',
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext: (): Context => ({ logMetadata: {} }),
  })
);

// ============================================================================
// Start Server
// ============================================================================

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Logs written to: ./logs/app.log`);
});

export type AppRouter = typeof appRouter;
