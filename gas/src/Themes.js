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
 * 手動投稿から、テーマと「この投稿を引き出せたであろう質問」を逆算する。
 *
 * 取り込んだ過去の投稿は theme が「手動投稿」で一括りなので、そのままでは
 * テーマ重みの学習に一切使えない（実測の大半がここに死蔵されている）。
 * 既存のテーマ一覧に当てはめ直すことで、404件ぶんの実測がテーマ別に効く
 * ようになる。あわせて質問も推定し、実際に伸びた投稿を生んだ聞き方を
 * 翌朝の質問生成の手本にする。
 *
 * GASの実行時間上限があるので4分で打ち切り、残件があれば1分後に自分を
 * 再実行する。二重実行はロックで弾く。
 */
function inferManualPostSources() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(100)) {
    var busy = 'テーマ逆算は既に実行中です';
    logEvent('infer_themes', busy);
    return busy;
  }
  try {
    return inferManualPostSourcesLocked();
  } finally {
    lock.releaseLock();
  }
}

function inferManualPostSourcesLocked() {
  ensureHeaders(SHEET.STOCK);
  ensureHeaders(SHEET.THEMES); // 新テーマの追加で base_weight を書くため
  clearInferTrigger();
  var started = new Date().getTime();
  var budgetMs = 4 * 60 * 1000;
  var batchSize = Number(getProp('INFER_BATCH', '20'));

  var themes = readTable(SHEET.THEMES).filter(function (t) { return String(t.theme).trim(); });
  if (!themes.length) throw new Error('Themesシートが空です');

  var pendingAll = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.category) === 'manual' && String(r.text).trim() && !String(r.inferred_question || '').trim();
  });
  if (!pendingAll.length) {
    var done = 'テーマ逆算は完了しています（未処理の手動投稿なし）';
    logEvent('infer_themes', done);
    return done;
  }

  var system = [
    'あなたはXアカウントの運用担当です。過去に投稿されたポストを見て、',
    '「このポストは、どのテーマについて、どんな質問をされたら出てきた話か」を推定します。',
    '',
    'テーマ一覧（この番号から選ぶ）:',
    themes.map(function (t, i) { return i + ': ' + t.theme + '（' + t.category + '）'; }).join('\n'),
    '',
    '判断のルール:',
    '- どのテーマにも当てはまらない場合だけ t を -1 にして、new に新しいテーマ名を書く',
    '- 無理に既存テーマへ押し込まない。逆に、少し違う程度なら既存を選ぶ',
    '- q は「毎朝ゆるく聞く質問」の形にする。40字以内、話し言葉、その場で思い出せることを聞く形',
    '- q はそのポストの内容を言い当てるのではなく、その話を引き出せる聞き方にする',
  ].join('\n');

  var processed = 0, cursor = 0;
  var proposals = {};

  while (new Date().getTime() - started < budgetMs) {
    var batch = pendingAll.slice(cursor, cursor + batchSize);
    if (!batch.length) break;
    var user = [
      '以下のポストを判定してください。',
      '',
      batch.map(function (d) { return 'id: ' + d.id + '\n' + String(d.text).slice(0, 300); }).join('\n\n====\n\n'),
      '',
      'JSON配列で出力: [{"id":"...","t":テーマ番号,"c":"evergreen|news|neta","q":"推定質問","new":"新テーマ名(tが-1のときだけ)"}]',
    ].join('\n');

    var results = null;
    try {
      results = askClaudeJsonSalvageable(system, user, 8000);
    } catch (e) {
      logEvent('infer_error', String(e).slice(0, 300));
      if (isFatalError(e)) break; // 残高切れ等。バッチを縮めても直らない
    }
    if (!Array.isArray(results)) {
      if (batchSize > 5) { batchSize = Math.floor(batchSize / 2); continue; }
      break;
    }

    var byId = {};
    results.forEach(function (r) { if (r && r.id !== undefined) byId[String(r.id)] = r; });

    // updateStockById は1件ごとに全行を読み直すため、数百件では実行時間が
    // 持たない。readTable が持っている行番号を使って直接書く
    var themeWrites = [], questionWrites = [];
    batch.forEach(function (d) {
      var r = byId[String(d.id)];
      if (!r) return;
      var idx = Number(r.t);
      var theme;
      if (isFinite(idx) && idx >= 0 && idx < themes.length) {
        theme = String(themes[idx].theme);
      } else if (String(r['new'] || '').trim()) {
        theme = String(r['new']).trim();
        proposals[theme] = (proposals[theme] || 0) + 1;
      } else {
        return;
      }
      // category は manual のまま残す（生成投稿と区別できなくなるため）
      themeWrites.push({ row: d._row, value: theme });
      questionWrites.push({ row: d._row, value: String(r.q || '').slice(0, 200) });
    });
    setColumnByRows(SHEET.STOCK, 'theme', themeWrites);
    setColumnByRows(SHEET.STOCK, 'inferred_question', questionWrites);
    var writes = themeWrites.length;

    if (!writes) {
      if (batchSize > 5) { batchSize = Math.floor(batchSize / 2); continue; }
      logEvent('infer_error', '最小バッチでも判定できませんでした（cursor=' + cursor + '）');
      break;
    }
    processed += writes;
    cursor += batch.length;
    logEvent('infer_themes', '進捗 ' + processed + '/' + pendingAll.length + '件（経過' +
      Math.round((new Date().getTime() - started) / 1000) + '秒）');
  }

  addProposedThemes(proposals);
  var remaining = pendingAll.length - processed;
  if (remaining > 0 && processed > 0) {
    scheduleInferContinue();
    return processed + '件を判定しました。残り' + remaining + '件は1分後に自動で続行します。';
  }
  if (remaining > 0) {
    var stuck = 'テーマ逆算が進みませんでした（残り' + remaining + '件）。Logの infer_error を確認してください。';
    notifySlack(':warning: ' + stuck);
    return stuck;
  }
  notifySlack(':white_check_mark: 手動投稿のテーマ逆算が完了しました（' + processed + '件）。\n' +
    'reportThemeWeights を実行すると、これらの実測がテーマ重みに反映されます。');
  return processed + '件を判定しました。完了です。';
}

