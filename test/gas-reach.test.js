import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const now = Date.parse('2026-10-10T03:00:00Z');
const stamp = '2026-10-10 12:00';
const id = '2104053537751880093';
function setup(properties = {}) {
  const db = { Stock: [], Interviews: [], QuoteSources: [] }, logs = [], api = [], messages = [];
  let held = false, day = '2026-10-10';
  class Clock extends Date { static now() { return now; } }
  const ctx = vm.createContext({ console, Date: Clock });
  for (const file of ['Pure', 'Config', 'Editorial', 'Reach', 'Interview', 'XApi', 'PostComposition']) {
    vm.runInContext(readFileSync(new URL(`../gas/src/${file}.js`, import.meta.url), 'utf8'), ctx);
  }
  Object.assign(ctx, {
    getProp: (key, fallback) => properties[key] ?? fallback,
    readTable: name => structuredClone(db[name] || []),
    appendRowsObj: (name, rows) => db[name].push(...structuredClone(rows)),
    updateStockById: (key, values) => Object.assign(db.Stock.find(r => r.id === key), structuredClone(values)),
    ensureHeaders: () => {}, ss: () => ({ getSheetByName: () => ({}), insertSheet: () => {} }),
    PropertiesService: { getScriptProperties: () => ({ setProperty: (key, value) => { properties[key] = value; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (held) return false; held = true; return true; }, releaseLock: () => { held = false; } }) },
    xApiGet: (path, params) => { api.push({ path, params }); return { data: [] }; },
    spendCapActiveUntil: () => null, noteSpendCap: () => { properties.cap = true; },
    logEvent: (...args) => logs.push(args), nowJst: () => new Clock(now), fmtDate: () => day, fmtDateTime: () => stamp,
    notifySlack: text => messages.push(text), syncSafe: () => {},
    prepareEditorialCouncil: () => ({}), editorialCouncilInstructions: () => '',
    axisGuidanceForQuestions: () => '', getMemoryNotes: () => [],
    oauth1Header: () => 'test',
  });
  return { ctx, db, logs, api, messages, properties, nextDay: () => { day = '2026-10-11'; } };
}
function tweet(more = {}) {
  return { id, author_id: '12345', text: '搬送の待ち時間まで含めて全体を設計する。', created_at: '2026-10-09T00:00:00Z', public_metrics: { impression_count: 2000 }, ...more };
}
function source(h, more = {}) { return { ...h.ctx.observedQuoteSource(tweet(), null, stamp), ...more }; }
function quoteRow(h, mode = 'link') {
  const s = source(h);
  return { quote_tweet_id: id, quote_source: JSON.stringify(s), quote_mode: mode, text: '全体の設計を見たい。\n' + s.url,
    edit_meta: JSON.stringify({ quote_source: s, quote_mode: mode }), post_format: 'single' };
}

test('reach: own examples separate origins and age bands; exclude ads, missing, stale and retired rows', () => {
  const h = setup();
  const rows = [];
  for (const origin of ['manual', 'interview']) {
    [100, 150, 200, 250, 300, origin === 'manual' ? 4100 : 800].forEach((impressions, i) => rows.push({
      id: origin + i, tweet_id: String(2100000000000000000n + BigInt(rows.length)), status: 'posted',
      session_id: origin === 'manual' ? '' : 's', source_idx: String(i + 1), text: '固有な経験' + i,
      posted_at: '2026-10-07 12:00', metrics_at: stamp, metrics_age_h: '72', impressions,
    }));
  }
  for (const extra of [{ promoted: 'yes' }, { paid_impressions: '10' }, { impressions: '' },
    { metrics_at: '2026-09-01 12:00' }, { text: '堀江さん' }, { tweet_id: 'dry-run' }]) {
    rows.push({ ...rows[0], id: 'excluded', tweet_id: String(2100000000000000100n + BigInt(rows.length)), impressions: 99999, ...extra });
  }
  const examples = h.ctx.reachPostExamples(rows, [{ session_id: 's', idx: 6, question: '迷った判断は？' }], now);
  assert.equal(examples.length, 4);
  assert.equal(examples[0].impressions, 4100);
  assert.equal(examples[0].cohort_n, 6);
  assert.equal(examples[1].role, '比較用の中央値付近');
  assert.equal(examples[2].actual_question, '迷った判断は？');
  assert.ok(examples.every(e => e.cohort_median === 225));
  assert.equal(h.ctx.reachPostExamples(rows.slice(0, 4), [], now).length, 0);
});

