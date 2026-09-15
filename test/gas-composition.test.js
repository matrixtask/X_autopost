import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const core = '完成より、まず壊れる条件を知りたい';
const other = '試験を見送る判断も仕事です';
const longText = core + '。' + 'まだ試す前なので、条件を一つずつ整理しています。'.repeat(12) + other + '。';
const answer = () => ({ session_id: 's', idx: 1, answer: longText, answered_at: 'now', theme: '試作', category: 'evergreen' });
const debate = () => ({ opinions: ['rei', 'sebastian', 'hannibal'].map((persona, i, names) => ({
  persona, proposal: '独立性を確認する', challenge_to: names[(i + 1) % 3], challenge: '留保を落とさない', final_position: '分割と一体の損失を比較する',
})), agreement: '原文を守る', disagreement: '分割する境界は本文で判断する' });
const reflection = () => ({ adopt: '試験前の留保を守る', reject: '一般論に薄めない', direction: '背景と判断をつなぐ',
  question_focus: '十分な回答がある', no_material: false, anchors: [{ qi: 1, quote: core, reason: '完成を急がない判断', hiring_signal: '現場の判断基準' }] });
const group = (format = 'long') => ({ qi: 1, format, reason: '背景と結論を一緒に読む必要がある', tradeoff: '短文では試験前の留保と理由が失われる', omitted: '',
  parts: format === 'split' ? [{ text: core + '。まだ試す前です。', core_quote: core }, { text: other + '。', core_quote: other }] : [{ text: longText, core_quote: core }] });
const composition = () => ({ opinions: ['rei', 'sebastian', 'hannibal'].map(persona => ({ persona, verdict: 'pass', reason: '本人の留保と具体的な判断が本文に残っている' })),
  mia: { persona: 'mia', verdict: 'pass', reason: '冒頭で示した判断の理由が結末で回収されている' } });
function review(text = longText, comp = composition()) {
  return { axes: Array.from({ length: 5 }, () => [2, text.slice(0, 10)]), fidelity: 'supported', privacy: 'clear', focus: 'aligned',
    review_note: '', issues: [], composition: comp };
}
function setup(properties = {}) {
  const db = { Stock: [], Interviews: [answer()] }, calls = [], requests = [], logs = [];
  let id = 0;
  const ctx = vm.createContext({ console, Date });
  for (const file of ['Pure', 'Config', 'Editorial', 'EditorialCouncil', 'PostComposition', 'Interview', 'Drafts', 'OutcomeQuality', 'Quality', 'WebApp', 'Scheduler', 'XApi', 'Notion', 'Rewrite']) {
    vm.runInContext(readFileSync(new URL(`../gas/src/${file}.js`, import.meta.url), 'utf8'), ctx);
  }
  Object.assign(ctx, {
    getProp: (key, fallback) => properties[key] ?? fallback,
    readTable: name => structuredClone(db[name] || []),
    appendRowsObj: (name, rows) => { calls.push(['save', rows.length]); db[name].push(...structuredClone(rows)); },
    updateStockById: (key, values) => Object.assign(db.Stock.find(row => row.id === key), structuredClone(values)),
    buildStylePrompt: () => '本人の声を守る', ensureHeaders: () => {}, syncStockRowToNotion: () => {}, syncSafe: () => {},
    nowJst: () => new Date('2026-09-12T00:00:00Z'), fmtDateTime: () => '2026-09-12 09:00',
    newId: prefix => prefix + (++id), logEvent: (...args) => logs.push(args), notifySlack: () => {}, assertAccess: () => {},
    claudeModelFor: () => 'test', claudeEffortFor: () => '',
    askClaudeJson: (system, input, tokens, opts) => { calls.push({ system, input, tokens, opts }); return structuredClone(requests.shift()); },
    askClaudeJsonSalvageable: (_system, input) => Object.fromEntries(JSON.parse(input.split('\nJSON')[0]).map(r => [r.id, review(r.text)])),
  });
  return { ctx, db, calls, requests, logs };
}
function generate(h, format = 'long') {
  h.requests.push(debate(), reflection(), [group(format)]);
  return h.ctx.generateDraftsFromInterview('s');
}

