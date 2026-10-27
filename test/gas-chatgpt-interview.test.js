import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function record({ id = 'voice-20261028-0700', part = 1, total = 1, qi = 1, question = '何を選びましたか？', answer = 'いや、そこで待ったんですよ。\n  急がなかった。', extra = '' } = {}) {
  return `【音声インタビュー記録 v1】\n記録ID: ${id}\n分割: ${part}/${total}\n質問番号: ${qi}\n【質問】\n${question}\n【回答】\n${answer}\n${extra}【記録完了】`;
}

function setup() {
  const tables = { VoiceImports: [], Interviews: [], Stock: [] }, props = { SLACK_CHANNEL_ID: 'C1' }, calls = [], messages = [], triggers = [];
  let locked = false, clock = 1000000;
  class Clock extends Date { static now() { return clock; } }
  const lock = { tryLock() { if (locked) return false; locked = true; return true; },
    waitLock() { assert.equal(locked, false); locked = true; }, releaseLock() { locked = false; } };
  const ctx = vm.createContext({ Date: Clock, console: { log() {} },
    getProp: (k, fallback) => props[k] ?? fallback,
    PropertiesService: { getScriptProperties: () => ({ setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => lock },
    ScriptApp: { getProjectTriggers: () => triggers, newTrigger: handler => ({ timeBased() { return this; }, everyMinutes(n) { assert.equal(n, 5); return this; }, create() { triggers.push({ getHandlerFunction: () => handler }); } }) },
    SHEET: { INTERVIEWS: 'Interviews', STOCK: 'Stock' }, INTERVIEW_STATUS: { OPEN: 'open', DONE: 'done', NO_MATERIAL: 'no_material' },
    readTable: name => tables[name].map((r, i) => ({ ...r, _row: i + 2 })),
    appendRowObj: (name, row) => tables[name].push({ ...row }),
    appendRowsObj: (name, rows) => tables[name].push(...rows.map(r => ({ ...r }))),
    updateRowsWhere: (name, key, value, updates) => tables[name].filter(r => String(r[key]) === String(value)).forEach(r => Object.assign(r, updates)),
    ensureHeaders() {}, clearInterviewRetry() {}, fmtDateTime: () => '2026-10-28 07:10:00', logEvent() {},
    formatInterviewDraftReview: r => r.text, interviewDraftReviewLocation: () => '管理画面で承認',
    interviewFailureRecoveryMessage: () => '回答は保存済みです。回答し直す必要はありません。',
    sendInterviewDraftMessages: (...args) => messages.push(args), notifySlack: (...args) => messages.push(args),
    generateDraftsFromInterview(sid) {
      assert.equal(locked, false); calls.push(sid);
      const row = { id: 'draft1', session_id: sid, text: '下書き', status: 'draft' };
      tables.Stock.push(row); return [row];
    },
  });
  vm.runInContext(readFileSync(new URL('../gas/src/ChatGPTInterview.js', import.meta.url), 'utf8'), ctx);
  ctx.ensureVoiceImportSheet = () => {};
  const event = (text, options = {}) => ({ type: 'message', channel: 'C1', user: 'U1', ts: '1.000001', text, ...options });
  return { ctx, tables, props, calls, messages, triggers, lock, event, advance: n => { clock += n; } };
}

test('voice record: preserves answer whitespace; clarification and AI note never become answers', () => {
  const h = setup(), answer = 'いや、<条件> & 理由。\n  そこは待ったんですよ。  ';
  const parsed = h.ctx.parseVoiceInterviewRecord(record({ answer: answer.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    extra: '【確認会話・原文】\n本人: どういう意味？\n聞き手: 仮の場面です。\n【AIメモ・原文ではない】\nAIの解釈\n' }));
  assert.equal(parsed.answer, answer); assert.equal(parsed.ai_note, 'AIの解釈');
  assert.match(parsed.clarification, /どういう意味/); assert.doesNotMatch(parsed.answer, /解釈|どういう意味/);
  assert.equal(h.ctx.parseVoiceInterviewRecord('普通の返信'), null);
});

test('voice record: rejects incomplete, ambiguous, oversized and impossible frames', () => {
  const h = setup();
  for (const text of [record().replace('【記録完了】', ''), record({ part: 2 }), record({ total: 31 }), record({ qi: 21 }),
    record({ answer: ' ' }), record({ answer: '本文\n【回答】\n別の本文' }), record({ answer: 'a'.repeat(4500) })]) {
    assert.throws(() => h.ctx.parseVoiceInterviewRecord(text));
  }
});

test('voice import: persists before returning and deduplicates Slack retries and identical re-posts', () => {
  const h = setup(), event = h.event(record());
  h.ctx.enqueueVoiceInterviewRecord(event); h.ctx.enqueueVoiceInterviewRecord(event);
  h.ctx.enqueueVoiceInterviewRecord({ ...event, ts: '1.000002' });
  assert.equal(h.tables.VoiceImports.length, 1); assert.equal(h.calls.length, 0); assert.equal(h.messages.length, 0);
  assert.throws(() => h.ctx.enqueueVoiceInterviewRecord(h.event(record({ answer: '別の回答' }))), /別の本文/);
  assert.equal(h.tables.VoiceImports[0].answer, 'いや、そこで待ったんですよ。\n  急がなかった。');
});

test('voice import: waits for all parts, checks thread and total, joins only consecutive parts of the same question', () => {
  const h = setup();
  h.ctx.enqueueVoiceInterviewRecord(h.event(record({ total: 3 })));
  h.ctx.processVoiceInterviewRecords(); assert.equal(h.calls.length, 0);
  assert.throws(() => h.ctx.enqueueVoiceInterviewRecord(h.event(record({ part: 2, total: 2 }))), /分割数/);
  assert.throws(() => h.ctx.enqueueVoiceInterviewRecord(h.event(record({ part: 2, total: 3 }), { ts: '2.000001' })), /スレッド/);
  h.ctx.enqueueVoiceInterviewRecord(h.event(record({ part: 3, total: 3, qi: 2, question: '何を捨てた？', answer: '即答を捨てた。' }), { ts: '1.000003', thread_ts: '1.000001' }));
  h.ctx.processVoiceInterviewRecords(); assert.equal(h.calls.length, 0);
  h.ctx.enqueueVoiceInterviewRecord(h.event(record({ part: 2, total: 3, answer: '次の日に判断した。' }), { ts: '1.000002', thread_ts: '1.000001' }));
  h.ctx.processVoiceInterviewRecords();
  assert.equal(h.calls.length, 1); assert.equal(h.tables.Interviews.length, 2);
  assert.match(h.tables.Interviews[0].answer, /急がなかった。\n次の日に判断した。$/);
  assert.equal(h.tables.Interviews[0].source_kind, 'chatgpt_voice_transcript');
  assert.equal(h.tables.Interviews[1].answer, '即答を捨てた。');
  assert.ok(h.tables.VoiceImports.every(r => r.status === 'done'));
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0][3], '1.000001');
  assert.match(h.messages[0][0], /採点は夜/);
  h.ctx.processVoiceInterviewRecords(); assert.equal(h.calls.length, 1);
});

