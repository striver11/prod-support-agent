// Watch Outlook and pass new incident subjects to the existing Jira agent.
const { readFile, writeFile, rename } = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { execFile } = require('node:child_process');

const GRAPH_URL = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta';
const SCOPE = 'https://graph.microsoft.com/Mail.ReadBasic offline_access';
const POLL_MS = 60_000;

class StateError extends Error {}

function openSignInPage(value) {
  const onError = () => console.warn('Could not open the browser automatically. Open the sign-in URL printed above.');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('Expected an HTTPS sign-in URL');
    const options = { windowsHide: true, timeout: 10_000 };
    let command;
    let args;
    if (process.platform === 'win32') {
      command = 'powershell.exe';
      // Pass the URL as data, keeping it out of the PowerShell command text.
      args = ['-NoProfile', '-NonInteractive', '-Command',
        'Start-Process -FilePath $env:OUTLOOK_SIGN_IN_URL -ErrorAction Stop'];
      options.env = { ...process.env, OUTLOOK_SIGN_IN_URL: url.href };
    } else {
      command = process.platform === 'darwin' ? 'open' : 'xdg-open';
      args = [url.href];
    }
    execFile(command, args, options, error => { if (error) onError(); });
  } catch {
    onError();
  }
}

async function jsonRequest(url, { form, headers } = {}) {
  const response = await fetch(url, {
    method: form ? 'POST' : 'GET',
    body: form ? new URLSearchParams(form) : undefined,
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => {
    throw new Error(`Microsoft returned an invalid response (HTTP ${response.status}).`);
  });
  return { status: response.status, result };
}

class GraphAuth {
  constructor(clientId, tenant) {
    this.clientId = clientId;
    this.authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  }

  remember(result) {
    this.accessToken = result.access_token;
    this.refreshToken = result.refresh_token || this.refreshToken;
    this.expiresAt = Date.now() + Number(result.expires_in || 3600) * 1000;
  }

  async signIn() {
    const { status, result: flow } = await jsonRequest(`${this.authority}/devicecode`, {
      form: { client_id: this.clientId, scope: SCOPE },
    });
    if (status !== 200) {
      throw new Error(`Sign-in could not start: ${flow.error_description || flow.error || status}`);
    }
    console.log(flow.message || `Visit ${flow.verification_uri} and enter code ${flow.user_code}`);
    openSignInPage(flow.verification_uri_complete || flow.verification_uri);
    let interval = Math.max(1, Number(flow.interval || 5)) * 1000;
    const deadline = Date.now() + Number(flow.expires_in) * 1000;
    while (Date.now() < deadline) {
      await sleep(interval);
      const { status: tokenStatus, result } = await jsonRequest(`${this.authority}/token`, {
        form: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: this.clientId,
          device_code: flow.device_code,
        },
      });
      if (tokenStatus === 200 && result.access_token) {
        this.remember(result);
        return;
      }
      if (result.error === 'authorization_pending') continue;
      if (result.error === 'slow_down') {
        interval += 5000;
        continue;
      }
      throw new Error(`Sign-in failed: ${result.error_description || result.error || tokenStatus}`);
    }
    throw new Error('Sign-in timed out. Restart the watcher for a new code.');
  }

  async token() {
    if (!this.accessToken) {
      await this.signIn();
    } else if (Date.now() >= this.expiresAt - 60_000) {
      if (this.refreshToken) {
        const { status, result } = await jsonRequest(`${this.authority}/token`, {
          form: {
            grant_type: 'refresh_token',
            client_id: this.clientId,
            refresh_token: this.refreshToken,
            scope: SCOPE,
          },
        });
        if (status === 200 && result.access_token) {
          this.remember(result);
          return this.accessToken;
        }
      }
      console.log('Sign-in needs to be renewed.');
      await this.signIn();
    }
    return this.accessToken;
  }
}

function initialDeltaUrl() {
  return `${GRAPH_URL}?${new URLSearchParams({
    changeType: 'created',
    $select: 'id,subject,receivedDateTime',
  })}`;
}

function validDeltaUrl(value) {
  try {
    const url = new URL(value);
    // Graph can return OData key syntax: mailFolders('id'), not only
    // mailFolders/id. Validate the path without rewriting opaque cursor URLs.
    const pathname = url.pathname.replace(/%27/gi, "'");
    return url.origin === 'https://graph.microsoft.com'
      && !url.username && !url.password && !url.hash
      && /^\/v1\.0\/(?:me|users\/[^/]+|users\('[^/']+'\))\/mailfolders(?:\/[^/]+|\('[^/']+'\))\/messages\/delta$/i.test(pathname);
  } catch {
    return false;
  }
}

