import { listJiraStories } from './jira.js';
import { embedTexts } from '../vectorDB/knowledge-base.js';

export const DUPLICATE_THRESHOLD = 0.70;
// Include this process's new Stories while Jira's search index catches up.
const recentStories = new Map();
const GENERIC_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in', 'is', 'it',
  'of', 'on', 'or', 'the', 'this', 'to', 'was', 'with', 'after', 'before', 'cannot',
  'incident', 'issue', 'problem', 'ticket', 'servicenow', 'jira', 'infra', 'service',
  'services', 'assigned', 'assignment', 'notification', 'priority', 'status',
  'review', 'investigate', 'reported', 'details', 'action', 'required', 'update',
  'updates', 'notes', 'resolution', 'source', 'number', 'email', 'user', 'users',
  'technical', 'fault', 'description', 'information', 'available', 'knowledge',
  'base', 'article', 'articles', 'confirmed', 'matching', 'directly', 'necessary',
  'management',
]);

export function rememberCreatedStory(story) {
  if (story.issueType === 'Story') recentStories.set(story.key, story);
}

export function normalizeIncidentText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => !(
      /\bincident\s+INC\d+\s+(?:has\s+been\s+)?assigned\s+to\s+Infra\s+Services\b/i.test(line)
      || /^\s*(?:[-*]\s*)?(?:incident notification details|requested actions)\s*:?\s*$/i.test(line)
      || /^\s*(?:[-*]\s*)?(?:incident number|assignment group|priority|status|notification source|source (?:ServiceNow ticket|ticket number from email))\s*:/i.test(line)
      || /^\s*(?:[-*]\s*)?(?:review the incident details|investigate the reported issue|provide required updates)/i.test(line)
      || /^\s*(?:[-*]\s*)?note:\s*the notification email did not include/i.test(line)
      || /\b(?:no|without)\s+(?:specific\s+)?(?:technical\s+|fault\s+)?(?:details|description|information)\b/i.test(line)
    ))
    .join('\n')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b(?:INC|SCTASK|KB)\d+\b/gi, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function sourceNumber(story) {
  const explicit = story.description?.match(/^\s*(?:[-*]\s*)?(?:source (?:ServiceNow ticket|ticket number from email)|incident number)\s*:\s*((?:INC|SCTASK)\d+)\b/im);
  const summary = story.summary?.match(/\b(?:incident\s+(INC\d+)|task\s+(SCTASK\d+))\b/i);
  return (explicit?.[1] || summary?.[1] || summary?.[2] || '').toUpperCase();
}

function issueTerms(text) {
  return new Set((text.match(/[a-z][a-z0-9]+/g) || [])
    .filter(word => word.length > 2 && !GENERIC_WORDS.has(word))
    .map(word => word.length > 4 ? word.replace(/s$/, '') : word));
}

function comparableDetails(left, right) {
  const a = issueTerms(left);
  const b = issueTerms(right);
  if (a.size < 2 || b.size < 2) return false;
  const shared = [...a].filter(term => b.has(term)).length;
  return shared > 0 && shared / Math.min(a.size, b.size) >= 0.2;
}

function unitVector(vector) {
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) {
    throw new Error('Invalid embedding in Jira duplicate check');
  }
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Empty embedding in Jira duplicate check');
  return vector.map(value => value / norm);
}

export function cosineSimilarity(left, right) {
  if (left.length !== right.length) throw new Error('Embedding dimensions differ in Jira duplicate check');
  const a = unitVector(left);
  const b = unitVector(right);
  return Math.max(-1, Math.min(1, a.reduce((sum, value, index) => sum + value * b[index], 0)));
}

async function documentVectors(texts, embed) {
  // Embed every part of long descriptions rather than silently truncating them.
  const chunks = [];
  texts.forEach((text, document) => {
    for (let offset = 0; offset < text.length; offset += 1800) {
      chunks.push({ document, text: text.slice(offset, offset + 1800) });
    }
  });
  const sums = new Array(texts.length);
  let dimensions;
  for (let offset = 0; offset < chunks.length; offset += 16) {
    const batch = chunks.slice(offset, offset + 16);
    const vectors = await embed(batch.map(chunk => chunk.text), { truncate: false });
    if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error('Incomplete embeddings in Jira duplicate check');
    vectors.forEach((vector, index) => {
      const normalized = unitVector(vector);
      dimensions ??= normalized.length;
      if (normalized.length !== dimensions) throw new Error('Embedding dimensions differ in Jira duplicate check');
      const { document, text } = batch[index];
      sums[document] ||= new Array(dimensions).fill(0);
      normalized.forEach((value, dimension) => { sums[document][dimension] += value * text.length; });
    });
  }
  return sums.map(unitVector);
}

export async function findDuplicateStory(emailContent, { serviceNowTicket, listStories = listJiraStories, embed = embedTexts } = {}) {
  const fetched = await listStories();
  const candidates = new Map(recentStories);
  fetched.forEach(story => { candidates.set(story.key, story); recentStories.delete(story.key); });
  if (!candidates.size) return null;
  const stories = [...candidates.values()];
  const incomingNumber = (serviceNowTicket?.number || emailContent.match(/\b(?:INC|SCTASK)\d+\b/i)?.[0] || '').toUpperCase();
  const sameIncident = incomingNumber && stories.find(story => sourceNumber(story) === incomingNumber);
  if (sameIncident) {
    console.log(`Existing Jira Story ${sameIncident.key} references the same source incident ${incomingNumber}.`);
    return { ...sameIncident, similarity: 1, matchReason: 'same incident number', outcome: 'duplicate' };
  }

  // A different INC number needs matching fault details, not another assignment notice.
  const ticketDetails = serviceNowTicket
    ? `${serviceNowTicket.short_description || ''}\n${serviceNowTicket.description || ''}` : '';
  const incoming = normalizeIncidentText(`${ticketDetails}\n${emailContent}`);
  // Titles often describe the assignment notification, not the fault. Require
  // evidence in the Story description itself for a different source incident.
  const described = stories.map(story => ({
    story, text: normalizeIncidentText(story.description),
  })).filter(candidate => {
    if (issueTerms(candidate.text).size >= 2) return true;
    console.log(`Excluded ${candidate.story.key} from similarity comparison: no specific problem details in its description.`);
    return false;
  });
  const usable = described.filter(candidate => comparableDetails(incoming, candidate.text));
  if (!usable.length) {
    console.log('No Jira Story has matching issue details; generic notifications are not duplicates.');
    return null;
  }
  const vectors = await documentVectors([incoming, ...usable.map(candidate => candidate.text)], embed);
  let best;
  usable.forEach(({ story }, index) => {
    const similarity = Math.max(0, cosineSimilarity(vectors[0], vectors[index + 1]));
    if (!best || similarity > best.similarity) best = { ...story, similarity };
  });
  console.log(`Compared issue details with ${usable.length} of ${stories.length} Jira Story descriptions. Closest: ${best.key}; description embedding similarity: ${(best.similarity * 100).toFixed(1)}%; threshold: 70% (not a percentage of matching facts).`);
  return best.similarity >= DUPLICATE_THRESHOLD ? { ...best, outcome: 'duplicate' } : null;
}
