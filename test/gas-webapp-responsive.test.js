import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = name => fs.readFileSync(new URL('../gas/src/' + name, import.meta.url), 'utf8');

function server() {
  const row = { id: 'a', text: '元の本文', status: 'scheduled', edit_meta: '{}', score: 85,
    score_version: 'outcome-v1', scheduled_at: '2026-11-02 09:00', outcome_text: '元の本文' };
  const queued = [], archived = [];
  const ctx = vm.createContext({
    SHEET: { STOCK: 'Stock' }, STATUS: Object.fromEntries(['draft', 'ready', 'stock', 'approved', 'scheduled', 'failed', 'rejected'].map(s => [s.toUpperCase(), s])),
    OUTCOME_SCORE_VERSION: 'outcome-v1', readTable: () => [{ ...row }],
    updateStockById: (id, values) => { assert.equal(id, row.id); Object.assign(row, values); },
    tryArchiveEditorialRows: rows => archived.push(rows[0].text), archiveWebStock: () => archived.push(row.text),
    useOutcomeQuality: () => true, enqueueOutcomeReview_: id => queued.push(id),
    runQualityGate: () => { assert.fail('No model work in the save request'); },
    logEvent: () => {}, syncStockRowToNotion: () => {}, stockPublishingProblem: () => '', outcomeReviewFeedback: () => '',
  });
  vm.runInContext(source('Pure.js') + source('WebApp.js'), ctx);
  ctx.assertAccess = token => { if (token !== 'valid') throw new Error('Unauthorized'); };
  return { ctx, row, queued, archived };
}

test('web save returns only saved row, resets approval, archives originals and queues one review without AI', () => {
  const h = server();
  const result = JSON.parse(h.ctx.api_updateText('valid', 'a', '新しい本文', '編集理由', { includePost: true }));
  assert.equal(result.post.text, '新しい本文'); assert.equal(result.post.status, 'draft');
  assert.equal(result.post.score, null); assert.equal(result.post.scheduled_at, '');
  assert.equal(h.row.outcome_text, ''); assert.deepEqual(h.queued, ['a']);
  assert.deepEqual(h.archived, ['元の本文', '新しい本文']); assert.match(result.message, /バックグラウンド/);
  const status = JSON.parse(h.ctx.api_setStatus('valid', 'a', 'rejected', '', { includePost: true }));
  assert.equal(status.post.status, 'rejected');
  assert.equal(h.ctx.api_setStatus('valid', 'a', 'stock'), 'ok');
  assert.ok(Array.isArray(JSON.parse(h.ctx.api_listPosts('valid'))));
});

test('web save queue failure preserves saved text and explains fallback; old callers retain string response', () => {
  const h = server(); h.ctx.enqueueOutcomeReview_ = () => { throw new Error('quota'); };
  const result = h.ctx.api_updateText('valid', 'a', '保存済み本文');
  assert.match(result, /保存しました.*次回ゲート/); assert.equal(h.row.text, '保存済み本文');
  assert.equal(h.row.status, 'draft');
  assert.throws(() => h.ctx.api_updateText('invalid', 'a', 'no'), /Unauthorized/);
  assert.throws(() => h.ctx.api_setStatus('invalid', 'a', 'approved'), /Unauthorized/);
  assert.equal(h.row.text, '保存済み本文');
});

test('legacy uncomposed posts retain legacy quality mode with deferred review', () => {
  const h = server(); h.row.edit_meta = ''; h.row.status = 'stock'; h.ctx.useOutcomeQuality = () => false;
  assert.match(h.ctx.api_updateText('valid', 'a', '旧方式の本文'), /旧方式/);
  assert.equal(h.row.status, 'draft'); assert.deepEqual(h.queued, []);
});

function client() {
  const elements = new Map(), calls = [], listeners = {};
  function element(id) {
    if (!elements.has(id)) elements.set(id, { id, innerHTML: '', textContent: '', style: {},
      classList: { add() {}, remove() {} }, setAttribute() {}, focus() {}, value: '' });
    return elements.get(id);
  }
  const makeCall = (ok, fail) => new Proxy({}, { get(target, name) {
    if (name === 'withSuccessHandler') return callback => makeCall(callback, fail);
    if (name === 'withFailureHandler') return callback => makeCall(ok, callback);
    return (...args) => calls.push({ name, args, ok, fail });
  } });
  const ctx = vm.createContext({ document: { getElementById: element, querySelectorAll: () => [] },
    window: { addEventListener: (key, fn) => { listeners[key] = fn; }, scrollTo() {} },
    google: { script: { run: makeCall() } }, setTimeout: () => 1, clearTimeout() {}, confirm: () => true,
  });
  vm.runInContext(source('Index.html').match(/<script>([\s\S]*?)<\/script>/)[1], ctx);
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: 'p' + i, text: '取材からの本文 ' + i,
    theme: i === 999 ? '探しているテーマ' : '設計', created_at: '2026-11-01', status: 'ready', score: null }));
  calls[0].ok(JSON.stringify(rows));
  return { ctx, calls, element, rows, listeners };
}

