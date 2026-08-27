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
/**
 * 実測で効いている軸を、書き手への指示に変換する。
 *
 * 採点は軸スコアと実測相関の内積で決まるのに、生成プロンプトはその軸を
 * 一度も見ていなかった。何で評価されるかを知らずに書いていたことになる。
 * 質問生成側（axisGuidanceForQuestions）と同じ考え方を書き手にも渡す。
 */
function axisGuidanceForWriting(category) {
  var b = axisWeightBreakdown(category);
  var c = b.weights;
  var ranked = AXES.map(function (a) {
    return { key: a.key, label: a.label, desc: a.desc, w: Number(c[a.key]) || 0 };
  }).sort(function (x, y) { return y.w - x.w; });

  var top = ranked.slice(0, 5).filter(function (x) { return x.w > 0; });
  var bottom = ranked.slice(-3).filter(function (x) { return x.w < 0; });
  if (!top.length) return '';

  // 重みの出どころで書き方を変える。実測で裏が取れていないのに
  // 「実測で効いている」と書くと、根拠のない指示を強い口調で押し付けることになる
  var proven = {};
  b.significant.forEach(function (k) { proven[k] = true; });
  var lines = [b.significant.length
    ? '採点で重く見る軸（★は実測で効き目が確認できたもの。他はまだ想定）:'
    : '採点で重く見る軸（いずれもまだ実測の裏付けはなく、想定にもとづく重みです）:'];
  top.forEach(function (x) {
    lines.push('- ' + (proven[x.key] ? '★' : '') + x.label + ': ' + x.desc);
  });
  if (bottom.length) {
    lines.push('');
    lines.push('逆に、この軸に寄せたポストは成果が下がっている。ここを狙わない:');
    bottom.forEach(function (x) { lines.push('- ' + x.label + ': ' + x.desc); });
  }
  lines.push('');
  lines.push('合格ラインは' + qualityThreshold() + '点。上の軸で平凡なら落ちる。');
  return lines.join('\n');
}

function buildStylePrompt(category) {
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
    '- 「本人にしか書けないこと」を必ず含める。空飛ぶクルマ開発の現場、航空認証、地方での事業づくり、',
    '  経営判断など、読んだ人が「この人は何者だ」と思う要素。誰が書いても成立する共感ネタで終わらせない',
    '',
    '禁止事項（AIっぽさの排除）:',
    '- 「〜ではないでしょうか」「いかがでしょうか」などの定型の問いかけで締めない',
    '- 「重要です」「鍵となります」「〜と言えるでしょう」などの評論調を使わない',
    '- 絵文字・記号の多用、箇条書きの乱用、「【】」での見出し付けをしない（サンプルにあれば例外）',
    '- 過度に整った起承転結にしない。本人のサンプルと同じくらいの砕け具合にする',
    '- ハッシュタグはサンプルで使われている場合のみ、同じ頻度で使う',
    '',
    'カテゴリごとに振り切る（いちばん大事）:',
    '- **1つのポストの中でネタと真面目を混ぜない。** 笑わせにいった話を最後に学びへ',
    '  着地させたり、真面目な話に受け狙いの一文を挟んだりすると、どちらでもなくなる',
    '- neta（ネタ）: 笑わせにいく。オチで終える。教訓・学び・まとめに落とさない。短く切る',
    '- news（時事）: 出来事に対する自分の立場を言い切る。解説で終えない。受け売りにしない',
    '- evergreen（定番）: 舞台裏・意思決定の内側・数字で押す。ウケ狙いを混ぜない',
    '',
  ];
  // 採点は実測相関の内積で行うのに、書き手がその軸を見ていなかった。
  // 何で評価されるかを知らずに書けば、落ちるのは当然だった
  var axisGuide = axisGuidanceForWriting(category);
  if (axisGuide) {
    lines.push(axisGuide);
    lines.push('');
  }

  // 文体サンプルは「らしさ」の見本だが、伸びたかどうかとは無関係。
  // 実測で反応が良かったポストを別枠で見せて、水準そのものを示す
  var winners = [];
  try {
    winners = topPostSamples(6);
  } catch (e) { /* 実測が無い時期は無視 */ }
  if (winners.length) {
    lines.push('実測で反応が良かった自分のポスト（内容ではなく、踏み込みの深さと具体の量をこの水準に合わせる）:');
    winners.forEach(function (w) { lines.push('- ' + w); });
    lines.push('');
  }

  var memory = buildMemoryPrompt();
  if (memory) {
    lines.push(memory);
    lines.push('');
  }
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
