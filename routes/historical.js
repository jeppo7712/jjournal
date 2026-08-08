/*
rules:

populating the database with historical data for a specific symbol and timeframe:

There shall always be at least the following data history in the database (see requiredDurations in historical-data-service.js): 5 years of 15M; 3 years of 1W, 1D, 5M; 1.5 years of 1H and 4H; 1 month of 1M.
If if's not possible to fetch this historical duration, the data will be fetched as far back as possible (Maybe Yahoo certain limits, Maybe IBKR has certain limits).
The goal is to have no gaps in the data -taking into account the exchange opening times.
The data shall always be up to date -taking exchange opening times into account. 
Up to date means: for example for the 1h timeframe, if the last bar in the database is from 3 hours ago, it needs to fetch the last 3 bars. 
The database shall be filled as soon as possible from Yahoo, meaning fetching from Yahoo will be attempted first, because it is fast and almost always available.
Data from IBKR is higher quality but maybe not always available due to no connection to TWS.
So after all data is fetched (or tried to be fetched) from Yahoo, data will be fetched from IBKR.
IBKR or Yahoo data already in the database does not need to be refetched
When fetching futures contracts from IBKR, data will be fetched for the individual contracts, not for the continuous contract.
When fetching futures contracts from IBKR, data will be fetched including the current and the next contract so a proper continuous series can be built.
When fetching futures contracts from Yahoo, the data will be in continuous series format as per Yahoo specification.
It is not needed to keep Yahoo data in the database up to the point where IBKR data is available (as a result of the rules below)

Preparing futures data for a requester:

IBKR data for futures contracts will be used to build a continuous series of futures data, based on volume.
An IBKR futures continuous series will be kept in the database based on the individual contracts.
As soon as new futures data from IBKR is done fetching and placed in the database, the IBKR futures continuous series will be updated.
There is no need to "prepare" IBKR data for stocks.

providing the data to a requester:

Data already in the database will be provided immediately if requested. 
As soon as newly fetched data is in the database (and processing on the data to form continuous series is done) it will be provided.
IBKR data is of higher quality than yahoo data, so if both are available, ibkr data will be used.
IBKR data for futures contracts will taken from the "prepared" continuous series
It will be checked until which point IBKR data is available. If after that point yahoo data is available, the data provided will be extended with yahoo data.
Before this point, only IBKR data will be provided, after that point only Yahoo data will be provided. For the rest yahoo and IBKR data will not be mixed.
If no IBKR data is available, only Yahoo data will be provided.
The requester shall always know the origin of the data (IBKR or Yahoo), and the contract month for futures contracts.
It shall be possible for a requester to request data for a specific period.
*/

const express = require('express');
const router = express.Router();
const { DateTime } = require('luxon');
const yahoo = require('../modules/yahoo.js');
const { getExchangeInfo } = require('../modules/historical-data-service'); // Assuming getExchangeInfo is exported
const dummyBroadcast = () => { };
const { logger } = require('../modules/logger.js');

