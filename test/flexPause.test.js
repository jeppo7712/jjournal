// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const flex = require('../routes/ibkrFlex.js');

// A fake Flex Web Service: SendRequest answers with `sendAnswer()`.
function fakeIbkr(t, sendAnswer) {
  let sends = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/SendRequest')) {
      sends += 1;
      const answer = sendAnswer(sends);
      const xml = answer === 'ok'
        ? '<FlexStatementResponse><Status>Success</Status><ReferenceCode>1</ReferenceCode></FlexStatementResponse>'
        : `<FlexStatementResponse><Status>Fail</Status><ErrorMessage>${answer}</ErrorMessage></FlexStatementResponse>`;
      return { ok: true, status: 200, text: async () => xml };
    }
    return { ok: true, status: 200, text: async () => '<FlexQueryResponse type="AF"><FlexStatements><FlexStatement accountId="DU1"/></FlexStatements></FlexQueryResponse>' };
  });
  return { sends: () => sends };
}

const INCOMPLETE = 'Statement is incomplete at this time. Please try again shortly.';
const LOCKED = 'Too many failed attempts. Please review your configuration.';

test('a statement still being generated: one request, then the query pauses', async (t) => {
  flex._queryPauses.clear();
  const ibkr = fakeIbkr(t, () => INCOMPLETE);
  await assert.rejects(flex.getFlexStatements('tok', 'Q1'), /incomplete/);
  assert.equal(ibkr.sends(), 1, 'no quick retries for an incomplete statement');
  await assert.rejects(flex.getFlexStatements('tok', 'Q1', { forceRefresh: true }), /paused until/);
  assert.equal(ibkr.sends(), 1, 'nothing sent while paused');
  assert.equal(flex._queryPauses.get('Q1').ms, 30 * 60 * 1000);
});

test('a locked query pauses longer, doubling while it stays locked', async (t) => {
  flex._queryPauses.clear();
  fakeIbkr(t, () => LOCKED);
  await assert.rejects(flex.getFlexStatements('tok', 'Q2'), /Too many failed attempts/);
  assert.equal(flex._queryPauses.get('Q2').ms, 60 * 60 * 1000);
  flex._queryPauses.get('Q2').until = Date.now() - 1; // the pause is over
  await assert.rejects(flex.getFlexStatements('tok', 'Q2', { forceRefresh: true }), /Too many failed attempts/);
  assert.equal(flex._queryPauses.get('Q2').ms, 2 * 60 * 60 * 1000);
});

test('a statement clears the pause; other queries are not affected', async (t) => {
  flex._queryPauses.clear();
  let answer = INCOMPLETE;
  fakeIbkr(t, () => answer);
  await assert.rejects(flex.getFlexStatements('tok', 'Q3'));
  answer = 'ok';
  const other = await flex.getFlexStatements('tok', 'Q4');
  assert.equal(other.statements.length, 1);
  flex._queryPauses.get('Q3').until = Date.now() - 1;
  await flex.getFlexStatements('tok', 'Q3', { forceRefresh: true });
  assert.equal(flex._queryPauses.has('Q3'), false);
});

test('a busy server is still asked again within the pull', async (t) => {
  flex._queryPauses.clear();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ibkr = fakeIbkr(t, (n) => (n === 1 ? 'Too many requests have been made from this token.' : 'ok'));
  const pending = flex.getFlexStatements('tok', 'Q5', { forceRefresh: true });
  for (let i = 0; i < 5; i += 1) { await new Promise(r => setImmediate(r)); t.mock.timers.tick(10000); }
  const result = await pending;
  assert.equal(result.statements.length, 1);
  assert.equal(ibkr.sends(), 2);
  assert.equal(flex._queryPauses.has('Q5'), false);
});
