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
 * 今日のテーマを選ぶ。時事1 + それ以外1 の計2テーマ。
 *
 * 時事枠は必ず1つ入れる。トレンドは鮮度が命で、翌週には語る意味が
 * 無くなるため、重み抽選に任せて出ない日が続くのを避ける。
 * 選定対象はスタメン（roster が入っている行）に限る。スタメンが
 * まだ無い場合は全テーマから選ぶ（初回や rotateThemeRoster 未実行時）。
 * 直近3日で使ったテーマは重みを下げる。
 */
function pickThemesForToday() {
  var all = readTable(SHEET.THEMES);
  if (!all.length) throw new Error('Themesシートが空です。setupSpreadsheet() を実行してください');

  var starters = all.filter(function (t) { return String(t.roster || '').trim(); });
  var pool0 = starters.length ? starters : all;

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

  function pickFrom(filter, exclude) {
    var pool = pool0.filter(function (t) {
      return filter(t) &&
        (Number(t.weight) || 0) > 0 && // 重み0 = 停止テーマは選ばない
        (!exclude || exclude.indexOf(t.theme) < 0);
    });
    if (!pool.length) return null;
    return pickWeighted(pool, effectiveWeight);
  }

  var picked = [];
  // 1. 時事枠を確保する。今週の trend 枠 → 無ければ news カテゴリ
  var trend = pickFrom(function (t) { return String(t.roster) === 'trend'; }) ||
    pickFrom(function (t) { return String(t.category) === 'news'; });
  if (trend) picked.push(trend);

  // 2. もう1つは時事以外から
  var exclude = picked.map(function (t) { return t.theme; });
  var second = pickFrom(function (t) {
    return String(t.roster) !== 'trend' && String(t.category) !== 'news';
  }, exclude) || pickFrom(function () { return true; }, exclude);
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

/**
 * スタメン100件の入れ替え（週1回）。
 *
 * 探索と活用を分けて持つ。上位50は実績で残し、下位50は毎週総取り替えする。
 *   core     50件  実績上位。活用
 *   adjacent 10件  上位に似ているが同一ではないテーマ。近傍の探索
 *   random   20件  実績と無関係に選ぶ。遠方の探索（局所解に嵌らないため）
 *   trend    20件  時事・トレンド。鮮度が命なので毎週必ず入れ替える
 *
 * 実測が無いテーマは順位付けの中央（50点）に置く。試されないまま
 * 消えることも、根拠なく上位に居座ることもないようにするため。
 */
function rotateThemeRoster() {
  ensureHeaders(SHEET.THEMES);
  var sizes = {
    core: Number(getProp('ROSTER_CORE', '50')),
    adjacent: Number(getProp('ROSTER_ADJACENT', '10')),
    random: Number(getProp('ROSTER_RANDOM', '20')),
    trend: Number(getProp('ROSTER_TREND', '20')),
  };
  var K = Number(getProp('THEME_SHRINKAGE_K', '10'));
  var today = fmtDate(nowJst());
  var perf = themePerformance();
  var rows = readTable(SHEET.THEMES).filter(function (t) { return String(t.theme).trim(); });

  // 時事枠は鮮度が命なので、実績に関係なく毎週ベンチへ落とす
  var candidates = rows.filter(function (t) {
    return Number(t.weight) !== 0 && String(t.roster) !== 'trend';
  });

  function score(t) {
    var p = perf.byTheme[normalizeThemeKey(t.theme)];
    if (!p) return 50; // 実測なしは中央
    var s = p.n / (p.n + K);
    return 50 + s * (p.perf - 50); // 標本が少ないほど50へ寄せる
  }
  candidates.sort(function (a, b) { return score(b) - score(a); });

  var core = candidates.slice(0, sizes.core);
  var coreNames = {};
  core.forEach(function (t) { coreNames[normalizeThemeKey(t.theme)] = true; });

  // まずスタメンを全部降ろす（あとで書き戻す）
  var demoted = [];
  rows.forEach(function (t) {
    if (String(t.roster) && !coreNames[normalizeThemeKey(t.theme)]) demoted.push(String(t.theme));
  });
  demoted.forEach(function (name) {
    updateRowsWhere(SHEET.THEMES, 'theme', name, { roster: '' });
  });
  core.forEach(function (t) {
    updateRowsWhere(SHEET.THEMES, 'theme', String(t.theme), { roster: 'core' });
  });

  // 下位50を作り直す
  var taken = {};
  rows.forEach(function (t) { taken[normalizeThemeKey(t.theme)] = true; });
  var added = { adjacent: [], random: [], trend: [] };

  // A. 上位に似ているが同一ではないテーマ
  var topNames = core.slice(0, 15).map(function (t) { return String(t.theme); });
  added.adjacent = draftThemes('adjacent', sizes.adjacent, {
    top: topNames,
    notes: core.slice(0, 15).map(function (t) { return String(t.notes || ''); }),
  }, taken, today);

  // B. 無作為。まずベンチに眠っているテーマから引き、足りなければ新規に作る
  var bench = rows.filter(function (t) {
    return !String(t.roster) && Number(t.weight) !== 0 && !coreNames[normalizeThemeKey(t.theme)];
  });
  shuffleInPlace(bench);
  var revived = bench.slice(0, sizes.random);
  revived.forEach(function (t) {
    updateRowsWhere(SHEET.THEMES, 'theme', String(t.theme), { roster: 'random', drafted_at: today });
    added.random.push(String(t.theme));
  });
  if (added.random.length < sizes.random) {
    added.random = added.random.concat(
      draftThemes('random', sizes.random - added.random.length, {}, taken, today));
  }

  // C. 時事・トレンド。実際の見出しから具体的なテーマに落とす
  var headlines = [];
  try {
    headlines = fetchNewsHeadlines(20);
  } catch (e) {
    logEvent('roster_error', 'ニュース取得に失敗: ' + String(e).slice(0, 200));
  }
  added.trend = draftThemes('trend', sizes.trend, { headlines: headlines }, taken, today);

  var summary = {
    core: core.length, adjacent: added.adjacent.length,
    random: added.random.length, trend: added.trend.length, demoted: demoted.length,
  };
  logEvent('roster_rotate', JSON.stringify(summary));
  return { summary: summary, added: added, core: core.map(function (t) { return String(t.theme); }) };
}

/** 配列をその場でシャッフルする（Fisher-Yates） */
function shuffleInPlace(a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * 枠の性格に合わせてテーマを生成し、Themesへ追加する。
 * すでにある名前（表記ゆれ含む）は捨てて、重複を増やさない。
 */
function draftThemes(kind, count, ctx, taken, today) {
  if (count <= 0) return [];
  var prompts = {
    adjacent: [
      '以下は、実測でよく読まれているテーマです。',
      (ctx.top || []).map(function (t, i) { return '- ' + t + (ctx.notes && ctx.notes[i] ? '（' + ctx.notes[i] + '）' : ''); }).join('\n'),
      '',
      'これらに**隣接するが同一ではない**テーマを' + count + '件作ってください。',
      '- 言い換えや細分化ではなく、切り口・場面・登場人物を変えたもの',
      '- 上のテーマをそのまま繰り返すものは不可',
    ].join('\n'),
    random: [
      'テーマを' + count + '件、**実績や過去の傾向とは無関係に**作ってください。',
      '- 話し手は空飛ぶクルマ（eVTOL）を開発するスタートアップの経営者',
      '- 事業の話に寄せすぎない。日常・趣味・歴史・技術・人間関係・失敗・食など幅広く',
      '- まだ試していない切り口を狙う。当たるかどうかは考えなくてよい',
    ].join('\n'),
    trend: [
      (ctx.headlines && ctx.headlines.length
        ? '今日のニュース見出し:\n' + ctx.headlines.map(function (h) { return '- ' + h; }).join('\n')
        : '（見出しは取得できませんでした。一般的な時事の切り口で構いません）'),
      '',
      '時事・トレンドのテーマを' + count + '件作ってください。',
      '- 見出しの受け売りではなく、当事者として語れる角度に落とす',
      '- 大企業の既出ニュースより、国際ニュースや小さなスタートアップの話を優先',
      '- 1週間で鮮度が切れて構わない。具体的であるほどよい',
    ].join('\n'),
  };

  var system = [
    'あなたはXアカウントの運用担当で、毎朝のインタビューのテーマ案を作ります。',
    '話し手は空飛ぶクルマ（eVTOL）を開発するスタートアップの経営者です。',
    '',
    'テーマの条件:',
    '- 30字以内。何について話すかが一読で分かること',
    '- notes には「何を聞けば良いポストになるか」を40字以内で書く',
    '- category は evergreen（定番）/ news（時事）/ neta（ゆるい話）のいずれか',
    '- その場で思い出して話せる粒度にする。調べないと答えられないテーマは不可',
  ].join('\n');

  var user = prompts[kind] + '\n\nJSON配列で出力: [{"theme":"...","category":"evergreen|news|neta","notes":"..."}]';

  var results = null;
  try {
    results = askClaudeJsonSalvageable(system, user, 4000);
  } catch (e) {
    logEvent('roster_error', kind + ': ' + String(e).slice(0, 300));
    return [];
  }
  if (!Array.isArray(results)) return [];

  var added = [];
  results.forEach(function (r) {
    if (added.length >= count) return;
    var name = String(r && r.theme || '').trim();
    var key = normalizeThemeKey(name);
    if (!name || !key || taken[key]) return;
    taken[key] = true;
    appendRowObj(SHEET.THEMES, {
      theme: name,
      // 時事枠は必ず news にする。startDailyInterview が news の有無で
      // ニュース見出しを取りに行くかどうかを決めているため
      category: kind === 'trend' ? 'news'
        : (['evergreen', 'news', 'neta'].indexOf(String(r.category)) >= 0 ? String(r.category) : 'evergreen'),
      weight: 2, last_used: '', notes: String(r.notes || '').slice(0, 120),
      base_weight: 2, perf: '', perf_n: '', roster: kind, drafted_at: today,
    });
    added.push(name);
  });
  return added;
}

/**
 * 週1回のテーマ整備。メモの書き直し → スタメン入れ替えの順に実行する。
 *
 * weeklyMetricsReport とは別トリガーにしている。どちらもLLMを何度も
 * 呼ぶので、1つの実行にまとめると6分の上限に当たるため。
 * メモを先に直すのは、隣接テーマの生成が上位テーマのメモを参考にするから。
 */
function weeklyThemeMaintenance() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(100)) return 'テーマ整備は既に実行中です';
  try {
    try {
      reportThemeNotes();
    } catch (e) {
      logEvent('theme_notes_error', String(e).slice(0, 300));
    }
    return reportThemeRoster();
  } finally {
    lock.releaseLock();
  }
}

