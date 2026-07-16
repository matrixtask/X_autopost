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
