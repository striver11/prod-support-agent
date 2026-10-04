import { pathToFileURL } from 'node:url';
import { indexServiceNowKnowledgeBase } from './knowledge-base.js';

async function main() {
  const count = await indexServiceNowKnowledgeBase();
  console.log(`Indexed ${count} published ServiceNow knowledge article(s) in Chroma.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Knowledge-base indexing failed: ${error.message}`);
    process.exitCode = 1;
  });
}
