/**
 * Config.js — スクリプトプロパティと定数
 *
 * 必須プロパティ（GASエディタ > プロジェクトの設定 > スクリプト プロパティ）:
 *   SPREADSHEET_ID      データ管理用スプレッドシートのID
 *   ANTHROPIC_API_KEY   Claude APIキー
 *   SLACK_BOT_TOKEN     Slackボットトークン (xoxb-...)
 *   SLACK_CHANNEL_ID    インタビュー・通知先チャンネルID
 *   ADMIN_TOKEN         Webアプリ閲覧用の長いランダム文字列
 *
 * X投稿に必要（DRY_RUN=false にする前に設定）:
 *   X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET
 *     （X Developer PortalのOAuth 1.0a User Context、Read and Write権限）
 *
 * 任意:
 *   NOTION_TOKEN        Notionインテグレーションのシークレット
 *   NOTION_DATABASE_ID  ストック同期先NotionデータベースID
 *   NOTION_THEMES_DATABASE_ID  テーマ管理DB（トークテーマ（運用中）_X）のID。
 *                       設定するとNotionの行がThemesシートへ毎朝同期される
 *   CLAUDE_MODEL        既定: claude-sonnet-5
 *   DRY_RUN             "false" にするまでXへは投稿しない（既定: true）
 *   AUTO_APPROVE        "true" で品質ゲート通過分を承認なしで予約（既定: false）
 *   QUALITY_THRESHOLD   品質ゲートの合格点 0-100（既定: 75）
 *   SLOT_TIMES          予約枠 "08:00,12:30,19:30"（既定）
 *   MAX_POSTS_PER_DAY   1日の最大投稿数（既定: 3）
 *   INTERVIEW_QUESTIONS 1回のインタビューの質問数（既定: 4）
 */

var SHEET = {
  STOCK: 'Stock',
  INTERVIEWS: 'Interviews',
  THEMES: 'Themes',
  VOICE: 'Voice',
  LOG: 'Log',
  MEMORY: 'Memory',
  FOLLOWERS: 'Followers',
};

var STATUS = {
  DRAFT: 'draft', // 生成直後・未採点
  STOCK: 'stock', // 採点済みだが閾値未満。ストックとして保持
  READY: 'ready', // 品質ゲート通過。承認待ち
  APPROVED: 'approved', // 承認済み。予約待ち
  SCHEDULED: 'scheduled', // 予約済み
  POSTED: 'posted',
  REJECTED: 'rejected',
  FAILED: 'failed',
};

function props() {
  return PropertiesService.getScriptProperties().getProperties();
}

function getProp(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null || v === '' ? (fallback === undefined ? null : fallback) : v;
}

function requireProp(key) {
  var v = getProp(key);
  if (!v) throw new Error('スクリプトプロパティ ' + key + ' が未設定です');
  return v;
}

function isDryRun() {
  return String(getProp('DRY_RUN', 'true')).toLowerCase() !== 'false';
}

function isAutoApprove() {
  return String(getProp('AUTO_APPROVE', 'false')).toLowerCase() === 'true';
}

function qualityThreshold() {
  return Number(getProp('QUALITY_THRESHOLD', '75'));
}

