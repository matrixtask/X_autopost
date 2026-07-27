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
  // organic_metrics(広告分を除いた実測)とnon_public_metrics(プロフィールクリック等)は
  // ユーザー認証の自分のツイートで取得可能。いずれも直近30日程度が対象。
  // プランや期間の制約で拒否された場合はpublic_metricsのみにフォールバックする
  var withOrganic = true;
  // X APIは1リクエスト100件までだが、GASのURL長制限(約2KB)があるため
  // ID(約19桁+エンコード済みカンマ)を40件ずつに分割する
  for (var i = 0; i < ids.length; i += 40) {
    var chunk = ids.slice(i, i + 40);
    var res;
    try {
      res = xApiGet('/tweets', {
        ids: chunk.join(','),
        'tweet.fields': withOrganic ? 'public_metrics,organic_metrics,non_public_metrics' : 'public_metrics',
      });
    } catch (e) {
      if (withOrganic) {
        logEvent('metrics_organic_unavailable', String(e).slice(0, 200));
        withOrganic = false;
        res = xApiGet('/tweets', {
          ids: chunk.join(','),
          'tweet.fields': 'public_metrics',
        });
      } else {
        throw e;
      }
    }
    (res.data || []).forEach(function (t) {
      var row = byTweetId[String(t.id)];
      if (!row) return;
      var pub = t.public_metrics || {};
      var org = t.organic_metrics;
      var hasOrganic = org && typeof org.impression_count === 'number';
      // 分析に使うimpressions/likesはオーガニック値。広告分はpaid_impressionsに分離
      var imp = hasOrganic ? org.impression_count : (pub.impression_count || 0);
      var paid = hasOrganic ? Math.max(0, (pub.impression_count || 0) - org.impression_count) : '';
      var updates = {
        impressions: imp,
        likes: hasOrganic && typeof org.like_count === 'number' ? org.like_count : (pub.like_count || 0),
        retweets: pub.retweet_count || 0,
        replies: pub.reply_count || 0,
        metrics_at: now,
      };
      if (hasOrganic) {
        updates.paid_impressions = paid;
        if (paid > 0) updates.promoted = 'yes';
      }
      // プロフィールクリック = フォローの直前行動。フォロワー増の代理指標として使う
      var npm = t.non_public_metrics;
      if (npm) {
        if (typeof npm.user_profile_clicks === 'number') updates.profile_clicks = npm.user_profile_clicks;
        if (typeof npm.url_link_clicks === 'number') updates.link_clicks = npm.url_link_clicks;
      }
      // 手動で promoted=yes を付けた行は上書きで消さない（organic取得不可時の逃げ道）
      updateStockById(row.id, updates);
      updated++;
    });
  }
  logEvent('metrics', updated + '件のメトリクスを更新' + (withOrganic ? '（広告分を自動分離）' : '（organic取得不可: public値のみ）'));
  return updated + '件のメトリクスを更新しました';
}

/**
 * フォロワー数の日次スナップショット。
 * X APIは「このポストで何人増えたか」を返さないため、日次で現在値を記録して
 * 差分を取ることでフォロワー増を評価する。dailyFollowerSnapshot()から毎日実行。
 */
function snapshotFollowers(note) {
  var spreadsheet = ss();
  if (!spreadsheet.getSheetByName(SHEET.FOLLOWERS)) {
    var sheet = spreadsheet.insertSheet(SHEET.FOLLOWERS);
    var headers = SHEET_HEADERS.Followers;
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
  }

  var me = xApiGet('/users/me', { 'user.fields': 'public_metrics' });
  var followers = Number(((me.data || {}).public_metrics || {}).followers_count || 0);
  var today = fmtDate(nowJst());

  var rows = readTable(SHEET.FOLLOWERS);
  // シートが日付を日時に変換して返すことがある（2026-07-27 → "2026-07-27 00:00"）ため、
  // 先頭10文字（yyyy-MM-dd）で突き合わせる
  var todaysRows = rows.filter(function (r) { return dateKey(r.date) === today; });
  var prior = rows.filter(function (r) { return dateKey(r.date) !== today; });
  var last = prior.length ? prior[prior.length - 1] : null;
  var delta = last ? followers - Number(last.followers || 0) : '';

  // その日に投稿した本数（どの日の投稿がフォロワー増に効いたかを後で突き合わせる）
  var postsToday = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.status) === STATUS.POSTED && String(r.posted_at || '').indexOf(today) === 0;
  }).length;

  var headers = SHEET_HEADERS.Followers;
  var sheet2 = getSheet(SHEET.FOLLOWERS);
  var values = { date: today, followers: followers, delta: delta, posts_that_day: postsToday, note: note || '' };
  if (todaysRows.length) {
    // 同じ日の行は1本にまとめる（過去に重複して追記された分もここで掃除する）
    var keep = todaysRows[0];
    headers.forEach(function (col, i) {
      sheet2.getRange(keep._row, i + 1).setValue(values[col]);
    });
    todaysRows.slice(1).sort(function (a, b) { return b._row - a._row; }).forEach(function (dup) {
      sheet2.deleteRow(dup._row);
    });
    if (todaysRows.length > 1) logEvent('followers_dedup', today + ': 重複' + (todaysRows.length - 1) + '行を削除');
  } else {
    appendRowObj(SHEET.FOLLOWERS, values);
  }
  logEvent('followers', today + ': ' + followers + '人（前回比 ' + (delta === '' ? '初回' : (delta >= 0 ? '+' : '') + delta) + '）');
  return followers + '人（' + (delta === '' ? '初回記録' : (delta >= 0 ? '+' : '') + delta) + '）';
}

