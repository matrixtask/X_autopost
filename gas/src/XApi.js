/**
 * XApi.js — X API v2 への投稿（OAuth 1.0a User Context）
 *
 * 毎時トリガーの postTick() が、予約時刻を過ぎた scheduled を投稿する。
 * DRY_RUN=true（既定）の間は投稿せず、ログとSlack通知のみ。
 */

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function oauth1Header(method, url) {
  var p = props();
  ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'].forEach(function (k) {
    if (!p[k]) throw new Error('スクリプトプロパティ ' + k + ' が未設定です');
  });
  var oauth = {
    oauth_consumer_key: p.X_API_KEY,
    oauth_nonce: Utilities.getUuid().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: p.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  // JSONボディはOAuth1署名のパラメータに含めない（フォームエンコードのみ対象）
  var paramString = Object.keys(oauth).sort().map(function (k) {
    return percentEncode(k) + '=' + percentEncode(oauth[k]);
  }).join('&');
  var base = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join('&');
  var signingKey = percentEncode(p.X_API_SECRET) + '&' + percentEncode(p.X_ACCESS_SECRET);
  var sigBytes = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, base, signingKey);
  oauth.oauth_signature = Utilities.base64Encode(sigBytes);
  return 'OAuth ' + Object.keys(oauth).sort().map(function (k) {
    return percentEncode(k) + '="' + percentEncode(oauth[k]) + '"';
  }).join(', ');
}

function postTweet(text) {
  var url = 'https://api.twitter.com/2/tweets';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: oauth1Header('POST', url) },
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code >= 300) throw new Error('X API error ' + code + ': ' + body.slice(0, 300));
  return JSON.parse(body).data; // { id, text }
}

/**
 * 毎時トリガー: 予約時刻を過ぎた投稿を順に投稿する。
 */
function postTick() {
  var now = fmtDateTime(nowJst());
  var due = readTable(SHEET.STOCK)
    .filter(function (r) {
      return String(r.status) === STATUS.SCHEDULED && r.scheduled_at && String(r.scheduled_at) <= now;
    })
    .sort(function (a, b) { return String(a.scheduled_at) < String(b.scheduled_at) ? -1 : 1; });

  due.forEach(function (post) {
    var text = String(post.text);
    if (isDryRun()) {
      updateStockById(post.id, { status: STATUS.POSTED, posted_at: now, tweet_id: 'dry-run' });
      logEvent('post_dry_run', post.id + ': ' + text.slice(0, 60));
      notifySlack(':sparkles: [DRY RUN] 投稿予定の内容です（実際には投稿していません）:\n' + text);
      syncSafe(post.id);
      return;
    }
    try {
      var tweet = postTweet(text);
      updateStockById(post.id, { status: STATUS.POSTED, posted_at: now, tweet_id: tweet.id });
      logEvent('posted', post.id + ' tweet_id=' + tweet.id);
      notifySlack(':bird: 投稿しました:\n' + text + '\nhttps://x.com/i/web/status/' + tweet.id);
    } catch (e) {
      updateStockById(post.id, { status: STATUS.FAILED });
      logEvent('post_failed', post.id + ': ' + e);
      notifySlack(':rotating_light: 投稿に失敗しました（' + post.id + '）: ' + e);
    }
    syncSafe(post.id);
  });
  return due.length;
}

function syncSafe(id) {
  try {
    syncStockRowToNotion(id);
  } catch (e) {
    logEvent('notion_error', id + ': ' + e);
  }
}
