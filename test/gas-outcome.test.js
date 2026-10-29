import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup(props = {}) {
  const db = { Stock: [], Interviews: [], Themes: [] };
  const logs = [];
  const ctx = vm.createContext({ console, Date, Set,
    getProp: (k, fallback) => props[k] ?? fallback,
    readTable: (name) => structuredClone(db[name] || []),
    ensureHeaders: () => {},
    appendRowsObj: (name, rows) => db[name].push(...structuredClone(rows)),
    appendRowObj: (name, row) => db[name].push(structuredClone(row)),
    updateRowsWhere: (name, key, value, updates) => db[name].filter(r => r[key] === value).forEach(r => Object.assign(r, updates)),
    updateStockById: (id, updates) => Object.assign(db.Stock.find(r => r.id === id), structuredClone(updates)),
    syncStockRowToNotion: () => {},
    logEvent: (...args) => logs.push(args),
    notifySlack: () => { throw new Error('no outbound messages in this test'); },
  });
  for (const file of ['Pure', 'Config', 'Editorial', 'OutcomeQuality', 'Themes', 'Quality', 'Metrics', 'Interview', 'OpenAI']) {
    vm.runInContext(readFileSync(new URL(`../gas/src/${file}.js`, import.meta.url), 'utf8'), ctx);
  }
  ctx.nowJst = () => new Date('2026-09-10T00:00:00Z');
  ctx.getProp = (k, fallback) => props[k] ?? fallback;
  ctx.claudeModelFor = () => 'test-model';
  ctx.claudeEffortFor = () => '';
  ctx.fmtDate = () => '2026-09-10';
  ctx.fmtDateTime = () => '2026-09-10 09:00';
  return { ctx, db, logs };
}

function review(ctx, score = 2, overrides = {}) {
  return { axes: Object.fromEntries(Array.from(ctx.OUTCOME_AXES, a => [a.key, { score, evidence: '自分で確認' }])),
    fidelity: 'supported', privacy: 'clear', focus: 'aligned', review_note: '', ...overrides };
}

test('review citations restore omitted line breaks only when the matching body span is unique and bounded', () => {
  const { ctx } = setup();
  assert.equal(ctx.restoreReviewQuoteLinebreaks('自分で確認した。次に進む。', '自分で確認した。\n次に進む。'), '自分で確認した。\n次に進む。');
  assert.equal(ctx.restoreReviewQuoteLinebreaks('違う話', '自分で確認した。\n次に進む。'), '違う話');
  assert.equal(ctx.restoreReviewQuoteLinebreaks('AB', 'A B'), 'AB');
  assert.equal(ctx.restoreReviewQuoteLinebreaks('AB', 'A\nB A\nB'), 'AB');
  assert.equal(ctx.restoreReviewQuoteLinebreaks('あ'.repeat(80), 'あ'.repeat(40) + '\n' + 'あ'.repeat(40)), 'あ'.repeat(80));
  const value = { axes: [[2, '自分で確認した。次に進む。']], issues: [{quote:'自分で確認した。次に進む。'}],
    composition: {opinions: [{quote:'自分で確認した。次に進む。'}], mia: {quote:'自分で確認した。次に進む。'}} };
  ctx.normalizeOutcomeQuoteLinebreaks(value, '自分で確認した。\n次に進む。');
  assert.equal(value.axes[0][1], '自分で確認した。\n次に進む。');
  assert.equal(value.issues[0].quote, value.axes[0][1]);
  assert.equal(value.composition.opinions[0].quote, value.axes[0][1]);
  assert.equal(value.composition.mia.quote, value.axes[0][1]);
});

test('outcome: a low reference score goes to human approval, never auto-approved or rewritten', () => {
  const { ctx, db } = setup({ AUTO_APPROVE: 'true' });
  db.Interviews.push({ session_id: 's', idx: 2, theme: '試作', answer: '自分で確認した', answered_at: 'now' });
  db.Stock.push({ id: 'd', session_id: 's', source_idx: '2', theme: '試作', text: '自分で確認した', status: 'draft', axes: 'old' });
  let calls = 0;
  ctx.askClaudeJsonSalvageable = (system, input, tokens, opts) => {
    calls++;
    assert.equal(opts.purpose, 'score');
    assert.match(input, /自分で確認した/);
    assert.doesNotMatch(input, /impressions|profile_clicks/);
    return { d: review(ctx, 1) };
  };
  ctx.refineFailedDrafts = () => { throw new Error('must not rewrite for score'); };
  const result = ctx.runQualityGateWithRefinement();
  assert.equal(result.passed, 1);
  assert.equal(db.Stock[0].score, 25);
  assert.equal(db.Stock[0].status, 'ready');
  assert.equal(JSON.parse(db.Stock[0].editorial_review).scorer, 'openai/gpt-6-luna/medium');
  assert.equal(db.Stock[0].axes, '');
  assert.equal(db.Stock[0].score_version, 'outcome-v1');
  assert.equal(calls, 1);
});

