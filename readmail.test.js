const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { isIncident, parseIncidentAssignment, loadState, pollInbox, processPending, readMessageBody, submitIncident, validDeltaUrl, GraphAuth } = require('./readmail.js');

const delta = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta';
const auth = { token: async () => 'test-token' };
const message = (id, subject, receivedDateTime = '2099-01-01T00:00:00Z') => ({ id, subject, receivedDateTime });
const incidentSubject = (number = 'INC838294', group = 'Infra Services') => `[Action Required]: Incident ${number} has been assigned to ${group}`;

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'outlook-jira-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  return { file, state: await loadState(file, 'client', 'tenant') };
}

test('incident keyword is case insensitive and respects word boundaries', () => {
  for (const subject of ['Incident: outage', '[INCIDENT] SCTASK123', 'Re: incident - checkout']) {
    assert.equal(isIncident(subject), true);
  }
  for (const subject of ['', undefined, 'incidental update', 'maintenance']) {
    assert.equal(isIncident(subject), false);
  }
});

test('assignment parser requires an INC number and the exact Infra Services group, ignoring case', () => {
  for (const subject of [incidentSubject(), incidentSubject('inc838294', 'iNfRa sErViCeS'), `Re: ${incidentSubject()}  `]) {
    assert.deepEqual(parseIncidentAssignment(subject), { incidentNumber: 'INC838294', serviceGroup: 'Infra Services' });
  }
  for (const subject of [
    incidentSubject('INC838294', 'Application Services'), incidentSubject('INC838294', 'Infra Services Other'),
    incidentSubject('INC838294', 'Other Infra Services'), incidentSubject('SCTASK123'),
    'Incident has been assigned to Infra Services', 'INC838294: Infra Services outage',
    'Production Incident - Application Service Interruption', '', undefined,
  ]) assert.equal(parseIncidentAssignment(subject), null, subject);
});

