import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalytics } from '../server/src/analytics.js';

test('analytics summarizes statuses, rates, charts and events', () => {
  const analytics = buildAnalytics(
    [
      { id: 'a', status: 'draft', scheduledAt: '2026-06-01T00:00:00.000Z', pillar: '事業開発', source: 'openai' },
      { id: 'b', status: 'approved', scheduledAt: '2026-06-02T00:00:00.000Z', pillar: '事業開発', source: 'openai' },
      { id: 'c', status: 'posted', scheduledAt: '2026-06-01T00:00:00.000Z', postedAt: '2026-06-01T00:01:00.000Z', pillar: '進捗', source: 'fallback' },
      { id: 'd', status: 'failed', scheduledAt: '2026-06-03T00:00:00.000Z', pillar: '進捗', source: 'fallback' },
      { id: 'e', status: 'rejected', scheduledAt: '2026-06-04T00:00:00.000Z', pillar: '進捗', source: 'openai' }
    ],
    [{ at: '2026-06-01T00:02:00.000Z', type: 'published', postId: 'c', from: 'approved', to: 'posted' }],
    new Date('2026-05-31T00:00:00.000Z')
  );

  assert.equal(analytics.summary.total, 5);
  assert.equal(analytics.summary.approvalRate, 50);
  assert.equal(analytics.summary.publishSuccessRate, 50);
  assert.deepEqual(analytics.charts.byPillar[0], { label: '進捗', value: 3 });
  assert.equal(analytics.recentEvents[0].type, 'published');
  assert.equal(analytics.upcoming.length, 2);
});
