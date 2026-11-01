import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function setup() {
  const rows = [{ id: 'p1', text: '本人の原文', status: 'failed', score: '', scheduled_at: '2026-11-01 10:00', tweet_id: '' }];
  const logs = [], archives = [], reviews = [], sent = [];
  const ctx = vm.createContext({
    SHEET: { STOCK: 'Stock', LOG: 'Log' }, OUTCOME_SCORE_VERSION: 'outcome-v1',
    STATUS: Object.fromEntries(['posted', 'failed', 'draft', 'ready', 'stock', 'approved', 'scheduled', 'rejected'].map(s => [s.toUpperCase(), s])),
    readTable: name => name === 'Log' ? logs : rows.map(r => ({ ...r })),
    updateStockById: (id, values) => Object.assign(rows.find(r => r.id === id), values),
    logEvent: (event, detail) => logs.push({ event, detail, timestamp: '2026-11-01 10:00' }),
    tryArchiveEditorialRows: selected => archives.push(selected[0].text), archiveWebStock: () => archives.push(rows[0].text),
    stockPublishingProblem: () => '', outcomeReviewFeedback: () => '', syncStockRowToNotion() {},
    useOutcomeQuality: () => true, enqueueOutcomeReview_: id => reviews.push(id),
    isDryRun: () => false, nowJst: () => new Date(), fmtDateTime: () => '2026-11-01 11:00',
    notifySlack() {},
  });
  for (const name of ['Pure', 'WebApp', 'XApi']) vm.runInContext(fs.readFileSync(new URL('../gas/src/' + name + '.js', import.meta.url), 'utf8'), ctx);
  ctx.assertAccess = token => { if (token !== 'valid') throw new Error('Unauthorized'); };
  ctx.postTweet = text => { sent.push(text); return { id: '1234567890' }; };
  return { ctx, rows, logs, archives, reviews, sent };
}

test('failure details use only the latest matching post log and explain unknown/limit/auth/content/duplicate cases', () => {
  const h = setup();
  h.logs.push({ event: 'post_failed', detail: 'p1: X API error 401: unauthorized', timestamp: 'old' },
    { event: 'post_failed', detail: 'p1: X API error 429: TooManyRequests', timestamp: 'new' },
    { event: 'post_failed', detail: 'p10: unrelated', timestamp: 'newer' });
  const details = JSON.parse(h.ctx.api_postFailure('valid', 'p1'));
  assert.match(details.title, /一時的な利用制限/); assert.equal(details.failed_at, 'new');
  assert.equal(h.rows[0].status, 'failed'); assert.deepEqual(h.sent, []);
  for (const [error, expected] of [['', /記録を取得できません/], ['X API error 403', /設定確認/],
    ['X API error 402: credits', /利用枠/], ['duplicate', /同じ内容/], ['X API error 400', /投稿内容/], ['timeout', /公開状況/]]) {
    assert.match(h.ctx.failedPostGuidance_(h.rows[0], error).title, expected);
  }
  h.ctx.readTable = name => { if (name === 'Log') throw new Error('unavailable'); return h.rows; };
  assert.match(JSON.parse(h.ctx.api_postFailure('valid', 'p1')).title, /記録を取得できません/);
  assert.throws(() => h.ctx.api_postFailure('invalid', 'p1'), /Unauthorized/);
});

test('recovering a failed post requires confirmation and returns only to human approval, never posts or schedules', () => {
  const h = setup();
  assert.throws(() => h.ctx.api_resolveFailedPost('invalid', 'p1', 'ready', true), /Unauthorized/);
  assert.throws(() => h.ctx.api_resolveFailedPost('valid', 'p1', 'ready', false), /未投稿/);
  assert.throws(() => h.ctx.api_setStatus('valid', 'p1', 'approved'), /公開状況/);
  h.ctx.stockPublishingProblem = () => '長文投稿が無効';
  assert.throws(() => h.ctx.api_resolveFailedPost('valid', 'p1', 'ready', true), /長文投稿/);
  h.ctx.stockPublishingProblem = () => '';
  const result = JSON.parse(h.ctx.api_resolveFailedPost('valid', 'p1', 'ready', true));
  assert.equal(result.post.status, 'ready'); assert.equal(h.rows[0].scheduled_at, '');
  assert.equal(h.rows[0].text, '本人の原文'); assert.deepEqual(h.sent, []);
  assert.deepEqual(h.archives, ['本人の原文', '本人の原文']);
  assert.throws(() => h.ctx.api_resolveFailedPost('valid', 'p1', 'ready', true), /状態が変わりました/);
});

