/**
 * Interview.js — 毎朝のインタビュー（Slackスレッドで対話）
 *
 * 流れ:
 *   1. 朝のトリガーで startDailyInterview() が実行される
 *   2. テーマ選定 → Claudeが質問を生成 → Slackに親メッセージ + 最初の質問
 *   3. ユーザーがスレッドで返信 → doPost → handleInterviewReply()
 *   4. 全問回答（または「終了」）で generateDraftsFromInterview() が走る
 *
 * スレッド内で使える言葉:
 *   スキップ … その質問を飛ばす
 *   終了 / 以上 … そこまでの回答で下書き生成へ
 */

var INTERVIEW_STATUS = { OPEN: 'open', DONE: 'done', EXPIRED: 'expired' };

function startDailyInterview() {
  var today = fmtDate(nowJst());
  // 追加インタビュー（_ivx_）は数に入れず、毎朝の定期分だけ1日1回に制限する
  var existing = readTable(SHEET.INTERVIEWS).filter(function (r) {
    return String(r.session_id).indexOf(today) === 0 && String(r.session_id).indexOf('_ivx_') < 0;
  });
  if (existing.length) {
    logEvent('interview_skip', '本日分は作成済み: ' + today);
    return;
  }
  expireOldSessions();
  // Notionのテーマデータベースをマスターとして取り込んでから選定する
  try {
    syncThemesFromNotion();
  } catch (e) {
    logEvent('themes_sync_error', String(e));
  }
  // 失敗しても黙って終わると「今日は届かなかった」としか分からない。
  // 何が起きたかをSlackに出したうえで、5分後にもう一度だけ試す
  try {
    startInterviewSession('iv', ':microphone: 今日のインタビュー');
    clearInterviewRetry();
  } catch (e) {
    logEvent('interview_error', String(e).slice(0, 400));
    var again = !hasInterviewRetry();
    notifySlack(':warning: 今日のインタビューを作れませんでした: ' + String(e).slice(0, 250) +
      (again ? '\n5分後にもう一度試します。' : '\n再試行も失敗しました。チャンネルに「インタビュー」と書けば手動で開始できます。'));
    if (again) ScriptApp.newTrigger('retryDailyInterview').timeBased().after(5 * 60 * 1000).create();
  }
}

/** 朝のインタビューが失敗したときの1回だけの再試行 */
function retryDailyInterview() {
  clearInterviewRetry();
  try {
    startInterviewSession('iv', ':microphone: 今日のインタビュー（再試行）');
  } catch (e) {
    logEvent('interview_error', '再試行も失敗: ' + String(e).slice(0, 400));
    notifySlack(':warning: 再試行も失敗しました: ' + String(e).slice(0, 250) +
      '\nチャンネルに「インタビュー」と書けば手動で開始できます。');
  }
}

function hasInterviewRetry() {
  return ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'retryDailyInterview';
  });
}

function clearInterviewRetry() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'retryDailyInterview') ScriptApp.deleteTrigger(t);
  });
}

/**
 * 追加インタビュー。回数制限なし。
 * GASエディタから実行するか、Slackのチャンネルに「インタビュー」と
 * 書き込むと開始される。
 */
function startExtraInterview() {
  startInterviewSession('ivx', ':microphone: 追加インタビュー');
}

function startInterviewSession(kind, title) {
  var themes = pickThemesForToday();
  var headlines = themes.some(function (t) { return t.category === 'news'; })
    ? fetchNewsHeadlines(12)
    : [];

  var questionCount = Number(getProp('INTERVIEW_QUESTIONS', '4'));
  var questions = generateInterviewQuestions(themes, headlines, questionCount);

  var sessionId = fmtDate(nowJst()) + '_' + newId(kind);
  var intro = [
    title + '（' + questions.length + '問）',
    'テーマ: ' + themes.map(function (t) { return t.theme + '（' + labelForCategory(t.category) + '）'; }).join(' / '),
    'このスレッドに普段の言葉のまま返信してください。走り書きでOK。',
    '「スキップ」で次へ、「終了」でそこまでの回答からポスト下書きを作ります。',
  ].join('\n');
  var parent = sendSlack(intro);
  var threadTs = parent.ts;

  questions.forEach(function (q, idx) {
    appendRowObj(SHEET.INTERVIEWS, {
      session_id: sessionId,
      thread_ts: 'ts_' + threadTs, // 'ts_'接頭辞でシートの数値化（精度落ち）を防ぐ
      idx: idx + 1,
      theme: q.theme,
      category: q.category,
      question: q.question,
      answer: '',
      answered_at: '',
      status: INTERVIEW_STATUS.OPEN,
    });
  });

  sendSlack('Q1. ' + questions[0].question, threadTs);
  logEvent('interview_start', sessionId + ' themes=' + JSON.stringify(themes));
}

