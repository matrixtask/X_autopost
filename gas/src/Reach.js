/** Reach.gs — 実績を取材仮説へ変換し、外部投稿の観測と本人回答を分離する。 */
var REACH_VERSION = 'reach-v1';
var QUOTE_SOURCE_SHEET = 'QuoteSources';

function reachDateMs(value) {
  var s = String(value || '');
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(s)) s = s.replace(' ', 'T') + ':00+09:00';
  var n = Date.parse(s);
  return isFinite(n) ? n : null;
}

function reachNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  var n = Number(value);
  return isFinite(n) && n >= 0 ? n : null;
}

function reachHypothesesPrompt() {
  return [
    '表示数を伸ばすための取材仮説（成功の保証・採点の正解ではない）:',
    '- 一般の仕事・暮らしの話を、本人の航空機開発・経営の見方で読み替える意外な接続を探す。比喩の答えを先に作らない。',
    '- 現場の選択で迷った一点、採らなかった案、その理由か代償を聞く。一般的な教訓だけを求めない。',
    '- 本人が遭遇した具体的な場面、予想と現実のずれ、自然な笑いを拾う。劇的な失敗を経験済みと決めつけない。',
    '- 4問以上なら上の異なる入口を少なくとも2つ検討する。テーマと回答済みの内容を優先し、無理に全型を埋めない。',
    '- 編集では固有な判断・比喩・留保を残す。経験を削って誰でも言えるまとめに変えない。炎上・有名人・定型CTAで代用しない。',
    '過去投稿の実測は候補を探す参考。手動/インタビュー由来、経過時間、広告の違いを無視して原因や質問の効果を断定しない。',
  ].join('\n');
}

/** 同じ由来・計測経過帯で比較。採点には渡さず、少数標本は順位化しない。 */
function reachPostExamples(rows, interviews, nowMs) {
  var cohorts = {}, seen = {};
  rows.forEach(function (r) {
    var posted = reachDateMs(r.posted_at), measured = reachDateMs(r.metrics_at), imp = reachNumber(r.impressions);
    var age = reachNumber(r.metrics_age_h);
    if (age === null && posted !== null && measured !== null) age = (measured - posted) / 3600000;
    if (r.status !== 'posted' || !/^\d{5,25}$/.test(String(r.tweet_id || '')) || seen[r.tweet_id] ||
        posted === null || measured === null || posted > nowMs || nowMs - posted > 90 * 86400000 ||
        measured > nowMs || nowMs - measured > 14 * 86400000 || imp === null ||
        age === null || age < 48 || r.promoted === 'yes' || reachNumber(r.paid_impressions) > 0 ||
        !String(r.text || '').trim() || isRetiredTopic(r.text + ' ' + r.theme)) return;
    seen[r.tweet_id] = true;
    var origin = r.session_id ? 'インタビュー由来' : '手動投稿';
    var band = age <= 168 ? '48〜168時間' : age <= 720 ? '169〜720時間' : '721時間以上';
    var key = origin + '/' + band;
    if (!cohorts[key]) cohorts[key] = [];
    cohorts[key].push({ row: r, impressions: imp, origin: origin, age_band: band });
  });
  var groups = [];
  Object.keys(cohorts).forEach(function (key) {
    var group = cohorts[key].sort(function (a, b) { return a.impressions - b.impressions; });
    if (group.length < 5) return;
    var mid = Math.floor(group.length / 2);
    var median = group.length % 2 ? group[mid].impressions : (group[mid - 1].impressions + group[mid].impressions) / 2;
    if (median <= 0) return;
    var top = group[group.length - 1];
    if (top.impressions < median * 1.3) return;
    var examples = [];
    [top, group[mid]].forEach(function (item, i) {
      var r = item.row;
      var qs = interviews.filter(function (q) { return r.session_id && q.session_id === r.session_id && String(q.idx) === String(r.source_idx); });
      examples.push({ post_id: String(r.id), tweet_id: String(r.tweet_id), role: i ? '比較用の中央値付近' : '同群の上位事例',
        origin: item.origin, age_band: item.age_band, cohort_n: group.length, cohort_median: median,
        impressions: item.impressions, measured_at: String(r.metrics_at), text: String(r.text).slice(0, 700),
        actual_question: qs.length === 1 ? String(qs[0].question || '') : '',
        question_evidence: qs.length === 1 ? '実施済み。効果の因果は未検証' : '質問の対応不明。逆算した質問を実施済みと扱わない' });
    });
    groups.push({ lift: top.impressions / median, examples: examples });
  });
  return groups.sort(function (a, b) { return b.lift - a.lift; }).slice(0, 3)
    .reduce(function (all, group) { return all.concat(group.examples); }, []);
}

