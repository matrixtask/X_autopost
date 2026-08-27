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
 * 手動投稿の取り込み（ページネーション対応）。
 *
 * Xのタイムラインは1リクエスト100件が上限だが、pagination_tokenで辿れば
 * 直近3,200件程度まで遡れる。週次の自動実行では直近100件だけを見て、
 * 過去分をまとめて取り込みたいときは backfillManualPosts() を使う。
 *
 * 注意: 遡って取れるのは本文と公開メトリクスまで。オーガニックインプと
 * プロフィールクリックはX側の仕様で直近30日分しか存在しない。
 *
 * @param {number} maxPosts 取得上限（既定100 = 1ページ）
 */
function importManualPosts(maxPosts) {
  ensureHeaders(SHEET.STOCK);
  var limit = Number(maxPosts || 100);
  // /users/me も読み取り枠を消費するため、ユーザーIDは初回取得後にキャッシュする
  var userId = getProp('X_USER_ID');
  if (!userId) {
    var me = xApiGet('/users/me', {});
    userId = String(me.data.id);
    PropertiesService.getScriptProperties().setProperty('X_USER_ID', userId);
  }

  var known = {};
  readTable(SHEET.STOCK).forEach(function (r) {
    if (r.tweet_id) known[String(r.tweet_id)] = true;
  });

  var now = fmtDateTime(nowJst());
  var pending = [];
  var fetched = 0;
  var pages = 0;
  var token = null;
  do {
    var params = {
      max_results: '100',
      exclude: 'retweets,replies',
      'tweet.fields': 'created_at,public_metrics',
    };
    if (token) params.pagination_token = token;
    var res;
    try {
      res = xApiGet('/users/' + userId + '/tweets', params);
    } catch (e) {
      // レート制限などで途中で落ちても、ここまでの分は保存して次回に続きから取る
      logEvent('manual_import_error', 'page ' + (pages + 1) + ': ' + String(e).slice(0, 200));
      break;
    }
    var batch = res.data || [];
    fetched += batch.length;
    pages++;

    batch.forEach(function (t) {
      if (known[String(t.id)]) return;
      known[String(t.id)] = true;
      var m = t.public_metrics || {};
      var postedAt = t.created_at ? fmtDateTime(new Date(t.created_at)) : '';
      pending.push({
        id: newId('m') + '_' + pending.length,
        created_at: postedAt,
        theme: '手動投稿',
        category: 'manual',
        session_id: '',
        text: String(t.text || ''),
        score: '', score_reason: '',
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
        refines: '', promoted: '', paid_impressions: '',
        profile_clicks: '', link_clicks: '', axes: '',
      });
    });
    token = (res.meta && res.meta.next_token) || null;
  } while (token && fetched < limit);

  // 1行ずつappendすると数百行で実行時間上限に当たるため一括で書き込む
  appendRowsObj(SHEET.STOCK, pending);
  logEvent('manual_import', pending.length + '件を取り込み（取得' + fetched + '件 / ' + pages + 'ページ）');
  return pending.length + '件の手動投稿を取り込みました（' + fetched + '件走査 / ' + pages + 'ページ）';
}

/**
 * 過去投稿の大量遡及取り込み。相関分析の標本を一気に増やすために使う。
 * 既定1000件。X APIの読み取り枠を消費するので、様子を見ながら増やすこと。
 */
function backfillManualPosts(maxPosts) {
  var n = Number(maxPosts || getProp('BACKFILL_MAX_POSTS', '1000'));
  var result = importManualPosts(n);
  notifySlack(':inbox_tray: 過去投稿の遡及取り込み: ' + result +
    '\n次は backfillAxisScores を実行すると、これらに軸スコアが付いて相関分析の標本になります。');
  return result;
}