async function saveState(file, state) {
  try {
    await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  } catch (error) {
    // Stop on persistence failures: continuing could submit the same email twice.
    throw new StateError(`Cannot save state file ${file}: ${error.message}`);
  }
}

async function loadState(file, clientId, tenant) {
  let state;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new StateError(`Cannot read state file ${file}: ${error.message}`);
    }
    state = {
      client_id: clientId,
      tenant,
      started_at: new Date().toISOString(),
      cursor: null,
      initialized: false,
      seen_ids: [],
      pending: [],
    };
    await saveState(file, state);
  }
  if (!state || state.client_id !== clientId || state.tenant !== tenant) {
    throw new StateError(`${file} belongs to another app or tenant. Use --state-file for this mailbox.`);
  }
  if (!Array.isArray(state.seen_ids) || !state.seen_ids.every(id => typeof id === 'string')
      || !Number.isFinite(Date.parse(state.started_at))
      || typeof state.initialized !== 'boolean'
      || !Array.isArray(state.pending)
      || !state.pending.every(message => message && typeof message.id === 'string'
        && typeof message.subject === 'string')
      || (state.cursor !== null && !validDeltaUrl(state.cursor))) {
    throw new StateError(`Invalid state file: ${file}`);
  }
  return state;
}

function isIncident(subject) {
  return /\bincident\b/i.test(subject || '');
}

function parseIncidentAssignment(subject) {
  const match = (subject || '').match(/\bincident\s+(INC\d+)\s+has\s+been\s+assigned\s+to\s+(Infra\s+Services)\s*$/i);
  if (!match) return null;
  return { incidentNumber: match[1].toUpperCase(), serviceGroup: 'Infra Services' };
}

async function pollInbox(auth, state, stateFile, request = jsonRequest) {
  let url = state.cursor || initialDeltaUrl();
  const seen = new Set(state.seen_ids);
  const startedAt = Date.parse(state.started_at);
  let resetAttempted = false;
  let authRetried = false;
  const counts = { newEmails: 0, incidentEmails: 0, matchingAssignments: 0, existingSkipped: 0 };
  while (true) {
    const { status, result } = await request(url, {
      headers: { Authorization: `Bearer ${await auth.token()}`, Prefer: 'IdType="ImmutableId"' },
    });
    if (status === 401 && !authRetried) {
      authRetried = true;
      auth.expiresAt = 0;
      continue;
    }
    if (status === 410 || result?.error?.code === 'syncStateNotFound') {
      if (resetAttempted) throw new Error('Inbox change cursor could not be rebuilt.');
      resetAttempted = true;
      state.cursor = null;
      await saveState(stateFile, state);
      url = initialDeltaUrl();
      continue;
    }
    if (status !== 200) {
      throw new Error(`Could not check Inbox: ${result?.error?.message || `HTTP ${status}`}`);
    }
    if (!Array.isArray(result?.value)) throw new Error('Unexpected Inbox response from Microsoft.');
    const nextUrl = result['@odata.nextLink'] || result['@odata.deltaLink'];
    if (!validDeltaUrl(nextUrl)) throw new Error('Microsoft returned an invalid Inbox change URL.');
    for (const message of result.value) {
      if (!message.id || '@removed' in message || seen.has(message.id)) continue;
      const isNew = state.initialized || Date.parse(message.receivedDateTime) > startedAt;
      const subject = message.subject || '(no subject)';
      if (isNew) {
        counts.newEmails++;
        console.log(`New email: ${JSON.stringify(subject)}`);
        if (isIncident(subject)) counts.incidentEmails++;
        const assignment = parseIncidentAssignment(subject);
        if (assignment) {
          counts.matchingAssignments++;
          state.pending.push({ id: message.id, subject });
          console.log(`Queued ${assignment.incidentNumber}: assigned to ${assignment.serviceGroup}.`);
        } else if (isIncident(subject)) {
          console.log('Skipped: subject must contain "Incident INC<number> has been assigned to Infra Services".');
        }
      } else {
        counts.existingSkipped++;
      }
      seen.add(message.id);
      state.seen_ids.push(message.id);
    }
    // Persist the queue with the cursor before any external Jira side effect.
    state.cursor = nextUrl;
    if (result['@odata.deltaLink']) state.initialized = true;
    await saveState(stateFile, state);
    if (result['@odata.deltaLink']) {
      console.log(`[${new Date().toISOString()}] Inbox check: new emails read=${counts.newEmails}, incident emails=${counts.incidentEmails}, Infra Services matches=${counts.matchingAssignments}, existing emails skipped=${counts.existingSkipped}, queued=${state.pending.length}.`);
      return counts;
    }
    url = nextUrl;
  }
}

