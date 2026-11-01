import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  // UTCでは10月31日、日本時間では11月1日。30日の開始は10月3日。
  class Clock extends Date { static now() { return Date.parse('2026-10-31T15:30:00Z'); } }
  const rows = [], learned = [];
  const ctx = vm.createContext({ Date: Clock, SHEET: { STOCK: 'Stock', FOLLOWERS: 'Followers' },
    STATUS: { POSTED: 'posted' }, OUTCOME_SCORE_VERSION: 'outcome-v1',
    readTable: sheet => sheet === 'Stock' ? rows : [{ date: '2026-11-01', followers: 300, delta: '' }],
    pearson: () => null, analyzeAxes: mode => { learned.push(mode); return { outcomeName: 'reach', ranked: [] }; },
  });
  vm.runInContext(fs.readFileSync(new URL('../gas/src/WebApp.js', import.meta.url), 'utf8'), ctx);
  ctx.assertAccess = token => { if (token !== 'valid') throw new Error('Unauthorized'); };
  function add(text, posted_at, impressions, extra = {}) {
    rows.push({ text, posted_at, impressions, status: 'posted', metrics_at: '2026-11-01 00:30',
      score: '', profile_clicks: '', paid_impressions: '', category: 'manual', ...extra });
  }
  return { ctx, rows, learned, add, analytics: period => JSON.parse(ctx.api_analytics('valid', period)) };
}

test('analytics ranges use JST posting dates, include lower boundary and reject future/missing/invalid dates', () => {
  const h = fixture();
  h.add('30日境界', '2026-10-03 00:00', 10);
  h.add('30日外', '2026-10-02 23:59:59', 100);
  h.add('90日境界', '2026-08-04 00:00:00', 200);
  h.add('90日外', '2026-08-03 23:59', 1000);
  h.add('現在', '2026-11-01 00:30', 20);
  h.add('未来', '2026-11-01 00:31', 9999);
  h.add('日付なし', '', 9999);
  h.add('不正日付', '2026-10-32 00:00', 9999);
  h.add('広告分離不可', '2026-10-10 12:00', 9999, { promoted: 'yes' });
  h.add('未計測', '2026-10-10 12:00', 9999, { metrics_at: '' });
  h.add('未投稿', '2026-10-10 12:00', 9999, { status: 'scheduled' });
  const month = h.analytics('30');
  assert.deepEqual(month.period, { key: '30', label: '直近1か月（30日）', from: '2026-10-03', through: '2026-11-01' });
  assert.deepEqual(month.top10.map(p => p.text), ['現在', '30日境界']);
  assert.deepEqual(month.total, { n: 2, imp: 30, likes: 0 });
  assert.equal(month.byCat[0].impAvg, 15); assert.equal(month.table.length, 2);
  assert.equal(month.follow.current, 300); assert.equal(month.axes, null); assert.deepEqual(h.learned, []);
  const quarter = h.analytics('90');
  assert.equal(quarter.period.from, '2026-08-04'); assert.equal(quarter.total.n, 4);
  assert.deepEqual(quarter.top10.map(p => p.text), ['90日境界', '30日外', '現在', '30日境界']);
  assert.equal(quarter.bySlot.reduce((sum, x) => sum + x.n, 0), 4); // Seconds timestamps also aggregate.
  assert.equal(month.byDay.find(x => x.key === '日').n, 1); // Nov 1 in JST, even on a UTC host.
  assert.deepEqual(h.analytics(), h.analytics('all')); // Existing callers still see all-time data.
  assert.throws(() => h.analytics('7'), /期間が不正/);
  assert.throws(() => h.ctx.api_analytics('invalid', '30'), /Unauthorized/);
  assert.equal(h.ctx.analyticsPostedAt_('2026-02-30 12:00'), null);
});

test('ranking keeps existing click criterion inside each period and returns an explicit empty period', () => {
  const h = fixture();
  h.add('古いクリック最多', '2026-01-01 00:00', 500, { profile_clicks: 100 });
  h.add('最近のクリック最多', '2026-10-31 12:00', 50, { profile_clicks: 3 });
  h.add('最近のインプ最多', '2026-10-30 12:00', 100, { profile_clicks: 1 });
  assert.equal(h.analytics('30').top10[0].text, '最近のクリック最多');
  assert.equal(h.analytics('all').top10[0].text, '古いクリック最多');
  h.rows.splice(1);
  const empty = h.analytics('30');
  assert.equal(empty.total.n, 0); assert.deepEqual(empty.top10, []); assert.deepEqual(empty.bySlot, []);
});
