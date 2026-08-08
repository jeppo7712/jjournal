const express = require('express');
const router = express.Router();
const { EventName } = require('@stoqey/ib');
const { DateTime } = require('luxon');
const { timeout, generateIbReqId } = require('../modules/utils.js');
const { logger } = require('../modules/logger.js');
const { fetchFlexExecutions } = require('./ibkrFlex.js');
const { loadConfig } = require('../modules/config.js');

module.exports = (ibkr, broadcastStatus, uuidv4) => {

  // ─── SHARED HELPERS ──────────────────────────────────────────────────────────

  async function fetchExecutions(symbol, effectiveType) {
    let execDetailsHandler;
    return new Promise((resolve, reject) => {
      const execFilter = {
        symbol: symbol.toUpperCase(),
        secType: effectiveType.toUpperCase(),
        time: DateTime.now().setZone('UTC').minus({ days: 7 }).startOf('day').toFormat('yyyyMMdd-HH:mm:ss'),
      };
      logger.debug(`[IBKR fetchExecutions] filter time: ${execFilter.time}`);

      let executionData = [];

      execDetailsHandler = (reqId, contract, execution) => {
        logger.debug('[DEBUG] execDetails orderId=%d parentId=%d symbol=%s side=%s qty=%d price=%d',
          execution.orderId, execution.permId, contract.symbol, execution.side, execution.shares, execution.price);
        executionData.push({
          execId: execution.execId,
          orderId: execution.orderId,
          permId: execution.permId,
          time: execution.time,
          side: execution.side,
          quantity: execution.shares,
          price: execution.price,
          commission: ibkr.commissionMap.get(execution.execId) || execution.commission || 0,
        });
      };

      ibkr.getIbApi().on(EventName.execDetails, execDetailsHandler);

      ibkr.getIbApi().once(EventName.execDetailsEnd, () => {
        if (execDetailsHandler) ibkr.getIbApi().off(EventName.execDetails, execDetailsHandler);
        setTimeout(() => {
          const updated = executionData.map(exec => ({
            ...exec,
            commission: ibkr.commissionMap.get(exec.execId) !== undefined
              ? ibkr.commissionMap.get(exec.execId)
              : exec.commission,
          }));
          ibkr.commissionMap.clear();
          logger.debug(`[IBKR fetchExecutions] resolved ${updated.length} executions`);
          resolve(updated);
        }, 2000);
      });

      ibkr.getIbApi().once(EventName.error, (err, code) => {
        if (execDetailsHandler) ibkr.getIbApi().off(EventName.execDetails, execDetailsHandler);
        reject(new Error(`IBKR execution error (code ${code}): ${err.message}`));
      });

      ibkr.getIbApi().reqExecutions(generateIbReqId(), execFilter);
    });
  }

  async function fetchCompletedOrders(symbol, effectiveType) {
    let completedOrderHandler;
    return new Promise((resolve) => {
      let orders = [];
      let fallbackTimer;

      completedOrderHandler = (contract, order, orderState) => {
        // Log every completedOrder event so we can diagnose parentId values
        logger.debug('[DEBUG] completedOrder symbol=%s orderId=%d parentId=%d action=%s type=%s status=%s',
          contract.symbol, order.orderId, order.parentId, order.action, order.orderType, orderState.status);

        if (
          contract.symbol && contract.symbol.toUpperCase() === symbol.toUpperCase() &&
          contract.secType && contract.secType.toUpperCase() === effectiveType.toUpperCase()
        ) {
          const rawParentId = order.parentId;
          const parentId = (rawParentId && rawParentId !== 0) ? rawParentId : 0;

          orders.push({
            orderId: order.orderId,
            permId: order.permId,
            parentId,
            action: order.action,
            orderType: order.orderType,
            quantity: order.totalQuantity,
            limitPrice: order.lmtPrice || null,
            stopPrice: order.auxPrice || null,
            status: orderState.status,
            filledQty: orderState.filled || 0,
            avgFillPrice: orderState.avgFillPrice || 0,
            source: 'completed',
          });
        }
      };

      ibkr.getIbApi().on(EventName.completedOrder, completedOrderHandler);

      const cleanup = () => {
        clearTimeout(fallbackTimer);
        if (ibkr.isIbkrConnected() && completedOrderHandler)
          ibkr.getIbApi().off(EventName.completedOrder, completedOrderHandler);
      };

      ibkr.getIbApi().once(EventName.completedOrdersEnd, () => {
        cleanup();
        logger.debug(`[IBKR fetchCompletedOrders] got ${orders.length} completed orders`);
        resolve(orders);
      });

      fallbackTimer = setTimeout(() => {
        cleanup();
        logger.warn(`[IBKR fetchCompletedOrders] timed out, resolving with ${orders.length} orders`);
        resolve(orders);
      }, 7000);

      ibkr.getIbApi().reqCompletedOrders(false);
    });
  }

  // Use reqAllOpenOrders() to also capture manually placed TWS bracket orders
  async function fetchOpenOrders(symbol, effectiveType) {
    let openOrderHandler;
    return new Promise((resolve, reject) => {
      let orders = [];

      openOrderHandler = (orderId, contract, order, orderState) => {
        logger.debug('[DEBUG] openOrder symbol=%s orderId=%d parentId=%d action=%s type=%s status=%s',
          contract.symbol, orderId, order.parentId, order.action, order.orderType, orderState.status);

        if (
          contract.symbol && contract.symbol.toUpperCase() === symbol.toUpperCase() &&
          contract.secType && contract.secType.toUpperCase() === effectiveType.toUpperCase()
        ) {
          const rawParentId = order.parentId;
          const parentId = (rawParentId && rawParentId !== 0) ? rawParentId : 0;

          orders.push({
            orderId: orderId,
            permId: order.permId,
            parentId,
            action: order.action,
            orderType: order.orderType,
            quantity: order.totalQuantity,
            limitPrice: order.lmtPrice || null,
            stopPrice: order.auxPrice || null,
            status: orderState.status,
            filledQty: 0,
            avgFillPrice: 0,
            source: 'open',
          });
        }
      };

      ibkr.getIbApi().on(EventName.openOrder, openOrderHandler);

      ibkr.getIbApi().once(EventName.openOrderEnd, () => {
        if (openOrderHandler) ibkr.getIbApi().off(EventName.openOrder, openOrderHandler);
        logger.debug(`[IBKR fetchOpenOrders] got ${orders.length} open orders`);
        resolve(orders);
      });

      ibkr.getIbApi().once(EventName.error, (err, code) => {
        if (openOrderHandler) ibkr.getIbApi().off(EventName.openOrder, openOrderHandler);
        reject(new Error(`IBKR open orders error (code ${code}): ${err.message}`));
      });

      // reqAllOpenOrders returns ALL open orders (including manually placed TWS orders)
      // This ensures bracket children from the TWS GUI have their parentId correctly set
      ibkr.getIbApi().reqAllOpenOrders();
    });
  }

  // ─── POSITION-BASED FALLBACK GROUPING ────────────────────────────────────────
  // When bracket order linkage fails (parentId=0 on children, or completedOrders empty),
  // group executions by tracking cumulative position. When position returns to 0 = one trade.
  function groupByPosition(execs) {
    if (execs.length === 0) return [];
    const sorted = [...execs].sort((a, b) => a.time.localeCompare(b.time));
    const groups = [];
    let current = null;
    let netQty = 0;

    for (const exec of sorted) {
      const isBuy = exec.side === 'BOT';
      const change = isBuy ? Number(exec.quantity) : -Number(exec.quantity);

      if (netQty === 0) {
        current = {
          type: 'position-based',
          parentOrderId: `pos_${exec.execId}`,
          direction: isBuy ? 'LONG' : 'SHORT',
          result: 'OPEN',
          entryOrder: null,
          entryExecutions: [],
          tpOrder: null,
          tpExecutions: [],
          slOrder: null,
          slExecutions: [],
          otherChildren: [],
        };
        groups.push(current);
      }

      netQty += change;

      // Entry = adding to position; exit = reducing/closing
      const isEntry = (current.direction === 'LONG' && isBuy) ||
                      (current.direction === 'SHORT' && !isBuy);

      if (isEntry) {
        current.entryExecutions.push(exec);
      } else {
        // Exit — we can't tell TP vs SL without order data, use tpExecutions slot
        current.tpExecutions.push(exec);
      }

      if (netQty === 0) {
        current.result = 'CLOSED';
        current = null;
      }
    }
    // If we still have an open position (current != null), it stays as result: 'OPEN'
    return groups;
  }

  // ─── MAIN GROUPING LOGIC ─────────────────────────────────────────────────────
  function buildBracketGroups(executions, allOrders) {
    // Build order map — prefer 'open' source over 'completed' for same orderId
    const orderMap = new Map();
    for (const o of allOrders) {
      if (!orderMap.has(o.orderId) || o.source === 'open') {
        orderMap.set(o.orderId, o);
      }
    }

    // Map executions to their orderId
    const execByOrderId = new Map();
    for (const exec of executions) {
      if (!execByOrderId.has(exec.orderId)) execByOrderId.set(exec.orderId, []);
      execByOrderId.get(exec.orderId).push(exec);
    }

    // Find root orders (parentId === 0)
    const parentOrders = [...orderMap.values()].filter(o => o.parentId === 0);

    const bracketGroups = [];
    const accountedExecIds = new Set();
    const accountedOrderIds = new Set();

    for (const parent of parentOrders) {
      const children = [...orderMap.values()].filter(o => o.parentId === parent.orderId);
      const entryExecs = execByOrderId.get(parent.orderId) || [];

      const tpOrder = children.find(c => c.orderType === 'LMT') || null;
      const slOrder = children.find(c =>
        c.orderType === 'STP' || c.orderType === 'STP LMT' || c.orderType === 'TRAIL'
      ) || null;
      const otherChildren = children.filter(c => c !== tpOrder && c !== slOrder);

      const tpExecs = tpOrder ? (execByOrderId.get(tpOrder.orderId) || []) : [];
      const slExecs = slOrder ? (execByOrderId.get(slOrder.orderId) || []) : [];

      // ── GHOST FILTER ──────────────────────────────────────────────────────────
      // Skip orders that appear as SELL LMT with no children and no executions.
      // These are cancelled TP legs from LONG brackets that IBKR returned with parentId=0 by mistake.
      const isGhostCancelledChildOrder = (
        entryExecs.length === 0 &&
        tpExecs.length === 0 &&
        slExecs.length === 0 &&
        children.length === 0 &&
        parent.action === 'SELL' &&
        (parent.orderType === 'LMT' || parent.orderType === 'STP' || parent.orderType === 'STP LMT')
      );
      if (isGhostCancelledChildOrder) {
        logger.debug(`[buildBracketGroups] Skipping ghost order orderId=${parent.orderId} action=${parent.action} type=${parent.orderType} status=${parent.status}`);
        accountedOrderIds.add(parent.orderId);
        continue;
      }
      // Also skip completely empty PENDING groups with no useful order info at all
      const isUseless = (
        entryExecs.length === 0 &&
        tpExecs.length === 0 &&
        slExecs.length === 0 &&
        children.length === 0 &&
        parent.limitPrice == null &&
        parent.stopPrice == null
      );
      if (isUseless) {
        logger.debug(`[buildBracketGroups] Skipping useless empty group orderId=${parent.orderId}`);
        accountedOrderIds.add(parent.orderId);
        continue;
      }
      // ─────────────────────────────────────────────────────────────────────────

      let result;
      if (tpExecs.length > 0) result = 'TP_HIT';
      else if (slExecs.length > 0) result = 'SL_HIT';
      else if (entryExecs.length === 0) result = 'PENDING';
      else result = 'OPEN';

      bracketGroups.push({
        type: children.length > 0 ? 'bracket' : 'standalone',
        parentOrderId: parent.orderId,
        direction: parent.action === 'BUY' ? 'LONG' : 'SHORT',
        result,
        entryOrder: parent,
        entryExecutions: entryExecs,
        tpOrder,
        tpExecutions: tpExecs,
        slOrder,
        slExecutions: slExecs,
        otherChildren: otherChildren.map(c => ({
          order: c,
          executions: execByOrderId.get(c.orderId) || [],
        })),
      });

      accountedOrderIds.add(parent.orderId);
      for (const c of children) accountedOrderIds.add(c.orderId);

      // Mark all executions in this group as accounted for
      [...entryExecs, ...tpExecs, ...slExecs].forEach(e => accountedExecIds.add(e.execId));
    }

    // Sort bracket groups by first entry execution time (oldest first)
    bracketGroups.sort((a, b) => {
      const aTime = a.entryExecutions[0]?.time || '';
      const bTime = b.entryExecutions[0]?.time || '';
      return aTime.localeCompare(bTime);
    });

    // Executions not claimed by any bracket group → run position-based fallback grouping
    const orphanExecs = executions.filter(e => !accountedExecIds.has(e.execId));
    logger.debug(`[buildBracketGroups] ${bracketGroups.length} bracket groups, ${orphanExecs.length} orphan execs for position grouping`);

    const positionGroups = groupByPosition(orphanExecs);

    // Remaining truly unmatched executions (open position, partial fills, etc.)
    const positionExecIds = new Set(
      positionGroups.flatMap(g => [...g.entryExecutions, ...g.tpExecutions].map(e => e.execId))
    );
    const remainingOrphans = orphanExecs.filter(e => !positionExecIds.has(e.execId));

    return {
      bracketGroups: [...bracketGroups, ...positionGroups],
      orphanExecutions: remainingOrphans,
    };
  }

  // ─── ROUTES ──────────────────────────────────────────────────────────────────

  router.get('/trade-groups', async (req, res) => {
    const { symbol, type } = req.query;
    const requestId = uuidv4();

    if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

    const effectiveType = (type || 'FUT').toUpperCase();
    if (!['STK', 'FUT'].includes(effectiveType))
      return res.status(400).json({ error: 'Invalid type. Must be STK or FUT.' });

    try {
      if (!ibkr.isIbkrConnected()) await ibkr.initializeIBKR(requestId, broadcastStatus);

      broadcastStatus(requestId, `Fetching trade groups for ${symbol}…`, 'info');

      const executions = await Promise.race([
        fetchExecutions(symbol, effectiveType),
        timeout(35000, `Execution fetch timed out for ${symbol}`),
      ]);
      logger.debug(`[/trade-groups] ${executions.length} executions`);

      const completedOrders = await Promise.race([
        fetchCompletedOrders(symbol, effectiveType),
        timeout(12000, 'Completed orders fetch timed out'),
      ]).catch(err => {
        logger.warn(`[/trade-groups] completedOrders failed: ${err.message}`);
        return [];
      });
      logger.debug(`[/trade-groups] ${completedOrders.length} completed orders`);

      const openOrders = await Promise.race([
        fetchOpenOrders(symbol, effectiveType),
        timeout(12000, 'Open orders fetch timed out'),
      ]).catch(err => {
        logger.warn(`[/trade-groups] openOrders failed: ${err.message}`);
        return [];
      });
      logger.debug(`[/trade-groups] ${openOrders.length} open orders`);

      const { bracketGroups, orphanExecutions } = buildBracketGroups(
        executions,
        [...completedOrders, ...openOrders]
      );

      broadcastStatus(requestId, `Found ${bracketGroups.length} trade groups for ${symbol}`, 'success');

      res.json({
        bracketGroups,
        orphanExecutions,
        rawExecutions: executions,
        rawOrders: [...completedOrders, ...openOrders],
      });
    } catch (err) {
      logger.error(`[/trade-groups] ${err.message}`);
      broadcastStatus(requestId, `Failed: ${err.message}`, 'error');
      res.status(500).json({ error: err.message });
    } finally {
      if (ibkr.isIbkrConnected()) await ibkr.disconnectIBKR();
    }
  });

  // Historical trades via IBKR Flex Web Service — independent of TWS, works
  // for any date range the saved Flex Query covers, not just today's session.
  // Results are cached server-side for a few minutes (see ibkrFlex.js) so
  // fetching several symbols back-to-back doesn't re-hit IBKR every time.
  // Pass ?refresh=true to force a fresh pull regardless of cache age.
  router.get('/trade-groups-flex', async (req, res) => {
    const { symbol, type, refresh } = req.query;
    const requestId = uuidv4();

    if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

    const effectiveType = (type || 'FUT').toUpperCase();
    if (!['STK', 'FUT'].includes(effectiveType))
      return res.status(400).json({ error: 'Invalid type. Must be STK or FUT.' });

    const config = await loadConfig();
    const flexToken = config.ibkrFlexToken;
    const flexQueryIds = [config.ibkrFlexQueryIdActivity, config.ibkrFlexQueryIdTradeConf].filter(Boolean);
    if (!flexToken || flexQueryIds.length === 0) {
      return res.status(500).json({
        error: 'Flex Web Service is not configured. Set your Flex token and at least one Query ID in Settings → TWS.',
      });
    }

    try {
      broadcastStatus(requestId, `Fetching trades for ${symbol} via Flex…`, 'info');

      const { executions, fetchedAt, fromCache, stale, failedQueryIds } = await Promise.race([
        fetchFlexExecutions(flexToken, flexQueryIds, symbol, effectiveType, { forceRefresh: refresh === 'true' }),
        timeout(90000, `Flex fetch for ${symbol} timed out`),
      ]);
      logger.debug(`[/trade-groups-flex] ${executions.length} flex executions for ${symbol} (fromCache=${fromCache})`);

      // Flex trade confirmations carry no bracket order linkage, so this
      // always falls through to the position-based grouping fallback below.
      const { bracketGroups, orphanExecutions } = buildBracketGroups(executions, []);

      broadcastStatus(requestId, `Found ${bracketGroups.length} trade group(s) for ${symbol}${fromCache ? ' (cached)' : ''}`, 'success');

      // Label which query type failed, if any, so the UI can say something
      // more useful than just "0 trades found".
      const queryLabels = {
        [config.ibkrFlexQueryIdActivity]: 'Activity (historical)',
        [config.ibkrFlexQueryIdTradeConf]: 'Trade Confirmation (today)',
      };
      const warning = (failedQueryIds && failedQueryIds.length > 0)
        ? `Could not reach the ${failedQueryIds.map(id => queryLabels[id] || id).join(' and ')} Flex quer${failedQueryIds.length !== 1 ? 'ies' : 'y'} — results below may be incomplete. Try again in a minute.`
        : null;

      res.json({
        bracketGroups,
        orphanExecutions,
        rawExecutions: executions,
        rawOrders: [],
        fetchedAt,
        fromCache,
        stale,
        warning,
      });
    } catch (err) {
      logger.error(`[/trade-groups-flex] ${err.message}`);
      broadcastStatus(requestId, `Failed: ${err.message}`, 'error');
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/executions', async (req, res) => {
    const { symbol, type } = req.query;
    const requestId = uuidv4();
    if (!symbol) return res.status(400).json({ error: 'Symbol is required' });
    const effectiveType = (type || 'FUT').toUpperCase();
    if (!['STK', 'FUT'].includes(effectiveType))
      return res.status(400).json({ error: 'Invalid type parameter. Must be STK or FUT.' });
    try {
      if (!ibkr.isIbkrConnected()) await ibkr.initializeIBKR(requestId, broadcastStatus);
      broadcastStatus(requestId, `Fetching executions for ${symbol}`, 'info');
      const executions = await Promise.race([
        fetchExecutions(symbol, effectiveType),
        timeout(30000, `IBKR execution fetch for ${symbol} timed out`),
      ]);
      broadcastStatus(requestId, `Retrieved ${executions.length} executions`, 'success');
      res.json(executions);
    } catch (err) {
      logger.error(`[/executions] ${err.message}`);
      broadcastStatus(requestId, `Failed: ${err.message}`, 'error');
      res.status(500).json({ error: err.message });
    } finally {
      if (ibkr.isIbkrConnected()) await ibkr.disconnectIBKR();
    }
  });

  router.get('/open-orders', async (req, res) => {
    const { symbol, type } = req.query;
    const requestId = uuidv4();
    if (!symbol) return res.status(400).json({ error: 'Symbol is required' });
    const effectiveType = (type || 'FUT').toUpperCase();
    if (!['STK', 'FUT'].includes(effectiveType))
      return res.status(400).json({ error: 'Invalid type parameter. Must be STK or FUT.' });
    try {
      if (!ibkr.isIbkrConnected()) await ibkr.initializeIBKR(requestId, broadcastStatus);
      broadcastStatus(requestId, `Fetching open orders for ${symbol}`, 'info');
      const openOrders = await Promise.race([
        fetchOpenOrders(symbol, effectiveType),
        timeout(30000, `IBKR open orders fetch timed out`),
      ]);
      broadcastStatus(requestId, `Retrieved ${openOrders.length} open orders`, 'success');
      res.json(openOrders);
    } catch (err) {
      logger.error(`[/open-orders] ${err.message}`);
      broadcastStatus(requestId, `Failed: ${err.message}`, 'error');
      res.status(500).json({ error: err.message });
    } finally {
      if (ibkr.isIbkrConnected()) await ibkr.disconnectIBKR();
    }
  });

  return router;
};