import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withTempDataFile(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'x-autopost-'));
  process.env.DATA_FILE = join(dir, 'posts.json');
  const storage = await import(`../server/src/storage.js?case=${Date.now()}-${Math.random()}`);
  try {
    await fn(storage);
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.DATA_FILE;
  }
}

test('upsert, approve and due lookup lifecycle', async () => {
  await withTempDataFile(async ({ upsertPosts, updatePost, dueApprovedPosts, listMetrics }) => {
    await upsertPosts([{ id: 'p1', content: 'hello', scheduledAt: '2026-01-01T00:00:00.000Z', status: 'draft' }]);
    assert.deepEqual(await dueApprovedPosts(new Date('2026-01-02T00:00:00.000Z')), []);
    await updatePost('p1', { status: 'approved' }, { type: 'approved' });
    const due = await dueApprovedPosts(new Date('2026-01-02T00:00:00.000Z'));
    assert.equal(due.length, 1);
    assert.equal(due[0].id, 'p1');
    const metrics = await listMetrics();
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].type, 'approved');
  });
});
