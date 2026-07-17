/**
 * Themes.js — テーマプールと日次のテーマ選定
 *
 * category:
 *   evergreen … 定番（仕事観・事業の学び・失敗談など）
 *   news      … 時事ネタ（Googleニュースの見出しと組み合わせる）
 *   neta      … ネタポスト（ゆるい話・あるある・自虐など）
 */

var DEFAULT_THEMES = [
  ['空飛ぶクルマ事業の今日の一歩', 'evergreen', 3, '進捗・学び・現場の話'],
  ['事業開発で最近ぶつかった壁', 'evergreen', 3, '失敗談・悩みは反応されやすい'],
  ['スタートアップ経営の原理原則', 'evergreen', 2, '自分の言葉で言い直す'],
  ['採用・チームづくりで考えていること', 'evergreen', 2, ''],
  ['航空・モビリティ業界の時事', 'news', 3, 'ニュース見出しに一言乗せる'],
  ['テック・AI関連の時事', 'news', 2, '自分の事業との接点で語る'],
  ['今日の時事に一言', 'news', 2, '業界外のニュースでもOK'],
  ['起業家あるある', 'neta', 2, '自虐・ゆるネタ'],
  ['今日あったどうでもいい話', 'neta', 2, '人間味が出るやつ'],
  ['真面目な顔して言う小ネタ', 'neta', 1, 'ギャップ狙い'],
];

function seedThemesIfEmpty() {
  if (readTable(SHEET.THEMES).length > 0) return;
  DEFAULT_THEMES.forEach(function (t) {
    appendRowObj(SHEET.THEMES, { theme: t[0], category: t[1], weight: t[2], last_used: '', notes: t[3] });
  });
}

/**
 * 今日のテーマを選ぶ。定番1 + (時事 or ネタ)1 の計2テーマが基本。
 * 直近3日で使ったテーマは重みを下げる。
 */
function pickThemesForToday() {
  var all = readTable(SHEET.THEMES);
  if (!all.length) throw new Error('Themesシートが空です。setupSpreadsheet() を実行してください');

  var now = nowJst();
  function effectiveWeight(t) {
    var w = Number(t.weight) || 1;
    if (t.last_used) {
      var last = new Date(t.last_used);
      var days = (now.getTime() - last.getTime()) / 86400000;
      if (days < 3) w *= 0.2;
    }
    return w;
  }

  function pickFrom(categories, exclude) {
    var pool = all.filter(function (t) {
      return categories.indexOf(String(t.category)) >= 0 &&
        (!exclude || exclude.indexOf(t.theme) < 0);
    });
    if (!pool.length) return null;
    return pickWeighted(pool, effectiveWeight);
  }

  var picked = [];
  var evergreen = pickFrom(['evergreen']);
  if (evergreen) picked.push(evergreen);
  // 時事とネタは日替わりでどちらかに寄せる（両方ある日も作る）
  var second = pickFrom(['news', 'neta'], picked.map(function (t) { return t.theme; }));
  if (second) picked.push(second);

  picked.forEach(function (t) {
    updateRowsWhere(SHEET.THEMES, 'theme', t.theme, { last_used: fmtDate(now) });
  });
  return picked.map(function (t) {
    return { theme: String(t.theme), category: String(t.category), notes: String(t.notes || '') };
  });
}
