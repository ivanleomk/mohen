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
    text?: string; // Aggregated text from text-delta chunks
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
  ignorePaths?: string[];     // Paths to ignore (supports wildcards like /health/*)
  includePaths?: string[];    // Only log these paths (supports wildcards)
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
  private ignorePaths: string[];
  private includePaths: string[];

  constructor(filePath: string, options: LoggerOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.maxSizeBytes = options.maxSizeBytes ?? 10 * 1024 * 1024; // 10MB default
    this.includeHeaders = options.includeHeaders ?? false;
    this.redactFields = new Set(options.redact ?? ['password', 'token', 'authorization', 'cookie']);
    this.ignorePaths = options.ignorePaths ?? [];
    this.includePaths = options.includePaths ?? [];

    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private generateRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private matchPath(pattern: string, requestPath: string): boolean {
    // Convert wildcard pattern to regex
    // /api/* matches /api/anything
    // /health matches exactly /health
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except *
      .replace(/\*/g, '.*'); // Convert * to .*
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(requestPath);
  }

  private shouldLog(requestPath: string): boolean {
    // Extract path without query string
    const pathOnly = requestPath.split('?')[0];

    // If includePaths is set, only log matching paths
    if (this.includePaths.length > 0) {
      return this.includePaths.some((pattern) => this.matchPath(pattern, pathOnly));
    }

    // If ignorePaths is set, skip matching paths
    if (this.ignorePaths.length > 0) {
      return !this.ignorePaths.some((pattern) => this.matchPath(pattern, pathOnly));
    }

    return true;
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

  /**
   * Decode chunk to string, handling Uint8Array/Buffer from TextEncoderStream
   */
  private decodeChunk(chunk: any): string {
    if (chunk === null || chunk === undefined) {
      return '';
    }
    
    // Handle Uint8Array (from TextEncoderStream in AI SDK)
    if (chunk instanceof Uint8Array) {
      return Buffer.from(chunk).toString('utf-8');
    }
    
    // Handle Buffer
    if (Buffer.isBuffer(chunk)) {
      return chunk.toString('utf-8');
    }
    
    // Handle string
    if (typeof chunk === 'string') {
      return chunk;
    }
    
    // Fallback: try toString but check if it looks like byte array
    const str = chunk.toString();
    
    // Detect if toString produced a comma-separated byte list like "100,97,116,97"
    // This happens when Uint8Array.toString() is called without proper decoding
    if (/^\d+(,\d+)*$/.test(str) && str.includes(',')) {
      try {
        const bytes = new Uint8Array(str.split(',').map(Number));
        return Buffer.from(bytes).toString('utf-8');
      } catch {
        return str;
      }
    }
    
    return str;
  }

  /**
   * Check if content looks like SSE data
   */
  private looksLikeSSE(content: string): boolean {
    return content.trimStart().startsWith('data:') || 
           content.includes('\ndata:') ||
           content.trimStart().startsWith('event:');
  }

  // ===========================================================================
  // Express Middleware
  // ===========================================================================

  expressMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const requestPath = req.originalUrl || req.url;

      // Check if we should log this path
      if (!this.shouldLog(requestPath)) {
        return next();
      }

      const start = Date.now();
      const requestId = this.generateRequestId();

      // Initialize metadata object on request
      req.logMetadata = {};

      // Detect SSE - check request Accept header initially
      let isSSE = req.headers.accept === 'text/event-stream';
      const chunks: unknown[] = [];
      const textDeltas: string[] = []; // Collect text-delta content

      // Helper to check Content-Type header for SSE
      const checkContentTypeForSSE = (headers: any): void => {
        if (!headers) return;
        
        // headers can be an object or array of [key, value] pairs
        if (Array.isArray(headers)) {
          for (let i = 0; i < headers.length; i += 2) {
            const key = headers[i];
            const value = headers[i + 1];
            if (typeof key === 'string' && 
                key.toLowerCase() === 'content-type' && 
                typeof value === 'string' && 
                value.includes('text/event-stream')) {
              isSSE = true;
              return;
            }
          }
        } else if (typeof headers === 'object') {
          for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === 'content-type' && 
                typeof value === 'string' && 
                value.includes('text/event-stream')) {
              isSSE = true;
              return;
            }
          }
        }
      };
      
      // Intercept setHeader to detect SSE by Content-Type
      const originalSetHeader = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: string | number | readonly string[]): Response => {
        if (name.toLowerCase() === 'content-type' && 
            typeof value === 'string' && 
            value.includes('text/event-stream')) {
          isSSE = true;
        }
        return originalSetHeader(name, value);
      }) as typeof res.setHeader;

      // Intercept writeHead to detect SSE (used by AI SDK's pipeUIMessageStreamToResponse)
      const originalWriteHead = res.writeHead.bind(res);
      res.writeHead = ((
        statusCode: number,
        statusMessageOrHeaders?: string | any,
        maybeHeaders?: any
      ): Response => {
        // writeHead can be called as:
        // writeHead(statusCode)
        // writeHead(statusCode, headers)
        // writeHead(statusCode, statusMessage, headers)
        let headers = maybeHeaders;
        if (!headers && typeof statusMessageOrHeaders === 'object') {
          headers = statusMessageOrHeaders;
        }
        
        checkContentTypeForSSE(headers);
        
        return originalWriteHead(statusCode, statusMessageOrHeaders as any, maybeHeaders);
      }) as typeof res.writeHead;

      // Capture request info
      const requestInfo: LogEntry['request'] = {
        body: req.body,
        query: req.query,
      };

      if (this.includeHeaders) {
        requestInfo.headers = req.headers as Record<string, string>;
      }

      // Intercept write/end for streaming detection
      const originalWrite = res.write.bind(res);
      const originalEnd = res.end.bind(res);
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);
      let responseBody: unknown;
      let logged = false;

      res.write = ((chunk: any, encodingOrCallback?: any, callback?: any): boolean => {
        if (chunk) {
          // Properly decode the chunk (handles Uint8Array from TextEncoderStream)
          const chunkStr = this.decodeChunk(chunk);
          
          // Auto-detect SSE from content if not already detected
          if (!isSSE && this.looksLikeSSE(chunkStr)) {
            isSSE = true;
          }
          
          if (isSSE) {
            const parsed = this.parseSSEChunk(chunkStr, textDeltas);
            if (parsed) {
              chunks.push(parsed);
            }
          }
        }
        return originalWrite(chunk, encodingOrCallback, callback);
      }) as typeof res.write;

      res.end = ((chunk?: any, encodingOrCallback?: any, callback?: any): Response => {
        if (logged) return originalEnd(chunk, encodingOrCallback, callback);
        logged = true;

        if (isSSE) {
          // SSE streaming path
          if (chunk) {
            const chunkStr = this.decodeChunk(chunk);
            const parsed = this.parseSSEChunk(chunkStr, textDeltas);
            if (parsed) {
              chunks.push(parsed);
            }
          }

          const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            requestId,
            type: 'http',
            method: req.method,
            path: requestPath,
            statusCode: res.statusCode,
            duration: Date.now() - start,
            request: requestInfo,
            response: {
              streaming: true,
              chunks,
            },
          };

          // Add aggregated text if we collected text-deltas
          if (textDeltas.length > 0) {
            entry.response!.text = textDeltas.join('');
          }

          if (req.logMetadata && Object.keys(req.logMetadata).length > 0) {
            entry.metadata = req.logMetadata;
          }

          this.write(entry);
        } else {
          // Regular response path
          const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            requestId,
            type: 'http',
            method: req.method,
            path: requestPath,
            statusCode: res.statusCode,
            duration: Date.now() - start,
            request: requestInfo,
            response: {
              body: responseBody,
              streaming: false,
            },
          };

          if (req.logMetadata && Object.keys(req.logMetadata).length > 0) {
            entry.metadata = req.logMetadata;
          }

          this.write(entry);
        }

        return originalEnd(chunk, encodingOrCallback, callback);
      }) as typeof res.end;

      const logResponse = () => {
        if (logged) return;
        logged = true;

        const entry: LogEntry = {
          timestamp: new Date().toISOString(),
          requestId,
          type: 'http',
          method: req.method,
          path: requestPath,
          statusCode: res.statusCode,
          duration: Date.now() - start,
          request: requestInfo,
          response: {
            body: responseBody,
            streaming: false,
          },
        };

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

      next();
    };
  }

  private parseSSEChunk(raw: string, textDeltas: string[]): unknown {
    const lines = raw.split('\n');
    const results: unknown[] = [];

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          results.push({ type: 'done' });
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          
          // Handle text-delta type - collect the delta text
          if (parsed.type === 'text-delta' && typeof parsed.delta === 'string') {
            textDeltas.push(parsed.delta);
          }
          
          results.push(parsed);
        } catch {
          results.push({ raw: data });
        }
      }
    }

    // Return single result or array
    if (results.length === 0) return null;
    if (results.length === 1) return results[0];
    return results;
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
      // Check if we should log this path
      if (!logger.shouldLog(opts.path)) {
        return opts.next();
      }

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
