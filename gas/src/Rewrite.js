/**
 * Rewrite.js — 未投稿ストックを最新の文体サンプルで書き直す
 *
 * Voiceシートを充実させた後などに、GASエディタから rewriteUnpostedDrafts() を
 * 実行すると、未投稿の下書き（draft / stock / ready）を本人の文体で
 * リライトし、ステータスを draft に戻して品質ゲートに再挑戦させる。
 *
 * approved / scheduled（承認・予約済み）は勝手に書き換えない。
 * それらも対象にしたい場合は rewriteUnpostedDrafts(true) を実行する。
 */

function rewriteUnpostedDrafts(includeApproved) {
  var targetStatuses = [STATUS.DRAFT, STATUS.STOCK, STATUS.READY];
  if (includeApproved) targetStatuses.push(STATUS.APPROVED, STATUS.SCHEDULED);

  var targets = readTable(SHEET.STOCK).filter(function (r) {
    return targetStatuses.indexOf(String(r.status)) >= 0 && String(r.text).trim();
  });
  if (!targets.length) return '対象がありません（未投稿の draft / stock / ready が0件）';

  // トークン上限対策で1回の実行は15件まで
  var batch = targets.slice(0, 15);

  var system = buildStylePrompt();
  var user = [
    '以下はXのポスト下書きです。内容（エピソード・主張・オチ）は変えずに、',
    '文体だけを本人のサンプルに寄せて書き直してください。',
    '',
    batch.map(function (d) {
      return 'id: ' + d.id + '\ncategory: ' + d.category + '\n本文:\n' + d.text;
    }).join('\n\n====\n\n'),
    '',
    'ルール:',
    '- 内容の追加・削除はしない。言い回しとテンポだけ本人に寄せる',
    '- すでに十分本人らしい場合は無理に変えず、そのまま返してよい',
    '- 全角換算140字（半角280字重み）以内',
    '',
    'JSON配列で出力: [{"id": "...", "text": "..."}]',
  ].join('\n');

  var results = askClaudeJson(system, user, 4000);
  if (!Array.isArray(results)) throw new Error('リライト結果の出力が不正です');

  var byId = {};
  results.forEach(function (r) { byId[String(r.id)] = r; });

  var rewritten = 0;
  batch.forEach(function (d) {
    var r = byId[String(d.id)];
    var text = r ? String(r.text || '').trim() : '';
    if (!text) return;
    if (!fitsInTweet(text)) text = truncateForTweet(text);
    // 書き直したものは再採点させる（scoreとステータスをリセット）
    updateStockById(d.id, {
      text: text,
      status: STATUS.DRAFT,
      score: '',
      score_reason: '',
      scheduled_at: '',
    });
    rewritten++;
    try { syncStockRowToNotion(d.id); } catch (e) { logEvent('notion_error', d.id + ': ' + e); }
  });

  var remaining = targets.length - batch.length;
  var msg = rewritten + '件を書き直して再採点待ち(draft)に戻しました' +
    (remaining > 0 ? '。残り' + remaining + '件はもう一度実行してください' : '') +
    '。品質ゲート（夜21時 or nightlyGateAndSchedule の手動実行）で再採点されます。';
  logEvent('rewrite', msg);
  notifySlack(':art: ' + msg);
  return msg;
}
