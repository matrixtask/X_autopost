import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup(ids = ['s3', 's2', 's1']) {
  const values = {}, triggers = [], calls = [], messages = [], logs = [];
  const eligible = new Set(ids);
  let locked = false, clock = 1000000;
  const props = { getProperties: () => ({ ...values }), getProperty: key => values[key] || null,
    setProperty: (key, value) => { values[key] = value; }, deleteProperty: key => { delete values[key]; } };
  const lock = { tryLock: () => { if (locked) return false; locked = true; return true; },
    waitLock: () => { assert.equal(locked, false); locked = true; }, releaseLock: () => { locked = false; } };
  class Clock extends Date { static now() { return clock; } }
  const ctx = vm.createContext({ Date: Clock, PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => lock },
    ScriptApp: { getProjectTriggers: () => [...triggers], deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: handler => ({ timeBased() { return this; }, everyMinutes(n) { assert.equal(n, 5); return this; },
        create() { const t = { getHandlerFunction: () => handler }; triggers.push(t); return t; } }) },
    failedInterviewSessions: () => [...eligible].map(sid => ({ sid })),
    generateDraftsFromInterview: sid => { assert.equal(locked, false); calls.push(sid); eligible.delete(sid); return [{ id: sid }]; },
    SHEET: { INTERVIEWS: 'Interviews' }, INTERVIEW_STATUS: { NO_MATERIAL: 'no_material' },
    updateRowsWhere: (_table, _key, sid) => eligible.delete(sid),
    logEvent: (...args) => logs.push(args), notifySlack: message => messages.push(message),
  });
  vm.runInContext(readFileSync(new URL('../gas/src/InterviewRecovery.js', import.meta.url), 'utf8'), ctx);
  return { ctx, values, triggers, calls, messages, logs, eligible, lock,
    advance: ms => { clock += ms; }, jobs: () => JSON.parse(JSON.stringify(ctx.interviewRecoveryJobs(props))) };
}

test('recovery: one start snapshots the queue, processes one per invocation and completes without touching other triggers', () => {
  const h = setup();
  h.triggers.push({ getHandlerFunction: () => 'postTick' });
  assert.match(h.ctx.startFailedInterviewBatch(), /3セッション/);
  assert.match(h.ctx.startFailedInterviewBatch(), /既に実行中/);
  h.eligible.add('s4'); // 開始後の回答はこのバッチには混ぜない。
  h.ctx.runFailedInterviewBatch(); assert.deepEqual(h.calls, ['s3']);
  h.ctx.runFailedInterviewBatch(); h.ctx.runFailedInterviewBatch();
  assert.deepEqual(h.calls, ['s3', 's2', 's1']);
  assert.ok(h.jobs().every(j => j.status === 'done'));
  assert.equal(h.triggers.length, 1); assert.equal(h.triggers[0].getHandlerFunction(), 'postTick');
  assert.match(h.messages.at(-1), /生成 3/);
  assert.equal(JSON.parse(h.values.INTERVIEW_RECOVERY_STATE).active, false);
});

test('recovery: a failure is retained once and later sessions continue', () => {
  const h = setup(['s2', 's1']); h.ctx.startFailedInterviewBatch();
  h.ctx.generateDraftsFromInterview = sid => { h.calls.push(sid); if (sid === 's2') throw new Error('API unavailable'); return [{ id: sid }]; };
  h.ctx.runFailedInterviewBatch(); h.ctx.runFailedInterviewBatch(); h.ctx.runFailedInterviewBatch();
  assert.deepEqual(h.calls, ['s2', 's1']);
  assert.equal(h.jobs().find(j => j.sid === 's2').status, 'failed');
  assert.match(h.messages.at(-1), /失敗・中断 1/);
});

test('recovery: a live lease prevents concurrent work, an expired lease is held without retry', () => {
  const h = setup(['s2', 's1']); h.ctx.startFailedInterviewBatch();
  h.values.INTERVIEW_RECOVERY_JOB_s2 = JSON.stringify({ sid: 's2', status: 'running', started_at: 1000000 });
  h.ctx.runFailedInterviewBatch(); assert.equal(h.calls.length, 0);
  h.advance(7 * 60000 + 1); h.ctx.runFailedInterviewBatch();
  assert.deepEqual(h.calls, ['s1']);
  assert.equal(h.jobs().find(j => j.sid === 's2').status, 'failed');
});

test('recovery: rechecks eligibility before generating and no-material is not retried', () => {
  const h = setup(['s2', 's1']); h.ctx.startFailedInterviewBatch();
  h.eligible.delete('s2');
  h.ctx.generateDraftsFromInterview = sid => { h.calls.push(sid); return []; };
  h.ctx.runFailedInterviewBatch();
  assert.deepEqual(h.calls, ['s1']);
  assert.deepEqual(h.jobs().map(j => j.status), ['skipped', 'no_material']);
  assert.equal(h.triggers.length, 0);
});

test('recovery: worker does not hold the reply lock during generation and a concurrent worker skips', () => {
  const h = setup(['s1']); h.ctx.startFailedInterviewBatch();
  h.ctx.generateDraftsFromInterview = sid => {
    assert.equal(h.lock.tryLock(), true); h.lock.releaseLock();
    h.ctx.runFailedInterviewBatch(); h.calls.push(sid); return [{ id: sid }];
  };
  h.ctx.runFailedInterviewBatch(); assert.deepEqual(h.calls, ['s1']);
});

test('recovery: stopping retains data and rejects restart while the current session is running', () => {
  const h = setup(['s1']); h.ctx.startFailedInterviewBatch();
  h.ctx.generateDraftsFromInterview = sid => {
    h.ctx.stopFailedInterviewBatch();
    assert.match(h.ctx.startFailedInterviewBatch(), /既に実行中/);
    h.calls.push(sid); return [{ id: sid }];
  };
  h.ctx.runFailedInterviewBatch();
  assert.equal(h.jobs()[0].status, 'done'); assert.equal(h.triggers.length, 0);
  assert.equal(JSON.parse(h.values.INTERVIEW_RECOVERY_STATE).active, false);
});

test('recovery: lock contention and trigger-registration failure do not start a stuck batch', () => {
  const h = setup(); h.lock.tryLock();
  assert.match(h.ctx.startFailedInterviewBatch(), /別の編集処理/);
  h.ctx.runFailedInterviewBatch(); assert.equal(h.calls.length, 0); h.lock.releaseLock();
  h.ctx.ScriptApp.newTrigger = () => { throw new Error('trigger quota'); };
  assert.throws(() => h.ctx.startFailedInterviewBatch(), /trigger quota/);
  assert.equal(h.ctx.interviewRecoveryIsActive(), false);
});
