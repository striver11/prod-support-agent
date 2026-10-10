const JIRA_BASE_URL = process.env.JIRA_BASE_URL?.replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY;

function getAuthHeader() {
  const missing = [
    ['JIRA_BASE_URL', JIRA_BASE_URL],
    ['JIRA_EMAIL', JIRA_EMAIL],
    ['JIRA_API_TOKEN', JIRA_API_TOKEN],
    ['JIRA_PROJECT_KEY', JIRA_PROJECT_KEY],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    throw new Error(`Missing Jira configuration: ${missing.join(', ')}`);
  }

  return `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`;
}

function toAdf(text) {
  return {
    type: 'doc',
    version: 1,
    content: text.split(/\r?\n/).map(line => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

export function adfToText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(adfToText).join('');
  if (value.type === 'text') return value.text || '';
  if (value.type === 'hardBreak') return '\n';
  const text = adfToText(value.content);
  return ['paragraph', 'heading', 'listItem', 'tableCell', 'tableRow', 'codeBlock'].includes(value.type)
    ? `${text}\n` : text;
}

export async function listJiraStories({ boardId = process.env.JIRA_BOARD_ID?.trim() } = {}) {
  const auth = getAuthHeader();
  if (boardId && !/^\d+$/.test(boardId)) throw new Error('JIRA_BOARD_ID must be a numeric board ID');
  const headers = { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' };
  const request = async (endpoint, options = {}) => {
    const response = await fetch(`${JIRA_BASE_URL}${endpoint}`, {
      ...options, headers, signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Jira Story search failed (${response.status}): ${JSON.stringify(result.errorMessages || result.message || result)}`);
    return result;
  };
  // An inaccessible board can return an empty issue list; verify access first.
  if (boardId) await request(`/rest/agile/1.0/board/${boardId}`);
  const scope = boardId ? `board ${boardId}` : `project ${JIRA_PROJECT_KEY}`;
  const jql = boardId ? 'issuetype = Story ORDER BY key ASC'
    : `project = ${JSON.stringify(JIRA_PROJECT_KEY)} AND issuetype = Story ORDER BY key ASC`;
  const fields = ['summary', 'description', 'status'];
  const stories = new Map();
  const tokens = new Set();
  let nextPageToken;
  do {
    let result;
    if (boardId) {
      const query = new URLSearchParams({ jql, fields: fields.join(','), maxResults: '100' });
      if (nextPageToken) query.set('nextPageToken', nextPageToken);
      result = await request(`/rest/software/1.0/board/${boardId}/issue?${query}`);
    } else {
      result = await request('/rest/api/3/search/jql', {
        method: 'POST', body: JSON.stringify({ jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }),
      });
    }
    if (!Array.isArray(result.issues)) throw new Error('Jira returned an invalid Story search response');
    for (const issue of result.issues) {
      if (!issue.key || typeof issue.fields?.summary !== 'string') throw new Error('Jira returned a Story without its key or summary');
      stories.set(issue.key, {
        key: issue.key, summary: issue.fields.summary,
        description: adfToText(issue.fields.description), status: issue.fields.status?.name || 'Unknown',
        issueType: 'Story', url: `${JIRA_BASE_URL}/browse/${issue.key}`,
      });
    }
    nextPageToken = result.nextPageToken;
    if (result.isLast === false && !nextPageToken) throw new Error('Jira Story search pagination is incomplete');
    if (nextPageToken && (typeof nextPageToken !== 'string' || tokens.has(nextPageToken))) {
      throw new Error('Jira Story search returned an invalid or repeated page token');
    }
    if (nextPageToken) tokens.add(nextPageToken);
  } while (nextPageToken);
  console.log(`Fetched ${stories.size} existing Jira Stories from ${scope}.`);
  return [...stories.values()];
}

export function formatJiraOutcome(result) {
  if (result.outcome === 'duplicate') {
    const reason = result.matchReason === 'same incident number'
      ? 'Same source incident number'
      : `Description embedding similarity: ${(result.similarity * 100).toFixed(1)}% (not a percentage of matching facts)`;
    return `Jira ticket will not be created${result.incidentNumber ? ` for incident ${result.incidentNumber}` : ' for this incident'}. A similar incident already exists in Jira US ${result.key}: ${result.summary}\n${reason}; status: ${result.status}.\n${result.url}`;
  }
  return `Created ${result.key}: ${result.summary}\n${result.url}`;
}

export async function createJiraIssue({ summary, description, issueType = process.env.JIRA_ISSUE_TYPE || 'Story' }) {
  const auth = getAuthHeader();
  if (!['Story', 'Bug'].includes(issueType)) {
    throw new Error('Jira issue type must be Story or Bug');
  }
  const response = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        project: { key: JIRA_PROJECT_KEY },
        summary,
        description: toAdf(description),
        issuetype: { name: issueType },
      },
    }),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result.errors || result.errorMessages || result.message || result;
    throw new Error(`Jira API error ${response.status}: ${JSON.stringify(detail)}`);
  }

  return {
    key: result.key,
    summary,
    issueType,
    url: `${JIRA_BASE_URL}/browse/${result.key}`,
  };
}
