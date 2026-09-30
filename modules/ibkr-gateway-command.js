const net = require('net');
const path = require('path');
const fs = require('fs').promises;
const { logger } = require('./logger.js');

// Sends commands to IBC's command server inside IB Gateway (IBC's
// CommandServerPort; its ControlFrom setting must allow this app's host).
// Used to ask the gateway to reconnect to IBKR's data servers when it stops
// answering historical-data requests, which it can do after reconnecting to
// IBKR while its API connection stays up. Configured in config.json as
// `ibkrGatewayCommandAddress: { "host": "ib-gateway", "port": 7462 }`;
// without it nothing is sent.
const USER_PATH_LOCAL = process.env.USER_PATH || './';
const CONFIG_FILE = path.join(USER_PATH_LOCAL, 'config.json');
const RECONNECT_INTERVAL_MS = 15 * 60 * 1000;

let lastReconnect = null; // { at, ok, reply }
let reconnectInFlight = false;

async function loadCommandAddress() {
  try {
    const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'));
    const a = config.ibkrGatewayCommandAddress;
    return a && a.host && a.port ? { host: a.host, port: Number(a.port) } : null;
  } catch {
    return null;
  }
}

function sendCommand({ host, port }, command, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let reply = '';
    const socket = net.connect(port, host, () => socket.write(`${command}\n`));
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no reply within ${timeoutMs / 1000} s`)); }, timeoutMs);
    socket.on('data', (d) => {
      reply += d.toString();
      // IBC answers "OK" or an error line once the command is done.
      if (reply.includes('\n')) { clearTimeout(timer); socket.end(); resolve(reply.trim()); }
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    socket.on('close', () => { clearTimeout(timer); resolve(reply.trim()); });
  });
}

const RESTART_AFTER_MS = 5 * 60 * 1000;
const RESTART_INTERVAL_MS = 60 * 60 * 1000;
let lastRestart = null; // { at, ok, reply }

async function send(address, command) {
  try {
    const reply = await sendCommand(address, command);
    const ok = /^OK\b/i.test(reply);
    (ok ? logger.info : logger.error)(`[IBKR gateway] ${command} reply: ${reply || '(none)'}`);
    return { at: new Date().toISOString(), ok, reply };
  } catch (err) {
    logger.error(`[IBKR gateway] ${command} failed: ${err.message}`);
    return { at: new Date().toISOString(), ok: false, reply: err.message };
  }
}

const since = (entry) => (entry ? Date.now() - new Date(entry.at).getTime() : Infinity);

/**
 * Called while historical requests keep failing. First asks the gateway to
 * reconnect its data connections (RECONNECTDATA, at most every 15 minutes).
 * If requests still fail 5 minutes after that, restarts the gateway
 * application (RESTART, at most once an hour): IBC logs in again by itself,
 * like the nightly auto-restart. Needed because after IBKR's daily server
 * reset the gateway can report its historical-data farms as broken
 * (e.g. "HMDS data farm connection is broken: ushmds") and RECONNECTDATA
 * doesn't bring them back, while a fresh login does. Does nothing when no
 * command address is configured.
 */
async function requestDataReconnect(reason) {
  if (reconnectInFlight) return;
  // A restart takes a minute or two; failures meanwhile are expected.
  if (since(lastRestart) < RESTART_AFTER_MS) return;
  // Claimed before the first await, so failures arriving together don't
  // each send a command.
  reconnectInFlight = true;
  try {
    const address = await loadCommandAddress();
    if (!address) return;
    if (since(lastReconnect) >= RECONNECT_INTERVAL_MS) {
      logger.warn(`[IBKR gateway] Historical data not answering (${reason}); sending RECONNECTDATA to ${address.host}:${address.port}.`);
      lastReconnect = await send(address, 'RECONNECTDATA');
    } else if (since(lastReconnect) >= RESTART_AFTER_MS && since(lastRestart) >= RESTART_INTERVAL_MS) {
      logger.warn(`[IBKR gateway] Still no historical data ${Math.round(since(lastReconnect) / 60000)} min after RECONNECTDATA (${reason}); sending RESTART to ${address.host}:${address.port}.`);
      lastRestart = await send(address, 'RESTART');
    }
  } finally {
    reconnectInFlight = false;
  }
}

function getLastReconnect() {
  return lastReconnect;
}

function getLastRestart() {
  return lastRestart;
}

module.exports = { requestDataReconnect, getLastReconnect, getLastRestart, sendCommand };
