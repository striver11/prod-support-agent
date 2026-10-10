import { test } from 'node:test';
import assert from 'node:assert/strict';

// Isolated test process: all external HTTP calls are intercepted below.
process.env.GEMINI_API_KEY = 'test-key';
process.env.SNOW_INSTANCE = 'snow.example';
process.env.SNOW_USERNAME = 'test-user';
process.env.SNOW_PASSWORD = 'test-password';
process.env.JIRA_BASE_URL = 'https://jira.example';
process.env.JIRA_EMAIL = 'test@example.com';
process.env.JIRA_API_TOKEN = 'test-token';
process.env.JIRA_PROJECT_KEY = 'TEST';
const { createJiraFromEmail } = await import('./jira-agent.js');

for (const configuredType of [undefined, 'Story']) {
  test(`email and retrieved ServiceNow ticket drive knowledge search and Jira creation (${configuredType || 'automatic type'})`, async t => {
    const email = 'Subject: [Action Required]: Incident INC838294 has been assigned to Infra Services\n\nCheckout fails after the latest deployment. Twenty users are affected.';
    const calls = [];
    const logs = [];
    t.mock.method(console, 'log', line => logs.push(line));
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      if (pathname === '/api/now/table/incident') {
        assert.equal(options.method, 'GET');
        assert.equal(new URL(url).searchParams.get('sysparm_query'), 'number=INC838294');
        return { ok: true, json: async () => ({ result: [{
          sys_id: 'incident-id', number: 'INC838294', short_description: 'Payment service outage',
          description: 'Database connections exhausted.',
        }] }) };
      }
      const payload = JSON.parse(options.body);
      if (pathname === '/rest/api/3/search/jql') {
        return { ok: true, json: async () => ({ issues: [{ key: 'TEST-OTHER', fields: {
          summary: 'New employee onboarding', description: 'Prepare account access.', status: { name: 'To Do' },
        } }], isLast: true }) };
      }
      if (pathname === '/api/embed') {
        return { ok: true, json: async () => ({ embeddings: payload.input.map((_, index) => index === 0 ? [1, 0] : [0, 1]) }) };
      }
      if (pathname === '/api/chat') {
        assert.equal(configuredType, undefined);
        const source = JSON.parse(payload.messages[1].content);
        assert.equal(source.email, email);
        assert.equal(source.serviceNowTicket.number, 'INC838294');
        assert.equal(source.serviceNowTicket.description, 'Database connections exhausted.');
        assert.equal(source.knowledgeArticles[0].number, 'KB0000001');
        return { ok: true, json: async () => ({ message: { content: '{"issueType":"Bug"}' } }) };
      }
      if (pathname.endsWith(':generateContent')) {
        const prompt = payload.contents[0].parts[0].text;
        assert.ok(prompt.includes('Twenty users are affected.'));
        assert.ok(prompt.includes('KB0000001'));
        assert.ok(prompt.includes('"serviceNowTicket"'));
        assert.ok(prompt.includes('Database connections exhausted.'));
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          summary: 'Checkout fails after deployment', description: 'Twenty users cannot check out.',
        }) }] } }] }) };
      }
      if (pathname === '/rest/api/3/issue') {
        assert.equal(payload.fields.issuetype.name, configuredType || 'Bug');
        assert.equal(payload.fields.summary, 'Checkout fails after deployment');
        const description = JSON.stringify(payload.fields.description);
        assert.ok(description.includes('https://snow.example/nav_to.do?uri=incident.do?sys_id=incident-id'));
        assert.ok(description.includes('INC838294'));
        return { ok: true, json: async () => ({ key: 'TEST-1' }) };
      }
      assert.fail(`Unexpected HTTP call: ${url}`);
    });
    const created = await createJiraFromEmail({
      emailText: email,
      serviceNowTicketNumber: configuredType ? undefined : 'INC838294',
      issueType: configuredType,
    }, {
      searchKnowledgeBase: async query => {
        assert.equal(query, `${email}\n\nPayment service outage\nDatabase connections exhausted.`);
        return [{ document: 'Deployment troubleshooting steps', metadata: { number: 'KB0000001', title: 'Checkout\n troubleshooting' } }];
      },
    });
    assert.equal(created.key, 'TEST-1');
    assert.equal(calls.length, configuredType ? 4 : 5);
    assert.equal(calls[1], '/rest/api/3/search/jql');
    assert.ok(!calls.includes('/api/embed'), 'Unrelated Stories do not need embedding');
    assert.equal(calls.at(-1), '/rest/api/3/issue');
    assert.equal(calls[0], '/api/now/table/incident');
    assert.ok(logs.includes('Reading email content and ServiceNow ticket INC838294...'));
    assert.ok(logs.includes('Related knowledge articles found (1):'));
    assert.ok(logs.includes('  1. KB0000001 - Checkout troubleshooting'));
    assert.ok(logs.includes(configuredType
      ? 'Using configured Jira issue type: Story.'
      : 'Ollama classified this request as a Jira Bug.'));
  });
}

