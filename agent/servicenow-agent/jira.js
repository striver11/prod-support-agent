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