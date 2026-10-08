# ServiceNow + Jira Agent — Setup and Run Guide

This project uses:

* **Ollama** for local LLM-based classification
* **ChromaDB** for vector storage and semantic search
* **ServiceNow** for retrieving task and knowledge-article information
* **Jira** for creating and managing Jira issues
* **Gemini API** for the configured AI functionality

---

## 1. Project Structure

The expected project structure is:

```text
F:\POC\new\servicenow-agent
│
├── agent
│   ├── .env
│   │
│   ├── servicenow-agent
│   │   ├── package.json
│   │   └── ...
│   │
│   └── vectorDB
│       ├── package.json
│       ├── index.js
│       └── chroma-data
│
└── README.md
```

> **Important:** The `.env` file must be inside the `agent` folder.

---

# 2. One-Time Machine Setup

These steps only need to be completed once per machine.

---

## 2.1 Install Ollama

Download and install Ollama:

https://ollama.com

After installation, open PowerShell and pull the required models:

```powershell
ollama pull llama3.2:3b
ollama pull nomic-embed-text
```

Verify the models:

```powershell
ollama list
```

Expected models:

```text
llama3.2:3b
nomic-embed-text
```

### Model Purpose

| Model              | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `llama3.2:3b`      | Classifies requests such as Story or Bug                 |
| `nomic-embed-text` | Converts text into embeddings for semantic/vector search |

---

# 3. Install Python and ChromaDB

## 3.1 Check Python

Open PowerShell:

```powershell
py --version
```

Python should be installed and accessible through the `py` command.

## 3.2 Install ChromaDB

```powershell
py -m pip install chromadb
```

You do **not** need to manually create the Chroma data directory.

The application will create it when Chroma is started:

```text
agent\vectorDB\chroma-data
```

---

# 4. Install Node.js Dependencies

Go to the project root:

```powershell
cd F:\POC\new\servicenow-agent
```

Install the ServiceNow agent dependencies:

```powershell
Push-Location agent\servicenow-agent
npm install
Pop-Location
```

Install the vector database dependencies:

```powershell
Push-Location agent\vectorDB
npm install
Pop-Location
```

After these commands, you should be back in:

```text
F:\POC\new\servicenow-agent
```

---

# 5. Configure the `.env` File

Create:

```text
F:\POC\new\servicenow-agent\agent\.env
```

You can create it from PowerShell:

```powershell
cd F:\POC\new\servicenow-agent\agent
New-Item .env -ItemType File
```

Or create a new file named `.env` inside the `agent` folder using VS Code.

---

## 5.1 `.env` Template

Use the following format:

```env
GEMINI_API_KEY=YOUR_GEMINI_API_KEY

SNOW_INSTANCE=YOUR_SERVICENOW_INSTANCE
SNOW_USERNAME=YOUR_SERVICENOW_USERNAME
SNOW_PASSWORD=YOUR_SERVICENOW_PASSWORD

JIRA_BASE_URL=https://YOUR_JIRA_INSTANCE.atlassian.net
JIRA_EMAIL=YOUR_JIRA_EMAIL
JIRA_API_TOKEN=YOUR_JIRA_API_TOKEN
JIRA_PROJECT_KEY=KAN
JIRA_ISSUE_TYPE=Story
```

### Important

Do **not** use spaces in environment variable names.

Correct:

```env
SNOW_INSTANCE=dev450799.service-now.com
SNOW_USERNAME=admin
SNOW_PASSWORD=your_password
```

Incorrect:

```text
SNOW INSTANCE=...
SNOW USERNAME=...
SNOW PASSWORD=...
```

Similarly:

Correct:

```env
JIRA_API_TOKEN=your_token
JIRA_PROJECT_KEY=KAN
JIRA_ISSUE_TYPE=Story
```

Incorrect:

```text
JIRA API_TOKEN-...
JIRA PROJECT_KEY=...
JIRA ISSUE TYPE=...
```

---

# 6. Protect the `.env` File

Never commit credentials to Git.

Add the following to `.gitignore`:

```gitignore
.env
*.env
```

