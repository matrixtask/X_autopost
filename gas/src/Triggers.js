/**
 * Triggers.js — 定期実行の登録（ルーティン化の心臓部）
 *
 * installTriggers() をGASエディタから1回実行すると:
 *   毎朝 8時台   startDailyInterview  … Slackにインタビューが届く（これが毎日のルーティン）
 *   毎晩 21時台  nightlyGateAndSchedule … 採点 → 予約 → Slack通知
 *   毎時        postTick             … 予約時刻を過ぎたものを投稿
 *   毎週月 9時台 weeklyDigest         … ストック残量と先週の実績を通知
 */

var TRIGGER_FUNCS = ['startDailyInterview', 'nightlyGateAndSchedule', 'postTick', 'weeklyDigest'];

function installTriggers() {
  deleteManagedTriggers();
  ScriptApp.newTrigger('startDailyInterview').timeBased().atHour(8).everyDays(1).create();
  ScriptApp.newTrigger('nightlyGateAndSchedule').timeBased().atHour(21).everyDays(1).create();
  ScriptApp.newTrigger('postTick').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('weeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create();
  logEvent('triggers', 'トリガーを登録しました');
  return 'OK';
}

function deleteManagedTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_FUNCS.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/** 毎週月曜: ストックの健康状態をSlackに */
function weeklyDigest() {
  var stock = readTable(SHEET.STOCK);
  var counts = {};
  stock.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });

  var weekAgo = fmtDateTime(new Date(nowJst().getTime() - 7 * 86400000));
  var postedThisWeek = stock.filter(function (r) {
    return String(r.status) === STATUS.POSTED && String(r.posted_at) >= weekAgo;
  });

  var scheduledCount = counts[STATUS.SCHEDULED] || 0;
  var lines = [
    ':bar_chart: 週次サマリー',
    '先週の投稿: ' + postedThisWeek.length + '件',
    '予約済み: ' + scheduledCount + '件 / 承認待ち: ' + (counts[STATUS.READY] || 0) + '件 / 保留ストック: ' + (counts[STATUS.STOCK] || 0) + '件',
  ];
  var maxPerDay = Number(getProp('MAX_POSTS_PER_DAY', '3'));
  var daysCovered = maxPerDay > 0 ? Math.floor(scheduledCount / maxPerDay) : 0;
  lines.push('予約の持ち日数: 約' + daysCovered + '日分');
  if (daysCovered < 2) {
    lines.push(':warning: 弾切れが近いです。今朝のインタビューに答えるか、Voiceシートにネタをメモしてください。');
  }
  notifySlack(lines.join('\n'));
}
