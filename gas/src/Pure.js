/**
 * Pure.js — GASにもNodeテストにも依存しない純粋関数。
 * （test/gas-pure.test.js がこのファイルをそのまま読み込んで検証する）
 */

/**
 * Xの重み付き文字数を概算する。
 * 日本語などの全角文字は2、半角英数などは1、URLは一律23としてカウント。
 * 上限は280（= 日本語なら実質140文字）。
 */
function weightedTweetLength(text) {
  if (!text) return 0;
  var URL_RE = /https?:\/\/[^\s]+/g;
  var stripped = String(text).replace(URL_RE, '');
  var urlCount = (String(text).match(URL_RE) || []).length;
  var len = urlCount * 23;
  // X仕様: このコードポイント範囲は重み1、それ以外（CJK・絵文字等）は重み2
  var lightRanges = [
    [0, 4351],
    [8192, 8205],
    [8208, 8223],
    [8242, 8247],
  ];
  for (var i = 0; i < stripped.length; i++) {
    var cp = stripped.codePointAt(i);
    if (cp > 0xffff) i++; // サロゲートペア
    var light = lightRanges.some(function (r) { return cp >= r[0] && cp <= r[1]; });
    len += light ? 1 : 2;
  }
  return len;
}

function fitsInTweet(text) {
  return weightedTweetLength(text) <= 280;
}

/**
 * LLMの返答からJSONを寛容に取り出す。```json フェンスや前後の文を無視する。
 */
function parseJsonLoose(text) {
  if (text === null || text === undefined) throw new Error('empty response');
  var s = String(text).trim();
  s = s.replace(/```(?:json)?/g, '');
  var starts = [s.indexOf('['), s.indexOf('{')].filter(function (i) { return i >= 0; });
  if (!starts.length) throw new Error('no JSON found in: ' + s.slice(0, 200));
  var start = Math.min.apply(null, starts);
  var closer = s[start] === '[' ? ']' : '}';
  var end = s.lastIndexOf(closer);
  if (end <= start) throw new Error('unbalanced JSON in: ' + s.slice(0, 200));
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * 途中で切れたJSONから、完成している要素だけを救出する。
 *
 * LLMの応答がmax_tokensで打ち切られると配列の途中で終わるため、そのままでは
 * パースできず1バッチ丸ごと無駄になる。最後に深さ1で現れたカンマまでを
 * 有効な要素の切れ目とみなし、そこで閉じてパースする。
 * 救出できなければ null。
 */
function salvageJson(text) {
  try {
    return parseJsonLoose(text); // そもそも切れていなければ全部返す
  } catch (e) { /* 続けて救出を試みる */ }
  var s = String(text === null || text === undefined ? '' : text).replace(/```(?:json)?/g, '');
  var starts = [s.indexOf('['), s.indexOf('{')].filter(function (i) { return i >= 0; });
  if (!starts.length) return null;
  var start = Math.min.apply(null, starts);
  var closer = s[start] === '[' ? ']' : '}';
  var depth = 0, inStr = false, esc = false, lastComma = -1;
  for (var i = start; i < s.length; i++) {
    var ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 1) lastComma = i;
  }
  if (lastComma < 0) return null; // 1要素も完成していない
  try {
    return JSON.parse(s.slice(start, lastComma) + closer);
  } catch (e) {
    return null;
  }
}

/**
 * 重み付きランダム抽選。rand は 0-1 を返す関数（テスト時に固定可能）。
 */
function pickWeighted(items, weightFn, rand) {
  if (!items.length) return null;
  var r = (rand || Math.random)();
  var total = 0;
  var weights = items.map(function (it) {
    var w = Math.max(0, Number(weightFn(it)) || 0);
    total += w;
    return w;
  });
  if (total <= 0) return items[0];
  var target = r * total;
  var acc = 0;
  for (var i = 0; i < items.length; i++) {
    acc += weights[i];
    if (target < acc) return items[i];
  }
  return items[items.length - 1];
}

/**
 * 予約枠の計算（純粋関数）。
 * @param {number} count           必要な枠数
 * @param {Object} opts
 *   now: Date                     現在時刻
 *   slotTimes: ['08:00', ...]     1日の投稿枠（時刻）
 *   taken: ['2026-07-16 08:00']   予約済み枠（fmt: yyyy-MM-dd HH:mm）
 *   daysAhead: number             何日先まで見るか（既定14）
 *   minLeadMinutes: number        現在からの最低リード時間（既定60）
 *   maxPerDay: number             1日の最大投稿数（既定 slotTimes.length）
 * @returns {string[]} 'yyyy-MM-dd HH:mm' の配列（昇順）
 */