test('Jira receives the subject INC number and never falls back to the configured SCTASK', async t => {
  const originalTicket = process.env.SNOW_TICKET_NUMBER;
  const originalType = process.env.JIRA_ISSUE_TYPE;
  t.after(() => {
    for (const [key, value] of [['SNOW_TICKET_NUMBER', originalTicket], ['JIRA_ISSUE_TYPE', originalType]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.SNOW_TICKET_NUMBER = 'SCTASK999';
  process.env.JIRA_ISSUE_TYPE = 'Bug';
  const calls = [];
  const createIssue = async input => { calls.push(input); return { key: 'TEST-1' }; };
  const subject = incidentSubject('inc838294');
  const body = 'The application is unavailable for all users after deployment.';
  await submitIncident({ subject, body }, createIssue);
  assert.deepEqual(calls[0], { emailText: `Subject: ${subject}\n\n${body}`, serviceNowTicketNumber: 'INC838294', issueType: 'Bug' });
  delete process.env.JIRA_ISSUE_TYPE;
  await submitIncident({ subject: incidentSubject('INC123'), body: '' }, createIssue);
  assert.deepEqual(calls[1], {
    emailText: `Subject: ${incidentSubject('INC123')}\n\n`, serviceNowTicketNumber: 'INC123', issueType: undefined,
  });
  await assert.rejects(submitIncident({ subject }, createIssue), /Email body must be read/);
  await assert.rejects(submitIncident({ subject: 'Incident: network outage' }, createIssue), /Only incident assignment/);
  await assert.rejects(submitIncident({ subject: incidentSubject('INC123', 'Other Group') }, createIssue), /Only incident assignment/);
  delete process.env.SNOW_TICKET_NUMBER;
  assert.equal(calls.length, 2);
});

test('initial paginated sync skips old mail, queues incident subjects, and deduplicates across restart', async t => {
  const { file, state } = await fixture(t);
  let page = 0;
  await pollInbox(auth, state, file, async (url, options) => {
    assert.equal(options.headers.Prefer, 'IdType="ImmutableId"');
    if (page++ === 0) {
      assert.match(url, /changeType=created/);
      return { status: 200, result: {
        value: [message('old', 'Incident: historical', '2000-01-01T00:00:00Z'),
          message('normal', 'Status update'), message('new', incidentSubject())],
        '@odata.nextLink': `${delta}?page=2`,
      } };
    }
    assert.equal(url, `${delta}?page=2`);
    return { status: 200, result: {
      value: [message('new', incidentSubject()), { id: 'removed', '@removed': {} }],
      '@odata.deltaLink': `${delta}?cursor=1`,
    } };
  });
  assert.equal(state.initialized, true);
  assert.deepEqual(state.pending, [{ id: 'new', subject: incidentSubject() }]);
  const calls = [];
  await processPending(state, file, async email => {
    calls.push(email.subject);
    return { key: 'TEST-1', summary: email.subject, url: 'https://jira.example/TEST-1' };
  });
  const resumed = await loadState(file, 'client', 'tenant');
  await pollInbox(auth, resumed, file, async url => {
    assert.equal(url, `${delta}?cursor=1`);
    return { status: 200, result: {
      value: [message('new', incidentSubject())], '@odata.deltaLink': `${delta}?cursor=2`,
    } };
  });
  await processPending(resumed, file, async () => assert.fail('Duplicate submission'));
  assert.deepEqual(calls, [incidentSubject()]);
  assert.deepEqual(resumed.pending, []);
});

test('a failed Jira submission survives restart and does not block another message', async t => {
  const { file, state } = await fixture(t);
  await pollInbox(auth, state, file, async () => ({ status: 200, result: {
    value: [message('fail', incidentSubject('INC1')), message('ok', incidentSubject('INC2'))],
    '@odata.deltaLink': `${delta}?cursor=1`,
  } }));
  await processPending(state, file, async email => {
    if (email.id === 'fail') throw new Error('Temporary Jira failure');
    return { key: 'TEST-2', summary: email.subject, url: 'https://jira.example/TEST-2' };
  });
  const resumed = await loadState(file, 'client', 'tenant');
  assert.deepEqual(resumed.pending.map(email => email.id), ['fail']);
  await processPending(resumed, file, async email => ({ key: 'TEST-3', summary: email.subject, url: 'test' }));
  assert.deepEqual((await loadState(file, 'client', 'tenant')).pending, []);
});

test('expired delta cursor rebuild retains processed IDs', async t => {
  const { file, state } = await fixture(t);
  state.initialized = true;
  state.cursor = `${delta}?expired=1`;
  state.seen_ids = ['old'];
  let calls = 0;
  await pollInbox(auth, state, file, async () => {
    if (calls++ === 0) return { status: 410, result: {} };
    return { status: 200, result: {
      value: [message('old', incidentSubject('INC1')), message('new', incidentSubject('INC2'))],
      '@odata.deltaLink': `${delta}?cursor=2`,
    } };
  });
  assert.equal(calls, 2);
  assert.deepEqual(state.pending.map(email => email.id), ['new']);
});

test('untrusted delta links are rejected before state advances', async t => {
  const { file, state } = await fixture(t);
  assert.equal(validDeltaUrl('https://attacker.example/v1.0/me/mailFolders/inbox/messages/delta'), false);
  await assert.rejects(pollInbox(auth, state, file, async () => ({ status: 200, result: {
    value: [message('new', 'Incident')], '@odata.deltaLink': 'https://attacker.example/',
  } })), /invalid Inbox change URL/);
  assert.equal(state.cursor, null);
  assert.deepEqual(state.pending, []);
});

test('Graph continuation URL formats stay restricted to message delta endpoints', () => {
  for (const resource of [
    'me/mailFolders/inbox',
    "me/mailfolders('AQMkADNkNAAAgEMAAAA')",
    'me/mailfolders(%27AQMkADNkNAAAgEMAAAA%27)',
    'users/test-user/mailFolders/inbox',
    "users('test-user')/mailFolders('AQMkADNkNAAAgEMAAAA')",
  ]) {
    assert.equal(validDeltaUrl(`https://graph.microsoft.com/v1.0/${resource}/messages/delta?$deltatoken=test`), true, resource);
  }
  for (const url of [
    'http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta',
    'https://graph.microsoft.com.attacker.example/v1.0/me/mailFolders/inbox/messages/delta',
    'https://user:password@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta',
    'https://graph.microsoft.com:444/v1.0/me/mailFolders/inbox/messages/delta',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/other/messages/delta',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta#fragment',
    'https://graph.microsoft.com/v1.0/me/drive/root/delta',
    undefined,
  ]) assert.equal(validDeltaUrl(url), false, String(url));
});

test('OData next and delta links are followed unchanged and resume after restart', async t => {
  const { file, state } = await fixture(t);
  const endpoint = "https://graph.microsoft.com/v1.0/me/mailfolders('AQMkADNkNAAAgEMAAAA')/messages/delta";
  const nextLink = `${endpoint}?$skiptoken=opaque%2Btoken%3D`;
  const deltaLink = `${endpoint}?$deltatoken=opaque%2Ftoken%3D`;
  let calls = 0;
  await pollInbox(auth, state, file, async url => {
    if (calls++ === 0) return { status: 200, result: {
      value: [], '@odata.nextLink': nextLink,
    } };
    assert.equal(url, nextLink);
    return { status: 200, result: {
      value: [message('new', incidentSubject())], '@odata.deltaLink': deltaLink,
    } };
  });
  const resumed = await loadState(file, 'client', 'tenant');
  assert.equal(resumed.cursor, deltaLink);
  assert.deepEqual(resumed.pending, [{ id: 'new', subject: incidentSubject() }]);
  await pollInbox(auth, resumed, file, async url => {
    assert.equal(url, deltaLink);
    return { status: 200, result: { value: [], '@odata.deltaLink': deltaLink } };
  });
});

test('state cannot be reused for a different app or tenant', async t => {
  const { file } = await fixture(t);
  await assert.rejects(loadState(file, 'another-client', 'tenant'), /another app or tenant/);
});

test('poll counts new emails and incident subjects across pages without triggering other groups', async t => {
  const { file, state } = await fixture(t);
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(line));
  let page = 0;
  const counts = await pollInbox(auth, state, file, async () => {
    if (page++ === 0) return { status: 200, result: {
      value: [message('old', incidentSubject(), '2000-01-01T00:00:00Z'),
        message('normal', 'Status update'), message('other-group', incidentSubject('INC1', 'Application Services'))],
      '@odata.nextLink': `${delta}?page=2`,
    } };
    return { status: 200, result: {
      value: [message('normal', 'Status update'), message('generic', 'Production Incident - Application Service Interruption'),
        message('match', incidentSubject()), { id: 'deleted', '@removed': {} }],
      '@odata.deltaLink': `${delta}?cursor=1`,
    } };
  });
  assert.deepEqual(counts, { newEmails: 4, incidentEmails: 3, matchingAssignments: 1, existingSkipped: 1 });
  assert.deepEqual(state.pending, [{ id: 'match', subject: incidentSubject() }]);
  assert.ok(logs.some(line => line.includes('new emails read=4, incident emails=3, Infra Services matches=1')));
  // An idle check reports zero new mail and cannot requeue old messages.
  const idle = await pollInbox(auth, state, file, async () => ({ status: 200, result: {
    value: [message('match', incidentSubject())], '@odata.deltaLink': `${delta}?cursor=2`,
  } }));
  assert.deepEqual(idle, { newEmails: 0, incidentEmails: 0, matchingAssignments: 0, existingSkipped: 0 });
  assert.equal(state.pending.length, 1);
});

test('legacy saved emails are filtered before any agent call and retries are explicitly logged', async t => {
  const { file, state } = await fixture(t);
  state.pending = [
    { id: 'legacy', subject: 'Production Incident - Application Service Interruption' },
    { id: 'other', subject: incidentSubject('INC1', 'Other Services') },
    { id: 'eligible', subject: incidentSubject() },
  ];
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(line));
  let submissions = 0;
  await processPending(state, file, async email => {
    assert.equal(email.id, 'eligible');
    submissions++;
    throw new Error('Temporary failure');
  });
  assert.equal(submissions, 1);
  const resumed = await loadState(file, 'client', 'tenant');
  assert.deepEqual(resumed.pending, [{ id: 'eligible', subject: incidentSubject(), attempts: 1 }]);
  await processPending(resumed, file, async () => ({ key: 'TEST-1', summary: 'Incident', url: 'test' }));
  assert.ok(logs.some(line => line.includes('Skipped saved email:')));
  assert.ok(logs.some(line => line.includes('attempt 2') && line.includes('not a newly received email')));
  assert.equal((await loadState(file, 'client', 'tenant')).pending.length, 0);
});

test('expired access tokens refresh without interactive sign-in', async t => {
  const graphAuth = new GraphAuth('client', 'tenant');
  graphAuth.remember({ access_token: 'expired', refresh_token: 'refresh', expires_in: 1 });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /\/tenant\/oauth2\/v2.0\/token$/);
    assert.equal(options.body.get('grant_type'), 'refresh_token');
    assert.equal(options.body.get('refresh_token'), 'refresh');
    assert.equal(options.body.get('scope'), 'https://graph.microsoft.com/Mail.Read offline_access');
    return { status: 200, json: async () => ({ access_token: 'renewed', expires_in: 3600 }) };
  });
  assert.equal(await graphAuth.token(), 'renewed');
});