/**
 * 軸別の相関分析と重み学習。
 *
 * 各採点軸(0-100)と成果指標の相関を取り、「どの軸が実際に効いているか」を
 * 推定する。相関が強い軸ほど重みを上げ、次回以降の合成スコアに反映する。
 *
 * n が小さいうちは相関が不安定なので、以下のガードを入れている:
 *  - 最低 MIN_AXIS_SAMPLES 件（既定15）を満たすまで重みは更新しない
 *  - 学習値と現行値を混ぜる（急激に振れないようにする）
 *  - 1軸あたり 3%〜35% にクランプしてから正規化する
 * 軸同士は相関が高い（良い投稿は全軸で高い）ため重回帰は過学習する。
 * この規模では単相関＋平滑化の方が素直で壊れにくい。
 */
/**
 * 各軸と成果指標の相関。標本5件未満の軸は corr=null。
 *
 * 生の相関(corr)と、ハローを除いた相関(corrCentered)の両方を出す。
 *
 * 生の軸スコアはどれも「そのポストの出来の良さ」を含んでいる（良いポストは
 * 全軸が高い）ので、そのまま相関を取ると全軸が同じ成分を拾ってしまい、
 * 軸ごとの効き方の違いが見えない。ポスト内の平均を引くと「そのポストの中で
 * 相対的に何が強かったか」だけが残る。重みの学習にはこちらを使う。
 */
function axisCorrelationsFor(target, outcomes) {
  var keys = AXES.map(function (a) { return a.key; });
  var centered = target.map(function (r) {
    var ax = parseAxes(r.axes);
    return ax ? centerAxisScores(ax, keys) : {};
  });
  return AXES.map(function (a) {
    var xs = [], ys = [], cs = [], cys = [];
    target.forEach(function (r, i) {
      var ax = parseAxes(r.axes);
      if (ax && isFinite(Number(ax[a.key]))) { xs.push(Number(ax[a.key])); ys.push(outcomes[i]); }
      if (isFinite(Number(centered[i][a.key]))) { cs.push(Number(centered[i][a.key])); cys.push(outcomes[i]); }
    });
    return {
      key: a.key, label: a.label, n: xs.length,
      corr: xs.length >= 5 ? pearson(xs, ys) : null,
      corrCentered: cs.length >= 5 ? pearson(cs, cys) : null,
    };
  });
}

/** 分析対象になる投稿済み行（軸スコア付き・広告インプを分離できているもの） */
function analyzableRows() {
  return readTable(SHEET.STOCK).filter(function (r) {
    if (String(r.status) !== STATUS.POSTED || !r.metrics_at) return false;
    if (String(r.promoted) === 'yes' && r.paid_impressions === '') return false;
    return parseAxes(r.axes) !== null;
  });
}

/** 投稿時刻を数値に。読めなければ null */
function postedAtMs(r) {
  var t = new Date(String(r.posted_at).replace(' ', 'T') + ':00+09:00').getTime();
  return isFinite(t) ? t : null;
}

/**
 * 窓内インプレッション順位。フォロワー数もアルゴリズムも時期で変わるので、
 * 生のインプではなく前後30日の投稿内での相対順位に直して比較可能にする。
 */
function reachOutcomes(rows) {
  return percentileWithinWindow(rows.map(function (r) {
    return { t: postedAtMs(r), v: Number(r.impressions) };
  }), 30);
}

/**
 * 実測から重みベクトルを推定する。クロスバリデーションでも同じ関数を使うので、
 * 「学習に使っていない投稿でどれだけ当たるか」を正しく測れる。
 *
 * Config.js の axisWeightBreakdown() と同じ考え方（有意な分だけ残す →
 * 塊で分け合う → 事前分布と混ぜる）を、その場のデータに対して行う。
 */
