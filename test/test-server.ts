import express from 'express';
import { createLogger } from '../src/logger';

const logger = createLogger('./logs/test.log', {
  maxSizeBytes: 1024 * 1024, // 1MB for testing
  redact: ['password', 'secret'],
});

const app = express();
app.use(express.json());
app.use(logger.express());

// Regular JSON endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'Hello World', timestamp: Date.now() });
});

// POST with body
app.post('/api/data', (req, res) => {
  res.json({ received: req.body, success: true });
});

// SSE streaming endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let count = 0;
  const interval = setInterval(() => {
    count++;
    res.write(`data: ${JSON.stringify({ count, msg: `Event ${count}` })}\n\n`);

    if (count >= 3) {
      res.write('data: [DONE]\n\n');
      clearInterval(interval);
      res.end();
    }
  }, 50);
});

const PORT = 3456;
const server = app.listen(PORT, () => {
  console.log(`Test server running on http://localhost:${PORT}`);
});

// Auto-shutdown after tests
setTimeout(() => {
  console.log('Shutting down test server...');
  server.close();
  process.exit(0);
}, 5000);