function contextFixture() {
  const h = setup();
  const quote = '条件が揃うまで待ちます。';
  const question = '試験を実施するか迷ったとき、どう判断しますか？';
  h.db.Interviews = [{ ...answer(), question, answer: quote }];
  const g = { qi: 1, source_qis: [1], format: 'single', reason: '質問から試験という対象を補えば判断が伝わる', tradeoff: '回答だけでは何を待つか分からない', omitted: '',
    parts: [{ text: '試験を実施するか迷ったら、' + quote, core_quote: quote, evidence: [{ qi: 1, quote }],
      question_context: [{ qi: 1, field: 'question', quote: '試験を実施するか', answer_quote: quote, text: '試験を実施するか', use: 'topic', reason: '本人が答えている問いの対象を明示する' }] }] };
  const r = reflection(); r.anchors[0].quote = quote;
  return { h, g, r, quote, question };
}

function mergeFixture() {
  const h = setup();
  const first = '条件が揃うまで待ちます。' + '予定を優先して条件を曖昧にすると、試験した意味がなくなる。'.repeat(3);
  const second = '記録がない試験は次に使えません。' + '条件と結果を残して、次に何を変えるか判断できるようにしたい。'.repeat(3);
  h.db.Interviews = [{ ...answer(), answer: first, question: '試験する条件は？' },
    { ...answer(), idx: 2, answer: second, question: '試験結果をどう使う？' }];
  const quote = '条件が揃うまで待ちます。';
  const g = { qi: 1, source_qis: [1, 2], format: 'long', reason: '試験の開始条件と結果を次へ生かす理由は同じ判断として読める', tradeoff: '別々だと待つ理由が見えない', omitted: '',
    parts: [{ text: first + '\n\n' + second, core_quote: quote,
      evidence: [{ qi: 1, quote }, { qi: 2, quote: '記録がない試験は次に使えません。' }], question_context: [] }] };
  const r = reflection(); r.anchors[0].quote = quote;
  return { h, g, r, first, second };
}

test('short answers receive question context before being skipped, and the context reaches all reviewers', () => {
  const { h, g, r, quote, question } = contextFixture();
  h.requests.push(debate(), r, [g]);
  h.ctx.generateDraftsFromInterview('s');
  assert.equal(h.db.Stock[0].text, g.parts[0].text);
  assert.equal(h.db.Stock[0].post_format, 'single');
  assert.equal(JSON.parse(h.calls[2].input.split('\nJSON')[0]).answers[0].question, question);
  assert.match(h.calls[1].system, /文脈不足だけで見送らない/);
  const meta = JSON.parse(h.db.Stock[0].edit_meta);
  assert.equal(meta.question_context[0].answer_quote, quote);
  h.ctx.askClaudeJsonSalvageable = (system, input) => {
    const [data] = JSON.parse(input.split('\nJSON')[0]);
    assert.equal(data.question_contexts[0].question, question);
    assert.ok(data.source.includes(quote));
    assert.ok(!data.source.includes(question));
    assert.match(system, /質問だけにある成果・数字/);
    return { [data.id]: review(data.text) };
  };
  assert.equal(h.ctx.runOutcomeQualityGate().passed, 1);
  assert.equal(h.db.Stock[0].status, 'ready');
});

test('several individually short answers can become one long post with every source retained for review', () => {
  const { h, g, r, first, second } = mergeFixture();
  assert.ok(h.ctx.fitsInTweet(first)); assert.ok(h.ctx.fitsInTweet(second));
  h.requests.push(debate(), r, [g]); h.ctx.generateDraftsFromInterview('s');
  const row = h.db.Stock[0], meta = JSON.parse(row.edit_meta);
  assert.equal(row.post_format, 'long'); assert.equal(row.source_idx, '1');
  assert.deepEqual(meta.source_qis, ['1', '2']); assert.equal(meta.evidence.length, 2);
  h.ctx.askClaudeJsonSalvageable = (_system, input) => {
    const [data] = JSON.parse(input.split('\nJSON')[0]);
    assert.ok(data.source.includes(first)); assert.ok(data.source.includes(second));
    assert.deepEqual(data.edit.source_qis, ['1', '2']);
    return { [data.id]: review(data.text) };
  };
  assert.equal(h.ctx.runOutcomeQualityGate().passed, 1);
});

