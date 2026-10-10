import { ChromaClient } from 'chromadb';
import { getPublishedKnowledgeArticles } from '../servicenow-agent/servicenow.js';

const chromaUrl = process.env.CHROMA_URL || 'http://127.0.0.1:8000';
const collectionName = process.env.CHROMA_COLLECTION || 'servicenow_knowledge';
const ollamaUrl = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const embeddingModel = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const pageSize = 100;

function getCollection() {
  const endpoint = new URL(chromaUrl);
  const client = new ChromaClient({
    host: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    ssl: endpoint.protocol === 'https:',
  });
  return client.getOrCreateCollection({
    name: collectionName,
    metadata: { 'hnsw:space': 'cosine' },
    embeddingFunction: null,
  });
}

export async function embedTexts(texts, { truncate = true } = {}) {
  const response = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: embeddingModel, input: texts, truncate }),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Ollama embedding error ${response.status}: ${result.error || JSON.stringify(result)}`);
  }
  if (!Array.isArray(result.embeddings) || result.embeddings.length !== texts.length) {
    throw new Error('Ollama returned an invalid embedding response');
  }
  return result.embeddings;
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildArticleContent(article) {
  return [article.text, article.kb_description, article.kb_workaround]
    .map(stripHtml)
    .filter(Boolean)
    .join('\n\n');
}

export async function indexServiceNowKnowledgeBase() {
  const collection = await getCollection();
  let indexed = 0;
  const publishedIds = new Set();

  const articles = await getPublishedKnowledgeArticles();
  for (let offset = 0; offset < articles.length; offset += pageSize) {
    const usableArticles = articles.slice(offset, offset + pageSize)
      .map(article => ({ ...article, content: buildArticleContent(article) }))
      .filter(article =>
        article.sys_id && article.short_description?.trim() && article.content,
      );
    usableArticles.forEach(article => publishedIds.add(article.sys_id));
    if (usableArticles.length) {
      const documents = usableArticles.map(article =>
        `${article.short_description}\n\n${article.content.slice(0, 2000)}`,
      );
      const embeddings = await embedTexts(documents);
      await collection.upsert({
        ids: usableArticles.map(article => article.sys_id),
        documents,
        embeddings,
        metadatas: usableArticles.map(article => ({
          number: article.number || '',
          title: article.short_description,
          updatedAt: article.sys_updated_on || '',
        })),
      });
      indexed += usableArticles.length;
    }
  }

  const existingCount = await collection.count();
  if (existingCount) {
    const existing = await collection.get({ include: ['metadatas'], limit: existingCount });
    const staleIds = (existing.ids || []).filter(id => !publishedIds.has(id));
    if (staleIds.length) await collection.delete({ ids: staleIds });
  }

  return indexed;
}

export async function searchKnowledgeBase(query, { limit = 5 } = {}) {
  const collection = await getCollection();
  const count = await collection.count();
  if (!count) {
    throw new Error('The ServiceNow knowledge base index is empty. Run the vectorDB index command first.');
  }

  const [queryEmbedding] = await embedTexts([query]);
  const result = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: Math.min(limit, count),
    include: ['documents', 'metadatas', 'distances'],
  });

  return (result.documents?.[0] || []).map((document, index) => ({
    document,
    metadata: result.metadatas?.[0]?.[index] || {},
    distance: result.distances?.[0]?.[index],
  }));
}