test('outcome: named axis pairs preserve scores and strict source checks across supported representations', () => {
  const { ctx } = setup(), value = review(ctx), text = '自分で確認した。\n次に進む。';
  const expected = ctx.validateOutcomeReview(value, text);
  value.axes = Object.fromEntries(Object.entries(value.axes).reverse().map(([key, a]) => [key, [a.score, a.evidence]]));
  assert.deepEqual(ctx.validateOutcomeReview(value, text), expected);
  value.axes.clarity = [2, '自分で確認した。次に進む。'];
  ctx.normalizeOutcomeQuoteLinebreaks(value, text);
  assert.equal(value.axes.clarity[1], text);
  assert.ok(ctx.validateOutcomeReview(value, text));
  for (const bad of [[2], [2, '自分で確認', 'extra'], ['2', '自分で確認'], [null, '自分で確認'],
    [5, '自分で確認'], [1.5, '自分で確認'], [2, '存在しない引用'], [2, '']]) {
    assert.equal(ctx.validateOutcomeReview({ ...value, axes: { ...value.axes, relevance: bad } }, text), null);
  }
  const missing = structuredClone(value); delete missing.axes.follow;
  assert.equal(ctx.validateOutcomeReview(missing, text), null);
});

test('outcome: named pairs do not turn a valid hold into a retry or approval', () => {
  const { ctx, db, logs } = setup();
  db.Stock.push({ id: 'd', session_id: 's', source_idx: '1', text: '自分で確認した', status: 'draft' });
  db.Interviews.push({ session_id: 's', idx: 1, answer: '自分で確認した' });
  const value = review(ctx, 2, { fidelity: 'confirm', issues: [{ kind: 'fidelity', quote: '自分で確認',
    reason: '本人の説明との関係を再確認する必要がある。', action: 'この表現の意味を確認する。' }] });
  value.axes = Object.fromEntries(Object.entries(value.axes).map(([key, a]) => [key, [a.score, a.evidence]]));
  let calls = 0;
  ctx.askClaudeJsonSalvageable = () => { calls++; return { d: value }; };
  ctx.runOutcomeQualityGate();
  assert.equal(calls, 1); assert.equal(db.Stock[0].status, 'stock'); assert.equal(db.Stock[0].score, 50);
  assert.equal(JSON.parse(db.Stock[0].editorial_review).fidelity, 'confirm');
  assert.equal(logs.some(r => r[0] === 'outcome_review_retry' || r[0] === 'outcome_invalid'), false);
});

test('outcome: a model or effort change during scoring cannot label the result as the new scorer', () => {
  const properties = { OPENAI_MODEL_SCORE: 'first-model' };
  const { ctx, db } = setup(properties);
  db.Interviews.push({ session_id: 's', idx: 1, theme: '試作', answer: '自分で確認した', answered_at: 'now' });
  db.Stock.push({ id: 'd', session_id: 's', source_idx: '1', theme: '試作', text: '自分で確認した', status: 'draft' });
  ctx.askClaudeJsonSalvageable = () => {
    properties.OPENAI_MODEL_SCORE = 'second-model';
    return { d: review(ctx, 2) };
  };
  ctx.runOutcomeQualityGate();
  assert.equal(db.Stock[0].status, 'draft');
  assert.equal(db.Stock[0].editorial_review, undefined);
});