test('a merged answer that fits a short post is not padded to force the long format', () => {
  const { h, g, r } = mergeFixture();
  h.db.Interviews[0].answer = '条件が揃うまで待ちます。';
  h.db.Interviews[1].answer = '記録がない試験は次に使えません。';
  g.format = 'single'; g.parts[0].text = h.db.Interviews.map(a => a.answer).join('');
  h.requests.push(debate(), r, [g]); h.ctx.generateDraftsFromInterview('s');
  assert.equal(h.db.Stock[0].post_format, 'single');
  assert.ok(h.ctx.outcomeSourceForRow(h.db.Stock[0], h.db.Interviews).includes(h.db.Interviews[1].answer));
});

test('old single-source composition-v1 stock still resolves without new metadata fields', () => {
  const h = setup();
  const row = { session_id: 's', source_idx: '1', edit_meta: JSON.stringify({ version: 'composition-v1', core_quote: core }) };
  assert.equal(h.ctx.outcomeSourceForRow(row, h.db.Interviews), longText);
  assert.equal(h.ctx.outcomeQuestionContexts(row, h.db.Interviews).length, 0);
});

test('merging rejects unknown, duplicate, cross-session, reused or uncited answers before saving any post', () => {
  for (const mutate of [
    ({ g }) => { g.source_qis = [1, 99]; },
    ({ g }) => { g.source_qis = [1, 1]; },
    ({ h }) => { h.db.Interviews[1].session_id = 'another-session'; },
    ({ h }) => { h.db.Interviews[1].answered_at = 'skipped'; },
    ({ g }) => { g.parts[0].evidence.pop(); },
    ({ g }) => { g.parts[0].evidence[1].quote = '本人が言っていない理由'; },
    ({ g }) => { g.format = 'single'; },
  ]) {
    const f = mergeFixture(); mutate(f); f.h.requests.push(debate(), f.r, [f.g]);
    assert.throws(() => f.h.ctx.generateDraftsFromInterview('s'), /不正/);
    assert.equal(f.h.db.Stock.length, 0);
  }
  const f = mergeFixture(); f.h.requests.push(debate(), f.r, [f.g, f.g]);
  assert.throws(() => f.h.ctx.generateDraftsFromInterview('s'), /重複/);
  assert.equal(f.h.db.Stock.length, 0);
});

test('context must cite the actual question and corresponding answer, never invent or use skipped followups', () => {
  for (const mutate of [
    c => { c.qi = 99; }, c => { c.quote = '存在しない質問'; }, c => { c.answer_quote = '同意していない'; },
    c => { c.text = '本文にない文脈'; }, c => { c.use = 'fact'; }, c => { c.field = 'followup_question'; },
  ]) {
    const { h, g, r } = contextFixture(); mutate(g.parts[0].question_context[0]);
    h.requests.push(debate(), r, [g]);
    assert.throws(() => h.ctx.generateDraftsFromInterview('s'), /文脈引用/);
    assert.equal(h.db.Stock.length, 0);
  }
});

test('unsupported question premises still hold a draft even when the composition review passes', () => {
  const { h, g, r } = contextFixture();
  h.requests.push(debate(), r, [g]); h.ctx.generateDraftsFromInterview('s');
  h.db.Stock[0].text += '。性能が30%改善しました。';
  h.ctx.askClaudeJsonSalvageable = (_system, input) => {
    const [data] = JSON.parse(input.split('\nJSON')[0]);
    return { [data.id]: { ...review(data.text), fidelity: 'confirm', issues: [{ kind: 'fidelity', quote: '性能が30%改善しました。',
      reason: '本人の回答には性能改善の数値も実績もありません', action: '本人が述べていない数値と実績を削除する' }] } };
  };
  h.ctx.runOutcomeQualityGate(); assert.equal(h.db.Stock[0].status, 'stock');
  assert.match(h.db.Stock[0].score_reason, /数値/);
});

test('review cannot pass on only the primary answer if another source disappears, and rejects stale source reviews', () => {
  const { h, g, r } = mergeFixture();
  h.requests.push(debate(), r, [g]); h.ctx.generateDraftsFromInterview('s');
  h.ctx.askClaudeJsonSalvageable = (_system, input) => {
    const [data] = JSON.parse(input.split('\nJSON')[0]);
    h.db.Interviews[1].answer += '訂正しました。';
    return { [data.id]: review(data.text) };
  };
  h.ctx.runOutcomeQualityGate(); assert.equal(h.db.Stock[0].status, 'draft');
  h.db.Interviews.pop();
  assert.equal(h.ctx.outcomeSourceForRow(h.db.Stock[0], h.db.Interviews), '');
  h.ctx.askClaudeJsonSalvageable = (_system, input) => {
    const [data] = JSON.parse(input.split('\nJSON')[0]); return { [data.id]: review(data.text) };
  };
  h.ctx.runOutcomeQualityGate(); assert.equal(h.db.Stock[0].status, 'stock');
});