module.exports = (db, taskManager, historicalDataService, broadcastStatus, uuidv4, triggerTaskProcessor) => {

    const { VALID_TIMEFRAMES, rebuildContinuousSeriesForSymbol, getEnabledTimeframes, getYahooMaxLookbackDays } = historicalDataService;

    router.get('/historical/db', async (req, res) => {
        // ADD startDate and endDate to the destructuring
        const { symbol: requestedSymbolParam, type = 'FUT', contractMonth, timeframe: requestedTimeframe, noRefresh, startDate, endDate } = req.query;
        const apiRequestId = uuidv4();

        if (!requestedSymbolParam || !requestedTimeframe) {
            return res.status(400).json({ error: 'Symbol and timeframe are required' });
        }
        const requestedSymbol = requestedSymbolParam.toUpperCase(); // Standardize symbol

        if (!VALID_TIMEFRAMES.includes(requestedTimeframe)) {
            return res.status(400).json({ error: `Invalid timeframe: ${requestedTimeframe}. Valid timeframes are: ${VALID_TIMEFRAMES.join(', ')}` });
        }
        logger.debug(`[Historical/DB] API Request: symbol=${requestedSymbol}, timeframe=${requestedTimeframe}, type=${type}, contractMonth=${contractMonth || 'N/A'}, apiRequestId=${apiRequestId}, noRefresh=${noRefresh}, startDate=${startDate || 'N/A'}, endDate=${endDate || 'N/A'}`);

        try {
            const { rows: futuresSettingsRows } = await db.getPool().query(
                'SELECT id, rollover_months, exchange, timeframe_settings FROM futures_settings WHERE symbol = $1 AND type = $2',
                [requestedSymbol, type]
            );
            if (futuresSettingsRows.length === 0) {
                return res.status(404).json({ error: `No futures settings found for symbol ${requestedSymbol}` });
            }
            const futuresSetting = futuresSettingsRows[0];
            const futuresSettingId = futuresSetting.id;

            const noRefreshFlag = noRefresh === 'true';
            // Existing data for a disabled timeframe is still served below (so
            // previously-fetched charts remain viewable) — it just stops being
            // actively (re)fetched, which is the point of disabling it.
            const timeframeEnabled = getEnabledTimeframes(futuresSetting.timeframe_settings).includes(requestedTimeframe);

            if (!noRefreshFlag && timeframeEnabled) {
                // --- Task Management Logic on New User Request ---
                // The PENDING QUEUE only ever loses *foreground* tasks (priority
                // 10/20 — tied to a chart the user was just looking at) for some
                // OTHER symbol, never background/cron work — this used to cancel
                // any pending task for a different symbol regardless of priority,
                // which meant simply opening a chart while a bulk backfill was
                // running would silently wipe out the rest of that backlog for
                // every other symbol. See getNextPendingTask for the matching
                // priority fix that makes a foreground request jump the pending
                // queue without needing to touch it at all.
                //
                // The CURRENTLY RUNNING task is different: it's fine to abort it
                // even if it's background/cron work, regardless of the new
                // request's symbol. Cancelling used to discard everything that
                // task had fetched so far (a since-fixed bug — see the
                // transaction-scope fix in populateHistoricalData), so this used
                // to be genuinely destructive; now the interrupted task's
                // progress is preserved and it simply resumes on its next run.
                // Without this, a long-running background fetch (1-minute data
                // can run for hours) would block a genuinely urgent foreground
                // request — e.g. opening a new trade's reference chart — for
                // however long it takes to finish, even though the task queue
                // otherwise correctly prioritizes the foreground request.
                const isForegroundTask = (t) =>
                    t.priority === taskManager.PRIORITY.USER_FOREGROUND_YAHOO ||
                    t.priority === taskManager.PRIORITY.USER_FOREGROUND_IBKR;

                const currentRunningTask = taskManager.getCurrentTask();
                if (currentRunningTask && currentRunningTask.symbol !== requestedSymbol) {
                    logger.debug(`[TaskManager] User switched to ${requestedSymbol}. Current task for ${currentRunningTask.symbol} (${currentRunningTask.id}) will be cancelled (progress already fetched is preserved).`);
                    currentRunningTask.cancellationController.abort();
                }
                let pendingCancelledCount = 0;
                taskManager.getQueue().forEach(task => {
                    if (task.symbol !== requestedSymbol && task.status === taskManager.TASK_STATUS.PENDING && isForegroundTask(task)) {
                        task.cancellationController.abort();
                        task.status = taskManager.TASK_STATUS.CANCELLED;
                        pendingCancelledCount++;
                    }
                });
                if (pendingCancelledCount > 0) {
                    logger.debug(`[TaskManager] Cancelled ${pendingCancelledCount} pending foreground tasks for other symbols.`);
                    taskManager.setQueue(taskManager.getQueue().filter(task => task.status !== taskManager.TASK_STATUS.CANCELLED));
                }


                taskManager.setQueue(taskManager.getQueue().filter(task =>
                    !(task.symbol === requestedSymbol && task.timeframe === requestedTimeframe && task.status === taskManager.TASK_STATUS.PENDING)
                ));

                const COOLDOWN_PERIOD_MS = 60000;
                const userRequestIdBase = `user_chart_${requestedSymbol}_${requestedTimeframe}`;
                const lastForegroundActivity = taskManager.getRecentCompletions().get(`${requestedSymbol}-${requestedTimeframe}-user_initiated_fg`);
                if (!lastForegroundActivity || (Date.now() - lastForegroundActivity > COOLDOWN_PERIOD_MS)) {
                    logger.debug(`[Historical/DB] Cooldown passed for ${requestedSymbol} ${requestedTimeframe}. Queuing foreground tasks.`);
                    taskManager.addTask(requestedSymbol, requestedTimeframe, 'yahoo_only', taskManager.PRIORITY.USER_FOREGROUND_YAHOO, `${userRequestIdBase}_yahoo_prio`, contractMonth, type);
                    taskManager.addTask(requestedSymbol, requestedTimeframe, 'ibkr_only', taskManager.PRIORITY.USER_FOREGROUND_IBKR, `${userRequestIdBase}_ibkr_prio`, contractMonth, type);
                }
                logger.debug(`[Historical/DB] Prioritized tasks for ${requestedSymbol} ${requestedTimeframe} (potentially) queued. Full sweep deferred to cron.`);
                triggerTaskProcessor();
            }

            const processedBars = await historicalDataService.getMergedHistoricalSeries({
                futuresSettingId,
                type,
                contractMonth: contractMonth || null,
                timeframe: requestedTimeframe,
                startDate,
                endDate,
            });

            if (processedBars.length > 0 || noRefreshFlag) {
                logger.debug(`[Historical/DB] Returning ${processedBars.length} existing bars for ${requestedSymbol} (${requestedTimeframe})`);
                if (!res.headersSent) res.json(processedBars);
            } else {
                if (!res.headersSent) {
                    logger.debug(`[Historical/DB] No data for ${requestedSymbol} (${requestedTimeframe}) yet, responding 202 as population tasks are queued.`);
                    broadcastStatus(apiRequestId, `No historical data for ${requestedSymbol} (${requestedTimeframe}), population tasks queued.`, 'info');
                    res.status(202).json({ message: `Data population tasks queued for ${requestedSymbol} (${requestedTimeframe}), check WebSocket for updates.` });
                }
            }
        } catch (err) {
            logger.error(`[Historical/DB] Error processing API request for ${requestedSymbol} at ${requestedTimeframe}: ${err.message}`);
            broadcastStatus(apiRequestId, `Failed to fetch historical data: ${err.message}`, 'error');
            if (!res.headersSent) {
                res.status(500).json({ error: `Failed to fetch historical data: ${err.message}` });
            }
        }
    });

    // Whether a symbol+timeframe's continuous series has ANY rollover point
    // at all, independent of what a chart currently has loaded. The main
    // chart data fetch (/historical/db) is bounded to a window around the
    // trade being viewed (see BARS_PADDING_BACKGROUND in TradeView.jsx) —
    // for a quarterly futures contract, the actual rollover date is often
    // months outside that window, so checking the loaded bars alone used to
    // make the "Continuous" toggle and rollover markers silently disappear
    // even though the symbol genuinely has rollovers, just not within the
    // currently-loaded range. This is a cheap, separate, index-assisted
    // EXISTS check, not tied to how much history is actually loaded.
    router.get('/historical/has-rollover', async (req, res) => {
        const { symbol, type = 'FUT', timeframe } = req.query;
        if (!symbol || !timeframe) {
            return res.status(400).json({ error: 'Symbol and timeframe are required' });
        }
        try {
            const { rows: settingRows } = await db.getPool().query(
                'SELECT id FROM futures_settings WHERE symbol = $1 AND type = $2',
                [symbol.toUpperCase(), type]
            );
            if (settingRows.length === 0) {
                return res.status(404).json({ error: `No futures settings found for symbol ${symbol}` });
            }
            const { rows } = await db.getPool().query(
                `SELECT EXISTS(
                    SELECT 1 FROM historical_data
                    WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = TRUE AND is_rollover = TRUE
                ) AS has_rollover`,
                [settingRows[0].id, timeframe]
            );
            res.json({ hasRollover: rows[0].has_rollover });
        } catch (err) {
            logger.error(`[Historical/has-rollover] ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });


    // DELETE /historical-data
    router.delete('/historical-data', async (req, res) => {
        const { symbol, type } = req.query;
        if (!symbol || !type) {
            return res.status(400).json({ error: 'Symbol and type are required' });
        }
        try {
            const { rows } = await db.getPool().query('SELECT id FROM futures_settings WHERE symbol = $1 AND type = $2', [symbol, type]);
            if (rows.length === 0) {
                return res.status(404).json({ error: 'Symbol and type not found' });
            }
            const futuresSettingId = rows[0].id;
            await db.getPool().query('DELETE FROM historical_data WHERE futures_setting_id = $1', [futuresSettingId]);
            res.json({ success: true });
        } catch (err) {
            logger.error('Error deleting historical data:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/historical-data/all', async (req, res) => {
        try {
            await db.getPool().query('TRUNCATE TABLE historical_data RESTART IDENTITY;');
            broadcastStatus(uuidv4(), 'All historical data has been deleted.', 'success');
            res.json({ success: true, message: 'All historical data has been successfully deleted.' });
        } catch (err) {
            logger.error('Error deleting all historical data:', err);
            broadcastStatus(uuidv4(), `Failed to delete all historical data: ${err.message}`, 'error');
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/historical-data/populate-all', async (req, res) => {
        const manualRunId = uuidv4();
        logger.debug(`[API/PopulateAll:${manualRunId}] Manual full data population triggered.`);
        broadcastStatus(manualRunId, 'Full historical data population initiated...', 'info');

        try {
            const { rows: allSymbols } = await db.getPool().query(
                'SELECT symbol, type, timeframe_settings FROM futures_settings WHERE symbol != $1', ['DEFAULT']
            );

            if (allSymbols.length === 0) {
                logger.debug(`[API/PopulateAll:${manualRunId}] No symbols configured to populate.`);
                broadcastStatus(manualRunId, 'No symbols configured to populate.', 'warning');
                return res.status(404).json({ message: 'No symbols configured to populate.' });
            }

            logger.debug(`[API/PopulateAll:${manualRunId}] Adding tasks for ${allSymbols.length} symbols.`);
            for (const { symbol, type, timeframe_settings } of allSymbols) {
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
                        const taskDesc = `${symbol} (${timeframe}, contract: ${contractMonth || 'cont.'}, type: ${type})`;
                        taskManager.addTask(symbol, timeframe, 'full', taskManager.PRIORITY.CRON_FULL_POPULATION, `manual_full_population_${manualRunId}`, contractMonth, type);
                    }
                }
            }

            triggerTaskProcessor(); // Make sure the processor is running

            const successMsg = `Successfully queued population tasks for ${allSymbols.length} symbols.`;
            logger.debug(`[API/PopulateAll:${manualRunId}] ${successMsg}`);
            broadcastStatus(manualRunId, successMsg, 'success');
            res.json({ success: true, message: successMsg, requestId: manualRunId });

        } catch (err) {
            logger.error(`[API/PopulateAll:${manualRunId}] Error during full data population setup: ${err.message}`);
            broadcastStatus(manualRunId, `Error setting up population tasks: ${err.message}`, 'error');
            res.status(500).json({ error: `Error setting up population tasks: ${err.message}` });
        }
    });


    router.post('/historical-data/populate-symbol', async (req, res) => {
        const { symbol, type } = req.body;
        const manualRunId = uuidv4();

        if (!symbol || !type) {
            return res.status(400).json({ error: 'symbol and type are required.' });
        }

        logger.debug(`[API/PopulateSymbol:${manualRunId}] Manual data population triggered for ${symbol} (${type}).`);
        broadcastStatus(manualRunId, `Population for ${symbol} (${type}) initiated...`, 'info');

        try {
            const { rows: symbolSettings } = await db.getPool().query(
                'SELECT symbol, type, timeframe_settings FROM futures_settings WHERE symbol = $1 AND type = $2', [symbol.toUpperCase(), type.toUpperCase()]
            );

            if (symbolSettings.length === 0) {
                logger.debug(`[API/PopulateSymbol:${manualRunId}] No settings configured for ${symbol} (${type}).`);
                broadcastStatus(manualRunId, `No settings configured for ${symbol} (${type}).`, 'warning');
                return res.status(404).json({ message: `No settings configured for ${symbol} (${type}).` });
            }

            const { symbol: dbSymbol, type: dbType, timeframe_settings } = symbolSettings[0];

            let contractMonthsToProcess = [null]; // Default for STK and continuous FUT
            if (dbType === 'FUT') {
                const { rows: tradeRows } = await db.getPool().query(
                    'SELECT DISTINCT contract_month FROM trades WHERE symbol = $1 AND type = $2 AND contract_month IS NOT NULL',
                    [dbSymbol, dbType]
                );
                contractMonthsToProcess = [null, ...new Set(tradeRows.map(row => row.contract_month))];
            }

            const enabledTimeframes = getEnabledTimeframes(timeframe_settings);
            for (const contractMonth of contractMonthsToProcess) {
                for (const timeframe of enabledTimeframes) {
                    taskManager.addTask(dbSymbol, timeframe, 'full', taskManager.PRIORITY.USER_BACKGROUND_YAHOO, `manual_symbol_population_${manualRunId}`, contractMonth, dbType);
                }
            }

            triggerTaskProcessor();

            const successMsg = `Successfully queued population tasks for ${dbSymbol} (${dbType}).`;
            logger.debug(`[API/PopulateSymbol:${manualRunId}] ${successMsg}`);
            broadcastStatus(manualRunId, successMsg, 'success');
            res.json({ success: true, message: successMsg, requestId: manualRunId });
        } catch (err) {
            logger.error(`[API/PopulateSymbol:${manualRunId}] Error during data population setup for ${symbol}: ${err.message}`);
            broadcastStatus(manualRunId, `Error setting up population tasks: ${err.message}`, 'error');
            res.status(500).json({ error: `Error setting up population tasks: ${err.message}` });
        }
    });


    // GET /yahoo-finance/:symbol
    router.get('/yahoo-finance/:symbol', async (req, res) => {
        const { symbol } = req.params;
        const requestId = uuidv4();

        if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol) && !/^[A-Z0-9.\-]+=.*$/.test(symbol)) {
            broadcastStatus(requestId, `Invalid symbol format: ${symbol}`, 'error');
            return res.status(400).json({ error: 'Invalid symbol format' });
        }

        broadcastStatus(requestId, `Fetching Yahoo Finance data for ${symbol}`, 'info');

        try {
            let data;

            try {
                data = await yahoo.quote(symbol);
            } catch (quoteError) {
                logger.warn(`[YahooFinance] Quote for ${symbol} failed: ${quoteError.message}. Attempting quoteSummary.`);
                broadcastStatus(requestId, `Quote for ${symbol} failed, trying alternative fetch.`, 'warn');

                try {
                    const quoteSummaryResult = await yahoo._internal.yfClient.quoteSummary(symbol, {
                        modules: ['price', 'summaryDetail']
                    });

                    if (quoteSummaryResult && quoteSummaryResult.price) {
                        data = quoteSummaryResult.price;
                        if (quoteSummaryResult.summaryDetail && quoteSummaryResult.summaryDetail.marketState) {
                            data.marketState = quoteSummaryResult.summaryDetail.marketState;
                        }
                    } else {
                        throw new Error(`No price data found in quoteSummary for ${symbol}`);
                    }
                } catch (quoteSummaryError) {
                    logger.error(`[YahooFinance] quoteSummary for ${symbol} also failed: ${quoteSummaryError.message}`);
                    throw new Error(`Failed to fetch data using quote or quoteSummary for ${symbol}: ${quoteSummaryError.message}`);
                }
            }


            if (!data) {
                broadcastStatus(requestId, `No data returned for ${symbol} from Yahoo Finance`, 'error');
                return res.status(404).json({ error: 'No data found for symbol' });
            }

            let latestPrice = null;
            let priceSource = null;

            if (typeof data.regularMarketPrice === 'number') {
                latestPrice = data.regularMarketPrice;
                priceSource = 'regularMarketPrice';
            } else if (typeof data.postMarketPrice === 'number' && data.marketState === 'POST') {
                latestPrice = data.postMarketPrice;
                priceSource = 'postMarketPrice';
            } else if (typeof data.preMarketPrice === 'number' && data.marketState === 'PRE') {
                latestPrice = data.preMarketPrice;
                priceSource = 'preMarketPrice';
            } else if (typeof data.bid === 'number') {
                latestPrice = data.bid;
                priceSource = 'bid';
            } else if (typeof data.ask === 'number') {
                latestPrice = data.ask;
            }

            if (latestPrice === null) {
                logger.warn(`[YahooFinance] No valid price found for ${symbol}: ${JSON.stringify(data)}`);
                broadcastStatus(requestId, `No valid price available for ${symbol}`, 'error');
                return res.status(404).json({ error: 'No valid price available for symbol' });
            }

            const response = {
                symbol: data.symbol || symbol,
                price: latestPrice,
                priceSource,
                marketState: data.marketState || 'UNKNOWN',
                // See routes/external.js's /quote/:symbol for why this checks
                // instanceof Date first — modules/yahoo.js's client-library path
                // returns regularMarketTime as an already-parsed Date, and
                // multiplying that by 1000 (assuming raw epoch seconds) produces a
                // garbage far-future timestamp.
                lastUpdated: data.regularMarketTime
                    ? (data.regularMarketTime instanceof Date
                        ? data.regularMarketTime.toISOString()
                        : new Date(data.regularMarketTime * 1000).toISOString())
                    : new Date().toISOString()
            };

            logger.debug(`[YahooFinance] Retrieved price for ${symbol}: ${latestPrice} (${priceSource}, marketState: ${data.marketState || 'N/A'})`);
            broadcastStatus(requestId, `Retrieved price ${latestPrice} for ${symbol} from Yahoo Finance`, 'success');
            res.json(response);
        } catch (error) {
            logger.error(`[YahooFinance] Failed to fetch data for ${symbol}: ${error.message}`);
            broadcastStatus(requestId, `Failed to fetch Yahoo Finance data for ${symbol}: ${error.message}`, 'error');
            res.status(500).json({ error: `Failed to fetch stock price: ${error.message}` });
        }
    });

    router.post('/historical/rollover-override', async (req, res) => {
        const { symbol, type, from_contract_month, to_contract_month, override_date } = req.body;

        if (!symbol || !type || !from_contract_month || !to_contract_month || !override_date) {
            return res.status(400).json({ error: 'symbol, type, from_contract_month, to_contract_month, and override_date are required.' });
        }

        try {
            const { rows: fsRows } = await db.getPool().query('SELECT id FROM futures_settings WHERE symbol = $1 AND type = $2', [symbol, type]);
            if (fsRows.length === 0) return res.status(404).json({ error: `Settings not found for ${symbol} (${type})` });
            const futuresSettingId = fsRows[0].id;

            await db.getPool().query(
                `INSERT INTO futures_rollover_overrides (futures_setting_id, from_contract_month, to_contract_month, override_date)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (futures_setting_id, from_contract_month, to_contract_month)
                 DO UPDATE SET override_date = EXCLUDED.override_date, updated_at = NOW()`,
                [futuresSettingId, from_contract_month, to_contract_month, override_date]
            );

            // Trigger the rebuild process
            await rebuildContinuousSeriesForSymbol(symbol, type);

            res.status(200).json({ success: true, message: 'Rollover override saved and continuous series are being updated.' });
        } catch (err) {
            logger.error(`[API/rollover-override] Error saving override: ${err.message}`);
            res.status(500).json({ error: 'Failed to save rollover override.' });
        }
    });

    router.delete('/historical/rollover-override', async (req, res) => {
        const { symbol, type, from_contract_month, to_contract_month } = req.body;

        if (!symbol || !type || !from_contract_month || !to_contract_month) {
            return res.status(400).json({ error: 'symbol, type, from_contract_month, and to_contract_month are required.' });
        }

        try {
            const { rows: fsRows } = await db.getPool().query('SELECT id FROM futures_settings WHERE symbol = $1 AND type = $2', [symbol, type]);
            if (fsRows.length === 0) return res.status(404).json({ error: `Settings not found for ${symbol} (${type})` });
            const futuresSettingId = fsRows[0].id;

            await db.getPool().query(
                'DELETE FROM futures_rollover_overrides WHERE futures_setting_id = $1 AND from_contract_month = $2 AND to_contract_month = $3',
                [futuresSettingId, from_contract_month, to_contract_month]
            );

            // Trigger the rebuild process
            await rebuildContinuousSeriesForSymbol(symbol, type);

            res.status(200).json({ success: true, message: 'Rollover override deleted and continuous series are being updated.' });
        } catch (err) {
            logger.error(`[API/rollover-override] Error deleting override: ${err.message}`);
            res.status(500).json({ error: 'Failed to delete rollover override.' });
        }
    });


    router.get('/historical/summary', async (req, res) => {
        const { symbol, type } = req.query;

        if (!symbol || !type) {
            return res.status(400).json({ error: 'Symbol and type are required' });
        }

        try {
            const { rows: futuresSettingsRows } = await db.getPool().query(
                'SELECT id, exchange FROM futures_settings WHERE symbol = $1 AND type = $2',
                [symbol.toUpperCase(), type.toUpperCase()]
            );

            if (futuresSettingsRows.length === 0) {
                return res.status(404).json({ error: `Settings not found for symbol ${symbol} (${type})` });
            }
            const { id: futuresSettingId, exchange } = futuresSettingsRows[0];

            // Fetch exchange info with a dummy broadcast function
            const exchangeInfo = await historicalDataService.getExchangeInfo(exchange, dummyBroadcast);
            const exchangeTimezone = exchangeInfo.timezone;

            // --- Create Response Structure ---
            const response = {
                symbol: symbol.toUpperCase(),
                type: type.toUpperCase(),
                exchangeTimezone,
                timeframes: {}
            };
            const VALID_TIMEFRAMES = ['1M', '5M', '15M', '1H', '4H', '1D', '1W'];
            VALID_TIMEFRAMES.forEach(tf => {
                response.timeframes[tf] = {};
            });

            // --- Query and Process Non-Continuous Data (Yahoo, Individual IBKR Contracts) ---
            const nonContinuousQuery = `
            SELECT timeframe, source, contract_month, MIN(time) AS earliest, MAX(time) AS latest
            FROM historical_data
            WHERE futures_setting_id = $1 AND is_continuous = FALSE
            GROUP BY timeframe, source, contract_month;
        `;
            const { rows: nonContinuousRows } = await db.getPool().query(nonContinuousQuery, [futuresSettingId]);

            nonContinuousRows.forEach(row => {
                const { timeframe, source, contract_month, earliest, latest } = row;
                const tfData = response.timeframes[timeframe];
                if (!tfData) return;
                const dataPoint = {
                    earliest: DateTime.fromJSDate(earliest).toISO(),
                    latest: DateTime.fromJSDate(latest).toISO()
                };
                if (source.toUpperCase() === 'YAHOO') {
                    tfData.yahoo = dataPoint;
                } else if (source.toUpperCase() === 'IBKR') {
                    if (type.toUpperCase() === 'FUT') {
                        if (!tfData.ibkrContracts) tfData.ibkrContracts = {};
                        if (contract_month) tfData.ibkrContracts[contract_month] = dataPoint;
                    } else {
                        tfData.ibkr = dataPoint;
                    }
                }
            });

            // --- Query and Process Continuous Data (for Min/Max and Rollovers) ---
            if (type.toUpperCase() === 'FUT') {
                const continuousQuery = `
                    SELECT timeframe, time, contract_month, is_rollover, rollover_type
                FROM historical_data
                WHERE futures_setting_id = $1 AND is_continuous = TRUE
                ORDER BY timeframe, time ASC;
            `;
                const { rows: continuousRows } = await db.getPool().query(continuousQuery, [futuresSettingId]);

                const continuousByTimeframe = continuousRows.reduce((acc, row) => {
                    if (!acc[row.timeframe]) acc[row.timeframe] = [];
                    acc[row.timeframe].push(row);
                    return acc;
                }, {});

                Object.entries(continuousByTimeframe).forEach(([timeframe, bars]) => {
                    if (bars.length === 0) return;
                    const tfData = response.timeframes[timeframe];

                    const continuousInfo = {
                        earliest: DateTime.fromJSDate(bars[0].time).toISO(),
                        latest: DateTime.fromJSDate(bars[bars.length - 1].time).toISO(),
                        rollovers: []
                    };

                    for (let i = 1; i < bars.length; i++) {
                        const prevBar = bars[i - 1];
                        const currBar = bars[i];
                        if (currBar.is_rollover && prevBar.contract_month && currBar.contract_month && prevBar.contract_month !== currBar.contract_month) {
                            continuousInfo.rollovers.push({
                                date: DateTime.fromJSDate(currBar.time).toISO(),
                                from: prevBar.contract_month,
                                to: currBar.contract_month,
                                rollover_type: currBar.rollover_type
                            });
                        }
                    }
                    tfData.ibkrContinuous = continuousInfo;
                });
            }

            res.json(response);

        } catch (err) {
            logger.error(`[Historical/Summary] Error fetching summary for ${symbol} (${type}): ${err.message}`);
            res.status(500).json({ error: `Failed to fetch historical data summary: ${err.message}` });
        }
    });

    // Data-provider lookback limits for a symbol, so the Settings UI can warn
    // the user when a requested "amount"/"unit" for a timeframe exceeds what a
    // provider can actually deliver — without ever guessing: Yahoo's limits are
    // fixed/documented (getYahooMaxLookbackDays), IBKR's are only known once
    // actually discovered during a real fetch (see historical_data_bounds,
    // populated by fetchAndStoreIBKRContractData). A timeframe/contract with no
    // discovered IBKR bound simply has no ibkrEarliestAvailable entries yet —
    // that's not the same as "no limit", just "not learned yet".
    router.get('/historical/limits', async (req, res) => {
        const { symbol, type = 'FUT' } = req.query;

        if (!symbol) {
            return res.status(400).json({ error: 'symbol is required' });
        }

        try {
            const { rows: futuresSettingsRows } = await db.getPool().query(
                'SELECT id FROM futures_settings WHERE symbol = $1 AND type = $2',
                [symbol.toUpperCase(), type.toUpperCase()]
            );
            if (futuresSettingsRows.length === 0) {
                return res.status(404).json({ error: `Settings not found for symbol ${symbol} (${type})` });
            }
            const futuresSettingId = futuresSettingsRows[0].id;

            const { rows: boundRows } = await db.getPool().query(
                'SELECT contract_month, timeframe, earliest_available, checked_at FROM historical_data_bounds WHERE futures_setting_id = $1',
                [futuresSettingId]
            );

            const response = {
                symbol: symbol.toUpperCase(),
                type: type.toUpperCase(),
                timeframes: {},
            };

            VALID_TIMEFRAMES.forEach(tf => {
                response.timeframes[tf] = {
                    yahooMaxLookbackDays: getYahooMaxLookbackDays(tf),
                    ibkrEarliestAvailable: [],
                };
            });

            boundRows.forEach(row => {
                const tfData = response.timeframes[row.timeframe];
                if (!tfData) return;
                tfData.ibkrEarliestAvailable.push({
                    contractMonth: row.contract_month || null,
                    earliestAvailable: DateTime.fromJSDate(row.earliest_available, { zone: 'utc' }).toISO(),
                    checkedAt: DateTime.fromJSDate(row.checked_at, { zone: 'utc' }).toISO(),
                });
            });

            res.json(response);
        } catch (err) {
            logger.error(`[Historical/Limits] Error fetching limits for ${symbol} (${type}): ${err.message}`);
            res.status(500).json({ error: `Failed to fetch historical data limits: ${err.message}` });
        }
    });

    // Live progress for population tasks. The WebSocket status broadcasts made
    // during actual task execution (in populateHistoricalData) are keyed by each
    // individual task's own id — never the batch id returned by
    // populate-all/populate-symbol — so a frontend trying to correlate those by
    // requestId never sees anything past the initial "queued" message. Polling
    // the queue directly instead reflects real state and survives navigating
    // away and back (unlike a WebSocket log tied to a specific requestId).
    router.get('/historical/queue-status', (req, res) => {
        const currentTask = taskManager.getCurrentTask();
        const pending = taskManager.getQueue().filter(t => t.status === taskManager.TASK_STATUS.PENDING);

        const describe = (t) => ({
            symbol: t.symbol,
            timeframe: t.timeframe,
            phase: t.phase,
            contractMonth: t.contractMonth || null,
            type: t.type,
        });

        res.json({
            currentTask: currentTask ? describe(currentTask) : null,
            pendingCount: pending.length,
            pendingPreview: pending.slice(0, 8).map(describe),
            // Chunk-level detail for the currently-running task — a single
            // task can be chunking through several contracts concurrently
            // (see IBKR_CONCURRENCY_LIMIT), especially slow/opaque for
            // 1-minute data where one contract's backfill takes hours.
            activeChunks: historicalDataService.getActiveChunkProgress(),
            // What happened to the last N tasks (completed/failed/cancelled) —
            // lets a long, cron-driven backfill be checked for real failures at
            // a glance instead of scrolling raw logs. Newest first.
            recentOutcomes: taskManager.getRecentTaskOutcomes(),
        });
    });

    router.post('/historical/rebuild-continuous', async (req, res) => {
        const { symbol, type } = req.body;

        if (!symbol || !type) {
            return res.status(400).json({ error: 'symbol, type are required.' });
        }

        try {
            // Trigger the rebuild process
            await rebuildContinuousSeriesForSymbol(symbol, type);

            res.status(200).json({ success: true, message: 'Continuous series rebuild.' });
        } catch (err) {
            logger.error(`[API/rebuild-continuous] Error in continuous series rebuild: ${err.message}`);
            res.status(500).json({ error: 'Error in continuous series rebuild.' });
        }
    });

    // Rebuild the continuous series for every FUT symbol, one at a time. Runs in
    // the background — each rebuild scans that symbol's full raw history, so
    // doing this for every symbol can take a while; the response returns as soon
    // as the batch is queued rather than waiting for it all to finish.
    router.post('/historical/rebuild-continuous-all', async (req, res) => {
        const runId = uuidv4();

        try {
            const { rows: futuresSymbols } = await db.getPool().query(
                "SELECT DISTINCT symbol, type FROM futures_settings WHERE symbol != $1 AND type = 'FUT'", ['DEFAULT']
            );

            if (futuresSymbols.length === 0) {
                return res.status(404).json({ message: 'No futures symbols configured.' });
            }

            res.status(202).json({
                success: true,
                message: `Rebuilding continuous series for ${futuresSymbols.length} symbol(s). Check WebSocket status for progress.`,
                requestId: runId,
            });

            (async () => {
                let succeeded = 0, failed = 0;
                for (const { symbol, type } of futuresSymbols) {
                    try {
                        broadcastStatus(runId, `Rebuilding continuous series for ${symbol}…`, 'info');
                        await rebuildContinuousSeriesForSymbol(symbol, type);
                        succeeded++;
                    } catch (err) {
                        failed++;
                        logger.error(`[API/rebuild-continuous-all:${runId}] Failed for ${symbol}: ${err.message}`);
                        broadcastStatus(runId, `Rebuild failed for ${symbol}: ${err.message}`, 'error');
                    }
                }
                const summary = `Continuous series rebuild complete: ${succeeded} succeeded, ${failed} failed (of ${futuresSymbols.length}).`;
                logger.info(`[API/rebuild-continuous-all:${runId}] ${summary}`);
                broadcastStatus(runId, summary, failed > 0 ? 'warning' : 'success');
            })();
        } catch (err) {
            logger.error(`[API/rebuild-continuous-all:${runId}] Error starting batch rebuild: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to start continuous series rebuild.' });
            }
        }
    });

    return router;
};