function learnAxisWeights(rows, outcomes) {
  var z = axisSignificanceZ();
  var results = axisCorrelationsFor(rows, outcomes);
  var learned = {};
  var significant = [];
  results.forEach(function (x) {
    var c = x.corrCentered === null ? x.corr : x.corrCentered;
    var v = c === null ? 0 : shrinkCorrelation(c, x.n, z);
    learned[x.key] = v;
    if (v !== 0) significant.push(x.key);
  });

  var clusters = axisClusters();
  if (String(getProp('CLUSTER_SPLIT', 'learned')) !== 'off') {
    clusters.forEach(function (g) {
      var members = g.filter(function (k) { return learned[k] !== undefined; });
      if (members.length < 2) return;
      members.forEach(function (k) { learned[k] = learned[k] / members.length; });
    });
  }

  var learnedNorm = normalizeWeights(learned);
  var priorNorm = normalizeWeights(DEFAULT_AXIS_WEIGHTS) || DEFAULT_AXIS_WEIGHTS;
  var blend = learnedNorm ? Math.min(1, significant.length / Math.max(1, axisLearnedFullAt())) : 0;
  var w = {};
  AXES.forEach(function (a) {
    var pr = Number(priorNorm[a.key]) || 0;
    var le = learnedNorm ? (Number(learnedNorm[a.key]) || 0) : 0;
    w[a.key] = pr * (1 - blend) + le * blend;
  });
  return { weights: w, results: results, significant: significant, blend: blend };
}

/** 重みベクトルで1件を採点する（compositeScoreFromAxes と同じ正規化） */
function scoreWithWeights(axes, w) {
  var raw = 0, pos = 0, neg = 0;
  AXES.forEach(function (a) {
    var wt = Number(w[a.key]) || 0;
    var v = Number(axes[a.key]);
    raw += (isFinite(v) ? v : 50) * wt;
    if (wt > 0) pos += wt; else neg += wt;
  });
  var min = 100 * neg, max = 100 * pos;
  if (max - min <= 0) return 50;
  return Math.max(0, Math.min(100, 100 * (raw - min) / (max - min)));
}

/**
 * 軸別の相関分析と重み学習。
 *
 * 各採点軸(0-100)と成果指標の相関を取り、「どの軸が実際に効いているか」を
 * 推定する。相関はそのまま保存し、重みへの変換（有意性による割り引き・
 * 塊の分割・事前分布との混合）は読み出し側の axisWeightBreakdown() が行う。
 *
 * 軸同士は相関が高い（良い投稿は全軸で高い）ため重回帰は過学習する。
 * 単相関＋ハロー除去＋有意性の足切り、の方がこの規模では素直で壊れにくい。
 */
