import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sources = ['Pure', 'Editorial', 'OutcomeQuality', 'Interview'].map((name) =>
  readFileSync(new URL(`../gas/src/${name}.js`, import.meta.url), 'utf8'));
const threadTs = '1789000000.123456';
const sessionId = '2026-09-10_iv_test';
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(count = 2, options = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    session_id: sessionId, thread_ts: `ts_${threadTs}`, idx: i + 1,
    theme: `テーマ${i + 1}`, category: 'evergreen', question: `質問${i + 1}は何ですか？`,
    answer: '', answered_at: '', status: 'open', _row: i + 2,
  }));
  const messages = [];
  const logs = [];
  const calls = [];
  const responses = [];
  const finished = [];
  const memories = [];
  let releases = 0;
  let generations = 0;
  let gates = 0;
  const context = {
    module: { exports: {} },
    SHEET: { INTERVIEWS: 'Interviews', STOCK: 'Stock' },
    STATUS: { READY: 'ready', APPROVED: 'approved', SCHEDULED: 'scheduled' },
    // Sheets returns detached rows. A mutation must go through an update helper.
    readTable: (sheet) => clone(sheet === 'Interviews' ? rows : []),
    updateRowsWhere: (sheet, key, value, updates) => {
      assert.equal(sheet, 'Interviews');
      rows.filter((row) => row[key] === value).forEach((row) => Object.assign(row, updates));
    },
    sendSlack: (text, thread) => { messages.push({ text, thread }); return { ts: threadTs }; },
    notifySlack: (text) => messages.push({ text }),
    logEvent: (type, message) => logs.push({ type, message }),
    getProp: (key, fallback) => options.props?.[key] ?? fallback,
    getMemoryNotes: () => [],
    prepareEditorialCouncil: () => ({}),
    editorialCouncilInstructions: () => '',
    addMemory: (text, source) => memories.push({ text, source }),
    nowJst: () => new Date('2026-09-10T03:00:00Z'),
    fmtDateTime: () => '2026-09-10 12:00',
    ensureHeaders: () => {},
    askClaude: (system, input) => {
      calls.push({ system, input, rows: clone(rows) });
      const response = responses.shift() ?? {};
      if (response instanceof Error) throw response;
      return JSON.stringify(response);
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => options.lockAvailable !== false,
        releaseLock: () => { releases++; },
      }),
    },
    generateDraftsFromInterview: () => { generations++; return []; },
    runQualityGateWithRefinement: () => { gates++; return { scored: 0, passed: 0 }; },
  };
  vm.createContext(context);
  sources.forEach((source) => vm.runInContext(source, context));
  context.updateInterviewRow = (sid, idx, updates) => {
    const row = rows.find((item) => item.session_id === sid && item.idx === idx);
    assert.ok(row, `missing interview row ${sid}/${idx}`);
    Object.assign(row, clone(updates));
  };
  const realFinish = context.finishInterview;
  context.finishInterview = (sid, thread) => {
    finished.push({ sid, thread });
    if (options.realFinish) return realFinish(sid, thread);
    rows.filter((row) => row.session_id === sid).forEach((row) => { row.status = 'done'; });
  };
  return {
    rows, messages, logs, calls, responses, finished, memories, context,
    reply: (text, imageRef) => context.handleInterviewReply(threadTs, text, imageRef),
    get releases() { return releases; },
    get generations() { return generations; },
    get gates() { return gates; },
  };
}

test('interview: save the original answer before calling Claude and advance with detached sheet rows', () => {
  const f = fixture();
  const answer = '昨日3社に断られた。\n理由はまだ聞けていない。';
  f.responses.push({ quote: '昨日3社に断られた。' });
  assert.equal(f.reply(answer), true);
  assert.equal(f.rows[0].answer, answer);
  assert.equal(f.calls[0].rows[0].answer, answer);
  assert.equal(f.rows[1].answer, '');
  assert.match(f.messages.at(-1).text, /Q2\./);
  assert.equal(f.finished.length, 0);
  assert.equal(f.releases, 1);
});

test('interview: clarification retains the current question and does not save an answer', () => {
  const f = fixture();
  const originalQuestion = f.rows[0].question;
  f.responses.push({ clarification: '昨日決めたことを1つ教えてください。' });
  f.reply('どういう意味？');
  assert.equal(f.rows[0].question, originalQuestion);
  assert.equal(f.rows[0].answer, '');
  assert.equal(f.rows[0].answered_at, '');
  assert.equal(f.rows[1].answer, '');
  assert.match(f.messages.at(-1).text, /昨日決めたこと/);
  assert.equal(f.finished.length, 0);
});

