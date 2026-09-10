/** 本人・テトラを主役に、専門外の読者との接点を作る編集方針。 */
var EDITORIAL_FOCUS_VERSION = 'tetra-v1';

function isRetiredTopic(text) {
  return /堀江|ホリエモン|ほりえもん|horiemon|takafumi\s*horie/i.test(String(text || '').normalize('NFKC'));
}

function editorialFocusPrompt() {
  return [
    '編集方針（過去のテーマ・メモ・成功例より優先）:',
    '- 主役は中井本人またはテトラ（teTra）。他の有名人や他社の論評を中心にしない。堀江さん・ホリエモンの過去話は再利用しない。',
    '- 広げるのは話題の散らばりではなく読者との接点。移動に奪われる時間、お金、仕事の判断、信頼、チーム、挑戦など、専門外の人にも関係する入口から本人の経験につなぐ。',
    '- 社名を付けるだけでは接点にならない。本人が何を経験し、選び、考えたかが中身。毎回の宣伝や業界解説にしない。',
    '- 専門用語は生活の言葉へ。数字・劇的な失敗・対立を要求しない。未経験かもしれないので、質問の中で出来事や成果を断定しない。',
    '- ニュースは本人の経験に自然につながる場合だけ。接点がなければ無理に時事を使わない。',
  ].join('\n');
}

// 事実の記述ではなく、答えが「ない」でもよい取材の入口。
var FOCUSED_THEMES = [
  ['テトラが減らしたい移動の負担', '移動', '本人が見聞きした移動の困りごとを一つ聞く'],
  ['移動時間が戻ったら何に使いたいか', '移動', '本人の暮らしの実感から聞く'],
  ['空の移動を身近に感じてもらう説明', '移動', '専門外の人に何と説明しているか聞く'],
  ['テトラを必要とする人の暮らし', '移動', '想定と実際に聞いた声を区別して聞く'],
  ['テトラで速さより大切にしていること', '判断', '具体的に優先したものがあれば一つ聞く'],
  ['テトラでやらないと決める基準', '判断', '最近の判断があれば理由を一つ聞く'],
  ['テトラでお金をかける所とかけない所', '判断', '公開できる実例を一つ。金額は必須にしない'],
  ['自分の判断を変えるきっかけ', '判断', '本人が考えを変えた場面があれば聞く'],
  ['テトラで安心を確かめる仕事', 'ものづくり', '安全という言葉で省略せず何を確認するか聞く'],
  ['テトラの見えない小さな改善', 'ものづくり', '最近の変更があれば使う人への意味を聞く'],
  ['テトラでものを作る時間の使い方', 'ものづくり', '作業より待つ時間が長い場面があれば聞く'],
  ['作る側になって見方が変わったもの', 'ものづくり', '本人の日常の発見を一つ聞く'],
  ['テトラで任せる仕事と自分で見る仕事', 'チーム', '本人が引く境界を具体的に聞く'],
  ['テトラで相談しやすくする工夫', 'チーム', '実際の会話や仕組みがあれば聞く'],
  ['テトラで一緒に働きたい人', 'チーム', '応募者の個人情報ではなく行動の特徴を聞く'],
  ['テトラのチームで意見が違うとき', 'チーム', '揉めたと決めつけず決め方を聞く'],
  ['テトラを続ける自分なりの理由', '本人', 'きれいな理念より今の本音を一つ聞く'],
  ['テトラの仕事でうれしい瞬間', '本人', '最近あれば一場面だけ聞く。成果を作らない'],
  ['経営していて普通の感覚に戻る時間', '本人', '本人の日常。教訓や会社紹介に結びつけない'],
  ['昔の自分と今で変わった仕事観', '本人', '本人の変化を一つ。過去の有名人話に戻さない'],
];

/** 既存行・停止設定を保存し、新しい入口だけを一度追加する。Slack送信なし。 */
function ensureFocusedThemes() {
  ensureHeaders(SHEET.THEMES);
  var existing = {};
  readTable(SHEET.THEMES).forEach(function (t) { existing[normalizeThemeKey(t.theme)] = true; });
  var added = FOCUSED_THEMES.filter(function (t) { return !existing[normalizeThemeKey(t[0])]; })
    .map(function (t) {
      return { theme: t[0], category: 'evergreen', weight: 2, base_weight: 2,
        notes: t[2], focus_version: EDITORIAL_FOCUS_VERSION, reader_bridge: t[1],
        roster: 'core', drafted_at: fmtDate(nowJst()) };
    });
  if (added.length) appendRowsObj(SHEET.THEMES, added);
  return added.length;
}

function isFocusedTheme(t) {
  return String(t.focus_version || '') === EDITORIAL_FOCUS_VERSION &&
    !!String(t.reader_bridge || '').trim() && !isRetiredTopic(t.theme + ' ' + (t.notes || ''));
}

/** テーマ学習も成果指標を統一。未測定クリックを0扱いせず、広告と計測時期の混在を避ける。 */
function themeOutcomeSamples() {
  return readTable(SHEET.STOCK).map(function (r) {
    if (r.status !== STATUS.POSTED || r.promoted === 'yes' || !r.posted_at || !r.metrics_at ||
        !r.tweet_id || r.tweet_id === 'dry-run' || isRetiredTopic(r.text + ' ' + r.theme)) return null;
    var m;
    if (r.score_version === OUTCOME_SCORE_VERSION) {
      try { m = JSON.parse(r.outcome_metrics); } catch (e) { return null; }
    } else {
      if (r.profile_clicks === '' || r.profile_clicks === undefined || r.profile_clicks === null) return null;
      m = { age_h: metricsAgeHours(r), impressions: Number(r.impressions), profile_clicks: Number(r.profile_clicks) };
    }
    if (!m || typeof m.age_h !== 'number' || m.age_h < 48 || m.age_h > 168 ||
        !isFinite(m.impressions) || m.impressions <= 0 || !isFinite(m.profile_clicks) || m.profile_clicks < 0) return null;
    return { row: r, t: outcomeDateMs(r.posted_at), rate: 100 * m.profile_clicks / m.impressions };
  }).filter(function (x) { return x && x.t !== null; });
}

/** 投稿本文を既知の成果で選び直さない、新5軸の固定された取材指針。 */
function outcomeWritingGuidance() {
  return editorialFocusPrompt() + '\n' + [
    '伸びると証明済みの条件ではなく、これから検証する編集仮説:',
    '- 読者が自分にも関係すると分かる入口を作る。全員向けの抽象的な共感へ薄めない。',
    '- 専門外の人が、何が起きて何が違うかを初見で理解できる。',
    '- 本人の選択・工夫と理由を、回答にある範囲で残す。',
    '- 本人が何を気にしたか、どんな気持ちだったかを本人の言葉で残す。感情を脚色しない。',
    '- 読後に、この人の次の経験も読みたいと思える中身。フォロー要求、煽り、情報の出し惜しみで代用しない。',
    '5軸を毎回すべて満たそうとしない。点数を稼ぐための要素追加はしない。',
  ].join('\n');
}
