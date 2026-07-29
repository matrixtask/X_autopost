/**
 * News.js — 時事ネタ用のニュース見出し取得（Googleニュース RSS）
 *
 * 方針:
 * - テクノロジーとモビリティを広く取る。空飛ぶクルマに寄せない
 *   （自社領域の話ばかりだと、時事枠が事業紹介の言い換えになってしまう）
 * - 直近3日に絞る。Googleニュース検索の `when:3d` を使い、さらに
 *   pubDate でも足切りする（フィードによっては古い記事が混ざるため）
 * - 何媒体が扱っているかを「話題の大きさ」の代理指標にする。
 *   実インプレッションはRSSからは取れないので、これが得られる最善の近似
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
    // モビリティ全般（自社領域に限定しない）。
    // 「交通」のような広い語を入れると自治体の広報記事ばかり拾うので使わない
    { url: googleNewsFeed('自動運転 OR ロボタクシー OR EV OR ドローン OR 物流', 'ja', days), area: 'モビリティ' },
    { url: googleNewsFeed('autonomous driving OR EV OR mobility OR transportation', 'en', days), area: 'mobility' },
    // テクノロジー全般
    { url: googleNewsFeed('AI OR 半導体 OR ロボット OR 宇宙', 'ja', days), area: 'テック' },
    { url: googleNewsFeed('AI OR robotics OR semiconductor OR space tech', 'en', days), area: 'tech' },
    // スタートアップの資金調達・撤退（まだ知られていない話が出やすい）
    { url: googleNewsFeed('startup funding OR acquisition OR shutdown', 'en', days), area: 'startup' },
    { url: googleNewsFeed('スタートアップ 資金調達 OR 買収', 'ja', days), area: 'スタートアップ' },
    // 航空・eVTOL は1本だけ（多いと時事枠が自社領域に偏る）
    { url: googleNewsFeed('eVTOL OR "air taxi" OR aviation certification', 'en', days), area: '航空' },
    // 媒体そのもののフィード（Googleニュースに乗らない話を拾う）
    { url: 'https://techcrunch.com/feed/', area: 'TechCrunch' },
  ];
}

/**
 * 見出しを取得する。
 *
 * @param {number} limit 返す最大件数（既定15）
 * @param {number} days 何日前までを対象にするか（既定3）
 * @returns {Array} [{title, source, area, ageHours, dup}] 話題の大きさ順
 */
function fetchNewsItems(limit, days) {
  var maxAgeDays = Number(days || getProp('NEWS_MAX_AGE_DAYS', '3'));
  var cutoff = new Date().getTime() - maxAgeDays * 86400000;
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
        // 日付が読めない場合は残す（弾きすぎるより混ぜて判断させる）
        if (isFinite(t) && t < cutoff) return;
        items.push({
          title: title,
          source: (item.getChild('source') && item.getChild('source').getText()) || '',
          area: feed.area,
          ageHours: isFinite(t) ? Math.round((new Date().getTime() - t) / 3600000) : null,
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
  return clustered.slice(0, limit || 15);
}

/** 見出しの文字列だけが欲しい呼び出し向け（従来互換） */
function fetchNewsHeadlines(limit, days) {
  return fetchNewsItems(limit, days).map(function (it) { return it.title; });
}

/** 話題の大きさと鮮度を添えた1行表記（プロンプトに渡す用） */
function formatNewsItem(it) {
  var parts = [];
  if (it.dup > 1) parts.push(it.dup + '媒体が報道');
  if (it.ageHours !== null && it.ageHours !== undefined) parts.push(it.ageHours + '時間前');
  if (it.area) parts.push(it.area);
  return '- ' + stripHeadlineSource(it.title) + (parts.length ? '（' + parts.join(' / ') + '）' : '');
}
