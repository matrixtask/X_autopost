/**
 * Notion.js — ストックをNotionデータベースへ同期（任意機能）
 *
 * NOTION_TOKEN / NOTION_DATABASE_ID が未設定なら何もしない。
 *
 * Notion側のデータベースに必要なプロパティ:
 *   Name (タイトル) / Status (セレクト) / Category (セレクト) /
 *   Score (数値) / Scheduled (日付) / Posted (日付) / Body (テキスト)
 */

function notionEnabled() {
  return !!(getProp('NOTION_TOKEN') && getProp('NOTION_DATABASE_ID'));
}

function notionApi(method, path, payload) {
  var res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, {
    method: method,
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + requireProp('NOTION_TOKEN'),
      'Notion-Version': '2022-06-28',
    },
    payload: payload ? JSON.stringify(payload) : undefined,
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code >= 300) throw new Error('Notion API error ' + code + ': ' + body.slice(0, 300));
  return JSON.parse(body);
}

function buildNotionProperties(row) {
  var text = String(row.text || '');
  var properties = {
    Name: { title: [{ text: { content: text.slice(0, 60) || '(本文なし)' } }] },
    Status: { select: { name: String(row.status || 'draft') } },
    Body: { rich_text: [{ text: { content: text.slice(0, 1900) } }] },
  };
  if (row.category) properties.Category = { select: { name: String(row.category) } };
  if (row.score !== '' && row.score !== null && row.score !== undefined) {
    properties.Score = { number: Number(row.score) };
  }
  if (row.scheduled_at) properties.Scheduled = { date: { start: toIsoJst(String(row.scheduled_at)) } };
  if (row.posted_at) properties.Posted = { date: { start: toIsoJst(String(row.posted_at)) } };
  return properties;
}

function toIsoJst(ymdhm) {
  // 'yyyy-MM-dd HH:mm' -> ISO8601 (+09:00)
  return ymdhm.replace(' ', 'T') + ':00+09:00';
}

/** Stockの1行をNotionへ作成/更新する */
function syncStockRowToNotion(id) {
  if (!notionEnabled()) return;
  var row = readTable(SHEET.STOCK).filter(function (r) { return String(r.id) === String(id); })[0];
  if (!row) return;
  var properties = buildNotionProperties(row);
  if (row.notion_page_id) {
    notionApi('patch', '/pages/' + row.notion_page_id, { properties: properties });
  } else {
    var page = notionApi('post', '/pages', {
      parent: { database_id: requireProp('NOTION_DATABASE_ID') },
      properties: properties,
    });
    updateStockById(id, { notion_page_id: page.id });
  }
}

/** NotionのプロパティからプレーンテキストをJavaScriptの文字列にする */
function notionPlainText(richArray) {
  return (richArray || []).map(function (t) { return t.plain_text || ''; }).join('').trim();
}

/**
 * Notionの「トークテーマ（運用中）_X」データベース → Themesシート同期。
 * Notionに行を足す/重み・メモを変える/状態を「停止」にする だけで
 * 毎朝のインタビューのテーマ選定に反映される（Notionがテーマのマスター）。
 *
 * 必要プロパティ: NOTION_TOKEN, NOTION_THEMES_DATABASE_ID
 * Notion側スキーマ: Name(タイトル) / カテゴリ(定番|時事|ネタ) / 重み(数値) /
 *                  状態(運用中|停止) / メモ / 出典
 */
function syncThemesFromNotion() {
  if (!getProp('NOTION_TOKEN') || !getProp('NOTION_THEMES_DATABASE_ID')) {
    return 'スキップ（NOTION_TOKEN / NOTION_THEMES_DATABASE_ID 未設定）';
  }
  var dbId = getProp('NOTION_THEMES_DATABASE_ID');
  var pages = [];
  var cursor = null;
  do {
    var payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    var res = notionApi('post', '/databases/' + dbId + '/query', payload);
    pages = pages.concat(res.results || []);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  var catMap = { '定番': 'evergreen', '時事': 'news', 'ネタ': 'neta' };
  var existing = {};
  readTable(SHEET.THEMES).forEach(function (r) {
    existing[String(r.theme).trim()] = r;
  });

  var added = 0;
  var updated = 0;
  pages.forEach(function (page) {
    var p = page.properties || {};
    var theme = notionPlainText(p['Name'] && p['Name'].title);
    if (!theme) return;
    var stopped = p['状態'] && p['状態'].select && p['状態'].select.name === '停止';
    var category = catMap[(p['カテゴリ'] && p['カテゴリ'].select && p['カテゴリ'].select.name) || ''] || 'evergreen';
    // 停止は重み0にして選定対象から外す（行は残す）
    var weight = stopped ? 0 : (p['重み'] && typeof p['重み'].number === 'number' ? p['重み'].number : 1);
    var memo = notionPlainText(p['メモ'] && p['メモ'].rich_text);
    var source = notionPlainText(p['出典'] && p['出典'].rich_text);
    var notes = memo + (source ? '（出典: ' + source + '）' : '');

    var row = existing[theme];
    if (!row) {
      appendRowObj(SHEET.THEMES, { theme: theme, category: category, weight: weight, last_used: '', notes: notes });
      added++;
    } else if (String(row.category) !== category || Number(row.weight) !== weight || String(row.notes) !== notes) {
      updateRowsWhere(SHEET.THEMES, 'theme', theme, { category: category, weight: weight, notes: notes });
      updated++;
    }
  });

  var msg = 'Notionテーマ同期: ' + pages.length + '件中 追加' + added + ' / 更新' + updated;
  logEvent('themes_sync', msg);
  return msg;
}

/** 手動実行用: 全ストックをNotionへ同期し直す */
function syncAllStockToNotion() {
  if (!notionEnabled()) return 'Notion未設定のためスキップ';
  var rows = readTable(SHEET.STOCK);
  rows.forEach(function (r) {
    try {
      syncStockRowToNotion(r.id);
    } catch (e) {
      logEvent('notion_error', r.id + ': ' + e);
    }
  });
  return rows.length + '件を同期しました';
}
