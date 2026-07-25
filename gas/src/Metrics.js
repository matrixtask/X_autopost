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
  // X APIは1リクエスト100件までだが、GASのURL長制限(約2KB)があるため
  // ID(約19桁+エンコード済みカンマ)を40件ずつに分割する
  for (var i = 0; i < ids.length; i += 40) {
    var chunk = ids.slice(i, i + 40);
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
 * 手動投稿の取り込み。
 * Xの自分のタイムラインから直近ポスト（最大100件、RT・リプライ除く）を取得し、
 * システム経由でない投稿を「手動投稿」としてStockに登録、メトリクスも記録する。
 * 以後は週次計測・時間帯分析の対象に含まれる。
 * 週次のメトリクス収集時に自動実行される（手動実行も可）。
 * 注意: X APIのFreeプランの読み取り枠を消費するため実行は週1目安。
 */
function importManualPosts() {
  ensureHeaders(SHEET.STOCK);
  // /users/me も読み取り枠を消費するため、ユーザーIDは初回取得後にキャッシュする
  var userId = getProp('X_USER_ID');
  if (!userId) {
    var me = xApiGet('/users/me', {});
    userId = String(me.data.id);
    PropertiesService.getScriptProperties().setProperty('X_USER_ID', userId);
  }
  var res = xApiGet('/users/' + userId + '/tweets', {
    max_results: '100',
    exclude: 'retweets,replies',
    'tweet.fields': 'created_at,public_metrics',
  });

  var known = {};
  readTable(SHEET.STOCK).forEach(function (r) {
    if (r.tweet_id) known[String(r.tweet_id)] = true;
  });

  var now = fmtDateTime(nowJst());
  var added = 0;
  (res.data || []).forEach(function (t) {
    if (known[String(t.id)]) return;
    var m = t.public_metrics || {};
    var postedAt = t.created_at ? fmtDateTime(new Date(t.created_at)) : '';
    appendRowObj(SHEET.STOCK, {
      id: newId('m'),
      created_at: postedAt,
      theme: '手動投稿',
      category: 'manual',
      session_id: '',
      text: String(t.text || ''),
      score: '',
      score_reason: '',
      status: STATUS.POSTED,
      scheduled_at: '',
      posted_at: postedAt,
      tweet_id: String(t.id),
      notion_page_id: '',
      impressions: m.impression_count || 0,
      likes: m.like_count || 0,
      retweets: m.retweet_count || 0,
      replies: m.reply_count || 0,
      metrics_at: now,
      refines: '',
    });
    added++;
  });
  logEvent('manual_import', added + '件の手動投稿を取り込み（取得' + ((res.data || []).length) + '件）');
  return added + '件の手動投稿を取り込みました';
}

/**
 * 自己採点の妥当性検証と、実測ベースの採点基準の学習。
 * - 採点スコアと実測インプレッションの相関を計算して報告
 * - インプレッション上位/下位の共通点から「追加採点基準」を生成し、
 *   スクリプトプロパティ QUALITY_RUBRIC_LEARNED に保存
 *   （以後の品質ゲートの採点プロンプトに自動で組み込まれる）
 * 手動実行可。週次メトリクス収集後にデータが8件以上あれば自動実行される。
 */
function evaluateScoring() {
  var rows = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.status) === STATUS.POSTED && r.metrics_at && r.score !== '';
  });
  if (rows.length < 8) {
    return 'データ不足（メトリクス付き投稿が' + rows.length + '件。8件以上で実行可能）';
  }

  var scores = rows.map(function (r) { return Number(r.score); });
  var imps = rows.map(function (r) { return Number(r.impressions || 0); });
  var corr = pearson(scores, imps);
  var corrText = corr === null ? '計算不能' : corr.toFixed(2);

  var sorted = rows.slice().sort(function (a, b) { return Number(b.impressions || 0) - Number(a.impressions || 0); });
  var list = sorted.map(function (r) {
    return '採点' + r.score + '点 / インプ' + r.impressions + ' / いいね' + r.likes + ' / ' + r.category + '\n' + r.text;
  }).join('\n\n----\n\n');

  var result = askClaudeJson(
    [
      'あなたはXアカウント運用のデータアナリストです。',
      'AIの自己採点（本人らしさ・具体性・引き・完成度の100点満点）と、実際のXでの反応を突き合わせて評価します。',
    ].join('\n'),
    [
      '投稿実績（インプレッション降順）:',
      '',
      list,
      '',
      '採点とインプレッションのピアソン相関: ' + corrText,
      '',
      'タスク:',
      '1. verdict: 自己採点はXの実際の反応を予測できているか。ズレている場合はどこがズレているかを150字以内で',
      '2. rubric: インプレッションが高いポストの共通点・低いポストの共通点から、採点プロンプトにそのまま追記できる「追加採点基準」を箇条書き3〜5行で。憶測ではなく上のデータに現れている事実だけから作る',
      '',
      'JSONで出力: {"verdict": "...", "rubric": "..."}',
    ].join('\n'),
    2000
  );

  if (result && result.rubric) {
    PropertiesService.getScriptProperties().setProperty('QUALITY_RUBRIC_LEARNED', String(result.rubric));
  }
  var report = [
    ':bar_chart: 採点妥当性チェック（' + rows.length + '件 / 相関 ' + corrText + '）',
    '判定: ' + (result && result.verdict ? result.verdict : '(取得失敗)'),
    '',
    '学習した追加採点基準（次回の品質ゲートから適用）:',
    result && result.rubric ? result.rubric : '(なし)',
  ].join('\n');
  logEvent('scoring_eval', '相関=' + corrText);
  notifySlack(report);
  return report;
}

/**
 * 週次トリガー: メトリクス取得 → ベスト3をSlack通知
 */
function weeklyMetricsReport() {
  // 手動投稿を先に取り込んでから全件のメトリクスを更新する
  try {
    importManualPosts();
  } catch (e) {
    logEvent('manual_import_error', String(e));
  }
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

  // データが溜まっていれば採点基準の妥当性検証と学習も回す
  try {
    if (rows.length >= 8) evaluateScoring();
  } catch (e) {
    logEvent('scoring_eval_error', String(e));
  }
}
