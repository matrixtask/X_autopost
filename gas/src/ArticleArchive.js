/** ArticleArchive.gs: 将来の記事化に向けた原文・編集履歴。記事生成や公開は行わない。 */
var ARTICLE_ARCHIVE_TABLES = ['SourceRevisions', 'EditorialHistory', 'ArticleDrafts', 'ArticleSources'];

/** GASエディタで一度実行。既存の定期トリガーを変更せず、現在の状態を取り込む。 */
function setupArticleArchive() {
  var spreadsheet = ss();
  ARTICLE_ARCHIVE_TABLES.forEach(function (name) {
    if (!spreadsheet.getSheetByName(name)) spreadsheet.insertSheet(name);
    ensureHeaders(name);
  });
  ensureHeaders(SHEET.STOCK);
  var result = captureArticleArchive();
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'onArticleArchiveEdit'; })) {
    ScriptApp.newTrigger('onArticleArchiveEdit').forSpreadsheet(spreadsheet).onEdit().create();
  }
  return '記事資料の保存を開始しました。既存内容は導入時点のスナップショットです。' + JSON.stringify(result);
}

function articleArchiveEnabled() {
  var spreadsheet = ss();
  return !!spreadsheet.getSheetByName('SourceRevisions') && !!spreadsheet.getSheetByName('EditorialHistory');
}

/** 呼び出し元がインタビューのロックを持つ場合は解放しない。 */
function withArticleArchiveLock(fn) {
  var lock = LockService.getScriptLock();
  var owned = lock.hasLock();
  if (!owned && !lock.tryLock(5000)) throw new Error('記事資料保存のロック待ち。次回の資料回収で再取得します');
  try { return fn(); } finally {
    if (!owned) {
      try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
    }
  }
}

function articleRevisionId(prefix) {
  // 取り込みでは同一秒に数百版を作る。既存newIdの4桁乱数では衝突しうる。
  return prefix + '_' + Utilities.getUuid();
}

