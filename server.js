const express = require('express');
const multer = require('multer');
const cors = require('cors');
const compression = require('compression');
const { logger, cronLogger } = require('./modules/logger.js'); // Import the new logger
const path = require('path');
const fs = require('fs').promises;
const http = require('http');
const { Pool } = require('pg');
const { IBApi, EventName } = require('@stoqey/ib');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { DateTime, Duration } = require('luxon');
const axios = require('axios');
const cron = require('node-cron');
const { delay, timeout, normalizeDate, getTimeframeDuration, parseDuration } = require('./modules/utils.js');
const db = require('./modules/database.js');
const ibkr = require('./modules/ibkr-conn.js');
const taskManager = require('./modules/task-manager.js');
const configManager = require('./modules/config.js');
const historicalDataService = require('./modules/historical-data-service.js');
const yahoo = require('./modules/yahoo.js');

const { getEnabledTimeframes } = historicalDataService;

const app = express();
const apiRouter = express.Router();
const upload = multer({ dest: 'Uploads/' });

let server = null;
let PORT = process.env.PORT || 3999;
let USER_PATH_LOCAL = process.env.USER_PATH || "./";

const AbortController = globalThis.AbortController || require('abort-controller'); // Polyfill for Node < 15 if needed

// WebSocket server
const wss = new WebSocket.Server({ noServer: true });

function broadcastStatus(requestId, status, type = 'info') {
  const message = {
    requestId,
    status,
    type, // info, success, error, warning
    timestamp: new Date().toISOString()
  };
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

async function triggerTaskProcessor() {
  // Prevent multiple processors from running
  if (taskManager.isProcessorActive()) {
    return;
  }

  taskManager.setProcessorActive(true);
  logger.info('[TaskManager] Task processor activated.');

  // Run indefinitely, checking for tasks
  while (true) {
    if (taskManager.getCurrentTask() === null && taskManager.getQueue().length > 0) {
      const taskToRun = taskManager.getNextPendingTask();
      if (taskToRun) {
      taskManager.setCurrentTask({
        id: taskToRun.id,
        symbol: taskToRun.symbol,
        timeframe: taskToRun.timeframe,
        phase: taskToRun.phase,
        contractMonth: taskToRun.contractMonth,
        type: taskToRun.type,
        cancellationController: taskToRun.cancellationController,
      });
      logger.info(`[TaskManager] Starting task: ${taskToRun.id} (${taskToRun.symbol} ${taskToRun.timeframe} ${taskToRun.phase})`);
      const outcomeBase = {
        id: taskToRun.id,
        symbol: taskToRun.symbol,
        timeframe: taskToRun.timeframe,
        phase: taskToRun.phase,
        contractMonth: taskToRun.contractMonth,
        type: taskToRun.type,
      };
      try {
        await historicalDataService.populateHistoricalData(taskToRun, broadcastStatus, wss);
        taskToRun.status = taskManager.TASK_STATUS.COMPLETED;
        logger.info(`[TaskManager] Completed task: ${taskToRun.id} (${taskToRun.symbol} ${taskToRun.timeframe} ${taskToRun.phase})`);
        taskManager.recordTaskOutcome({ ...outcomeBase, status: 'completed' });
        // Recorded for every task regardless of priority — this is what lets
        // the cron sweep's CRON_RECHECK_THROTTLE_MINUTES skip re-queuing a
        // coarse timeframe (4H/1D/1W) that was just checked, no matter which
        // priority tier actually did the checking.
        taskManager.getRecentCompletions().set(
          `${taskToRun.symbol}-${taskToRun.timeframe}-${taskToRun.contractMonth || 'cont'}-${taskToRun.type}-any_completion`,
          Date.now()
        );
        if (taskToRun.priority === taskManager.PRIORITY.USER_FOREGROUND_YAHOO || taskToRun.priority === taskManager.PRIORITY.USER_FOREGROUND_IBKR) {
          taskManager.getRecentCompletions().set(`${taskToRun.symbol}-${taskToRun.timeframe}-user_initiated_fg`, Date.now());
          logger.debug(`[TaskManager] Updated foreground completion time for ${taskToRun.symbol}-${taskToRun.timeframe}.`);
        }
      } catch (error) {
        if (taskToRun.cancellationController.signal.aborted) {
          taskToRun.status = taskManager.TASK_STATUS.CANCELLED;
          logger.warn(`[TaskManager] Cancelled task: ${taskToRun.id} - ${error.message}`);
          taskManager.recordTaskOutcome({ ...outcomeBase, status: 'cancelled', error: error.message });
        } else {
          taskToRun.status = taskManager.TASK_STATUS.FAILED;
          logger.error(`[TaskManager] Failed task: ${taskToRun.id} - ${error.message}`);
          taskManager.recordTaskOutcome({ ...outcomeBase, status: 'failed', error: error.message });
        }
      } finally {
        taskManager.clearCurrentTask();
      }
    } 
  } else {
      await delay(1000); // Wait 1 second before checking again
    }
  }
  // Note: This function no longer exits naturally; it runs until the server stops
}

async function startServer(newPort) {
  if (server) {
    await new Promise((resolve) => {
      server.close(() => {
        broadcastStatus(uuidv4(), 'Server stopped', 'info');
        logger.info('🛑 Server stopped');
        resolve();
      });
    });
  }

  PORT = newPort || PORT;
  server = http.createServer(app);
  server.listen(PORT, () => {
    broadcastStatus(uuidv4(), `API running on port ${PORT}`, 'success');
    logger.info(`🚀 API running on port ${PORT}`);
  });

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });
}

