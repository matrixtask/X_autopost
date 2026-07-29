/**
 * Sheets.js — スプレッドシートをDBとして使うためのヘルパー
 */

var SHEET_HEADERS = {
  // inferred_question: 手動投稿から逆算した「この投稿を引き出せたであろう質問」
  Stock: ['id', 'created_at', 'theme', 'category', 'session_id', 'text', 'score', 'score_reason', 'status', 'scheduled_at', 'posted_at', 'tweet_id', 'notion_page_id', 'impressions', 'likes', 'retweets', 'replies', 'metrics_at', 'refines', 'promoted', 'paid_impressions', 'profile_clicks', 'link_clicks', 'axes', 'inferred_question'],
  Interviews: ['session_id', 'thread_ts', 'idx', 'theme', 'category', 'question', 'answer', 'answered_at', 'status'],
  // weight は実績から自動更新される。base_weight は手で決めた初期値で、
  // 学習はここを起点に増減させる（前回の結果に掛け続けて発散しないようにするため）
  Themes: ['theme', 'category', 'weight', 'last_used', 'notes', 'base_weight', 'perf', 'perf_n'],
  Voice: ['text', 'note'],
  Log: ['timestamp', 'event', 'detail'],
  Memory: ['created_at', 'note', 'source', 'status'],
  Followers: ['date', 'followers', 'delta', 'posts_that_day', 'note'],
};

function ss() {
  return SpreadsheetApp.openById(requireProp('SPREADSHEET_ID'));
}

function getSheet(name) {
  var sheet = ss().getSheetByName(name);
  if (!sheet) throw new Error('シートがありません: ' + name + '（setupSpreadsheet() を実行してください）');
  return sheet;
}

/**
 * 初回セットアップ: シート作成 + ヘッダー + テーマ初期データ投入。
 * GASエディタから手動で1回実行する。
 */
function setupSpreadsheet() {
  var spreadsheet = ss();
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    var headers = SHEET_HEADERS[name];
    var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (String(current[0]) !== headers[0]) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
    // 日時やSlackのts（例: 1752624000.123456）が勝手にDate/数値へ変換されないよう全列テキスト書式にする
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
  });
  seedThemesIfEmpty();
  logEvent('setup', 'シートを初期化しました');
  return 'OK: ' + spreadsheet.getUrl();
}

/** 既存シートに後から増えた列（メトリクス等）のヘッダーを追記する */
function ensureHeaders(sheetName) {
  var sheet = getSheet(sheetName);
  var headers = SHEET_HEADERS[sheetName];
  var width = sheet.getLastColumn();
  var current = width > 0 ? sheet.getRange(1, 1, 1, width).getValues()[0].map(String) : [];
  if (current.length < headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
  }
}

/** シート全体をオブジェクト配列で読む。_row に行番号（1始まり）を持たせる */
function readTable(sheetName) {
  var sheet = getSheet(sheetName);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(String);
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i].every(function (c) { return c === '' || c === null; })) continue;
    var obj = { _row: i + 1 };
    headers.forEach(function (h, j) {
      var v = values[i][j];
      // 既存シートで書式がテキストでなかった場合の保険: Dateは常に文字列へ正規化
      obj[h] = v instanceof Date ? fmtDateTime(v) : v;
    });
    rows.push(obj);
  }
  return rows;
}

function appendRowObj(sheetName, obj) {
  var headers = SHEET_HEADERS[sheetName];
  var row = headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; });
  getSheet(sheetName).appendRow(row);
}

/**
 * 複数行をまとめて追記する。appendRowを繰り返すと1行あたり100ms前後かかり
 * 数百行で実行時間上限に当たるため、setValuesで一括書き込みする。
 */
function appendRowsObj(sheetName, objs) {
  if (!objs || !objs.length) return 0;
  var headers = SHEET_HEADERS[sheetName];
  var sheet = getSheet(sheetName);
  var rows = objs.map(function (obj) {
    return headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; });
  });
  var start = sheet.getLastRow() + 1;
  if (start + rows.length > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), start + rows.length - sheet.getMaxRows());
  }
  sheet.getRange(start, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

/**
 * 行番号を指定して1列だけをまとめて書き込む。
 * updateStockById は1回ごとにシート全体を読み直すため、数百件の一括更新には
 * 使えない（遡及採点など）。readTable の _row をそのまま渡して使う。
 * @param {Array} entries [{row: 12, value: '...'}]
 */
function setColumnByRows(sheetName, column, entries) {
  var col = SHEET_HEADERS[sheetName].indexOf(column);
  if (col < 0 || !entries || !entries.length) return 0;
  var sheet = getSheet(sheetName);
  entries.forEach(function (e) { sheet.getRange(e.row, col + 1).setValue(e.value); });
  return entries.length;
}

/** keyColumn=value の行の複数カラムを更新する */
function updateRowsWhere(sheetName, keyColumn, value, updates) {
  var headers = SHEET_HEADERS[sheetName];
  var sheet = getSheet(sheetName);
  var rows = readTable(sheetName);
  var count = 0;
  rows.forEach(function (r) {
    if (String(r[keyColumn]) !== String(value)) return;
    Object.keys(updates).forEach(function (col) {
      var colIdx = headers.indexOf(col);
      if (colIdx < 0) return;
      sheet.getRange(r._row, colIdx + 1).setValue(updates[col]);
    });
    count++;
  });
  return count;
}

function updateStockById(id, updates) {
  return updateRowsWhere(SHEET.STOCK, 'id', id, updates);
}

function logEvent(event, detail) {
  try {
    appendRowObj(SHEET.LOG, {
      timestamp: fmtDateTime(new Date()) ,
      event: event,
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
    });
  } catch (e) {
    console.error('logEvent failed: ' + e);
  }
}
