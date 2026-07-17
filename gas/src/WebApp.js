/**
 * WebApp.js — Webアプリのエンドポイント
 *
 * doGet  : モバイル対応の確認・承認UI（?token=ADMIN_TOKEN）
 * doPost : Slack Events APIの受け口（インタビューのスレッド返信）
 *
 * デプロイ: GASエディタ > デプロイ > 新しいデプロイ > ウェブアプリ
 *   実行ユーザー: 自分 / アクセス: 全員
 * デプロイURLを Script Properties の WEBAPP_URL に保存し、
 * SlackアプリのEvent SubscriptionsのRequest URLにも設定する。
 */

function doGet(e) {
  var token = e && e.parameter ? e.parameter.token : '';
  if (!token || token !== getProp('ADMIN_TOKEN')) {
    return HtmlService.createHtmlOutput('<p>token が違います。URL末尾の ?token=... を確認してください。</p>');
  }
  var template = HtmlService.createTemplateFromFile('Index');
  template.token = token;
  return template.evaluate()
    .setTitle('X Autopost ストック')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('bad request');
  }

  // SlackのURL検証
  if (payload.type === 'url_verification') {
    return ContentService.createTextOutput(payload.challenge);
  }

  // 文体サンプルの一括取り込み（Xアーカイブ等から。ADMIN_TOKEN必須）
  // 例: POST {"action":"import_voice","token":"...","posts":["...","..."],"note":"archive"}
  if (payload.action === 'import_voice') {
    if (!payload.token || payload.token !== getProp('ADMIN_TOKEN')) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }
    var added = importVoicePosts(payload.posts || [], payload.note || 'import');
    return ContentService.createTextOutput(JSON.stringify({ ok: true, added: added }));
  }

  if (payload.type === 'event_callback') {
    // GASはリクエストヘッダを読めないため署名検証ができない。
    // 代わりにチャンネルIDの一致を確認し、event_idで重複排除する。
    var event = payload.event || {};
    var eventId = payload.event_id;
    var cache = CacheService.getScriptCache();
    if (eventId) {
      if (cache.get('ev_' + eventId)) return ContentService.createTextOutput('dup');
      cache.put('ev_' + eventId, '1', 3600);
    }
    if (
      event.type === 'message' &&
      !event.bot_id &&
      !event.subtype &&
      event.thread_ts &&
      String(event.channel) === String(getProp('SLACK_CHANNEL_ID'))
    ) {
      try {
        handleInterviewReply(event.thread_ts, event.text);
      } catch (err) {
        logEvent('slack_event_error', String(err));
      }
    }
  }
  return ContentService.createTextOutput('ok');
}

// ---- Web UI から google.script.run で呼ばれるAPI ----

function assertToken(token) {
  if (!token || token !== getProp('ADMIN_TOKEN')) throw new Error('認証エラー');
}

function api_listPosts(token) {
  assertToken(token);
  var rows = readTable(SHEET.STOCK).map(function (r) {
    return {
      id: String(r.id),
      created_at: String(r.created_at),
      theme: String(r.theme),
      category: String(r.category),
      text: String(r.text),
      score: r.score === '' ? null : Number(r.score),
      score_reason: String(r.score_reason || ''),
      status: String(r.status),
      scheduled_at: String(r.scheduled_at || ''),
      posted_at: String(r.posted_at || ''),
    };
  });
  rows.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
  return JSON.stringify(rows);
}

function api_setStatus(token, id, status) {
  assertToken(token);
  var allowed = [STATUS.APPROVED, STATUS.REJECTED, STATUS.READY, STATUS.STOCK];
  if (allowed.indexOf(status) < 0) throw new Error('不正なステータス: ' + status);
  var updates = { status: status };
  if (status !== STATUS.SCHEDULED) updates.scheduled_at = '';
  updateStockById(id, updates);
  logEvent('webapp_status', id + ' -> ' + status);
  try { syncStockRowToNotion(id); } catch (e) { logEvent('notion_error', id + ': ' + e); }
  return 'ok';
}

function api_updateText(token, id, text) {
  assertToken(token);
  var t = String(text || '').trim();
  if (!t) throw new Error('本文が空です');
  if (!fitsInTweet(t)) throw new Error('長すぎます（280重み超過）。現在: ' + weightedTweetLength(t));
  updateStockById(id, { text: t });
  logEvent('webapp_edit', id);
  try { syncStockRowToNotion(id); } catch (e) { logEvent('notion_error', id + ': ' + e); }
  return 'ok';
}

function api_scheduleNow(token) {
  assertToken(token);
  var scheduled = scheduleApprovedPosts();
  return JSON.stringify(scheduled);
}
