/**
 * Themes.js — テーマプールと日次のテーマ選定
 *
 * category:
 *   evergreen … 定番（仕事観・事業の学び・失敗談など）
 *   news      … 時事ネタ（Googleニュースの見出しと組み合わせる）
 *   neta      … ネタポスト（ゆるい話・あるある・自虐など）
 */

var DEFAULT_THEMES = [
  ['空飛ぶクルマ事業の今日の一歩', 'evergreen', 3, '進捗・学び・現場の話'],
  ['事業開発で最近ぶつかった壁', 'evergreen', 3, '失敗談・悩みは反応されやすい'],
  ['スタートアップ経営の原理原則', 'evergreen', 2, '自分の言葉で言い直す'],
  ['採用・チームづくりで考えていること', 'evergreen', 2, ''],
  ['航空・モビリティ業界の時事', 'news', 3, 'ニュース見出しに一言乗せる'],
  ['テック・AI関連の時事', 'news', 2, '自分の事業との接点で語る'],
  ['今日の時事に一言', 'news', 2, '業界外のニュースでもOK'],
  ['起業家あるある', 'neta', 2, '自虐・ゆるネタ'],
  ['今日あったどうでもいい話', 'neta', 2, '人間味が出るやつ'],
  ['真面目な顔して言う小ネタ', 'neta', 1, 'ギャップ狙い'],
];

function seedThemesIfEmpty() {
  if (readTable(SHEET.THEMES).length > 0) return;
  DEFAULT_THEMES.forEach(function (t) {
    appendRowObj(SHEET.THEMES, { theme: t[0], category: t[1], weight: t[2], last_used: '', notes: t[3] });
  });
}

/**
 * 今日のテーマを選ぶ。定番1 + (時事 or ネタ)1 の計2テーマが基本。
 * 直近3日で使ったテーマは重みを下げる。
 */
function pickThemesForToday() {
  var all = readTable(SHEET.THEMES);
  if (!all.length) throw new Error('Themesシートが空です。setupSpreadsheet() を実行してください');

  var now = nowJst();
  function effectiveWeight(t) {
    var w = Number(t.weight) || 1;
    if (t.last_used) {
      var last = new Date(t.last_used);
      var days = (now.getTime() - last.getTime()) / 86400000;
      if (days < 3) w *= 0.2;
    }
    return w;
  }

  function pickFrom(categories, exclude) {
    var pool = all.filter(function (t) {
      return categories.indexOf(String(t.category)) >= 0 &&
        (Number(t.weight) || 0) > 0 && // 重み0 = 停止テーマは選ばない
        (!exclude || exclude.indexOf(t.theme) < 0);
    });
    if (!pool.length) return null;
    return pickWeighted(pool, effectiveWeight);
  }

  var picked = [];
  var evergreen = pickFrom(['evergreen']);
  if (evergreen) picked.push(evergreen);
  // 時事とネタは日替わりでどちらかに寄せる（両方ある日も作る）
  var second = pickFrom(['news', 'neta'], picked.map(function (t) { return t.theme; }));
  if (second) picked.push(second);

  picked.forEach(function (t) {
    updateRowsWhere(SHEET.THEMES, 'theme', t.theme, { last_used: fmtDate(now) });
  });
  return picked.map(function (t) {
    return { theme: String(t.theme), category: String(t.category), notes: String(t.notes || '') };
  });
}

/**
 * テーマごとの実績を集計する。
 *
 * 成果の見方は手に入る順に落としていく:
 *   1. 投稿済み＆インプレッションあり → 前後30日の投稿内での順位(0-100)
 *   2. 採点済み                       → 合成スコア(0-100)
 * 1と2は尺度が違うので混ぜたくはないが、投稿までいっていないテーマを
 * 「実績なし」で放置すると、たまたま最初に選ばれたテーマだけが伸び続ける。
 * 実測がある投稿だけを使い、無いテーマは据え置く（重みを動かさない）。
 */