test('outcome: missing source, privacy and retired topic cannot be compensated by high scores', () => {
  const { ctx, db } = setup();
  const texts = ['自分で確認した', '自分で確認した非公開の件', '堀江さんと自分で確認した'];
  db.Stock.push(...texts.map((text, i) => ({ id: String(i), theme: '試作', session_id: 's', source_idx: i ? '1' : '99', text, status: 'draft' })));
  db.Interviews.push({ session_id: 's', idx: 1, theme: '試作', answer: texts.join('。'), answered_at: 'now' });
  ctx.askClaudeJsonSalvageable = () => ({ 0: review(ctx, 4), 1: review(ctx, 4, { privacy: 'hold', issues: [
    { kind: 'privacy', quote: '非公開の件', reason: '本人が非公開と指定した情報を含むため。', action: '非公開の箇所を削除する。' }
  ] }), 2: review(ctx, 4) });
  assert.equal(ctx.runQualityGate().passed, 0);
  assert.ok(db.Stock.every(r => r.status === 'stock'));
  assert.match(db.Stock[0].score_reason, /照合が必要/);
  assert.match(db.Stock[1].score_reason, /公開してよい/);
  assert.match(db.Stock[2].score_reason, /中心のテーマ/);
  assert.ok(db.Stock.every(r => JSON.parse(r.editorial_review).review_note.length > 0));
});

test('outcome: unexplained holds are retried and a supported answer is released for human approval', () => {
  const { ctx, db, logs } = setup();
  db.Stock.push({ id: 'd', session_id: 's', source_idx: '1', text: '自分で確認した', status: 'draft' });
  db.Interviews.push({ session_id: 's', idx: 1, answer: '自分で確認した' });
  let calls = 0;
  ctx.askClaudeJsonSalvageable = (_system, input) => {
    calls++;
    if (calls === 2) assert.match(input, /前回の評価は形式または引用の検証に失敗/);
    return { d: review(ctx, 2, { fidelity: calls === 1 ? 'confirm' : 'supported' }) };
  };
  assert.equal(ctx.runOutcomeQualityGate().passed, 1);
  assert.equal(calls, 2);
  assert.equal(db.Stock[0].status, 'ready');
  assert.equal(JSON.parse(db.Stock[0].editorial_review).review_note, '');
  assert.ok(logs.some(([kind, detail]) => kind === 'outcome_sources' && detail.includes('source_chars')));
});

test('outcome: repeated missing explanations stay unscored, not a completed user-facing hold', () => {
  const { ctx, db } = setup();
  db.Stock.push({ id: 'd', text: '自分で確認した', status: 'draft' });
  let calls = 0;
  ctx.askClaudeJsonSalvageable = () => { calls++; return { d: review(ctx, 2, { fidelity: 'confirm' }) }; };
  assert.equal(ctx.runOutcomeQualityGate().scored, 0);
  assert.equal(calls, 2);
  assert.equal(db.Stock[0].status, 'draft');
  assert.equal(db.Stock[0].editorial_review, '');
});

test('outcome: every hold needs a real quoted passage, reason and action', () => {
  const { ctx } = setup();
  const input = { text: '自分で確認した' };
  const good = { issues: [{ kind: 'fidelity', quote: '確認した', reason: '回答ではまだ確認予定のため、実施済みとは言えません。', action: '確認する予定に戻す。' }] };
  const value = review(ctx, 2, { fidelity: 'confirm' });
  assert.equal(ctx.validateOutcomeIssues(value, good, input), true);
  assert.match(value.review_note, /「確認した」.*実施済み.*対応: 確認する予定/);
  const invented = structuredClone(good); invented.issues[0].quote = '存在しない語句';
  assert.equal(ctx.validateOutcomeIssues(value, invented, input), false);
  assert.equal(ctx.validateOutcomeIssues({ ...value, privacy: 'hold' }, good, input), false);
  const vague = structuredClone(good); vague.issues[0].action = '';
  assert.equal(ctx.validateOutcomeIssues(value, vague, input), false);
  assert.equal(ctx.validateOutcomeIssues(review(ctx), good, input), false);
});

