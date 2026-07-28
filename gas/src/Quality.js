/**
 * Quality.js — 品質ゲート
 *
 * 未採点(draft)のストックをClaudeが採点し、
 * 閾値以上 → ready（AUTO_APPROVE=true なら approved）
 * 閾値未満 → stock（捨てずに保持。後で書き直しの種になる）
 */

/** LLMが返した軸スコアを検証して0-100に丸める。1つも取れなければnull */
function compositeAxes(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var out = {};
  var found = 0;
  AXES.forEach(function (a) {
    var v = Number(raw[a.key]);
    if (isFinite(v)) {
      out[a.key] = Math.max(0, Math.min(100, Math.round(v)));
      found++;
    } else {
      out[a.key] = 50; // 欠損は中央値で埋める
    }
  });
  return found >= Math.ceil(AXES.length / 2) ? out : null;
}

/** Stockの axes 列をパースする。壊れていればnull */
function parseAxes(v) {
  if (!v) return null;
  try {
    var o = typeof v === 'string' ? JSON.parse(v) : v;
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}

function runQualityGate() {
  var drafts = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.status) === STATUS.DRAFT;
  });
  if (!drafts.length) {
    logEvent('quality_gate', '採点対象なし');
    return { scored: 0, passed: 0 };
  }

  ensureHeaders(SHEET.STOCK);
  var threshold = qualityThreshold();
  var system = axisScoringSystemPrompt(getVoiceSamples(10), false);

  var user = [
    '以下の下書きを採点してください。',
    '',
    drafts.map(function (d) {
      return 'id: ' + d.id + '\ncategory: ' + d.category + '\n本文:\n' + d.text;
    }).join('\n\n====\n\n'),
    '',
    'JSON配列で出力: [{"id": "...", "axes": {' +
      AXES.map(function (a) { return '"' + a.key + '": 0-100'; }).join(', ') +
      '}, "reason": "最も高い軸と最も低い軸に触れて50字以内で"}]',
  ].join('\n');

  var results = askClaudeJson(system, user, 4000);
  if (!Array.isArray(results)) throw new Error('採点結果の出力が不正です');

  var passed = 0;
  var byId = {};
  results.forEach(function (r) { byId[String(r.id)] = r; });

  drafts.forEach(function (d) {
    var r = byId[String(d.id)];
    if (!r) return;
    var axes = compositeAxes(r.axes);
    if (!axes) return;
    // 全体スコア = 軸スコア · 実測相関ベクトル（0〜100に正規化）
    var score = compositeScoreFromAxes(axes);

    var pass = score >= threshold;
    if (pass) passed++;
    var newStatus = pass ? (isAutoApprove() ? STATUS.APPROVED : STATUS.READY) : STATUS.STOCK;
    updateStockById(d.id, {
      score: score,
      score_reason: String(r.reason || ''),
      axes: JSON.stringify(axes),
      status: newStatus,
    });
    try {
      syncStockRowToNotion(d.id);
    } catch (e) {
      logEvent('notion_error', d.id + ': ' + e);
    }
  });

  logEvent('quality_gate', '採点' + drafts.length + '件 / 合格' + passed + '件（閾値' + threshold + '）');
  return { scored: drafts.length, passed: passed };
}

/**
 * 投稿済みポストへの遡及採点。
 *
 * 相関分析の標本を増やすため、軸スコアが無い投稿済みポストを後から採点する。
 * 合否やステータスは一切変えず、axes列だけを埋める（過去の投稿を今の基準で
 * 落とすのは無意味なため）。
 *
 * GASの実行時間上限（6分）があるので、4分で打ち切って残件があれば
 * 1分後に自分を再実行するワンショットトリガーを仕込む。放置で完走する。
 */
