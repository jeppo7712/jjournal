// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-label-'));
const { futuresContractLabel } = require('../modules/utils.js');

test('a futures contract is stored under IBKR\'s contract month', () => {
  // CL December stops trading on 19 November.
  assert.equal(futuresContractLabel({ lastTradeDateOrContractMonth: '20261119', contractMonth: '202612' }), '202612');
  // Without one (a contract IBKR didn't describe): its last trading month, as before.
  assert.equal(futuresContractLabel({ lastTradeDateOrContractMonth: '20261218' }), '202612');
  assert.equal(futuresContractLabel({}), null);
});
