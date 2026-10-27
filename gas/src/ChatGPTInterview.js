/** ChatGPTInterview.gs — ChatGPT音声取材のSlack記録を、既存の編集工程へ渡す。 */
var VOICE_RECORD_MARKER = '【音声インタビュー記録 v1】';
var VOICE_IMPORT_SHEET = 'VoiceImports';
var VOICE_IMPORT_HANDLER = 'processVoiceInterviewRecords';
var VOICE_IMPORT_LEASE_MS = 7 * 60000;

function voiceRecordInputError(message) {
  var error = new Error(message);
  error.voiceRecordInput = true;
  return error;
}

function usesChatGPTInterview() {
  return getProp('INTERVIEW_ENTRYPOINT', 'slack') === 'chatgpt_voice';
}

/** Slack本文のエンティティだけ戻す。回答の空白やURL表示は書き換えない。 */
function voiceRecordText(text) {
  return String(text || '').replace(/\r\n/g, '\n')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** 全文一致する、完結した1パートだけ受け付ける。AIメモは回答に入れない。 */
function parseVoiceInterviewRecord(raw) {
  var text = voiceRecordText(raw);
  if (text.indexOf(VOICE_RECORD_MARKER) !== 0) return null;
  if (text.length > 4500) throw voiceRecordInputError('取材記録は1メッセージ4500文字以内に分割してください。');
  var match = text.match(/^【音声インタビュー記録 v1】\n記録ID: ([A-Za-z0-9_-]{8,64})\n分割: ([1-9][0-9]?)\/([1-9][0-9]?)\n質問番号: ([1-9][0-9]?)\n【質問】\n([\s\S]+?)\n【回答】\n([\s\S]+?)\n(?:【確認会話・原文】\n([\s\S]*?)\n)?(?:【AIメモ・原文ではない】\n([\s\S]*?)\n)?【記録完了】\s*$/);
  if (!match) throw voiceRecordInputError('取材記録の見出し、分割番号、質問・回答、記録完了の形式を確認してください。');
  var result = { record_id: match[1], part: Number(match[2]), total: Number(match[3]),
    question_idx: Number(match[4]), question: match[5], answer: match[6],
    clarification: match[7] || '', ai_note: match[8] || '', raw_text: text };
  if (result.part > result.total || result.total > 30 || result.question_idx > 20 ||
      !result.question.trim() || !result.answer.trim() || result.question.length > 2000 ||
      /\n【(?:質問|回答|確認会話・原文|AIメモ・原文ではない|記録完了)】/.test(result.question + '\n' + result.answer)) {
    throw voiceRecordInputError('取材記録の番号・本文が不正です。見出しを回答本文に埋め込まないでください。');
  }
  return result;
}

function ensureVoiceImportSheet() {
  var spreadsheet = ss();
  if (!spreadsheet.getSheetByName(VOICE_IMPORT_SHEET)) {
    var sheet = spreadsheet.insertSheet(VOICE_IMPORT_SHEET);
    sheet.getRange(1, 1, 1, SHEET_HEADERS[VOICE_IMPORT_SHEET].length).setValues([SHEET_HEADERS[VOICE_IMPORT_SHEET]]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, sheet.getMaxRows(), SHEET_HEADERS[VOICE_IMPORT_SHEET].length).setNumberFormat('@');
  }
  ensureHeaders(VOICE_IMPORT_SHEET);
}

/** 新規トリガーだけ追加する。既存の投稿/品質ゲート/回答は消さない。 */
function setupChatGPTVoiceInterview() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureVoiceImportSheet();
    ensureHeaders(SHEET.INTERVIEWS);
    if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === VOICE_IMPORT_HANDLER; })) {
      ScriptApp.newTrigger(VOICE_IMPORT_HANDLER).timeBased().everyMinutes(5).create();
    }
    PropertiesService.getScriptProperties().setProperty('INTERVIEW_ENTRYPOINT', 'chatgpt_voice');
    clearInterviewRetry();
    var result = 'ChatGPT音声取材の取り込みを有効にしました。Slack定期質問は停止、記録は約5分ごとに1取材ずつ編集します。';
    logEvent('voice_interview_setup', result);
    console.log(result);
    return result;
  } finally { lock.releaseLock(); }
}

