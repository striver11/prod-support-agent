# ServiceNow and Jira Agents

This repository contains two Node.js command-line agents:

- The ServiceNow agent uses Gemini to create, update, close, or retrieve ServiceNow Catalog Tasks from a natural-language command.
- The Jira agent uses Gemini to draft and create a Jira Story or Bug from email text and an existing ServiceNow Catalog Task.

The Jira flow currently takes email text from configuration or the command line. It does not connect to an email inbox.

## Requirements

- Node.js 22 or later
- Python 3 for running Chroma locally without Docker
- A ServiceNow instance with API access to the `sc_task` table; vector indexing also requires read access to `kb_knowledge`
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
SNOW_TICKET_NUMBER=SCTASK0012345
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
   chroma run --path .\agent\vectorDB\chroma-data --host 127.0.0.1 --port 8000
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

It retrieves the ServiceNow task, searches the Chroma index, uses Ollama for automatic Story/Bug classification, sends the email, task, and matching articles to Gemini to draft the Jira summary and description, and creates the selected Jira issue type. If `SNOW_TICKET_NUMBER` is omitted, it tries to find an `SCTASK` number in `EMAIL_TEXT`. The current ServiceNow task lookup only searches the `sc_task` table. Every successful run creates a new Jira issue; there is no duplicate-email detection yet.

Jira Cloud authentication uses your Atlassian account email and an API token. Create a token in your Atlassian account security settings. Keep it private.

## Email and Knowledge-Base Integration

Email intake remains future integration work. The email component should provide the message body and the related ServiceNow Catalog Task number. The Jira agent exports a function for such integrations:

```js
import { createJiraFromEmail } from "./agent/servicenow-agent/jira-agent.js";

const issue = await createJiraFromEmail({
  emailText: email.textBody,
  serviceNowTicketNumber: email.serviceNowTaskNumber,
  issueType: classification.issueType,
});
```

When `issueType` is omitted, the agent retrieves relevant articles from Chroma and classifies the request with Ollama. Retrieved articles are also provided to Gemini as supporting context for the Jira draft. The eventual email trigger should prevent duplicate processing, for example by tracking the email provider's message ID.

## Troubleshooting

- **ServiceNow task not found:** Confirm the ticket exists in the same instance and is a Catalog Task (`SCTASK...`); Incidents (`INC...`) are not supported by the current lookup.
- **ServiceNow authentication or access error:** Verify the instance hostname, username, password, and API access to `sc_task`.
- **Jira project or issue-type error:** Check the project key and confirm that the project supports the selected issue type.
- **Gemini API error:** Verify the API key and model. A `503` may be temporary; retry after a short wait.
- **Ollama or Chroma connection error:** Confirm Ollama and the Chroma server are running, the configured models have been pulled, and the ServiceNow knowledge articles have been indexed.
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
```
