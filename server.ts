import dotenv from 'dotenv';
import path from 'path';

if (!process.env.DATABASE_URL || !process.env.APP_URL) {
  dotenv.config({ path: path.join(process.cwd(), 'backend', '.env') });
  dotenv.config({ path: path.join(process.cwd(), '.env') });
}
dotenv.config();

import express from 'express';
import http from 'http';
import cors from 'cors';

import { authenticate } from './server/auth.js';
import { initSocket, getIO } from './server/socket.js';

import authRouter from './server/routes/auth.js';
import projectsRouter from './server/routes/projects.js';
import phasesRouter from './server/routes/phases.js';
import tasksRouter from './server/routes/tasks.js';
import issuesRouter from './server/routes/issues.js';
import risksRouter from './server/routes/risks.js';
import milestonesRouter from './server/routes/milestones.js';
import alertsRouter from './server/routes/alerts.js';
import workloadRouter from './server/routes/workload.js';
import notificationsRouter from './server/routes/notifications.js';
import chatRouter from './server/routes/chat.js';
import approvalsRouter from './server/routes/approvals.js';
import baselinesRouter from './server/routes/baselines.js';
import changelogRouter from './server/routes/changelog.js';
import budgetRouter from './server/routes/budget.js';
import portfolioRouter from './server/routes/portfolio.js';
import documentsRouter from './server/routes/documents.js';
import calendarRouter from './server/routes/calendar.js';
import usersRouter from './server/routes/users.js';
import leaveRouter from './server/routes/leave.js';

const app = express();

const httpServer = http.createServer(app);

// Initialize Socket.IO
initSocket(httpServer);

// CORS configuration for production & development
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like server-to-server, curl, mobile apps)
      if (!origin) return callback(null, true);
      const appUrl = process.env.APP_URL;
      if (
        !appUrl ||
        origin === appUrl ||
        origin.endsWith('.vercel.app') ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1')
      ) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'Cookie'],
  })
);

// Route Socket.IO polling requests directly to Socket.IO engine (prior to JSON body parsing)
app.use((req, res, next) => {
  if (req.url.startsWith('/socket.io') && !res.headersSent) {
    const ioInstance = getIO();
    if (ioInstance) {
      (ioInstance.engine as any).handleRequest(req, res);
      return;
    }
  }
  next();
});

// Middleware
app.use(express.json());

// Public health check and root endpoints (zero authentication dependency)
app.get('/', (req, res) => {
  res.json({
    service: 'Fern & Foley — Projects API',
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Fern & Foley — Projects API',
    timestamp: new Date().toISOString(),
  });
});

// Global Auth Middleware
app.use(authenticate);

// Authentication
app.use('/api/auth', authRouter);

// Domain Routers
app.use('/api/projects', projectsRouter);
app.use('/api', phasesRouter);
app.use('/api/tasks', tasksRouter);

app.post('/api/quality-checks/:id/toggle', (req, res, next) => {
  req.url = `/quality-checks/${req.params.id}/toggle`;
  tasksRouter(req, res, next);
});

app.use('/api/issues', issuesRouter);
app.use('/api/risks', risksRouter);
app.use('/api/milestones', milestonesRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/workload', workloadRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/users', usersRouter);

// Phase 2 Routers
app.use('/api/notifications', notificationsRouter);
app.use('/api', chatRouter);
app.use('/api/approvals', approvalsRouter);
app.use('/api/projects', baselinesRouter);
app.use('/api/projects', changelogRouter);
app.use('/api/projects', budgetRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api', documentsRouter);
app.use('/api/leave', leaveRouter);

// Local development only (skip auto-listen in test runner or on Vercel)
if (!process.env.VERCEL && process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT
    ? parseInt(process.env.PORT, 10)
    : 5000;

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(
      `\n  ➜ API Server running on: http://localhost:${PORT}\n`
    );
  });
}

// Export for Vercel
export default app;
export { app, httpServer };
