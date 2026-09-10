import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup() {
  const ctx = vm.createContext({});
  for (const file of ['Pure', 'OutcomeQuality', 'Interview', 'WebApp']) {
    vm.runInContext(readFileSync(new URL(`../gas/src/${file}.js`, import.meta.url), 'utf8'), ctx);
  }
  ctx.STATUS = { DRAFT: 'draft', STOCK: 'stock', READY: 'ready', APPROVED: 'approved', SCHEDULED: 'scheduled' };
  ctx.SHEET = { STOCK: 'Stock', INTERVIEWS: 'Interviews' };
  ctx.getProp = (key, fallback) => ({ WEBAPP_URL: 'https://example.test/admin', ADMIN_TOKEN: 'test-only' })[key] ?? fallback;
  return ctx;
}

function row(overrides = {}) {
  return { id: 'd', session_id: 's', status: 'stock', text: '試作の工夫を紹介します。', score: 45,
    score_version: 'outcome-v1', score_reason: '本人の回答との照合が必要',
    editorial_review: JSON.stringify({ fidelity: 'confirm', privacy: 'clear', focus: 'aligned', review_note: '' }), ...overrides };
}

test('review display: empty model explanation is identified as evaluator deficiency, not a request for more answers', () => {
  const ctx = setup();
  const original = row();
  const display = ctx.formatInterviewDraftReview(original, 2);
  assert.match(display, /下書き3｜保留/);
  assert.match(display, /試作の工夫を紹介/);
  assert.match(display, /具体的な確認箇所: AIが理由の詳細を返していません/);
  assert.match(display, /追加回答は不要/);
  assert.match(display, /参考評価: 45点/);
  assert.equal(original.status, 'stock');
  assert.equal(original.score_reason, '本人の回答との照合が必要');
});

test('review display: concrete notes and privacy concerns remain visible', () => {
  const ctx = setup();
  const display = ctx.outcomeReviewFeedback(row({ editorial_review: JSON.stringify({
    fidelity: 'supported', privacy: 'hold', focus: 'aligned', review_note: '公開範囲について本人の指定があります。'
  }) }));
  assert.match(display, /確認項目: 公開してよい情報か/);
  assert.match(display, /確認箇所: 公開範囲について本人の指定があります/);
  assert.doesNotMatch(display, /説明不足/);
});

test('review display: pending or malformed evaluations do not invent user-facing issues', () => {
  const ctx = setup();
  assert.match(ctx.outcomeReviewFeedback(row({ status: 'draft' })), /評価が未完了/);
  assert.match(ctx.outcomeReviewFeedback(row({ editorial_review: '{broken' })), /確認内容を読み取れません/);
  ctx.getProp = (_key, fallback) => fallback;
  assert.match(ctx.interviewDraftReviewLocation(), /普段お使いの管理画面/);
  assert.doesNotMatch(ctx.interviewDraftReviewLocation(), /undefined|token=/);
});

test('review display: actual completion with zero ready drafts includes numbered notes and the management location', () => {
  const ctx = setup();
  const stock = [row(), row({ id: 'd2' })];
  const before = JSON.stringify(stock);
  const messages = [];
  ctx.readTable = name => name === 'Stock' ? stock : [{ session_id: 's', answer: '本人の回答' }];
  ctx.updateRowsWhere = () => {};
  ctx.generateDraftsFromInterview = () => stock;
  ctx.runQualityGateWithRefinement = () => ({ scored: 2, passed: 0 });
  ctx.missingInfoHints = () => [];
  ctx.logEvent = () => {};
  ctx.sendSlack = (text, thread) => messages.push({ text, thread });
  ctx.finishInterview('s', 'thread');
  const result = messages.at(-1);
  assert.equal(result.thread, 'thread');
  assert.match(result.text, /下書き1｜保留/);
  assert.match(result.text, /下書き2｜保留/);
  assert.match(result.text, /確認・編集: https:\/\/example.test\/admin\?token=test-only/);
  assert.match(result.text, /管理画面の「保留」/);
  assert.doesNotMatch(result.text, /下書きの指摘を確認してください/);
  assert.equal(JSON.stringify(stock), before);
});

test('review display: management API shows the same missing-explanation message without updating stored reviews', () => {
  const ctx = setup();
  const original = row();
  ctx.assertAccess = () => {};
  ctx.readTable = () => [original];
  const response = JSON.parse(ctx.api_listPosts('test-only'));
  assert.match(response[0].score_reason, /評価側の説明不足/);
  assert.equal(original.score_reason, '本人の回答との照合が必要');
});