(async () => {
  try {
    const config = await configManager.loadConfig();
    PORT = config.port || PORT; // Use config port if available

    if (config.databaseUrl && config.databaseUrl.startsWith('postgresql://')) {
      await db.connectDatabase(config.databaseUrl, broadcastStatus, uuidv4);
    } else {
      broadcastStatus(uuidv4(), 'No valid database URL configured', 'warning');
      logger.warn('⚠️ No valid database URL configured. Waiting for configuration via /api/config');
    }
    const tradesRouter = require('./routes/trades.js')(db.getPool(), upload, broadcastStatus, uuidv4);
    const accountsRouter = require('./routes/accounts.js')(db.getPool(), broadcastStatus, uuidv4);
    const settingsRouter = require('./routes/settings.js')(db.getPool(), broadcastStatus, uuidv4);
    const historicalRouter = require('./routes/historical.js')(db, taskManager, historicalDataService, broadcastStatus, uuidv4, triggerTaskProcessor);
    const ibkrRouter = require('./routes/ibkr.js')(ibkr, broadcastStatus, uuidv4);
    const capitalRouter = require('./routes/capital.js')(db.getPool(), broadcastStatus, uuidv4);

    apiRouter.use('/', tradesRouter);
    apiRouter.use('/accounts', accountsRouter);
    apiRouter.use('/', settingsRouter);
    apiRouter.use('/', historicalRouter);
    apiRouter.use('/ibkr', ibkrRouter);
    apiRouter.use('/', capitalRouter);

    await startServer(PORT); // Start the HTTP server

    // START THE TASK PROCESSOR
    triggerTaskProcessor(); // This will start the loop if there are any initial tasks or wait for tasks.

  } catch (err) {
    broadcastStatus(uuidv4(), `Failed to initialize server: ${err.message}`, 'error');
    logger.error('❌ Failed to initialize server:', { message: err.message, stack: err.stack });
  }
})();

// General middleware
app.use(cors());
// Historical data responses for heavily-backfilled 1-minute symbols can be
// enormous (a real case this session: ~150MB of JSON for one symbol's full
// history) — almost entirely repeated field names and similar-looking
// numbers, which gzip handles extremely well (measured ~91% smaller on that
// exact payload). That was the single biggest remaining contributor to
// TradeView's "stuck for tens of seconds" complaint after zooming out, once
// the client-side sort/parse cost was separately fixed — this cuts transfer
// time by roughly the same ~10x without touching any chart/panning logic at
// all, since it's transparent to every existing client.
app.use(compression());
app.use(express.json({ limit: '200kb' }));
app.use('/uploads', express.static(path.join(__dirname, 'Uploads')));

// External API (routes/external.js) — mounted directly on `app`, and
// registered before `app.use('/api', apiRouter)` below, so it never passes
// through apiRouter's internal middleware (the X-Account-ID requirement in
// particular makes no sense here: the external API is account-agnostic,
// taking account_id as an optional query filter instead). Only needs `db`
// (the module, not an already-connected pool — routes call db.getPool() lazily
// per request) plus already-available module references, so it can be built
// synchronously here rather than inside the async startup IIFE above, which
// matters: code in that IIFE only runs (and thus only registers routes) after
// this file's synchronous top-level code — including the `/api` mount below —
// has already finished executing.
const externalRouter = require('./routes/external.js')(db, historicalDataService, yahoo, broadcastStatus, uuidv4, taskManager, triggerTaskProcessor);
app.use('/api/external/v1', externalRouter);

