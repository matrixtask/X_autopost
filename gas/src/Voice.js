/**
 * Voice.js — 文体プロファイル
 *
 * Voiceシートに「自分が実際に書いたポストや文章」を貼っておくと、
 * 生成・採点の両方でfew-shotのお手本として使われる。
 * 多いほど精度が上がる。20〜50本を推奨。
 */

/**
 * ポストの配列をVoiceシートへ取り込む共通処理。
 * - RT・URLだけのポスト・20字未満は文体サンプルとして薄いので除外
 * - 既存分・同一バッチ内の重複はスキップ
 * @returns {number} 追加した件数
 */
function importVoicePosts(texts, note) {
  var existing = {};
  readTable(SHEET.VOICE).forEach(function (r) {
    existing[String(r.text || '').trim()] = true;
  });
  var added = 0;
  (texts || []).forEach(function (raw) {
    var t = String(raw || '').trim();
    if (!t || existing[t]) return;
    if (/^RT @/.test(t)) return;
    var withoutUrls = t.replace(/https?:\/\/[^\s]+/g, '').trim();
    if (withoutUrls.length < 20) return;
    appendRowObj(SHEET.VOICE, { text: t, note: note || '' });
    existing[t] = true;
    added++;
  });
  logEvent('voice_import', added + '件追加（入力' + (texts || []).length + '件）');
  return added;
}

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
    'X向けの大原則（つぶやき化）:',
    '- 「質問に答えた文」ではなく「ふと思いついて、これみんなに言わなきゃと思った独り言」として書く',
    '- 冒頭の前置き・挨拶・お題の説明は書かない。1行目からいきなり本題',
    '- 説明口調（「〜なんです」「〜と思います」の連発）を避け、言い切り・体言止めでテンポを出す',
    '- 固有名詞・数字・今日の出来事を最低1つ入れる。一般論だけのポストにしない',
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