function ensureQuoteSourcesSheet() {
  var book = ss();
  if (!book.getSheetByName(QUOTE_SOURCE_SHEET)) book.insertSheet(QUOTE_SOURCE_SHEET);
  ensureHeaders(QUOTE_SOURCE_SHEET);
}

function latestQuoteSources(rows) {
  var latest = {};
  rows.forEach(function (r) { latest[String(r.tweet_id)] = r; });
  return latest;
}

/** 原文は取得時点のスナップショット。外部の主張の真偽や広告除外は証明しない。 */
function observedQuoteSource(tweet, previous, measuredAt) {
  var imp = tweet && reachNumber(tweet.public_metrics && tweet.public_metrics.impression_count);
  var text = String(tweet && ((tweet.note_tweet && tweet.note_tweet.text) || tweet.text) || '');
  if (!tweet || typeof tweet.id !== 'string' || !/^\d{5,25}$/.test(tweet.id) || !tweet.author_id ||
      !text.trim() || text.length > 5000 || imp === null || reachDateMs(tweet.created_at) === null ||
      tweet.possibly_sensitive || tweet.withheld || (tweet.referenced_tweets || []).length || isRetiredTopic(text)) return null;
  var before = previous && reachNumber(previous.impressions), beforeAt = previous && reachDateMs(previous.observed_at);
  var currentAt = reachDateMs(measuredAt);
  var comparable = previous && previous.status === 'available' && previous.text === text && before !== null &&
    beforeAt !== null && currentAt - beforeAt >= 3600000 && imp >= before;
  return { tweet_id: tweet.id, author_id: String(tweet.author_id), url: 'https://x.com/i/status/' + tweet.id,
    text: text, created_at: tweet.created_at, observed_at: measuredAt, impressions: imp,
    previous_impressions: comparable ? before : '', previous_at: comparable ? previous.observed_at : '',
    growth: comparable ? imp - before : '', status: 'available' };
}