test('outcome: repair only reevaluates unexplained unposted holds and is idempotent', () => {
  const { ctx, db } = setup();
  let released = 0;
  ctx.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => released++ }) };
  ctx.console = { log() {} };
  const old = { id: 'd', session_id: 's', source_idx: '1', text: '自分で確認した', status: 'stock',
    score_version: 'outcome-v1', editorial_review: JSON.stringify(review(ctx, 2, { fidelity: 'confirm' })) };
  db.Stock.push(old, ...['ready', 'approved', 'scheduled', 'posted'].map(status => ({ ...old, id: status, status })),
    { ...old, id: 'has-tweet', tweet_id: '123' }, { ...old, id: 'legacy', score_version: '' },
    { ...old, id: 'explained', editorial_review: JSON.stringify(review(ctx, 2, { fidelity: 'confirm', review_note: '既存の具体的な指摘' })) });
  const protectedRows = JSON.stringify(db.Stock.slice(1));
  db.Interviews.push({ session_id: 's', idx: 1, answer: '自分で確認した' });
  let calls = 0;
  ctx.askClaudeJsonSalvageable = (_sys, input) => { calls++; assert.doesNotMatch(input, /has-tweet|explained|scheduled/); return { d: review(ctx) }; };
  assert.equal(ctx.repairOutcomeReviews().passed, 1);
  assert.equal(db.Stock[0].status, 'ready');
  assert.equal(db.Stock[0].text, old.text);
  assert.equal(JSON.stringify(db.Stock.slice(1)), protectedRows);
  assert.equal(ctx.repairOutcomeReviews().scored, 0);
  assert.equal(calls, 1);
  assert.equal(released, 2);
});

test('outcome: approval or text edits during scoring are not overwritten', () => {
  for (const update of [{ status: 'approved' }, { text: '本人が編集した本文' }]) {
    const { ctx, db } = setup();
    db.Stock.push({ id: 'd', text: '自分で確認した', status: 'draft' });
    ctx.askClaudeJsonSalvageable = () => { Object.assign(db.Stock[0], update); return { d: review(ctx) }; };
    assert.equal(ctx.runOutcomeQualityGate().scored, 0);
    assert.equal(db.Stock[0][Object.keys(update)[0]], Object.values(update)[0]);
    assert.equal(db.Stock[0].editorial_review, undefined);
  }
});

test('outcome: malformed scores and invented citations stay draft and clear stale evaluation', () => {
  const { ctx, db } = setup();
  const good = review(ctx);
  for (const score of [null, '', '2', -1, 5, 2.5]) {
    const invalid = structuredClone(good); invalid.axes.clarity.score = score;
    assert.equal(ctx.validateOutcomeReview(invalid, '自分で確認した'), null);
  }
  good.axes.decision.evidence = '存在しない引用';
  db.Stock.push({ id: 'd', status: 'draft', text: '自分で確認した', score: 99, outcome_axes: 'stale' });
  ctx.askClaudeJsonSalvageable = () => ({ d: good });
  assert.equal(ctx.runQualityGate().scored, 0);
  assert.equal(db.Stock[0].status, 'draft');
  assert.equal(db.Stock[0].score, '');
  assert.equal(db.Stock[0].outcome_axes, '');
});

test('outcome: exact source includes only answers, ambiguous legacy and skipped sources stay unverified', () => {
  const { ctx } = setup();
  const qa = [{ session_id: 's', idx: 1, theme: 't', question: '架空の事件を断定', answer: '自分で確認',
    followup_question: '別の未確認前提', followup_answer: '補足の事実', followup_answered_at: 'now' },
  { session_id: 's', idx: 2, theme: 't', answer: 'もう一つ' }];
  const source = ctx.outcomeSourceForRow({ session_id: 's', source_idx: 1 }, qa);
  assert.match(source, /補足の事実/);
  assert.doesNotMatch(source, /架空|未確認前提|もう一つ/);
  assert.equal(ctx.outcomeSourceForRow({ session_id: 's', theme: 't' }, qa), '');
  qa[0].answered_at = 'skipped';
  assert.equal(ctx.outcomeSourceForRow({ session_id: 's', source_idx: 1 }, qa), '');
});

test('outcome: measurement freezes once, includes zero clicks, rejects ads, missing clicks and wrong ages', () => {
  const { ctx } = setup();
  const row = { score_version: 'outcome-v1', text: 't', outcome_text: 't' };
  const m = { metrics_age_h: 72, impressions: 200, profile_clicks: 0, metrics_at: '2026-09-13 09:00' };
  assert.equal(JSON.parse(ctx.captureOutcomeMetrics(row, m)).profile_clicks, 0);
  for (const overrides of [{ metrics_age_h: 47 }, { metrics_age_h: 169 }, { profile_clicks: undefined },
    { profile_clicks: '' }, { impressions: 0 }, { promoted: 'yes' }]) {
    assert.equal(ctx.captureOutcomeMetrics(row, { ...m, ...overrides }), '');
  }
  for (const overrides of [{ outcome_metrics: '{}' }, { outcome_text: 'old' }, { promoted: 'yes' }, { score_version: '' }]) {
    assert.equal(ctx.captureOutcomeMetrics({ ...row, ...overrides }, m), '');
  }
});

