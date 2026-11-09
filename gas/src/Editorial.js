/** 本人・テトラを主役に、専門外の読者との接点を作る編集方針。 */
var EDITORIAL_FOCUS_VERSION = 'tech-news-v3';

function isRetiredTopic(text) {
  return /堀江|ホリエモン|ほりえもん|horiemon|takafumi\s*horie/i.test(String(text || '').normalize('NFKC'));
}

function editorialFocusPrompt() {
  return [
    '編集方針（過去のテーマ・メモ・成功例・人格の深掘り要求より優先）:',
    '- 最優先の成果は本人の投稿のオーガニックインプレッション。プロフィールクリック・フォロワー増は補助指標。初見で伝わる話題、本人の率直な見方、読者が続きを読みたくなる入口を重視するが、数字を伸ばすために本人の発言を捏造しない。引用元の人気を本人の投稿の成果と混同しない。',
    '- 時事ネタへの本人の感想を主軸にする。ニュースの要約ではなく中井本人の気になる点・期待・違和感・使ってみたい気持ちを残す。堀江さん・ホリエモンの過去話は再利用しない。',
    '- AI・ディープテック・テクノロジーの最近のニュースを優先。AIの進歩や実装、ロボティクス、半導体・量子計算、宇宙、電池・エネルギー・新素材、先端モビリティ、バイオ技術を横断する。芸能・映画・スポーツ・流行商品は話題性だけでは選ばない。技術の変化が主題なら娯楽分野の応用も可。専門的な題材は歓迎するが、背景を平易に説明し、技術の正否を判定する知識テスト、経営判断の基準・資源配分・代償の言語化、機密や社内事情が必要な話題は避ける。',
    '- 本人の実体験やテトラとの接点は必須にしない。自然に出た経験は歓迎するが、社名・採用・経営の教訓へ無理に結びつけない。他社ニュースへの本人のコメントも主役は本人。',
    '- 質問はニュースの何が起きたかを短い一文で補ってから、率直な感想を一つだけ聞く。知識を試さず、専門用語を避ける。当事者でない意思決定や二択を押し付けず、言い換えでもニュースの対象を変えない。短い感想も投稿の材料として扱い、理由や独自性を捏造しない。',
    '- 取材では直近3日程度の出典・日付を確認できるニュースを優先する。古いテーマ名・過去メモを最新ニュースの根拠にしない。見出し以上の数字・因果・評価は補わず、報道された内容と本人の意見を分ける。研究成果・企業発表・実証・販売開始を混同しない。',
    '- 適切なニュースがないときは創作せず、最近使ったAIや技術、試したい技術への感想へ切り替える。知らない・難しい・話せないなら追問せず次の話題へ。調べ物、賛否の強制、炎上狙いは不要。',
    '- 追問は本人が話したそうな点の理由や気になる箇所を一つだけ。抽象的な判断基準・捨てた案・代償を必須にしない。本人が自発的に話した深い内容は削らず残す。',
  ].join('\n');
}

// 事実の記述ではなく、答えが「ない」でもよい取材の入口。
var FOCUSED_THEMES = [
  ['生成AIの新しい能力への第一印象', 'AI', '確認済みの進歩を短く説明し気になる点を聞く', 'news'],
  ['AIエージェントの実装で気になること', 'AI活用', '何ができるようになったか説明し感想を聞く', 'news'],
  ['ロボットの新しい実証への期待', 'ロボティクス', '実証した範囲を説明し気になる点を一つ聞く', 'news'],
  ['半導体や量子計算の進歩への感想', '計算基盤', '何が変わるか平易に説明し第一印象を聞く', 'news'],
  ['宇宙開発の新しい動きへの感想', '宇宙', '確認済みの出来事を説明し興味を一つ聞く', 'news'],
  ['電池やエネルギー技術への期待', 'エネルギー', '研究と実用を分けて説明し気になる点を聞く', 'news'],
  ['自動運転や空の移動技術への感想', 'モビリティ', '技術の変化を説明し経営判断でなく感想を聞く', 'news'],
  ['新素材やバイオ技術で気になる進歩', 'ディープテック', '新しくできることを説明し第一印象を聞く', 'news'],
  ['最近自分で使ったAIへの感想', 'AI体験', 'ニュース不足時の入口。未使用でもよい', 'evergreen'],
  ['今試してみたいテクノロジー', '技術への興味', '知識や導入計画でなく興味を一つ聞く', 'evergreen'],
  ['技術を使って意外だったこと', '技術の体験', '経験があれば聞く。驚きや失敗を決めつけない', 'evergreen'],
  ['身近に来てほしいロボットや技術', '技術と暮らし', '専門評価を求めず期待を一つ聞く', 'evergreen'],
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
      if (r.impressions === '' || r.impressions === undefined || r.impressions === null) return null;
      m = { age_h: metricsAgeHours(r), impressions: Number(r.impressions), profile_clicks: Number(r.profile_clicks) };
    }
    if (!m || typeof m.age_h !== 'number' || m.age_h < 48 || m.age_h > 168 ||
        typeof m.impressions !== 'number' || !isFinite(m.impressions) || m.impressions < 0) return null;
    return { row: r, t: outcomeDateMs(r.posted_at), impressions: m.impressions };
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