/**
 * 添付画像をClaudeに読ませて、ポストの材料になる説明文にする。
 *
 * 説明は回答テキストに追記され、そのまま下書き生成と採点に流れる。
 * 実測で効いている軸（具体性・内部情報性）を意識して、見たままの
 * 固有名詞・数字・状況を拾わせる。感想や推測は書かせない。
 *
 * @returns {string} 追記する説明（画像が無い・読めない場合は空文字）
 */
function describeSlackImages(files, contextText) {
  var maxImages = Number(getProp('MAX_IMAGES_PER_REPLY', '3'));
  var images = [];
  (files || []).slice(0, maxImages).forEach(function (f) {
    var got = fetchSlackFile(f);
    if (got) images.push(got);
  });
  if (!images.length) return '';

  var system = [
    'あなたはXの投稿ネタを集める編集者です。送られてきた画像から、',
    'ポストの材料になる事実を拾います。',
    '',
    '- 見えているものだけを書く。推測・感想・評価は書かない',
    '- 固有名詞・数字・日付・型番・看板の文字など、読み取れる具体は必ず拾う',
    '- 何が写っているかだけでなく、その場で何が起きているところかを書く',
    '- 200字以内。箇条書きにせず、続けて書く',
    '- 人物が写っている場合、誰かを推測しない（「男性2人」のように書く）',
  ].join('\n');

  var user = [
    contextText ? '投稿者のコメント: ' + contextText : '（コメントなしで画像だけが送られました）',
    '',
    'この画像から読み取れる事実を書いてください。',
  ].join('\n');

  try {
    // 説明自体は200字だが、思考ブロックに枠を食われて本文が0文字になることが
    // あるため広めに取る（朝のインタビューが飛んだのと同じ原因）
    var desc = askClaudeWithImages(system, user, images, 4000);
    logEvent('image_read', images.length + '枚を読みました: ' + String(desc).slice(0, 120));
    return String(desc).trim();
  } catch (e) {
    logEvent('image_error', String(e).slice(0, 300));
    return '';
  }
}

function labelForCategory(cat) {
  return { evergreen: '定番', news: '時事', neta: 'ネタ' }[cat] || cat;
}

/**
 * 実測で効いている軸を、質問生成の指示に変換する。
 *
 * 採点だけを学習しても、そもそも効かない軸しか引き出せない質問を
 * していたら点は伸びない。何を聞くかの段階で相関を効かせる。
 */
function axisGuidanceForQuestions() {
  var c = axisCorrelations();
  var ranked = AXES.map(function (a) {
    return { label: a.label, desc: a.desc, w: Number(c[a.key]) || 0 };
  }).sort(function (x, y) { return y.w - x.w; });

  var top = ranked.slice(0, 4).filter(function (x) { return x.w > 0; });
  var bottom = ranked.slice(-3).filter(function (x) { return x.w < 0; });
  if (!top.length) return '';

  var lines = ['実測データから、この軸が高いポストほどフォロワー獲得に繋がっています。',
    'この軸が引き出せる質問を優先してください:'];
  top.forEach(function (x) { lines.push('- ' + x.label + ': ' + x.desc); });
  if (bottom.length) {
    lines.push('');
    lines.push('逆に、この軸が高いポストは成果が下がっています。' +
      'これらばかりを引き出す質問（当たり障りのない共感狙い等）に寄せないこと:');
    bottom.forEach(function (x) { lines.push('- ' + x.label); });
  }
  return lines.join('\n');
}

