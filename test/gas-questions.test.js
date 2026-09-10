import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup() {
  const ctx = vm.createContext({});
  for (const file of ['Pure.js', 'Interview.js']) {
    vm.runInContext(readFileSync(new URL('../gas/src/' + file, import.meta.url), 'utf8'), ctx);
  }
  ctx.SHEET = { INTERVIEWS: 'Interviews', STOCK: 'Stock' };
  ctx.getMemoryNotes = () => ['似た答えになる問いは減らして', 'スキップ', 'https://example.com/?token=private'];
  ctx.axisGuidanceForQuestions = () => '';
  ctx.logEvent = () => {};
  ctx.readTable = (name) => name === 'Interviews' ? [
    { question: '試作の変更点は？', answer: '3kg軽量化', answered_at: '2026-09-10' },
    { question: '抽象的な質問？', answer: '', answered_at: 'skipped' },
  ] : [];
  return ctx;
}

test('question context preserves short answers without treating them as failure', () => {
  const ctx = setup();
  assert.deepEqual(Array.from(ctx.hardToAnswerQuestions()), ['- 抽象的な質問？']);
  assert.match(ctx.wellAnsweredQuestions().join('\n'), /3kg軽量化/);
  const notes = ctx.buildInterviewMemoryPrompt();
  assert.match(notes, /似た答え/);
  assert.doesNotMatch(notes, /token=|スキップ/);
});

test('initial question schema rejects unknown sources, duplicates and malformed questions', () => {
  const ctx = setup();
  const themes = [{ theme: '試作', category: 'evergreen' }];
  const q = (question, more = {}) => ({ theme: '試作', category: 'evergreen', question, ...more });
  ctx.askClaudeJson = (system, user) => {
    assert.match(system, /似た答え/);
    assert.match(user, /3kg軽量化/);
    return [null, q('最近の工夫は？'), q('最近の工夫は?'), q('どこ？なぜ？'),
      q('別のテーマ？', { theme: '未指定' }), q('型は？', { category: 'news' }), q({ text: '不正' })];
  };
  assert.equal(ctx.generateInterviewQuestions(themes, [], 4).length, 1);
  ctx.askClaudeJson = () => [q('別のテーマ？', { theme: '未指定' })];
  assert.throws(() => ctx.generateInterviewQuestions(themes, [], 4), /有効な質問/);
});

test('turn plan rejects invented acknowledgements and respects followup budget', () => {
  const ctx = setup();
  const current = { question: '最近の工夫は？', answer: '3kg軽量化した' };
  const next = { question: '苦労した点は？', theme: '試作' };
  ctx.askClaude = () => JSON.stringify({ quote: '5kg軽量化した', followup: '何を変えた？', next_question: '何を？なぜ？' });
  const result = ctx.planInterviewTurn([current, next], current, current.answer, next, false, false);
  assert.equal(result.quote, '');
  assert.equal(result.followup, '');
  assert.equal(result.next_question, '');
  ctx.askClaude = () => JSON.stringify({ quote: '3kg軽量化', followup: current.question });
  const repeated = ctx.planInterviewTurn([current], current, current.answer, null, true, false);
  assert.equal(repeated.quote, '3kg軽量化');
  assert.equal(repeated.followup, '');
});

test('turn plan survives malformed output and unavailable memory without extra API retries', () => {
  const ctx = setup();
  const current = { question: '最近の工夫は？', answer: '3kg軽量化した' };
  let calls = 0;
  ctx.getMemoryNotes = () => { throw new Error('memory unavailable'); };
  ctx.askClaude = () => { calls++; return '{broken'; };
  assert.equal(Object.keys(ctx.planInterviewTurn([current], current, current.answer, null, true, false)).length, 0);
  assert.equal(calls, 1);
});
