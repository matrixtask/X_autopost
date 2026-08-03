/**
 * Slack.js — Slack Bot API クライアント
 */

function slackApi(method, payload) {
  var token = requireProp('SLACK_BOT_TOKEN');
  var res = UrlFetchApp.fetch('https://slack.com/api/' + method, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var json = JSON.parse(res.getContentText());
  if (!json.ok) {
    logEvent('slack_error', method + ': ' + res.getContentText().slice(0, 300));
    throw new Error('Slack API error (' + method + '): ' + json.error);
  }
  return json;
}

/**
 * Slackに添付されたファイルを取得してbase64で返す。
 *
 * url_private_download はボットトークンを付けないと取れない（付けないと
 * ログイン画面のHTMLが返ってくる）。Bot Token Scopes に files:read が必要。
 *
 * @returns {Object|null} {base64, mimeType, name} 取れなければ null
 */
function fetchSlackFile(file) {
  var url = file && (file.url_private_download || file.url_private);
  if (!url) return null;
  var maxBytes = Number(getProp('MAX_IMAGE_BYTES', '4000000')); // Claudeの上限に合わせる
  try {
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + requireProp('SLACK_BOT_TOKEN') },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) {
      logEvent('slack_file_error', 'HTTP ' + res.getResponseCode() + ' ' + (file.name || ''));
      return null;
    }
    var blob = res.getBlob();
    var bytes = blob.getBytes();
    if (bytes.length > maxBytes) {
      logEvent('slack_file_error', '大きすぎます（' + Math.round(bytes.length / 1024) + 'KB）: ' + (file.name || ''));
      return null;
    }
    // Slackのmimetypeを優先する（Blobは application/octet-stream になることがある）
    var mime = String(file.mimetype || blob.getContentType() || '');
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(mime)) {
      logEvent('slack_file_error', '対応していない形式です: ' + mime);
      return null;
    }
    return {
      base64: Utilities.base64Encode(bytes),
      mimeType: mime === 'image/jpg' ? 'image/jpeg' : mime,
      name: String(file.name || ''),
    };
  } catch (e) {
    logEvent('slack_file_error', String(e).slice(0, 200));
    return null;
  }
}

/** チャンネル（またはスレッド）にメッセージを送る。戻り値に ts が入る */
function sendSlack(text, threadTs) {
  var payload = {
    channel: requireProp('SLACK_CHANNEL_ID'),
    text: text,
    unfurl_links: false,
  };
  if (threadTs) payload.thread_ts = threadTs;
  return slackApi('chat.postMessage', payload);
}

/** 通知だけしたい場面用。失敗しても本処理を止めない */
function notifySlack(text, threadTs) {
  try {
    return sendSlack(text, threadTs);
  } catch (e) {
    console.error('notifySlack failed: ' + e);
    return null;
  }
}
