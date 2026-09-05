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
            // Separate Flex credentials per paper-vs-real, since that's a
            // property of which IBKR account the Flex Query was generated
            // against — see the migration note in loadConfig() below.
            ibkrFlexTokenReal: '',
            ibkrFlexQueryIdActivityReal: '',
            ibkrFlexQueryIdTradeConfReal: '',
            ibkrFlexTokenPaper: '',
            ibkrFlexQueryIdActivityPaper: '',
            ibkrFlexQueryIdTradeConfPaper: '',
        };
        await fs.writeFile(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    }
}

/**
 * Existing installs have a single Flex token/query-ID set
 * (ibkrFlexToken/ibkrFlexQueryIdActivity/ibkrFlexQueryIdTradeConf) with no
 * notion of paper vs. real — it was written back when the app only ever
 * assumed one IBKR account. Fold that single set into the new "Real" slot
 * (the far more common existing use case) the first time this runs, then
 * drop the old keys so there's only ever one place these credentials live.
 * A no-op past the first run on any given install.
 */
function migrateFlexConfig(config) {
    const hadOldFields = 'ibkrFlexToken' in config || 'ibkrFlexQueryIdActivity' in config || 'ibkrFlexQueryIdTradeConf' in config;
    if (!hadOldFields) return false;

    if (config.ibkrFlexTokenReal === undefined) config.ibkrFlexTokenReal = config.ibkrFlexToken || '';
    if (config.ibkrFlexQueryIdActivityReal === undefined) config.ibkrFlexQueryIdActivityReal = config.ibkrFlexQueryIdActivity || '';
    if (config.ibkrFlexQueryIdTradeConfReal === undefined) config.ibkrFlexQueryIdTradeConfReal = config.ibkrFlexQueryIdTradeConf || '';
    if (config.ibkrFlexTokenPaper === undefined) config.ibkrFlexTokenPaper = '';
    if (config.ibkrFlexQueryIdActivityPaper === undefined) config.ibkrFlexQueryIdActivityPaper = '';
    if (config.ibkrFlexQueryIdTradeConfPaper === undefined) config.ibkrFlexQueryIdTradeConfPaper = '';

    delete config.ibkrFlexToken;
    delete config.ibkrFlexQueryId; // even older field, superseded by ...Activity/...TradeConf long ago
    delete config.ibkrFlexQueryIdActivity;
    delete config.ibkrFlexQueryIdTradeConf;
    return true;
}

/**
 * Loads the configuration from the file.
 * @returns {Promise<object>} The configuration object.
 */
async function loadConfig() {
    await initializeConfig();
    const configData = await fs.readFile(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(configData);
    if (migrateFlexConfig(config)) {
        await saveConfig(config);
    }
    return config;
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
