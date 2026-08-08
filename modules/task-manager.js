const { v4: uuidv4 } = require('uuid');
const AbortController = globalThis.AbortController || require('abort-controller');
const { logger } = require('./logger.js');

// --- Internal State ---
let taskQueue = [];
let currentRunningTaskInfo = null;
let taskProcessorActive = false;
const recentForegroundCompletions = new Map();

// In-memory (not persisted, cleared on restart) log of what happened to each
// task as it finished — completed, failed, or cancelled — so a long,
// cron-driven backfill across many symbols can be checked at a glance for
// real failures instead of requiring a manual scroll through raw server
// logs (which are dominated by expected-looking noise, e.g. IBKR's own
// "no data" responses logged at error level). Capped so it can't grow
// unbounded over a multi-day repopulation.
const MAX_TASK_OUTCOMES = 200;
const recentTaskOutcomes = [];

function recordTaskOutcome(outcome) {
    recentTaskOutcomes.unshift({ ...outcome, finishedAt: new Date().toISOString() });
    if (recentTaskOutcomes.length > MAX_TASK_OUTCOMES) recentTaskOutcomes.length = MAX_TASK_OUTCOMES;
}

function getRecentTaskOutcomes() {
    return recentTaskOutcomes;
}

// --- Constants ---
const TASK_STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    FAILED: 'failed',
};

const PRIORITY = {
    USER_FOREGROUND_YAHOO: 10,
    USER_FOREGROUND_IBKR: 20,
    USER_BACKGROUND_YAHOO: 30,
    USER_BACKGROUND_IBKR: 40,
    CRON_FULL_POPULATION: 50,
};

// --- Public Functions ---
function addTask(symbol, timeframe, phase, priority, requestedBy, contractMonth = null, type = 'FUT') {
    const upperSymbol = symbol.toUpperCase();

    // Skip if an equivalent task (same symbol/timeframe/phase/contract/type) is
    // already pending or currently running. Without this, repeated calls (e.g.
    // the 6-hourly cron sweep landing on top of a still-draining backlog from a
    // previous run, since tasks are processed strictly one at a time) just keep
    // stacking duplicate work onto the queue indefinitely.
    const isDuplicate = (t) =>
        t.symbol === upperSymbol && t.timeframe === timeframe && t.phase === phase &&
        t.contractMonth === contractMonth && t.type === type;
    const alreadyPending = taskQueue.some(t => t.status === TASK_STATUS.PENDING && isDuplicate(t));
    const alreadyRunning = currentRunningTaskInfo && isDuplicate(currentRunningTaskInfo);
    if (alreadyPending || alreadyRunning) {
        logger.debug(`[TaskManager] Skipped duplicate task: (${upperSymbol} ${timeframe} ${phase} contract=${contractMonth || 'N/A'}) already ${alreadyRunning ? 'running' : 'pending'}.`);
        return null;
    }

    const taskId = uuidv4();
    const cancellationController = new AbortController();
    const task = {
        id: taskId,
        symbol: upperSymbol,
        timeframe,
        phase,
        priority,
        requestedBy,
        status: TASK_STATUS.PENDING,
        cancellationController,
        contractMonth,
        type,
        createdAt: new Date(),
    };
    taskQueue.push(task);
    logger.debug(`[TaskManager] Added task: ${task.id} (${task.symbol} ${task.timeframe} ${task.phase}) Pri: ${task.priority} By: ${task.requestedBy}`);

    taskQueue.sort((a, b) => {
        if (a.priority !== b.priority) {
            return a.priority - b.priority;
        }
        return a.createdAt - b.createdAt;
    });

    return taskId;
}

// Picks the pending task with the lowest priority number (see PRIORITY below
// — foreground user requests are meant to jump ahead of background cron
// work). Ties broken by insertion order (first `<`, not `<=`, so an earlier
// task at the same priority is never displaced by a later one) — plain FIFO
// was the only behavior here before, which meant priority was set on every
// task but never actually consulted: a long cron-queued backlog could bury
// a "foreground" chart request behind hundreds of background tasks with no
// way to jump ahead, exactly the opposite of the intent.
function getNextPendingTask() {
    let bestIndex = -1;
    let bestPriority = Infinity;
    for (let i = 0; i < taskQueue.length; i++) {
        const t = taskQueue[i];
        if (t.status === TASK_STATUS.PENDING && t.priority < bestPriority) {
            bestPriority = t.priority;
            bestIndex = i;
        }
    }
    if (bestIndex === -1) {
        return null;
    }
    const [taskToRun] = taskQueue.splice(bestIndex, 1);
    taskToRun.status = TASK_STATUS.RUNNING;
    return taskToRun;
}

// --- Getters and Setters for State Management ---
const getQueue = () => taskQueue;
const setQueue = (newQueue) => { taskQueue = newQueue; };
const getCurrentTask = () => currentRunningTaskInfo;
const setCurrentTask = (taskInfo) => { currentRunningTaskInfo = taskInfo; };
const clearCurrentTask = () => { currentRunningTaskInfo = null; };
const isProcessorActive = () => taskProcessorActive;
const setProcessorActive = (isActive) => { taskProcessorActive = isActive; };
const getRecentCompletions = () => recentForegroundCompletions;

module.exports = {
    addTask,
    getNextPendingTask,
    getQueue,
    setQueue,
    getCurrentTask,
    setCurrentTask,
    clearCurrentTask,
    isProcessorActive,
    setProcessorActive,
    getRecentCompletions,
    recordTaskOutcome,
    getRecentTaskOutcomes,
    TASK_STATUS,
    PRIORITY,
};
