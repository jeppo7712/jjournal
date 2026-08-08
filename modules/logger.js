const winston = require('winston');
const path = require('path');
const fs = require('fs');

const USER_PATH_LOCAL = process.env.USER_PATH || "./";

// In production, truncate old log files so they don't grow indefinitely.
// This keeps the log output focused on the current run.
if (process.env.NODE_ENV === 'production') {
  const truncateIfExists = (filename) => {
    try {
      const fullPath = path.join(USER_PATH_LOCAL, filename);
      if (fs.existsSync(fullPath)) {
        fs.truncateSync(fullPath, 0);
      }
    } catch (e) {
      // If truncate fails, we still want the app to start.
      // Logging isn't initialized yet, so swallow errors silently.
    }
  };

  truncateIfExists('server.log');
  truncateIfExists('server-error.log');
  truncateIfExists('cron.log');
}

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

// Define a custom format for development logs to make them readable and colorful
const devFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} ${level}: ${stack || message}`;
});

// Main application logger
const logger = winston.createLogger({
  // Set the level based on the environment.
  // In development, we see 'debug' and higher.
  // In production, we only see 'info' and higher.
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  
  // In production, format logs as JSON. In development, use our custom devFormat.
  format: process.env.NODE_ENV === 'production'
    ? combine(timestamp(), errors({ stack: true }), json())
    : combine(colorize(), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), devFormat),
  
  transports: [
    // In production, log to files.
    ...(process.env.NODE_ENV === 'production' ? [
      new winston.transports.File({ filename: path.join(USER_PATH_LOCAL, 'server-error.log'), level: 'error' }),
      new winston.transports.File({ filename: path.join(USER_PATH_LOCAL, 'server.log') })
    ] : [
      // In development, just log to the console.
      new winston.transports.Console()
    ])
  ],
  exitOnError: false,
});

// Add a custom 'http' level for logging Express requests, which is a common practice.
const levels = { ...winston.config.npm.levels, http: 6 };
winston.addColors({ http: 'magenta' });
logger.levels = levels;

/**
 * A separate logger specifically for cron job outputs.
 * This demonstrates how you can direct different kinds of logs to different files.
 */
const cronLogger = winston.createLogger({
    level: 'info',
    format: combine(
        timestamp(),
        printf(({ message }) => message) // A very simple format for the cron log
    ),
    transports: [
        new winston.transports.File({ filename: path.join(USER_PATH_LOCAL, 'cron.log') })
    ]
});

module.exports = { logger, cronLogger };