// Deliberately its own top-level path, not nested under /api/external/v1 —
// see routes/tradingview-webhook.js for why. This is the one endpoint in the
// app meant to be reachable from the public internet (a tunnel scoped to
// just this path), so it has its own secret-based auth rather than relying
// on "trusted network" like the rest of the external API.
const tradingViewWebhookRouter = require('./routes/tradingview-webhook.js')(db, configManager, broadcastStatus, uuidv4, wss, WebSocket);
app.use('/api/webhooks', tradingViewWebhookRouter);

apiRouter.use((req, res, next) => {
  const accountId = req.headers['x-account-id'];
  // Skip X-Account-ID check for specific endpoints
  const exemptPaths = [
    '/accounts',
    '/config',
    '/config/status',
    '/config/logs',
    '/futures-settings',
    '/historical',
    '/historical/populate',
    '/historical/db',
    '/yahoo-finance',
    '/ibkr'
  ];
  if (exemptPaths.some(path => req.path.startsWith(path)) || (req.path === '/accounts' && req.method === 'POST')) {
    req.accountId = parseInt(accountId, 10) || null; // Set accountId if provided, else null
    next();
  } else {
    if (!accountId) {
      return res.status(400).json({ error: 'Missing X-Account-ID header' });
    }
    req.accountId = parseInt(accountId, 10);
    if (!isNaN(req.accountId)) {
      next();
    } else {
      return res.status(400).json({ error: 'Invalid X-Account-ID' });
    }
  }
});

apiRouter.use((req, res, next) => {
  const databaseEndpoints = [
    '/accounts',
    '/trades',
    '/attachments',
    '/daynotes',
    '/futures-settings',
    '/historical/populate',
    '/historical/db',
    '/exchanges',
    '/yahoo-finance'
  ];
  if (databaseEndpoints.some(endpoint => req.path.startsWith(endpoint)) && !db.getIsConnected()) {
    return res.status(503).json({ error: 'Database not configured or not connected' });
  }
  next();
});

apiRouter.use((req, res, next) => {
  logger.http(`${req.method} ${req.url} (Account: ${req.accountId || 'N/A'})`);
  if (req.body && Object.keys(req.body).length > 0) {
    logger.debug(`[Payload Size] ${req.url}: ${JSON.stringify(req.body).length} bytes`);
  }
  next();
});



apiRouter.get('/config/status', async (req, res) => {
  try {
    const config = await configManager.loadConfig();
    res.json({
      isConnected: db.getIsConnected(),
      databaseUrl: config.databaseUrl || null,
      port: config.port || PORT,
      ibkrAddresses: config.ibkrAddresses || [{ host: '', port: 7497 }, { host: '', port: 7497 }],
      ibkrConnected: ibkr.isIbkrConnected(),
      status: db.getIsConnected() ? 'Connected' : config.databaseUrl ? 'Connection failed' : 'Not configured',
      ibkrFlexQueryIdActivity: config.ibkrFlexQueryIdActivity || '',
      ibkrFlexQueryIdTradeConf: config.ibkrFlexQueryIdTradeConf || '',
      ibkrFlexTokenSet: !!config.ibkrFlexToken
    });
  } catch (err) {
    broadcastStatus(uuidv4(), `Error fetching config status: ${err.message}`, 'error');
    logger.error('Error fetching config status:', { error: err });
    res.status(500).json({ error: 'Failed to fetch config status: ' + err.message });
  }
});

