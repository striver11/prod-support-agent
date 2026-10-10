import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.JIRA_BASE_URL = 'https://jira.example';
process.env.JIRA_EMAIL = 'test@example.com';
process.env.JIRA_API_TOKEN = 'test-token';
process.env.JIRA_PROJECT_KEY = 'KAN';
const { adfToText, listJiraStories, formatJiraOutcome } = await import('./jira.js');
const issue = key => ({ key, fields: { summary: 'Checkout failure', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Payments fail.' }] }] }, status: { name: 'In Progress' } } });

test('reads rich-text descriptions including lists and tables', () => {
  assert.equal(adfToText(issue('KAN-1').fields.description).trim(), 'Payments fail.');
  assert.equal(adfToText(null), '');
  assert.equal(adfToText('Plain text'), 'Plain text');
  assert.match(adfToText({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Outage' }] }] }] }] }), /Outage/);
});

test('fetches every project Story page, including a duplicate on a later page', async t => {
  let page = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://jira.example/rest/api/3/search/jql');
    const body = JSON.parse(options.body);
    assert.equal(body.jql, 'project = "KAN" AND issuetype = Story ORDER BY key ASC');
    assert.deepEqual(body.fields, ['summary', 'description', 'status']);
    if (page++ === 0) return { ok: true, json: async () => ({ issues: [issue('KAN-1')], nextPageToken: 'page-2', isLast: false }) };
    assert.equal(body.nextPageToken, 'page-2');
    return { ok: true, json: async () => ({ issues: [issue('KAN-2')], isLast: true }) };
  });
  const stories = await listJiraStories({ boardId: '' });
  assert.deepEqual(stories.map(s => s.key), ['KAN-1', 'KAN-2']);
  assert.equal(stories[1].description.trim(), 'Payments fail.');
  assert.equal(stories[1].url, 'https://jira.example/browse/KAN-2');
});

test('optional board ID uses board access check and enhanced board search', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    if (url.endsWith('/board/42')) return { ok: true, json: async () => ({ id: 42 }) };
    assert.equal(new URL(url).pathname, '/rest/software/1.0/board/42/issue');
    assert.equal(new URL(url).searchParams.get('jql'), 'issuetype = Story ORDER BY key ASC');
    return { ok: true, json: async () => ({ issues: [issue('KAN-1')], isLast: true }) };
  });
  assert.equal((await listJiraStories({ boardId: '42' })).length, 1);
  assert.equal(requests.length, 2);
});

test('failed, malformed, or incomplete search never silently succeeds', async t => {
  for (const response of [
    { ok: false, status: 403, json: async () => ({ message: 'Forbidden' }) },
    { ok: true, json: async () => ({}) },
    { ok: true, json: async () => ({ issues: [], isLast: false }) },
    { ok: true, json: async () => ({ issues: [], nextPageToken: 'repeat' }) },
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(listJiraStories({ boardId: '' }));
    mock.mock.restore();
  }
});

test('duplicate log identifies the existing US and never claims creation', () => {
  const log = formatJiraOutcome({ outcome: 'duplicate', key: 'KAN-14', summary: 'Checkout failure', similarity: 0.85, status: 'In Progress', url: 'https://jira.example/browse/KAN-14' });
  assert.match(log, /Jira ticket will not be created for this incident/);
  assert.match(log, /already exists in Jira US KAN-14/);
  assert.match(log, /85.0%/);
  assert.ok(!log.includes('Created KAN-14'));
});
