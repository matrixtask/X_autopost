/**
 * Drafts.js — インタビュー回答から本人の文体でポスト下書きを生成し、ストックに積む
 */

function generateDraftsFromInterview(sessionId) {
  ensureHeaders(SHEET.STOCK);
  var qa = readTable(SHEET.INTERVIEWS).filter(function (r) {
    return String(r.session_id) === sessionId && String(r.answered_at) !== 'skipped' && interviewAnswerText(r);
  });
  if (!qa.length) throw new Error('回答がありません: ' + sessionId);
  // 一次資料はモデル呼び出し前に版を固定。保存失敗時は出典IDを推測して付けない。
  var sourceRefs = typeof tryArchiveInterviewSources === 'function' ? tryArchiveInterviewSources(qa, 'generation_input') : {};
  qa.forEach(function (r) { r.article_source_revision_ids = JSON.stringify(sourceRefs[sessionId + ':Q' + r.idx] || []); });

  var councilSources = qa.map(function (r) {
    return { qi: r.idx, question: String(r.question || ''),
      followup_question: r.followup_answer && r.followup_answered_at !== 'skipped' ? String(r.followup_question || '') : '', answer: String(r.answer || '') +
      (r.followup_answer && String(r.followup_answered_at) !== 'skipped' ? '\n' + r.followup_answer : '') };
  });
  var brief = prepareEditorialCouncil('drafts', { answers: councilSources }, 'generate', councilSources, sessionId);
  if (brief.reflection.no_material) {
    logEvent('drafts_created', sessionId + ' -> 0件（会議で投稿の核なし）');
    return [];
  }

  // 短答も質問の文脈補完・複数回答の統合を検討してから掲載形式を決める。
  return generateEditedDrafts(sessionId, qa, brief);
}

/** 280重みを超えた本文を文末から削って収める */
function truncateForTweet(text) {
  var t = String(text);
  while (t.length > 1 && !fitsInTweet(t)) {
    t = t.slice(0, -1);
  }
  return t.replace(/[、。,.\s]+$/, '');
}