/**
 * 答えにくかった質問を集める。スキップされたもの、および回答が極端に短い
 * もの（＝聞かれても書くことが無かった質問）を、避けるべき型として渡す。
 */
function hardToAnswerQuestions(limit) {
  var rows = readTable(SHEET.INTERVIEWS).filter(function (r) {
    if (!String(r.question).trim()) return false;
    if (String(r.answered_at) === 'skipped') return true;
    var a = String(r.answer || '').trim();
    return a.length > 0 && a.length < 15;
  });
  return rows.slice(-(limit || 10)).map(function (r) { return '- ' + r.question; });
}

/** よく答えられた質問（長く具体的に答えたもの）を、良い型として渡す */
function wellAnsweredQuestions(limit) {
  var rows = readTable(SHEET.INTERVIEWS).filter(function (r) {
    return String(r.answered_at) !== 'skipped' && String(r.answer || '').trim().length >= 60;
  });
  return rows.slice(-(limit || 6)).map(function (r) { return '- ' + r.question; });
}

/**
 * 実際に伸びた投稿を生んだ質問。
 *
 * 過去の手動投稿から逆算した「この投稿を引き出せたであろう質問」のうち、
 * インプレッションが窓内で上位だったものを手本として渡す。
 * インタビュー経由でない投稿の実績も、聞き方の学習に使えるようにする。
 */
function highPerformingQuestions(limit) {
  var rows = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.inferred_question || '').trim() && r.posted_at &&
      Number(r.impressions || 0) > 0 &&
      !(String(r.promoted) === 'yes' && r.paid_impressions === '');
  });
  if (rows.length < 10) return [];
  var pct = percentileWithinWindow(rows.map(function (r) {
    return { t: new Date(String(r.posted_at).replace(' ', 'T') + ':00+09:00').getTime(), v: Number(r.impressions) };
  }), 30);
  return rows.map(function (r, i) { return { q: String(r.inferred_question), p: pct[i] }; })
    .filter(function (x) { return x.p >= 75; })
    .sort(function (a, b) { return b.p - a.p; })
    .slice(0, limit || 8)
    .map(function (x) { return '- ' + x.q + '（窓内順位' + Math.round(x.p) + '点）'; });
}

function generateInterviewQuestions(themes, headlines, count) {
  var system = [
    'あなたは経営者に毎朝ゆるく話を聞くインタビュアーです。',
    '相手はX（Twitter）のポストの種になる話を引き出してほしいと思っています。',
    '質問のルール:',
    '- 1問1トピック、話し言葉で短く（40字以内目安）',
    '- 「はい/いいえ」で終わらない、具体的なエピソードや本音が出る聞き方',
    '- 固有名詞・数字・「今日/最近あったこと」が答えに出てくる聞き方を最優先。抽象的な回想・ビジョン語りを誘う質問（「当時の自分に何て言う？」等）は避ける',
    '- 【最重要】相手がその場で思い出せることだけを聞く。調べないと答えられない質問、考え込まないと答えが出ない質問は、答えてもらえないので価値がゼロ',
    '- 時事テーマにはニュース見出しを1つ選んで絡める。大企業の既出ニュースの繰り返しより、国際ニュースや小さなスタートアップの「まだ知られていない話」を優先する',
    '- ネタテーマはゆるく、笑える話や人間味が出る話を引き出す',
    '',
    axisGuidanceForQuestions(),
  ].join('\n');
  // 直近に聞いた時事質問を出し、同じ話題の連発（例: トヨタ3連発）を防ぐ
  var recentNewsQs = readTable(SHEET.INTERVIEWS)
    .filter(function (r) { return String(r.category) === 'news'; })
    .slice(-12)
    .map(function (r) { return '- ' + r.question; });
  var user = [
    '今日のテーマ:',
    themes.map(function (t) { return '- ' + t.theme + '（カテゴリ: ' + t.category + (t.notes ? ' / メモ: ' + t.notes : '') + '）'; }).join('\n'),
    '',
    headlines.length ? '今日のニュース見出し（英語見出しは日本語で聞いてよい）:\n' + headlines.map(function (h) { return '- ' + h; }).join('\n') : '',
    '',
    recentNewsQs.length ? '最近すでに聞いた時事質問（同じ話題・同じ企業の質問は禁止）:\n' + recentNewsQs.join('\n') : '',
    '',
    (function () {
      var hard = hardToAnswerQuestions(10);
      return hard.length ? '実際にスキップされた・ほとんど答えてもらえなかった質問（この型は避ける）:\n' + hard.join('\n') : '';
    })(),
    '',
    (function () {
      var good = wellAnsweredQuestions(6);
      return good.length ? 'しっかり答えてもらえた質問（この型に寄せる）:\n' + good.join('\n') : '';
    })(),
    '',
    (function () {
      var top = highPerformingQuestions(8);
      return top.length
        ? '過去に実際に伸びた投稿を引き出せたであろう質問（実測ベース。この方向を狙う）:\n' + top.join('\n')
        : '';
    })(),
    '',
    '合計' + count + '問。各テーマから最低1問。',
    'JSON配列で出力: [{"theme": "...", "category": "evergreen|news|neta", "question": "..."}]',
  ].join('\n');
  // 質問4問なら本文は500トークンもあれば足りるが、モデルが思考ブロックに
  // 枠を使うため、それを見込んで広めに取る（1500だと思考だけで枠を使い切り、
  // 本文が0文字になって朝のインタビューが飛んだ）
  var questions = askClaudeJson(system, user, 6000);
  if (!Array.isArray(questions) || !questions.length) throw new Error('質問生成に失敗しました');
  return questions.slice(0, count);
}

