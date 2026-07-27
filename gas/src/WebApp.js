/**
 * WebApp.js — Webアプリのエンドポイント
 *
 * doGet  : 確認・承認UI。Googleアカウント認証が必須（下記アクセス制御を参照）
 * doPost : Slack Events APIの受け口。Slackは匿名POSTのためGoogle認証は使えない
 *
 * 【デプロイは2本に分ける】
 *  A. 管理UI用: アクセス = 「テトラ・アビエーション内のユーザー」（ドメイン制限）
 *     → 人間が使うURL。Googleが認証し、さらにコード側でもメールを検証する
 *  B. Slack用:  アクセス = 「全員」
 *     → SlackのRequest URL専用。このURLでUIを開いても匿名なので必ず拒否される
 *
 * アクセス制御の設定（スクリプトプロパティ）:
 *   ALLOWED_DOMAINS  許可するメールドメイン（既定: tetra-aviation.com、カンマ区切り）
 *   ALLOWED_EMAILS   個別に許可するメールアドレス（任意、カンマ区切り）
 *   REQUIRE_TOKEN    "false" にするとURLの ?token= を不要にできる（既定: true）
 *   ACCESS_MODE      "token" にすると旧方式（トークンのみ）に一時的に戻せる。
 *                    ドメイン制限デプロイでメール取得に失敗した場合の緊急避難用
 */

/** アクセス中のGoogleアカウント。匿名アクセスや取得不可なら空文字 */
function currentUserEmail() {
  try {
    return String(Session.getActiveUser().getEmail() || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

function csvProp(key, fallback) {
  return String(getProp(key, fallback || ''))
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
}

/**
 * Googleアカウント + トークンの二重チェック。
 * 認可されていればメールアドレスを返し、そうでなければ例外を投げる。
 */
function assertAccess(token) {
  var legacyMode = String(getProp('ACCESS_MODE', 'account')).toLowerCase() === 'token';
  var email = currentUserEmail();

  if (!legacyMode) {
    if (!email) {
      throw new Error('Googleアカウントで認証されていません。ドメイン制限デプロイのURLを、テトラのアカウントでログインした状態で開いてください。');
    }
    var domain = email.indexOf('@') >= 0 ? email.split('@')[1] : '';
    var allowedDomains = csvProp('ALLOWED_DOMAINS', 'tetra-aviation.com');
    var allowedEmails = csvProp('ALLOWED_EMAILS', '');
    var ok = allowedEmails.indexOf(email) >= 0 || allowedDomains.indexOf(domain) >= 0;
    if (!ok) {
      logEvent('access_denied', email);
      throw new Error('このアカウントには権限がありません: ' + email);
    }
  }

  // URL共有事故に備えた二次防御。REQUIRE_TOKEN=false で省略できる
  if (String(getProp('REQUIRE_TOKEN', 'true')).toLowerCase() !== 'false') {
    if (!token || token !== getProp('ADMIN_TOKEN')) throw new Error('認証エラー（token不一致）');
  }
  return email;
}

function denyPage(message) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,sans-serif;padding:24px;line-height:1.7">' +
    '<h2 style="font-size:17px;margin:0 0 8px">アクセスできません</h2>' +
    '<p style="color:#5A5F68;font-size:14px">' + message.replace(/[<>&]/g, '') + '</p>' +
    '</div>'
  );
}

function doGet(e) {
  var token = e && e.parameter ? e.parameter.token : '';
  var email;
  try {
    email = assertAccess(token);
  } catch (err) {
    return denyPage(String(err.message || err));
  }
  logEvent('webapp_open', email || '(token mode)');
  var template = HtmlService.createTemplateFromFile('Index');
  template.token = token;
  return template.evaluate()
    .setTitle('X Autopost ストック')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('bad request');
  }

  // SlackのURL検証
  if (payload.type === 'url_verification') {
    return ContentService.createTextOutput(payload.challenge);
  }

  // 文体サンプルの一括取り込み（Xアーカイブ等から。ADMIN_TOKEN必須）
  // 例: POST {"action":"import_voice","token":"...","posts":["...","..."],"note":"archive"}
  if (payload.action === 'import_voice') {
    if (!payload.token || payload.token !== getProp('ADMIN_TOKEN')) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }
    var added = importVoicePosts(payload.posts || [], payload.note || 'import');
    return ContentService.createTextOutput(JSON.stringify({ ok: true, added: added }));
  }

  if (payload.type === 'event_callback') {
    // GASはリクエストヘッダを読めないため署名検証ができない。
    // 代わりにチャンネルIDの一致を確認し、event_idで重複排除する。
    var event = payload.event || {};
    var eventId = payload.event_id;
    var cache = CacheService.getScriptCache();
    if (eventId) {
      if (cache.get('ev_' + eventId)) return ContentService.createTextOutput('dup');
      cache.put('ev_' + eventId, '1', 3600);
    }
    if (
      event.type === 'message' &&
      !event.bot_id &&
      !event.subtype &&
      String(event.channel).trim() === String(getProp('SLACK_CHANNEL_ID') || '').trim()
    ) {
      try {
        if (event.thread_ts) {
          var handled = handleInterviewReply(event.thread_ts, event.text);
          // 完了済みインタビューのスレッドへの自由記述は運用メモとして取り込む
          if (!handled) handleThreadFeedback(event.thread_ts, event.text);
        } else {
          // スレッド外に書かれた場合も、進行中インタビューへの回答として救済する
          handleChannelMessage(event.text);
        }
      } catch (err) {
        logEvent('slack_event_error', String(err));
      }
    } else if (event.type === 'message' && !event.bot_id) {
      // チャンネル不一致の切り分け用ログ（SLACK_CHANNEL_ID設定ミスの検出）
      logEvent('slack_event_ignored', 'channel=' + event.channel + ' subtype=' + (event.subtype || '') + ' expected=' + getProp('SLACK_CHANNEL_ID'));
    }
  }
  return ContentService.createTextOutput('ok');
}

