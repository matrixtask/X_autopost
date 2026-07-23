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
  startInterviewSession('iv', ':microphone: 今日のインタビュー');
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

function labelForCategory(cat) {
  return { evergreen: '定番', news: '時事', neta: 'ネタ' }[cat] || cat;
}

function generateInterviewQuestions(themes, headlines, count) {
  var system = [
    'あなたは経営者に毎朝ゆるく話を聞くインタビュアーです。',
    '相手はX（Twitter）のポストの種になる話を引き出してほしいと思っています。',
    '質問のルール:',
    '- 1問1トピック、話し言葉で短く（40字以内目安）',
    '- 「はい/いいえ」で終わらない、具体的なエピソードや本音が出る聞き方',
    '- 固有名詞・数字・「今日/最近あったこと」が答えに出てくる聞き方を最優先。抽象的な回想・ビジョン語りを誘う質問（「当時の自分に何て言う？」等）は避ける',
    '- 時事テーマにはニュース見出しを1つ選んで絡める。大企業の既出ニュースの繰り返しより、国際ニュースや小さなスタートアップの「まだ知られていない話」を優先する',
    '- ネタテーマはゆるく、笑える話や人間味が出る話を引き出す',
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
    '合計' + count + '問。各テーマから最低1問。',
    'JSON配列で出力: [{"theme": "...", "category": "evergreen|news|neta", "question": "..."}]',
  ].join('\n');
  var questions = askClaudeJson(system, user, 1500);
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
      var head = (ok ? ':white_check_mark:' : ':no_entry_sign:') + ' *' + (r.score === '' ? '-' : r.score) + '点* ';
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