/**
 * Slackスレッドへの返信を処理する（doPost から呼ばれる）。
 */
function handleInterviewReply(threadTs, text) {
  // シートが数値解釈でtsの末尾0を落とすことがあるため、正規化して照合する
  var rows = readTable(SHEET.INTERVIEWS).filter(function (r) {
    return slackTsEqual(r.thread_ts, threadTs) && String(r.status) === INTERVIEW_STATUS.OPEN;
  });
  if (!rows.length) {
    logEvent('interview_no_match', 'thread_ts=' + threadTs + ' に一致する進行中セッションなし');
    return false;
  }
  rows.sort(function (a, b) { return Number(a.idx) - Number(b.idx); });
  var sessionId = String(rows[0].session_id);
  // 保存値が欠損していたら、イベントの正確なtsでシートを自己修復する
  if (String(rows[0].thread_ts) !== 'ts_' + String(threadTs)) {
    updateRowsWhere(SHEET.INTERVIEWS, 'session_id', sessionId, { thread_ts: 'ts_' + String(threadTs) });
    logEvent('interview_ts_healed', sessionId + ': ' + rows[0].thread_ts + ' -> ts_' + threadTs);
  }
  var trimmed = String(text || '').trim();

  if (/^(終了|以上|おわり|done)/.test(trimmed)) {
    finishInterview(sessionId, threadTs);
    return true;
  }

  var current = rows.filter(function (r) { return !String(r.answer) && String(r.answered_at) !== 'skipped'; })[0];
  if (!current) {
    finishInterview(sessionId, threadTs);
    return true;
  }

  var isSkip = /^(スキップ|skip|パス)$/i.test(trimmed);
  updateInterviewRow(sessionId, Number(current.idx), {
    answer: isSkip ? '' : trimmed,
    answered_at: isSkip ? 'skipped' : fmtDateTime(nowJst()),
  });

  // 記録できたことを必ず返信で知らせる
  var ack = isSkip
    ? ':fast_forward: Q' + current.idx + ' をスキップしました。'
    : ':white_check_mark: Q' + current.idx + ' の回答を記録しました。';

  var remaining = rows.filter(function (r) {
    return Number(r.idx) > Number(current.idx);
  });
  if (remaining.length) {
    var next = remaining[0];
    sendSlack(ack + '\n\nQ' + next.idx + '. ' + next.question, threadTs);
  } else {
    sendSlack(ack, threadTs);
    finishInterview(sessionId, threadTs);
  }
  return true;
}

