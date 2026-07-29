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
/** 各軸と成果指標の単相関。標本5件未満の軸は corr=null */
function axisCorrelationsFor(target, outcomes) {
  return AXES.map(function (a) {
    var xs = [], ys = [];
    target.forEach(function (r, i) {
      var ax = parseAxes(r.axes);
      if (ax && isFinite(Number(ax[a.key]))) { xs.push(Number(ax[a.key])); ys.push(outcomes[i]); }
    });
    return { key: a.key, label: a.label, n: xs.length, corr: xs.length >= 5 ? pearson(xs, ys) : null };
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
    // フォロワー数もアルゴリズムも時期で変わるため、生インプではなく
    // 前後30日の投稿内での相対順位に変換して比較可能にする
    target = rows.filter(function (r) { return Number(r.impressions || 0) > 0 && r.posted_at; });
    outcomeName = 'インプレッション窓内順位';
    outcomes = percentileWithinWindow(target.map(function (r) {
      return { t: new Date(String(r.posted_at).replace(' ', 'T') + ':00+09:00').getTime(), v: Number(r.impressions) };
    }), 30);
  }

  var results = axisCorrelationsFor(target, outcomes);

  // 相関ベクトルをそのまま保存する（重みへの変換はせず、内積の係数として使う）。
  // 標本数も一緒に残し、読み出し側で n/(n+K) の縮小をかける。
  var minSamples = Number(getProp('MIN_AXIS_SAMPLES', '10'));
  var usable = results.filter(function (x) { return x.corr !== null && x.n >= minSamples; });
  var updated = false;
  var storeKey = wantFollow ? 'AXIS_CORRELATIONS' : 'AXIS_CORRELATIONS_REACH';

  if (usable.length >= 3) {
    var store = {};
    results.forEach(function (x) {
      if (x.corr !== null && x.n >= minSamples) {
        store[x.key] = { c: Math.round(x.corr * 1000) / 1000, n: x.n };
      }
    });
    PropertiesService.getScriptProperties().setProperty(storeKey, JSON.stringify(store));
    updated = true;
    logEvent('axis_correlations', storeKey + ' ' + JSON.stringify(store));
  }

  // 実際にスコア計算で使われている係数（縮小後）と、その寄与率
  var effective = axisCorrelations();
  var absSum = 0;
  AXES.forEach(function (a) { absSum += Math.abs(Number(effective[a.key]) || 0); });

  var floors = axisFloors();
  var ranked = results.slice().sort(function (a, b) {
    return (b.corr === null ? -2 : b.corr) - (a.corr === null ? -2 : a.corr);
  }).map(function (x) {
    var eff = Number(effective[x.key]) || 0;
    return {
      key: x.key, label: x.label, n: x.n, corr: x.corr,
      effective: Math.round(eff * 1000) / 1000,
      share: absSum > 0 ? Math.round(Math.abs(eff) / absSum * 1000) / 10 : 0,
      // 相関が下限を下回っていて、重みが下限で止められている軸
      floored: floors[x.key] !== undefined && eff <= Number(floors[x.key]) + 1e-9,
    };
  });
  return {
    outcomeName: outcomeName, sampleSize: target.length, minSamples: minSamples,
    ranked: ranked, updated: updated,
  };
}

/**
 * 交絡の検証: 取り込んだ手動投稿と、この仕組みが生成した投稿とで、
 * 軸の効き方が違うかどうかを見る。
 *
 * 標本の大半は取り込んだ過去の手動投稿で、それらは定義上いちばん
 * 「本人らしい」うえに雑談や短い呟きが多い。そのため「本人らしさ」の
 * 負の相関が、文体そのものではなく「昔の雑な呟きかどうか」を拾って
 * いる可能性がある。群を分けて符号が変わるなら、その疑いは濃い。
 *
 * 成果指標は analyzeAxes と同じ考え方で、群ごとに窓内インプ順位を使う
 * （プロフィールクリックは直近30日分しかなく、群を割ると足りないため）。
 */
function analyzeAxesByOrigin() {
  var rows = analyzableRows().filter(function (r) {
    return Number(r.impressions || 0) > 0 && r.posted_at;
  });
  var groups = {
    manual: rows.filter(function (r) { return String(r.category) === 'manual'; }),
    generated: rows.filter(function (r) { return String(r.category) !== 'manual'; }),
  };

  var out = {};
  Object.keys(groups).forEach(function (name) {
    var g = groups[name];
    if (g.length < 10) { out[name] = { n: g.length, ranked: null }; return; }
    // 群ごとに窓内順位を取り直す（群をまたいで順位を比べても意味がないため）
    var outcomes = percentileWithinWindow(g.map(function (r) {
      return { t: new Date(String(r.posted_at).replace(' ', 'T') + ':00+09:00').getTime(), v: Number(r.impressions) };
    }), 30);
    out[name] = { n: g.length, ranked: axisCorrelationsFor(g, outcomes) };
  });
  return out;
}

/** 交絡検証をSlackに投げる。手動実行用 */
function reportAxesByOrigin() {
  var a = analyzeAxesByOrigin();
  if (!a.manual.ranked || !a.generated.ranked) {
    var msg = ':mag: 交絡検証: 群が足りません（手動投稿' + a.manual.n + '件 / 生成投稿' + a.generated.n +
      '件。それぞれ10件以上必要です）';
    notifySlack(msg);
    return msg;
  }
  var byKey = {};
  a.generated.ranked.forEach(function (x) { byKey[x.key] = x; });

  var lines = [
    ':mag: *交絡検証: 手動投稿 vs 生成投稿*（成果指標はどちらもインプレッション窓内順位）',
    '手動' + a.manual.n + '件 / 生成' + a.generated.n + '件。',
    '符号が入れ替わる軸は、その軸そのものではなく「どちらの群か」を測っている疑いがあります。',
    '',
  ];
  var flipped = [];
  a.manual.ranked.slice().sort(function (x, y) {
    return (y.corr === null ? -2 : y.corr) - (x.corr === null ? -2 : x.corr);
  }).forEach(function (m) {
    var g = byKey[m.key];
    if (m.corr === null || !g || g.corr === null) return;
    var flip = (m.corr < -0.05 && g.corr > 0.05) || (m.corr > 0.05 && g.corr < -0.05);
    if (flip) flipped.push(m.label);
    lines.push((flip ? ':warning: ' : '') + m.label +
      ': 手動 ' + (m.corr >= 0 ? '+' : '') + m.corr.toFixed(2) +
      ' / 生成 ' + (g.corr >= 0 ? '+' : '') + g.corr.toFixed(2));
  });
  lines.push('');
  lines.push(flipped.length
    ? '符号が反転した軸: ' + flipped.join('、') + '。これらは交絡の疑いが濃いので、重みをそのまま信じないでください。'
    : '符号が反転した軸はありません。群による交絡は見当たりません。');
  notifySlack(lines.join('\n'));
  return lines.join('\n');
}

/**
 * 軸別分析をSlackに投げる（週次から呼ばれる。手動実行も可）。
 * リーチモデルとフォローモデルの両方を回して、それぞれの効き方を並べて出す。
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

  var lines = [
    ':microscope: *軸別の効き方分析*',
    '全体スコアは「軸スコア × 下の相関」の内積で算出されます。',
  ];
  models.forEach(function (a) {
    lines.push('');
    lines.push('*' + a.outcomeName + '*（n=' + a.sampleSize + '）');
    var shown = 0;
    a.ranked.forEach(function (x) {
      if (x.corr === null) return;
      shown++;
      var bar = '█'.repeat(Math.max(1, Math.round(Math.abs(x.corr) * 12)));
      // 寄与率は2モデルを合成した後の最終的な重みなので、両モデルで同じ値になる。
      // モデルごとの数字と誤読されないよう、相関とは別物であることを明示する
      lines.push((x.corr >= 0 ? '+' : '−') + Math.abs(x.corr).toFixed(2) + ' ' + bar +
        ' ' + x.label + '（n=' + x.n + ' / 合成後の寄与' + x.share + '%' +
        (x.floored ? '・下限で固定' : '') + '）');
    });
    if (!shown) lines.push('（このモデルはまだデータ不足）');
    var lacking = a.ranked.filter(function (x) { return x.corr === null; });
    if (lacking.length && shown) {
      lines.push('データ不足の軸: ' + lacking.map(function (x) { return x.label; }).join('、'));
    }
    lines.push(a.updated
      ? ':white_check_mark: 相関を更新しました。次回の採点から反映されます。'
      : ':hourglass: 相関は未更新（各軸' + a.minSamples + '件以上たまると自動更新します）。');
    var negatives = a.ranked.filter(function (x) { return x.corr !== null && x.corr < -0.1; });
    if (negatives.length) {
      lines.push('※ ' + negatives.map(function (x) { return x.label; }).join('、') +
        ' は負の相関。高いポストほど成果が下がっているため、スコアでは減点として働きます。');
    }
  });
  if (models.length < 2) {
    lines.push('');
    lines.push('フォローモデル（プロフィールクリック率）はまだ標本不足です。' +
      'クリック数はXの仕様で直近30日分しか取れないため、投稿を重ねながらたまるのを待ちます。');
  }
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
  // 軸別の効き方分析と重み更新
  try {
    reportAxisAnalysis();
  } catch (e) {
    logEvent('axis_analysis_error', String(e));
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