test('quotes: growth requires two comparable observations; missing metrics, edited posts and unsafe sources do not fake growth', () => {
  const h = setup();
  const previous = source(h, { observed_at: '2026-10-09 12:00', impressions: 1000 });
  const observed = h.ctx.observedQuoteSource(tweet(), previous, stamp);
  assert.equal(observed.growth, 1000);
  assert.equal(h.ctx.observedQuoteSource(tweet({ text: '編集済み' }), previous, stamp).growth, '');
  assert.equal(h.ctx.observedQuoteSource(tweet(), { ...previous, observed_at: stamp }, stamp).growth, '');
  for (const more of [{ public_metrics: {} }, { id: Number(id) }, { possibly_sensitive: true }, { withheld: { country_codes: ['JP'] } },
    { referenced_tweets: [{ type: 'replied_to', id: '123456' }] }, { text: 'ホリエモン' }, { text: 'a'.repeat(5001) }]) {
    assert.equal(h.ctx.observedQuoteSource(tweet(more), previous, stamp), null);
  }
});

test('quotes: candidates prefer measured growth and exclude stale, unavailable, reused and own posts', () => {
  const h = setup();
  const s = source(h), growing = source(h, { tweet_id: '2104053537751880094', impressions: 1500, previous_impressions: 1000, growth: 500, previous_at: '2026-10-09 12:00' });
  const candidates = h.ctx.quoteCandidates([s, growing], [], [], now, 1000);
  assert.equal(candidates[0].tweet_id, growing.tweet_id);
  assert.match(candidates[0].signal, /2時点/);
  assert.match(candidates[1].signal, /未確認/);
  assert.equal(h.ctx.quoteGrowthRate({ ...growing, previous_impressions: '' }), 0);
  assert.equal(h.ctx.quoteCandidates([s], [{ quote_tweet_id: id }], [], now, 1000).length, 0);
  assert.equal(h.ctx.quoteCandidates([s], [{ tweet_id: id }], [], now, 1000).length, 0);
  assert.equal(h.ctx.quoteCandidates([s, { ...s, status: 'unavailable' }], [], [], now, 1000).length, 0);
  assert.equal(h.ctx.quoteCandidates([{ ...s, observed_at: '2026-10-08 12:00' }], [], [], now, 1000).length, 0);
});

test('quotes: daily refresh caps reads, releases the reply lock before API calls, and tombstones missing sources', () => {
  const h = setup();
  h.db.QuoteSources.push(source(h, { observed_at: '2026-10-09 12:00' }));
  h.ctx.xApiGet = (path, params) => {
    const lock = h.ctx.LockService.getScriptLock(); assert.equal(lock.tryLock(), true); lock.releaseLock();
    h.api.push({ path, params }); return { data: [] };
  };
  h.ctx.refreshQuoteSources(); h.ctx.refreshQuoteSources();
  assert.equal(h.api.length, 2);
  assert.equal(h.api[1].params.max_results, '20');
  assert.equal(h.ctx.quoteCandidates(h.db.QuoteSources, [], [], now, 1000).length, 0);
  assert.equal(h.messages.length, 0);
});

test('quotes: unavailable API and spend caps preserve normal interview generation without read retries', () => {
  const h = setup();
  let calls = 0;
  h.ctx.xApiGet = () => { calls++; throw new Error('spend-cap-reached'); };
  h.ctx.refreshQuoteSources(); h.ctx.refreshQuoteSources();
  assert.equal(calls, 1); assert.equal(h.properties.cap, true);
  assert.equal(h.ctx.reachQuestionContext().candidates.length, 0);
  const off = setup({ QUOTE_DISCOVERY_ENABLED: 'false' }); off.ctx.refreshQuoteSources();
  assert.equal(off.api.length, 0);
});

test('questions: council and generator receive observed examples and external context; unknown IDs cannot be saved', () => {
  const h = setup(); h.db.QuoteSources.push(source(h));
  const theme = { theme: 'テトラでものを作る時間の使い方', category: 'evergreen' };
  let councilInput;
  h.ctx.prepareEditorialCouncil = (_stage, input) => { councilInput = input; return {}; };
  const q = (question, quoteId = '') => ({ ...theme, question, quote_tweet_id: quoteId,
    quote_bridge: '航空機開発での待ち時間をどう捉えるかという本人の視点を聞く', reach_angle: 'cross_domain' });
  h.ctx.askClaudeJson = (system, input) => {
    assert.match(system, /表示数を伸ばすための取材仮説/); assert.match(input, /搬送の待ち時間/);
    return [q('その搬送の話、航空機開発ではどう見える？', id), q('別の引用？', id), q('偽の引用？', '999999'), q('最近変えた作業は？')];
  };
  const questions = h.ctx.generateInterviewQuestions([theme], [], 4);
  assert.match(councilInput, /伸長は未確認/);
  assert.equal(questions.length, 2);
  assert.equal(JSON.parse(questions[0].quote_source).text, tweet().text);
  assert.match(h.ctx.interviewQuestionDisplay(questions[0]), /参考投稿.*\n/);
  assert.match(h.ctx.interviewQuestionDisplay(questions[0]), /https:\/\/x.com/);
  assert.equal(JSON.parse(questions[0].reach_meta).angle, 'cross_domain');
  assert.equal(h.db.Interviews.length, 0);
});

