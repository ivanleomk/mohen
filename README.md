<p align="center">
  <img src="logo.png" alt="mohen logo" width="200" />
</p>

<h1 align="center">mohen 墨痕</h1>

<p align="center">
  <strong>A simple, unified request/response logger for Express and tRPC</strong><br>
  Writes to a single file with JSON lines format
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mohen"><img src="https://img.shields.io/npm/v/mohen.svg" alt="npm version"></a>
  <a href="https://github.com/ivanleomk/mohen/actions"><img src="https://github.com/ivanleomk/mohen/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/ivanleomk/mohen/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/mohen.svg" alt="license"></a>
</p>

---

## Features

- Single file logging for both Express and tRPC
- JSON lines format (one JSON object per line)
- SSE streaming support with chunk aggregation
- Arbitrary metadata attachment
- Automatic field redaction (passwords, tokens, etc.)
- File size management with automatic truncation

## Installation

```bash
npm install mohen
# or
pnpm add mohen
```

## Quick Start

```typescript
import express from 'express';
import { createLogger } from 'mohen';

const logger = createLogger('./logs/app.log');

const app = express();
app.use(express.json());
app.use(logger.express());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(3000);
```

That's it. All requests and responses are now logged to `./logs/app.log`.

## Usage

### Express

```typescript
import { createLogger, attachMetadata } from 'mohen';

const logger = createLogger('./logs/app.log', {
  maxSizeBytes: 10 * 1024 * 1024, // 10MB max, then truncate to 25%
  redact: ['password', 'token', 'secret'],
});

app.use(logger.express());

// Attach custom metadata to any request
app.get('/api/users/:id', (req, res) => {
  attachMetadata(req, {
    userId: req.params.id,
    source: 'user-service',
    cacheHit: false,
  });

  res.json({ id: req.params.id, name: 'John Doe' });
});
```

### tRPC

```typescript
import { initTRPC } from '@trpc/server';
import { createLogger, attachTrpcMetadata } from 'mohen';

interface Context {
  logMetadata?: Record<string, unknown>;
}

const logger = createLogger('./logs/app.log');
const t = initTRPC.context<Context>().create();

const loggedProcedure = t.procedure.use(logger.trpc<Context>());

const appRouter = t.router({
  getUser: loggedProcedure
    .input((val: unknown) => val as { id: string })
    .query(({ input, ctx }) => {
      // Attach custom metadata
      attachTrpcMetadata(ctx, {
        userId: input.id,
        source: 'user-service',
      });

      return { id: input.id, name: 'John Doe' };
    }),
});
```

### SSE Streaming

SSE responses are automatically detected and all chunks are aggregated into a single log entry:

```typescript
app.get('/api/stream', (req, res) => {
  attachMetadata(req, { streamType: 'events' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ count: 1 })}\n\n`);
  res.write(`data: ${JSON.stringify({ count: 2 })}\n\n`);
  res.end();
});
```

Log output:
```json
{
  "type": "http",
  "path": "/api/stream",
  "response": {
    "streaming": true,
    "chunks": [{"count": 1}, {"count": 2}]
  },
  "metadata": {"streamType": "events"}
}
```

## Configuration Options

```typescript
createLogger(filePath, {
  maxSizeBytes: 10 * 1024 * 1024, // Max file size before truncation (default: 10MB)
  includeHeaders: false,          // Log request headers (default: false)
  redact: ['password', 'token'],  // Fields to redact (default: password, token, authorization, cookie)
  ignorePaths: ['/health', '/health/*', '/metrics'], // Paths to skip logging (supports wildcards)
  includePaths: ['/api/*'],       // Only log these paths (supports wildcards)
});
```

### Path Filtering

Use `ignorePaths` to skip noisy endpoints like health checks:

```typescript
const logger = createLogger('./logs/app.log', {
  ignorePaths: ['/health', '/health/*', '/metrics', '/favicon.ico'],
});
```

Or use `includePaths` to only log specific routes:

```typescript
const logger = createLogger('./logs/app.log', {
  includePaths: ['/api/*', '/trpc/*'],
});
```

Wildcard patterns:
- `/health` - matches exactly `/health`
- `/health/*` - matches `/health/live`, `/health/ready`, etc.
- `/api/*` - matches any path starting with `/api/`

## Log Format

Each line is a JSON object with the following structure:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "requestId": "m1abc123-xyz789",
  "type": "http",
  "method": "POST",
  "path": "/api/users",
  "statusCode": 200,
  "duration": 45,
  "request": {
    "body": {"name": "John", "password": "[REDACTED]"},
    "query": {}
  },
  "response": {
    "body": {"id": 1, "name": "John"},
    "streaming": false
  },
  "metadata": {
    "userId": "123",
    "source": "signup-flow"
  }
}
```

For SSE streaming responses with text-delta events (like LLM responses), the text is automatically aggregated:

```json
{
  "type": "http",
  "path": "/api/chat",
  "response": {
    "streaming": true,
    "chunks": [{"type": "start"}, {"type": "text-delta", "delta": "Hello"}, ...],
    "text": "Hello world! This is the complete aggregated response."
  }
}
```

## File Size Management

When the log file exceeds `maxSizeBytes`, the oldest 75% of log entries are removed, keeping the most recent 25%. This happens automatically before each write.

## API Reference

### `createLogger(filePath, options?)`

Creates a logger instance.

Returns:
- `express()` - Express middleware function
- `trpc<TContext>()` - tRPC middleware function
- `write(entry)` - Direct write access for custom logging

### `attachMetadata(req, metadata)`

Attach arbitrary metadata to an Express request's log entry.

```typescript
attachMetadata(req, { userId: '123', feature: 'checkout' });
```

### `attachTrpcMetadata(ctx, metadata)`

Attach arbitrary metadata to a tRPC procedure's log entry.

```typescript
attachTrpcMetadata(ctx, { userId: '123', feature: 'checkout' });
```

## License

MIT
