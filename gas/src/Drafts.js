/**
 * Drafts.js — インタビュー回答から本人の文体でポスト下書きを生成し、ストックに積む
 */

function generateDraftsFromInterview(sessionId) {
  var qa = readTable(SHEET.INTERVIEWS).filter(function (r) {
    return String(r.session_id) === sessionId && String(r.answer).trim();
  });
  if (!qa.length) throw new Error('回答がありません: ' + sessionId);

  var system = buildStylePrompt();
  var user = [
    '以下は本人へのインタビューの記録です。回答の言葉づかいをできるだけ活かして、',
    'X（Twitter）のポスト下書きを作ってください。',
    '',
    qa.map(function (r) {
      return '【テーマ: ' + r.theme + ' / カテゴリ: ' + r.category + '】\nQ: ' + r.question + '\nA: ' + r.answer;
    }).join('\n\n'),
    '',
    'ルール:',
    '- 回答1つにつき1〜2案。合計は最大6案',
    '- 「Q&Aの回答」をそのまま文にしない。質問の存在を消して、自分から言い出した独り言のつぶやきに変換する',
    '- 本人の回答にある具体的な言い回しを優先して残す（要約しすぎない）',
    '- 全角換算140字（半角280字重み）以内。短くてもいい',
    '- カテゴリ neta はオチやゆるさを残す。無理に学びに落とさない',
    '- カテゴリ news は見出しの受け売りでなく本人の視点を軸にする',
    '',
    'JSON配列で出力: [{"theme": "...", "category": "...", "text": "..."}]',
  ].join('\n');

  // 6案しか出さないので3000で足りるが、回答が長いと前置きを書きたがることがある。
  // 途中で切れても書けた案だけは救出して先へ進める。
  var drafts = askClaudeJsonSalvageable(system, user, 4000);
  if (!Array.isArray(drafts)) throw new Error('下書き生成の出力が不正です');

  var saved = [];
  drafts.forEach(function (d) {
    var text = String(d.text || '').trim();
    if (!text) return;
    if (!fitsInTweet(text)) {
      text = truncateForTweet(text);
    }
    var id = newId('p');
    appendRowObj(SHEET.STOCK, {
      id: id,
      created_at: fmtDateTime(nowJst()),
      theme: String(d.theme || ''),
      category: String(d.category || ''),
      session_id: sessionId,
      text: text,
      score: '',
      score_reason: '',
      status: STATUS.DRAFT,
      scheduled_at: '',
      posted_at: '',
      tweet_id: '',
      notion_page_id: '',
    });
    saved.push({ id: id, text: text });
    try {
      syncStockRowToNotion(id);
    } catch (e) {
      logEvent('notion_error', id + ': ' + e);
    }
  });
  logEvent('drafts_created', sessionId + ' -> ' + saved.length + '件');
  return saved;
}

/** 280重みを超えた本文を文末から削って収める */
function truncateForTweet(text) {
  var t = String(text);
  while (t.length > 1 && !fitsInTweet(t)) {
    t = t.slice(0, -1);
  }
  return t.replace(/[、。,.\s]+$/, '');
}
