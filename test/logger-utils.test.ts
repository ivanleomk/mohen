import { describe, it, expect } from 'vitest';
import {
  decodeChunk,
  looksLikeSSE,
  matchPath,
  parseSSEChunk,
  redactObject,
  shouldLogPath,
} from '../src/logger-utils';

describe('logger utils', () => {
  it('matches wildcard and exact paths', () => {
    expect(matchPath('/api/*', '/api/users')).toBe(true);
    expect(matchPath('/health', '/health')).toBe(true);
    expect(matchPath('/health', '/health/live')).toBe(false);
  });

  it('filters paths with include and ignore lists', () => {
    expect(shouldLogPath('/api/users?active=true', ['/api/*'], [])).toBe(true);
    expect(shouldLogPath('/health', ['/api/*'], [])).toBe(false);
    expect(shouldLogPath('/metrics', [], ['/metrics', '/health/*'])).toBe(false);
    expect(shouldLogPath('/health/live', [], ['/metrics', '/health/*'])).toBe(false);
    expect(shouldLogPath('/api/users', [], ['/metrics', '/health/*'])).toBe(true);
  });

  it('redacts nested objects and arrays', () => {
    const redacted = redactObject(
      {
        user: { email: 'test@example.com', password: 'secret' },
        tokens: [{ token: 'abc' }, { token: 'def' }],
      },
      new Set(['password', 'token'])
    );

    expect(redacted).toEqual({
      user: { email: 'test@example.com', password: '[REDACTED]' },
      tokens: [{ token: '[REDACTED]' }, { token: '[REDACTED]' }],
    });
  });

  it('decodes Uint8Array and comma-separated byte strings', () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: {"type":"start"}\n\n');
    expect(decodeChunk(bytes)).toBe('data: {"type":"start"}\n\n');

    const commaStringLike = { toString: () => bytes.toString() };
    expect(decodeChunk(commaStringLike)).toBe('data: {"type":"start"}\n\n');
  });

  it('detects SSE payloads', () => {
    expect(looksLikeSSE('data: {"type":"start"}\n\n')).toBe(true);
    expect(looksLikeSSE('event: message\n\n')).toBe(true);
    expect(looksLikeSSE('plain text')).toBe(false);
  });

  it('parses SSE chunks and aggregates text deltas', () => {
    const textDeltas: string[] = [];
    const parsed = parseSSEChunk(
      'data: {"type":"text-delta","delta":"Hello"}\n\ndata: {"type":"text-delta","delta":" world"}\n\ndata: [DONE]\n\n',
      textDeltas
    );

    expect(parsed).toEqual([
      { type: 'text-delta', delta: 'Hello' },
      { type: 'text-delta', delta: ' world' },
      { type: 'done' },
    ]);
    expect(textDeltas.join('')).toBe('Hello world');
  });

  it('decodes SSE chunks before parsing', () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: {"type":"text-delta","delta":"Hi"}\n\n');
    const decoded = decodeChunk(bytes);
    const textDeltas: string[] = [];
    const parsed = parseSSEChunk(decoded, textDeltas);

    expect(parsed).toEqual({ type: 'text-delta', delta: 'Hi' });
    expect(textDeltas).toEqual(['Hi']);
  });
});
