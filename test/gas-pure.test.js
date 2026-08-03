import { test } from 'node:test';
// vm別レルムの配列/オブジェクトはプロトタイプが異なりdeepStrictEqualで弾かれるため非strictを使う
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// gas/src/Pure.js はGASのグローバル関数スタイルなので、vmで読み込んで検証する
const code = readFileSync(new URL('../gas/src/Pure.js', import.meta.url), 'utf8');
const context = { module: { exports: {} } };
vm.createContext(context);
vm.runInContext(code, context);
const { weightedTweetLength, fitsInTweet, parseJsonLoose, pickWeighted, computeNextSlots, normalizeSlackTs, slackTsEqual, pearson, dateKey } = context.module.exports;

test('normalizeSlackText: Slackの独自記法を素の文に戻す', () => {
  const { normalizeSlackText } = context.module.exports;

  // リンクを添付したときの実際の形。この記法のままだとXにそのまま出てしまう
  assert.equal(normalizeSlackText('これ見て <https://example.com/a?b=1>'),
    'これ見て https://example.com/a?b=1');
  assert.equal(normalizeSlackText('<https://example.com|すごい記事> が面白い'),
    'すごい記事 https://example.com が面白い');

  assert.equal(normalizeSlackText('<@U12345|tasuku> ありがとう'), 'tasuku ありがとう');
  assert.equal(normalizeSlackText('<@U12345> ありがとう'), '@U12345 ありがとう');
  assert.equal(normalizeSlackText('A &amp; B は &lt;重要&gt;'), 'A & B は <重要>');

  // 普通の文は壊さない
  assert.equal(normalizeSlackText('今日は暑い。試験は延期。'), '今日は暑い。試験は延期。');
  assert.equal(normalizeSlackText('  前後の空白  '), '前後の空白');
  assert.equal(normalizeSlackText(''), '');
  assert.equal(normalizeSlackText(null), '');
  assert.equal(normalizeSlackText(undefined), '');
});

test('clusterHeadlines: 同じ出来事を媒体をまたいでまとめる', () => {
  const { clusterHeadlines, stripHeadlineSource } = context.module.exports;

  assert.equal(stripHeadlineSource('トヨタが新型EVを発表 - 日経新聞'), 'トヨタが新型EVを発表');
  assert.equal(stripHeadlineSource('見出しだけ'), '見出しだけ');

  const items = [
    { title: 'トヨタが新型EVを発表、航続距離は800km - 日経新聞', area: 'モビリティ' },
    { title: 'トヨタ、新型EVを発表 航続距離800kmへ - Reuters' },   // 同じ話題
    { title: 'Waymoがロボタクシーを5都市に拡大 - The Verge' },      // 別の話題
  ];
  const c = clusterHeadlines(items);
  assert.equal(c.length, 2);
  assert.equal(c[0].dup, 2);        // トヨタの件は2媒体
  assert.equal(c[0].area, 'モビリティ'); // 先頭の要素の情報を引き継ぐ
  assert.equal(c[1].dup, 1);

  // 話題が違えばまとめない
  assert.equal(clusterHeadlines([
    { title: 'AI半導体の輸出規制が強化される' },
    { title: '南極の氷が過去最少を記録' },
  ]).length, 2);

  assert.deepEqual(clusterHeadlines([]), []);
});

test('normalizeThemeKey: 表記ゆれのテーマを同一視する', () => {
  const { normalizeThemeKey } = context.module.exports;
  const a = '空飛ぶクルマの本命は「医療・緊急」だと思う理由';
  const b = '空飛ぶクルマの本命は医療・緊急だと思う理由';
  assert.equal(normalizeThemeKey(a), normalizeThemeKey(b)); // 実際に重複していた組

  assert.equal(normalizeThemeKey('移動あるある '), normalizeThemeKey('移動あるある'));
  assert.equal(normalizeThemeKey('ＡＩと移動'), normalizeThemeKey('AIと移動')); // 全角英字
  assert.equal(normalizeThemeKey('起業家あるある！'), normalizeThemeKey('起業家あるある'));

  // 中身が違うものまで同一視しない
  assert.notEqual(normalizeThemeKey('テック・AI関連の時事'),
    normalizeThemeKey('テック・AIの時事を自分の事業との接点で語る'));
  assert.equal(normalizeThemeKey(''), '');
  assert.equal(normalizeThemeKey(null), '');
});