test('a question edited during review invalidates that review even when its cited substring survives', () => {
  const { h, g, r } = contextFixture();
  h.requests.push(debate(), r, [g]); h.ctx.generateDraftsFromInterview('s');
  h.ctx.askClaudeJsonSalvageable = (_system, input) => {
    const [data] = JSON.parse(input.split('\nJSON')[0]); h.db.Interviews[0].question += '別の対象です。';
    return { [data.id]: review(data.text) };
  };
  h.ctx.runOutcomeQualityGate(); assert.equal(h.db.Stock[0].status, 'draft');
});

test('question context counts toward the review source budget and is not silently truncated', () => {
  const { h, g, r } = contextFixture();
  h.requests.push(debate(), r, [g]); h.ctx.generateDraftsFromInterview('s');
  h.db.Interviews[0].question += 'あ'.repeat(12000);
  h.ctx.askClaudeJsonSalvageable = (_system, input) => {
    const [data] = JSON.parse(input.split('\nJSON')[0]);
    assert.equal(data.source, ''); assert.deepEqual(data.question_contexts, []);
    return { [data.id]: review(data.text) };
  };
  h.ctx.runOutcomeQualityGate(); assert.equal(h.db.Stock[0].status, 'stock');
});

test('long answer runs the council, Mia and Rina, then stores the complete long post and editorial choice', () => {
  const h = setup();
  assert.equal(generate(h).length, 1);
  assert.match(h.calls[2].system, /リナ.*架空の長文編集者/);
  assert.match(h.calls[2].system, /split:.*単独で読める/);
  assert.ok(h.calls.slice(0, 3).every(c => c.opts.purpose === 'generate'));
  assert.equal(h.db.Stock[0].text, longText);
  assert.equal(h.db.Stock[0].post_format, 'long');
  assert.equal(h.db.Stock[0].source_idx, '1');
  assert.equal(h.db.Stock[0].status, 'draft');
  assert.equal(JSON.parse(h.db.Stock[0].edit_meta).editor, 'rina');
  assert.match(h.db.Stock[0].edit_reason, /他の形式との比較/);
  assert.deepEqual(h.calls[3], ['save', 1]);
});

test('split posts share provenance and group identity but remain separate approval and scheduling units', () => {
  const h = setup(); generate(h, 'split');
  const [a, b] = h.db.Stock;
  assert.equal(a.edit_group, b.edit_group); assert.notEqual(a.id, b.id);
  assert.equal(a.part_count, '2'); assert.equal(b.part_index, '2');
  assert.equal(a.source_idx, b.source_idx); assert.ok(h.ctx.fitsStockText(a)); assert.ok(h.ctx.fitsStockText(b));
  assert.deepEqual(h.calls[3], ['save', 2]);
  a.status = 'approved';
  assert.equal(h.ctx.scheduleApprovedPosts().length, 1);
  assert.equal(b.status, 'draft');
});

test('a long answer can produce a single short post when the editorial choice supports it', () => {
  const h = setup(); const g = group('single'); g.parts[0].text = core + '。';
  h.requests.push(debate(), reflection(), [g]);
  h.ctx.generateDraftsFromInterview('s');
  assert.equal(h.db.Stock[0].post_format, 'single');
});

test('invalid source, missing core, duplicate claims, wrong counts and overlong parts save nothing', () => {
  for (const mutate of [
    g => { g.qi = 99; }, g => { g.reason = ''; }, g => { g.parts[0].core_quote = '本人は言っていない'; },
    g => { g.parts[1].text = g.parts[0].text; g.parts[1].core_quote = core; },
    g => { g.parts.pop(); }, g => { g.parts[1].text = other + 'あ'.repeat(141); },
    g => { g.parts[0].text = '違う核'; g.parts[0].core_quote = '違う核'; },
  ]) {
    const h = setup(), g = group('split'); mutate(g);
    h.requests.push(debate(), reflection(), [g]);
    assert.throws(() => h.ctx.generateDraftsFromInterview('s'), /不正|核/);
    assert.equal(h.db.Stock.length, 0);
  }
});