function updateInterviewRow(sessionId, idx, updates) {
  var headers = SHEET_HEADERS.Interviews;
  var sheet = getSheet(SHEET.INTERVIEWS);
  readTable(SHEET.INTERVIEWS).forEach(function (r) {
    if (String(r.session_id) !== sessionId || Number(r.idx) !== idx) return;
    Object.keys(updates).forEach(function (col) {
      var colIdx = headers.indexOf(col);
      if (colIdx >= 0) sheet.getRange(r._row, colIdx + 1).setValue(updates[col]);
    });
  });
}

function finishInterview(sessionId, threadTs) {
  updateRowsWhere(SHEET.INTERVIEWS, 'session_id', sessionId, { status: INTERVIEW_STATUS.DONE });
  var answered = readTable(SHEET.INTERVIEWS).filter(function (r) {
    return String(r.session_id) === sessionId && String(r.answer).trim();
  });
  if (!answered.length) {
    sendSlack('回答がなかったので今日はここまで。また明日聞きます :wave:', threadTs);
    logEvent('interview_empty', sessionId);
    return;
  }
  sendSlack('ありがとうございます。下書きを作って、その場で採点までやります…', threadTs);
  try {
    var drafts = generateDraftsFromInterview(sessionId);
    // 即時品質ゲート: 不合格分は自己批判リライトを挟んで合格点が出るまで(最大2周)改造する
    runQualityGateWithRefinement();

    var rows = readTable(SHEET.STOCK).filter(function (r) {
      return String(r.session_id) === sessionId;
    });
    var passStatuses = [STATUS.READY, STATUS.APPROVED, STATUS.SCHEDULED];
    var passed = rows.filter(function (r) { return passStatuses.indexOf(String(r.status)) >= 0; });

    var lines = rows.map(function (r) {
      var ok = passStatuses.indexOf(String(r.status)) >= 0;
      var refines = Number(r.refines || 0);
      var head = (ok ? ':white_check_mark:' : ':no_entry_sign:') + ' *' + (r.score === '' ? '-' : r.score) + '点* ' +
        (refines > 0 ? '(リライト' + refines + '回) ' : '');
      var reason = String(r.score_reason || '');
      return head + String(r.text) + (reason ? '\n　└ ' + reason : '');
    });

    var footer;
    if (!passed.length) {
      footer = ':arrows_counterclockwise: 合格なし。チャンネルに「インタビュー」と書けば、すぐ次のインタビューを始めます。';
    } else if (isAutoApprove()) {
      var scheduled = scheduleApprovedPosts();
      footer = ':calendar: 合格' + passed.length + '件のうち' + scheduled.length + '件を予約しました。';
    } else {
      var url = getProp('WEBAPP_URL');
      footer = ':hourglass: 合格' + passed.length + '件は承認待ちです。' +
        (url ? '承認: ' + url + '?token=' + getProp('ADMIN_TOKEN') : 'Webアプリから承認してください。');
    }

    sendSlack(
      ':inbox_tray: ' + drafts.length + '件をストックし、採点しました（合格 ' + passed.length + '/' + rows.length + '、閾値' + qualityThreshold() + '点）\n\n' +
      lines.join('\n\n') + '\n\n' + footer,
      threadTs
    );
  } catch (e) {
    logEvent('draft_error', sessionId + ': ' + e);
    sendSlack(':warning: 下書き生成/採点でエラー: ' + e + '\n下書きが残っていれば今夜の品質ゲートで再処理されます。', threadTs);
  }
}

/**
 * 生成に失敗したインタビューのポストを作り直す。
 *
 * 「回答はあるのに Stock に下書きが1件も無い」セッションを取りこぼしとみなし、
 * 生成→採点をやり直す。生成中にエラーが出た日の救済用で、GASエディタから
 * 引数なしで実行できる。回答そのものは残っているので何度でもやり直せる。
 *
 * @param {number} maxSessions 1回で処理するセッション数（既定3。実行時間上限があるため）
 */