test('salvageJson: max_tokensで切れた応答から完成分だけ救出する', () => {
  const { salvageJson } = context.module.exports;

  // 実際に起きたケース: 一括採点の途中で切れる
  const cut = '{"p_1": [75,55,30,60,55,20,25,20,25,20,10,30,40,35,25,45,30], "p_2": [80,60,35,"';
  assert.deepEqual(salvageJson(cut), { p_1: [75, 55, 30, 60, 55, 20, 25, 20, 25, 20, 10, 30, 40, 35, 25, 45, 30] });

  // 配列でも同じ
  assert.deepEqual(salvageJson('[{"id":"a","v":1}, {"id":"b","v":'), [{ id: 'a', v: 1 }]);

  // 3件中2件まで完成
  assert.equal(salvageJson('[{"a":1},{"a":2},{"a":').length, 2);

  // 文字列の中のカンマや括弧を切れ目と誤認しない
  assert.deepEqual(salvageJson('[{"t":"a,b]"},{"t":"c'), [{ t: 'a,b]' }]);
  assert.deepEqual(salvageJson('[{"t":"エスケープ\\""},{"t":'), [{ t: 'エスケープ"' }]);

  // 1要素も完成していない・JSONですらない場合はnull
  assert.equal(salvageJson('[{"a":'), null);
  assert.equal(salvageJson('すみません、採点できません'), null);
  assert.equal(salvageJson(''), null);

  // 壊れていない入力はそのまま通る（最後の要素を落とさない）
  assert.deepEqual(salvageJson('```json\n[{"a":1},{"a":2}]\n```'), [{ a: 1 }, { a: 2 }]);
});

test('percentileWithinWindow: 窓内での相対順位に変換する', () => {
  const { percentileWithinWindow } = context.module.exports;
  const day = 86400000;
  // 同じ窓内の4件: 値 10/20/30/40 → 12.5/37.5/62.5/87.5
  const same = percentileWithinWindow(
    [{ t: 0, v: 10 }, { t: day, v: 20 }, { t: 2 * day, v: 30 }, { t: 3 * day, v: 40 }], 30);
  assert.deepEqual(same, [12.5, 37.5, 62.5, 87.5]);

  // 窓が離れていれば別グループとして評価される（フォロワー数が違う時期を混ぜない）
  const eras = percentileWithinWindow([
    { t: 0, v: 100 }, { t: day, v: 200 },                 // 昔: 100は下位
    { t: 400 * day, v: 1000 }, { t: 401 * day, v: 2000 }, // 今: 1000は下位
  ], 30);
  assert.equal(eras[0], eras[2]); // 生の値は10倍違うが、窓内順位は同じ
  assert.equal(eras[1], eras[3]);

  assert.deepEqual(percentileWithinWindow([{ t: 0, v: 5 }], 30), [50]); // 単独は50
});

test('dateKey: 日時に変換された日付でも同じ日として扱える', () => {
  assert.equal(dateKey('2026-07-27'), '2026-07-27');
  assert.equal(dateKey('2026-07-27 00:00'), '2026-07-27'); // シートが日時化したケース
  assert.equal(dateKey(' 2026-07-27 19:36 '), '2026-07-27');
  assert.equal(dateKey(''), '');
  assert.equal(dateKey('週次'), '');
  assert.equal(dateKey(null), '');
});

test('pearson: 相関係数の基本ケース', () => {
  assert.equal(pearson([1, 2, 3], [2, 4, 6]), 1); // 完全正相関
  assert.equal(pearson([1, 2, 3], [6, 4, 2]), -1); // 完全負相関
  assert.equal(pearson([1], [1]), null); // データ不足
  assert.equal(pearson([1, 1, 1], [2, 4, 6]), null); // 分散0
  const weak = pearson([80, 60, 70, 90], [100, 5000, 300, 200]);
  assert.ok(weak !== null && weak > -1 && weak < 1);
});