// ---- Web UI から google.script.run で呼ばれるAPI ----


function api_listPosts(token) {
  assertAccess(token);
  var rows = readTable(SHEET.STOCK).map(function (r) {
    return {
      id: String(r.id),
      created_at: String(r.created_at),
      theme: String(r.theme),
      category: String(r.category),
      text: String(r.text),
      score: r.score === '' ? null : Number(r.score),
      score_reason: String(r.score_reason || ''),
      status: String(r.status),
      scheduled_at: String(r.scheduled_at || ''),
      posted_at: String(r.posted_at || ''),
    };
  });
  rows.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
  return JSON.stringify(rows);
}

function api_setStatus(token, id, status) {
  assertAccess(token);
  var allowed = [STATUS.APPROVED, STATUS.REJECTED, STATUS.READY, STATUS.STOCK];
  if (allowed.indexOf(status) < 0) throw new Error('不正なステータス: ' + status);
  var updates = { status: status };
  if (status !== STATUS.SCHEDULED) updates.scheduled_at = '';
  updateStockById(id, updates);
  logEvent('webapp_status', id + ' -> ' + status);
  try { syncStockRowToNotion(id); } catch (e) { logEvent('notion_error', id + ': ' + e); }
  return 'ok';
}

function api_updateText(token, id, text) {
  assertAccess(token);
  var t = String(text || '').trim();
  if (!t) throw new Error('本文が空です');
  if (!fitsInTweet(t)) throw new Error('長すぎます（280重み超過）。現在: ' + weightedTweetLength(t));

  var row = readTable(SHEET.STOCK).filter(function (r) { return String(r.id) === String(id); })[0];
  var rescoreTargets = [STATUS.DRAFT, STATUS.STOCK, STATUS.READY];
  var shouldRescore = row && rescoreTargets.indexOf(String(row.status)) >= 0;

  updateStockById(id, shouldRescore
    ? { text: t, status: STATUS.DRAFT, score: '', score_reason: '' } // 編集分は再採点にかける
    : { text: t });
  logEvent('webapp_edit', id);

  var message = '保存しました';
  if (shouldRescore) {
    try {
      runQualityGate(); // 編集直後に即再採点（リライトはかけず、あなたの文をそのまま採点）
      var updated = readTable(SHEET.STOCK).filter(function (r) { return String(r.id) === String(id); })[0];
      if (updated && updated.score !== '') {
        var passed = [STATUS.READY, STATUS.APPROVED].indexOf(String(updated.status)) >= 0;
        message = '再採点: ' + updated.score + '点（' + (passed ? '合格' : '保留') + '）' +
          (updated.score_reason ? ' / ' + updated.score_reason : '');
      }
    } catch (e) {
      logEvent('rescore_error', id + ': ' + e);
      message = '保存しました（再採点は次回ゲートで実行）';
    }
  }
  try { syncStockRowToNotion(id); } catch (e) { logEvent('notion_error', id + ': ' + e); }
  return message;
}

/**
 * ストック・不合格分の自己批判リライト＋再採点をその場で回す。
 * 手動実行なので、自動リライトの上限(REFINE_ROUNDS)に達したものも
 * もう一度書き直しの対象にする。
 */
function api_refineNow(token) {
  assertAccess(token);
  var refined = refineFailedDrafts(true);
  if (!refined) return 'リライト対象がありません（不合格ストックが0件）';
  var gate = runQualityGate();
  logEvent('webapp_refine', 'リライト' + refined + '件 / 合格' + gate.passed + '件');
  return 'リライト' + refined + '件 → 再採点で合格' + gate.passed + '件';
}