/** スタメン入れ替えの結果をSlackに投げる（週次から呼ばれる） */
function reportThemeRoster() {
  var r = rotateThemeRoster();
  var s = r.summary;
  var lines = [
    ':repeat: *テーマのスタメンを入れ替えました*',
    'core ' + s.core + ' / 隣接 ' + s.adjacent + ' / 無作為 ' + s.random + ' / 時事 ' + s.trend +
      '（ベンチへ ' + s.demoted + '件）',
    '',
    '*上位10テーマ*',
  ];
  r.core.slice(0, 10).forEach(function (t, i) { lines.push((i + 1) + '. ' + t); });
  if (r.added.trend.length) {
    lines.push('');
    lines.push('*今週の時事枠*（毎朝のインタビューに必ず1問入ります）');
    r.added.trend.slice(0, 8).forEach(function (t) { lines.push('- ' + t); });
  }
  if (r.added.adjacent.length) {
    lines.push('');
    lines.push('*上位に隣接する新テーマ*');
    r.added.adjacent.forEach(function (t) { lines.push('- ' + t); });
  }
  notifySlack(lines.join('\n'));
  return lines.join('\n');
}

/**
 * notes を実測に合わせて書き直す。
 *
 * notes は質問生成のプロンプトにそのまま渡っている。手で書いた
 * 「失敗談は強い」のような想定が外れていると、外れた方向へ質問が
 * 誘導され続ける（実測では失敗談3テーマとも平均以下だった）。
 * 実測が溜まったテーマだけ、実際に伸びた/沈んだポストを見せて書き直す。
 *
 * 出典の括弧書きは残す（どこから来たテーマか分からなくなるため）。
 */