test('slackTsEqual: シートの数値解釈で下位桁が失われても一致する', () => {
  assert.equal(slackTsEqual('1784266535.69018', '1784266535.690180'), true); // 末尾0落ち
  assert.equal(slackTsEqual('1784266535.69018', '1784266535.690189'), true); // 精度落ち（実例）
  assert.equal(slackTsEqual(1784266535.69018, '1784266535.690189'), true);
  assert.equal(slackTsEqual('ts_1784266535.690189', '1784266535.690189'), true); // 接頭辞付き保存
  assert.equal(slackTsEqual('1784266536.690189', '1784266535.690189'), false); // 別の秒
  assert.equal(slackTsEqual('', ''), false);
  assert.equal(normalizeSlackTs('ts_1784266535.690180'), '1784266535.69018');
  assert.equal(normalizeSlackTs(' abc '), 'abc');
});

test('weightedTweetLength: 半角は1、全角は2', () => {
  assert.equal(weightedTweetLength(''), 0);
  assert.equal(weightedTweetLength('hello'), 5);
  assert.equal(weightedTweetLength('こんにちは'), 10);
  assert.equal(weightedTweetLength('abcあいう'), 3 + 6);
});

test('weightedTweetLength: URLは一律23', () => {
  assert.equal(weightedTweetLength('https://example.com/very/long/path?query=1'), 23);
  assert.equal(weightedTweetLength('見て https://example.com'), 4 + 1 + 23);
});

test('fitsInTweet: 全角140字はOK、141字はNG', () => {
  assert.equal(fitsInTweet('あ'.repeat(140)), true);
  assert.equal(fitsInTweet('あ'.repeat(141)), false);
});

test('parseJsonLoose: コードフェンスや前置きを無視する', () => {
  assert.deepEqual(parseJsonLoose('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(parseJsonLoose('結果は以下です。\n{"ok": true}\n以上。'), { ok: true });
  assert.throws(() => parseJsonLoose('JSONなし'));
});

test('pickWeighted: 乱数固定で決定的に選ばれる', () => {
  const items = [{ w: 1 }, { w: 3 }];
  assert.equal(pickWeighted(items, (i) => i.w, () => 0.1), items[0]); // 0.4未満
  assert.equal(pickWeighted(items, (i) => i.w, () => 0.9), items[1]);
  assert.equal(pickWeighted([], (i) => 1), null);
});

test('computeNextSlots: リード時間内の枠は飛ばす', () => {
  const slots = computeNextSlots(2, {
    now: new Date(2026, 6, 16, 7, 30),
    slotTimes: ['08:00', '12:30', '19:30'],
    taken: [],
    minLeadMinutes: 60,
  });
  // 08:00は 07:30+60分 より前なのでスキップ
  assert.deepEqual(slots, ['2026-07-16 12:30', '2026-07-16 19:30']);
});

test('computeNextSlots: 予約済み枠は避けて翌日に流れる', () => {
  const slots = computeNextSlots(3, {
    now: new Date(2026, 6, 16, 7, 30),
    slotTimes: ['08:00', '12:30', '19:30'],
    taken: ['2026-07-16 12:30'],
    minLeadMinutes: 60,
  });
  assert.deepEqual(slots, ['2026-07-16 19:30', '2026-07-17 08:00', '2026-07-17 12:30']);
});

test('computeNextSlots: maxPerDayで1日の投稿数を制限する', () => {
  const slots = computeNextSlots(3, {
    now: new Date(2026, 6, 16, 0, 0),
    slotTimes: ['08:00', '12:30', '19:30'],
    taken: [],
    minLeadMinutes: 60,
    maxPerDay: 1,
  });
  assert.deepEqual(slots, ['2026-07-16 08:00', '2026-07-17 08:00', '2026-07-18 08:00']);
});