/** 旧Slackインタビューへの切り戻し。取材記録と生成済み下書きは保持する。 */
function restoreSlackInterviewEntry() {
  PropertiesService.getScriptProperties().setProperty('INTERVIEW_ENTRYPOINT', 'slack');
  return 'Slack定期インタビューを再開しました。ChatGPTの通知停止はChatGPTのスケジュール画面で行ってください。';
}

function acceptsVoiceRecordEvent(event) {
  if (!event || event.type !== 'message' || String(event.channel) !== String(getProp('SLACK_CHANNEL_ID'))) return false;
  if (['', 'bot_message', 'thread_broadcast'].indexOf(String(event.subtype || '')) < 0) return false;
  // 他のbotや自分の通知を本人発言として取り込まない。必要な送信botだけ明示指定する。
  if (event.bot_id && String(event.bot_id) !== String(getProp('CHATGPT_SLACK_BOT_ID', ''))) return false;
  return voiceRecordText(event.text).indexOf(VOICE_RECORD_MARKER) === 0;
}

/** Events APIでは保存だけ行う。LLMは5分トリガーで実行し、再配送は永続キーで排除。 */
function enqueueVoiceInterviewRecord(event) {
  var part = parseVoiceInterviewRecord(event.text);
  if (!part) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('取材記録の保存が競合しています。Slack再配送で再試行します。');
  try {
    ensureVoiceImportSheet();
    var all = readTable(VOICE_IMPORT_SHEET);
    var records = all.filter(function (r) { return String(r.record_id) === part.record_id; });
    var existing = records.filter(function (r) { return Number(r.part) === part.part; })[0];
    if (existing) {
      if (String(existing.raw_text) !== part.raw_text) throw voiceRecordInputError('同じ記録ID・分割番号に別の本文があります。元の記録を残しています。');
      return true;
    }
    var threadTs = String(event.thread_ts || event.ts || '');
    if (!/^\d+\.\d+$/.test(threadTs)) throw voiceRecordInputError('Slackのスレッド番号を取得できません。');
    if (records.some(function (r) { return Number(r.total) !== part.total || String(r.thread_ts) !== threadTs; })) {
      throw voiceRecordInputError('同じ取材の分割数と保存先スレッドを揃えてください。');
    }
    appendRowObj(VOICE_IMPORT_SHEET, {
      record_id: part.record_id, part: part.part, total: part.total, question_idx: part.question_idx,
      slack_ts: String(event.ts), thread_ts: threadTs, received_at: fmtDateTime(new Date()),
      raw_text: part.raw_text, question: part.question, answer: part.answer,
      ai_note: part.ai_note, status: 'received', session_id: 'voice_' + part.record_id,
    });
    return true;
  } finally { lock.releaseLock(); }
}

/** 分割の欠落を待ち、同一質問の続きだけ結合する。要約や聞き返しは合成しない。 */
function assembleVoiceInterviewRecords(parts) {
  if (!parts.length) return null;
  parts = parts.slice().sort(function (a, b) { return Number(a.part) - Number(b.part); });
  var total = Number(parts[0].total);
  if (parts.length !== total) return null;
  var questions = [];
  parts.forEach(function (part, i) {
    if (Number(part.part) !== i + 1 || Number(part.total) !== total) throw new Error('取材記録の分割番号が揃っていません。');
    var idx = Number(part.question_idx), last = questions[questions.length - 1];
    if (last && last.idx === idx) {
      if (last.question !== String(part.question)) throw new Error('分割された回答の質問文が一致しません。');
      last.answer += '\n' + String(part.answer);
      if (last.answer.length > 40000) throw new Error('1回答が長すぎます。取材を分けて保存してください。');
    } else {
      if (idx !== questions.length + 1) throw new Error('質問番号は1から順に記録してください。');
      questions.push({ idx: idx, question: String(part.question), answer: String(part.answer) });
    }
  });
  return questions;
}

function updateVoiceRecord(recordId, values) {
  updateRowsWhere(VOICE_IMPORT_SHEET, 'record_id', recordId, values);
}

