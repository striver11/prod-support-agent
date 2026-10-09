# ServiceNow and Jira Agents

This repository contains two Node.js command-line agents:

- The ServiceNow agent uses Gemini to create, update, close, or retrieve ServiceNow Catalog Tasks from a natural-language command.
- The Jira agent searches indexed knowledge articles using email content, then uses Gemini to draft and create a Jira Story or Bug. Direct ServiceNow ticket lookup is temporarily disabled.

The Jira flow accepts email text from configuration or the command line. The Outlook watcher invokes it automatically only for new Inbox subjects reporting an `INC...` incident assigned to `Infra Services` (case insensitive).

## Requirements

- Node.js 22 or later
- Python 3 for running Chroma locally without Docker
- ServiceNow access for Catalog Task commands and knowledge-article indexing. The email-to-Jira flow uses the existing vector index without looking up a ServiceNow ticket.
- For ServiceNow commands and Jira creation: a Gemini API key
- For Jira creation: a Jira Cloud API token

## Install

```powershell
Push-Location agent\servicenow-agent
npm install
Pop-Location

Push-Location agent\vectorDB
npm install
Pop-Location
```

The local `agent/.env` file is shared by both modules, ignored by Git, and should not be committed.

## ServiceNow Agent

Set these variables in `agent/.env`:

```dotenv
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-3.8-flash
SNOW_INSTANCE=your-instance.service-now.com
SNOW_USERNAME=admin
SNOW_PASSWORD=your-instance-password
```

From the repository root, run a ServiceNow command:

```powershell
$env:USER_COMMAND = "create a task for deployment review"
npm --prefix agent\servicenow-agent start
```

The agent supports creating, updating, closing, and retrieving ServiceNow Catalog Tasks. Ticket numbers currently use the `SCTASK...` format.

The GitHub Actions workflow at `.github/workflows/servicenow-agent.yml` runs this ServiceNow command agent through a manual `workflow_dispatch` input. Configure `GEMINI_API_KEY`, `SNOW_INSTANCE`, `SNOW_USERNAME`, and `SNOW_PASSWORD` as repository Actions secrets before running it.

## Jira Agent

Configure the Jira flow in `agent/.env`:

```dotenv
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-3.8-flash
SNOW_INSTANCE=your-instance.service-now.com
SNOW_USERNAME=admin
SNOW_PASSWORD=your-instance-password
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_PROJECT_KEY=YOURPROJECT
# Optional override: Story or Bug. Leave unset for Ollama classification.
EMAIL_TEXT="Customer reports that checkout fails after payment."
```

Use the Jira project key assigned to your project, not the example value above. `JIRA_ISSUE_TYPE` is optional; when set, it must be `Story` or `Bug` and overrides automatic classification. If unset, the Jira agent classifies the request using Ollama and the indexed knowledge articles. `GEMINI_MODEL` is optional; the current default is `gemini-3.8-flash`.

## Vector Database (ServiceNow Knowledge Base)

The application is organized under `agent/`: `agent/servicenow-agent/` contains the ServiceNow and Jira agents, and `agent/vectorDB/` contains the separate vector-database module. It uses Ollama to embed published ServiceNow Knowledge Base articles, stores them in Chroma, and retrieves relevant articles for Ollama's Story/Bug classification and Gemini's Jira draft.

1. Install the vector database module dependencies from the repository root:

   ```powershell
   Push-Location agent\vectorDB
   npm install
   Pop-Location
   ```

2. Start a persistent local Chroma server without Docker. Install Chroma in Python:

   ```powershell
   py -m pip install chromadb
   ```

   Then, from the repository root, start Chroma and leave this terminal running:

   ```powershell
   npm.cmd --prefix agent/vectorDB run start:chroma
   ```

