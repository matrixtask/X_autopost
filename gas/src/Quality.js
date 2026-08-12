/**
 * Quality.js — 品質ゲート
 *
 * 未採点(draft)のストックをClaudeが採点し、
 * 閾値以上 → ready（AUTO_APPROVE=true なら approved）
 * 閾値未満 → stock（捨てずに保持。後で書き直しの種になる）
 */

/**
 * LLMが返した軸スコアを検証して0-100に丸める。1つも取れなければnull。
 * 軸名をキーにしたオブジェクトと、AXES順に並んだ数値配列の両方を受け付ける
 * （遡及採点では出力トークンを節約するため配列形式を使う）。
 */
function compositeAxes(raw) {
  if (Array.isArray(raw)) {
    // 順序でしか対応が取れないので、長さが違うものは取り違えを避けて捨てる
    if (raw.length !== AXES.length) return null;
    var byKey = {};
    AXES.forEach(function (a, i) { byKey[a.key] = raw[i]; });
    raw = byKey;
  }
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

  // 軸名をキーで書かせると1件250トークン近くかかり、下書きが溜まっていると
  // max_tokensの途中で応答が切れて全件無駄になる。AXES順の配列で受け取り、
  // さらに10件ずつに分けて投げる。
  var byId = {};
  for (var i = 0; i < drafts.length; i += 10) {
    var chunk = drafts.slice(i, i + 10);
    var user = [
      '以下の下書きを採点してください。',
      '',
      chunk.map(function (d) {
        return 'id: ' + d.id + '\ncategory: ' + d.category + '\n本文:\n' + d.text;
      }).join('\n\n====\n\n'),
      '',
      'JSON配列で出力: [{"id": "...", "axes": [下記の順に' + AXES.length + '個の整数(0-100)],' +
        ' "reason": "最も高い軸と最も低い軸に触れて50字以内で"}]',
      '軸の順序: ' + AXES.map(function (a) { return a.key; }).join(', '),
    ].join('\n');

    var results;
    try {
      results = askClaudeJsonSalvageable(system, user, 8000);
    } catch (e) {
      // 一部が採点できなくても、採点できた分は反映して先へ進む
      logEvent('quality_gate_error', String(e).slice(0, 300));
      if (isFatalError(e)) throw e; // 残高切れ等は残りを投げても無駄
      continue;
    }
    if (!Array.isArray(results)) continue;
    results.forEach(function (r) { if (r && r.id !== undefined) byId[String(r.id)] = r; });
  }
  if (!Object.keys(byId).length) throw new Error('採点結果が1件も得られませんでした');

  var passed = 0;
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
 *
 * 継続トリガーの発火中に手動実行が重なると、両方が同じ未採点リストを読んで
 * 同じポストを二重に採点してしまう。ロックで後発を弾く。
 */
var MIN_BACKFILL_BATCH = 3;

function backfillAxisScores() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(100)) {
    var busy = '遡及採点は既に実行中です（二重実行を防ぐためスキップしました）';
    logEvent('backfill_axes', busy);
    return busy;
  }
  try {
    return backfillAxisScoresLocked();
  } finally {
    lock.releaseLock();
  }
}