/** 1日最大1回、検索20件＋前回候補20件の再観測。取得不能でも取材を止めない。 */
function refreshQuoteSources() {
  if (getProp('QUOTE_DISCOVERY_ENABLED', 'true') !== 'true') return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var today = fmtDate(nowJst());
    if (getProp('QUOTE_DISCOVERY_DAY', '') === today) return;
    PropertiesService.getScriptProperties().setProperty('QUOTE_DISCOVERY_DAY', today);
  } finally { lock.releaseLock(); }
  try {
    ensureQuoteSourcesSheet();
    if (spendCapActiveUntil()) return;
    var now = Date.now(), stamp = fmtDateTime(new Date(now));
    var previous = latestQuoteSources(readTable(QUOTE_SOURCE_SHEET));
    var ids = Object.keys(previous).filter(function (id) {
      var t = reachDateMs(previous[id].created_at);
      return t !== null && now - t <= 72 * 3600000 && previous[id].status === 'available';
    }).sort(function (a, b) { return Number(previous[b].impressions) - Number(previous[a].impressions); }).slice(0, 20);
    var fields = 'created_at,author_id,public_metrics,possibly_sensitive,referenced_tweets,note_tweet,withheld';
    var observations = [];
    if (ids.length) {
      var lookup = xApiGet('/tweets', { ids: ids.join(','), 'tweet.fields': fields });
      var found = {};
      (lookup.data || []).forEach(function (tweet) {
        var source = observedQuoteSource(tweet, previous[tweet.id], stamp);
        if (source) { observations.push(source); found[source.tweet_id] = true; }
      });
      // 削除・非公開・不正な応答を、古い本文で引用候補へ復活させない。
      ids.forEach(function (id) {
        if (!found[id]) observations.push(Object.assign({}, previous[id], { observed_at: stamp, status: 'unavailable' }));
      });
      if (observations.length) appendRowsObj(QUOTE_SOURCE_SHEET, observations);
    }
    var query = getProp('QUOTE_SEARCH_QUERY', '(ものづくり OR 製造 OR 設計 OR 移動 OR チーム OR 採用) lang:ja -is:retweet -is:reply -is:quote');
    var result = xApiGet('/tweets/search/recent', { query: query, max_results: '20', sort_order: 'relevancy',
      start_time: new Date(now - 72 * 3600000).toISOString(), 'tweet.fields': fields });
    var observed = {};
    observations.forEach(function (r) { observed[r.tweet_id] = true; });
    var added = (result.data || []).map(function (tweet) {
      return observed[tweet.id] ? null : observedQuoteSource(tweet, previous[tweet.id], stamp);
    }).filter(Boolean);
    if (added.length) appendRowsObj(QUOTE_SOURCE_SHEET, added);
    logEvent('quote_discovery', '再観測' + ids.length + '件 / 新規観測' + added.length + '件。公開表示数は広告を含みうる');
  } catch (e) {
    if (isSpendCapError(e)) noteSpendCap();
    logEvent('quote_discovery_error', String(e).slice(0, 300));
  }
}

function quoteCandidates(rows, stock, interviews, nowMs, minImpressions) {
  var used = {};
  stock.concat(interviews).forEach(function (r) { if (r.quote_tweet_id) used[String(r.quote_tweet_id)] = true; });
  // 自分の既投稿も引用候補から外す。
  stock.forEach(function (r) { if (r.tweet_id) used[String(r.tweet_id)] = true; });
  var latest = latestQuoteSources(rows);
  return Object.keys(latest).map(function (id) { return latest[id]; }).filter(function (r) {
    var created = reachDateMs(r.created_at), observed = reachDateMs(r.observed_at), imp = reachNumber(r.impressions);
    return !used[r.tweet_id] && r.status === 'available' && /^\d{5,25}$/.test(String(r.tweet_id)) &&
      created !== null && created <= nowMs && nowMs - created <= 72 * 3600000 &&
      observed !== null && observed <= nowMs && nowMs - observed <= 30 * 3600000 &&
      imp !== null && imp >= minImpressions && String(r.text || '').trim() && !isRetiredTopic(r.text);
  }).sort(function (a, b) {
    return quoteGrowthRate(b) - quoteGrowthRate(a) || Number(b.impressions) - Number(a.impressions);
  }).slice(0, 5).map(function (r) {
    return Object.assign({}, r, { signal: quoteGrowthRate(r) > 0 ? '2時点で表示増を観測' : '表示数上位・伸長は未確認' });
  });
}

function quoteGrowthRate(row) {
  var current = reachNumber(row.impressions), previous = reachNumber(row.previous_impressions), growth = reachNumber(row.growth);
  var start = reachDateMs(row.previous_at), end = reachDateMs(row.observed_at);
  if (current === null || previous === null || growth === null || growth <= 0 || current - previous !== growth ||
      start === null || end === null || end - start < 3600000) return 0;
  return growth / ((end - start) / 3600000);
}