function themePerformance() {
  var rows = readTable(SHEET.STOCK).filter(function (r) {
    if (String(r.promoted) === 'yes' && r.paid_impressions === '') return false;
    return String(r.theme).trim();
  });

  var measured = rows.filter(function (r) {
    return String(r.status) === STATUS.POSTED && Number(r.impressions || 0) > 0 && r.posted_at;
  });
  var pct = percentileWithinWindow(measured.map(function (r) {
    return { t: new Date(String(r.posted_at).replace(' ', 'T') + ':00+09:00').getTime(), v: Number(r.impressions) };
  }), 30);

  var byTheme = {};
  measured.forEach(function (r, i) {
    var key = String(r.theme);
    if (!byTheme[key]) byTheme[key] = { sum: 0, n: 0 };
    byTheme[key].sum += pct[i];
    byTheme[key].n++;
  });

  var out = {};
  var all = [];
  Object.keys(byTheme).forEach(function (k) {
    var perf = byTheme[k].sum / byTheme[k].n;
    out[k] = { perf: perf, n: byTheme[k].n };
    all.push(perf);
  });
  // 全体平均は「テーマ平均の平均」ではなく実測全体の中央値50（パーセンタイルの定義上）
  return { byTheme: out, mean: 50, themeCount: all.length };
}

/**
 * 実績からテーマの重みを更新する（週次から呼ばれる。手動実行も可）。
 *
 * base_weight を起点に、実績が平均(50)からどれだけ離れているかで増減する。
 * 前回の重みに掛け続けると発散するので、必ず base_weight から計算し直す。
 * 標本が少ないテーマは n/(n+K) で効果を薄める。
 */
function updateThemeWeights() {
  ensureHeaders(SHEET.THEMES);
  var perf = themePerformance();
  var K = Number(getProp('THEME_SHRINKAGE_K', '5'));
  var span = Number(getProp('THEME_WEIGHT_SPAN', '20')); // 平均から何点ずれたら重み2倍か
  var rows = readTable(SHEET.THEMES);
  var changes = [];

  rows.forEach(function (t) {
    var name = String(t.theme);
    // 初回は現在の重みを base_weight として固定する
    var base = Number(t.base_weight);
    if (!isFinite(base) || base <= 0) {
      base = Number(t.weight) || 1;
      updateRowsWhere(SHEET.THEMES, 'theme', name, { base_weight: base });
    }
    var p = perf.byTheme[name];
    if (!p) return; // 実測が無いテーマは据え置く

    var shrink = p.n / (p.n + K);
    var w = base * (1 + shrink * (p.perf - perf.mean) / span);
    w = Math.max(0.3, Math.min(base * 3, Math.round(w * 10) / 10));
    var before = Number(t.weight) || 0;
    updateRowsWhere(SHEET.THEMES, 'theme', name, {
      weight: w,
      perf: Math.round(p.perf * 10) / 10,
      perf_n: p.n,
    });
    if (Math.abs(w - before) >= 0.1) {
      changes.push({ theme: name, from: before, to: w, perf: Math.round(p.perf), n: p.n });
    }
  });

  logEvent('theme_weights', changes.length + '件を更新');
  return { changes: changes, measured: perf.themeCount };
}

/** テーマ重みの更新結果をSlackに投げる */
function reportThemeWeights() {
  var r = updateThemeWeights();
  if (!r.changes.length) {
    var msg = ':dart: テーマ重み: 変更なし（実測のあるテーマ' + r.measured + '件）';
    notifySlack(msg);
    return msg;
  }
  var lines = [':dart: *テーマ重みを実績で更新しました*（実測のあるテーマ' + r.measured + '件）', ''];
  r.changes.sort(function (a, b) { return b.to - a.to; }).forEach(function (c) {
    lines.push((c.to > c.from ? ':arrow_up:' : ':arrow_down:') + ' ' + c.theme +
      ': ' + c.from + ' → ' + c.to + '（窓内順位の平均' + c.perf + '点 / n=' + c.n + '）');
  });
  lines.push('');
  lines.push('重みが上がったテーマほど、翌朝のインタビューで選ばれやすくなります。');
  notifySlack(lines.join('\n'));
  return lines.join('\n');
}