function analyzeAxes(mode) {
  var rows = analyzableRows();

  // 2つのモデルを使い分ける:
  //  follow: プロフィールクリック率。KGI(フォロワー増)に近いが直近30日分しか無い
  //  reach : 窓内インプ・パーセンタイル。標本は多いがフォローとは別物
  var withClicks = rows.filter(function (r) {
    return r.profile_clicks !== '' && Number(r.impressions || 0) > 0;
  });
  var wantFollow = mode !== 'reach' && withClicks.length >= 10;
  var target, outcomeName, outcomes;

  if (wantFollow) {
    target = withClicks;
    outcomeName = 'プロフィールクリック率';
    outcomes = target.map(function (r) { return Number(r.profile_clicks) / Number(r.impressions) * 100; });
  } else {
    target = rows.filter(function (r) { return Number(r.impressions || 0) > 0 && postedAtMs(r) !== null; });
    outcomeName = 'インプレッション窓内順位';
    outcomes = reachOutcomes(target);
  }

  var results = axisCorrelationsFor(target, outcomes);

  // 軸同士の塊を実測から求めて保存する。内積で同じ成分が何度も数えられるのを防ぐ
  if (target.length >= 15) {
    var columns = {};
    AXES.forEach(function (a) {
      columns[a.key] = target.map(function (r) {
        var ax = parseAxes(r.axes);
        return ax && isFinite(Number(ax[a.key])) ? Number(ax[a.key]) : 50;
      });
    });
    var groups = correlationClusters(columns, AXES.map(function (a) { return a.key; }),
      Number(getProp('CLUSTER_THRESHOLD', '0.7'))).filter(function (g) { return g.length > 1; });
    PropertiesService.getScriptProperties().setProperty('AXIS_CLUSTERS', JSON.stringify(groups));
    if (groups.length) logEvent('axis_clusters', JSON.stringify(groups));
  }

  // 相関ベクトルをそのまま保存する（重みへの変換は読み出し側で行う）。
  // 学習に使うのはハロー除去後の相関。標本数も一緒に残す
  var minSamples = Number(getProp('MIN_AXIS_SAMPLES', '10'));
  var usable = results.filter(function (x) { return x.corr !== null && x.n >= minSamples; });
  var updated = false;
  var storeKey = wantFollow ? 'AXIS_CORRELATIONS' : 'AXIS_CORRELATIONS_REACH';

  if (usable.length >= 3) {
    var store = {};
    results.forEach(function (x) {
      if (x.corr === null || x.n < minSamples) return;
      var c = x.corrCentered === null ? x.corr : x.corrCentered;
      store[x.key] = { c: Math.round(c * 1000) / 1000, n: x.n, raw: Math.round(x.corr * 1000) / 1000 };
    });
    PropertiesService.getScriptProperties().setProperty(storeKey, JSON.stringify(store));
    updated = true;
    logEvent('axis_correlations', storeKey + ' ' + JSON.stringify(store));
  }

  // 実際にスコア計算で使われている重みと、その寄与率
  var breakdown = axisWeightBreakdown();
  var effective = breakdown.weights;
  var absSum = 0;
  AXES.forEach(function (a) { absSum += Math.abs(Number(effective[a.key]) || 0); });

  var floors = axisFloors();
  var threshold = minDetectableCorrelation(target.length, axisSignificanceZ());
  var ranked = results.slice().sort(function (a, b) {
    return (b.corr === null ? -2 : b.corr) - (a.corr === null ? -2 : a.corr);
  }).map(function (x) {
    var eff = Number(effective[x.key]) || 0;
    var c = x.corrCentered === null ? x.corr : x.corrCentered;
    return {
      key: x.key, label: x.label, n: x.n, corr: x.corr, corrCentered: x.corrCentered,
      effective: Math.round(eff * 1000) / 1000,
      share: absSum > 0 ? Math.round(Math.abs(eff) / absSum * 1000) / 10 : 0,
      // 誤差の範囲を超えているか（超えていないなら重みには入っていない）
      significant: c !== null && shrinkCorrelation(c, x.n, axisSignificanceZ()) !== 0,
      floored: floors[x.key] !== undefined && eff <= Number(floors[x.key]) + 1e-9,
    };
  });
  return {
    outcomeName: outcomeName, sampleSize: target.length, minSamples: minSamples,
    ranked: ranked, updated: updated, breakdown: breakdown,
    detectable: threshold,
  };
}

/**
 * 採点の正しさを、学習に使っていない投稿で測る。
 *
 * これがこの仕組みの一次指標。手元のデータに当てはめた相関はいくらでも
 * 高く出せる（実測では 同一標本 +0.32 に対し、学習に使っていない投稿では
 * +0.04 だった）ので、必ず分割して測る。
 *
 * 5分割し、4/5で重みを学習して残り1/5を採点する、を5回。順番はidで固定する
 * （実行のたびに数字が動くと、良くなったのか偶然なのか分からなくなるため）。
 *
 * GASエディタでは Metrics.gs を開いて実行する。
 */
