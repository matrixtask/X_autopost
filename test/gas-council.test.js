import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function debate() {
  return { opinions: ['rei', 'sebastian', 'hannibal'].map((persona, i, people) => ({
    persona, proposal: `提案${i}`, challenge_to: people[(i + 1) % 3], challenge: `異論${i}`, final_position: `確定${i}`,
  })), agreement: '本人の判断を残す', disagreement: '採用に毎回結びつける必要はない' };
}
function reflection(anchors = []) {
  return { adopt: '捨てた案を残す', reject: '後付けの教訓は使わない', direction: '選択の理由を伝える',
    question_focus: '判断の理由を一つ聞く', no_material: false, anchors };
}
function setup() {
  const calls = [], logs = [], stock = [], qa = [], responses = [];
  const ctx = vm.createContext({ console, Date,
    SHEET: { STOCK: 'Stock', INTERVIEWS: 'Interviews' }, STATUS: { DRAFT: 'draft' },
    getProp: (_k, fallback) => fallback, getMemoryNotes: () => [],
    buildStylePrompt: () => '本人の原文を守る', ensureHeaders: () => {},
    readTable: name => structuredClone(name === 'Stock' ? stock : qa),
    appendRowObj: (_name, row) => stock.push(structuredClone(row)),
    syncStockRowToNotion: () => {}, logEvent: (...args) => logs.push(args),
    newId: () => 'p1', nowJst: () => new Date(), fmtDateTime: () => '2026-09-11 10:00',
  });
  for (const name of ['Pure', 'Editorial', 'EditorialCouncil', 'Interview', 'Drafts']) {
    vm.runInContext(readFileSync(new URL(`../gas/src/${name}.js`, import.meta.url), 'utf8'), ctx);
  }
  ctx.axisGuidanceForQuestions = () => '';
  const request = (kind, system, input, tokens, opts) => {
    calls.push({ kind, system, input, tokens, purpose: opts.purpose });
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return kind === 'text' ? JSON.stringify(result) : structuredClone(result);
  };
  ctx.askClaudeJson = (...args) => request('json', ...args);
  ctx.askClaude = (...args) => request('text', ...args);
  ctx.askClaudeJsonSalvageable = (...args) => request('draft', ...args);
  return { ctx, calls, logs, stock, qa, responses };
}

test('council: questions wait for distinct final positions and Mia reflection, then generate', () => {
  const { ctx, calls, logs, responses } = setup();
  responses.push(debate(), reflection(), [{ theme: '試作', category: 'evergreen', question: '別案を見送った理由は何ですか？' }]);
  assert.equal(ctx.generateInterviewQuestions([{ theme: '試作', category: 'evergreen' }], [], 4).length, 1);
  assert.deepEqual(calls.map(c => c.kind), ['json', 'json', 'json']);
  assert.ok(calls.every(c => c.purpose === 'interview'));
  assert.match(calls[0].system, /hannibal（ハンニバル）.*敗北.*内省.*方針転換条件/);
  assert.equal(JSON.parse(logs[0][1]).brief.version, 'council-v2');
  assert.match(calls[1].input, /final_debate.*確定0.*確定1.*確定2/);
  assert.match(calls[2].input, /後付けの教訓は使わない/);
  assert.doesNotMatch(calls[2].system, /価値がゼロ/);
  assert.equal(logs[0][0], 'editorial_council');
  assert.equal(JSON.parse(logs[0][1]).brief.debate.opinions.length, 3);
});

test('council: duplicate personas, missing objections and ungrounded quotes stop before generation', () => {
  for (const invalid of ['duplicate', 'missing', 'quote']) {
    const { ctx, calls, responses } = setup();
    const d = debate();
    if (invalid === 'duplicate') d.opinions[1].persona = 'rei';
    if (invalid === 'missing') d.opinions[1].challenge = '';
    responses.push(d, reflection([{ qi: 1, quote: '創作した事実', reason: '面白い', hiring_signal: '仕事の実像' }]));
    assert.throws(() => ctx.prepareEditorialCouncil('drafts', {}, 'generate', [{ qi: 1, answer: '本人の回答' }]), /生成を止めました/);
    assert.equal(calls.length, invalid === 'quote' ? 2 : 1);
  }
});