test('truncated JSON is never partially salvaged into a split series; a repeated generation does not duplicate stock', () => {
  const h = setup(); h.requests.push(debate(), reflection(), { parts: 'incomplete' });
  assert.throws(() => h.ctx.generateDraftsFromInterview('s'), /出力が不正/); assert.equal(h.db.Stock.length, 0);
  generate(h, 'split'); const ids = h.db.Stock.map(r => r.id);
  generate(h, 'split'); assert.deepEqual(h.db.Stock.map(r => r.id), ids);
});

test('long limits count whole Unicode characters while legacy and split posts retain the weighted limit', () => {
  const { ctx } = setup();
  assert.equal(ctx.fitsStockText({ post_format: 'long', text: '😀'.repeat(4000) }), true);
  assert.equal(ctx.fitsStockText({ post_format: 'long', text: '😀'.repeat(4001) }), false);
  assert.equal(ctx.fitsStockText({ text: longText }), false);
  assert.equal(ctx.fitsStockText({ post_format: 'split', text: longText }), false);
  assert.equal(ctx.fitsStockText({ post_format: 'unknown', text: '短文' }), false);
});

test('full text and sibling context reach independent post-edit review and a pass still needs human approval', () => {
  const h = setup({ AUTO_APPROVE: 'true' }); generate(h, 'split');
  h.ctx.askClaudeJsonSalvageable = (system, input) => {
    assert.match(system, /レイ\(rei\).*セバスチャン\(sebastian\).*ハンニバル\(hannibal\)/);
    const [data] = JSON.parse(input.split('\nJSON')[0]); assert.equal(data.siblings.length, 2);
    assert.ok(data.source.includes(longText)); assert.match(data.edit.reason, /他の形式/);
    return { [data.id]: review(data.text) };
  };
  const result = h.ctx.runOutcomeQualityGate();
  assert.equal(result.passed, 2); assert.ok(h.db.Stock.every(r => r.status === 'ready'));
  assert.ok(h.db.Stock.every(r => JSON.parse(r.edit_review).opinions.length === 3));
});

test('post-edit reviewer omissions and fabricated issue quotes remain unscored; one real objection holds the draft', () => {
  for (const kind of ['missing', 'duplicate', 'fabricated', 'objection']) {
    const h = setup(); generate(h);
    h.ctx.askClaudeJsonSalvageable = () => {
      const c = composition();
      if (kind === 'missing') c.opinions.pop();
      if (kind === 'duplicate') c.opinions[1].persona = 'rei';
      if (kind === 'fabricated' || kind === 'objection') Object.assign(c.opinions[0], {
        verdict: 'revise', quote: kind === 'objection' ? core : '存在しない引用', reason: '冒頭にある試験前の留保が不明瞭です', action: '冒頭にも未実施の留保を戻してください',
      });
      return { [h.db.Stock[0].id]: review(longText, c) };
    };
    h.ctx.runOutcomeQualityGate();
    assert.equal(h.db.Stock[0].status, kind === 'objection' ? 'stock' : 'draft');
    assert.equal(h.db.Stock[0].text, longText);
    if (kind === 'objection') assert.match(h.ctx.outcomeReviewFeedback(h.db.Stock[0]), /留保を戻して/);
  }
});

test('an edit while the model reviews a sibling prevents stale review from being saved', () => {
  const h = setup(); generate(h, 'split');
  h.ctx.askClaudeJsonSalvageable = (_system, input) => {
    const [data] = JSON.parse(input.split('\nJSON')[0]);
    h.db.Stock[1].text += '変更';
    return { [data.id]: review(data.text) };
  };
  h.ctx.runOutcomeQualityGate(); assert.ok(h.db.Stock.every(r => r.status === 'draft'));
});

test('editing a scheduled long post keeps the full ending and revokes prior approval and review', () => {
  const h = setup(); generate(h); const row = h.db.Stock[0];
  Object.assign(row, { status: 'scheduled', scheduled_at: '2026-09-13 10:00', edit_review: 'old', outcome_text: longText });
  h.ctx.runQualityGate = () => { throw new Error('defer'); };
  h.ctx.api_updateText('', row.id, longText + '\n結論もまだ仮説です。');
  assert.match(row.text, /結論もまだ仮説です。$/); assert.equal(row.status, 'draft');
  assert.equal(row.scheduled_at, ''); assert.equal(row.edit_review, ''); assert.equal(row.outcome_text, '');
  assert.throws(() => h.ctx.api_updateText('', row.id, '長'.repeat(4001)), /長すぎます/);
});

