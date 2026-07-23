/**
 * Quality.js — 品質ゲート
 *
 * 未採点(draft)のストックをClaudeが採点し、
 * 閾値以上 → ready（AUTO_APPROVE=true なら approved）
 * 閾値未満 → stock（捨てずに保持。後で書き直しの種になる）
 */

function runQualityGate() {
  var drafts = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.status) === STATUS.DRAFT;
  });
  if (!drafts.length) {
    logEvent('quality_gate', '採点対象なし');
    return { scored: 0, passed: 0 };
  }

  var threshold = qualityThreshold();
  var samples = getVoiceSamples(10);
  // 実測インプレッションから学習した追加基準（evaluateScoring()が更新する）
  var learnedRubric = getProp('QUALITY_RUBRIC_LEARNED', '');
  var system = [
    'あなたはXアカウント運用の編集長です。ポスト下書きを採点します。',
    '採点基準（各25点、計100点）:',
    '1. 本人らしさ: 下の文体サンプルと同じ人が書いたように読めるか。AIっぽい定型・評論調は大減点',
    '2. 具体性: 固有のエピソード・数字・現場感があるか。一般論だけなら低得点',
    '3. 引き: 続きを読みたくなるか、反応（リプ・いいね）したくなるか',
    '4. 完成度: 誤字・冗長さ・文字数・単体で意味が通るか',
    '',
    learnedRubric ? '実測インプレッションの分析から学習した追加基準（採点に反映すること）:\n' + learnedRubric + '\n' : '',
    (function () { var m = buildMemoryPrompt(); return m ? m + '\n' : ''; })(),
    '文体サンプル:',
    samples.map(function (s, i) { return '--- ' + (i + 1) + ' ---\n' + s; }).join('\n'),
  ].join('\n');

  var user = [
    '以下の下書きを採点してください。',
    '',
    drafts.map(function (d) {
      return 'id: ' + d.id + '\ncategory: ' + d.category + '\n本文:\n' + d.text;
    }).join('\n\n====\n\n'),
    '',
    'JSON配列で出力: [{"id": "...", "score": 0-100の整数, "reason": "採点理由を50字以内で"}]',
  ].join('\n');

  var results = askClaudeJson(system, user, 3000);
  if (!Array.isArray(results)) throw new Error('採点結果の出力が不正です');

  var passed = 0;
  var byId = {};
  results.forEach(function (r) { byId[String(r.id)] = r; });

  drafts.forEach(function (d) {
    var r = byId[String(d.id)];
    if (!r || typeof r.score !== 'number') return;
    var pass = r.score >= threshold;
    if (pass) passed++;
    var newStatus = pass ? (isAutoApprove() ? STATUS.APPROVED : STATUS.READY) : STATUS.STOCK;
    updateStockById(d.id, {
      score: r.score,
      score_reason: String(r.reason || ''),
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
      return 'id: ' + d.id + '\n採点: ' + d.score + '点 / 指摘: ' + d.score_reason + '\n本文:\n' + d.text +
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