function measured(ctx, id, overrides = {}) {
  const day = String(1 + Number(id) % 28).padStart(2, '0');
  return { id: String(id), tweet_id: 'tweet-' + id, session_id: 's-' + id, status: 'posted',
    text: '自分で確認した', outcome_text: '自分で確認した', score_version: 'outcome-v1',
    outcome_scored_at: '2026-08-01 09:00', posted_at: `2026-09-${day} 09:00`,
    outcome_axes: JSON.stringify(review(ctx, Number(id) % 5).axes),
    editorial_review: JSON.stringify({ scorer: 'claude/test-model/' }),
    outcome_metrics: JSON.stringify({ age_h: 72, impressions: 200, profile_clicks: Number(id) % 5 }), ...overrides };
}

test('outcome: prospective validation excludes old scales, retrospective scoring, stale text and repeats', () => {
  const { ctx } = setup();
  const data = Array.from({ length: 25 }, (_, i) => measured(ctx, i));
  data.push(measured(ctx, 26, { score_version: '' }), measured(ctx, 27, { outcome_scored_at: '2026-10-01 09:00' }),
    measured(ctx, 28, { outcome_text: 'old' }), measured(ctx, 29, { promoted: 'yes' }),
    measured(ctx, 30, { outcome_metrics: '{bad' }), measured(ctx, 31, { session_id: 's-0' }), measured(ctx, 0));
  const result = ctx.outcomeValidationSummary(data);
  assert.equal(result.all.n, 25);
  assert.equal(result.duplicateSessionPosts, 1);
  assert.equal(result.excluded, 5);
  assert.equal(result.all.rho, 1);
  assert.equal(result.age96to168.n, 0);
  assert.equal(result.age96to168.rho, null);
});

test('themes: existing famous-person roster cannot override focus; seeding is idempotent and preserves stopped rows', () => {
  const { ctx, db } = setup();
  db.Themes.push({ theme: '堀江さんが工場に来た日の話', weight: 9999, roster: 'core' },
    { theme: ctx.FOCUSED_THEMES[0][0], weight: 0, notes: '本人が停止' });
  assert.equal(ctx.ensureFocusedThemes(), 19);
  assert.equal(ctx.ensureFocusedThemes(), 0);
  assert.equal(db.Themes[0].weight, 9999);
  assert.equal(db.Themes[1].notes, '本人が停止');
  for (let i = 0; i < 20; i++) {
    const selected = ctx.pickThemesForToday();
    assert.equal(selected.length, 2);
    assert.ok(selected.every(t => !ctx.isRetiredTopic(t.theme)));
    assert.notEqual(selected[0].theme, selected[1].theme);
    assert.notEqual(selected[0].reader_bridge, selected[1].reader_bridge);
    assert.ok(selected.every(t => t.category !== 'news'));
  }
});

test('themes: weekly rotation and generation cannot restore retired or unrelated legacy themes', () => {
  const { ctx, db } = setup({ ROSTER_CORE: '2', ROSTER_ADJACENT: '2', ROSTER_RANDOM: '2', ROSTER_TREND: '2' });
  db.Themes.push({ theme: '堀江さんの話', weight: 9999, roster: 'core' },
    { theme: '海外ニュースへの論評', weight: 9999, roster: 'random' });
  ctx.fetchNewsItems = () => [];
  ctx.topPostSamples = () => [];
  ctx.askClaudeJsonSalvageable = (_sys, _user, _limit, opts) => {
    assert.equal(opts.purpose, 'interview');
    return [{ theme: 'ホリエモンが工場へ', protagonist: '本人', reader_bridge: '仕事' },
      { theme: '有名人への論評', protagonist: '有名人', reader_bridge: '仕事' }];
  };
  ctx.rotateThemeRoster();
  assert.equal(db.Themes[0].roster, '');
  assert.equal(db.Themes[1].roster, '');
  assert.ok(db.Themes.filter(t => t.roster).every(ctx.isFocusedTheme));
});

