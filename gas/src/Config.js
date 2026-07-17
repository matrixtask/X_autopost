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
