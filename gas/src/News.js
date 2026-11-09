/**
 * News.js — 時事ネタ用のニュース見出し取得（Googleニュース RSS）
 *
 * 方針:
 * - テクノロジーとモビリティを広く取る。空飛ぶクルマに寄せない
 *   （自社領域の話ばかりだと、時事枠が事業紹介の言い換えになってしまう）
 * - 直近3日に絞る。Googleニュース検索の `when:3d` を使い、さらに
 *   pubDate でも足切りする（フィードによっては古い記事が混ざるため）
 * - 何媒体が扱っているかを「話題の大きさ」の代理指標にする。
 *   実インプレッションはRSSからは取れず、報道量は候補探しの目安に限る
 */

/** Googleニュース検索のRSS URLを組み立てる（日本語/英語） */
function googleNewsFeed(query, lang, days) {
  var q = encodeURIComponent(query + ' when:' + (days || 3) + 'd');
  return lang === 'en'
    ? 'https://news.google.com/rss/search?q=' + q + '&hl=en-US&gl=US&ceid=US:en'
    : 'https://news.google.com/rss/search?q=' + q + '&hl=ja&gl=JP&ceid=JP:ja';
}

function newsFeeds(days) {
  return [
    // 日英を同じ領域にまとめ、AIと複数のディープテック領域から候補を取る。
    { url: googleNewsFeed('生成AI OR AIエージェント OR 人工知能', 'ja', days), area: 'AI' },
    { url: googleNewsFeed('"generative AI" OR "AI agents" OR "AI models"', 'en', days), area: 'AI' },
    { url: googleNewsFeed('ロボティクス OR ヒューマノイド OR 産業用ロボット', 'ja', days), area: 'ロボティクス' },
    { url: googleNewsFeed('robotics OR humanoid OR "industrial robot"', 'en', days), area: 'ロボティクス' },
    { url: googleNewsFeed('半導体 OR 量子コンピュータ OR 光コンピューティング', 'ja', days), area: '半導体・計算基盤' },
    { url: googleNewsFeed('semiconductor OR "quantum computing"', 'en', days), area: '半導体・計算基盤' },
    { url: googleNewsFeed('宇宙開発 OR ロケット OR 衛星通信', 'ja', days), area: '宇宙' },
    { url: googleNewsFeed('全固体電池 OR 核融合 OR 新素材 OR 蓄電技術', 'ja', days), area: 'エネルギー・素材' },
    { url: googleNewsFeed('"solid state battery" OR "fusion energy" OR "advanced materials"', 'en', days), area: 'エネルギー・素材' },
    { url: googleNewsFeed('自動運転 OR ロボタクシー OR eVTOL OR ドローン技術', 'ja', days), area: 'モビリティ' },
    { url: googleNewsFeed('"autonomous driving" OR eVTOL OR "air taxi"', 'en', days), area: 'モビリティ' },
    { url: googleNewsFeed('ディープテック OR 合成生物学 OR バイオ製造', 'ja', days), area: 'ディープテック' },
  ];
}

/**
 * 見出しを取得する。
 *
 * @param {number} limit 返す最大件数（既定15）
 * @param {number} days 何日前までを対象にするか（既定3）
 * @returns {Array} [{title, source, area, ageHours, publishedAt, url, dup}] 話題の大きさ順
 */
function fetchNewsItems(limit, days) {
  var maxAgeDays = Number(days || getProp('NEWS_MAX_AGE_DAYS', '3'));
  var fetchedAt = new Date().getTime();
  var cutoff = fetchedAt - maxAgeDays * 86400000;
  var items = [];

  newsFeeds(maxAgeDays).forEach(function (feed) {
    try {
      var res = UrlFetchApp.fetch(feed.url, { muteHttpExceptions: true });
      if (res.getResponseCode() >= 300) return;
      var doc = XmlService.parse(res.getContentText());
      var channel = doc.getRootElement().getChild('channel');
      if (!channel) return;
      channel.getChildren('item').slice(0, 12).forEach(function (item) {
        var title = item.getChildText('title');
        if (!title) return;
        var pub = item.getChildText('pubDate');
        var t = pub ? new Date(pub).getTime() : NaN;
        // 鮮度不明・未来・古い記事は「最近のニュース」に混ぜない。
        if (!isFinite(t) || t < cutoff || t > fetchedAt) return;
        items.push({
          title: title,
          source: (item.getChild('source') && item.getChild('source').getText()) || '',
          area: feed.area,
          publishedAt: new Date(t).toISOString(),
          url: /^https?:\/\//i.test(item.getChildText('link') || '') ? item.getChildText('link') : '',
          ageHours: Math.round((fetchedAt - t) / 3600000),
        });
      });
    } catch (e) {
      logEvent('news_error', feed.area + ': ' + String(e).slice(0, 150));
    }
  });

  if (!items.length) return [];

  // 同じ出来事をまとめ、扱っている媒体が多い順 → 新しい順
  var clustered = clusterHeadlines(items);
  clustered.sort(function (a, b) {
    if (b.dup !== a.dup) return b.dup - a.dup;
    return (a.ageHours === null ? 999 : a.ageHours) - (b.ageHours === null ? 999 : b.ageHours);
  });
  return balanceByArea(clustered, limit || 15);
}

/**
 * 領域ごとに順番に取って、上位が一領域で埋まるのを防ぐ。
 *
 * フィードを増やしても、話題の大きさ順に並べるとAIのように記事数が多い
 * 領域が上位を占める。プロンプトに渡る時点で偏っていたら、そこから選ぶ
 * テーマも偏る。各領域の1位から順に拾っていく。
 */
function balanceByArea(items, limit) {
  var byArea = {};
  var order = [];
  items.forEach(function (it) {
    var k = String(it.area || '?');
    if (!byArea[k]) { byArea[k] = []; order.push(k); }
    byArea[k].push(it);
  });
  var out = [];
  for (var round = 0; out.length < limit; round++) {
    var added = 0;
    for (var i = 0; i < order.length && out.length < limit; i++) {
      var list = byArea[order[i]];
      if (list.length > round) { out.push(list[round]); added++; }
    }
    if (!added) break;
  }
  return out;
}

/** 文字列配列の互換性を保ち、日付・出典も質問生成へ渡す。 */
function fetchNewsHeadlines(limit, days) {
  return fetchNewsItems(limit, days).map(function (it) { return formatNewsItem(it).replace(/^- /, ''); });
}

/** 話題の大きさと鮮度を添えた1行表記（プロンプトに渡す用） */
function formatNewsItem(it) {
  var parts = [];
  if (it.dup > 1) parts.push(it.dup + '媒体が報道');
  if (it.ageHours !== null && it.ageHours !== undefined) parts.push(it.ageHours + '時間前');
  if (it.area) parts.push(it.area);
  if (it.source) parts.push(it.source);
  if (it.publishedAt) parts.push(it.publishedAt);
  if (it.url) parts.push(it.url);
  return '- ' + stripHeadlineSource(it.title) + (parts.length ? '（' + parts.join(' / ') + '）' : '');
}
