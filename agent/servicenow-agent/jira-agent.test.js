import { test } from 'node:test';
import assert from 'node:assert/strict';

// Isolated test process: all external HTTP calls are intercepted below.
process.env.GEMINI_API_KEY = 'test-key';
process.env.JIRA_BASE_URL = 'https://jira.example';
process.env.JIRA_EMAIL = 'test@example.com';
process.env.JIRA_API_TOKEN = 'test-token';
process.env.JIRA_PROJECT_KEY = 'TEST';
const { createJiraFromEmail } = await import('./jira-agent.js');

for (const configuredType of [undefined, 'Story']) {
  test(`email content drives knowledge search and Jira creation without ServiceNow lookup (${configuredType || 'automatic type'})`, async t => {
    const email = 'Subject: [Action Required]: Incident INC838294 has been assigned to Infra Services\n\nCheckout fails after the latest deployment. Twenty users are affected.';
    const calls = [];
    const logs = [];
    t.mock.method(console, 'log', line => logs.push(line));
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      const payload = JSON.parse(options.body);
      if (pathname === '/api/chat') {
        assert.equal(configuredType, undefined);
        const source = JSON.parse(payload.messages[1].content);
        assert.equal(source.email, email);
        assert.equal(source.serviceNowTicket, undefined);
        assert.equal(source.knowledgeArticles[0].number, 'KB0000001');
        return { ok: true, json: async () => ({ message: { content: '{"issueType":"Bug"}' } }) };
      }
      if (pathname.endsWith(':generateContent')) {
        const prompt = payload.contents[0].parts[0].text;
        assert.ok(prompt.includes('Twenty users are affected.'));
        assert.ok(prompt.includes('KB0000001'));
        assert.ok(!prompt.includes('"serviceNowTicket"'));
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          summary: 'Checkout fails after deployment', description: 'Twenty users cannot check out.',
        }) }] } }] }) };
      }
      if (pathname === '/rest/api/3/issue') {
        assert.equal(payload.fields.issuetype.name, configuredType || 'Bug');
        assert.equal(payload.fields.summary, 'Checkout fails after deployment');
        const description = JSON.stringify(payload.fields.description);
        assert.ok(!description.includes('nav_to.do'));
        if (!configuredType) assert.ok(description.includes('INC838294'));
        return { ok: true, json: async () => ({ key: 'TEST-1' }) };
      }
      assert.fail(`Unexpected HTTP call (no ServiceNow lookup allowed): ${url}`);
    });
    const created = await createJiraFromEmail({
      emailText: email,
      serviceNowTicketNumber: configuredType ? undefined : 'INC838294',
      issueType: configuredType,
    }, {
      searchKnowledgeBase: async query => {
        assert.equal(query, email);
        return [{ document: 'Deployment troubleshooting steps', metadata: { number: 'KB0000001', title: 'Checkout\n troubleshooting' } }];
      },
    });
    assert.equal(created.key, 'TEST-1');
    assert.equal(calls.length, configuredType ? 2 : 3);
    assert.ok(logs.includes('Reading email content...'));
    assert.ok(logs.includes('Related knowledge articles found (1):'));
    assert.ok(logs.includes('  1. KB0000001 - Checkout troubleshooting'));
    assert.ok(logs.includes(configuredType
      ? 'Using configured Jira issue type: Story.'
      : 'Ollama classified this request as a Jira Bug.'));
  });
}
