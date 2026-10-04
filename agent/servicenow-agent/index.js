// index.js — Gemini-powered ServiceNow Agent
import { createTask, updateTask, closeTask, getTask } from './servicenow.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const userCommand = process.env.USER_COMMAND;

if (!GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY.');
  process.exit(1);
}

if (!userCommand) {
  console.error('❌ No command provided. Set USER_COMMAND env variable.');
  process.exit(1);
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const tools = [
  {
    name: 'create_task',
    description: 'Create a new task in ServiceNow. Use when user wants to create, add, or open a new task/ticket.',
    input_schema: {
      type: 'object',
      properties: {
        short_description: {
          type: 'string',
          description: 'A concise title for the task (max 80 chars)',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the task',
        },
        priority: {
          type: 'string',
          enum: ['1', '2', '3', '4'],
          description: '1=Critical, 2=High, 3=Moderate, 4=Low. Infer from context.',
        },
      },
      required: ['short_description', 'description'],
    },
  },
  {
    name: 'update_task',
    description: 'Update an existing ServiceNow task status or description. Use when user mentions a ticket number and wants to change its state.',
    input_schema: {
      type: 'object',
      properties: {
        number: {
          type: 'string',
          description: 'The ServiceNow task number e.g. SCTASK0010001',
        },
        state: {
          type: 'string',
          description: 'New state: open, in progress, closed, complete, incomplete',
        },
        short_description: {
          type: 'string',
          description: 'Optional updated title',
        },
      },
      required: ['number', 'state'],
    },
  },
  {
    name: 'close_task',
    description: 'Close a ServiceNow task. Use when user says close, done, complete, or resolve a task.',
    input_schema: {
      type: 'object',
      properties: {
        number: {
          type: 'string',
          description: 'The ServiceNow task number e.g. SCTASK0010001',
        },
        resolution_notes: {
          type: 'string',
          description: 'Brief notes on how/why the task was closed',
        },
      },
      required: ['number'],
    },
  },
  {
    name: 'get_task',
    description: 'Get details of an existing ServiceNow task by number.',
    input_schema: {
      type: 'object',
      properties: {
        number: {
          type: 'string',
          description: 'The ServiceNow task number e.g. SCTASK0010001',
        },
      },
      required: ['number'],
    },
  },
];

function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;

  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [
    key,
    key === 'type' && typeof value === 'string'
      ? value.toUpperCase()
      : toGeminiSchema(value),
  ]));
}

const geminiTools = [{
  functionDeclarations: tools.map(({ name, description, input_schema }) => ({
    name,
    description,
    parameters: toGeminiSchema(input_schema),
  })),
}];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, input) {
  console.log(`\n🔧 Executing tool: ${name}`);
  console.log(`   Input: ${JSON.stringify(input, null, 2)}`);

  switch (name) {
    case 'create_task': return await createTask(input);
    case 'update_task': return await updateTask(input);
    case 'close_task': return await closeTask(input);
    case 'get_task': return await getTask(input);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function generateContent(contents, systemPrompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: geminiTools,
      }),
    },
  );

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result.error?.message || JSON.stringify(result);
    throw new Error(`Gemini API error ${response.status}: ${detail}`);
  }
  return result;
}

// ── Agentic loop ──────────────────────────────────────────────────────────────
async function runAgent() {
  console.log('═══════════════════════════════════════════');
  console.log('  🤖  ServiceNow Agent — Powered by Gemini ');
  console.log('═══════════════════════════════════════════');
  console.log(`\n📥 Command received: "${userCommand}"\n`);

  const contents = [{ role: 'user', parts: [{ text: userCommand }] }];

  const systemPrompt = `You are a ServiceNow agent. Your job is to help users manage ServiceNow tasks via simple natural language commands.

When a user gives you a command:
1. Understand their intent (create / update / close / get a task)
2. Call the appropriate tool with well-formed inputs
3. After the tool responds, summarize the result clearly

Rules:
- Infer priority from context (deployment, production, urgent = High or Critical; regular tasks = Moderate)
- Always write clear, professional short_description and description fields
- If a ticket number is mentioned, extract it exactly (format: SCTASK followed by digits)
- After completing the action, give a short friendly confirmation with the ticket number and link`;

  for (let turn = 0; turn < 10; turn += 1) {
    const result = await generateContent(contents, systemPrompt);
    const candidate = result.candidates?.[0];
    const modelContent = candidate?.content;
    if (!modelContent?.parts?.length) {
      throw new Error(`Gemini returned no response content (finish reason: ${candidate?.finishReason || 'unknown'})`);
    }
    contents.push(modelContent);

    const functionCalls = modelContent.parts
      .filter(part => part.functionCall)
      .map(part => part.functionCall);

    if (!functionCalls.length) {
      const finalText = modelContent.parts
        .map(part => part.text || '')
        .filter(Boolean)
        .join('\n');
      if (!finalText) {
        throw new Error(`Gemini returned neither text nor a function call (finish reason: ${candidate.finishReason || 'unknown'})`);
      }

      console.log('\n✅ Agent Response:');
      console.log('─────────────────────────────────────────');
      console.log(finalText);
      console.log('─────────────────────────────────────────');
      return;
    }

    const functionResponses = [];
    for (const call of functionCalls) {
      try {
        const toolResult = await executeTool(call.name, call.args || {});
        console.log(`   Result: ${JSON.stringify(toolResult, null, 2)}`);
        functionResponses.push({
          functionResponse: { name: call.name, response: { result: toolResult } },
        });
      } catch (err) {
        console.error(`   ❌ Tool error: ${err.message}`);
        functionResponses.push({
          functionResponse: { name: call.name, response: { error: err.message } },
        });
      }
    }

    contents.push({ role: 'user', parts: functionResponses });
  }

  throw new Error('Gemini exceeded the maximum of 10 tool-calling turns');
}

runAgent().catch(err => {
  console.error('❌ Agent failed:', err.message);
  process.exit(1);
});