test('interview: clarification of a pending follow-up refers to that follow-up', () => {
  const f = fixture();
  f.responses.push({ followup: '3社に共通していた理由は何でしたか？' });
  f.reply('昨日3社に断られた');
  f.responses.push({ clarification: '断られた理由で同じものはありましたか？' });
  f.reply('もう少し具体的に');
  const input = JSON.parse(f.calls.at(-1).input.split('\nJSONのみ:')[0]);
  assert.equal(input.current_question, f.rows[0].followup_question);
  assert.equal(input.clarification_requested, true);
  assert.equal(f.rows[0].answer, '昨日3社に断られた');
  assert.equal(f.rows[0].followup_answered_at, undefined);
  assert.match(f.messages.at(-1).text, /Q1の補足/);
});

test('interview: end commands require an exact match, not the prefix of an answer', () => {
  const f = fixture();
  f.reply('以上の条件なら進めます');
  assert.equal(f.rows[0].answer, '以上の条件なら進めます');
  assert.equal(f.finished.length, 0);
  f.reply('以上。');
  assert.equal(f.finished.length, 1);
  assert.equal(f.rows[1].answer, '');
});

test('interview: follow-up is limited to one per session and skipping preserves the answer', () => {
  const f = fixture(3);
  f.responses.push({ followup: '3社に共通していた理由は何でしたか？' });
  f.reply('昨日3社に断られた');
  f.reply('スキップ');
  assert.equal(f.rows[0].answer, '昨日3社に断られた');
  assert.equal(f.rows[0].followup_answer, '');
  assert.equal(f.rows[0].followup_answered_at, 'skipped');
  assert.match(f.messages.at(-1).text, /元の回答は残しています/);
  assert.match(f.messages.at(-1).text, /Q2\./);
  f.responses.push({ followup: 'もう少し教えてください？' });
  f.reply('今日は試験を延期しました');
  assert.equal(f.rows[1].followup_question, undefined);
  assert.match(f.messages.at(-1).text, /Q3\./);
  const input = JSON.parse(f.calls.at(-1).input.split('\nJSONのみ:')[0]);
  assert.equal(input.allow_followup, false);
});

test('interview: the final question waits for its pending follow-up and includes both source answers', () => {
  const f = fixture(1);
  f.responses.push({ followup: '断られた理由は何でしたか？' });
  f.reply('昨日3社に断られた');
  assert.equal(f.finished.length, 0);
  assert.equal(f.reply('納期が合わなかった'), true);
  assert.equal(f.rows[0].answer, '昨日3社に断られた');
  assert.equal(f.rows[0].followup_answer, '納期が合わなかった');
  assert.equal(f.finished.length, 1);
  const source = f.context.interviewAnswerText(f.rows[0]);
  assert.match(source, /昨日3社に断られた/);
  assert.match(source, /補足Q（本人の事実ではない）/);
  assert.match(source, /補足A: 納期が合わなかった/);
});

test('interview: Claude failure preserves the answer and advances to the planned question', () => {
  const f = fixture();
  f.responses.push(new Error('API unavailable'));
  f.reply('昨日3社に断られた');
  assert.equal(f.rows[0].answer, '昨日3社に断られた');
  assert.match(f.messages.at(-1).text, /Q2\. 質問2は何ですか？/);
  assert.ok(f.logs.some((entry) => entry.type === 'interview_turn_error'));
  assert.equal(f.releases, 1);
});

test('interview: next-question adaptation is persisted before it is sent', () => {
  const f = fixture();
  f.responses.push({ next_question: '延期で今日変えた予定は何ですか？' });
  f.reply('試験を延期しました');
  assert.equal(f.rows[1].question, '延期で今日変えた予定は何ですか？');
  assert.match(f.messages.at(-1).text, /Q2\. 延期で今日変えた予定/);
  assert.equal(f.rows[1].answer, '');
});

