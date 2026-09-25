import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sources = ['Pure', 'Editorial', 'PostComposition', 'OutcomeQuality', 'Interview', 'Drafts', 'Quality'].map((name) => ({
  name,
  code: readFileSync(new URL(`../gas/src/${name}.js`, import.meta.url), 'utf8'),
}));

function answer(overrides = {}) {
  return {
    session_id: 'session-1', idx: 1, question: '何を変えた？',
    answer: '重量を3kg落とした', answered_at: '2026-09-10 09:00',
    theme: '設計', category: 'evergreen', media_url: '', media_type: '',
    ...overrides,
  };
}

function harness(interviews, response = []) {
  const state = { interviews, response, stock: [], prompts: [], logs: [], updates: [] };
  let id = 0;
  const context = {
    SHEET: { INTERVIEWS: 'Interviews', STOCK: 'Stock' },
    STATUS: { DRAFT: 'draft', STOCK: 'stock' },
    readTable: (sheet) => sheet === 'Interviews' ? state.interviews : state.stock,
    buildStylePrompt: () => '',
    // このファイルは保存・出典処理を検証。会議の実行と引用検証はgas-council.test.jsで検証する。
    prepareEditorialCouncil: () => ({ reflection: { no_material: false,
      anchors: Array.isArray(state.response) ? state.response.filter(d => d && d.text).map(d => ({ qi: d.qi, quote: d.text })) : [] } }),
    editorialCouncilInstructions: () => '',
    askClaudeJsonSalvageable: (system, user) => {
      state.prompts.push({ system, user });
      return Array.isArray(state.response) ? state.response.map(d => d && { ...d, core_quote: d.text }) : state.response;
    },
    assertEditorialExecutionBudget: () => {},
    councilText: (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max,
    askClaudeJson: (system, user) => {
      state.prompts.push({ system, user });
      return Array.isArray(state.response) ? state.response.map(d => d && ({ ...d, format: 'single', reason: '判断を短く伝える', tradeoff: '長文は不要', omitted: '', parts: [{ text: d.text, core_quote: d.text }] })) : state.response;
    },
    appendRowsObj: (_name, rows) => state.stock.push(...rows),
    newId: () => `draft-${++id}`,
    fmtDateTime: () => '2026-09-10 09:00',
    nowJst: () => new Date('2026-09-10T00:00:00Z'),
    appendRowObj: (sheet, row) => {
      assert.equal(sheet, 'Stock');
      state.stock.push(row);
    },
    syncStockRowToNotion: () => {},
    logEvent: (type, message) => state.logs.push({ type, message }),
    ensureHeaders: () => {},
    getProp: (key, fallback) => key === 'QUALITY_MODE' ? 'legacy' : fallback,
    parseAxes: () => null,
    updateStockById: (draftId, updates) => state.updates.push({ draftId, updates }),
  };
  vm.createContext(context);
  sources.forEach(({ name, code }) => vm.runInContext(code, context, { filename: `${name}.js` }));
  return { context, state };
}

test('drafts: テーマ・カテゴリ・画像はモデル出力でなく回答済みの出典行から保存する', () => {
  const { context, state } = harness([
    answer({ media_url: 'https://example.test/image', media_type: 'image/png' }),
  ], [{ qi: 1, text: '重量を3kg落とした', theme: '架空テーマ', category: 'news' }]);

  assert.equal(context.generateDraftsFromInterview('session-1').length, 1);
  assert.equal(state.stock[0].theme, '設計');
  assert.equal(state.stock[0].category, 'evergreen');
  assert.equal(state.stock[0].media_url, 'https://example.test/image');
  assert.equal(state.stock[0].media_type, 'image/png');
});

test('drafts: 未回答・スキップ・別セッション・不正qiの案は一括保存前に棄却する', () => {
  for (const qi of [2, 3, 4, 99, 'toString', undefined]) {
    const { context, state } = harness([
      answer(), answer({ idx: 2, answer: '', answered_at: '' }),
      answer({ idx: 3, answer: '残っていた文字', answered_at: 'skipped' }),
      answer({ idx: 4, session_id: 'session-2' }),
    ], [{ qi: 1, text: '重量を3kg落とした' }, { qi, text: '不正な出典' }]);
    assert.throws(() => context.generateDraftsFromInterview('session-1'), /不正/);
    assert.equal(state.stock.length, 0);
  }
});

test('drafts: 材料不足の空配列は正常終了しストックを増やさない', () => {
  const { context, state } = harness([answer({ answer: 'わからない' })], []);
  assert.equal(context.generateDraftsFromInterview('session-1').length, 0);
  assert.equal(state.stock.length, 0);
});

test('drafts: retired-topic-only output is no-material and preserves the original answer', () => {
  const original = answer({ answer: '堀江さんが来た', theme: '堀江さんの話' });
  const { context, state } = harness([original], [{ qi: 1, text: '堀江さんが来た' }]);
  assert.equal(context.generateDraftsFromInterview('session-1').length, 0);
  assert.equal(state.stock.length, 0);
  assert.equal(state.interviews[0].answer, '堀江さんが来た');
});

test('drafts: 不正案しかない出力は材料不足と区別してエラーにする', () => {
  const { context, state } = harness([answer()], [{ qi: 99, text: '不正な案' }]);
  assert.throws(() => context.generateDraftsFromInterview('session-1'), /不正/);
  assert.equal(state.stock.length, 0);

  state.response = { qi: 1, text: '配列でない' };
  assert.throws(() => context.generateDraftsFromInterview('session-1'), /出力が不正/);
});

test('drafts: 回答がないセッションはAPIを呼ばずエラーにする', () => {
  const { context, state } = harness([answer({ answer: '', answered_at: '' })]);
  assert.throws(() => context.generateDraftsFromInterview('session-1'), /回答がありません/);
  assert.equal(state.prompts.length, 0);
});

test('drafts: 本人の追問回答を実helper経由で渡し、スキップした追問は渡さない', () => {
  const followup = '部品を共通化して実測で3kg減った';
  const skipped = 'これは使わない補足';
  const { context, state } = harness([
    answer({
      followup_question: 'どう減らした？', followup_answer: followup,
      followup_answered_at: '2026-09-10 09:01',
    }),
    answer({
      idx: 2, followup_question: '別の追問', followup_answer: skipped,
      followup_answered_at: 'skipped',
    }),
  ]);

  context.generateDraftsFromInterview('session-1');
  assert.ok(state.prompts[0].user.includes(followup));
  assert.ok(!state.prompts[0].user.includes(skipped));
});

test('quality: リライトにも本人の追問原文を渡し、スキップと別セッションを除外する', () => {
  const followup = '部品を共通化して実測で3kg減った';
  const { context, state } = harness([
    answer({
      followup_question: 'どう減らした？', followup_answer: followup,
      followup_answered_at: '2026-09-10 09:01',
    }),
    answer({
      idx: 2, followup_question: '別の追問', followup_answer: 'スキップした補足原文',
      followup_answered_at: 'skipped',
    }),
    answer({ idx: 3, answer: 'スキップした回答原文', answered_at: 'skipped' }),
    answer({ session_id: 'session-2', answer: '別セッションの回答原文' }),
  ], [{ id: 'draft-1', skip: true }]);
  state.stock.push({
    id: 'draft-1', session_id: 'session-1', status: 'stock',
    text: '重量を3kg落とした', score: 65, score_reason: '具体が不足', refines: 0,
  });

  assert.equal(context.refineFailedDrafts(), 0);
  const prompt = state.prompts[0].user;
  assert.ok(prompt.includes(followup));
  assert.ok(!prompt.includes('スキップした補足原文'));
  assert.ok(!prompt.includes('スキップした回答原文'));
  assert.ok(!prompt.includes('別セッションの回答原文'));
  assert.equal(state.updates[0].updates.refines, 2);
});