test('management and Notion receive complete text; Slack clearly labels its preview', () => {
  const h = setup(); generate(h); const row = h.db.Stock[0]; row.text = '😀'.repeat(2000) + '\n最後の留保';
  const [view] = JSON.parse(h.ctx.api_listPosts(''));
  assert.equal(view.text, row.text); assert.equal(view.format_label, '長文1本'); assert.ok(view.edit_reason);
  const chunks = h.ctx.buildNotionProperties(row).Body.rich_text;
  assert.equal(chunks.map(r => r.text.content).join(''), row.text);
  assert.ok(chunks.every(r => r.text.content.length <= 1900 && !/[\uD800-\uDBFF]$/.test(r.text.content)));
  assert.match(h.ctx.formatInterviewDraftReview(row, 0), /プレビュー。全文は管理画面/);
});

test('legacy scoring and short-only rewriting cannot truncate or auto-approve composed posts', () => {
  const h = setup({ QUALITY_MODE: 'legacy', AUTO_APPROVE: 'true' }); generate(h);
  assert.equal(h.ctx.runQualityGate().passed, 1); assert.equal(h.db.Stock[0].status, 'ready');
  assert.match(h.ctx.rewriteUnpostedDrafts(), /対象がありません/);
  h.db.Stock[0].status = 'stock'; assert.equal(h.ctx.refineFailedDrafts(true), 0);
  assert.equal(h.db.Stock[0].text, longText);
});

test('a long post follows scheduling and posts the complete text; capability disable holds it intact', () => {
  for (const enabled of ['true', 'false']) {
    const h = setup({ X_LONG_POSTS_ENABLED: enabled }); generate(h); const row = h.db.Stock[0]; row.status = 'approved';
    assert.equal(h.ctx.scheduleApprovedPosts().length, enabled === 'true' ? 1 : 0);
    Object.assign(row, { status: 'scheduled', scheduled_at: '2026-09-12 08:00' });
    h.ctx.isDryRun = () => false; let body;
    h.ctx.oauth1Header = () => 'test';
    h.ctx.UrlFetchApp = { fetch: (_url, options) => { body = JSON.parse(options.payload); return { getResponseCode: () => 201, getContentText: () => '{"data":{"id":"123","text":"server response"}}' }; } };
    h.ctx.postTick();
    if (enabled === 'true') { assert.equal(body.text, longText); assert.equal(row.tweet_id, '123'); assert.equal(row.status, 'posted'); }
    else { assert.equal(body, undefined); assert.equal(row.status, 'approved'); assert.equal(row.text, longText); }
  }
});

test('an API rejection never falls back to a shortened post and keeps the original stock text', () => {
  const h = setup(); generate(h); const row = h.db.Stock[0]; Object.assign(row, { status: 'scheduled', scheduled_at: '2026-09-12 08:00' });
  h.ctx.isDryRun = () => false; h.ctx.oauth1Header = () => 'test'; let requests = 0;
  h.ctx.UrlFetchApp = { fetch: () => { requests++; return { getResponseCode: () => 403, getContentText: () => 'not eligible' }; } };
  h.ctx.postTick(); assert.equal(requests, 1); assert.equal(row.status, 'failed'); assert.equal(row.text, longText);
});

test('long review notifications keep every card and the management link within bounded Slack messages', () => {
  const { ctx } = setup(), sent = [];
  ctx.sendSlack = (text, thread) => sent.push({ text, thread });
  const lines = Array.from({ length: 8 }, (_, i) => '下書き' + i + '\n' + '😀'.repeat(4000));
  ctx.sendInterviewDraftMessages('8件の編集案', lines, '管理画面: https://example.test', '123.456');
  assert.ok(sent.length > 1); assert.ok(sent.every(r => r.text.length <= 10000 && r.thread === '123.456'));
  for (const line of lines) assert.ok(sent.some(r => r.text.includes(line)));
  assert.ok(sent.at(-1).text.endsWith('管理画面: https://example.test'));
});

test('exhausted generation budget stops before editing and never saves partial work', () => {
  const h = setup(); h.ctx.EDITORIAL_EXECUTION_DEADLINE = Date.now() + 100;
  assert.throws(() => generate(h), /時間予算/); assert.equal(h.db.Stock.length, 0); assert.equal(h.calls.length, 0);
});
