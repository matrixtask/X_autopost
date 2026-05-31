import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';
import { config, requireAdminToken } from './config.js';
import { buildAnalytics } from './analytics.js';
import { generateWithOpenAI, nextWeekStart } from './post-generator.js';
import { listMetrics, listPosts, readState, updatePost, upsertPosts } from './storage.js';
import { publishDuePosts } from './tick-core.js';

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const publicDir = new URL('../public/', import.meta.url).pathname;
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function send(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS'
  });
  response.end(JSON.stringify(body));
}

async function sendStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const normalized = normalize(decodeURIComponent(requested)).replace(/^\.\.(\/|$)/, '');
  const filePath = join(publicDir, normalized);
  if (!filePath.startsWith(publicDir)) return false;
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream' });
    response.end(body);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
}

function assertAuthorized(request) {
  requireAdminToken();
  const expected = `Bearer ${config.adminToken}`;
  if (request.headers.authorization !== expected) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, config.baseUrl);
    if (request.method === 'OPTIONS') return send(response, 204, {});
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, 200, { ok: true, dryRun: config.dryRun, timezone: config.timezone });
    }
    if (request.method === 'GET' && url.pathname === '/api/posts') {
      assertAuthorized(request);
      return send(response, 200, { posts: await listPosts({ status: url.searchParams.get('status') }) });
    }
    if (request.method === 'GET' && url.pathname === '/api/analytics') {
      assertAuthorized(request);
      const state = await readState();
      return send(response, 200, buildAnalytics(state.posts, state.metrics));
    }
    if (request.method === 'GET' && url.pathname === '/api/metrics') {
      assertAuthorized(request);
      return send(response, 200, { metrics: await listMetrics() });
    }
    if (request.method === 'POST' && url.pathname === '/api/posts/generate-week') {
      assertAuthorized(request);
      const body = await readJson(request);
      const startDate = body.startDate ? new Date(body.startDate) : nextWeekStart();
      const posts = await generateWithOpenAI({ startDate, days: body.days || 7 });
      await upsertPosts(posts);
      return send(response, 201, { posts });
    }
    const postMatch = url.pathname.match(/^\/api\/posts\/([^/]+)(?:\/(approve|reject))?$/);
    if (postMatch && ['PATCH', 'POST'].includes(request.method)) {
      assertAuthorized(request);
      const [, rawId, action] = postMatch;
      const id = decodeURIComponent(rawId);
      const body = await readJson(request);
      const patch = action === 'approve' ? { status: 'approved' } : action === 'reject' ? { status: 'rejected' } : body;
      const eventType = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'edited';
      const post = await updatePost(id, patch, { type: eventType });
      return post ? send(response, 200, { post }) : send(response, 404, { error: 'Post not found' });
    }
    if (request.method === 'POST' && url.pathname === '/api/tick') {
      assertAuthorized(request);
      return send(response, 200, { results: await publishDuePosts() });
    }
    if (request.method === 'GET' && await sendStatic(response, url.pathname)) return;
    return send(response, 404, { error: 'Not found' });
  } catch (error) {
    return send(response, error.status || 500, { error: error.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`X autopost server listening on http://${config.host}:${config.port}`);
});
