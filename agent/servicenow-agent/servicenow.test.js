import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getServiceNowTicket } from './servicenow.js';

test('INC tickets are read from the Incident table with the extracted number', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(url);
    assert.equal(request.pathname, '/api/now/table/incident');
    assert.equal(request.searchParams.get('sysparm_query'), 'number=INC838294');
    assert.equal(request.searchParams.get('sysparm_display_value'), 'true');
    assert.equal(options.method, 'GET');
    return { ok: true, json: async () => ({ result: [{
      sys_id: 'incident-id', number: 'INC838294', short_description: 'Production outage',
      description: 'Service unavailable', assignment_group: 'Infra Services', state: 'New',
    }] }) };
  });
  const ticket = await getServiceNowTicket({ number: 'inc838294' });
  assert.equal(ticket.number, 'INC838294');
  assert.equal(ticket.description, 'Service unavailable');
  assert.match(ticket.link, /uri=incident\.do\?sys_id=incident-id$/);
});

test('manual SCTASK lookups continue to use the Catalog Task table', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    const request = new URL(url);
    assert.equal(request.pathname, '/api/now/table/sc_task');
    assert.equal(request.searchParams.get('number'), 'SCTASK123');
    return { ok: true, json: async () => ({ result: [{ sys_id: 'task-id', number: 'SCTASK123' }] }) };
  });
  const ticket = await getServiceNowTicket({ number: 'SCTASK123' });
  assert.match(ticket.link, /uri=sc_task\.do\?sys_id=task-id$/);
});

test('missing incidents fail explicitly without falling back to a Catalog Task', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => ({ result: [] }) };
  });
  await assert.rejects(getServiceNowTicket({ number: 'INC838294' }), /Incident INC838294 not found/);
  assert.equal(calls, 1);
  await assert.rejects(getServiceNowTicket({ number: 'INC838294^ORactive=true' }), /INC or SCTASK/);
  assert.equal(calls, 1);
});