test('themes: performance uses measured profile rate, excludes missing clicks and retired topics', () => {
  const { ctx, db } = setup();
  db.Stock.push(...[
    { theme: 'A', impressions: 100, profile_clicks: 5 },
    { theme: 'B', impressions: 10000, profile_clicks: 1 },
    { theme: '未測定', impressions: 10000, profile_clicks: '' },
    { theme: '堀江の話', impressions: 100, profile_clicks: 90 },
    { theme: '未成熟', impressions: 100, profile_clicks: 90, metrics_age_h: 1 },
  ].map((r, i) => ({ status: 'posted', posted_at: '2026-09-01 09:00', metrics_at: '2026-09-04 09:00',
    metrics_age_h: 72, text: '自分の話', tweet_id: String(i + 1), ...r })));
  const result = ctx.themePerformance();
  assert.equal(result.themeCount, 2);
  assert.ok(result.byTheme.a.perf > result.byTheme.b.perf);
});

test('outcome: diagnostic entrypoints are read only and do not change legacy weights', () => {
  const { ctx, db } = setup();
  ctx.console = { log: () => {} };
  ctx.PropertiesService = { getScriptProperties: () => { throw new Error('no setting writes'); } };
  ctx.askClaudeJsonSalvageable = () => { throw new Error('no LLM call'); };
  assert.equal(ctx.diagnoseScoring().all.n, 0);
  assert.equal(ctx.evaluateScoring().all.n, 0);
  assert.equal(db.Stock.length, 0);
});

test('questions: retired names are blocked in generated and adaptive questions', () => {
  const { ctx } = setup();
  for (const q of ['堀江さんの話は？', 'ホリエモンの反応は？', 'Horiemonについて？', 'Ｔａｋａｆｕｍｉ Ｈｏｒｉｅの話は？']) {
    assert.equal(ctx.validInterviewQuestion(q), false);
  }
  assert.equal(ctx.validInterviewQuestion('テトラで最近変えたことは？'), true);
});

test('metrics: existing fetch captures new measurements without an extra API call and preserves the first snapshot', () => {
  const { ctx, db } = setup();
  db.Stock.push(measured(ctx, 1, { posted_at: '2026-09-07 09:00', outcome_metrics: '', metrics_at: '' }));
  ctx.spendCapActiveUntil = () => '';
  let requests = 0;
  ctx.xApiGet = () => {
    requests++;
    return { data: [{ id: 'tweet-1', public_metrics: { impression_count: 200 },
      organic_metrics: { impression_count: 200 }, non_public_metrics: { user_profile_clicks: requests } }] };
  };
  ctx.fetchTweetMetrics();
  const first = db.Stock[0].outcome_metrics;
  assert.equal(JSON.parse(first).profile_clicks, 1);
  ctx.fetchTweetMetrics();
  assert.equal(requests, 2);
  assert.equal(db.Stock[0].profile_clicks, 2);
  assert.equal(db.Stock[0].outcome_metrics, first);
});

test('outcome: different scoring models are reported separately rather than pooled', () => {
  const { ctx } = setup();
  const data = [measured(ctx, 1), measured(ctx, 2, { editorial_review: JSON.stringify({ scorer: 'claude/another-model/' }) })];
  const report = ctx.outcomeValidationSummary(data);
  assert.equal(report.mixedScorers, true);
  assert.equal(report.all.n, 0);
  assert.equal(report.byScorer['claude/another-model/'].n, 1);
  assert.match(ctx.outcomeValidationText(report), /採点モデルが複数/);
});

test('legacy: old axis analysis cannot accidentally learn from new scores', () => {
  const { ctx, db } = setup({ QUALITY_MODE: 'legacy' });
  db.Stock.push(measured(ctx, 1, { axes: '{"voice":60}', metrics_at: '2026-09-04 09:00', metrics_age_h: 72 }),
    measured(ctx, 2, { score_version: '', axes: '{"voice":60}', metrics_at: '2026-09-04 09:00', metrics_age_h: 72 }));
  assert.equal(ctx.analyzableRows().length, 1);
  assert.equal(ctx.analyzableRows()[0].id, '2');
});

test('outcome: compact API vectors preserve axis order and reject shifted or incomplete vectors', () => {
  const { ctx } = setup();
  const value = review(ctx);
  value.axes = [0, 1, 2, 3, 4].map(score => [score, '自分で確認']);
  const result = ctx.validateOutcomeReview(value, '自分で確認した');
  assert.equal(result.axes.relevance.score, 0);
  assert.equal(result.axes.follow.score, 4);
  value.axes.pop();
  assert.equal(ctx.validateOutcomeReview(value, '自分で確認した'), null);
  value.axes.push([4]);
  assert.equal(ctx.validateOutcomeReview(value, '自分で確認した'), null);
});