test('voice import: rejects discontinuous question numbers and changed repeated questions without calling LLM', () => {
  for (const second of [{ qi: 3 }, { qi: 1, question: '違う質問' }]) {
    const h = setup();
    h.ctx.enqueueVoiceInterviewRecord(h.event(record({ total: 2 })));
    h.ctx.enqueueVoiceInterviewRecord(h.event(record({ part: 2, total: 2, ...second }), { ts: '1.000002', thread_ts: '1.000001' }));
    h.ctx.processVoiceInterviewRecords(); assert.equal(h.calls.length, 0);
    assert.ok(h.tables.VoiceImports.every(r => r.status === 'failed'));
  }
});

test('voice import: lease blocks concurrent generation; failure retains sources and does not auto-loop', () => {
  const h = setup(); h.ctx.enqueueVoiceInterviewRecord(h.event(record()));
  h.ctx.generateDraftsFromInterview = sid => {
    assert.equal(h.tables.Interviews[0].status, 'open');
    h.ctx.processVoiceInterviewRecords(); h.calls.push(sid); throw new Error('LLM unavailable');
  };
  h.ctx.processVoiceInterviewRecords(); h.ctx.processVoiceInterviewRecords();
  assert.equal(h.calls.length, 1); assert.equal(h.tables.VoiceImports[0].status, 'failed');
  assert.equal(h.tables.Interviews[0].status, 'done'); assert.match(h.messages[0][0], /保存済み/);
  assert.ok(h.tables.Interviews[0].answer); assert.ok(h.tables.VoiceImports[0].raw_text);
});

test('voice import: stale lease is held once; preexisting stock is never regenerated', () => {
  const h = setup(); h.ctx.enqueueVoiceInterviewRecord(h.event(record()));
  Object.assign(h.tables.VoiceImports[0], { status: 'running', started_at: '1000000' });
  h.ctx.processVoiceInterviewRecords(); assert.equal(h.calls.length, 0);
  h.advance(7 * 60000 + 1); h.ctx.processVoiceInterviewRecords();
  assert.equal(h.tables.VoiceImports[0].status, 'failed'); assert.equal(h.calls.length, 0);
  const h2 = setup(); h2.ctx.enqueueVoiceInterviewRecord(h2.event(record()));
  h2.tables.Stock.push({ session_id: h2.tables.VoiceImports[0].session_id, text: '保存済み下書き' });
  h2.ctx.processVoiceInterviewRecords(); assert.equal(h2.calls.length, 0); assert.equal(h2.tables.VoiceImports[0].status, 'done');
});

