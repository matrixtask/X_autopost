import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function setup() {
  let locked = false, now = 1000000;
  const props = {}, triggers = [], calls = [], logs = [];
  const rows = ['a', 'b', 'c'].map(id => ({ id, status: 'draft', text: id }));
  const lock = { tryLock() { if (locked) return false; locked = true; return true; },
    waitLock() { assert.equal(locked, false); locked = true; }, releaseLock() { locked = false; } };
  class Clock extends Date { static now() { return now; } }
  const ctx = vm.createContext({ Date: Clock, LockService: { getScriptLock: () => lock },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k], setProperty: (k, v) => { props[k] = v; } }) },
    ScriptApp: { getProjectTriggers: () => [...triggers], deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: name => ({ timeBased() { return this; }, everyMinutes(n) { assert.equal(n, 1); return this; },
        create() { triggers.push({ getHandlerFunction: () => name }); } }) },
    readTable: () => rows.map(r => ({ ...r })), SHEET: { STOCK: 'Stock' }, STATUS: { DRAFT: 'draft', READY: 'ready', STOCK: 'stock' },
    logEvent: (...x) => logs.push(x), runOutcomeQualityGate: selected => {
      assert.equal(locked, false); assert.equal(selected.length, 1); calls.push(selected[0].id);
      rows.find(r => r.id === selected[0].id).status = 'ready';
    },
  });
  vm.runInContext(fs.readFileSync(new URL('../gas/src/OutcomeReviewQueue.js', import.meta.url), 'utf8'), ctx);
  return { ctx, rows, calls, props, logs, triggers, lock, state: () => JSON.parse(props.OUTCOME_REVIEW_QUEUE || '{}'),
    advance: n => { now += n; } };
}

test('review queue: snapshots only drafts, runs one per invocation and cleans up only its own trigger', () => {
  const h = setup(); h.rows.push({ id: 'approved', status: 'approved' });
  h.triggers.push({ getHandlerFunction: () => 'postTick' });
  assert.match(h.ctx.startPendingReviewBatch(), /3件/);
  assert.match(h.ctx.startPendingReviewBatch(), /既に実行中/);
  h.rows.push({ id: 'new', status: 'draft' });
  h.ctx.runPendingReviewBatch(); assert.deepEqual(h.calls, ['a']);
  h.ctx.runPendingReviewBatch(); h.ctx.runPendingReviewBatch();
  assert.deepEqual(h.calls, ['a', 'b', 'c']); assert.equal(h.state().active, false);
  assert.equal(h.state().counts.ready, 3); assert.equal(h.triggers.length, 1);
  assert.equal(h.triggers[0].getHandlerFunction(), 'postTick');
  assert.equal(h.rows.find(r => r.id === 'approved').status, 'approved');
  assert.equal(h.rows.find(r => r.id === 'new').status, 'draft');
});

test('review queue: held and malformed reviews do not prevent later drafts; failed drafts are not retried', () => {
  const h = setup(); h.ctx.startPendingReviewBatch();
  h.ctx.runOutcomeQualityGate = selected => {
    const id = selected[0].id; h.calls.push(id);
    if (id === 'a') h.rows[0].status = 'stock';
    if (id === 'b') throw new Error('API unavailable');
  };
  for (let i = 0; i < 5; i++) h.ctx.runPendingReviewBatch();
  assert.deepEqual(h.calls, ['a', 'b', 'c']);
  assert.deepEqual(h.state().counts, { ready: 0, held: 1, failed: 2, skipped: 0 });
  assert.equal(h.rows[1].status, 'draft'); assert.equal(h.rows[2].status, 'draft');
});

test('review queue: live lease blocks concurrency; terminated work is held once and remaining work continues', () => {
  const h = setup(); h.ctx.startPendingReviewBatch();
  const state = h.state(); state.pending.shift(); state.running = { id: 'a', started_at: 1000000 };
  h.props.OUTCOME_REVIEW_QUEUE = JSON.stringify(state);
  h.ctx.runPendingReviewBatch(); assert.equal(h.calls.length, 0);
  h.advance(7 * 60000 + 1); h.ctx.runPendingReviewBatch(); h.ctx.runPendingReviewBatch();
  assert.deepEqual(h.calls, ['b', 'c']); assert.equal(h.state().counts.failed, 1);
  assert.equal(h.rows[0].status, 'draft'); assert.equal(h.state().active, false);
});

test('review queue: user changes and stop preserve stored state without approving or publishing', () => {
  const h = setup(); h.ctx.startPendingReviewBatch(); h.rows[0].status = 'approved';
  h.ctx.runPendingReviewBatch(); assert.equal(h.state().counts.skipped, 1); assert.equal(h.calls.length, 0);
  h.ctx.runOutcomeQualityGate = selected => {
    h.ctx.runPendingReviewBatch(); // Concurrent invocation must not claim another row.
    h.ctx.stopPendingReviewBatch();
    assert.match(h.ctx.startPendingReviewBatch(), /既に実行中/);
    h.calls.push(selected[0].id); h.rows[1].status = 'ready';
  };
  h.ctx.runPendingReviewBatch(); h.ctx.runPendingReviewBatch();
  assert.deepEqual(h.calls, ['b']); assert.equal(h.state().active, false);
  assert.equal(h.rows[2].status, 'draft'); assert.equal(h.triggers.length, 0);
});

test('review queue: registration failure and lock contention leave no active batch; empty queue does no work', () => {
  const h = setup(); h.lock.tryLock();
  assert.match(h.ctx.startPendingReviewBatch(), /別の保存/); h.ctx.runPendingReviewBatch(); h.lock.releaseLock();
  h.ctx.ScriptApp.newTrigger = () => { throw new Error('quota'); };
  assert.throws(() => h.ctx.startPendingReviewBatch(), /quota/); assert.equal(h.state().active, undefined);
  h.rows.length = 0; assert.match(h.ctx.startPendingReviewBatch(), /ありません/);
});