function refreshThemeNotes(minSamples) {
  ensureHeaders(SHEET.THEMES);
  var min = Number(minSamples || getProp('NOTES_MIN_SAMPLES', '5'));
  var perf = themePerformance();
  var themes = readTable(SHEET.THEMES).filter(function (t) {
    if (Number(t.weight) === 0) return false;
    var p = perf.byTheme[normalizeThemeKey(t.theme)];
    return p && p.n >= min;
  });
  if (!themes.length) return '書き直す対象がありません（実測' + min + '件以上のテーマなし）';

  // テーマごとに、実際に伸びた例と沈んだ例を1つずつ添える
  var samples = themeSamples();
  var axisHint = axisGuidanceForQuestions();

  var system = [
    'あなたはXアカウントの運用担当です。テーマごとの「メモ」を書き直します。',
    'メモは翌朝のインタビューの質問を作るときに、そのまま参考として渡されます。',
    '',
    '書き方のルール:',
    '- 40字以内。何を聞けばそのテーマの良いポストになるかを、実測に沿って書く',
    '- 実測が想定と食い違っているテーマでは、はっきり方向転換を書く',
    '- 「（出典: ◯◯）」の括弧書きが元のメモにあれば、末尾にそのまま残す',
    '- 精神論ではなく、聞き方の指示にする（例:「数字と固有名詞を必ず聞く」）',
    '',
    axisHint,
  ].join('\n');

  var updated = [];
  for (var i = 0; i < themes.length; i += 12) {
    var chunk = themes.slice(i, i + 12);
    var user = [
      '以下のテーマのメモを書き直してください。',
      'perfは「そのテーマの投稿が、同時期の投稿の中で上位何%に入ったか」の平均です。50が平均。',
      '',
      chunk.map(function (t, j) {
        var p = perf.byTheme[normalizeThemeKey(t.theme)];
        var s = samples[normalizeThemeKey(t.theme)] || {};
        return [
          j + ': ' + t.theme,
          '  現在のメモ: ' + (t.notes || '（なし）'),
          '  実測: perf ' + Math.round(p.perf) + '点 / n=' + p.n,
          s.best ? '  伸びた例: ' + String(s.best).slice(0, 120) : '',
          s.worst ? '  沈んだ例: ' + String(s.worst).slice(0, 120) : '',
        ].filter(Boolean).join('\n');
      }).join('\n\n'),
      '',
      'JSON配列で出力: [{"i": 番号, "notes": "書き直したメモ"}]',
    ].join('\n');

    var results = null;
    try {
      results = askClaudeJsonSalvageable(system, user, 4000);
    } catch (e) {
      logEvent('notes_error', String(e).slice(0, 300));
      if (isFatalError(e)) break;
      continue;
    }
    if (!Array.isArray(results)) continue;
    results.forEach(function (r) {
      var t = chunk[Number(r.i)];
      var note = String(r.notes || '').trim();
      if (!t || !note) return;
      updateRowsWhere(SHEET.THEMES, 'theme', String(t.theme), { notes: note });
      updated.push({ theme: String(t.theme), before: String(t.notes || ''), after: note });
    });
  }

  logEvent('theme_notes', updated.length + '件のメモを更新');
  return updated;
}