test('known tweet IDs can be restored without reposting; reject/restore cannot bypass duplicate guard', () => {
  const h = setup(); Object.assign(h.rows[0], { tweet_id: '1234567890', posted_at: '2026-11-01 10:00' });
  assert.match(JSON.parse(h.ctx.api_postFailure('valid', 'p1')).tweet_url, /1234567890$/);
  assert.throws(() => h.ctx.api_resolveFailedPost('valid', 'p1', 'ready', true), /投稿ID/);
  assert.throws(() => h.ctx.api_updateText('valid', 'p1', '変更', '', { confirmedNotPublished: true }), /投稿ID/);
  const result = JSON.parse(h.ctx.api_resolveFailedPost('valid', 'p1', 'posted'));
  assert.equal(result.post.status, 'posted'); assert.equal(result.post.posted_at, '2026-11-01 10:00');
  assert.deepEqual(h.sent, []);
  h.rows[0].status = 'failed'; h.ctx.api_resolveFailedPost('valid', 'p1', 'rejected');
  assert.throws(() => h.ctx.api_setStatus('valid', 'p1', 'stock'), /投稿ID/);
});

test('failed edits without composition metadata still reset scores and queue review; skip retains source', () => {
  const h = setup(); h.rows[0].score = 75;
  assert.throws(() => h.ctx.api_updateText('valid', 'p1', '編集'), /未投稿/);
  assert.throws(() => h.ctx.api_resolveFailedPost('valid', 'p1', 'posted'), /投稿ID/);
  h.ctx.api_updateText('valid', 'p1', '編集', '', { confirmedNotPublished: true });
  assert.equal(h.rows[0].status, 'draft'); assert.equal(h.rows[0].score, '');
  assert.deepEqual(h.reviews, ['p1']); assert.equal(h.archives[0], '本人の原文');
  h.rows[0].status = 'failed'; h.ctx.api_resolveFailedPost('valid', 'p1', 'rejected');
  assert.equal(h.rows[0].text, '編集'); assert.equal(h.rows[0].status, 'rejected');
  assert.deepEqual(h.sent, []);
});

test('Slack failure after successful posting keeps posted status and does not prevent subsequent posts', () => {
  const h = setup(); h.rows[0].status = 'scheduled';
  h.rows.push({ ...h.rows[0], id: 'p2' });
  h.ctx.notifySlack = () => { throw new Error('Slack offline'); };
  h.ctx.postTick();
  assert.equal(h.sent.length, 2); assert.ok(h.rows.every(r => r.status === 'posted'));
  assert.equal(h.logs.filter(l => l.event === 'post_failed').length, 0);
  assert.equal(h.logs.filter(l => l.event === 'post_notification_failed').length, 2);
  h.ctx.postTick(); assert.equal(h.sent.length, 2);
});

test('X rejection or uncertain response stays failed even if notification also fails; returned IDs survive local write failure', () => {
  for (const outcome of ['reject', 'missing-id', 'write-failure']) {
    const h = setup(); h.rows[0].status = 'scheduled';
    h.ctx.notifySlack = () => { throw new Error('offline'); };
    if (outcome === 'reject') h.ctx.postTweet = () => { throw new Error('X API error 429'); };
    if (outcome === 'missing-id') h.ctx.postTweet = () => ({});
    if (outcome === 'write-failure') {
      const update = h.ctx.updateStockById; let once = true;
      h.ctx.updateStockById = (id, values) => { if (once) { once = false; throw new Error('temporary sheet failure'); } update(id, values); };
    }
    h.ctx.postTick(); assert.equal(h.rows[0].status, 'failed');
    assert.equal(h.logs.filter(l => l.event === 'post_failed').length, 1);
    assert.equal(h.rows[0].tweet_id, outcome === 'write-failure' ? '1234567890' : '');
  }
});
