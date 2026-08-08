const fs = require('fs').promises;
const path = require('path');
const { logger } = require('./logger.js');

const USER_PATH_LOCAL = process.env.USER_PATH || "./";
const CONFIG_FILE = path.join(USER_PATH_LOCAL, 'config.json');

/**
 * Ensures a configuration file exists, creating a default one if necessary.
 */
async function initializeConfig() {
    try {
        await fs.access(CONFIG_FILE);
    } catch {
        logger.info('[ConfigManager] No config file found. Creating a default one.');
        const defaultConfig = {
            port: 3999,
            databaseUrl: "",
            ibkrAddresses: [
                { host: '127.0.0.1', port: 7497 },
                { host: '', port: 7497 }
            ],
            ibkrFlexToken: '',
            ibkrFlexQueryId: '',
        };
        await fs.writeFile(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    }
}

/**
 * Loads the configuration from the file.
 * @returns {Promise<object>} The configuration object.
 */
async function loadConfig() {
    await initializeConfig();
    const configData = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(configData);
}

/**
 * Saves the provided configuration object to the file.
 * @param {object} config - The configuration object to save.
 */
async function saveConfig(config) {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

module.exports = {
    loadConfig,
    saveConfig,
};
