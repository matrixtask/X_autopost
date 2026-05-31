import { generateWithOpenAI, nextWeekStart } from './post-generator.js';
import { upsertPosts } from './storage.js';

const startDate = process.argv[2] ? new Date(process.argv[2]) : nextWeekStart();
const posts = await generateWithOpenAI({ startDate });
await upsertPosts(posts);
console.log(JSON.stringify({ generated: posts.length, startDate: startDate.toISOString() }, null, 2));
