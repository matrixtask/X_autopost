import { publishDuePosts } from './tick-core.js';

const results = await publishDuePosts();
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