function slotTimes() {
  return String(getProp('SLOT_TIMES', '08:00,12:30,19:30'))
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

/**
 * 採点の軸。各軸は独立して0〜100で採点し、合成スコアはコード側で
 * 重み付き平均して算出する（重みを学習で更新できるようにするため）。
 */
var AXES = [
  // 語り手としての特徴
  { key: 'voice', label: '本人らしさ', desc: '文体サンプルと同じ人が書いたように読めるか。AIっぽい定型・評論調は大減点' },
  { key: 'emotion', label: '感情の温度', desc: '本音・熱・悔しさ・可笑しさが出ているか。優等生的な平熱は低得点' },
  { key: 'humor', label: 'ユーモア', desc: '笑える・ニヤッとする要素があるか。自虐やズレの面白さを含む' },
  { key: 'stance', label: '立場の明確さ', desc: '言い切っているか。両論併記・保留・玉虫色は低得点' },
  // 情報としての強度
  { key: 'concrete', label: '具体性', desc: '固有名詞・その日の出来事・実際の場面があるか。一般論だけなら低得点' },
  { key: 'numbers', label: '数字の強度', desc: '意味のある数字・規模・比較があるか。飾りの数字は低得点' },
  { key: 'expertise', label: '専門性', desc: 'この人にしか書けない知識・当事者性があるか' },
  { key: 'insider', label: '内部情報性', desc: '普段見えない舞台裏・意思決定の内側が見えるか' },
  { key: 'novelty', label: '新規情報性', desc: '読んだ人が知らなかったことを含むか。既知の再確認は低得点' },
  { key: 'surprise', label: '意外性', desc: '通説と違う、逆張り、聞いて驚くか。予定調和は低得点' },
  // 読ませる力
  { key: 'hook', label: '冒頭の引き', desc: '1行目で指が止まるか' },
  { key: 'story', label: '物語性', desc: '場面が立ち上がるか。起伏や落差があるか' },
  { key: 'brevity', label: '簡潔さ', desc: '無駄がないか。説明が長い・回りくどいは低得点' },
  { key: 'visual', label: '情景の喚起', desc: '読むと絵が浮かぶか。抽象語だけなら低得点' },
  // 反応の引き出し
  { key: 'discussion', label: '議論喚起', desc: '返信・引用したくなるか。反論の余地や問いがあるか' },
  { key: 'relatability', label: '共感性', desc: '誰にでも当てはまる「わかる」度。※高いほど良いとは限らない軸' },
  { key: 'profile', label: 'プロフィール誘引', desc: '読んだ人が「この人は何者だ」とプロフィールを見に行きたくなるか' },
];

/**
 * データが無い間の既定の相関ベクトル（＝重み）。合計1.0の正値。
 * 実測がたまると analyzeAxes() が AXIS_CORRELATIONS を更新し、そちらが使われる。
 */
var DEFAULT_AXIS_WEIGHTS = {
  voice: 0.09, emotion: 0.04, humor: 0.03, stance: 0.05,
  concrete: 0.09, numbers: 0.04, expertise: 0.10, insider: 0.07,
  novelty: 0.06, surprise: 0.06, hook: 0.07, story: 0.04,
  brevity: 0.04, visual: 0.03, discussion: 0.05, relatability: 0.02,
  profile: 0.12,
};

/**
 * 相関がいくら負に出ても、重みをこの値より下げない軸。
 *
 * 「本人らしさ」は成果指標ではなく制約条件。本人の文体で書くことは
 * この仕組みの前提であって、フォロワーが増えないなら捨てる、という
 * 性質のものではない。加えて、標本の大半が取り込んだ過去の手動投稿
 * （＝定義上いちばん本人らしく、かつ雑談が多い）なので、この軸は
 * 「本人らしさ」ではなく「昔の雑な呟きかどうか」を測っている疑いがある。
 * analyzeAxesByOrigin() でその交絡を検証できる。
 *
 * 下限をかけても分析レポートには生の相関がそのまま出るので、
 * 「データはこう出ているが、重みは下限で止めている」ことは隠れない。
 */
var DEFAULT_AXIS_FLOORS = { voice: 0.05 };

/**
 * カテゴリごとに「その型を成立させるために外せない軸」。
 *
 * 相関は全カテゴリを混ぜて出しているので、ネタと真面目が打ち消し合う。
 * その平均でネタを採点すると、ユーモアを削るほど点が上がってしまい、
 * ネタでも真面目でもない中途半端な文になる。
 * カテゴリの定義そのものにあたる軸は、成果指標ではなく制約として扱う。
 */
var DEFAULT_CATEGORY_FLOORS = {
  neta: { humor: 0.18, brevity: 0.08 },      // 笑えないネタはネタではない
  news: { novelty: 0.10, expertise: 0.05 },  // 既知の受け売りなら出す意味がない
  evergreen: { insider: 0.08 },              // 当事者にしか書けない部分を残す
};

function axisFloors(category) {
  var base;
  var raw = getProp('AXIS_FLOORS', '');
  if (!raw) {
    base = DEFAULT_AXIS_FLOORS;
  } else {
    try {
      base = JSON.parse(raw);
    } catch (e) {
      logEvent('axis_floors_parse_error', String(e));
      base = DEFAULT_AXIS_FLOORS;
    }
  }

  var byCat = DEFAULT_CATEGORY_FLOORS;
  var rawCat = getProp('CATEGORY_FLOORS', '');
  if (rawCat) {
    try {
      byCat = JSON.parse(rawCat);
    } catch (e2) {
      logEvent('category_floors_parse_error', String(e2));
    }
  }

  var out = {};
  Object.keys(base).forEach(function (k) { out[k] = base[k]; });
  var extra = byCat[String(category || '')] || {};
  Object.keys(extra).forEach(function (k) {
    if (out[k] === undefined || Number(extra[k]) > Number(out[k])) out[k] = extra[k];
  });
  return out;
}

/** スクリプトプロパティに入った {key: {c, n}} を読む。壊れていたら null */
function parseCorrStore(key) {
  var raw = getProp(key, '');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    logEvent('correlations_parse_error', key + ': ' + String(e));
    return null;
  }
}