function backfillAxisScoresLocked() {
  ensureHeaders(SHEET.STOCK);
  // 発火済みの一回きりトリガーは無効のまま残り、溜まると上限に当たる。
  // 予約済みの継続トリガーがあればそれも消す（この実行が引き継ぐため）。
  clearBackfillTrigger();
  var started = new Date().getTime();
  var budgetMs = 4 * 60 * 1000;
  var batchSize = Number(getProp('BACKFILL_BATCH', '15'));

  var pendingAll = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.status) === STATUS.POSTED && String(r.text).trim() && !parseAxes(r.axes);
  });
  if (!pendingAll.length) {
    clearBackfillTrigger();
    var done = '遡及採点は完了しています（未採点の投稿済みポストなし）';
    logEvent('backfill_axes', done);
    return done;
  }

  var cursor = 0;
  var scored = 0;
  var samples = getVoiceSamples(8);
  var system = axisScoringSystemPrompt(samples, true);
  // 軸名をキーにすると1件あたり250トークン近く使い、25件でmax_tokensを超えて
  // JSONが途中で切れる。AXES順の数値配列にすると1件40トークン程度に収まる。
  var order = AXES.map(function (a) { return a.key; }).join(', ');

  while (new Date().getTime() - started < budgetMs) {
    var batch = pendingAll.slice(cursor, cursor + batchSize);
    if (!batch.length) break;
    var user = [
      '以下は過去に投稿されたポストです。各ポストの全軸を採点してください。',
      '',
      batch.map(function (d) {
        return 'id: ' + d.id + '\n本文:\n' + String(d.text).slice(0, 400);
      }).join('\n\n====\n\n'),
      '',
      '出力はJSONオブジェクト1つ。キーがid、値が下記の順に並べた' + AXES.length + '個の整数(0-100)。',
      '順序: ' + order,
      '例: {"' + batch[0].id + '": [' + AXES.map(function () { return '50'; }).join(',') + ']}',
      '全' + batch.length + '件を必ず含めること。説明や軸名は書かない（トークンの無駄なので）。',
    ].join('\n');

    var results = null;
    var fatal = false;
    try {
      results = askClaudeJsonSalvageable(system, user, 8000);
    } catch (e) {
      logEvent('backfill_error', 'batch=' + batchSize + ' ' + String(e).slice(0, 300));
      fatal = isFatalError(e);
    }
    if (fatal) break; // 残高切れ等。バッチを縮めても直らない

    // 指示に反して [{"id": ..., "axes": ...}] 形式で返ってきた場合も拾う
    if (Array.isArray(results)) {
      var byId = {};
      results.forEach(function (r) {
        if (r && r.id !== undefined) byId[String(r.id)] = r.axes !== undefined ? r.axes : r;
      });
      results = byId;
    }

    var writes = [];
    if (results && typeof results === 'object') {
      batch.forEach(function (d) {
        var axes = compositeAxes(results[String(d.id)]);
        if (axes) writes.push({ row: d._row, value: JSON.stringify(axes) });
      });
    }

    if (!writes.length) {
      // 件数が多すぎて応答が不安定なのかもしれないので、半分にして同じ位置から
      // やり直す。それでも駄目なら諦めて次の実行に回す（無限に投げ続けない）。
      if (batchSize > MIN_BACKFILL_BATCH) {
        batchSize = Math.max(MIN_BACKFILL_BATCH, Math.floor(batchSize / 2));
        logEvent('backfill_axes', 'バッチを' + batchSize + '件に縮小して再試行します');
        continue;
      }
      logEvent('backfill_error', '最小バッチでも採点できませんでした（cursor=' + cursor + '）');
      break;
    }

    // updateStockById は1件ごとに全行を読み直すので、ここでは行番号直指定で書く
    setColumnByRows(SHEET.STOCK, 'axes', writes);
    scored += writes.length;
    cursor += batch.length;
    // 4分間まるごと無言だと動いているのか分からないので、バッチごとに進捗を残す
    logEvent('backfill_axes', '進捗 ' + scored + '/' + pendingAll.length + '件' +
      '（今回のバッチ' + writes.length + '/' + batch.length + '件 / 経過' +
      Math.round((new Date().getTime() - started) / 1000) + '秒）');
  }

  // 書けなかった分は残件に戻る（次の実行で拾い直す）
  var remaining = pendingAll.length - scored;
  logEvent('backfill_axes', scored + '件を採点 / 残り' + remaining + '件');
  if (remaining > 0 && scored > 0) {
    scheduleBackfillContinue();
    return scored + '件を採点しました。残り' + remaining + '件は1分後に自動で続行します。';
  }
  if (remaining > 0) {
    // 1件も進まなかった。トリガーで無限に回り続けないよう止めて知らせる
    clearBackfillTrigger();
    var stuck = '遡及採点が進みませんでした（残り' + remaining + '件）。Logシートの backfill_error を確認してください。';
    notifySlack(':warning: ' + stuck);
    return stuck;
  }
  clearBackfillTrigger();
  notifySlack(':white_check_mark: 遡及採点が完了しました。軸スコア付きの投稿が増えたので、' +
    'reportAxisAnalysis を実行すると相関が出ます。');
  return scored + '件を採点しました。完了です。';
}

