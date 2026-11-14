// Run against an isolated mock server: SISU_BASE=http://127.0.0.1:3348 node tests/gauntlet/judge-audit.mjs
import assert from 'node:assert/strict';
import { BASE, CUSTOMERS, runTurn } from './lib.mjs';
const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body:JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const health = await (await fetch(`${BASE}/api/health`)).json();
assert.equal(health.mock, true, 'This isolated state-changing smoke must run in mock mode');
const customers = Object.values(CUSTOMERS);
const turns = await Promise.all(Array.from({length:12}, (_,i) => runTurn({customerId:customers[i%3], text:'What if I save 50 euros a month for five years?', mode:'text'})));
for (const turn of turns) {
  assert.equal(turn.status,200); assert.equal(turn.error,null);
  assert.ok(turn.types.includes('done')); assert.ok(turn.tools.some(t => t.name === 'run_scenario'));
}
const created = await post('/api/actions/prepare', {customerId:customers[0],kind:'one_off_transfer',amountEur:10});
assert.equal(created.status,201);
const id = created.body.action.id;
assert.equal((await post(`/api/actions/${id}/approve`,{customerId:customers[1],confirm:true})).status,404);
assert.equal((await post(`/api/actions/${id}/approve`,{customerId:customers[0]})).status,400);
const results = await Promise.all(Array.from({length:3},()=>post(`/api/actions/${id}/approve`,{customerId:customers[0],confirm:true})));
assert.equal(results.filter(r=>r.status===200).length,1);
assert.equal(results.filter(r=>r.status===409).length,2);
console.log(JSON.stringify({mode:'mock', concurrentCompletedTurns:turns.length, crossCustomerApproval:404, missingConfirmation:400, simultaneousApprovals:results.map(r=>r.status)},null,2));
