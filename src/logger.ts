import * as fs from 'fs';
import * as path from 'path';
import type { Request, Response, NextFunction } from 'express';

// ============================================================================
// Types
// ============================================================================

interface LogEntry {
  timestamp: string;
  requestId: string;
  type: 'http' | 'trpc';
  method: string;
  path: string;
  statusCode?: number;
  duration: number;
  request?: {
    body?: unknown;
    query?: unknown;
    headers?: Record<string, string>;
  };
  response?: {
    body?: unknown;
    streaming?: boolean;
    chunks?: unknown[];
  };
  error?: {
    message: string;
    stack?: string;
  };
  metadata?: Record<string, unknown>;
}

interface LoggerOptions {
  maxSizeBytes?: number;      // Default: 10MB
  includeHeaders?: boolean;   // Default: false
  redact?: string[];          // Fields to redact from logs
}

// Extend Express Request to include metadata
declare global {
  namespace Express {
    interface Request {
      logMetadata?: Record<string, unknown>;
    }
  }
}

// ============================================================================
// Core Logger Class
// ============================================================================

class UnifiedLogger {
  private filePath: string;
  private maxSizeBytes: number;
  private includeHeaders: boolean;
  private redactFields: Set<string>;

  constructor(filePath: string, options: LoggerOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.maxSizeBytes = options.maxSizeBytes ?? 10 * 1024 * 1024; // 10MB default
    this.includeHeaders = options.includeHeaders ?? false;
    this.redactFields = new Set(options.redact ?? ['password', 'token', 'authorization', 'cookie']);

    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private generateRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private redact(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redact(item));
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (this.redactFields.has(key.toLowerCase())) {
        result[key] = '[REDACTED]';
      } else if (typeof value === 'object') {
        result[key] = this.redact(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private checkAndRotate(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;

      const stats = fs.statSync(this.filePath);
      if (stats.size > this.maxSizeBytes) {
        // Read file, keep last 25% of lines
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const lines = content.trim().split('\n');
        const keepCount = Math.floor(lines.length * 0.25);
        const newContent = lines.slice(-keepCount).join('\n') + '\n';
        fs.writeFileSync(this.filePath, newContent);
      }
    } catch (err) {
      console.error('Logger rotation error:', err);
    }
  }

  write(entry: LogEntry): void {
    try {
      this.checkAndRotate();
      const redactedEntry = this.redact(entry) as LogEntry;
      const line = JSON.stringify(redactedEntry) + '\n';
      fs.appendFileSync(this.filePath, line);
    } catch (err) {
      console.error('Logger write error:', err);
    }
  }

  // ===========================================================================
  // Express Middleware
  // ===========================================================================

  expressMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      const requestId = this.generateRequestId();

      // Initialize metadata object on request
      req.logMetadata = {};

      // Detect SSE
      const isSSE = req.headers.accept === 'text/event-stream';
      const chunks: unknown[] = [];

      // Capture request info
      const requestInfo: LogEntry['request'] = {
        body: req.body,
        query: req.query,
      };

      if (this.includeHeaders) {
        requestInfo.headers = req.headers as Record<string, string>;
      }

      if (isSSE) {
        // --- SSE Streaming ---
        const originalWrite = res.write.bind(res);
        const originalEnd = res.end.bind(res);

        res.write = ((chunk: any, encodingOrCallback?: any, callback?: any): boolean => {
          if (chunk) {
            const chunkStr = chunk.toString();
            // Parse SSE data
            const parsed = this.parseSSEChunk(chunkStr);
            if (parsed) {
              chunks.push(parsed);
            }
          }
          return originalWrite(chunk, encodingOrCallback, callback);
        }) as typeof res.write;

        res.end = ((chunk?: any, encodingOrCallback?: any, callback?: any): Response => {
          if (chunk) {
            const chunkStr = chunk.toString();
            const parsed = this.parseSSEChunk(chunkStr);
            if (parsed) {
              chunks.push(parsed);
            }
          }

          const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            requestId,
            type: 'http',
            method: req.method,
            path: req.originalUrl || req.url,
            statusCode: res.statusCode,
            duration: Date.now() - start,
            request: requestInfo,
            response: {
              streaming: true,
              chunks,
            },
          };

          // Attach metadata if present
          if (req.logMetadata && Object.keys(req.logMetadata).length > 0) {
            entry.metadata = req.logMetadata;
          }

          this.write(entry);

          return originalEnd(chunk, encodingOrCallback, callback);
        }) as typeof res.end;

      } else {
        // --- Non-streaming ---
        const originalJson = res.json.bind(res);
        const originalSend = res.send.bind(res);
        let responseBody: unknown;
        let logged = false;

        const logResponse = () => {
          if (logged) return;
          logged = true;

          const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            requestId,
            type: 'http',
            method: req.method,
            path: req.originalUrl || req.url,
            statusCode: res.statusCode,
            duration: Date.now() - start,
            request: requestInfo,
            response: {
              body: responseBody,
              streaming: false,
            },
          };

          // Attach metadata if present
          if (req.logMetadata && Object.keys(req.logMetadata).length > 0) {
            entry.metadata = req.logMetadata;
          }

          this.write(entry);
        };

        res.json = (body: any) => {
          responseBody = body;
          logResponse();
          return originalJson(body);
        };

        res.send = (body: any) => {
          if (!logged) {
            try {
              responseBody = typeof body === 'string' ? JSON.parse(body) : body;
            } catch {
              responseBody = body;
            }
            logResponse();
          }
          return originalSend(body);
        };
      }

