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

function oauth1Header(method, url, queryParams) {
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
  // 署名対象 = oauthパラメータ + クエリパラメータ（JSONボディは含めない）
  var all = {};
  Object.keys(oauth).forEach(function (k) { all[k] = oauth[k]; });
  Object.keys(queryParams || {}).forEach(function (k) { all[k] = queryParams[k]; });
  var paramString = Object.keys(all).sort().map(function (k) {
    return percentEncode(k) + '=' + percentEncode(all[k]);
  }).join('&');
  var base = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join('&');
  var signingKey = percentEncode(p.X_API_SECRET) + '&' + percentEncode(p.X_ACCESS_SECRET);
  var sigBytes = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, base, signingKey);
  oauth.oauth_signature = Utilities.base64Encode(sigBytes);
  return 'OAuth ' + Object.keys(oauth).sort().map(function (k) {
    return percentEncode(k) + '="' + percentEncode(oauth[k]) + '"';
  }).join(', ');
}

/**
 * 画像をXにアップロードして media_id を得る。
 *
 * メディアのアップロードは v2 に無いので v1.1 の media/upload を使う。
 * multipart/form-data のボディはOAuth1.0aの署名対象に含めない決まりなので、
 * 既存の oauth1Header（クエリのみ署名）がそのまま使える。
 *
 * @param {Blob} blob 画像のBlob
 * @returns {string} media_id_string
 */
function uploadMediaToX(blob) {
  var url = 'https://upload.twitter.com/1.1/media/upload.json';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { Authorization: oauth1Header('POST', url) },
    payload: { media: blob }, // contentTypeを指定しないとGASがmultipartで組み立てる
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code >= 300) throw new Error('メディアのアップロードに失敗 ' + code + ': ' + body.slice(0, 300));
  var json = JSON.parse(body);
  var id = json.media_id_string || (json.media_id && String(json.media_id));
  if (!id) throw new Error('media_id が返ってきませんでした: ' + body.slice(0, 200));
  return id;
}

function postTweet(text, mediaIds) {
  var url = 'https://api.twitter.com/2/tweets';
  var body = { text: text };
  if (mediaIds && mediaIds.length) body.media = { media_ids: mediaIds };
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: oauth1Header('POST', url) },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var resBody = res.getContentText();
  if (code >= 300) throw new Error('X API error ' + code + ': ' + resBody.slice(0, 300));
  return JSON.parse(resBody).data; // { id, text }
}

/**
 * 投稿直前に画像を取り直してXへ上げる。
 *
 * 画像そのものは持たず、Slackのファイル URL だけを Stock に持たせている。
 * 投稿は数日後になることもあるが、Slackのファイルは消さない限り残るので
 * その場で取り直すほうが、どこかに複製を溜めるより壊れにくい。
 *
 * @returns {Object} {ids: [media_id...], problem: '理由'}
 */
function prepareMediaForPost(row) {
  var url = String(row.media_url || '').trim();
  if (!url) return { ids: [], problem: '' };
  var got = fetchSlackFile({
    url_private_download: url,
    mimetype: String(row.media_type || ''),
    name: String(row.id || ''),
  });
  if (!got || !got.base64) {
    return { ids: [], problem: (got && got.problem) || '画像を取得できませんでした' };
  }
  try {
    var blob = Utilities.newBlob(Utilities.base64Decode(got.base64), got.mimeType, 'image');
    return { ids: [uploadMediaToX(blob)], problem: '' };
  } catch (e) {
    return { ids: [], problem: String(e).slice(0, 200) };
  }
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
    var hasMedia = String(post.media_url || '').trim() !== '';
    if (isDryRun()) {
      updateStockById(post.id, { status: STATUS.POSTED, posted_at: now, tweet_id: 'dry-run' });
      logEvent('post_dry_run', post.id + ': ' + text.slice(0, 60));
      notifySlack(':sparkles: [DRY RUN] 投稿予定の内容です（実際には投稿していません）:\n' + text +
        (hasMedia ? '\n（画像1枚を添付予定）' : ''));
      syncSafe(post.id);
      return;
    }
    try {
      // 画像の準備に失敗しても本文だけは出す。予約枠を落とすより、
      // 添付なしで出して警告を出すほうが被害が小さい
      var media = { ids: [], problem: '' };
      if (hasMedia) {
        media = prepareMediaForPost(post);
        if (media.problem) {
          logEvent('media_failed', post.id + ': ' + media.problem);
          notifySlack(':warning: 画像を添付できませんでした（' + post.id + '）: ' + media.problem +
            '\n本文だけを投稿します。');
        }
      }
      var tweet = postTweet(text, media.ids);
      updateStockById(post.id, { status: STATUS.POSTED, posted_at: now, tweet_id: tweet.id });
      logEvent('posted', post.id + ' tweet_id=' + tweet.id + (media.ids.length ? ' media=1' : ''));
      notifySlack(':bird: 投稿しました' + (media.ids.length ? '（画像つき）' : '') + ':\n' + text +
        '\nhttps://x.com/i/web/status/' + tweet.id);
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

/** X API v2 のGET呼び出し（クエリパラメータ込みでOAuth1署名する） */
function xApiGet(path, params) {
  var url = 'https://api.twitter.com/2' + path;
  var qs = Object.keys(params || {}).map(function (k) {
    return percentEncode(k) + '=' + percentEncode(params[k]);
  }).join('&');
  var res = UrlFetchApp.fetch(url + (qs ? '?' + qs : ''), {
    headers: { Authorization: oauth1Header('GET', url, params) },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code >= 300) throw new Error('X API error ' + code + ': ' + body.slice(0, 300));
  return JSON.parse(body);
}

/**
 * 自分の直近ポストをX APIから取得してVoiceシートに投入する（手動で1回実行）。
 * X_API_KEY等の4プロパティが必要。RT・リプライは除外し、既存分と重複しない
 * ものだけ追加する。
 * 注意: X APIのFreeプランは読み取り上限が非常に小さい。403/429で失敗する場合は
 * アーカイブ取り込み（importVoicePosts）を使うこと。
 */
function importVoiceFromX() {
  var me = xApiGet('/users/me', {});
  var userId = me.data.id;
  var result = xApiGet('/users/' + userId + '/tweets', {
    max_results: '100',
    exclude: 'retweets,replies',
  });
  var texts = (result.data || []).map(function (t) { return String(t.text || ''); });
  var added = importVoicePosts(texts, 'X import ' + fmtDate(nowJst()));
  return added + '件をVoiceシートに追加しました（取得' + texts.length + '件）';
}
