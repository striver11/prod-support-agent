// servicenow.js — ServiceNow REST API client

const INSTANCE = process.env.SNOW_INSTANCE; // e.g. dev12345.service-now.com
const USERNAME = process.env.SNOW_USERNAME;
const PASSWORD = process.env.SNOW_PASSWORD;

const BASE_URL = `https://${INSTANCE}/api/now/table`;

function authHeader() {
  const encoded = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  return `Basic ${encoded}`;
}

async function snowFetch(path, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, options);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`ServiceNow API error ${res.status}: ${JSON.stringify(data)}`);
  }
  return data.result;
}

// Create a task in ServiceNow (sc_task table)
export async function createTask({ short_description, description, priority = '3' }) {
  const result = await snowFetch('/sc_task', 'POST', {
    short_description,
    description,
    priority, // 1=Critical, 2=High, 3=Moderate, 4=Low
    state: '1', // Open
  });

  return {
    sys_id: result.sys_id,
    number: result.number,
    short_description: result.short_description,
    state: result.state?.display_value || 'Open',
    priority: result.priority?.display_value || 'Moderate',
    link: `https://${INSTANCE}/nav_to.do?uri=sc_task.do?sys_id=${result.sys_id}`,
  };
}

// Update state/description of an existing task by ticket number
export async function updateTask({ number, state, short_description }) {
  // First find the task by number
  const search = await snowFetch(`/sc_task?number=${number}&sysparm_limit=1`);
  if (!search || search.length === 0) {
    throw new Error(`Task ${number} not found in ServiceNow`);
  }

  const sys_id = search[0].sys_id;
  const updateBody = {};

  // State mapping: 1=Open, 2=Work in Progress, 3=Closed Complete, 4=Closed Incomplete
  const stateMap = {
    'open': '1',
    'in progress': '2',
    'work in progress': '2',
    'closed': '3',
    'complete': '3',
    'done': '3',
    'incomplete': '4',
  };

  if (state) {
    const mappedState = stateMap[state.toLowerCase()] || state;
    updateBody.state = mappedState;
  }
  if (short_description) updateBody.short_description = short_description;

  const result = await snowFetch(`/sc_task/${sys_id}`, 'PATCH', updateBody);

  return {
    sys_id: result.sys_id,
    number: result.number,
    short_description: result.short_description,
    state: result.state?.display_value || state,
    link: `https://${INSTANCE}/nav_to.do?uri=sc_task.do?sys_id=${result.sys_id}`,
  };
}

// Close a task by ticket number
export async function closeTask({ number, resolution_notes }) {
  return updateTask({
    number,
    state: 'closed',
    short_description: resolution_notes,
  });
}

// Get task details by number
export async function getTask({ number }) {
  const search = await snowFetch(`/sc_task?number=${number}&sysparm_limit=1`);
  if (!search || search.length === 0) {
    throw new Error(`Task ${number} not found`);
  }

  const t = search[0];
  return {
    sys_id: t.sys_id,
    number: t.number,
    short_description: t.short_description,
    description: t.description,
    state: t.state?.display_value,
    priority: t.priority?.display_value,
    link: `https://${INSTANCE}/nav_to.do?uri=sc_task.do?sys_id=${t.sys_id}`,
  };
}

async function getPublishedKnowledgeArticlesFromTable(table, fields) {
  const pageSize = 100;
  const articles = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      sysparm_query: 'active=true^workflow_state=published^ORDERBYnumber',
      sysparm_fields: fields,
      sysparm_limit: String(pageSize),
      sysparm_offset: String(offset),
      sysparm_display_value: 'false',
    });
    const page = await snowFetch(`/${table}?${params}`);
    articles.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
  }

  return articles;
}

export async function getPublishedKnowledgeArticles() {
  const baseFields = 'sys_id,number,short_description,text,sys_updated_on';
  const knownErrorFields = `${baseFields},kb_description,kb_workaround`;
  const baseArticles = await getPublishedKnowledgeArticlesFromTable('kb_knowledge', baseFields);
  const knownErrorArticles = await getPublishedKnowledgeArticlesFromTable(
    'kb_template_known_error_article',
    knownErrorFields,
  );
  const articlesById = new Map(baseArticles.map(article => [article.sys_id, article]));

  for (const article of knownErrorArticles) {
    articlesById.set(article.sys_id, { ...articlesById.get(article.sys_id), ...article });
  }

  return [...articlesById.values()].sort((a, b) => a.number.localeCompare(b.number));
}