test('matching email bodies are fetched as plain text using immutable message IDs', async () => {
  const body = await readMessageBody(auth, 'message/id+123=', async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/v1.0/me/messages/message%2Fid%2B123%3D');
    assert.equal(parsed.searchParams.get('$select'), 'body');
    assert.equal(options.headers.Prefer, 'IdType="ImmutableId", outlook.body-content-type="text"');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return { status: 200, result: { body: { contentType: 'text', content: 'Checkout is unavailable.' } } };
  });
  assert.equal(body, 'Checkout is unavailable.');
  await assert.rejects(readMessageBody(auth, 'id', async () => ({ status: 403, result: {} })), /Mail.Read permission/);
  await assert.rejects(readMessageBody(auth, 'id', async () => ({ status: 200, result: {} })), /plain-text email body/);
});

test('body retrieval failures remain queued and cached content survives Jira retries', async t => {
  const { file, state } = await fixture(t);
  state.pending = [
    { id: 'wrong-group', subject: incidentSubject('INC1', 'Other Services') },
    { id: 'valid', subject: incidentSubject() },
  ];
  let bodyReads = 0;
  let submissions = 0;
  const submit = async email => {
    submissions++;
    assert.equal(email.body, 'Checkout is unavailable.');
    if (submissions === 1) throw new Error('Temporary Jira failure');
    return { key: 'TEST-1', summary: 'Checkout outage', url: 'test' };
  };
  const readBody = async id => {
    assert.equal(id, 'valid');
    if (++bodyReads === 1) throw new Error('Graph unavailable');
    return 'Checkout is unavailable.';
  };
  await processPending(state, file, submit, readBody);
  assert.equal(submissions, 0);
  assert.equal(state.pending.length, 1);
  await processPending(state, file, submit, readBody);
  const resumed = await loadState(file, 'client', 'tenant');
  assert.equal(resumed.pending[0].body, 'Checkout is unavailable.');
  await processPending(resumed, file, submit, readBody);
  assert.equal(submissions, 2);
  assert.equal(bodyReads, 2);
  assert.equal(resumed.pending.length, 0);
});