function backfillAxisScores() {
  ensureHeaders(SHEET.STOCK);
  var started = new Date().getTime();
  var budgetMs = 4 * 60 * 1000;
  var batchSize = Number(getProp('BACKFILL_BATCH', '25'));

  var pendingAll = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.status) === STATUS.POSTED && String(r.text).trim() && !parseAxes(r.axes);
  });
  if (!pendingAll.length) {
    clearBackfillTrigger();
    var done = '遡及採点は完了しています（未採点の投稿済みポストなし）';
    logEvent('backfill_axes', done);
    return done;
  }

  var scored = 0;
  var samples = getVoiceSamples(8);
  var system = axisScoringSystemPrompt(samples, true);

  while (new Date().getTime() - started < budgetMs) {
    var batch = pendingAll.slice(scored, scored + batchSize);
    if (!batch.length) break;
    var user = [
      '以下は過去に投稿されたポストです。各軸を採点してください。',
      '',
      batch.map(function (d) {
        return 'id: ' + d.id + '\n本文:\n' + String(d.text).slice(0, 400);
      }).join('\n\n====\n\n'),
      '',
      'JSON配列で出力: [{"id": "...", "axes": {' +
        AXES.map(function (a) { return '"' + a.key + '": 0-100'; }).join(', ') + '}}]',
    ].join('\n');

    var results;
    try {
      results = askClaudeJson(system, user, 4000);
    } catch (e) {
      logEvent('backfill_error', String(e).slice(0, 200));
      break;
    }
    if (!Array.isArray(results)) break;
    var byId = {};
    results.forEach(function (r) { byId[String(r.id)] = r; });
    var writes = [];
    batch.forEach(function (d) {
      var r = byId[String(d.id)];
      var axes = r ? compositeAxes(r.axes) : null;
      if (axes) writes.push({ row: d._row, value: JSON.stringify(axes) });
    });
    // updateStockById は1件ごとに全行を読み直すので、ここでは行番号直指定で書く
    setColumnByRows(SHEET.STOCK, 'axes', writes);
    scored += batch.length;
  }

  var remaining = pendingAll.length - scored;
  logEvent('backfill_axes', scored + '件を採点 / 残り' + remaining + '件');
  if (remaining > 0) {
    scheduleBackfillContinue();
    return scored + '件を採点しました。残り' + remaining + '件は1分後に自動で続行します。';
  }
  clearBackfillTrigger();
  notifySlack(':white_check_mark: 遡及採点が完了しました。軸スコア付きの投稿が増えたので、' +
    'reportAxisAnalysis を実行すると相関が出ます。');
  return scored + '件を採点しました。完了です。';
}

/** 遡及採点の続きを1分後に実行するワンショットトリガーを仕込む */
function scheduleBackfillContinue() {
  clearBackfillTrigger();
  ScriptApp.newTrigger('backfillAxisScores').timeBased().after(60 * 1000).create();
}

function clearBackfillTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backfillAxisScores') ScriptApp.deleteTrigger(t);
  });
}

/** 軸採点の共通systemプロンプト。@param {boolean} terse 遡及採点用に短縮するか */
function axisScoringSystemPrompt(samples, terse) {
  var learnedRubric = getProp('QUALITY_RUBRIC_LEARNED', '');
  return [
    'あなたはXアカウント運用の編集長です。ポストを採点します。',
    'このアカウントの最終目的は「フォロワーを増やすこと」です。いいねが付くことではありません。',
    '',
    '以下の各軸を、それぞれ独立に0〜100点で採点してください。',
    '軸ごとの重み付けはこちらで行うので、あなたは各軸を純粋に評価することに集中してください。',
    '中央値を50とし、平凡なら50前後、際立って良ければ80以上、明確に欠けていれば30以下を付けること。',
    '全部の軸に似た点を付けるのは分析上まったく役に立ちません。軸ごとの差をはっきり付けてください。',
    '',
    AXES.map(function (a, i) {
      return (i + 1) + '. ' + a.key + '（' + a.label + '）: ' + a.desc;
    }).join('\n'),
    '',
    terse ? '' : (learnedRubric ? '実測データの分析から学習した追加基準（採点に反映すること）:\n' + learnedRubric + '\n' : ''),
    terse ? '' : (function () { var m = buildMemoryPrompt(); return m ? m + '\n' : ''; })(),
    '文体サンプル:',
    samples.map(function (s, i) { return '--- ' + (i + 1) + ' ---\n' + s; }).join('\n'),
  ].join('\n');
}

/**
 * 採点 → 不合格分を採点コメントに基づいて自己批判リライト → 再採点、を
 * 最大 REFINE_ROUNDS 回（既定2回）繰り返す。
 * リライト回数は refines 列に記録し、上限に達したものは stock のまま残す。
 */
function runQualityGateWithRefinement() {
  var total = runQualityGate();
  var rounds = Number(getProp('REFINE_ROUNDS', '2'));
  for (var r = 0; r < rounds; r++) {
    var refined = refineFailedDrafts();
    if (!refined) break;
    var g = runQualityGate();
    total.scored += g.scored;
    total.passed += g.passed;
  }
  return total;
}

/**
 * 閾値未満(stock)の下書きを、採点コメントを踏まえて「独り言のつぶやき」へ
 * 書き直し、draftに戻して再採点対象にする。1回の実行で最大10件。
 * @param {boolean} force 上限(REFINE_ROUNDS)到達分も対象にする（手動リライト用）
 */