test('questions: adaptive turns keep a quote question attached to its source', () => {
  const h = setup(), row = { question: '最近の判断は？', answer: '少し待つかな' };
  const next = { ...quoteRow(h), question: '搬送の話をどう見る？' };
  h.ctx.askClaude = (_system, input) => {
    assert.equal(JSON.parse(input.split('\nJSON')[0]).next.quote_source.tweet_id, id);
    return JSON.stringify({ quote: '', followup: '', next_question: '関係のない問いは？' });
  };
  assert.equal(h.ctx.planInterviewTurn([row, next], row, row.answer, next, false, false).next_question, '');
});

test('quotes: source attachment rejects mismatches and combining different quoted posts', () => {
  const h = setup(), row = quoteRow(h);
  assert.equal(h.ctx.compositionQuoteSource([row]).tweet_id, id);
  assert.throws(() => h.ctx.quoteSourceForRow({ ...row, quote_tweet_id: '999999' }), /一致/);
  const other = source(h, { tweet_id: '999999', url: 'https://x.com/i/status/999999' });
  assert.throws(() => h.ctx.compositionQuoteSource([row, { quote_tweet_id: '999999', quote_source: JSON.stringify(other) }]), /統合/);
});

test('quotes: link loss and changed source metadata block scheduling; native posting requires explicit entitlement', () => {
  const h = setup(), row = quoteRow(h);
  assert.equal(h.ctx.stockPublishingProblem(row), '');
  assert.match(h.ctx.stockPublishingProblem({ ...row, text: 'リンクがない' }), /リンク/);
  assert.match(h.ctx.stockPublishingProblem({ ...row, quote_mode: 'native' }), /編集時/);
  assert.match(h.ctx.stockPublishingProblem({ ...row, quote_tweet_id: '', quote_source: '' }), /失われ/);
  assert.match(h.ctx.stockPublishingProblem(quoteRow(h, 'native')), /権限/);
  assert.throws(() => h.ctx.postTweet('見方', [], id), /権限/);
});

test('questions: a new session saves the exact selected source and displays it before asking for an answer', () => {
  const h = setup(); h.db.QuoteSources.push(source(h));
  const theme = { theme: '作る側になって見方が変わったもの', category: 'evergreen' };
  h.ctx.refreshQuoteSources = () => {};
  h.ctx.pickThemesForToday = () => [theme]; h.ctx.newId = () => 'iv-test';
  h.ctx.appendRowObj = (name, row) => h.db[name].push(structuredClone(row));
  h.ctx.sendSlack = text => { h.messages.push(text); return { ts: '12345.6789' }; };
  h.ctx.askClaudeJson = () => [{ ...theme, question: 'この設計の話、航空機だとどう見える？', quote_tweet_id: id,
    quote_bridge: '全体設計について本人の専門的な視点を聞く' }];
  h.ctx.startInterviewSession('iv', '今日のインタビュー');
  assert.equal(h.db.Interviews.length, 1);
  assert.equal(h.db.Interviews[0].quote_tweet_id, id);
  assert.equal(JSON.parse(h.db.Interviews[0].quote_source).text, tweet().text);
  assert.match(h.messages[1], /参考投稿/);
  assert.ok(h.messages[1].indexOf('https://x.com') < h.messages[1].indexOf('この設計の話'));
  assert.equal(h.db.Stock.length, 0);
});

test('quotes: changed or missing external post stops publishing without silently dropping the reference', () => {
  const h = setup(), row = quoteRow(h);
  h.ctx.xApiGet = () => ({ data: tweet() }); assert.doesNotThrow(() => h.ctx.verifyQuoteBeforePosting(row));
  for (const data of [null, tweet({ text: '変更済み' }), tweet({ withheld: {} })]) {
    h.ctx.xApiGet = () => ({ data }); assert.throws(() => h.ctx.verifyQuoteBeforePosting(row), /公開せず/);
  }
});

test('quotes: native API body uses a string ID; existing normal and link posts keep their original payload', () => {
  const h = setup({ X_NATIVE_QUOTES_ENABLED: 'true' }); const bodies = [];
  h.ctx.UrlFetchApp = { fetch: (_url, opts) => { bodies.push(JSON.parse(opts.payload)); return { getResponseCode: () => 201, getContentText: () => '{"data":{"id":"999999"}}' }; } };
  h.ctx.postTweet('本人の見方', [], id);
  h.ctx.postTweet('普通の投稿', []);
  assert.equal(bodies[0].quote_tweet_id, id);
  assert.equal(bodies[1].quote_tweet_id, undefined);
});