function api_scheduleNow(token) {
  assertAccess(token);
  var scheduled = scheduleApprovedPosts();
  return JSON.stringify(scheduled);
}

/**
 * 分析タブ用の集計。オーガニックインプ基準(広告分離不能なプロモ行は除外)で
 * 時間帯・曜日・カテゴリ別の平均と、インプレッションTop10を返す。
 */
function api_analytics(token) {
  assertAccess(token);
  var rows = readTable(SHEET.STOCK).filter(function (r) {
    if (String(r.status) !== STATUS.POSTED || !r.metrics_at) return false;
    if (String(r.promoted) === 'yes' && r.paid_impressions === '') return false;
    return true;
  });

  var DAYS = ['日', '月', '火', '水', '木', '金', '土'];
  function agg(map, key, r) {
    if (!map[key]) map[key] = { n: 0, imp: 0, likes: 0, points: [] };
    map[key].n++;
    map[key].imp += Number(r.impressions || 0);
    map[key].likes += Number(r.likes || 0);
    map[key].points.push(Number(r.impressions || 0));
  }

  var bySlot = {}, byDay = {}, byCat = {};
  var totalImp = 0, totalLikes = 0;
  rows.forEach(function (r) {
    var postedAt = String(r.posted_at || '');
    var d = new Date(postedAt.replace(' ', 'T') + ':00+09:00');
    if (postedAt.length >= 16 && !isNaN(d.getTime())) {
      agg(bySlot, postedAt.slice(11, 13) + '時台', r);
      agg(byDay, DAYS[d.getDay()], r);
    }
    agg(byCat, String(r.category || '不明'), r);
    totalImp += Number(r.impressions || 0);
    totalLikes += Number(r.likes || 0);
  });

  var sorted = rows.slice().sort(function (a, b) {
    return Number(b.impressions || 0) - Number(a.impressions || 0);
  });
  function rowView(r) {
    var postedAt = String(r.posted_at || '');
    return {
      text: String(r.text).slice(0, 90),
      imp: Number(r.impressions || 0),
      likes: Number(r.likes || 0),
      rt: Number(r.retweets || 0),
      rep: Number(r.replies || 0),
      category: String(r.category || ''),
      score: r.score === '' ? null : Number(r.score),
      posted_at: postedAt,
      slot: postedAt.length >= 16 ? postedAt.slice(11, 13) + '時台' : '',
      promoted: String(r.promoted) === 'yes',
    };
  }
  var top10 = sorted.slice(0, 10).map(rowView);
  var table = sorted.map(rowView);

  // 採点スコアと実測インプの相関（採点のある自動投稿のみ）
  var scored = rows.filter(function (r) { return r.score !== ''; });
  var scatter = scored.map(function (r) {
    return { score: Number(r.score), imp: Number(r.impressions || 0), text: String(r.text).slice(0, 40) };
  });
  var corr = pearson(scored.map(function (r) { return Number(r.score); }),
    scored.map(function (r) { return Number(r.impressions || 0); }));

  function toList(map) {
    return Object.keys(map).map(function (k) {
      var m = map[k];
      return {
        key: k, n: m.n,
        impAvg: Math.round(m.imp / m.n),
        likesAvg: Math.round(m.likes / m.n * 10) / 10,
        engRate: m.imp > 0 ? Math.round(1000 * m.likes / m.imp) / 10 : 0,
        points: m.points,
      };
    }).sort(function (a, b) { return b.impAvg - a.impAvg; });
  }

  return JSON.stringify({
    total: { n: rows.length, imp: totalImp, likes: totalLikes },
    bySlot: toList(bySlot),
    byDay: toList(byDay),
    byCat: toList(byCat),
    top10: top10,
    table: table,
    scatter: scatter,
    corr: corr === null ? null : Math.round(corr * 100) / 100,
  });
}

/** 承認待ち(ready)を一括で承認する */
function api_approveAll(token) {
  assertAccess(token);
  var readyRows = readTable(SHEET.STOCK).filter(function (r) {
    return String(r.status) === STATUS.READY;
  });
  if (!readyRows.length) return '承認待ちが0件です';
  readyRows.forEach(function (r) {
    updateStockById(r.id, { status: STATUS.APPROVED });
    try { syncStockRowToNotion(r.id); } catch (e) { logEvent('notion_error', r.id + ': ' + e); }
  });
  logEvent('webapp_approve_all', readyRows.length + '件を一括承認');
  return readyRows.length + '件を承認しました。「予約実行」で枠に割り当てられます';
}
