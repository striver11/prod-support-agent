import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, findDuplicateStory, normalizeIncidentText, rememberCreatedStory } from './jira-duplicates.js';

const story = (key = 'TEST-1') => ({ key, summary: 'Checkout payment failure', description: 'Customers cannot submit payments.', status: 'In Progress', url: `https://jira.example/browse/${key}`, issueType: 'Story' });

test('cosine similarity validates vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [2, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.throws(() => cosineSimilarity([1], [1, 2]), /dimensions/);
  assert.throws(() => cosineSimilarity([0, 0], [1, 0]), /Empty embedding/);
  assert.throws(() => cosineSimilarity([NaN, 0], [1, 0]), /Invalid embedding/);
});

test('notification boilerplate and source IDs do not drive similarity', () => {
  assert.equal(normalizeIncidentText('Subject: [Action Required]: Incident INC123 has been assigned to Infra Services\n\nCheckout fails.\nSource ServiceNow ticket: INC123\nhttps://snow.example/ticket'), 'checkout fails.');
});

test('a generic Story for a different incident cannot suppress a new incident', async () => {
  const genericStory = {
    ...story('KAN-13'),
    summary: 'Investigate Incident INC838294 assigned to Infra Services (Priority: P2 – High)',
    description: `Incident Notification Details:
- Incident Number: INC838294
- Assignment Group: Infra Services
- Priority: P2 – High
- Status: In Progress
- Notification Source: ServiceNow Incident Management

Requested Actions:
- Review the incident details directly in ServiceNow (no ServiceNow ticket lookup has been performed yet).
- Investigate the reported issue and take necessary action toward resolution.
- Provide required updates and status notes in ServiceNow.

Note: The notification email did not include specific technical fault details or descriptions of the incident, and none of the available knowledge base articles have been confirmed as matching.

Source ticket number from email: INC838294`,
  };
  const result = await findDuplicateStory('Subject: [Action Required]: Incident INC0010005 has been assigned to Infra Services', {
    serviceNowTicket: {
      number: 'INC0010005', short_description: 'VPN connection fails at the branch office',
      description: 'Router loses its tunnel after rekeying.',
    },
    listStories: async () => [genericStory],
    embed: async () => assert.fail('Generic Story must not be embedded'),
  });
  assert.equal(result, null);
});

test('ServiceNow issue details can match a Story despite a generic assignment email', async () => {
  const inputs = [];
  const result = await findDuplicateStory('Subject: [Action Required]: Incident INC0010005 has been assigned to Infra Services', {
    serviceNowTicket: {
      number: 'INC0010005', short_description: 'Checkout payment service outage',
      description: 'Database connections exhausted while customers submit payments.',
    },
    listStories: async () => [{ ...story(), description: 'Database connections exhausted while customers submit payments.\nSource ServiceNow ticket: INC838294' }],
    embed: async texts => { inputs.push(...texts); return texts.map(() => [1, 0]); },
  });
  assert.equal(result?.outcome, 'duplicate');
  assert.match(inputs[0], /database connections exhausted/);
  assert.match(inputs[1], /database connections exhausted/);
});

test('a matching title cannot substitute for a missing or generic problem description', async t => {
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(line));
  for (const description of ['', 'Incident Notification Details:\nPriority: P2 High\nStatus: In Progress\nRequested Actions:\nReview the incident details directly in ServiceNow.']) {
    const result = await findDuplicateStory('Checkout payment failure. Customers cannot submit payments.', {
      listStories: async () => [{ ...story(), description }],
      embed: async () => assert.fail('Title-only matches must not be scored'),
    });
    assert.equal(result, null);
  }
  assert.ok(logs.some(line => line.includes('Excluded TEST-1') && line.includes('no specific problem details')));
});

test('matching titles cannot override descriptions of a different fault', async () => {
  const result = await findDuplicateStory('Checkout payment failure. Customers cannot submit payments.', {
    listStories: async () => [{ ...story(), description: 'Branch VPN tunnel disconnects during router rekeying.' }],
    embed: async () => assert.fail('Shared title must not qualify unrelated descriptions'),
  });
  assert.equal(result, null);
});

