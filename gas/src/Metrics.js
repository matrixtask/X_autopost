/**
 * Metrics.js — 投稿済みポストのトラクション（インプ・いいね等）収集
 *
 * fetchTweetMetrics() が posted のツイートをX APIからまとめて取得し
 * （100件まで1リクエスト。Freeプランの読み取り枠でも週1なら余裕）、
 * Stockシートの impressions/likes/retweets/replies に記録する。
 * installTriggers() で毎週月曜8時台に自動実行される。
 */

function fetchTweetMetrics() {
  ensureHeaders(SHEET.STOCK);
  var posted = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.status) === STATUS.POSTED &&
      r.tweet_id && String(r.tweet_id) !== 'dry-run';
  });
  if (!posted.length) return '対象なし（実投稿された行がありません）';

  var byTweetId = {};
  posted.forEach(function (r) { byTweetId[String(r.tweet_id)] = r; });
  var ids = Object.keys(byTweetId);

  var now = fmtDateTime(nowJst());
  var updated = 0;
  // X APIは1リクエスト100件まで
  for (var i = 0; i < ids.length; i += 100) {
    var chunk = ids.slice(i, i + 100);
    var res = xApiGet('/tweets', {
      ids: chunk.join(','),
      'tweet.fields': 'public_metrics',
    });
    (res.data || []).forEach(function (t) {
      var row = byTweetId[String(t.id)];
      var m = t.public_metrics || {};
      if (!row) return;
      updateStockById(row.id, {
        impressions: m.impression_count || 0,
        likes: m.like_count || 0,
        retweets: m.retweet_count || 0,
        replies: m.reply_count || 0,
        metrics_at: now,
      });
      updated++;
    });
  }
  logEvent('metrics', updated + '件のメトリクスを更新');
  return updated + '件のメトリクスを更新しました';
}

/**
 * 週次トリガー: メトリクス取得 → ベスト3をSlack通知
 */
function weeklyMetricsReport() {
  var result;
  try {
    result = fetchTweetMetrics();
  } catch (e) {
    logEvent('metrics_error', String(e));
    notifySlack(':rotating_light: メトリクス取得に失敗: ' + e);
    return;
  }
  var rows = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.status) === STATUS.POSTED && r.metrics_at;
  });
  if (!rows.length) return;
  rows.sort(function (a, b) { return Number(b.impressions || 0) - Number(a.impressions || 0); });

  var totalImp = 0, totalLikes = 0;
  rows.forEach(function (r) {
    totalImp += Number(r.impressions || 0);
    totalLikes += Number(r.likes || 0);
  });

  var lines = [
    ':trophy: 投稿トラクション（累計 ' + rows.length + '件 / インプ ' + totalImp + ' / いいね ' + totalLikes + '）',
    '',
    'インプレッション Top3:',
  ];
  rows.slice(0, 3).forEach(function (r, i) {
    lines.push((i + 1) + '. 👁' + r.impressions + ' ❤️' + r.likes + ' 🔁' + r.retweets + ' 〔' + String(r.category) + '/' + r.score + '点〕');
    lines.push('　' + String(r.text).slice(0, 60) + (String(r.text).length > 60 ? '…' : ''));
  });
  notifySlack(lines.join('\n'));
}
