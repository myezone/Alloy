// Quick self-check of the ESB mapping. Run with: npm test
const assert = require('assert');
const { normalize, toAlloyPayload, validate, mockDecision } = require('./server.js');

const cases = [
  [{ status: 'completed', complete_outcome: 'Approved' }, 'approved'],
  [{ status: 'completed', complete_outcome: 'Denied' }, 'denied'],
  [{ status: 'pending_step_up', complete_outcome: null }, 'step_up'],
  [{ status: 'pending_documents', complete_outcome: null }, 'step_up'],
  [{ status: 'waiting_review', complete_outcome: null }, 'review'],
  [{ status: 'pending_journey_application_review' }, 'review'],
  [{ status: 'pending_action' }, 'more_info'],
  [{ status: 'data_request' }, 'more_info'],
  [{ status: 'error' }, 'error'],
  [{ status: 'running' }, 'processing'],
];
for (const [input, expected] of cases) assert.strictEqual(normalize(input).state, expected, JSON.stringify(input));

const form = { firstName: 'Avery', lastName: 'Stone', birthDate: '1988-04-12', ssn: '111-22-3333', email: 'a@example.com', phone: '(402) 555-0142', addressLine1: '100 Main Street', city: 'Anytown', state: 'FL', postalCode: '33602' };
assert.deepStrictEqual(validate(form), []);
assert.ok(validate({ ...form, ssn: '123' }).length > 0);
const p = toAlloyPayload(form);
assert.strictEqual(p.entities[0].data.document_ssn, '111223333');
assert.strictEqual(p.entities[0].data.phone_number, '4025550142');
assert.strictEqual(p.entities[0].data.addresses[0].postal_code, '33602');
assert.strictEqual(p.entities[0].branch_name, 'persons');
assert.strictEqual(mockDecision('00001').status, 'pending_step_up');
assert.strictEqual(mockDecision('00002').outcome, 'Denied');
assert.strictEqual(mockDecision('00003').status, 'waiting_review');
assert.strictEqual(mockDecision('33602').outcome, 'Approved');
console.log(`ok: ${cases.length} status mappings, payload and validation checks passed`);
