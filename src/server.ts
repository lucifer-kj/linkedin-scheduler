import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config/index.js';
import { apiRouter } from './api/routes.js';
import { SchedulerService } from './queue/scheduler.js';
import { logger } from './logger/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

// Serve static frontend dashboard
app.use(express.static(path.join(__dirname, 'public')));

// Mount API routes
app.use('/api', apiRouter);

// Fallback to index.html for SPA routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server and background scheduler
const server = app.listen(config.PORT, async () => {
  logger.info(`=======================================================`);
  logger.info(`🚀 LinkedIn Post Scheduler is running!`);
  logger.info(`🌐 Web Dashboard: http://localhost:${config.PORT}`);
  logger.info(`🔐 Mode: ${config.USE_MOCK_LINKEDIN ? 'MOCK MODE (Zero-Config Testing)' : 'LIVE LINKEDIN API'}`);
  logger.info(`🛡️ Encryption: AES-256-GCM Active for Token Storage`);
  logger.info(`=======================================================`);

  // Initialize background queue & scheduler
  await SchedulerService.init();
});

// Graceful shutdown handling
const shutdown = () => {
  logger.info('Shutting down scheduler and HTTP server gracefully...');
  SchedulerService.stop();
  server.close(() => {
    logger.info('HTTP server closed. Exiting process.');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