/**
 * 遡及採点が失敗したときの切り分け用。未採点の先頭3件だけを採点して、
 * Claudeの生の応答をそのまま返す。GASエディタで実行してログを見ると、
 * 空応答なのか・形式違いなのか・途中で切れたのかが一目で分かる。
 * シートは一切書き換えない。
 */
function debugBackfillSample() {
  var pending = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.status) === STATUS.POSTED && String(r.text).trim() && !parseAxes(r.axes);
  }).slice(0, 3);
  if (!pending.length) return '未採点の投稿済みポストはありません';

  var system = axisScoringSystemPrompt(getVoiceSamples(8), true);
  var order = AXES.map(function (a) { return a.key; }).join(', ');
  var user = [
    '以下は過去に投稿されたポストです。各ポストの全軸を採点してください。',
    '',
    pending.map(function (d) {
      return 'id: ' + d.id + '\n本文:\n' + String(d.text).slice(0, 400);
    }).join('\n\n====\n\n'),
    '',
    '出力はJSONオブジェクト1つ。キーがid、値が下記の順に並べた' + AXES.length + '個の整数(0-100)。',
    '順序: ' + order,
    '全' + pending.length + '件を必ず含めること。説明や軸名は書かない。',
  ].join('\n');

  var out = ['system長=' + system.length + '文字 / user長=' + user.length + '文字'];
  try {
    var text = askClaude(system, user, 8000);
    out.push('--- 生の応答 ---', text);
    var parsed = salvageJson(text);
    out.push('--- パース結果 ---', parsed ? JSON.stringify(parsed) : 'パース不能');
    if (parsed) {
      pending.forEach(function (d) {
        out.push(d.id + ' → ' + (compositeAxes(parsed[String(d.id)]) ? 'OK' : '不正な形式: ' + JSON.stringify(parsed[String(d.id)])));
      });
    }
  } catch (e) {
    out.push('--- 例外 ---', String(e));
  }
  var report = out.join('\n');
  logEvent('backfill_debug', report.slice(0, 800));
  console.log(report);
  return report;
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
 * 不合格の下書きについて「何の具体が足りなかったか」を、次に答えるときの
 * 形で返す。
 *
 * 「具体性が低い」と言われても次に何を書けばいいか分からない。
 * 足りない情報の種類と、その情報が入った答え方の例（型）を示す。
 *
 * 例は**型であって事実ではない**。実際の出来事は本人しか知らないので、
 * こちらで具体的な出来事を作ると捏造になる。埋めるべき枠として書かせる。
 *
 * @param {Array} rows 不合格だったStockの行
 * @returns {Array} [{id, text, missing, example}]
 */