test('lookup failure prevents knowledge search and Jira creation', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(new URL(url).pathname);
    return { ok: true, json: async () => ({ result: [] }) };
  });
  await assert.rejects(createJiraFromEmail({ emailText: 'Incident INC838294: checkout unavailable' }, {
    searchKnowledgeBase: async () => assert.fail('Search must wait for successful lookup'),
  }), /Incident INC838294 not found/);
  assert.deepEqual(calls, ['/api/now/table/incident']);
});

test('a missing ticket number fails before external requests', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No request expected'));
  await assert.rejects(createJiraFromEmail({ emailText: 'Checkout unavailable' }), /INC or SCTASK ticket number/);
});

test('a similar existing Story skips classification, Gemini drafting, and Jira creation', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/now/table/incident') return { ok: true, json: async () => ({ result: [{
      sys_id: 'incident-id', number: 'INC123', short_description: 'Checkout outage', description: 'Payments fail.',
    }] }) };
    if (pathname === '/rest/api/3/search/jql') return { ok: true, json: async () => ({ isLast: true, issues: [{
      key: 'TEST-1', fields: { summary: 'Checkout outage', description: 'Payments fail.', status: { name: 'In Progress' } },
    }] }) };
    if (pathname === '/api/embed') {
      const { input } = JSON.parse(options.body);
      return { ok: true, json: async () => ({ embeddings: input.map(() => [1, 0]) }) };
    }
    assert.fail(`No create request should happen: ${url}`);
  });
  const result = await createJiraFromEmail({ emailText: 'Incident INC123: checkout payments fail.' }, {
    searchKnowledgeBase: async () => [],
    classifyEmail: async () => assert.fail('Must skip classification'),
    understandEmail: async () => assert.fail('Must skip Gemini drafting'),
    createJiraIssue: async () => assert.fail('Must skip issue creation'),
  });
  assert.equal(result.outcome, 'duplicate');
  assert.equal(result.key, 'TEST-1');
  assert.equal(result.similarity, 1);
  assert.equal(result.incidentNumber, 'INC123');
});

test('Jira search errors prevent creation and propagate for mail retry', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (new URL(url).pathname === '/api/now/table/incident') return { ok: true, json: async () => ({ result: [{
      sys_id: 'incident-id', number: 'INC123', short_description: 'Outage',
    }] }) };
    return { ok: false, status: 503, json: async () => ({ message: 'Unavailable' }) };
  });
  await assert.rejects(createJiraFromEmail({ emailText: 'Incident INC123 outage', issueType: 'Story' }, {
    searchKnowledgeBase: async () => [],
    understandEmail: async () => assert.fail('Must not draft without duplicate check'),
    createJiraIssue: async () => assert.fail('Must not create without duplicate check'),
  }), /Jira Story search failed/);
});