/**
 * 逆算中に提案された新テーマを Themes に追加する。
 * 1〜2件しか当てはまらない思いつきを増やしても選定が薄まるだけなので、
 * 一定数以上まとまったものだけを採用する。
 */
function addProposedThemes(proposals) {
  var min = Number(getProp('NEW_THEME_MIN_POSTS', '3'));
  // 表記ゆれ違いの既存テーマを増やさないよう、正規化して突き合わせる
  var existing = {};
  readTable(SHEET.THEMES).forEach(function (t) { existing[normalizeThemeKey(t.theme)] = true; });
  var added = [];
  Object.keys(proposals).forEach(function (name) {
    var key = normalizeThemeKey(name);
    if (existing[key] || proposals[name] < min) return;
    existing[key] = true; // 同じ実行内での重複も防ぐ
    appendRowObj(SHEET.THEMES, {
      theme: name, category: 'evergreen', weight: 2, last_used: '',
      notes: '手動投稿から逆算して追加（' + proposals[name] + '件）',
      base_weight: 2, perf: '', perf_n: '',
    });
    added.push(name + '(' + proposals[name] + '件)');
  });
  if (added.length) {
    logEvent('theme_added', added.join(', '));
    notifySlack(':new: 過去の投稿から新しいテーマを見つけました: ' + added.join('、'));
  }
  return added;
}

function scheduleInferContinue() {
  clearInferTrigger();
  ScriptApp.newTrigger('inferManualPostSources').timeBased().after(60 * 1000).create();
}

function clearInferTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'inferManualPostSources') ScriptApp.deleteTrigger(t);
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

  // 表記ゆれで実測が分断されないよう、正規化したキーで集計する
  var byTheme = {};
  measured.forEach(function (r, i) {
    var key = normalizeThemeKey(r.theme);
    if (!key) return;
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
 * base_weight（手で決めた初期値）を起点にするが、**標本が増えるほど
 * base_weight から離れて中立値へ寄せる**。手の勘をいつまでも起点に
 * 残すと、証拠が47件あるテーマが証拠2件のテーマより軽い、という
 * 逆転が起きる（実際に起きた）。
 *
 *   s      = n / (n + K)                      証拠の強さ 0〜1
 *   anchor = base * (1 - s) + 中立値 * s       証拠が増えたら手の勘を捨てる
 *   w      = anchor * (1 + s * (perf - 50) / span)
 *
 * 前回の重みに掛け続けると発散するので、必ず base_weight から計算し直す。
 */
function updateThemeWeights() {
  ensureHeaders(SHEET.THEMES);
  var perf = themePerformance();
  var K = Number(getProp('THEME_SHRINKAGE_K', '10'));
  var span = Number(getProp('THEME_WEIGHT_SPAN', '20')); // 平均から何点ずれたら重み2倍か
  var neutral = Number(getProp('THEME_NEUTRAL_WEIGHT', '2'));
  var rows = readTable(SHEET.THEMES);
  var changes = [];

  rows.forEach(function (t) {
    var name = String(t.theme);
    if (Number(t.weight) === 0) return; // 統合済み・停止テーマは触らない
    // 初回は現在の重みを base_weight として固定する
    var base = Number(t.base_weight);
    if (!isFinite(base) || base <= 0) {
      base = Number(t.weight) || 1;
      updateRowsWhere(SHEET.THEMES, 'theme', name, { base_weight: base });
    }
    var p = perf.byTheme[normalizeThemeKey(name)];
    if (!p) return; // 実測が無いテーマは据え置く

    var shrink = p.n / (p.n + K);
    var anchor = base * (1 - shrink) + neutral * shrink;
    var w = anchor * (1 + shrink * (p.perf - perf.mean) / span);
    w = Math.max(0.3, Math.min(neutral * 3, Math.round(w * 10) / 10));
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

/**
 * 表記ゆれで重複したテーマを統合する。
 *
 * 「空飛ぶクルマの本命は『医療・緊急』だと思う理由」と
 * 「空飛ぶクルマの本命は医療・緊急だと思う理由」のように、鉤括弧の
 * 有無だけが違うテーマが並ぶと、実測がそこで分断される。
 *
 * 行は消さない（手で書いたnotesが失われるため）。Stockのtheme列を
 * 代表名に寄せたうえで、重複側は weight=0 の停止テーマにする。
 * pickThemesForToday は weight<=0 を選ばないので、これで実質統合される。
 */
function mergeDuplicateThemes() {
  ensureHeaders(SHEET.THEMES);
  var rows = readTable(SHEET.THEMES);
  var groups = {};
  rows.forEach(function (t) {
    var key = normalizeThemeKey(t.theme);
    if (!key) return;
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  // Stock側の件数を数えて、実測が多い方を代表にする
  var stock = readTable(SHEET.STOCK);
  var counts = {};
  stock.forEach(function (r) {
    var k = String(r.theme);
    if (k) counts[k] = (counts[k] || 0) + 1;
  });

  var merged = [];
  Object.keys(groups).forEach(function (key) {
    var g = groups[key];
    if (g.length < 2) return;
    g.sort(function (a, b) { return (counts[String(b.theme)] || 0) - (counts[String(a.theme)] || 0); });
    var keep = String(g[0].theme);
    var drop = g.slice(1).map(function (t) { return String(t.theme); });

    // Stockのtheme列を代表名に寄せる
    var writes = [];
    stock.forEach(function (r) {
      if (drop.indexOf(String(r.theme)) >= 0) writes.push({ row: r._row, value: keep });
    });
    setColumnByRows(SHEET.STOCK, 'theme', writes);

    drop.forEach(function (name) {
      updateRowsWhere(SHEET.THEMES, 'theme', name, {
        weight: 0,
        notes: '「' + keep + '」に統合（表記ゆれ）',
      });
    });
    merged.push({ keep: keep, drop: drop, moved: writes.length });
  });

  logEvent('theme_merge', merged.length + '組を統合');
  return merged;
}

/** 重複テーマの統合結果をSlackに投げる */
function reportDuplicateThemes() {
  var merged = mergeDuplicateThemes();
  if (!merged.length) {
    var msg = ':broom: 表記ゆれで重複したテーマはありませんでした';
    notifySlack(msg);
    return msg;
  }
  var lines = [':broom: *重複テーマを統合しました*', ''];
  merged.forEach(function (m) {
    lines.push('「' + m.keep + '」← ' + m.drop.map(function (d) { return '「' + d + '」'; }).join('、') +
      '（ポスト' + m.moved + '件を付け替え）');
  });
  lines.push('');
  lines.push('統合された側は重み0の停止テーマにしてあります。行は残っているので、間違っていれば手で戻せます。');
  notifySlack(lines.join('\n'));
  return lines.join('\n');
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
