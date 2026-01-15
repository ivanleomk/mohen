export function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function matchPath(pattern: string, requestPath: string): boolean {
  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(requestPath);
}

export function shouldLogPath(
  requestPath: string,
  includePaths: string[],
  ignorePaths: string[]
): boolean {
  const pathOnly = requestPath.split('?')[0];

  if (includePaths.length > 0) {
    return includePaths.some((pattern) => matchPath(pattern, pathOnly));
  }

  if (ignorePaths.length > 0) {
    return !ignorePaths.some((pattern) => matchPath(pattern, pathOnly));
  }

  return true;
}

export function redactObject(obj: unknown, redactFields: Set<string>): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, redactFields));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (redactFields.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object') {
      result[key] = redactObject(value, redactFields);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function decodeChunk(chunk: unknown): string {
  if (chunk === null || chunk === undefined) {
    return '';
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString('utf-8');
  }

  if (Buffer.isBuffer(chunk)) {
    return chunk.toString('utf-8');
  }

  if (typeof chunk === 'string') {
    return chunk;
  }

  const str = String(chunk);

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

export function looksLikeSSE(content: string): boolean {
  return (
    content.trimStart().startsWith('data:') ||
    content.includes('\ndata:') ||
    content.trimStart().startsWith('event:')
  );
}

export function parseSSEChunk(raw: string, textDeltas: string[]): unknown {
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

        if (parsed.type === 'text-delta' && typeof parsed.delta === 'string') {
          textDeltas.push(parsed.delta);
        }

        results.push(parsed);
      } catch {
        results.push({ raw: data });
      }
    }
  }

  if (results.length === 0) return null;
  if (results.length === 1) return results[0];
  return results;
}