/**
 * 各軸の「成果指標との相関係数」ベクトル。全体スコアはこれとの内積で決まる。
 *
 * 2つのモデルを足し合わせる:
 *   AXIS_CORRELATIONS       フォローモデル。プロフィールクリック率との相関。
 *                           KGI(フォロワー増)に近いが、X APIの制約で直近30日分しか取れない
 *   AXIS_CORRELATIONS_REACH リーチモデル。窓内インプレッション順位との相関。
 *                           過去3,200件まで遡れるので標本が桁違いに多い
 *
 * フォロワー増 = インプレッション × プロフィールクリック率 × フォロー率 なので、
 * リーチもフォローも両方がKGIの構成要素。よって片方への切り替えではなく加算する。
 * ただしリーチはKGIの代理指標にすぎないので REACH_MODEL_WEIGHT（既定0.5）で割り引く。
 *
 * どちらも {key: {c: 相関係数, n: 標本数}} 形式。標本が少ない相関は信用できないので
 * n/(n+K) で0へ縮小する（K=SHRINKAGE_K、既定10）。データが無い軸は既定重みで代替する。
 */
function axisCorrelations(category) {
  var K = Number(getProp('SHRINKAGE_K', '10'));
  var reachW = Number(getProp('REACH_MODEL_WEIGHT', '0.5'));
  var follow = parseCorrStore('AXIS_CORRELATIONS');
  var reach = parseCorrStore('AXIS_CORRELATIONS_REACH');
  var out = {};

  function shrunk(store, key) {
    var rec = store ? store[key] : null;
    if (!rec || !isFinite(Number(rec.c))) return null;
    var n = Number(rec.n) || 0;
    return Number(rec.c) * (n / (n + K)); // 標本数による縮小
  }

  var any = false;
  AXES.forEach(function (a) {
    var f = shrunk(follow, a.key);
    var r = shrunk(reach, a.key);
    if (f === null && r === null) {
      out[a.key] = null; // 未学習
      return;
    }
    out[a.key] = (f || 0) + (r || 0) * reachW;
    any = true;
  });
  if (!any) return DEFAULT_AXIS_WEIGHTS;
  // 未学習の軸は既定重みで埋める（学習済みの軸と桁を合わせるため縮尺を合わせる）
  var learned = [];
  AXES.forEach(function (a) { if (out[a.key] !== null) learned.push(Math.abs(out[a.key])); });
  var scale = learned.length ? learned.reduce(function (s, v) { return s + v; }, 0) / learned.length : 0.1;
  AXES.forEach(function (a) {
    if (out[a.key] === null) out[a.key] = (DEFAULT_AXIS_WEIGHTS[a.key] || 0.05) * scale * 5;
  });
  // 制約条件の軸は下限で止める（負の相関が出ても減点にしない）。
  // カテゴリを渡すと、その型に必須の軸も下限が効く
  var floors = axisFloors(category);
  Object.keys(floors).forEach(function (key) {
    if (out[key] !== undefined && out[key] < Number(floors[key])) out[key] = Number(floors[key]);
  });
  return out;
}

/**
 * 全体スコア = 軸スコアベクトル · 相関ベクトル を 0〜100 に正規化したもの。
 *
 * 相関が負の軸は「高いほど成果が下がる」ので、内積の中で自然に減点として働く。
 * 取りうる範囲は
 *   最小 = 正相関の軸すべて0点 かつ 負相関の軸すべて100点 → 100 * Σ(負の相関)
 *   最大 = 正相関の軸すべて100点 かつ 負相関の軸すべて0点 → 100 * Σ(正の相関)
 * なので、この区間を0〜100へ線形写像する。
 */
function compositeScoreFromAxes(axes, category) {
  var c = axisCorrelations(category);
  var raw = 0, pos = 0, neg = 0;
  AXES.forEach(function (a) {
    var w = Number(c[a.key]) || 0;
    var v = Number(axes[a.key]);
    raw += (isFinite(v) ? v : 50) * w;
    if (w > 0) pos += w; else neg += w;
  });
  var min = 100 * neg;
  var max = 100 * pos;
  if (max - min <= 0) return 50;
  return Math.max(0, Math.min(100, Math.round(100 * (raw - min) / (max - min))));
}

function nowJst() {
  return new Date();
}

function fmtDate(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function fmtDateTime(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
}

function newId(prefix) {
  return prefix + '_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMddHHmmss') + '_' + Math.floor(Math.random() * 10000);
}
