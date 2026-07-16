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
