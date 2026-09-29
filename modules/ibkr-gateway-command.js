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

/**
 * Asks the gateway to reconnect its data connections, at most once per
 * RECONNECT_INTERVAL_MS. Returns without doing anything when no command
 * address is configured.
 */
async function requestDataReconnect(reason) {
  if (reconnectInFlight) return;
  if (lastReconnect && Date.now() - new Date(lastReconnect.at).getTime() < RECONNECT_INTERVAL_MS) return;
  const address = await loadCommandAddress();
  if (!address) return;
  reconnectInFlight = true;
  try {
    logger.warn(`[IBKR gateway] Historical data not answering (${reason}); sending RECONNECTDATA to ${address.host}:${address.port}.`);
    const reply = await sendCommand(address, 'RECONNECTDATA');
    const ok = /^OK\b/i.test(reply);
    lastReconnect = { at: new Date().toISOString(), ok, reply };
    (ok ? logger.info : logger.error)(`[IBKR gateway] RECONNECTDATA reply: ${reply || '(none)'}`);
  } catch (err) {
    lastReconnect = { at: new Date().toISOString(), ok: false, reply: err.message };
    logger.error(`[IBKR gateway] RECONNECTDATA failed: ${err.message}`);
  } finally {
    reconnectInFlight = false;
  }
}

function getLastReconnect() {
  return lastReconnect;
}

module.exports = { requestDataReconnect, getLastReconnect, sendCommand };