function evaluateScoringAccuracy(mode) {
  // 成果指標を選ぶ。プロフィールクリック率を優先する。
  //
  // インプレッションは「内容で動いていない」ことが実測で分かっている
  // （どの軸も、文字数も投稿時刻も、有意な相関を持たない）。ノイズを
  // 相手に予測力を測ると、採点がどれだけ良くなっても数字は0のままで、
  // 改善したかどうかが判定できない。
  // プロフィールクリック率はフォローの直前行動で、実測でも軸との相関が出る。
  var all = analyzableRows();
  var withClicks = all.filter(function (r) {
    return r.profile_clicks !== '' && Number(r.impressions || 0) > 0;
  });
  var useClicks = mode !== 'reach' && withClicks.length >= 25;
  var rows, outcomes, outcomeName;
  if (useClicks) {
    rows = withClicks.slice();
    outcomeName = 'プロフィールクリック率';
  } else {
    rows = all.filter(function (r) { return Number(r.impressions || 0) > 0 && postedAtMs(r) !== null; });
    outcomeName = 'インプレッション窓内順位';
  }

  var K = 5;
  if (rows.length < 25) {
    var short = ':straight_ruler: 採点の予測力: 標本不足（軸スコアと実測が揃った投稿が' +
      rows.length + '件。25件以上必要です）';
    notifySlack(short);
    return short;
  }
  rows.sort(function (a, b) { return String(a.id) < String(b.id) ? -1 : 1; });
  outcomes = useClicks
    ? rows.map(function (r) { return Number(r.profile_clicks) / Number(r.impressions) * 100; })
    : reachOutcomes(rows);

  var predicted = [], actual = [], priorPred = [];
  for (var f = 0; f < K; f++) {
    var train = [], trainOut = [], test = [];
    rows.forEach(function (r, i) {
      if (i % K === f) test.push({ row: r, out: outcomes[i] });
      else { train.push(r); trainOut.push(outcomes[i]); }
    });
    if (train.length < 10 || !test.length) continue;
    var w = learnAxisWeights(train, trainOut).weights;
    test.forEach(function (t) {
      var ax = parseAxes(t.row.axes);
      if (!ax) return;
      predicted.push(scoreWithWeights(ax, w));
      priorPred.push(scoreWithWeights(ax, DEFAULT_AXIS_WEIGHTS));
      actual.push(t.out);
    });
  }
  if (predicted.length < 10) {
    var few = ':straight_ruler: 採点の予測力: 検証できた件数が' + predicted.length + '件しかありません';
    notifySlack(few);
    return few;
  }

  var rho = spearman(predicted, actual);
  var rhoPrior = spearman(priorPred, actual);
  // 順位相関だけだと実感が湧かないので、上位半分と下位半分の実測差も出す
  var idx = predicted.map(function (_, i) { return i; })
    .sort(function (a, b) { return predicted[b] - predicted[a]; });
  var half = Math.floor(idx.length / 2);
  function med(list) {
    var v = list.slice().sort(function (a, b) { return a - b; });
    if (!v.length) return 0;
    return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  }
  var topHalf = med(idx.slice(0, half).map(function (i) { return actual[i]; }));
  var lowHalf = med(idx.slice(half).map(function (i) { return actual[i]; }));
  var unit = useClicks ? '%' : 'パーセンタイル';

  // n件での「偶然でも出てしまう順位相関」の目安
  var noise = minDetectableCorrelation(predicted.length, 2.0);
  var verdict = rho === null ? '計算不能'
    : Math.abs(rho) < noise ? '実質ゼロ（偶然の範囲）'
    : rho > 0 ? '予測できている' : '逆に効いている（重みの符号が疑わしい）';

  var lines = [
    ':straight_ruler: *採点の予測力*（' + K + '分割クロスバリデーション / 検証' + predicted.length + '件）',
    '成果指標: ' + outcomeName,
    '学習に使っていない投稿を採点して、実測をどれだけ当てられたかです。',
    '手元のデータへの当てはまりは重みをいじれば上がりますが、この数字は上がりません。',
    '',
    '学習した重み: 順位相関 ' + (rho === null ? '—' : (rho >= 0 ? '+' : '') + rho.toFixed(2)) + '  → ' + verdict,
    '事前分布のみ: 順位相関 ' + (rhoPrior === null ? '—' : (rhoPrior >= 0 ? '+' : '') + rhoPrior.toFixed(2)),
    '偶然でも出る大きさ: ±' + noise.toFixed(2) + '（これを超えて初めて意味があります）',
    '',
    'スコア上位半分の実測 中央値 ' + topHalf.toFixed(2) + unit,
    'スコア下位半分の実測 中央値 ' + lowHalf.toFixed(2) + unit,
    '差 ' + (topHalf - lowHalf).toFixed(2) + unit + '（0なら採点は当たっていません）',
  ];
  if (rho !== null && Math.abs(rho) < noise) {
    lines.push('');
    lines.push('※ いまの標本数では、どんな重みでもこの水準を超えられません。' +
      '重みをいじるより、まず measureScoringReliability（Quality.gs）で' +
      '採点自体が再現するかを確かめてください。');
  }
  if (!useClicks) {
    lines.push('');
    lines.push('※ 成果指標がインプレッションのときは、そもそも実測が内容で' +
      'ほとんど動きません（文字数も投稿時刻も有意な相関を持たない）。' +
      'プロフィールクリック付きの投稿が25件たまると、そちらで測るようになります' +
      '（現在' + withClicks.length + '件）。');
  }
  logEvent('scoring_accuracy', outcomeName + ' n=' + predicted.length +
    ' rho=' + (rho === null ? 'null' : rho.toFixed(3)) +
    ' prior=' + (rhoPrior === null ? 'null' : rhoPrior.toFixed(3)) +
    ' gap=' + (topHalf - lowHalf).toFixed(2));
  notifySlack(lines.join('\n'));
  return lines.join('\n');
}