function articleSnapshotHash(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function latestArticleRecords(rows, key) {
  var latest = {};
  rows.forEach(function (r) { latest[String(r[key])] = r; });
  return latest;
}

/** 原文と補足を別々の不変版として保存。本文を空にした訂正も履歴に残す。 */
function archiveInterviewSources(rows, origin) {
  if (!articleArchiveEnabled()) return {};
  return withArticleArchiveLock(function () {
    var latest = latestArticleRecords(readTable('SourceRevisions'), 'source_id');
    var pending = [], refs = {};
    rows.forEach(function (r) {
      ['answer', 'followup_answer'].forEach(function (field) {
        var key = 'interview:' + r.session_id + ':Q' + r.idx + ':' + field;
        var previous = latest[key];
        var skipped = String(r[field === 'answer' ? 'answered_at' : 'followup_answered_at']) === 'skipped';
        var text = skipped ? '' : String(r[field] || '');
        if (!previous && !text.trim()) return;
        var snapshot = {
          text: text, question: String(r[field === 'answer' ? 'question' : 'followup_question'] || ''),
          theme: String(r.theme || ''), source_time: String(r[field === 'answer' ? 'answered_at' : 'followup_answered_at'] || ''),
          thread_ts: String(r.thread_ts || ''), media_url: String(r.media_url || ''), media_type: String(r.media_type || '')
        };
        var hash = articleSnapshotHash(snapshot);
        if (!previous || previous.content_hash !== hash) {
          var record = Object.assign({}, snapshot, {
            revision_id: articleRevisionId('src'), source_id: key, source_kind: 'interview_raw',
            session_id: String(r.session_id), source_idx: String(r.idx), source_field: field,
            channel_id: getProp('SLACK_CHANNEL_ID', ''), observed_at: fmtDateTime(new Date()),
            content_hash: hash, supersedes_revision_id: previous ? previous.revision_id : '',
            change_origin: origin || 'observed_snapshot',
            // 公開可の判断はその版だけ。非公開指定は訂正後も引き継ぐ。
            publication_scope: previous && previous.publication_scope === 'private' ? 'private' : 'review_required',
            reason: '', deleted: text.trim() ? 'false' : 'true'
          });
          pending.push(record); latest[key] = record; previous = record;
        }
        var questionKey = String(r.session_id) + ':Q' + r.idx;
        if (!refs[questionKey]) refs[questionKey] = [];
        if (previous.deleted !== 'true') refs[questionKey].push(previous.revision_id);
      });
    });
    appendRowsObj('SourceRevisions', pending);
    return refs;
  });
}

/** AI原稿は二次資料。user は管理UIの明示的操作だけに付ける。 */
function archiveEditorialRows(rows, actor, eventType, reason) {
  if (!articleArchiveEnabled()) return 0;
  return withArticleArchiveLock(function () {
    var latest = latestArticleRecords(readTable('EditorialHistory'), 'post_id');
    var pending = [];
    rows.forEach(function (r) {
      var previous = latest[String(r.id)];
      var snapshot = { text: String(r.text || ''), status: String(r.status || ''),
        source_revision_ids: String(r.source_revision_ids || ''), edit_meta: String(r.edit_meta || '') };
      var hash = articleSnapshotHash(snapshot);
      if (previous && previous.content_hash === hash) return;
      var record = Object.assign({}, snapshot, {
        event_id: articleRevisionId('editrev'), post_id: String(r.id), session_id: String(r.session_id || ''),
        source_idx: String(r.source_idx || ''), observed_at: fmtDateTime(new Date()),
        actor_type: actor || 'unknown', event_type: eventType || 'observed_snapshot', reason: String(reason || ''),
        content_hash: hash, previous_event_id: previous ? previous.event_id : ''
      });
      pending.push(record); latest[String(r.id)] = record;
    });
    appendRowsObj('EditorialHistory', pending);
    return pending.length;
  });
}

/** 回収失敗で既存の回答保存・投稿編集を妨げない。原本から次回再回収する。 */
function tryArchiveInterviewSources(rows, origin) {
  try { return archiveInterviewSources(rows, origin); }
  catch (e) { logEvent('article_archive_error', 'interview: ' + String(e).slice(0, 250)); return {}; }
}

function tryArchiveEditorialRows(rows, actor, eventType, reason) {
  try { return archiveEditorialRows(rows, actor, eventType, reason); }
  catch (e) { logEvent('article_archive_error', 'stock: ' + String(e).slice(0, 250)); return 0; }
}

function archiveWebStock(id, actor, eventType, reason) {
  try {
    if (!articleArchiveEnabled()) return;
    archiveEditorialRows(readTable(SHEET.STOCK).filter(function (r) { return String(r.id) === String(id); }), actor, eventType, reason);
  } catch (e) { logEvent('article_archive_error', 'web: ' + String(e).slice(0, 250)); }
}

/** 手動回収にも使える。過去の失われた版や行削除は復元しない。 */
function captureArticleArchive() {
  if (!articleArchiveEnabled()) return { enabled: false };
  var refs = archiveInterviewSources(readTable(SHEET.INTERVIEWS), 'observed_snapshot');
  var edits = archiveEditorialRows(readTable(SHEET.STOCK), 'unknown', 'observed_snapshot');
  return { enabled: true, questions: Object.keys(refs).length, new_editorial_events: edits };
}

/** Sheetsでの直接編集は実行時に観測できた状態を保存。API経由の変更は各保存箇所で回収する。 */
function onArticleArchiveEdit(e) {
  if (!e || !e.range || e.range.getRow() < 2) return;
  var name = e.range.getSheet().getName();
  if ([SHEET.INTERVIEWS, SHEET.STOCK].indexOf(name) < 0) return;
  var start = e.range.getRow(), end = e.range.getLastRow();
  var rows = readTable(name).filter(function (r) { return r._row >= start && r._row <= end; });
  if (name === SHEET.INTERVIEWS) tryArchiveInterviewSources(rows, 'sheet_edit_observed');
  else tryArchiveEditorialRows(rows, 'unknown', 'sheet_edit_observed');
}

/** 将来の執筆処理向け。既定は本人が公開可とした最新原文のみ。AI投稿を混ぜない。 */
function getArticleSourceBundle(includeReviewRequired) {
  if (!articleArchiveEnabled()) return [];
  var current = {};
  readTable(SHEET.INTERVIEWS).forEach(function (r) {
    ['answer', 'followup_answer'].forEach(function (field) {
      var skipped = String(r[field === 'answer' ? 'answered_at' : 'followup_answered_at']) === 'skipped';
      current['interview:' + r.session_id + ':Q' + r.idx + ':' + field] = skipped ? '' : String(r[field] || '');
    });
  });
  var latest = latestArticleRecords(readTable('SourceRevisions'), 'source_id');
  return Object.keys(latest).map(function (key) { return latest[key]; }).filter(function (r) {
    return r.deleted !== 'true' && current[r.source_id] === r.text && (r.publication_scope === 'allowed' ||
      (includeReviewRequired === true && r.publication_scope === 'review_required'));
  });
}