function regenerateFailedInterviews(maxSessions) {
  var limit = Number(maxSessions || 3);
  var stockSessions = {};
  readTable(SHEET.STOCK).forEach(function (r) {
    if (r.session_id) stockSessions[String(r.session_id)] = true;
  });

  var bySession = {};
  readTable(SHEET.INTERVIEWS).forEach(function (r) {
    if (!String(r.answer || '').trim()) return;
    var sid = String(r.session_id);
    if (!bySession[sid]) bySession[sid] = { sid: sid, threadTs: r.thread_ts, answers: 0 };
    bySession[sid].answers++;
  });

  // session_id は先頭が日時なので、降順に並べると新しい順になる
  var failed = Object.keys(bySession)
    .filter(function (sid) { return !stockSessions[sid]; })
    .sort().reverse();

  if (!failed.length) {
    var none = '作り直す対象はありません（回答があるのに下書きが無いセッションは0件）';
    logEvent('regenerate', none);
    return none;
  }

  var targets = failed.slice(0, limit);
  var results = [];
  targets.forEach(function (sid) {
    var threadTs = rawSlackTs(bySession[sid].threadTs);
    try {
      var drafts = generateDraftsFromInterview(sid);
      results.push(sid + ': ' + drafts.length + '件を生成');
      logEvent('regenerate', sid + ': ' + drafts.length + '件を生成');
      if (threadTs) sendSlack(':arrows_counterclockwise: 下書きを作り直しました（' + drafts.length + '件）。採点はこのあとまとめて行います。', threadTs);
    } catch (e) {
      results.push(sid + ': 失敗 ' + String(e).slice(0, 150));
      logEvent('regenerate_error', sid + ': ' + String(e).slice(0, 300));
      if (threadTs) sendSlack(':warning: 作り直しにも失敗しました: ' + String(e).slice(0, 200), threadTs);
    }
  });

  // 採点は全セッション分をまとめて1回で済ませる（下書きはどれも draft 状態）
  var gate = null;
  try {
    gate = runQualityGateWithRefinement();
  } catch (e) {
    logEvent('regenerate_error', '採点でエラー: ' + String(e).slice(0, 300));
  }

  var msg = ':arrows_counterclockwise: 生成し直しました（' + targets.length + '/' + failed.length + 'セッション）\n' +
    results.join('\n') +
    (gate ? '\n採点: ' + gate.scored + '件中' + gate.passed + '件が合格' : '\n採点: 失敗（今夜の品質ゲートで再処理されます）') +
    (failed.length > targets.length ? '\n残り' + (failed.length - targets.length) + 'セッションは、もう一度実行すると処理します。' : '');
  notifySlack(msg);
  return msg;
}

/**
 * スレッド外（チャンネル直下）に書かれたメッセージの救済。
 * 進行中セッションが1つあれば、そのスレッドへの返信として扱う。
 */
function handleChannelMessage(text) {
  var trimmed = String(text || '').trim();
  // 「インタビュー」と書き込むと追加インタビューを開始する
  if (/^(インタビュー|追加インタビュー|interview)$/i.test(trimmed)) {
    startExtraInterview();
    return true;
  }
  // 「メモ: 〜」は運用メモとして取り込む（インタビュー進行中でも回答扱いにしない）
  var memoMatch = trimmed.match(/^(?:メモ|memo)[:：]\s*([\s\S]+)$/i);
  if (memoMatch) {
    addMemory(memoMatch[1], 'チャンネルのメモ');
    notifySlack(':memo: メモとして取り込みました。今後の生成・採点に反映します。');
    return true;
  }
  var open = readTable(SHEET.INTERVIEWS).filter(function (r) {
    return String(r.status) === INTERVIEW_STATUS.OPEN && r.thread_ts;
  });
  if (!open.length) return false;
  var threadTs = rawSlackTs(open[0].thread_ts);
  return handleInterviewReply(threadTs, text);
}

/** 前日以前の未完了セッションを期限切れにする（回答が来ても誤反応しないように） */
function expireOldSessions() {
  var today = fmtDate(nowJst());
  readTable(SHEET.INTERVIEWS).forEach(function (r) {
    if (String(r.status) === INTERVIEW_STATUS.OPEN && String(r.session_id).indexOf(today) !== 0) {
      updateRowsWhere(SHEET.INTERVIEWS, 'session_id', r.session_id, { status: INTERVIEW_STATUS.EXPIRED });
    }
  });
}