/**
 * 軸別分析をSlackに投げる（週次から呼ばれる。手動実行も可）。
 * リーチモデルとフォローモデルの両方を回して、それぞれの効き方を並べて出す。
 *
 * **有意でない相関は「効いている」と書かない。** 以前はどんなに小さい相関でも
 * 棒グラフを立てて並べていたので、誤差の範囲の数字が根拠のように見えていた。
 *
 * 重みの状態は最後に1回だけ出す。モデルごとに出すと、1本目を回した時点と
 * 2本目を回した時点で保存済みの相関が変わっており、同じレポートの中に
 * 違う状態が2つ並んでしまう。
 */
function reportAxisAnalysis() {
  var models = [analyzeAxes('reach')];
  var follow = analyzeAxes(); // 30日以内のクリック実測が10件以上あればフォローモデルになる
  if (follow.outcomeName !== models[0].outcomeName) models.push(follow);

  var hasAny = models.some(function (m) {
    return m.ranked.some(function (x) { return x.corr !== null; });
  });
  if (!hasAny) {
    var msg = ':microscope: 軸別分析: データ不足（軸スコア付きの計測済み投稿が' + models[0].sampleSize + '件）。' +
      'backfillManualPosts → backfillAxisScores を実行すると過去投稿が一気に標本になります。';
    notifySlack(msg);
    return msg;
  }

  var lines = [':microscope: *軸別の効き方分析*'];
  models.forEach(function (a) {
    lines.push('');
    lines.push('*' + a.outcomeName + '*（n=' + a.sampleSize + '）');
    lines.push('この標本数だと、|相関|が ' + a.detectable.toFixed(2) +
      ' を超えて初めて「偶然ではない」と言えます。');
    var sig = a.ranked.filter(function (x) { return x.significant; });
    var shown = 0;
    a.ranked.forEach(function (x) {
      if (x.corr === null) return;
      shown++;
      // 学習に使うのはハロー除去後の相関。生の相関も併記する
      var c = x.corrCentered === null ? x.corr : x.corrCentered;
      var bar = x.significant ? ' ' + '█'.repeat(Math.max(1, Math.round(Math.abs(c) * 12))) : '';
      lines.push((x.significant ? '' : ':grey_question: ') +
        (c >= 0 ? '+' : '−') + Math.abs(c).toFixed(2) + bar +
        ' ' + x.label + '（n=' + x.n + ' / 生の相関' + (x.corr >= 0 ? '+' : '−') + Math.abs(x.corr).toFixed(2) +
        (x.floored ? ' / 下限で固定' : '') + '）');
    });
    if (!shown) lines.push('（このモデルはまだデータ不足）');
    lines.push(sig.length
      ? ':white_check_mark: 偶然とは言えない軸: ' + sig.map(function (x) { return x.label; }).join('、') +
        '（' + sig.length + '/' + a.ranked.length + '軸）'
      : ':grey_question: がついた軸は、数字は出ていますが誤差の範囲です。**どれも重みには入れていません。**');
    lines.push(a.updated
      ? '相関を保存しました。' : '相関は未保存（各軸' + a.minSamples + '件以上たまると保存します）。');
  });

  // 2モデルぶんを保存し終えた状態で、いまの重みを1回だけ出す
  var b = axisWeightBreakdown();
  lines.push('');
  lines.push('*いまの重み*');
  lines.push('事前分布 ' + Math.round((1 - b.blend) * 100) + '% / 実測 ' + Math.round(b.blend * 100) + '%' +
    (b.significant.length ? '（実測が効いている軸: ' + b.significant.join('、') + '）' : '（実測で言い切れる軸がまだ無いため、全部が事前の想定です）'));
  if (b.dropped.length) lines.push('再現しないため使っていない軸: ' + b.dropped.join('、'));

  var groups = axisClusters();
  if (groups.length) {
    var mass = 0;
    AXES.forEach(function (ax) { mass += Math.abs(Number(b.weights[ax.key]) || 0); });
    lines.push('');
    lines.push('*ほぼ同じものを測っている軸の塊*（内積で同じ成分が何度も数えられます）:');
    groups.forEach(function (g) {
      var share = 0;
      g.forEach(function (k) { share += Math.abs(Number(b.weights[k]) || 0); });
      var labels = g.map(function (k) {
        var found = k;
        AXES.forEach(function (ax) { if (ax.key === k) found = ax.label; });
        return found;
      });
      lines.push('　・' + labels.join('＋') + ' → 合計で重みの' +
        (mass > 0 ? Math.round(share / mass * 1000) / 10 : 0) + '%');
    });
    lines.push('　別々の軸に見えて、実測では中身が1つです。塊が重みの多くを占めていると、' +
      'スコアは実質その1成分だけで決まります。');
    lines.push('　塊の中で重みを分け合わせたい場合は、スクリプトプロパティ ' +
      'CLUSTER_SPLIT を all にしてください（既定 learned = 学習した分だけ分割）。');
  }

  if (models.length < 2) {
    lines.push('');
    lines.push('フォローモデル（プロフィールクリック率）はまだ標本不足です。' +
      'クリック数はXの仕様で直近30日分しか取れないため、投稿を重ねながらたまるのを待ちます。');
  }
  lines.push('');
  lines.push('※ ここに出る相関は「手元のデータへの当てはまり」です。' +
    '採点が実際に当たるかは evaluateScoringAccuracy（Metrics.gs）で測ってください。');
  notifySlack(lines.join('\n'));
  return lines.join('\n');
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

  // 相関が誤差の範囲のときに「上位と下位の共通点」を学習させると、
  // ただの偶然を採点基準として固定してしまう。しかもその基準は次の採点に
  // 効いてくるので、ノイズが自分自身を強化する。有意なときだけ更新する。
  var mainCorr = useClicks ? corrClicks : corr;
  var noise = minDetectableCorrelation(useClicks ? withClicks.length : rows.length, 2.0);
  var trustworthy = mainCorr !== null && Math.abs(mainCorr) >= noise;
  if (result && result.rubric && trustworthy) {
    PropertiesService.getScriptProperties().setProperty('QUALITY_RUBRIC_LEARNED', String(result.rubric));
  }
  var report = [
    ':bar_chart: 採点妥当性チェック（' + rows.length + '件 / 対インプ相関 ' + corrText +
      (useClicks ? ' / 対プロフクリック率相関 ' + corrClicks.toFixed(2) : '') + '）',
    '判定: ' + (result && result.verdict ? result.verdict : '(取得失敗)'),
    '',
    trustworthy
      ? '学習した追加採点基準（次回の品質ゲートから適用）:'
      : '※ 採点と実測の相関が誤差の範囲（|' + (mainCorr === null ? '—' : Math.abs(mainCorr).toFixed(2)) +
        '| < ' + noise.toFixed(2) + '）のため、採点基準は**更新していません**。' +
        'ここで見えている共通点は偶然の可能性が高く、基準にすると次の採点を歪めます。\n' +
        '参考（採用していません）:',
    result && result.rubric ? result.rubric : '(なし)',
  ].join('\n');
  logEvent('scoring_eval', '相関=' + corrText);
  notifySlack(report);
  return report;
}