/** テーマごとに、実測がいちばん高い投稿と低い投稿の本文を拾う */
function themeSamples() {
  var rows = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.theme).trim() && r.posted_at && Number(r.impressions || 0) > 0 &&
      !(String(r.promoted) === 'yes' && r.paid_impressions === '');
  });
  var pct = percentileWithinWindow(rows.map(function (r) {
    return { t: new Date(String(r.posted_at).replace(' ', 'T') + ':00+09:00').getTime(), v: Number(r.impressions) };
  }), 30);
  var out = {};
  rows.forEach(function (r, i) {
    var key = normalizeThemeKey(r.theme);
    if (!out[key]) out[key] = { hi: -1, lo: 101 };
    if (pct[i] > out[key].hi) { out[key].hi = pct[i]; out[key].best = r.text; }
    if (pct[i] < out[key].lo) { out[key].lo = pct[i]; out[key].worst = r.text; }
  });
  return out;
}

/** メモの書き直し結果をSlackに投げる */
function reportThemeNotes() {
  var updated = refreshThemeNotes();
  if (typeof updated === 'string') { notifySlack(':memo: ' + updated); return updated; }
  if (!updated.length) {
    var msg = ':memo: メモの更新はありませんでした';
    notifySlack(msg);
    return msg;
  }
  var lines = [':memo: *テーマのメモを実測に合わせて書き直しました*（' + updated.length + '件）', ''];
  updated.slice(0, 15).forEach(function (u) {
    lines.push('*' + u.theme + '*\n  旧: ' + (u.before || '（なし）') + '\n  新: ' + u.after);
  });
  if (updated.length > 15) lines.push('…ほか' + (updated.length - 15) + '件');
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