/** 毎日23時台のトリガー本体 */
function dailyFollowerSnapshot() {
  try {
    snapshotFollowers();
  } catch (e) {
    logEvent('followers_error', String(e));
  }
}

/** 直近days日のフォロワー増減サマリ */
function followerSummary(days) {
  var rows = readTable(SHEET.FOLLOWERS).filter(function (r) { return dateKey(r.date); });
  if (rows.length < 2) return null;
  var n = Math.min(days || 7, rows.length - 1);
  var latest = rows[rows.length - 1];
  var base = rows[rows.length - 1 - n];
  return {
    current: Number(latest.followers || 0),
    gained: Number(latest.followers || 0) - Number(base.followers || 0),
    days: n,
    from: dateKey(base.date),
    to: dateKey(latest.date),
  };
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
    if (String(r.status) !== STATUS.POSTED || !r.metrics_at || r.score === '') return false;
    // 広告インプを分離できていないプロモ投稿は学習を歪めるため除外
    if (String(r.promoted) === 'yes' && r.paid_impressions === '') return false;
    return true;
  });
  if (rows.length < 8) {
    return 'データ不足（メトリクス付き投稿が' + rows.length + '件。8件以上で実行可能）';
  }

  var scores = rows.map(function (r) { return Number(r.score); });
  var imps = rows.map(function (r) { return Number(r.impressions || 0); });
  var corr = pearson(scores, imps);
  var corrText = corr === null ? '計算不能' : corr.toFixed(2);

  // フォロワー増が目的なので、プロフィールクリック率を主目的変数として扱う
  var withClicks = rows.filter(function (r) {
    return r.profile_clicks !== '' && Number(r.impressions || 0) > 0;
  });
  var clickRate = function (r) { return Number(r.profile_clicks) / Number(r.impressions) * 100; };
  var corrClicks = withClicks.length >= 8
    ? pearson(withClicks.map(function (r) { return Number(r.score); }), withClicks.map(clickRate))
    : null;
  var useClicks = corrClicks !== null;

  var sorted = rows.slice().sort(function (a, b) {
    if (useClicks) {
      var ra = Number(a.profile_clicks || 0), rb = Number(b.profile_clicks || 0);
      if (rb !== ra) return rb - ra;
    }
    return Number(b.impressions || 0) - Number(a.impressions || 0);
  });
  var list = sorted.map(function (r) {
    return '採点' + r.score + '点 / インプ' + r.impressions + ' / いいね' + r.likes +
      (r.profile_clicks !== '' ? ' / プロフクリック' + r.profile_clicks + '(率' + clickRate(r).toFixed(2) + '%)' : '') +
      ' / ' + r.category + '\n' + r.text;
  }).join('\n\n----\n\n');

  var follow = followerSummary(30);

  var result = askClaudeJson(
    [
      'あなたはXアカウント運用のデータアナリストです。',
      'このアカウントの最終目的は「フォロワーを増やすこと」です。',
      'AIの自己採点（本人らしさ・具体性・引き・完成度の100点満点）と、実際のXでの反応を突き合わせて評価します。',
      useClicks
        ? '評価の主軸はプロフィールクリック率（そのポストを見た人がプロフィールを見に行った割合）です。フォローの直前行動なので、インプレッションよりフォロワー増に近い指標です。'
        : 'プロフィールクリックのデータがまだ足りないため、今回はインプレッションといいねを主軸にします。',
    ].join('\n'),
    [
      '投稿実績（' + (useClicks ? 'プロフィールクリック降順' : 'インプレッション降順') + '）:',
      '',
      list,
      '',
      '採点とインプレッションの相関: ' + corrText,
      useClicks ? '採点とプロフィールクリック率の相関: ' + corrClicks.toFixed(2) : '',
      follow ? 'アカウント全体: 現在' + follow.current + 'フォロワー / 直近' + follow.days + '日で' + (follow.gained >= 0 ? '+' : '') + follow.gained + '人' : '',
      '',
      'タスク:',
      '1. verdict: 自己採点は「フォロワーが増えるポスト」を予測できているか。ズレている場合はどこがズレているかを150字以内で',
      '2. rubric: ' + (useClicks ? 'プロフィールクリック率が高いポスト' : '反応が良いポスト') + 'の共通点・低いポストの共通点から、採点プロンプトにそのまま追記できる「追加採点基準」を箇条書き3〜5行で。憶測ではなく上のデータに現れている事実だけから作る。「読んだ人がこの人を知りたくなるか」という観点を必ず含める',
      '',
      'JSONで出力: {"verdict": "...", "rubric": "..."}',
    ].join('\n'),
    2000
  );

  if (result && result.rubric) {
    PropertiesService.getScriptProperties().setProperty('QUALITY_RUBRIC_LEARNED', String(result.rubric));
  }
  var report = [
    ':bar_chart: 採点妥当性チェック（' + rows.length + '件 / 対インプ相関 ' + corrText +
      (useClicks ? ' / 対プロフクリック率相関 ' + corrClicks.toFixed(2) : '') + '）',
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
  // フォロワー数と手動投稿を先に取り込んでから全件のメトリクスを更新する
  try {
    snapshotFollowers('週次');
  } catch (e) {
    logEvent('followers_error', String(e));
  }
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
  var all = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.status) === STATUS.POSTED && r.metrics_at;
  });
  if (!all.length) return;
  // 広告インプを分離できていないプロモ投稿(手動フラグのみ)はランキングから外す
  var rows = all.filter(function (r) {
    return !(String(r.promoted) === 'yes' && r.paid_impressions === '');
  });
  var excluded = all.length - rows.length;
  rows.sort(function (a, b) { return Number(b.impressions || 0) - Number(a.impressions || 0); });

  var totalImp = 0, totalLikes = 0;
  rows.forEach(function (r) {
    totalImp += Number(r.impressions || 0);
    totalLikes += Number(r.likes || 0);
  });

  // フォロワー増を先頭に置く（このアカウントの最終目的）
  var week = followerSummary(7);
  var lines = [];
  if (week) {
    lines.push(':chart_with_upwards_trend: *フォロワー ' + week.current + '人（直近' + week.days + '日で ' +
      (week.gained >= 0 ? '+' : '') + week.gained + '人）*');
    lines.push('');
  } else {
    lines.push(':chart_with_upwards_trend: フォロワー記録を開始しました（増減は明日以降から出ます）');
    lines.push('');
  }
  lines.push(':trophy: 投稿トラクション（累計 ' + rows.length + '件 / オーガニックインプ ' + totalImp + ' / いいね ' + totalLikes + '）');
  lines.push('');
  // プロフィールクリック（フォローの直前行動）が取れていればそれ基準で並べる
  var hasClicks = rows.some(function (r) { return r.profile_clicks !== ''; });
  if (hasClicks) {
    rows.sort(function (a, b) { return Number(b.profile_clicks || 0) - Number(a.profile_clicks || 0); });
  }
  lines.push(hasClicks ? 'プロフィールクリック Top10（フォローに一番近い指標）:' : 'オーガニックインプレッション Top10:');
  rows.slice(0, 10).forEach(function (r, i) {
    var promoTag = String(r.promoted) === 'yes' ? ' 💰広告分' + r.paid_impressions + 'は除外済み' : '';
    var clickTag = r.profile_clicks !== ''
      ? ' 👤' + r.profile_clicks + (Number(r.impressions) > 0 ? '(' + (Number(r.profile_clicks) / Number(r.impressions) * 100).toFixed(1) + '%)' : '')
      : '';
    lines.push((i + 1) + '.' + clickTag + ' 👁' + r.impressions + ' ❤️' + r.likes + ' 🔁' + r.retweets + ' 〔' + String(r.category) + '/' + (r.score === '' ? '手動' : r.score + '点') + '〕' + promoTag);
    lines.push('　' + String(r.text).slice(0, 60) + (String(r.text).length > 60 ? '…' : ''));
  });
  if (excluded > 0) {
    lines.push('');
    lines.push('※広告インプを分離できない' + excluded + '件(promoted=yes・分離データなし)は集計から除外');
  }
  notifySlack(lines.join('\n'));

  // データが溜まっていれば採点基準の妥当性検証と学習も回す
  try {
    if (rows.length >= 8) evaluateScoring();
  } catch (e) {
    logEvent('scoring_eval_error', String(e));
  }
}