function reachQuestionContext() {
  var stock = readTable(SHEET.STOCK), interviews = readTable(SHEET.INTERVIEWS), candidates = [];
  if (getProp('QUOTE_DISCOVERY_ENABLED', 'true') === 'true') {
    try {
      var ownId = getProp('X_USER_ID', '');
      candidates = quoteCandidates(readTable(QUOTE_SOURCE_SHEET), stock, interviews, Date.now(), Number(getProp('QUOTE_MIN_IMPRESSIONS', '1000')) || 1000)
        .filter(function (r) { return !ownId || r.author_id !== ownId; });
    }
    catch (e) { logEvent('quote_candidates_unavailable', String(e).slice(0, 180)); }
  }
  return { version: REACH_VERSION, examples: reachPostExamples(stock, interviews, Date.now()), candidates: candidates };
}

function quoteSourceForRow(row) {
  if (!row.quote_tweet_id && !row.quote_source) return null;
  var source;
  try { source = JSON.parse(row.quote_source); } catch (e) { throw new Error('引用元の保存資料が不正です'); }
  if (!source || typeof source.tweet_id !== 'string' || source.tweet_id !== String(row.quote_tweet_id) ||
      !/^\d{5,25}$/.test(source.tweet_id) || source.url !== 'https://x.com/i/status/' + source.tweet_id ||
      typeof source.text !== 'string' || !source.text.trim() || source.text.length > 5000 || isRetiredTopic(source.text)) {
    throw new Error('引用元と保存資料が一致しません');
  }
  return source;
}

function compositionQuoteSource(sources) {
  var chosen = null;
  sources.forEach(function (r) {
    var source = quoteSourceForRow(r);
    if (!source) return;
    if (chosen && JSON.stringify(chosen) !== JSON.stringify(source)) throw new Error('異なる引用元の回答は統合できません');
    chosen = source;
  });
  return chosen;
}

function quotePublishingProblem(row) {
  try {
    var edit;
    try { edit = JSON.parse(row.edit_meta); } catch (e) { /* 引用元がある場合だけ下で保留 */ }
    var source = quoteSourceForRow(row);
    if (!source) return edit && edit.quote_source ? '編集時の引用元が失われています。再審査してください' : '';
    if (!edit) return '引用元の編集記録がありません。再審査してください';
    if (JSON.stringify(edit.quote_source) !== JSON.stringify(source) || edit.quote_mode !== row.quote_mode) return '引用元または投稿形式が編集時から変わっています。再審査してください';
    if (row.quote_mode === 'native') return getProp('X_NATIVE_QUOTES_ENABLED', 'false') === 'true' ? '' : 'ネイティブ引用のAPI権限が未確認です。手動投稿または参照リンク形式を選んでください';
    if (row.quote_mode !== 'link' || String(row.text).indexOf(source.url) < 0) return '参照リンクが本文にありません。引用元を確認してください';
    return '';
  } catch (e) { return String(e.message || e); }
}

function quotePreview(row) {
  if (!row.quote_tweet_id) return '';
  try {
    var source = quoteSourceForRow(row);
    return (row.quote_mode === 'native' ? '引用投稿' : '参照リンク付き投稿') + '\n引用元: ' + source.url + '\n「' + source.text.slice(0, 220) + (source.text.length > 220 ? '…' : '') + '」';
  } catch (e) { return '引用元の資料を確認してください'; }
}

/** 承認後に削除・編集された引用元を、そのまま投稿しない。失敗時に通常投稿へ変換しない。 */
function verifyQuoteBeforePosting(row) {
  var source = quoteSourceForRow(row);
  if (spendCapActiveUntil()) throw new Error('X APIの読取利用枠がないため引用元を確認できません。公開を止めました');
  var result = xApiGet('/tweets/' + source.tweet_id, { 'tweet.fields': 'note_tweet,withheld,possibly_sensitive' });
  var tweet = result.data;
  if (!tweet || tweet.id !== source.tweet_id || tweet.withheld || tweet.possibly_sensitive ||
      String((tweet.note_tweet && tweet.note_tweet.text) || tweet.text || '') !== source.text) {
    throw new Error('引用元が削除・非公開・編集された可能性があります。公開せず再確認してください');
  }
}