async function submitIncident({ subject }, createIssue) {
  const assignment = parseIncidentAssignment(subject);
  if (!assignment) {
    throw new Error('Only incident assignment emails for Infra Services can trigger the Jira agent.');
  }
  createIssue ||= (await import('./agent/servicenow-agent/jira-agent.js')).createJiraFromEmail;
  return createIssue({
    emailText: subject,
    serviceNowTicketNumber: assignment.incidentNumber,
    issueType: process.env.JIRA_ISSUE_TYPE || undefined,
  });
}

async function processPending(state, stateFile, submit = submitIncident) {
  for (const message of [...state.pending]) {
    // Recheck saved messages too: earlier versions queued any incident keyword.
    const assignment = parseIncidentAssignment(message.subject);
    if (!assignment) {
      state.pending = state.pending.filter(item => item.id !== message.id);
      await saveState(stateFile, state);
      console.log(`Skipped saved email: ${JSON.stringify(message.subject)} does not match an Infra Services incident assignment.`);
      continue;
    }
    message.attempts = (Number.isSafeInteger(message.attempts) ? message.attempts : 0) + 1;
    await saveState(stateFile, state);
    console.log(`Processing queued email for ${assignment.incidentNumber} (attempt ${message.attempts}). ${message.attempts > 1 ? 'Retrying a previous failure; this is not a newly received email.' : ''}`.trim());
    let created;
    try {
      created = await submit(message);
    } catch (error) {
      console.error(`Jira submission failed for ${JSON.stringify(message.subject)}; queued for retry: ${error.message}`);
      continue;
    }
    state.pending = state.pending.filter(item => item.id !== message.id);
    await saveState(stateFile, state);
    console.log(`Created ${created.key}: ${created.summary}\n${created.url}`);
  }
  if (state.pending.length) console.log(`Pending retries: ${state.pending.length}. Next attempt on the next Inbox check.`);
}

async function main() {
  const { values } = parseArgs({ options: {
    'state-file': { type: 'string', default: path.join(__dirname, 'outlook-jira.state.json') },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node readmail.js [--state-file path]\nLoads agent/.env automatically. Triggers Jira only for INC incidents assigned to Infra Services in the email subject.');
    return;
  }
  try {
    process.loadEnvFile(path.join(__dirname, 'agent', '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const clientId = process.env.OUTLOOK_CLIENT_ID?.trim();
  const tenant = process.env.OUTLOOK_TENANT?.trim() || 'common';
  if (!clientId) throw new Error('Set OUTLOOK_CLIENT_ID first. See README.md for setup.');
  if (!/^[A-Za-z0-9.-]+$/.test(tenant)) throw new Error('Invalid OUTLOOK_TENANT.');
  const stateFile = path.resolve(values['state-file']);
  const state = await loadState(stateFile, clientId, tenant);
  const auth = new GraphAuth(clientId, tenant);
  await auth.signIn();
  console.log('Watching Inbox every 60 seconds. Only incident assignment emails for Infra Services trigger agents; the INC number comes from the subject.');
  console.log(`Loaded ${state.pending.length} saved queued email(s). Saved emails are rechecked against the assignment filter before retrying.`);
  while (true) {
    const nextPoll = Date.now() + POLL_MS;
    try {
      await pollInbox(auth, state, stateFile);
    } catch (error) {
      if (error instanceof StateError) throw error;
      console.error(`Inbox check failed: ${error.message}`);
    }
    await processPending(state, stateFile);
    await sleep(Math.max(0, nextPoll - Date.now()));
  }
}

module.exports = { GraphAuth, isIncident, parseIncidentAssignment, loadState, pollInbox, processPending, submitIncident, validDeltaUrl };

if (require.main === module) {
  main().catch(error => {
    console.error(`Mail watcher failed: ${error.message}`);
    process.exitCode = 1;
  });
}