function computeNextSlots(count, opts) {
  var now = opts.now;
  var slots = opts.slotTimes || [];
  var taken = {};
  (opts.taken || []).forEach(function (t) { taken[t] = true; });
  var daysAhead = opts.daysAhead === undefined ? 14 : opts.daysAhead;
  var lead = (opts.minLeadMinutes === undefined ? 60 : opts.minLeadMinutes) * 60 * 1000;
  var maxPerDay = opts.maxPerDay || slots.length;
  var result = [];

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  var perDay = {};
  Object.keys(taken).forEach(function (t) {
    var day = t.slice(0, 10);
    perDay[day] = (perDay[day] || 0) + 1;
  });

  for (var d = 0; d <= daysAhead && result.length < count; d++) {
    var day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    var key = dayKey(day);
    for (var s = 0; s < slots.length && result.length < count; s++) {
      if ((perDay[key] || 0) >= maxPerDay) break;
      var hm = slots[s].split(':');
      var slotDate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(hm[0]), Number(hm[1]));
      if (slotDate.getTime() < now.getTime() + lead) continue;
      var slotKey = key + ' ' + pad(slotDate.getHours()) + ':' + pad(slotDate.getMinutes());
      if (taken[slotKey]) continue;
      taken[slotKey] = true;
      perDay[key] = (perDay[key] || 0) + 1;
      result.push(slotKey);
    }
  }
  return result;
}

/**
 * Slackのts（例 "1784266535.690189"）まわりのヘルパー。
 * スプレッドシートがtsを数値として解釈すると精度落ちで下位桁が失われる
 * （1784266535.690189 → 1784266535.69018）。そのため:
 * - 保存時は 'ts_' 接頭辞を付けて数値化そのものを防ぐ（rawSlackTsで復元）
 * - 照合は文字列一致に加えて、数値としての誤差 0.0001秒以内も同一とみなす
 *   （インタビューは1日1スレッドなので誤衝突は実質起きない）
 */
function rawSlackTs(v) {
  return String(v === null || v === undefined ? '' : v).trim().replace(/^ts_/, '');
}