Check that Git does not track the file:

```powershell
git status
```

The `.env` file should not appear as a file ready to commit.

> **Security:** Never paste API keys, passwords, Jira tokens, or ServiceNow credentials into chat, screenshots, presentations, GitHub, or documentation.

---

# 7. Start ChromaDB

ChromaDB needs to be running before the knowledge articles are indexed.

Open **PowerShell Window 1**.

Run:

```powershell
npm.cmd --prefix agent/vectorDB run start:chroma
```

Keep this PowerShell window open.

Chroma will run on:

```text
http://127.0.0.1:8000
```

---

## 7.1 Verify ChromaDB

Open a browser and navigate to:

```text
http://127.0.0.1:8000/api/v2/heartbeat
```

If Chroma is running, you should receive a short response containing a number.

For example:

```text
{"nanosecond heartbeat":123456789}
```

If you see:

```text
ERR_CONNECTION_REFUSED
```

ChromaDB is not running.

---

# 8. Index ServiceNow Knowledge Articles

ChromaDB must be running before this step.

Open **PowerShell Window 2**.

Go to the project root:

```powershell
cd F:\POC\new\servicenow-agent
```

Run:

```powershell
node --env-file=agent\.env agent\vectorDB\index.js
```

Expected output:

```text
Indexed 38 published ServiceNow knowledge article(s) in Chroma.
```

The exact number may vary depending on how many published knowledge articles exist in ServiceNow.

---

## 8.1 When Should Indexing Be Run?

Run the indexing command:

* The first time you set up the project
* When new ServiceNow knowledge articles are added
* When existing articles are modified
* When articles are published

You do **not** need to run indexing every time you start the agent.

---

# 9. Run the ServiceNow Agent

The ServiceNow agent can retrieve details about a specific ServiceNow task.

For example:

```text
get details of task SCTASK0010001
```

From the project root:

```powershell
npm --prefix agent\servicenow-agent start
```

When prompted, provide the task command:

```text
get details of task SCTASK0010001
```

The agent will retrieve the requested information from ServiceNow.

---

# 10. Run the Jira Agent

## Automatic Outlook trigger

To send new Outlook incident subjects to the Jira agent automatically, add `OUTLOOK_CLIENT_ID` and `OUTLOOK_TENANT` to `agent/.env`, then run from the repository root:

```powershell
npm --prefix agent\servicenow-agent run start:mail
```

The watcher opens the Microsoft sign-in page automatically; enter the code printed in the terminal. It checks every 60 seconds and only triggers agents for subjects such as `[Action Required]: Incident INC838294 has been assigned to Infra Services`. Matching is case insensitive, and the group must be exactly `Infra Services`. It extracts the `INC...` number from the subject and reads that record from ServiceNow's `incident` table. The mail watcher does not use `SNOW_TICKET_NUMBER` or `EMAIL_TEXT` from `.env`. Jira, ServiceNow, Gemini, Ollama, and Chroma setup remains as described above; the ServiceNow account also needs read access to `incident`.

Existing mail is skipped on the first run. Each Inbox check logs the number of new emails read, incident subjects, and matching Infra Services assignments. Progress and failed submissions are saved in `outlook-jira.state.json`; preserve it across restarts and run one watcher per mailbox. Saved emails are rechecked against the group filter, and retry logs distinguish previous failures from new mail. See README.md for authentication setup, retry behavior, and state-file details.

## Manual invocation

The Jira agent can use a ServiceNow ticket and email/request information to determine the Jira issue to create.

Start the Jira agent from the project root:

```powershell
npm --prefix agent\servicenow-agent run start:jira
```

The application may ask for inputs such as:

```text
SNOW TICKET NUMBER:
SCTASK0010002
```

And:

```text
EMAIL TEXT:
Several users report that the USB port on their PC stopped working after the latest update, and they cannot connect keyboards or headsets. About 20 people are affected. Please look into it urgently.
```

---

# 11. Example End-to-End Flow

The overall flow is:

