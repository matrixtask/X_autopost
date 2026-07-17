/**
 * Voice.js — 文体プロファイル
 *
 * Voiceシートに「自分が実際に書いたポストや文章」を貼っておくと、
 * 生成・採点の両方でfew-shotのお手本として使われる。
 * 多いほど精度が上がる。20〜50本を推奨。
 */

function getVoiceSamples(limit) {
  var rows = readTable(SHEET.VOICE)
    .map(function (r) { return String(r.text || '').trim(); })
    .filter(Boolean);
  // 直近優先ではなくランダムに混ぜて偏りを避ける
  for (var i = rows.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = rows[i]; rows[i] = rows[j]; rows[j] = tmp;
  }
  return rows.slice(0, limit || 15);
}

/**
 * 「本人の文体で書く」ための共通スタイル指示。
 * 生成プロンプトのsystemに常に含める。
 */
function buildStylePrompt() {
  var samples = getVoiceSamples(15);
  var lines = [
    'あなたは本人（中井）に代わってXのポストを書くゴーストライターです。',
    '最重要ルール: 本人が書いた以下のサンプルの文体・テンポ・語彙・句読点の癖を忠実に再現すること。',
    '',
    '禁止事項（AIっぽさの排除）:',
    '- 「〜ではないでしょうか」「いかがでしょうか」などの定型の問いかけで締めない',
    '- 「重要です」「鍵となります」「〜と言えるでしょう」などの評論調を使わない',
    '- 絵文字・記号の多用、箇条書きの乱用、「【】」での見出し付けをしない（サンプルにあれば例外）',
    '- 過度に整った起承転結にしない。本人のサンプルと同じくらいの砕け具合にする',
    '- ハッシュタグはサンプルで使われている場合のみ、同じ頻度で使う',
    '',
  ];
  if (samples.length) {
    lines.push('本人の文体サンプル:');
    samples.forEach(function (s, i) {
      lines.push('--- サンプル' + (i + 1) + ' ---');
      lines.push(s);
    });
  } else {
    lines.push('（文体サンプル未登録。自然な日本語の話し言葉寄りで、飾らない文体にすること。Voiceシートへのサンプル登録を推奨）');
  }
  return lines.join('\n');
}