/** GAS最大6分を超えた処理は失敗として保持し、無限に再生成しない。 */
function processVoiceInterviewRecords() {
  var lock = LockService.getScriptLock(), job, questions;
  if (!lock.tryLock(1000)) return;
  try {
    ensureVoiceImportSheet();
    var records = readTable(VOICE_IMPORT_SHEET);
    if (records.some(function (r) { return r.status === 'running' && Date.now() - Number(r.started_at) < VOICE_IMPORT_LEASE_MS; })) return;
    var groups = Object.create(null);
    records.forEach(function (r) { (groups[r.record_id] || (groups[r.record_id] = [])).push(r); });
    Object.keys(groups).some(function (id) {
      var parts = groups[id], first = parts[0];
      if (parts.some(function (r) { return r.status === 'running'; })) {
        updateVoiceRecord(id, { status: 'failed', error: '前回の実行が中断しました。原文とStockを確認して再生成してください。' });
        updateRowsWhere(SHEET.INTERVIEWS, 'session_id', String(first.session_id), { status: INTERVIEW_STATUS.DONE });
        return false;
      }
      if (!parts.every(function (r) { return r.status === 'received'; })) return false;
      try { questions = assembleVoiceInterviewRecords(parts); }
      catch (e) { updateVoiceRecord(id, { status: 'failed', error: String(e) }); return false; }
      if (!questions) return false;
      job = first;
      updateVoiceRecord(id, { status: 'running', started_at: String(Date.now()), error: '' });
      return true;
    });
    if (!job) return;
    var existing = readTable(SHEET.INTERVIEWS).filter(function (r) { return String(r.session_id) === String(job.session_id); });
    if (!existing.length) {
      appendRowsObj(SHEET.INTERVIEWS, questions.map(function (q) {
        return { session_id: job.session_id, thread_ts: 'ts_' + job.thread_ts, idx: q.idx,
          theme: '本人・teTraの音声取材', category: 'evergreen', question: q.question, answer: q.answer,
          answered_at: job.received_at, status: INTERVIEW_STATUS.OPEN,
          source_kind: 'chatgpt_voice_transcript', source_record_id: job.record_id };
      }));
    }
  } finally { lock.releaseLock(); }
  // 上のclaimでロックを解放してから生成する。旧回復バッチはOPENを対象にしない。
  if (!job) return;
  EDITORIAL_EXECUTION_DEADLINE = Date.now() + 240000;
  var resultStatus = 'done', error = '';
  try {
    var rows = readTable(SHEET.STOCK).filter(function (r) { return String(r.session_id) === String(job.session_id); });
    if (!rows.length) {
      var drafts = generateDraftsFromInterview(String(job.session_id));
      if (!drafts.length) resultStatus = 'no_material';
      rows = readTable(SHEET.STOCK).filter(function (r) { return String(r.session_id) === String(job.session_id); });
    }
    sendInterviewDraftMessages(
      rows.length ? ':inbox_tray: 音声取材から' + rows.length + '件をストックしました。採点は夜の品質ゲートで行います。'
        : ':memo: 取材記録は保存済みです。今回は公開用の材料が足りず、下書きは作りませんでした。',
      rows.map(formatInterviewDraftReview),
      rows.length ? '公開は本人の確認・承認後です。\n' + interviewDraftReviewLocation() : '', String(job.thread_ts)
    );
  } catch (e) {
    resultStatus = 'failed'; error = String(e).slice(0, 400);
    logEvent('voice_interview_error', String(job.session_id) + ': ' + error);
    notifySlack(':warning: 音声取材の編集に失敗しました: ' + error + '\n' + interviewFailureRecoveryMessage(String(job.session_id)), String(job.thread_ts));
  }
  lock.waitLock(10000);
  try {
    updateRowsWhere(SHEET.INTERVIEWS, 'session_id', String(job.session_id), {
      status: resultStatus === 'no_material' ? INTERVIEW_STATUS.NO_MATERIAL : INTERVIEW_STATUS.DONE,
    });
    updateVoiceRecord(String(job.record_id), { status: resultStatus, error: error, notified_at: fmtDateTime(new Date()) });
  } finally { lock.releaseLock(); }
}
