/**
 * News.js — 時事ネタ用のニュース見出し取得（Googleニュース RSS）
 */

var NEWS_FEEDS = [
  'https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja', // トップ
  'https://news.google.com/rss/search?q=%E7%A9%BA%E9%A3%9B%E3%81%B6%E3%82%AF%E3%83%AB%E3%83%9E%20OR%20eVTOL&hl=ja&gl=JP&ceid=JP:ja', // 空飛ぶクルマ / eVTOL
  'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=ja&gl=JP&ceid=JP:ja', // テック
];

/** 各フィードから見出しを取り、重複を除いて最大 limit 件返す */
function fetchNewsHeadlines(limit) {
  var titles = [];
  var seen = {};
  NEWS_FEEDS.forEach(function (url) {
    try {
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() >= 300) return;
      var doc = XmlService.parse(res.getContentText());
      var items = doc.getRootElement().getChild('channel').getChildren('item');
      items.slice(0, 8).forEach(function (item) {
        var title = item.getChildText('title');
        if (title && !seen[title]) {
          seen[title] = true;
          titles.push(title);
        }
      });
    } catch (e) {
      logEvent('news_error', url + ': ' + e);
    }
  });
  return titles.slice(0, limit || 15);
}