test('council: draft core must survive verbatim, with its uncertainty and correct source', () => {
  const { ctx, calls, qa, stock, responses } = setup();
  const quote = '完成より、まず壊れる条件を知りたい';
  qa.push({ session_id: 's', idx: 1, answer: quote + '。まだ試す前です。', theme: '試作', category: 'evergreen' });
  responses.push(debate(), reflection([{ qi: 1, quote, reason: '完成を急がない判断が固有', hiring_signal: '試験の判断基準' }]), [
    { qi: 1, core_quote: quote, text: '安全と品質を大事にします。' },
    { qi: 99, core_quote: quote, text: quote },
    { qi: 1, core_quote: quote, text: quote + '。まだ試す前です。' },
  ]);
  assert.equal(ctx.generateDraftsFromInterview('s').length, 1);
  assert.deepEqual(calls.map(c => c.kind), ['json', 'json', 'draft']);
  assert.ok(calls.every(c => c.purpose === 'generate'));
  assert.equal(stock[0].source_idx, '1');
  assert.equal(stock[0].text, quote + '。まだ試す前です。');
});

test('council: a long draft is rejected whole, never cut through its ending', () => {
  const { ctx, qa, stock, responses } = setup();
  qa.push({ session_id: 's', idx: 1, answer: 'まだ試す前です', theme: '試作', category: 'evergreen' });
  responses.push(debate(), reflection([{ qi: 1, quote: 'まだ試す前です', reason: '未実施の留保を守る', hiring_signal: '仕事の実像' }]),
    [{ qi: 1, core_quote: 'まだ試す前です', text: 'あ'.repeat(141) + 'まだ試す前です' }]);
  ctx.truncateForTweet = () => { throw new Error('must not truncate'); };
  assert.throws(() => ctx.generateDraftsFromInterview('s'), /有効な下書き/);
  assert.equal(stock.length, 0);
});

test('council: no material ends after reflection; question premises cannot become answer anchors', () => {
  const { ctx, qa, stock, calls, responses } = setup();
  qa.push({ session_id: 's', idx: 1, question: '架空の改善が成功した理由は？', answer: '特にない', theme: '試作', category: 'evergreen' });
  responses.push(debate(), { ...reflection(), no_material: true });
  assert.equal(ctx.generateDraftsFromInterview('s').length, 0);
  assert.equal(calls.length, 2);
  assert.equal(stock.length, 0);
  assert.doesNotMatch(calls[1].input, /架空の改善/);
});

test('council: turn uses new discussion and does not add both a followup and replacement question', () => {
  const { ctx, calls, responses } = setup();
  const current = { idx: 1, session_id: 's', question: '何を見直しました？', answer: '重量を見直した' };
  const next = { idx: 2, theme: '試作', question: '次に試すことは？' };
  responses.push(debate(), reflection(), { quote: '重量', followup: '見送った案は何でした？', next_question: '判断の理由は何ですか？' });
  const result = ctx.planInterviewTurn([current, next], current, current.answer, next, true, false);
  assert.equal(calls.length, 3);
  assert.equal(result.followup, '見送った案は何でした？');
  assert.equal(result.next_question, '');
});

test('council: a failed discussion does not silently fall back to generating an ordinary response', () => {
  const { ctx, calls, responses } = setup();
  responses.push(new Error('API unavailable'));
  const result = ctx.planInterviewTurn([], { question: '問い' }, '本人の回答', null, true, false);
  assert.equal(result.editorial_unavailable, true);
  assert.equal(calls.length, 1);
});

test('council: time budget is shared between meetings and checked before API and JSON retry', () => {
  const { ctx, calls, responses } = setup();
  let clock = 1000;
  ctx.Date = { now: () => clock };
  responses.push(debate(), reflection());
  ctx.prepareEditorialCouncil('turn', {}, 'interview');
  const deadline = ctx.EDITORIAL_EXECUTION_DEADLINE;
  clock += 185000;
  assert.throws(() => ctx.prepareEditorialCouncil('drafts', {}, 'generate'), /時間予算/);
  assert.equal(ctx.EDITORIAL_EXECUTION_DEADLINE, deadline);
  assert.equal(calls.length, 2);
  vm.runInContext(readFileSync(new URL('../gas/src/Claude.js', import.meta.url), 'utf8'), ctx);
  let network = 0;
  ctx.responseProviderFor = () => 'openai';
  ctx.openAIMessage = () => { network++; return '{}'; };
  assert.throws(() => ctx.askClaudeJson('', '', 1000, { purpose: 'interview' }), /時間予算/);
  try { ctx.assertEditorialExecutionBudget(); } catch (error) {
    assert.equal(error.llmNoRetry, true);
    assert.equal(ctx.isFatalError(error), false); // 新しいGAS実行での朝の再試行は許す。
  }
  assert.equal(network, 0);
});
