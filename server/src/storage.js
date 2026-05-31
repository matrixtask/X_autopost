import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';

const initialState = { posts: [], metrics: [] };

export async function readState() {
  try {
    const raw = await readFile(config.dataFile, 'utf8');
    return { ...initialState, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(initialState);
    throw error;
  }
}

export async function writeState(state) {
  await mkdir(dirname(config.dataFile), { recursive: true });
  await writeFile(config.dataFile, `${JSON.stringify(state, null, 2)}\n`);
}

export async function listPosts(filter = {}) {
  const state = await readState();
  return state.posts
    .filter((post) => !filter.status || post.status === filter.status)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
}

export async function upsertPosts(posts) {
  const state = await readState();
  const byId = new Map(state.posts.map((post) => [post.id, post]));
  for (const post of posts) {
    byId.set(post.id, { ...byId.get(post.id), ...post, updatedAt: new Date().toISOString() });
  }
  state.posts = [...byId.values()].sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  await writeState(state);
  return posts;
}

export async function updatePost(id, patch, event = {}) {
  const state = await readState();
  const index = state.posts.findIndex((post) => post.id === id);
  if (index === -1) return null;
  const before = state.posts[index];
  const updatedAt = new Date().toISOString();
  state.posts[index] = { ...before, ...patch, updatedAt };
  if (event.type || before.status !== state.posts[index].status) {
    state.metrics.push({
      id: `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: updatedAt,
      type: event.type || 'status_changed',
      postId: id,
      from: before.status,
      to: state.posts[index].status,
      ...event
    });
  }
  await writeState(state);
  return state.posts[index];
}

export async function listMetrics() {
  const state = await readState();
  return state.metrics.sort((a, b) => new Date(b.at) - new Date(a.at));
}

export async function dueApprovedPosts(now = new Date()) {
  const state = await readState();
  return state.posts
    .filter((post) => post.status === 'approved' && new Date(post.scheduledAt) <= now)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
}