3. Install [Ollama](https://ollama.com/) and pull a chat model and embedding model:

   ```powershell
   ollama pull llama3.2:3b
   ollama pull nomic-embed-text
   ```

4. Add these optional settings to `agent/.env` if you want to use different models or endpoints:

   ```dotenv
   OLLAMA_URL=http://127.0.0.1:11434
   OLLAMA_CHAT_MODEL=llama3.2:3b
   OLLAMA_EMBED_MODEL=nomic-embed-text
   CHROMA_URL=http://127.0.0.1:8000
   CHROMA_COLLECTION=servicenow_knowledge
   ```

5. Ensure the ServiceNow account can read the `kb_knowledge` table, then index active, published articles from the repository root:

   ```powershell
   node --env-file=agent/.env agent/vectorDB/index.js
   ```

   Run this again after Knowledge Base content changes to upsert the articles.

The Jira flow requires the Chroma server and Ollama to be running, and the index to contain articles. It automatically classifies each request when `JIRA_ISSUE_TYPE` is unset. Start the Jira flow from the repository root:

```powershell
npm --prefix agent/servicenow-agent run start:jira
```

It searches the Chroma knowledge-article index using the email content, prints related articles, uses Ollama for automatic Story/Bug classification, and sends the email plus matching articles to Gemini to draft the Jira summary and description. Direct ServiceNow ticket lookup is commented out for now. An INC or SCTASK number found in manual email text is retained only as a source reference; a ticket number is not required for manual runs, and `SNOW_TICKET_NUMBER` is unused. Every successful manual run creates a new Jira issue; duplicate-email tracking is provided by the Outlook watcher below.

Jira Cloud authentication uses your Atlassian account email and an API token. Create a token in your Atlassian account security settings. Keep it private.

## Email and Knowledge-Base Integration

### Automatic Outlook incident intake

`readmail.js` is the JavaScript replacement for the subject-printing `readmail.py`. It uses Microsoft Graph device-code sign-in and checks the Inbox every 60 seconds. Only subjects matching this assignment format trigger the agents:

```text
[Action Required]: Incident INC838294 has been assigned to Infra Services
```

The watcher extracts `INC838294` from the subject and requires the assigned group to be exactly `Infra Services`, ignoring case and extra whitespace. Subjects for other groups, without an INC number, or containing only a generic incident keyword are skipped. For matching emails, it fetches the full plain-text body from Microsoft Graph and passes the subject plus body as `emailText` to `createJiraFromEmail`. This content drives the similarity search over the existing knowledge-article index, classification, and Jira drafting. No direct ServiceNow Incident lookup is performed. Attachments are not read.

Add the Outlook settings to `agent/.env`, alongside the existing Jira, ServiceNow, and Gemini settings:

```dotenv
OUTLOOK_CLIENT_ID=your-microsoft-app-client-id
OUTLOOK_TENANT=common
```

Use the Microsoft app registration from the Python reader, with public client/device-code authentication enabled and delegated Microsoft Graph `Mail.Read` permission. The previous `Mail.ReadBasic` permission excludes email bodies. Restart the watcher and consent to `Mail.Read` when prompted; if consent is blocked, add this delegated permission in the app registration and have your administrator grant it as required by your tenant. See [Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference#mailread). `OUTLOOK_TENANT` can be your tenant ID, `organizations`, `consumers`, or `common`, as appropriate for the registration.

With the existing Jira dependencies and services configured above, run from the repository root:

```powershell
npm --prefix agent/servicenow-agent run start:mail
```

Alternatively:

```powershell
node readmail.js
```

The watcher automatically loads `agent/.env` relative to its script location. Environment variables already set in the terminal take precedence.

The watcher opens the Microsoft sign-in page in your default browser automatically. Enter the device code printed in the terminal when prompted, then sign in to the mailbox. If the browser cannot open, use the printed URL manually. Leave the watcher running; stop with Ctrl+C. Tokens refresh in memory, and a restart requires signing in again.

The mail watcher retains the INC number from the assignment subject as a source reference only. It does not use `SNOW_TICKET_NUMBER` or `EMAIL_TEXT` from `.env`. Manual Jira commands still accept `EMAIL_TEXT`.

On its first run, the watcher skips mail received before startup. It saves the Inbox cursor, seen message IDs, and pending incident subjects in the Git-ignored `outlook-jira.state.json`. Bodies are fetched only for matching queued messages and cached there until successful Jira creation, including for subjects queued by earlier versions. Body-read failures stay queued and do not trigger Jira using only a subject. Completed messages are skipped across restarts, and failed submissions retry on later polls without blocking other queued messages. Keep this file to preserve progress. It is separate from the Python reader's state. Use `--state-file path` for a separate mailbox, and run only one watcher per mailbox/state file. Custom state files contain email subjects and bodies and should also be Git-ignored.

Each completed Inbox check logs counts for new emails read, subjects containing the incident keyword, matching Infra Services assignments, existing mail skipped, and queued messages. Counts cover all pages of that check and exclude duplicate/deleted messages. An idle check reports zero new emails. For example:

```text
Inbox check: new emails read=4, incident emails=3, Infra Services matches=1, existing emails skipped=0, queued=1.
Processing queued email for INC838294 (attempt 1).
```

On restart, saved queued emails are rechecked against the assignment filter; older generic incident subjects are skipped without calling any agents. Eligible failures remain queued and can retry even when there is no new mail. Logs identify retries and their attempt number. Mail arriving while the watcher was stopped is picked up from the saved cursor on restart.

There is a small duplicate risk if Jira creates an issue but the response is lost or the process stops before saving success; local state does not provide an atomic transaction with Jira.

Run the automated watcher checks without contacting Outlook or Jira:

```powershell
node --test readmail.test.js agent/servicenow-agent/servicenow.test.js agent/servicenow-agent/jira-agent.test.js
```

### Calling the Jira agent from other integrations

The Jira agent exports a function for email integrations:

```js
import { createJiraFromEmail } from "./agent/servicenow-agent/jira-agent.js";

const issue = await createJiraFromEmail({
  emailText: email.textBody,
  serviceNowTicketNumber: email.serviceNowTicketNumber, // Optional reference, no lookup.
  issueType: classification.issueType,
});
```

When `issueType` is omitted, the agent retrieves relevant articles from Chroma and classifies the request with Ollama. Retrieved articles are also provided to Gemini as supporting context for the Jira draft. The Outlook watcher tracks Microsoft's immutable message IDs to avoid resubmitting completed messages.

## Troubleshooting

- **Cannot read email body:** Grant delegated Microsoft Graph `Mail.Read` permission and restart the watcher to sign in again. Existing Inbox cursors and queued emails can be kept.
- **ServiceNow ticket not found in standalone commands:** Confirm the ticket exists in the configured instance. Ticket lookup is currently disabled in the email-to-Jira flow.
- **ServiceNow authentication or access error:** Verify the instance hostname, username, password, and API access to the relevant `incident` or `sc_task` table.
- **Jira project or issue-type error:** Check the project key and confirm that the project supports the selected issue type.
- **Gemini API error:** Verify the API key and model. A `503` may be temporary; retry after a short wait.
- **Ollama or Chroma connection error:** Confirm Ollama and the Chroma server are running, the configured models have been pulled, and the ServiceNow knowledge articles have been indexed. On Windows, start Chroma from the repository root with `npm.cmd --prefix agent/vectorDB run start:chroma` and leave it running. Check `http://127.0.0.1:8000/api/v2/heartbeat`. If the index is empty, run `node --env-file=agent/.env agent/vectorDB/index.js`. The mail watcher retries queued incidents automatically once the services recover.
- **ServiceNow knowledge-base access error:** Verify the account can read published records from the `kb_knowledge` table.
- **Credentials:** Never commit `.env` or paste API tokens and passwords into chat or issue trackers.

## Project Files

```text
.github/workflows/servicenow-agent.yml  Manual GitHub Actions workflow for ServiceNow
agent/servicenow-agent/index.js          Gemini-based ServiceNow command agent
agent/servicenow-agent/servicenow.js     ServiceNow REST API client
agent/servicenow-agent/jira-agent.js     Gemini-based email and ServiceNow to Jira flow
agent/servicenow-agent/jira.js           Jira Cloud REST API client
agent/servicenow-agent/package.json      ServiceNow/Jira scripts and dependencies
agent/vectorDB/index.js                  Indexes published ServiceNow Knowledge Base articles
agent/vectorDB/knowledge-base.js         Ollama embeddings and Chroma vector search
agent/vectorDB/classifier.js             Ollama Story/Bug classification
agent/vectorDB/package.json              Chroma client dependency
agent/.env                              Local, Git-ignored configuration
readmail.js                             Outlook incident subject watcher and Jira trigger
readmail.test.js                        Offline watcher tests
```