test('UI bounds rendering to 30 of 1000 posts, creates editors on demand and searches beyond first page', () => {
  const h = client();
  assert.equal((h.element('list').innerHTML.match(/class="card"/g) || []).length, 30);
  assert.equal(h.element('list').innerHTML.includes('<textarea'), false);
  h.ctx.searchPosts('探しているテーマ'); assert.match(h.element('list').innerHTML, /card-p999/);
  assert.equal(h.calls.length, 1); // Search and pagination require no server request.
  h.ctx.searchPosts(''); h.ctx.changePage(1); assert.match(h.element('list').innerHTML, /card-p30/);
  h.ctx.toggleEdit('p30'); h.ctx.rememberDraft('p30', 'まだ保存していない文章');
  h.ctx.setTab('draft'); h.ctx.setTab('ready'); h.ctx.changePage(1);
  assert.match(h.element('list').innerHTML, /まだ保存していない文章/);
  let prevented = false; h.listeners.beforeunload({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test('UI ignores late analytics on other tabs and deduplicates analytics requests', () => {
  const h = client(); h.ctx.setTab('analytics'); h.ctx.setTab('ready'); h.ctx.setTab('analytics');
  assert.equal(h.calls.filter(c => c.name === 'api_analytics').length, 1);
  h.ctx.setTab('ready'); const html = h.element('list').innerHTML;
  h.calls[1].ok('{}'); assert.equal(h.element('list').innerHTML, html);
  const f = client(); f.ctx.setTab('analytics'); f.ctx.setTab('ready');
  const old = f.element('list').innerHTML; f.calls[1].fail(new Error('offline'));
  assert.equal(f.element('list').innerHTML, old);
});

test('UI save is single-flight, retains unsaved text on failure and patches row without list reload', () => {
  const h = client(); h.ctx.toggleEdit('p0'); h.element('ta-p0').value = '変更後の本文';
  h.ctx.saveText('p0'); h.ctx.saveText('p0'); h.ctx.load(); h.ctx.approveAll();
  assert.equal(h.calls.length, 2); assert.equal(h.ctx.busy, true);
  h.calls[1].fail(new Error('offline'));
  assert.equal(h.ctx.editors.p0.text, '変更後の本文'); assert.equal(h.ctx.busy, false);
  assert.match(h.element('activity').textContent, /入力内容は画面に残して/);
  h.ctx.setStatus('p0', 'approved'); assert.equal(h.calls.length, 2); // Unsaved text cannot be approved.
  h.ctx.saveText('p0'); h.ctx.setTab('draft');
  h.calls[2].ok(JSON.stringify({ message: '保存済み・再審査待ち', post: { ...h.rows[0], text: '変更後の本文', status: 'draft' } }));
  assert.equal(h.calls.length, 3); assert.equal(h.ctx.posts[0].text, '変更後の本文');
  assert.equal(h.ctx.editors.p0, undefined); assert.match(h.element('list').innerHTML, /変更後の本文/);
  assert.equal(h.ctx.busy, false);
});

test('UI reload is single-flight and keeps a pending editor through server refresh', () => {
  const h = client(); h.ctx.toggleEdit('p0'); h.ctx.rememberDraft('p0', '未保存');
  h.ctx.load(); h.ctx.load(); assert.equal(h.calls.length, 2);
  h.calls[1].ok(JSON.stringify(h.rows)); assert.match(h.element('list').innerHTML, /未保存/);
  h.ctx.load(); h.calls[2].fail(new Error('offline'));
  assert.equal(h.ctx.loading, false); assert.match(h.element('activity').textContent, /再試行/);
});

function emptyAnalytics(key) {
  return JSON.stringify({ period: { key, label: key + '日', from: '2026-10-03', through: '2026-11-01' }, total: { n: 0 } });
}

test('failed cards reveal recovery actions and require confirmation without issuing a publish request', () => {
  const h = client(); h.ctx.posts[0].status = 'failed'; h.ctx.setTab('failed');
  assert.match(h.element('list').innerHTML, /失敗理由・次の操作/);
  assert.match(h.element('list').innerHTML, /今回は見送る/);
  assert.doesNotMatch(h.element('list').innerHTML, /承認して予約へ/);
  h.ctx.showFailure('p0'); h.calls[1].ok(JSON.stringify({ title: 'APIの利用制限', next: '解除を待ってください', error: '<script>', publish_note: '' }));
  assert.match(h.element('list').innerHTML, /編集して再審査/);
  assert.match(h.element('list').innerHTML, /&lt;script&gt;/);
  h.ctx.confirm = () => false; h.ctx.resolveFailure('p0', 'ready'); assert.equal(h.calls.length, 2);
  h.ctx.confirm = () => true; h.ctx.resolveFailure('p0', 'ready');
  assert.equal(h.calls[2].name, 'api_resolveFailedPost'); assert.equal(h.calls[2].args[3], true);
  h.calls[2].ok(JSON.stringify({ post: { ...h.rows[0], status: 'ready' }, message: '承認待ちに戻しました' }));
  assert.equal(h.ctx.posts[0].status, 'ready'); assert.equal(h.calls.length, 3);
  h.ctx.posts[0].status = 'failed'; h.ctx.posts[0].tweet_url = 'https://x.com/i/web/status/1234567890'; h.ctx.renderList();
  assert.match(h.element('list').innerHTML, /投稿済みに戻す/);
  assert.doesNotMatch(h.element('list').innerHTML, /編集して再審査/);
});

test('analytics switches periods during loading, caches each result, and ignores stale successes/errors', () => {
  const h = client(); h.ctx.setTab('analytics'); h.ctx.setAnalyticsPeriod('30'); h.ctx.setAnalyticsPeriod('90');
  assert.deepEqual(h.calls.slice(1).map(c => c.args[1]), ['all', '30', '90']);
  h.calls[2].ok(emptyAnalytics('30')); // Late month result cannot replace selected quarter.
  assert.match(h.element('list').innerHTML, /集計中/);
  h.calls[1].fail(new Error('all-time failure')); assert.doesNotMatch(h.element('list').innerHTML, /all-time failure/);
  h.calls[3].ok(emptyAnalytics('90')); assert.match(h.element('list').innerHTML, /90日/);
  h.ctx.setAnalyticsPeriod('30'); assert.match(h.element('list').innerHTML, /この期間に計測済みの投稿はありません/);
  assert.equal(h.calls.length, 4); // Revisiting the month does not fetch again.
  h.ctx.setAnalyticsPeriod('all'); assert.equal(h.calls.length, 5); // Failed range can retry.
  h.ctx.load(); h.calls[5].ok(JSON.stringify(h.rows)); // Refresh invalidates both cached and in-flight results.
  assert.equal(h.calls.length, 7);
  h.calls[4].ok(emptyAnalytics('old')); assert.match(h.element('list').innerHTML, /集計中/);
  h.calls[6].ok(emptyAnalytics('all')); assert.doesNotMatch(h.element('list').innerHTML, /old日/);
});

test('schedule view refreshes persisted rows, clears unrelated searches, includes date-pending approvals and shows rejections separately', () => {
  const h = client(); h.ctx.searchPosts('絶対に一致しない検索'); h.ctx.setTab('scheduled');
  assert.equal(h.calls[1].name, 'api_listPosts'); assert.equal(h.ctx.query, '');
  h.calls[1].ok(JSON.stringify([
    {...h.rows[0],status:'scheduled',scheduled_at:'2026-11-05 09:00'},
    {...h.rows[1],status:'approved'}, {...h.rows[2],status:'rejected'}
  ]));
  assert.match(h.element('list').innerHTML,/日時確定 1件/);
  assert.match(h.element('list').innerHTML,/日時未確定 1件/);
  assert.match(h.element('list').innerHTML,/予約 2026-11-05 09:00/);
  assert.ok(h.element('list').innerHTML.indexOf('card-p0') < h.element('list').innerHTML.indexOf('card-p1'));
  assert.doesNotMatch(h.element('list').innerHTML,/card-p2/);
  h.ctx.setTab('rejected'); assert.match(h.element('list').innerHTML,/card-p2/);
  assert.match(h.element('tabs').innerHTML,/見送り 1/);
  h.listeners.focus(); assert.equal(h.calls[2].name,'api_listPosts');
});

test('web rejection notifies only on transition; notification failure does not undo saved decision', () => {
  const h = server(), notices = [];
  h.ctx.notifyEditorialDecision = (...args) => {notices.push(args); return false;};
  const result = JSON.parse(h.ctx.api_setStatus('valid','a','rejected','今回は使わない',{includePost:true}));
  assert.equal(result.post.status,'rejected'); assert.match(result.message,/Slack通知は失敗/);
  assert.equal(notices[0][2],'今回は使わない');
  h.ctx.api_setStatus('valid','a','rejected'); assert.equal(notices.length,1);
});
