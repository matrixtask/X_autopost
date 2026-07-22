/**
 * News.js — 時事ネタ用のニュース見出し取得（Googleニュース RSS）
 */

var NEWS_FEEDS = [
  // 国際: eVTOL/エアモビリティ（英語圏の一次情報。大手ニュースに出ない話を拾う）
  'https://news.google.com/rss/search?q=eVTOL%20OR%20%22air%20taxi%22%20OR%20%22urban%20air%20mobility%22&hl=en-US&gl=US&ceid=US:en',
  // 国際: 航空・モビリティ系スタートアップの資金調達・進捗
  'https://news.google.com/rss/search?q=aviation%20startup%20funding%20OR%20%22flying%20car%22%20startup&hl=en-US&gl=US&ceid=US:en',
  // 国際: テック系スタートアップ全般（TechCrunch Transportation）
  'https://techcrunch.com/category/transportation/feed/',
  // 国内: スタートアップ・モビリティ
  'https://news.google.com/rss/search?q=%E3%82%B9%E3%82%BF%E3%83%BC%E3%83%88%E3%82%A2%E3%83%83%E3%83%97%20%E8%B3%87%E9%87%91%E8%AA%BF%E9%81%94%20OR%20%E3%83%A2%E3%83%93%E3%83%AA%E3%83%86%E3%82%A3&hl=ja&gl=JP&ceid=JP:ja',
  // 国内: 空飛ぶクルマ / eVTOL
  'https://news.google.com/rss/search?q=%E7%A9%BA%E9%A3%9B%E3%81%B6%E3%82%AF%E3%83%AB%E3%83%9E%20OR%20eVTOL&hl=ja&gl=JP&ceid=JP:ja',
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