function missingInfoHints(rows) {
  var targets = (rows || []).filter(function (r) { return String(r.text || '').trim(); }).slice(0, 6);
  if (!targets.length) return [];

  var c = axisCorrelations();
  var system = [
    'あなたはXアカウントの編集者です。合格しなかった下書きについて、',
    '「次に本人へ聞くとき、どんな情報を答えてもらえれば強くなるか」を示します。',
    '',
    '- missing には、足りない情報の種類を15字以内で書く（例:「相手の反応」「かかった時間」）',
    '- example には、その情報が入った**答え方の型**を40字以内で書く',
    '- 【最重要】example に具体的な事実を作ってはいけない。実際の出来事は本人しか',
    '  知らないので、「◯月◯日」「△△社の担当者」「□時間」のように埋める枠で書く',
    '- 下書きの言い換えを書かない。足りないものだけを指す',
    '- 抽象語（「もっと具体的に」「深掘りを」）は禁止。何を聞くかまで落とす',
  ].join('\n');

  var user = [
    '合格ラインは' + qualityThreshold() + '点です。以下は届かなかった下書きです。',
    '',
    targets.map(function (d, i) {
      var ax = parseAxes(d.axes);
      var weak = '';
      if (ax) {
        var sorted = AXES.filter(function (a) { return isFinite(Number(ax[a.key])); })
          .sort(function (a, b) {
            // 実測で重い軸ほど、低いときの痛手が大きい。重み付きで弱点を選ぶ
            var wa = Math.max(0, Number(c[a.key]) || 0), wb = Math.max(0, Number(c[b.key]) || 0);
            return (Number(ax[a.key]) * (1 - wa)) - (Number(ax[b.key]) * (1 - wb));
          });
        weak = ' / 弱い軸: ' + sorted.slice(0, 3).map(function (a) {
          return a.label + ' ' + ax[a.key] + '点';
        }).join('、');
      }
      return i + ': ' + String(d.text).slice(0, 200) + '\n   採点: ' + d.score + '点' + weak;
    }).join('\n\n'),
    '',
    'JSON配列で出力: [{"i": 番号, "missing": "...", "example": "..."}]',
  ].join('\n');

  try {
    var res = askClaudeJsonSalvageable(system, user, 4000);
    if (!Array.isArray(res)) return [];
    return res.map(function (r) {
      var d = targets[Number(r.i)];
      if (!d || !r.missing) return null;
      return {
        id: String(d.id), text: String(d.text),
        missing: String(r.missing), example: String(r.example || ''),
      };
    }).filter(Boolean);
  } catch (e) {
    logEvent('hint_error', String(e).slice(0, 200));
    return [];
  }
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

  // 捏造防止: 本人がインタビューで実際に話した内容を「一次情報」として渡す。
  // 同じセッションの下書きは同じ一次情報を参照するので、下書きごとに全文を
  // 繰り返すとプロンプトが10倍に膨らむ（長い回答をした日はそれで壊れる）。
  // セッションごとに1回だけ載せて、下書きからは参照させる。
  var MAX_QA_CHARS = 2000;
  var qaBySession = {};
  readTable(SHEET.INTERVIEWS).forEach(function (r) {
    if (!String(r.answer || '').trim()) return;
    var sid = String(r.session_id);
    if (!qaBySession[sid]) qaBySession[sid] = [];
    qaBySession[sid].push('Q: ' + r.question + ' / A: ' + r.answer);
  });

  var usedSessions = {};
  targets.forEach(function (d) { usedSessions[String(d.session_id)] = true; });
  var sources = Object.keys(usedSessions).filter(function (sid) {
    return qaBySession[sid] && qaBySession[sid].length;
  }).map(function (sid) {
    var body = qaBySession[sid].join('\n');
    // 1回の回答が極端に長いこともあるので、セッションあたりの上限を設ける
    if (body.length > MAX_QA_CHARS) body = body.slice(0, MAX_QA_CHARS) + '…(以下略)';
    return '[' + sid + ']\n' + body;
  });

  var system = buildStylePrompt();
  var user = [
    '以下は品質ゲートで不合格になったXのポスト下書きと、その採点コメント、',
    'および本人がインタビューで実際に話した一次情報です。指摘を踏まえて書き直してください。',
    '',
    sources.length
      ? '## 一次情報（本人の回答。各下書きの session が対応する）\n' + sources.join('\n\n')
      : '## 一次情報: なし（本文にある事実だけで書き直すこと）',
    '',
    '## 下書き',
    targets.map(function (d) {
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
      return 'id: ' + d.id + '\nsession: ' + d.session_id +
        '\n採点: ' + d.score + '点 / 指摘: ' + d.score_reason + weak + '\n本文:\n' + d.text;
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

  var results = askClaudeJsonSalvageable(system, user, 6000);
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
