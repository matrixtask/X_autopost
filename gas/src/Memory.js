/**
 * Memory.js — 本人フィードバックの永続メモリ
 *
 * 採点結果が出た後などにSlackスレッドへ自由記述で書いたコメントを
 * Memoryシートに取り込み、以後の「下書き生成・リライト・採点」の
 * プロンプトに常時反映する。
 *
 * 取り込み経路:
 *   1. 完了済みインタビューのスレッドへの返信（全文をメモとして取り込む）
 *   2. チャンネル直下で「メモ: 〜」と書く（インタビュー進行中でも使える）
 *
 * 運用: Memoryシートの status を 'archived' にすると反映対象から外れる。
 */

function memorySheet() {
  var spreadsheet = ss();
  var sheet = spreadsheet.getSheetByName(SHEET.MEMORY);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET.MEMORY);
    var headers = SHEET_HEADERS.Memory;
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
  }
  return sheet;
}

function addMemory(note, source) {
  var t = String(note || '').trim();
  if (!t) return false;
  memorySheet();
  appendRowObj(SHEET.MEMORY, {
    created_at: fmtDateTime(nowJst()),
    note: t,
    source: source || '',
    status: 'active',
  });
  logEvent('memory_add', t.slice(0, 80));
  return true;
}

/** activeなメモを新しい順に最大limit件返す */
function getMemoryNotes(limit) {
  memorySheet();
  var rows = readTable(SHEET.MEMORY).filter(function (r) {
    return String(r.status) === 'active' && String(r.note).trim();
  });
  return rows.slice(-1 * (limit || 20)).map(function (r) { return String(r.note).trim(); });
}

/** 生成・採点プロンプトに差し込むブロック。メモが無ければ空文字 */
function buildMemoryPrompt() {
  var notes = getMemoryNotes(20);
  if (!notes.length) return '';
  return [
    '本人からの運用フィードバック（最優先で従うこと）:',
    notes.map(function (n) { return '- ' + n; }).join('\n'),
  ].join('\n');
}

/**
 * スレッドへの返信をメモとして取り込む。
 * doPost から、進行中インタビューに一致しなかった場合に呼ばれる。
 * 専用チャンネルなので、完了済みインタビューだけでなく品質ゲート結果や
 * 週次サマリなど、どの通知メッセージのスレッドへの返信でもメモ扱いにする。
 */
function handleThreadFeedback(threadTs, text) {
  var t = String(text || '').trim();
  if (!t) return false;
  var isInterviewThread = readTable(SHEET.INTERVIEWS).some(function (r) {
    return slackTsEqual(r.thread_ts, threadTs);
  });
  addMemory(t, isInterviewThread ? 'インタビュースレッドの自由記述' : '通知スレッドへの返信');
  sendSlack(':memo: メモとして取り込みました。今後の生成・採点に反映します。', threadTs);
  return true;
}
