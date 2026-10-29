/** OutcomeReviewQueue.gs: 未採点稿の審査を1実行1件で完了まで進める。公開はしない。 */
var OUTCOME_QUEUE_KEY = 'OUTCOME_REVIEW_QUEUE';
var OUTCOME_QUEUE_HANDLER = 'runPendingReviewBatch';
var OUTCOME_QUEUE_LEASE_MS = 7 * 60000;

/** GASから一度実行。開始時点の未採点稿を最大100件、各1回ずつ審査する。 */
function startPendingReviewBatch() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return '別の保存処理中です。少し待って再実行してください。';
  try {
    var props = PropertiesService.getScriptProperties();
    var state = JSON.parse(props.getProperty(OUTCOME_QUEUE_KEY) || '{}');
    if (state.active || (state.running && Date.now() - state.running.started_at < OUTCOME_QUEUE_LEASE_MS)) return '審査バッチは既に実行中です。';
    var ids = readTable(SHEET.STOCK).filter(function (r) { return r.status === STATUS.DRAFT; })
      .map(function (r) { return String(r.id); }).slice(0, 100);
    if (!ids.length) return '未採点の下書きはありません。';
    clearPendingReviewTriggers();
    // 登録に失敗した場合はactiveを残さない。
    ScriptApp.newTrigger(OUTCOME_QUEUE_HANDLER).timeBased().everyMinutes(1).create();
    props.setProperty(OUTCOME_QUEUE_KEY, JSON.stringify({ active: true, pending: ids, running: null,
      total: ids.length, counts: { ready: 0, held: 0, failed: 0, skipped: 0 } }));
    logEvent('outcome_batch_start', String(ids.length));
    return ids.length + '件の審査を開始しました。この画面を閉じても継続します。公開は本人承認後です。';
  } finally { lock.releaseLock(); }
}

function clearPendingReviewTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === OUTCOME_QUEUE_HANDLER) ScriptApp.deleteTrigger(t);
  });
}

/** 強制終了した稿は保留し、次へ進む。同一バッチ内では同じ稿を再試行しない。 */
function runPendingReviewBatch() {
  var lock = LockService.getScriptLock(), props, state, id;
  if (!lock.tryLock(1000)) return;
  try {
    props = PropertiesService.getScriptProperties();
    state = JSON.parse(props.getProperty(OUTCOME_QUEUE_KEY) || '{}');
    if (!state.active) { clearPendingReviewTriggers(); return; }
    if (state.running && Date.now() - state.running.started_at < OUTCOME_QUEUE_LEASE_MS) return;
    if (state.running) {
      state.counts.failed++;
      logEvent('outcome_batch_failed', state.running.id + ': interrupted; draft retained');
      state.running = null;
    }
    id = state.pending.shift();
    if (id) state.running = { id: id, started_at: Date.now() };
    props.setProperty(OUTCOME_QUEUE_KEY, JSON.stringify(state));
  } finally { lock.releaseLock(); }
  var outcome = 'skipped';
  if (id) {
    try {
      var row = readTable(SHEET.STOCK).filter(function (r) { return String(r.id) === id; })[0];
      if (row && row.status === STATUS.DRAFT) {
        runOutcomeQualityGate([row]);
        var current = readTable(SHEET.STOCK).filter(function (r) { return String(r.id) === id; })[0];
        outcome = current && current.status === STATUS.READY ? 'ready' :
          current && current.status === STATUS.STOCK ? 'held' :
          current && current.status === STATUS.DRAFT ? 'failed' : 'skipped';
      }
    } catch (e) {
      outcome = 'failed';
      logEvent('outcome_batch_failed', id + ': ' + String(e).slice(0, 300));
    }
  }
  lock.waitLock(10000);
  try {
    state = JSON.parse(props.getProperty(OUTCOME_QUEUE_KEY) || '{}');
    if (id && state.running && state.running.id === id) {
      state.counts[outcome]++; state.running = null;
      logEvent('outcome_batch_result', id + ': ' + outcome);
    }
    if (!state.pending.length) {
      state.active = false;
      clearPendingReviewTriggers();
      logEvent('outcome_batch_complete', JSON.stringify(state.counts));
    }
    props.setProperty(OUTCOME_QUEUE_KEY, JSON.stringify(state));
  } finally { lock.releaseLock(); }
}

/** 実行中の1件は完了させ、次の審査を停止する。回答・稿・審査結果を保持する。 */
function stopPendingReviewBatch() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return '保存処理中です。少し待って再実行してください。';
  try {
    var props = PropertiesService.getScriptProperties();
    var state = JSON.parse(props.getProperty(OUTCOME_QUEUE_KEY) || '{}');
    state.active = false;
    props.setProperty(OUTCOME_QUEUE_KEY, JSON.stringify(state));
    clearPendingReviewTriggers();
    return '次の審査を停止しました。保存済みの稿と審査結果は保持しています。';
  } finally { lock.releaseLock(); }
}