```text
                    ┌──────────────────────┐
                    │  Email / User Input  │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │   ServiceNow Agent   │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ ServiceNow Knowledge │
                    │      Articles        │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │      ChromaDB        │
                    │   Vector Database    │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │   Ollama Embeddings  │
                    │ nomic-embed-text     │
                    └──────────────────────┘


Email / Request
       │
       ▼
┌─────────────────────┐
│ Ollama llama3.2:3b  │
│                     │
│ Story or Bug?       │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│     Jira Agent      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│    Jira Project     │
│       KAN           │
└─────────────────────┘
```

---

# 12. Normal Startup Procedure

Once the machine is already configured, you normally only need the following steps.

### Window 1 — Start ChromaDB

```powershell
npm.cmd --prefix agent/vectorDB run start:chroma
```

Keep this window running.

### Window 2 — Run the required agent

For the ServiceNow agent:

```powershell
cd F:\POC\new\servicenow-agent
npm --prefix agent\servicenow-agent start
```

For the Jira agent:

```powershell
cd F:\POC\new\servicenow-agent
npm --prefix agent\servicenow-agent run start:jira
```

---

# 13. Troubleshooting

## ChromaDB connection refused

If:

```text
http://127.0.0.1:8000/api/v2/heartbeat
```

does not open:

1. Check that Chroma PowerShell window is running.
2. Restart Chroma:

```powershell
npm.cmd --prefix agent/vectorDB run start:chroma
```

---

## `.env` variables are not loading

Verify the file exists:

```powershell
Test-Path F:\POC\new\servicenow-agent\agent\.env
```

Expected:

```text
True
```

Also verify that the variable names contain no spaces:

```env
SNOW_INSTANCE=...
SNOW_USERNAME=...
SNOW_PASSWORD=...
```

---

## Node.js dependency error

From the project root:

```powershell
cd F:\POC\new\servicenow-agent
```

Then:

```powershell
Push-Location agent\servicenow-agent
npm install
Pop-Location
```

And:

```powershell
Push-Location agent\vectorDB
npm install
Pop-Location
```

---

## Knowledge articles are not available

Make sure ChromaDB is running first.

Then execute:

```powershell
node --env-file=agent\.env agent\vectorDB\index.js
```

---

# 14. Quick Command Reference

| Task                            | Command                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| Check Python                    | `py --version`                                                 |
| Check Ollama models             | `ollama list`                                                  |
| Pull Llama                      | `ollama pull llama3.2:3b`                                      |
| Pull embeddings                 | `ollama pull nomic-embed-text`                                 |
| Install Chroma                  | `py -m pip install chromadb`                                   |
| Install ServiceNow dependencies | `npm --prefix agent\servicenow-agent install`                  |
| Install vectorDB dependencies   | `npm --prefix agent\vectorDB install`                          |
| Start ChromaDB                  | `npm.cmd --prefix agent/vectorDB run start:chroma` |
| Index knowledge articles        | `node --env-file=agent\.env agent\vectorDB\index.js`           |
| Start ServiceNow agent          | `npm --prefix agent\servicenow-agent start`                    |
| Start Jira agent                | `npm --prefix agent\servicenow-agent run start:jira`           |

---

# 15. Security Checklist

Before pushing the project to Git:

* [ ] `.env` is not committed
* [ ] `.env` is included in `.gitignore`
* [ ] Gemini API key is not hard-coded
* [ ] ServiceNow password is not hard-coded
* [ ] Jira API token is not hard-coded
* [ ] Credentials are not present in README
* [ ] Credentials are not present in screenshots
* [ ] Credentials are not present in source code
* [ ] Any previously exposed credentials have been rotated

---

## 16. Important Command Notes

The following are the correct command formats used in this project:

### Correct

```powershell
node --env-file=agent\.env agent\vectorDB\index.js
```

```powershell
npm --prefix agent\servicenow-agent start
```

```powershell
npm --prefix agent\servicenow-agent run start:jira
```

### Incorrect

```text
node-env-file-agent\.env
```

```text
npm-prefix agent\servicenow-agent
```

The corrected commands above should be used when running the project.