function refineFailedDrafts(force) {
  ensureHeaders(SHEET.STOCK);
  var maxRefines = Number(getProp('REFINE_ROUNDS', '2'));
  var targets = readTable(SHEET.STOCK).filter(function (r) {
    if (String(r.status) !== STATUS.STOCK) return false;
    return force || Number(r.refines || 0) < maxRefines;
  }).slice(0, 10);
  if (!targets.length) return 0;

  // 捏造防止: 本人がインタビューで実際に話した内容を「一次情報」として渡す
  var qaBySession = {};
  readTable(SHEET.INTERVIEWS).forEach(function (r) {
    if (!String(r.answer || '').trim()) return;
    var sid = String(r.session_id);
    if (!qaBySession[sid]) qaBySession[sid] = [];
    qaBySession[sid].push('Q: ' + r.question + ' / A: ' + r.answer);
  });

  var system = buildStylePrompt();
  var user = [
    '以下は品質ゲートで不合格になったXのポスト下書きと、その採点コメント、',
    'および本人がインタビューで実際に話した一次情報です。指摘を踏まえて書き直してください。',
    '',
    targets.map(function (d) {
      var qa = qaBySession[String(d.session_id)] || [];
      // 弱い軸を名指しして、そこを重点的に直させる
      var ax = parseAxes(d.axes);
      var weak = '';
      if (ax) {
        var sorted = AXES.filter(function (a) { return isFinite(Number(ax[a.key])); })
          .sort(function (a, b) { return Number(ax[a.key]) - Number(ax[b.key]); });
        weak = '\n弱い軸（ここを重点的に直す）: ' + sorted.slice(0, 3).map(function (a) {
          return a.label + ' ' + ax[a.key] + '点';
        }).join(' / ');
      }
      return 'id: ' + d.id + '\n採点: ' + d.score + '点 / 指摘: ' + d.score_reason + weak + '\n本文:\n' + d.text +
        (qa.length ? '\n一次情報（本人の回答）:\n' + qa.join('\n') : '\n一次情報: なし（本文にある事実だけで書き直すこと）');
    }).join('\n\n====\n\n'),
    '',
    'ルール:',
    '- 「質問に答えた文」を「ふと思いついた独り言のつぶやき」に変換する。前置きなしで1行目から本題',
    '- 指摘された弱点（抽象的・評論調・説教臭い・文脈依存など）を具体的に直す',
    '- 【最重要】事実の追加は「一次情報」にあるものだけ。数字・固有名詞・エピソードの捏造は絶対にしない。足せる事実がなければ、盛らずに削って研ぐ',
    '- 教訓やまとめで締めない。本音・オチ・言い切りで終わる',
    '- 元の内容の事実を変えない。全角換算140字以内',
    '- どう直しても良くならないものは "skip": true を返す',
    '',
    'JSON配列で出力: [{"id": "...", "text": "...", "skip": false}]',
  ].join('\n');

  var results = askClaudeJson(system, user, 3000);
  if (!Array.isArray(results)) throw new Error('リライト結果の出力が不正です');
  var byId = {};
  results.forEach(function (r) { byId[String(r.id)] = r; });

  var refined = 0;
  targets.forEach(function (d) {
    var r = byId[String(d.id)];
    var count = Number(d.refines || 0) + 1;
    if (!r || r.skip || !String(r.text || '').trim()) {
      // 改善不能と判断されたものは上限扱いにして毎回のリライト対象から外す
      updateStockById(d.id, { refines: maxRefines });
      return;
    }
    var text = String(r.text).trim();
    if (!fitsInTweet(text)) text = truncateForTweet(text);
    updateStockById(d.id, {
      text: text,
      status: STATUS.DRAFT,
      score: '',
      score_reason: '',
      axes: '',
      refines: count,
    });
    refined++;
  });
  if (refined) logEvent('refine', refined + '件をリライトして再採点へ');
  return refined;
}

/**
 * 夜のトリガー本体: 採点(+リライトループ) → 予約 → Slack通知
 */
function nightlyGateAndSchedule() {
  var gate = runQualityGateWithRefinement();
  var scheduled = scheduleApprovedPosts();

  var stock = readTable(SHEET.STOCK);
  var counts = {};
  stock.forEach(function (r) {
    counts[r.status] = (counts[r.status] || 0) + 1;
  });

  var lines = [
    ':night_with_stars: 品質ゲート結果',
    '採点: ' + gate.scored + '件 / 合格: ' + gate.passed + '件',
    '予約に追加: ' + scheduled.length + '件',
  ];
  scheduled.forEach(function (s) {
    lines.push('・' + s.scheduled_at + ' → ' + s.text.slice(0, 40) + (s.text.length > 40 ? '…' : ''));
  });
  lines.push('');
  lines.push('ストック状況: 承認待ち ' + (counts[STATUS.READY] || 0) + ' / 予約済み ' + (counts[STATUS.SCHEDULED] || 0) + ' / 保留ストック ' + (counts[STATUS.STOCK] || 0));
  if ((counts[STATUS.READY] || 0) > 0 && !isAutoApprove()) {
    var url = getProp('WEBAPP_URL');
    lines.push(url ? '承認はこちら: ' + url + '?token=' + getProp('ADMIN_TOKEN') : '承認はWebアプリから（WEBAPP_URL未設定）');
  }
  notifySlack(lines.join('\n'));
}