test('the comparison embeds the problem description without the Story title or assignment metadata', async () => {
  const inputs = [];
  await findDuplicateStory('Customers cannot submit payments.', {
    listStories: async () => [{ ...story(), summary: 'Infra assignment notification', description: 'Priority: P2 High\nCustomers cannot submit payments.\nSource ServiceNow ticket: INC999' }],
    embed: async texts => { inputs.push(...texts); return texts.map(() => [1, 0]); },
  });
  assert.equal(inputs[1], 'customers cannot submit payments.');
});

test('same source incident is a duplicate even when both descriptions are empty', async () => {
  const result = await findDuplicateStory('Subject: Incident INC0010005 has been assigned to Infra Services', {
    serviceNowTicket: { number: 'INC0010005', short_description: '', description: '' },
    listStories: async () => [{ ...story('KAN-99'), summary: 'Investigate incident', description: 'Source ServiceNow ticket: INC0010005' }],
    embed: async () => assert.fail('Exact source number needs no embedding'),
  });
  assert.equal(result?.key, 'KAN-99');
  assert.equal(result?.matchReason, 'same incident number');
});

test('high embedding similarity alone does not override unrelated fault descriptions', async () => {
  const result = await findDuplicateStory('Subject: Incident INC0010005 has been assigned to Infra Services', {
    serviceNowTicket: { number: 'INC0010005', short_description: 'VPN tunnel rekeying failure', description: 'Branch router drops connections.' },
    listStories: async () => [{ ...story(), description: 'Checkout payment authorization fails for customers.\nSource ServiceNow ticket: INC838294' }],
    embed: async () => assert.fail('Unrelated details must not be embedded'),
  });
  assert.equal(result, null);
});

for (const score of [0.699, 0.7, 0.9]) {
  test(`duplicate threshold includes 70 percent: score ${score}`, async () => {
    const result = await findDuplicateStory('Customers cannot pay for their order.', {
      listStories: async () => [story()],
      embed: async () => [[1, 0], [score, Math.sqrt(1 - score * score)]],
    });
    assert.equal(result?.outcome === 'duplicate', score >= 0.7);
  });
}

test('chooses the best matching Story and returns its key and link', async () => {
  const result = await findDuplicateStory('Payments fail.', {
    listStories: async () => [story('TEST-1'), story('TEST-2')],
    embed: async () => [[1, 0], [0.8, 0.6], [1, 0]],
  });
  assert.equal(result.key, 'TEST-2');
  assert.equal(result.url, 'https://jira.example/browse/TEST-2');
});

test('empty project needs no embeddings; errors never become no-match results', async () => {
  assert.equal(await findDuplicateStory('Payments fail.', {
    listStories: async () => [], embed: async () => assert.fail('No embedding needed'),
  }), null);
  await assert.rejects(findDuplicateStory('Payments fail.', { listStories: async () => { throw new Error('Jira unavailable'); } }), /Jira unavailable/);
  await assert.rejects(findDuplicateStory('Payments fail.', {
    listStories: async () => [story()], embed: async () => { throw new Error('Ollama unavailable'); },
  }), /Ollama unavailable/);
  await assert.rejects(findDuplicateStory('Payments fail.', {
    listStories: async () => [story()], embed: async () => [[1, 0]],
  }), /Incomplete embeddings/);
});

test('long documents are fully embedded in bounded batches', async () => {
  const longText = 'payment failure '.repeat(4000);
  const allInputs = [];
  await findDuplicateStory('Payments fail.', {
    listStories: async () => [{ ...story(), description: longText }],
    embed: async (input, options) => {
      assert.ok(input.length <= 16);
      assert.equal(options.truncate, false);
      allInputs.push(...input);
      return input.map(() => [1, 0]);
    },
  });
  assert.equal(allInputs.slice(1).join(''), normalizeIncidentText(longText));
});

test('newly created Stories participate while Jira search indexing catches up', async () => {
  rememberCreatedStory(story('TEST-NEW'));
  const result = await findDuplicateStory('Payments fail.', {
    listStories: async () => [], embed: async () => [[1, 0], [1, 0]],
  });
  assert.equal(result.key, 'TEST-NEW');
  // Seeing the issue in live search removes the temporary cache entry.
  await findDuplicateStory('Payments fail.', {
    listStories: async () => [story('TEST-NEW')], embed: async () => [[1, 0], [1, 0]],
  });
});