/**
 * 採点の健康診断。「採点は当てになるのか」に一度で答えるための入口。
 *
 * 見るのは3つだけ:
 *   1. 採点は再現するか（同じポストを2回採点して一致するか）
 *   2. 採点は当たるか（学習に使っていない投稿で実測を予測できるか）
 *   3. 重みは実測に基づいているのか、それとも事前分布のままか
 *
 * 2が悪いとき、原因は「採点がブレている」か「実測が内容で動いていない」の
 * どちらか。1を先に見ないと切り分けられないので、この順に出す。
 *
 * GASエディタでは Metrics.gs を開いて実行する。
 * Claude APIを2回ぶん多く使う（再現性の測定で同じ標本を2度採点するため）。
 *
 * @param {boolean} skipReliability 再現性の測定を飛ばす（APIを節約したいとき）
 */
function diagnoseScoring(skipReliability) {
  var out = [':stethoscope: *採点の健康診断*', ''];

  var rows = analyzableRows().filter(function (r) {
    return Number(r.impressions || 0) > 0 && postedAtMs(r) !== null;
  });
  out.push('軸スコアと実測が揃った投稿: ' + rows.length + '件');
  out.push('この標本数で「偶然ではない」と言える相関の大きさ: ±' +
    minDetectableCorrelation(rows.length, axisSignificanceZ()).toFixed(2));
  out.push('');

  if (!skipReliability) {
    try {
      out.push('── 1. 採点は再現するか ──');
      out.push(String(measureScoringReliability()).replace(/^:repeat: \*[^*]*\*[^\n]*\n/, ''));
    } catch (e) {
      out.push('（再現性の測定に失敗: ' + String(e).slice(0, 150) + '）');
    }
    out.push('');
  }

  try {
    out.push('── 2. 採点は当たるか ──');
    out.push(String(evaluateScoringAccuracy()).replace(/^:straight_ruler: \*[^*]*\*[^\n]*\n/, ''));
  } catch (e) {
    out.push('（予測力の測定に失敗: ' + String(e).slice(0, 150) + '）');
  }
  out.push('');

  try {
    out.push('── 3. いまの重みの出どころ ──');
    var b = axisWeightBreakdown();
    out.push('事前分布 ' + Math.round((1 - b.blend) * 100) + '% / 実測 ' + Math.round(b.blend * 100) + '%');
    out.push(b.significant.length
      ? '実測で効いていると言える軸: ' + b.significant.join('、')
      : '実測で効いていると言える軸は**まだ1つもありません**。いまの重みは全部が事前の想定です。');
    if (b.dropped.length) out.push('再現しないため使っていない軸: ' + b.dropped.join('、'));
    var groups = axisClusters();
    if (groups.length) {
      out.push('中身が同じ軸の塊: ' + groups.map(function (g) { return g.join('＋'); }).join(' , '));
    }
  } catch (e) {
    out.push('（重みの取得に失敗: ' + String(e).slice(0, 150) + '）');
  }

  var report = out.join('\n');
  logEvent('scoring_diagnosis', report.slice(0, 500));
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
  // 軸別の効き方分析と重み更新
  try {
    reportAxisAnalysis();
  } catch (e) {
    logEvent('axis_analysis_error', String(e));
  }
  // 採点が実際に当たっているかを、学習に使っていない投稿で測る。
  // 手元への当てはまりは重みをいじれば上がるが、この数字だけは上がらない
  try {
    evaluateScoringAccuracy();
  } catch (e) {
    logEvent('scoring_accuracy_error', String(e));
  }
  // テーマの重みも実績で更新する（採点だけ学習しても、聞くテーマが
  // 変わらなければ同じような下書きしか出てこないため）
  try {
    reportThemeWeights();
  } catch (e) {
    logEvent('theme_weight_error', String(e));
  }
  // メモの書き直しとスタメン入れ替えは weeklyThemeMaintenance が別枠でやる。
  // どちらもLLMを何度も呼ぶので、ここに足すと6分の実行上限に当たる
}