// Return the last N lines of the server log (useful for debugging when running in production)
apiRouter.get('/config/logs', async (req, res) => {
  const lines = Math.min(parseInt(req.query.lines, 10) || 200, 2000);
  const logFilePath = path.join(USER_PATH_LOCAL, 'server.log');

  try {
    const stats = await fs.stat(logFilePath);
    const maxBytes = 200 * 1024; // Read up to the last 200KB
    const readBytes = Math.min(stats.size, maxBytes);
    const fd = await fs.open(logFilePath, 'r');
    try {
      const buffer = Buffer.alloc(readBytes);
      await fd.read(buffer, 0, readBytes, stats.size - readBytes);
      let content = buffer.toString('utf8');
      // If we didn't read from the start, drop the first partial line
      if (stats.size > readBytes) {
        const firstNewline = content.indexOf('\n');
        if (firstNewline !== -1) {
          content = content.slice(firstNewline + 1);
        }
      }
      const allLines = content.split(/\r?\n/).filter(Boolean);
      const tail = allLines.slice(-lines).join('\n');
      res.json({ log: tail });
    } finally {
      await fd.close();
    }
  } catch (err) {
    broadcastStatus(uuidv4(), `Error fetching server logs: ${err.message}`, 'error');
    logger.error('Error fetching server logs:', { error: err });
    res.status(500).json({ error: 'Failed to fetch server logs: ' + err.message });
  }
});

apiRouter.post('/config', async (req, res) => {
  const { databaseUrl, port, ibkrAddresses, ibkrFlexToken, ibkrFlexQueryIdActivity, ibkrFlexQueryIdTradeConf, tradingViewWebhookSecret } = req.body;

  try {
    const config = await configManager.loadConfig();
    let needsRestart = false;

    if (databaseUrl && databaseUrl !== config.databaseUrl) {
      if (!databaseUrl.startsWith('postgresql://')) {
        return res.status(400).json({ error: 'Invalid PostgreSQL URL format' });
      }
      const testPool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
      const client = await testPool.connect();
      await client.release();
      await testPool.end(); // It's okay to end a temporary test pool
      config.databaseUrl = databaseUrl;
      needsRestart = true;      logger.info('[Config] Database URL changed. Server restart required.');
    }

    if (port) {
      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
        return res.status(400).json({ error: 'Port must be a number between 1024 and 65535' });
      }
      if (portNum !== config.port) {
        config.port = portNum;
        needsRestart = true;
        logger.info('[Config] Port changed. Server restart required.');
      }
    }

    // Other settings that don't require a restart
    if (ibkrAddresses) config.ibkrAddresses = ibkrAddresses;
    if (ibkrFlexToken !== undefined) config.ibkrFlexToken = ibkrFlexToken;
    if (ibkrFlexQueryIdActivity !== undefined) config.ibkrFlexQueryIdActivity = ibkrFlexQueryIdActivity;
    if (ibkrFlexQueryIdTradeConf !== undefined) config.ibkrFlexQueryIdTradeConf = ibkrFlexQueryIdTradeConf;
    // No restart needed — the webhook route reads this fresh via
    // configManager.loadConfig() on every request, not a cached value.
    if (tradingViewWebhookSecret !== undefined) config.tradingViewWebhookSecret = tradingViewWebhookSecret;

    await configManager.saveConfig(config);

    const message = `Configuration updated successfully.${needsRestart ? ' Server is restarting.' : ''}`;
    broadcastStatus(uuidv4(), message, 'success');
    res.json({ success: true, message: message, needsRestart: needsRestart });

    if (needsRestart) {
      logger.info('[Config] Triggering graceful shutdown for restart...');
      // Give the response time to send before shutting down
      setTimeout(() => {
        server.close(() => {
          logger.info('[Config] Server closed. Exiting process for restart.');
          process.exit(0); // Exit gracefully. PM2 or Docker will restart it.
        });
      }, 1000);
    }

  } catch (err) {
    logger.error('Error updating configuration:', { error: err });
    let errorMessage = 'Failed to update configuration: ' + err.message;
    if (err.code === '28P01') errorMessage = 'Invalid database authentication credentials';
    if (err.code === '3D000') errorMessage = 'Database does not exist';
    if (err.code === '08001') errorMessage = 'Unable to connect to database host';

    broadcastStatus(uuidv4(), errorMessage, 'error');
    res.status(500).json({ error: errorMessage });
  }
});

// Mount API routes
app.use('/api', apiRouter);

function logCronOutcome(requestId, status, message) {
  cronLogger.info(`${status}: ${message} (requestId: ${requestId})`);
}

