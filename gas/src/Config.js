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
  { key: 'voice', label: '本人らしさ', desc: '文体サンプルと同じ人が書いたように読めるか。AIっぽい定型・評論調は大減点' },
  { key: 'concrete', label: '具体性', desc: '固有名詞・数字・その日の出来事があるか。一般論だけなら低得点' },
  { key: 'expertise', label: '専門性', desc: 'この人にしか書けない知識・現場・当事者性があるか' },
  { key: 'hook', label: '引き', desc: '1行目で止まるか。続きを読みたくなるか' },
  { key: 'emotion', label: '感情の温度', desc: '本音・熱・悔しさ・可笑しさが出ているか。優等生的な平熱は低得点' },
  { key: 'surprise', label: '意外性', desc: '通説と違う、知らなかった、と思わせるか。予定調和は低得点' },
  { key: 'discussion', label: '議論喚起', desc: '返信・引用したくなるか。反論の余地や問いがあるか' },
  { key: 'profile', label: 'プロフィール誘引', desc: '読んだ人が「この人は何者だ」とプロフィールを見に行きたくなるか' },
];

/** 既定の重み（合計1.0）。学習後は QUALITY_WEIGHTS に保存される */
var DEFAULT_AXIS_WEIGHTS = {
  voice: 0.15, concrete: 0.15, expertise: 0.15, hook: 0.10,
  emotion: 0.05, surprise: 0.08, discussion: 0.07, profile: 0.25,
};

function axisWeights() {
  var raw = getProp('QUALITY_WEIGHTS', '');
  if (raw) {
    try {
      var w = JSON.parse(raw);
      var sum = 0;
      AXES.forEach(function (a) { sum += Number(w[a.key]) || 0; });
      if (sum > 0) {
        var norm = {};
        AXES.forEach(function (a) { norm[a.key] = (Number(w[a.key]) || 0) / sum; });
        return norm;
      }
    } catch (e) {
      logEvent('weights_parse_error', String(e));
    }
  }
  return DEFAULT_AXIS_WEIGHTS;
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
