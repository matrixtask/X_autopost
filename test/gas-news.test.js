import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup() {
  const now = Date.now();
  const item = (title, hours, extra = {}) => {
    const data = { title, pubDate: hours === null ? '' : new Date(now - hours * 3600000).toUTCString(),
      link: 'https://example.com/news', ...extra };
    return { getChildText: k => data[k] || '', getChild: k => k === 'source' ? { getText: () => 'テスト媒体' } : null };
  };
  const entries = [item('新しい移動サービスの発表', 2), item('古すぎる話題', 80),
    item('日付がない話題', null), item('未来の日付の話題', -24), item('壊れた日付', null, { pubDate: 'invalid' })];
  const ctx = vm.createContext({ Date, getProp: (_k, fallback) => fallback, logEvent: () => {},
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => 'test' }) },
    XmlService: { parse: () => ({ getRootElement: () => ({ getChild: () => ({ getChildren: () => entries }) }) }) },
  });
  for (const name of ['Pure', 'News']) vm.runInContext(readFileSync(new URL(`../gas/src/${name}.js`, import.meta.url), 'utf8'), ctx);
  ctx.newsFeeds = () => [{ url: 'https://example.com/feed', area: '移動' }];
  return { ctx, entries };
}

test('news excludes stale, unknown and future dates and preserves source metadata in question context', () => {
  const { ctx } = setup();
  const items = ctx.fetchNewsItems(12, 3);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'テスト媒体');
  assert.equal(items[0].url, 'https://example.com/news');
  assert.equal(items[0].ageHours, 2);
  assert.ok(Number.isFinite(Date.parse(items[0].publishedAt)));
  const headlines = ctx.fetchNewsHeadlines(12, 3);
  assert.equal(headlines.length, 1);
  assert.match(headlines[0], /新しい移動サービス.*テスト媒体.*https:\/\/example.com\/news/);
});

test('empty or unavailable feeds return no news rather than fabricated fallback headlines', () => {
  const { ctx, entries } = setup();
  entries.length = 0;
  assert.equal(ctx.fetchNewsHeadlines(12).length, 0);
  ctx.UrlFetchApp.fetch = () => { throw new Error('offline'); };
  assert.equal(ctx.fetchNewsItems(12).length, 0);
});
