import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config/env.js';
import chatRouter from './routes/chat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '../../web');

const app = express();
app.use(express.json());
app.use(express.static(webDir));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api', chatRouter);

app.listen(config.port, () => {
  console.log(`Sales-Recovery Agent server listening on http://localhost:${config.port}`);
});