      next();
    };
  }

  private parseSSEChunk(raw: string): unknown {
    const lines = raw.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') return { done: true };
        try {
          return JSON.parse(data);
        } catch {
          return { raw: data };
        }
      }
    }
    return null;
  }

  // ===========================================================================
  // tRPC Middleware
  // ===========================================================================

  trpcMiddleware<TContext extends Record<string, unknown> = Record<string, unknown>>() {
    const logger = this;

    return async function loggerMiddleware(opts: {
      path: string;
      type: 'query' | 'mutation' | 'subscription';
      input: unknown;
      ctx: TContext & { logMetadata?: Record<string, unknown> };
      next: () => Promise<{ ok: boolean; data?: unknown; error?: Error }>;
    }) {
      const start = Date.now();
      const requestId = logger.generateRequestId();

      // Initialize metadata on context if not present
      if (!opts.ctx.logMetadata) {
        opts.ctx.logMetadata = {};
      }

      try {
        const result = await opts.next();

        const entry: LogEntry = {
          timestamp: new Date().toISOString(),
          requestId,
          type: 'trpc',
          method: opts.type.toUpperCase(),
          path: opts.path,
          statusCode: result.ok ? 200 : 500,
          duration: Date.now() - start,
          request: {
            body: opts.input,
          },
          response: {
            body: result.data,
            streaming: false,
          },
        };

        // Attach metadata if present
        if (opts.ctx.logMetadata && Object.keys(opts.ctx.logMetadata).length > 0) {
          entry.metadata = opts.ctx.logMetadata;
        }

        if (result.error) {
          entry.error = {
            message: result.error.message,
            stack: result.error.stack,
          };
        }

        logger.write(entry);

        return result;
      } catch (error) {
        const err = error as Error;

        const entry: LogEntry = {
          timestamp: new Date().toISOString(),
          requestId,
          type: 'trpc',
          method: opts.type.toUpperCase(),
          path: opts.path,
          statusCode: 500,
          duration: Date.now() - start,
          request: {
            body: opts.input,
          },
          error: {
            message: err.message,
            stack: err.stack,
          },
        };

        // Attach metadata if present
        if (opts.ctx.logMetadata && Object.keys(opts.ctx.logMetadata).length > 0) {
          entry.metadata = opts.ctx.logMetadata;
        }

        logger.write(entry);

        throw error;
      }
    };
  }
}

// ============================================================================
// Factory Function (Main Export)
// ============================================================================

export function createLogger(filePath: string, options?: LoggerOptions) {
  const logger = new UnifiedLogger(filePath, options);

  return {
    /** Express middleware - use with app.use() */
    express: () => logger.expressMiddleware(),

    /** tRPC middleware - use with t.procedure.use() */
    trpc: <TContext extends Record<string, unknown> = Record<string, unknown>>() => 
      logger.trpcMiddleware<TContext>(),

    /** Direct write access for custom logging */
    write: (entry: Partial<LogEntry>) => logger.write({
      timestamp: new Date().toISOString(),
      requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      type: 'http',
      method: 'CUSTOM',
      path: '/',
      duration: 0,
      ...entry,
    } as LogEntry),
  };
}

// ============================================================================
// Helper to attach metadata (for cleaner API)
// ============================================================================

/**
 * Attach metadata to the current request log entry (Express)
 */
export function attachMetadata(req: Request, metadata: Record<string, unknown>): void {
  if (!req.logMetadata) {
    req.logMetadata = {};
  }
  Object.assign(req.logMetadata, metadata);
}

/**
 * Attach metadata to the current request log entry (tRPC)
 */
export function attachTrpcMetadata<TContext extends { logMetadata?: Record<string, unknown> }>(
  ctx: TContext,
  metadata: Record<string, unknown>
): void {
  if (!ctx.logMetadata) {
    ctx.logMetadata = {};
  }
  Object.assign(ctx.logMetadata, metadata);
}

// Default export for simpler imports
export default createLogger;