// The cron sweep below queues every enabled timeframe for every symbol every
// single cycle, regardless of whether that timeframe could possibly have a
// new bar since last time — a 1W bar only closes once a week, so checking it
// every 30 minutes is ~99% wasted round-trips that only ever confirm "still
// nothing new," while still costing a full task slot each time (DB queries,
// an IBKR/Yahoo request, queue bookkeeping) and contributing to the queue
// depth some other symbol's genuinely-due task is waiting behind. Only the
// coarse timeframes need throttling — 1M/5M/15M/1H bars can each plausibly
// have new data within a single 30-min cron window, so they're deliberately
// left unthrottled here (absent from the map = no throttle).
const CRON_RECHECK_THROTTLE_MINUTES = {
  '4H': 120,  // new bar every 4h — checking every 2h is already generous
  '1D': 240,  // new bar once a day — checking every 4h is already generous
  '1W': 720,  // new bar once a week — checking twice a day is already generous
};

cron.schedule('*/30 * * * *', async () => {
  const cronRunId = uuidv4();
  logger.info(`[Cron:${cronRunId}] Background data fetch triggered.`);
  try {
    const { rows: allSymbols } = await db.getPool().query(
      'SELECT id, symbol, type, exchange, timeframe_settings FROM futures_settings WHERE symbol != $1', ['DEFAULT']
    );
    if (allSymbols.length === 0) {
      logger.info(`[Cron:${cronRunId}] No symbols found for daily fetch.`);
      logCronOutcome(cronRunId, 'skipped', 'No symbols to process.');
      return;
    }

    logger.info(`[Cron:${cronRunId}] Adding tasks for ${allSymbols.length} symbols.`);
    let queuedCount = 0, throttledCount = 0;
    for (const { symbol, type, exchange, timeframe_settings } of allSymbols) {
      let contractMonthsToProcess = [null]; // Default for STK and continuous FUT
      if (type === 'FUT') {
        const { rows: tradeRows } = await db.getPool().query(
          'SELECT DISTINCT contract_month FROM trades WHERE symbol = $1 AND type = $2 AND contract_month IS NOT NULL',
          [symbol, type]
        );
        contractMonthsToProcess = [null, ...new Set(tradeRows.map(row => row.contract_month))];
      }

      const enabledTimeframes = getEnabledTimeframes(timeframe_settings);
      for (const contractMonth of contractMonthsToProcess) {
        for (const timeframe of enabledTimeframes) {
          const throttleMinutes = CRON_RECHECK_THROTTLE_MINUTES[timeframe];
          if (throttleMinutes) {
            const completionKey = `${symbol}-${timeframe}-${contractMonth || 'cont'}-${type}-any_completion`;
            const lastCompleted = taskManager.getRecentCompletions().get(completionKey);
            if (lastCompleted && (Date.now() - lastCompleted) < throttleMinutes * 60 * 1000) {
              throttledCount++;
              continue; // Checked recently enough for how often this timeframe can change.
            }
          }
          const taskDesc = `${symbol} (${timeframe}, contract: ${contractMonth || 'cont.'}, type: ${type})`;
          // Cron tasks get a 'full' phase and lower priority
          const added = taskManager.addTask(symbol, timeframe, 'full', taskManager.PRIORITY.CRON_FULL_POPULATION, `cron_${taskDesc}`, contractMonth, type);
          if (added) queuedCount++;
        }
      }
    }
    logger.info(`[Cron:${cronRunId}] All daily tasks added to queue (${queuedCount} queued, ${throttledCount} skipped as recently-checked coarse timeframes).`);
    logCronOutcome(cronRunId, 'tasks_queued', `Queued ${queuedCount} tasks across ${allSymbols.length} symbols (${throttledCount} skipped, recently checked).`);
  } catch (err) {
    logger.error(`[Cron:${cronRunId}] Error during daily data fetch setup: ${err.message}`);
    logCronOutcome(cronRunId, 'error', `Error setting up tasks: ${err.message}`);
  }
  // The task processor will pick these up based on priority. No direct lock management here.
});

logger.info('[YahooCron] Scheduled background data fetch for stocks and futures every 30 minutes');

// Serve static files and handle frontend routes in production
if (process.env.NODE_ENV === 'production') {
  const buildPath = path.join(__dirname, 'build');
  app.use(express.static(buildPath));
  app.get('/*any', (req, res) => {
    logger.debug(`Serving index.html for path: ${req.path}`);
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  broadcastStatus(uuidv4(), `Internal server error: ${err.message}`, 'error');
  logger.error('Unhandled error:', { error: err });
  res.status(500).json({ error: 'Internal server error' });
});