function normalizeSlackTs(v) {
  var s = rawSlackTs(v);
  if (/^\d+\.\d+$/.test(s)) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

function slackTsEqual(a, b) {
  var na = normalizeSlackTs(a);
  var nb = normalizeSlackTs(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  var fa = parseFloat(na);
  var fb = parseFloat(nb);
  return isFinite(fa) && isFinite(fb) && Math.abs(fa - fb) < 0.0001;
}

/**
 * 時系列窓内でのパーセンタイル化。
 *
 * フォロワー数が数倍に増えていたり、アルゴリズムが変わっていたりすると、
 * 生のインプレッションは時期をまたいで比較できない。そこで各投稿を
 * 「前後windowDays日の投稿の中で上位何%か」に変換して比較可能にする。
 *
 * @param {Array} items [{t: 経過ミリ秒(またはDate.getTime()), v: 値}]
 * @param {number} windowDays 前後何日を比較対象にするか
 * @returns {Array<number>} 各要素のパーセンタイル(0-100)。窓内が1件なら50
 */
function percentileWithinWindow(items, windowDays) {
  var span = (windowDays || 30) * 86400000;
  return items.map(function (self) {
    var peers = items.filter(function (o) { return Math.abs(o.t - self.t) <= span; });
    if (peers.length < 2) return 50;
    var below = 0, ties = 0;
    peers.forEach(function (o) {
      if (o.v < self.v) below++;
      else if (o.v === self.v) ties++;
    });
    // 同値は中間順位として扱う
    return Math.round((below + ties / 2) / peers.length * 1000) / 10;
  });
}

/**
 * Slackのメッセージ本文を素の日本語に戻す。
 *
 * Slackはリンクやメンションを独自記法で送ってくる（`<https://x.com|タイトル>`）。
 * そのまま回答として保存すると、下書きにこの記法が混ざってXへ投稿されてしまう。
 * &amp; などのHTMLエスケープも戻す。
 */
function normalizeSlackText(text) {
  var s = String(text === null || text === undefined ? '' : text);
  s = s.replace(/<(https?:\/\/[^>|]+)\|([^>]*)>/g, '$2 $1'); // リンク＋表示名
  s = s.replace(/<(https?:\/\/[^>]+)>/g, '$1');              // リンクのみ
  s = s.replace(/<mailto:[^>|]+\|([^>]*)>/g, '$1');
  s = s.replace(/<[@#!][^>|]+\|([^>]*)>/g, '$1');            // メンション（表示名つき）
  s = s.replace(/<[@#!]([^>]+)>/g, '@$1');                   // メンション（IDのみ）
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return s.replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * 見出しから「Googleニュースが付ける ' - 媒体名' の接尾辞」を外す。
 */
function stripHeadlineSource(title) {
  var s = String(title === null || title === undefined ? '' : title).trim();
  var m = s.match(/^(.*)\s[-–—]\s[^-–—]{2,40}$/);
  return m ? m[1].trim() : s;
}

/**
 * 見出しを話題ごとにまとめる。
 *
 * 同じ出来事が複数の媒体で報じられているほど、話題として大きい＝
 * 読まれやすい、という前提で「何媒体が扱っているか」を人気の代理指標にする。
 * 実際のインプレッションはRSSからは分からないので、これが得られる最善の近似。
 *
 * 見出しは媒体ごとに言い回しが違うため、完全一致ではなく語の重なり
 * （Jaccard係数）でまとめる。
 *
 * @param {Array} items [{title, ...}]
 * @param {number} threshold 同一話題とみなす重なり（既定0.45）
 * @returns {Array} [{...先頭の要素, dup: 何件まとまったか, variants: [見出し...]}]
 */
function clusterHeadlines(items, threshold) {
  var th = threshold === undefined ? 0.45 : threshold;
  function tokens(t) {
    var s = stripHeadlineSource(t).toLowerCase()
      .replace(/[「」『』（）()【】\[\]"'’”,.、。:：;；!！?？|/\\-]/g, ' ');
    // 英語は単語、日本語は2文字の連なり（bi-gram）で見る
    var out = {};
    s.split(/\s+/).filter(Boolean).forEach(function (w) {
      if (/^[a-z0-9]+$/.test(w)) { if (w.length > 2) out[w] = true; return; }
      for (var i = 0; i + 1 < w.length; i++) out[w.slice(i, i + 2)] = true;
    });
    return Object.keys(out);
  }
  function jaccard(a, b) {
    if (!a.length || !b.length) return 0;
    var set = {};
    a.forEach(function (x) { set[x] = true; });
    var inter = 0;
    b.forEach(function (x) { if (set[x]) inter++; });
    return inter / (a.length + b.length - inter);
  }

  var clusters = [];
  items.forEach(function (it) {
    var tk = tokens(it.title);
    for (var i = 0; i < clusters.length; i++) {
      if (jaccard(clusters[i].tokens, tk) >= th) {
        clusters[i].dup++;
        clusters[i].variants.push(it.title);
        return;
      }
    }
    var c = {};
    Object.keys(it).forEach(function (k) { c[k] = it[k]; });
    c.tokens = tk;
    c.dup = 1;
    c.variants = [it.title];
    clusters.push(c);
  });
  return clusters.map(function (c) {
    delete c.tokens;
    return c;
  });
}

/**
 * テーマ名の同一判定キー。
 *
 * 逆算やNotion同期でテーマが増えると、鉤括弧の有無や空白だけが違う
 * 「ほぼ同じテーマ」が並ぶ。別テーマとして扱うと実測がそこで分断され、
 * どちらも標本不足のまま埋もれる。表記ゆれを潰して同一視する。
 */
function normalizeThemeKey(s) {
  return String(s === null || s === undefined ? '' : s)
    .normalize('NFKC')            // 全角英数・記号を半角へ
    .toLowerCase()
    .replace(/[「」『』（）()"'’”\s]/g, '')
    .replace(/[、。,.\-–—_/・:：;；!！?？]/g, '');
}

/**
 * 日付キーの正規化。シートが日付を日時として返す場合があるため
 * （"2026-07-27" が "2026-07-27 00:00" になる）、先頭のyyyy-MM-dd部分だけを取る。
 */
function dateKey(v) {
  var s = String(v === null || v === undefined ? '' : v).trim();
  var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/**
 * ピアソン相関係数。データ点が2未満・分散0の場合はnull。
 * 自己採点スコアと実測インプレッションの整合チェックに使う。
 */
function pearson(xs, ys) {
  var n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  var sx = 0, sy = 0;
  for (var i = 0; i < n; i++) { sx += Number(xs[i]); sy += Number(ys[i]); }
  var mx = sx / n, my = sy / n;
  var cov = 0, vx = 0, vy = 0;
  for (var j = 0; j < n; j++) {
    var dx = Number(xs[j]) - mx;
    var dy = Number(ys[j]) - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

// Nodeテスト用（GASでは module は未定義なので無視される）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { weightedTweetLength: weightedTweetLength, fitsInTweet: fitsInTweet, parseJsonLoose: parseJsonLoose, salvageJson: salvageJson, pickWeighted: pickWeighted, computeNextSlots: computeNextSlots, normalizeSlackTs: normalizeSlackTs, slackTsEqual: slackTsEqual, rawSlackTs: rawSlackTs, pearson: pearson, dateKey: dateKey, percentileWithinWindow: percentileWithinWindow, normalizeThemeKey: normalizeThemeKey, clusterHeadlines: clusterHeadlines, stripHeadlineSource: stripHeadlineSource, normalizeSlackText: normalizeSlackText };
}
