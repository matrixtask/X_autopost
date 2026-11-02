/** 本人・テトラを主役に、専門外の読者との接点を作る編集方針。 */
var EDITORIAL_FOCUS_VERSION = 'news-comment-v2';

function isRetiredTopic(text) {
  return /堀江|ホリエモン|ほりえもん|horiemon|takafumi\s*horie/i.test(String(text || '').normalize('NFKC'));
}

function editorialFocusPrompt() {
  return [
    '編集方針（過去のテーマ・メモ・成功例・人格の深掘り要求より優先）:',
    '- 時事ネタへの本人の感想を主軸にする。ニュースの要約ではなく中井本人の気になる点・期待・違和感・使ってみたい気持ちを残す。堀江さん・ホリエモンの過去話は再利用しない。',
    '- AIの新機能、身近な商品・サービス、移動・旅行、働き方、暮らしや趣味など、一文の説明でコメントできる最近のニュースを優先。専門的な技術評価、経営判断の基準・資源配分・代償の言語化、機密や社内事情が必要な話題は避ける。',
    '- 本人の実体験やテトラとの接点は必須にしない。自然に出た経験は歓迎するが、社名・採用・経営の教訓へ無理に結びつけない。他社ニュースへの本人のコメントも主役は本人。',
    '- 質問はニュースの何が起きたかを短い一文で補ってから、率直な感想を一つだけ聞く。知識を試さず、専門用語を避ける。当事者でない意思決定や二択を押し付けず、言い換えでもニュースの対象を変えない。短い感想も投稿の材料として扱い、理由や独自性を捏造しない。',
    '- 取材では直近3日程度の出典・日付を確認できるニュースを優先する。古いテーマ名・過去メモを最新ニュースの根拠にしない。見出し以上の数字・因果・評価は補わず、報道された内容と本人の意見を分ける。',
    '- 適切なニュースがないときは創作せず、最近気になった話題や身近な出来事へ切り替える。知らない・難しい・話せないなら追問せず次の話題へ。調べ物、賛否の強制、炎上狙いは不要。',
    '- 追問は本人が話したそうな点の理由や気になる箇所を一つだけ。抽象的な判断基準・捨てた案・代償を必須にしない。本人が自発的に話した深い内容は削らず残す。',
  ].join('\n');
}

// 事実の記述ではなく、答えが「ない」でもよい取材の入口。
var FOCUSED_THEMES = [
  ['最近のAI新機能で気になること', 'AI', '新機能を一文で紹介し本人の気になる点を聞く', 'news'],
  ['話題の新商品を自分なら使いたいか', '買い物', '使いたい場面や引っかかる点を一つ聞く', 'news'],
  ['最近の移動サービスへの感想', '移動', '便利そうな点を生活者として聞く', 'news'],
  ['旅行のニュースで気になったこと', '旅行', '行ってみたい気持ちや気になる点を聞く', 'news'],
  ['身近なロボットのニュースへの感想', '暮らし', '日常で使うなら気になる点を一つ聞く', 'news'],
  ['働き方のニュースへの率直な感想', '仕事', '社内制度や経営判断ではなく本人の感想を聞く', 'news'],
  ['話題の映画やゲームで気になるもの', '趣味', '知識を試さず楽しそうな点を聞く', 'news'],
  ['街の新サービスへの第一印象', '街', '何が変わるかを説明して本人の感想を聞く', 'news'],
  ['最近使って便利だったもの', '道具', 'ニュースがない日の入口。身近な感想でよい', 'evergreen'],
  ['この頃ちょっと楽しかったこと', '日常', '教訓や採用につなげず本人の言葉を聞く', 'evergreen'],
  ['最近の移動中に気になったもの', '外出', '専門評価を求めず気づいたことを一つ聞く', 'evergreen'],
  ['今ちょっと試してみたいこと', '楽しみ', '成果や計画を求めず興味を一つ聞く', 'evergreen'],
];

/** 既存行・停止設定を保存し、新しい入口だけを一度追加する。Slack送信なし。 */
function ensureFocusedThemes() {
  ensureHeaders(SHEET.THEMES);
  var existing = {};
  readTable(SHEET.THEMES).forEach(function (t) { existing[normalizeThemeKey(t.theme)] = true; });
  var added = FOCUSED_THEMES.filter(function (t) { return !existing[normalizeThemeKey(t[0])]; })
    .map(function (t) {
      return { theme: t[0], category: t[3], weight: 2, base_weight: 2,
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
