/** InterviewRecovery.gs: 未生成の完了セッションを、1実行1件で自動救済する。 */
var INTERVIEW_RECOVERY_STATE = 'INTERVIEW_RECOVERY_STATE';
var INTERVIEW_RECOVERY_JOB_PREFIX = 'INTERVIEW_RECOVERY_JOB_';
var INTERVIEW_RECOVERY_HANDLER = 'runFailedInterviewBatch';
// GASの最大実行時間6分を超えてから中断と判断する。
var INTERVIEW_RECOVERY_LEASE_MS = 7 * 60000;

function interviewRecoveryIsActive() {
  var props = PropertiesService.getScriptProperties();
  var state = JSON.parse(props.getProperty(INTERVIEW_RECOVERY_STATE) || '{}');
  return !!state.active || interviewRecoveryJobs(props).some(function (j) {
    return j.status === 'running' && Date.now() - j.started_at < INTERVIEW_RECOVERY_LEASE_MS;
  });
}

function interviewRecoveryJobs(props) {
  var values = props.getProperties();
  return Object.keys(values).filter(function (key) {
    return key.indexOf(INTERVIEW_RECOVERY_JOB_PREFIX) === 0;
  }).sort().reverse().map(function (key) { return JSON.parse(values[key]); });
}

function clearInterviewRecoveryTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === INTERVIEW_RECOVERY_HANDLER) ScriptApp.deleteTrigger(trigger);
  });
}

/** GASエディタで一度実行。新しい回答は次回の開始時に取り込む。 */
function startFailedInterviewBatch() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return '別の編集処理が実行中です。終了後にもう一度開始してください。';
  try {
    var props = PropertiesService.getScriptProperties();
    var state = JSON.parse(props.getProperty(INTERVIEW_RECOVERY_STATE) || '{}');
    if (interviewRecoveryIsActive()) return '一括再生成は既に実行中です。';
    var sessions = failedInterviewSessions();
    if (!sessions.length) return '作り直す対象はありません。';
    clearInterviewRecoveryTriggers();
    Object.keys(props.getProperties()).forEach(function (key) {
      if (key.indexOf(INTERVIEW_RECOVERY_JOB_PREFIX) === 0) props.deleteProperty(key);
    });
    sessions.forEach(function (s) {
      props.setProperty(INTERVIEW_RECOVERY_JOB_PREFIX + s.sid, JSON.stringify({ sid: s.sid, status: 'pending' }));
    });
    // 登録失敗時にactive状態を残さない。ロック解放前に状態を保存する。
    ScriptApp.newTrigger(INTERVIEW_RECOVERY_HANDLER).timeBased().everyMinutes(5).create();
    props.setProperty(INTERVIEW_RECOVERY_STATE, JSON.stringify({ active: true, total: sessions.length }));
    logEvent('regenerate_batch_start', String(sessions.length));
    var message = '一括再生成を開始しました（' + sessions.length + 'セッション）。約5分ごとに1件ずつ処理し、失敗分は保留して次へ進みます。採点は夜の品質ゲートで行います。';
    notifySlack(message);
    return message;
  } finally { lock.releaseLock(); }
}

/** 専用トリガー用。実行中状態を先に保存し、強制終了した分も次回は繰り返さない。 */
function runFailedInterviewBatch() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  var job, props, state;
  try {
    props = PropertiesService.getScriptProperties();
    state = JSON.parse(props.getProperty(INTERVIEW_RECOVERY_STATE) || '{}');
    if (!state.active) { clearInterviewRecoveryTriggers(); return; }
    var jobs = interviewRecoveryJobs(props);
    if (jobs.some(function (j) {
      return j.status === 'running' && Date.now() - j.started_at < INTERVIEW_RECOVERY_LEASE_MS;
    })) return;
    var eligible = {};
    failedInterviewSessions().forEach(function (s) { eligible[s.sid] = true; });
    function save(job) { props.setProperty(INTERVIEW_RECOVERY_JOB_PREFIX + job.sid, JSON.stringify(job)); }
    jobs.forEach(function (job) {
      if (job.status === 'running') {
        job.status = 'failed'; job.error = '前回の処理が中断しました。Stockを確認してから再開してください。';
        save(job); logEvent('regenerate_batch_failed', job.sid + ': interrupted');
      } else if (job.status === 'pending' && !eligible[job.sid]) {
        job.status = 'skipped'; save(job);
      }
    });
    job = jobs.filter(function (j) { return j.status === 'pending'; })[0];
    if (job) { job.status = 'running'; job.started_at = Date.now(); save(job); }
  } finally { lock.releaseLock(); }
  // LLM待ちの間はインタビュー回答の保存を妨げない。次のworkerは上のleaseで排他する。
  if (job) {
    EDITORIAL_EXECUTION_DEADLINE = Date.now() + 240000;
    try {
      var drafts = generateDraftsFromInterview(job.sid);
      if (!drafts.length) updateRowsWhere(SHEET.INTERVIEWS, 'session_id', job.sid, { status: INTERVIEW_STATUS.NO_MATERIAL });
      job.status = drafts.length ? 'done' : 'no_material'; job.drafts = drafts.length;
      logEvent('regenerate_batch_result', job.sid + ': ' + job.status + ' drafts=' + drafts.length);
    } catch (error) {
      job.status = 'failed'; job.error = String(error).slice(0, 250);
      logEvent('regenerate_batch_failed', job.sid + ': ' + job.error);
    }
  }
  lock.waitLock(10000);
  try {
    if (job) props.setProperty(INTERVIEW_RECOVERY_JOB_PREFIX + job.sid, JSON.stringify(job));
    state = JSON.parse(props.getProperty(INTERVIEW_RECOVERY_STATE) || '{}');
    if (!state.active) return;
    var jobs = interviewRecoveryJobs(props);
    if (jobs.some(function (j) { return j.status === 'pending'; })) return;
    state.active = false; props.setProperty(INTERVIEW_RECOVERY_STATE, JSON.stringify(state));
    clearInterviewRecoveryTriggers();
    var counts = {};
    jobs.forEach(function (j) { counts[j.status] = (counts[j.status] || 0) + 1; });
    logEvent('regenerate_batch_complete', JSON.stringify(counts));
    notifySlack('一括再生成が完了しました。生成 ' + (counts.done || 0) + ' / 材料不足 ' + (counts.no_material || 0) +
      ' / 対象外 ' + (counts.skipped || 0) + ' / 失敗・中断 ' + (counts.failed || 0) + 'セッション。採点は夜の品質ゲートで行います。' +
      (counts.failed ? '\n失敗・中断分の詳細はLogのregenerate_batch_failedを確認してください。' : ''));
  } finally { lock.releaseLock(); }
}

/** 次の実行を停止する。生成中の1件は終了まで進め、回答・下書き・結果を保持する。 */
function stopFailedInterviewBatch() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return '生成処理が実行中です。終了後にもう一度停止してください。';
  try {
    var props = PropertiesService.getScriptProperties();
    var state = JSON.parse(props.getProperty(INTERVIEW_RECOVERY_STATE) || '{}');
    state.active = false; props.setProperty(INTERVIEW_RECOVERY_STATE, JSON.stringify(state));
    clearInterviewRecoveryTriggers();
    return '一括再生成を停止しました。保存済みデータは保持しています。';
  } finally { lock.releaseLock(); }
}
