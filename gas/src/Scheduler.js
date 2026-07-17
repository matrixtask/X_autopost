/**
 * Scheduler.js — 承認済みポストを予約枠に割り当てる
 */

function scheduleApprovedPosts() {
  var stock = readTable(SHEET.STOCK);
  var approved = stock
    .filter(function (r) { return String(r.status) === STATUS.APPROVED; })
    .sort(function (a, b) {
      // スコアが高い順に良い枠（早い枠）を割り当てる
      return Number(b.score || 0) - Number(a.score || 0);
    });
  if (!approved.length) return [];

  var taken = stock
    .filter(function (r) { return String(r.status) === STATUS.SCHEDULED && r.scheduled_at; })
    .map(function (r) { return String(r.scheduled_at); });

  var slots = computeNextSlots(approved.length, {
    now: nowJst(),
    slotTimes: slotTimes(),
    taken: taken,
    daysAhead: 21,
    minLeadMinutes: 60,
    maxPerDay: Number(getProp('MAX_POSTS_PER_DAY', '3')),
  });

  var scheduled = [];
  approved.forEach(function (post, i) {
    if (i >= slots.length) return; // 枠が足りなければ approved のまま次回に回す
    updateStockById(post.id, { status: STATUS.SCHEDULED, scheduled_at: slots[i] });
    scheduled.push({ id: post.id, text: String(post.text), scheduled_at: slots[i] });
    try {
      syncStockRowToNotion(post.id);
    } catch (e) {
      logEvent('notion_error', post.id + ': ' + e);
    }
  });
  if (scheduled.length) logEvent('scheduled', scheduled.length + '件を予約');
  return scheduled;
}
