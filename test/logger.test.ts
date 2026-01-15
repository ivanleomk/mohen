import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger, attachMetadata, attachTrpcMetadata } from '../src/logger';
import { initTRPC } from '@trpc/server';
import * as trpcExpress from '@trpc/server/adapters/express';

const TEST_LOG_FILE = path.join(__dirname, 'test.log');

// Mock date for deterministic timestamp
const MOCK_DATE = new Date('2024-01-15T10:30:00.000Z');

// Helper to read log entries
function readLogEntries(): any[] {
  if (!fs.existsSync(TEST_LOG_FILE)) return [];
  const content = fs.readFileSync(TEST_LOG_FILE, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map((line) => JSON.parse(line));
}

// Helper to clear log file
function clearLogFile(): void {
  if (fs.existsSync(TEST_LOG_FILE)) {
    fs.unlinkSync(TEST_LOG_FILE);
  }
}

describe('mohen logger', () => {
  let app: Express;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    clearLogFile();
    
    // Mock Date for deterministic timestamp
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_DATE);
    
    logger = createLogger(TEST_LOG_FILE, {
      redact: ['password', 'token', 'secret'],
    });
    app = express();
    app.use(express.json());
    app.use(logger.express());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearLogFile();
  });

  describe('Express - Normal Requests', () => {
    it('should log GET requests with correct fields', async () => {
      app.get('/api/test', (req, res) => {
        res.json({ message: 'hello', value: 42 });
      });

      await request(app).get('/api/test').expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'http',
        method: 'GET',
        path: '/api/test',
        statusCode: 200,
        duration: 0,
        request: {
          body: {},
          query: {},
        },
        response: {
          body: { message: 'hello', value: 42 },
          streaming: false,
        },
      });
      expect(entries[0].requestId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    });

    it('should log POST requests with request body', async () => {
      app.post('/api/users', (req, res) => {
        res.json({ id: 1, name: req.body.name });
      });

      await request(app)
        .post('/api/users')
        .send({ name: 'John', email: 'john@example.com' })
        .expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'http',
        method: 'POST',
        path: '/api/users',
        statusCode: 200,
        duration: 0,
        request: {
          body: { name: 'John', email: 'john@example.com' },
          query: {},
        },
        response: {
          body: { id: 1, name: 'John' },
          streaming: false,
        },
      });
    });

    it('should redact sensitive fields', async () => {
      app.post('/api/login', (req, res) => {
        res.json({ success: true, token: 'abc123' });
      });

      await request(app)
        .post('/api/login')
        .send({ username: 'john', password: 'secret123' })
        .expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'http',
        method: 'POST',
        path: '/api/login',
        statusCode: 200,
        request: {
          body: { username: 'john', password: '[REDACTED]' },
        },
        response: {
          body: { success: true, token: '[REDACTED]' },
        },
      });
    });

    it('should log query parameters', async () => {
      app.get('/api/search', (req, res) => {
        res.json({ query: req.query.q });
      });

      await request(app).get('/api/search?q=hello&limit=10').expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'http',
        method: 'GET',
        path: '/api/search?q=hello&limit=10',
        statusCode: 200,
        request: {
          query: { q: 'hello', limit: '10' },
        },
        response: {
          body: { query: 'hello' },
        },
      });
    });
  });

  describe('Express - SSE Streaming', () => {
    it('should aggregate SSE chunks into single log entry', async () => {
      app.get('/api/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        res.write(`data: ${JSON.stringify({ count: 1 })}\n\n`);
        res.write(`data: ${JSON.stringify({ count: 2 })}\n\n`);
        res.write(`data: ${JSON.stringify({ count: 3 })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      await request(app)
        .get('/api/stream')
        .set('Accept', 'text/event-stream')
        .expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'http',
        method: 'GET',
        path: '/api/stream',
        statusCode: 200,
        response: {
          streaming: true,
          chunks: [
            { count: 1 },
            { count: 2 },
            { count: 3 },
            { type: 'done' },
          ],
        },
      });
    });

    it('should handle SSE with metadata', async () => {
      app.get('/api/stream-with-meta', (req, res) => {
        attachMetadata(req, { streamId: 'abc123', userId: '42' });

        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ msg: 'hello' })}\n\n`);
        res.end();
      });

      await request(app)
        .get('/api/stream-with-meta')
        .set('Accept', 'text/event-stream')
        .expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'http',
        method: 'GET',
        path: '/api/stream-with-meta',
        statusCode: 200,
        response: {
          streaming: true,
          chunks: [{ msg: 'hello' }],
        },
        metadata: { streamId: 'abc123', userId: '42' },
      });
    });
  });

  describe('Express - attachMetadata', () => {
    it('should attach custom metadata to log entry', async () => {
      app.get('/api/users/:id', (req, res) => {
        attachMetadata(req, {
          userId: req.params.id,
          source: 'user-service',
          cacheHit: false,
        });
        res.json({ id: req.params.id, name: 'John' });
      });

      await request(app).get('/api/users/123').expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'http',
        method: 'GET',
        path: '/api/users/123',
        statusCode: 200,
        response: {
          body: { id: '123', name: 'John' },
          streaming: false,
        },
        metadata: {
          userId: '123',
          source: 'user-service',
          cacheHit: false,
        },
      });
    });

    it('should merge multiple metadata calls', async () => {
      app.get('/api/order', (req, res) => {
        attachMetadata(req, { orderId: 'order-1' });
        attachMetadata(req, { region: 'us-east-1' });
        attachMetadata(req, { priority: true });
        res.json({ success: true });
      });

      await request(app).get('/api/order').expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'http',
        method: 'GET',
        path: '/api/order',
        statusCode: 200,
        response: {
          body: { success: true },
        },
        metadata: {
          orderId: 'order-1',
          region: 'us-east-1',
          priority: true,
        },
      });
    });

    it('should not include metadata field if none attached', async () => {
      app.get('/api/simple', (req, res) => {
        res.json({ ok: true });
      });

      await request(app).get('/api/simple').expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata).toBeUndefined();
      expect(entries[0]).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'http',
        method: 'GET',
        path: '/api/simple',
        statusCode: 200,
        response: {
          body: { ok: true },
        },
      });
    });
  });

  describe('tRPC - Normal Procedures', () => {
    it('should log tRPC query', async () => {
      interface Context {
        logMetadata?: Record<string, unknown>;
      }

      const t = initTRPC.context<Context>().create();
      const loggedProcedure = t.procedure.use(logger.trpc<Context>());

      const appRouter = t.router({
        hello: loggedProcedure
          .input((val: unknown) => val as { name: string })
          .query(({ input }) => {
            return { greeting: `Hello, ${input.name}!` };
          }),
      });

      app.use(
        '/trpc',
        trpcExpress.createExpressMiddleware({
          router: appRouter,
          createContext: (): Context => ({ logMetadata: {} }),
        })
      );

      await request(app)
        .get('/trpc/hello?input=%7B%22name%22%3A%22World%22%7D')
        .expect(200);

      const entries = readLogEntries();
      // Find the tRPC entry (there will also be an Express entry)
      const trpcEntry = entries.find((e) => e.type === 'trpc');
      expect(trpcEntry).toBeDefined();
      expect(trpcEntry).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'trpc',
        method: 'QUERY',
        path: 'hello',
        statusCode: 200,
        duration: 0,
        response: {
          body: { greeting: 'Hello, World!' },
          streaming: false,
        },
      });
      expect(trpcEntry.requestId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    });

    it('should log tRPC mutation', async () => {
      interface Context {
        logMetadata?: Record<string, unknown>;
      }

      const t = initTRPC.context<Context>().create();
      const loggedProcedure = t.procedure.use(logger.trpc<Context>());

      const appRouter = t.router({
        createUser: loggedProcedure
          .input((val: unknown) => val as { email: string })
          .mutation(({ input }) => {
            return { id: 'user-1', email: input.email };
          }),
      });

      app.use(
        '/trpc',
        trpcExpress.createExpressMiddleware({
          router: appRouter,
          createContext: (): Context => ({ logMetadata: {} }),
        })
      );

      await request(app)
        .post('/trpc/createUser')
        .send({ email: 'test@example.com' })
        .expect(200);

      const entries = readLogEntries();
      const trpcEntry = entries.find((e) => e.type === 'trpc');
      expect(trpcEntry).toBeDefined();
      expect(trpcEntry).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'trpc',
        method: 'MUTATION',
        path: 'createUser',
        statusCode: 200,
        response: {
          body: { id: 'user-1', email: 'test@example.com' },
          streaming: false,
        },
      });
    });
  });

  describe('tRPC - attachTrpcMetadata', () => {
    it('should attach custom metadata to tRPC log entry', async () => {
      interface Context {
        logMetadata?: Record<string, unknown>;
      }

      const t = initTRPC.context<Context>().create();
      const loggedProcedure = t.procedure.use(logger.trpc<Context>());

      const appRouter = t.router({
        getUser: loggedProcedure
          .input((val: unknown) => val as { id: string })
          .query(({ input, ctx }) => {
            attachTrpcMetadata(ctx, {
              userId: input.id,
              source: 'user-service',
              cached: true,
            });
            return { id: input.id, name: 'John' };
          }),
      });

      app.use(
        '/trpc',
        trpcExpress.createExpressMiddleware({
          router: appRouter,
          createContext: (): Context => ({ logMetadata: {} }),
        })
      );

      await request(app)
        .get('/trpc/getUser?input=%7B%22id%22%3A%22user-123%22%7D')
        .expect(200);

      const entries = readLogEntries();
      const trpcEntry = entries.find((e) => e.type === 'trpc');
      expect(trpcEntry).toBeDefined();
      expect(trpcEntry).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'trpc',
        method: 'QUERY',
        path: 'getUser',
        statusCode: 200,
        response: {
          body: { id: 'user-123', name: 'John' },
          streaming: false,
        },
        metadata: {
          userId: 'user-123',
          source: 'user-service',
          cached: true,
        },
      });
    });
  });

  describe('Path Filtering', () => {
    it('should ignore paths matching ignorePaths patterns', async () => {
      vi.useRealTimers();
      clearLogFile();
      
      const filteredLogger = createLogger(TEST_LOG_FILE, {
        ignorePaths: ['/health', '/health/*', '/metrics'],
      });

      const filteredApp = express();
      filteredApp.use(express.json());
      filteredApp.use(filteredLogger.express());
      filteredApp.get('/health', (req, res) => res.json({ status: 'ok' }));
      filteredApp.get('/health/live', (req, res) => res.json({ live: true }));
      filteredApp.get('/metrics', (req, res) => res.json({ cpu: 50 }));
      filteredApp.get('/api/users', (req, res) => res.json({ users: [] }));

      await request(filteredApp).get('/health').expect(200);
      await request(filteredApp).get('/health/live').expect(200);
      await request(filteredApp).get('/metrics').expect(200);
      await request(filteredApp).get('/api/users').expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe('/api/users');
    });

    it('should only log paths matching includePaths patterns', async () => {
      vi.useRealTimers();
      clearLogFile();
      
      const filteredLogger = createLogger(TEST_LOG_FILE, {
        includePaths: ['/api/*'],
      });

      const filteredApp = express();
      filteredApp.use(express.json());
      filteredApp.use(filteredLogger.express());
      filteredApp.get('/health', (req, res) => res.json({ status: 'ok' }));
      filteredApp.get('/api/users', (req, res) => res.json({ users: [] }));
      filteredApp.get('/api/orders', (req, res) => res.json({ orders: [] }));

      await request(filteredApp).get('/health').expect(200);
      await request(filteredApp).get('/api/users').expect(200);
      await request(filteredApp).get('/api/orders').expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].path).toBe('/api/users');
      expect(entries[1].path).toBe('/api/orders');
    });
  });

  describe('AI SDK Style Streaming', () => {
    it('should detect SSE via writeHead (AI SDK pipeUIMessageStreamToResponse)', async () => {
      app.get('/api/ai-stream', (req, res) => {
        // AI SDK uses writeHead instead of setHeader
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        res.write('data: {"type":"start"}\n\n');
        res.write('data: {"type":"text-delta","delta":"Hello"}\n\n');
        res.write('data: {"type":"finish"}\n\n');
        res.end();
      });

      await request(app)
        .get('/api/ai-stream')
        .expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: 'http',
        method: 'GET',
        path: '/api/ai-stream',
        response: {
          streaming: true,
          text: 'Hello',
        },
      });
      expect(entries[0].response.chunks).toContainEqual({ type: 'start' });
    });

    it('should handle Uint8Array chunks from TextEncoderStream', async () => {
      app.get('/api/binary-stream', (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
        });

        // Simulate TextEncoderStream output (Uint8Array)
        const encoder = new TextEncoder();
        res.write(encoder.encode('data: {"type":"start"}\n\n'));
        res.write(encoder.encode('data: {"type":"text-delta","delta":"Binary"}\n\n'));
        res.write(encoder.encode('data: {"type":"text-delta","delta":" works"}\n\n'));
        res.write(encoder.encode('data: [DONE]\n\n'));
        res.end();
      });

      await request(app)
        .get('/api/binary-stream')
        .expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: 'http',
        path: '/api/binary-stream',
        response: {
          streaming: true,
          text: 'Binary works',
        },
      });
    });

    it('should auto-detect SSE from content when headers not set', async () => {
      app.get('/api/auto-detect', (req, res) => {
        // No SSE headers set, but content is SSE format
        res.write('data: {"type":"start"}\n\n');
        res.write('data: {"type":"text-delta","delta":"Auto"}\n\n');
        res.write('data: {"type":"text-delta","delta":" detected"}\n\n');
        res.end();
      });

      await request(app)
        .get('/api/auto-detect')
        .expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: 'http',
        path: '/api/auto-detect',
        response: {
          streaming: true,
          text: 'Auto detected',
        },
      });
    });

    it('should handle writeHead with statusMessage parameter', async () => {
      app.get('/api/writehead-msg', (req, res) => {
        // writeHead(statusCode, statusMessage, headers)
        res.writeHead(200, 'OK', {
          'Content-Type': 'text/event-stream',
        });

        res.write('data: {"type":"text-delta","delta":"Test"}\n\n');
        res.end();
      });

      await request(app)
        .get('/api/writehead-msg')
        .expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].response.streaming).toBe(true);
      expect(entries[0].response.text).toBe('Test');
    });
  });

  describe('SSE Text Delta Parsing', () => {
    it('should aggregate text-delta chunks into text field', async () => {
      app.get('/api/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        res.write('data: {"type":"start"}\n\n');
        res.write('data: {"type":"text-delta","id":"0","delta":"Hello"}\n\n');
        res.write('data: {"type":"text-delta","id":"0","delta":" world"}\n\n');
        res.write('data: {"type":"text-delta","id":"0","delta":"!"}\n\n');
        res.write('data: {"type":"finish","finishReason":"stop"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });

      await request(app)
        .get('/api/stream')
        .set('Accept', 'text/event-stream')
        .expect(200);

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        timestamp: '2024-01-15T10:30:00.000Z',
        type: 'http',
        method: 'GET',
        path: '/api/stream',
        statusCode: 200,
        response: {
          streaming: true,
          text: 'Hello world!',
        },
      });
      expect(entries[0].response.chunks).toContainEqual({ type: 'start' });
      expect(entries[0].response.chunks).toContainEqual({ type: 'text-delta', id: '0', delta: 'Hello' });
      expect(entries[0].response.chunks).toContainEqual({ type: 'done' });
    });
  });

  describe('File Size Management', () => {
    it('should truncate log file when exceeding max size', async () => {
      vi.useRealTimers(); // Use real timers for this test
      
      // Create logger with very small max size
      clearLogFile();
      const smallLogger = createLogger(TEST_LOG_FILE, {
        maxSizeBytes: 500, // Very small for testing
      });

      const smallApp = express();
      smallApp.use(express.json());
      smallApp.use(smallLogger.express());
      smallApp.get('/api/test', (req, res) => {
        res.json({ message: 'a'.repeat(100) });
      });

      // Make multiple requests to exceed the limit
      for (let i = 0; i < 10; i++) {
        await request(smallApp).get('/api/test').expect(200);
      }

      const entries = readLogEntries();
      // Should have fewer entries due to truncation (keeping 25%)
      expect(entries.length).toBeLessThan(10);
      expect(entries.length).toBeGreaterThan(0);
    });
  });
});