test('voice import: no-material is final, and bot/channel edits are not implicitly trusted', () => {
  const h = setup(), event = h.event(record());
  assert.equal(h.ctx.acceptsVoiceRecordEvent(event), true);
  for (const change of [{ channel: 'C2' }, { bot_id: 'B2' }, { subtype: 'message_changed' }, { text: 'ordinary' }]) {
    assert.equal(h.ctx.acceptsVoiceRecordEvent({ ...event, ...change }), false);
  }
  h.props.CHATGPT_SLACK_BOT_ID = 'B2'; assert.equal(h.ctx.acceptsVoiceRecordEvent({ ...event, bot_id: 'B2', subtype: 'bot_message' }), true);
  h.ctx.enqueueVoiceInterviewRecord(event); h.ctx.generateDraftsFromInterview = sid => { h.calls.push(sid); return []; };
  h.ctx.processVoiceInterviewRecords(); h.ctx.processVoiceInterviewRecords();
  assert.equal(h.calls.length, 1); assert.equal(h.tables.Interviews[0].status, 'no_material');
});

test('voice setup: preserves other triggers, is idempotent and only then switches entry', () => {
  const h = setup(); h.triggers.push({ getHandlerFunction: () => 'postTick' });
  assert.equal(h.ctx.usesChatGPTInterview(), false); h.ctx.setupChatGPTVoiceInterview(); h.ctx.setupChatGPTVoiceInterview();
  assert.equal(h.triggers.length, 2); assert.equal(h.ctx.usesChatGPTInterview(), true);
  h.ctx.restoreSlackInterviewEntry(); assert.equal(h.ctx.usesChatGPTInterview(), false);
  const h2 = setup(); h2.ctx.ScriptApp.newTrigger = () => { throw new Error('quota'); };
  assert.throws(() => h2.ctx.setupChatGPTVoiceInterview(), /quota/); assert.equal(h2.ctx.usesChatGPTInterview(), false);
});

test('voice webhook: durable import runs before event cache, images and ordinary interview handling', () => {
  const h = setup(), events = [];
  Object.assign(h.ctx, { CacheService: { getScriptCache() { throw new Error('cache must not gate voice record'); } },
    ContentService: { createTextOutput: text => text }, enqueueVoiceInterviewRecord: event => events.push(event),
  });
  vm.runInContext(readFileSync(new URL('../gas/src/WebApp.js', import.meta.url), 'utf8'), h.ctx);
  assert.equal(h.ctx.doPost({ postData: { contents: JSON.stringify({ type: 'event_callback', event: h.event(record()), event_id: 'E1' }) } }), 'voice record saved');
  assert.equal(events.length, 1);
});

test('voice entry: daily/retry/extra entry never asks Slack questions in ChatGPT mode', () => {
  const h = setup(); h.props.INTERVIEW_ENTRYPOINT = 'chatgpt_voice';
  vm.runInContext(readFileSync(new URL('../gas/src/Interview.js', import.meta.url), 'utf8'), h.ctx);
  h.ctx.clearInterviewRetry = () => {};
  h.ctx.startDailyInterview(); h.ctx.retryDailyInterview(); h.ctx.startExtraInterview(); h.ctx.startInterviewSession('iv', 'test');
  assert.equal(h.messages.length, 0); assert.equal(h.tables.Interviews.length, 0);
});

test('voice webhook: rejected format is explained once; temporary persistence failures remain retryable', () => {
  const h = setup(), cache = {};
  Object.assign(h.ctx, { CacheService: { getScriptCache: () => ({ get: key => cache[key], put: (key, value) => { cache[key] = value; } }) },
    ContentService: { createTextOutput: text => text },
  });
  vm.runInContext(readFileSync(new URL('../gas/src/WebApp.js', import.meta.url), 'utf8'), h.ctx);
  const request = text => ({ postData: { contents: JSON.stringify({ type: 'event_callback', event: h.event(text), event_id: 'E1' }) } });
  const bad = request(record().replace('【記録完了】', ''));
  assert.equal(h.ctx.doPost(bad), 'voice record rejected'); h.ctx.doPost(bad);
  assert.equal(h.messages.length, 1); assert.match(h.messages[0][0], /回答し直す必要はありません/);
  h.ctx.ensureVoiceImportSheet = () => { throw new Error('Sheets unavailable'); };
  assert.throws(() => h.ctx.doPost(request(record())), /Sheets unavailable/);
  h.ctx.ensureVoiceImportSheet = () => {};
  assert.equal(h.ctx.doPost(request(record())), 'voice record saved'); assert.equal(h.tables.VoiceImports.length, 1);
});
