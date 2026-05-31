import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackPosts, nextWeekStart } from '../server/src/post-generator.js';

test('nextWeekStart returns a Monday at midnight', () => {
  const start = nextWeekStart(new Date('2026-05-31T10:00:00Z'));
  assert.equal(start.toISOString(), '2026-05-31T15:00:00.000Z');
  assert.equal(start.getMinutes(), 0);
});

test('fallback generator creates 7 days x 3 drafts with safe X length', () => {
  const posts = buildFallbackPosts({ startDate: new Date('2026-06-01T00:00:00Z') });
  assert.equal(posts.length, 21);
  assert.ok(posts.every((post) => post.status === 'draft'));
  assert.ok(posts.every((post) => post.content.length <= 260));
  assert.deepEqual(posts.slice(0, 3).map((post) => post.scheduledAt), [
    '2026-05-31T22:00:00.000Z',
    '2026-06-01T03:00:00.000Z',
    '2026-06-01T10:00:00.000Z'
  ]);
});