test('interview: a completed session is not revived by later feedback, even with unanswered rows', () => {
  const f = fixture();
  f.reply('終了');
  assert.equal(f.rows[0].status, 'done');
  assert.equal(f.reply('この質問は答えにくかった'), false);
  assert.equal(f.rows[0].status, 'done');
  assert.equal(f.rows[0].answer, '');
  assert.equal(f.calls.length, 0);
  assert.equal(f.finished.length, 1);
});

test('interview: no-material completion is excluded from failed-session regeneration', () => {
  const f = fixture(1, { realFinish: true });
  f.reply('分からない');
  assert.equal(f.rows[0].answer, '分からない');
  assert.equal(f.rows[0].status, 'no_material');
  assert.equal(f.generations, 1);
  assert.equal(f.gates, 0);
  assert.match(f.context.regenerateFailedInterviews(), /対象はありません/);
  assert.equal(f.generations, 1);
  assert.equal(f.reply('質問を言い換えて'), false);
});

test('interview: end during a follow-up skips only the supplement and retains the original', () => {
  const f = fixture();
  f.responses.push({ followup: '延期を決めた理由は何ですか？' });
  f.reply('試験を延期しました');
  f.reply('終了');
  assert.equal(f.rows[0].answer, '試験を延期しました');
  assert.equal(f.rows[0].followup_answered_at, 'skipped');
  assert.equal(f.finished.length, 1);
});

test('interview: explicit decline blocks follow-ups even if Claude proposes one', () => {
  const f = fixture();
  f.responses.push({ followup: '秘密の内容を教えてください？' });
  f.reply('そこは非公開です');
  assert.equal(f.rows[0].answer, 'そこは非公開です');
  assert.equal(f.rows[0].followup_question, undefined);
  assert.match(f.messages.at(-1).text, /Q2\./);
});

test('interview: busy lock does not consume the reply or call Claude', () => {
  const f = fixture(2, { lockAvailable: false });
  assert.equal(f.reply('昨日3社に断られた'), true);
  assert.equal(f.rows[0].answer, '');
  assert.equal(f.calls.length, 0);
  assert.equal(f.releases, 0);
  assert.match(f.messages.at(-1).text, /まだ記録していません/);
});

test('interview: operational memo and explicit correction do not consume the current answer', () => {
  const f = fixture();
  f.reply('メモ: 一問を短くして');
  f.reply('訂正: 昨日は2社でした');
  assert.equal(f.rows[0].answer, '');
  assert.equal(f.rows[0].answered_at, '');
  assert.equal(f.memories[0].text, '一問を短くして');
  assert.equal(f.calls.length, 0);
});

test('interview: regeneration marks an empty result as no-material and does not retry it again', () => {
  const f = fixture(1);
  Object.assign(f.rows[0], { status: 'done', answer: '今回は話せることがありません', answered_at: '2026-09-10 12:00' });
  f.context.regenerateFailedInterviews();
  assert.equal(f.rows[0].status, 'no_material');
  assert.equal(f.generations, 1);
  assert.match(f.context.regenerateFailedInterviews(), /対象はありません/);
  assert.equal(f.generations, 1);
});

test('interview: memory-read failure still saves the answer and advances', () => {
  const f = fixture();
  f.context.getMemoryNotes = () => { throw new Error('Memory sheet unavailable'); };
  f.reply('昨日3社に断られた');
  assert.equal(f.rows[0].answer, '昨日3社に断られた');
  assert.equal(f.calls.length, 1);
  assert.match(f.messages.at(-1).text, /Q2\./);
  assert.ok(f.logs.some((entry) => entry.type === 'interview_memory_error'));
});

test('interview: regeneration excludes an open session with saved answers', () => {
  const f = fixture();
  Object.assign(f.rows[0], { answer: '昨日3社に断られた', answered_at: '2026-09-10 12:00' });
  assert.match(f.context.regenerateFailedInterviews(), /対象はありません/);
  assert.equal(f.generations, 0);
});

test('interview: regeneration excludes the whole expired session while any follow-up is pending', () => {
  const f = fixture();
  f.rows.forEach((row) => { row.status = 'expired'; });
  Object.assign(f.rows[0], { answer: '昨日3社に断られた', answered_at: '2026-09-10 12:00' });
  Object.assign(f.rows[1], {
    answer: '試験を延期しました', answered_at: '2026-09-10 12:00',
    followup_question: '延期を決めた理由は何ですか？',
  });
  assert.match(f.context.regenerateFailedInterviews(), /対象はありません/);
  assert.equal(f.generations, 0);
});
