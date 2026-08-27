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
 * @returns {Object} 成功なら {base64, mimeType, name}、失敗なら {problem, name}
 */
function fetchSlackFile(file) {
  if (!file) return { problem: 'ファイル情報がありません', name: '' };
  var maxBytes = Number(getProp('MAX_IMAGE_BYTES', '4000000')); // Claudeの上限に合わせる

  // 元ファイル → サムネイルの順に試す。SlackのサムネイルはJPEG/PNGに
  // 変換済みなので、HEICのような未対応形式や大きすぎる画像の逃げ道になる
  var candidates = [
    { url: file.url_private_download || file.url_private, label: '元ファイル' },
    { url: file.thumb_1024, label: 'サムネイル1024' },
    { url: file.thumb_720, label: 'サムネイル720' },
    { url: file.thumb_360, label: 'サムネイル360' },
  ].filter(function (c) { return c.url; });

  var lastProblem = '';
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    try {
      var res = slackFileFetch(c.url);
      if (!res) continue;
      var code = res.getResponseCode();
      if (code >= 300) {
        // 403/404 はほぼ権限。番号だけ出しても何をすればいいか分からない
        lastProblem = (code === 403 || code === 404)
          ? 'HTTP ' + code + '（権限不足）。Slackアプリの Bot Token Scopes に files:read を追加し、' +
            'Reinstall to Workspace を実行してください'
          : 'HTTP ' + code;
        continue;
      }
      var bytes = res.getBlob().getBytes();
      if (bytes.length > maxBytes) {
        lastProblem = c.label + 'が大きすぎます（' + Math.round(bytes.length / 1024) + 'KB）';
        continue; // 次のサムネイルなら収まるかもしれない
      }

      // Slackが申告する mimetype は信用しない。認証に失敗するとログインページの
      // HTMLが200で返るが、mimetype は image/png のままなので、そのまま送ると
      // Claudeが "Could not process image" で400を返す。中身で判定する。
      var mime = detectImageMime(bytes);
      if (!mime) {
        var head = '';
        try { head = res.getContentText().slice(0, 120).replace(/\s+/g, ' '); } catch (e2) { /* バイナリ */ }
        lastProblem = /<html|<!doctype|signin|login/i.test(head)
          ? 'ログインページが返っています。Slackアプリの Bot Token Scopes に files:read を追加して Reinstall to Workspace を実行してください'
          : c.label + 'を画像として認識できません（申告: ' + (file.mimetype || '不明') + '）';
        if (head) lastProblem += ' 先頭: ' + head;
        continue;
      }

      if (i > 0) logEvent('slack_file', c.label + 'を使いました: ' + (file.name || ''));
      return {
        base64: Utilities.base64Encode(bytes),
        mimeType: mime,
        name: String(file.name || ''),
      };
    } catch (e) {
      lastProblem = String(e).slice(0, 150);
    }
  }

  var problem = lastProblem || '取得できませんでした';
  logEvent('slack_file_error', (file.name || '') + ': ' + problem);
  // 呼び出し側が理由をSlackへ出せるよう、理由つきで返す（nullだと原因が消える）
  return { problem: problem, name: String(file.name || '') };
}

/**
 * ボットトークンを付けてSlackのファイルを取る。
 * リダイレクトを自動で追うと Authorization ヘッダが落ちて認証されないため、
 * 自分で追いかけてヘッダを付け直す。
 */
function slackFileFetch(url) {
  var token = requireProp('SLACK_BOT_TOKEN');
  var current = url;
  for (var hop = 0; hop < 3; hop++) {
    var res = UrlFetchApp.fetch(current, {
      headers: { Authorization: 'Bearer ' + token },
      followRedirects: false,
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code < 300 || code >= 400) return res;
    var next = res.getHeaders().Location || res.getHeaders().location;
    if (!next) return res;
    current = next;
  }
  logEvent('slack_file_error', 'リダイレクトが多すぎます: ' + url);
  return null;
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
