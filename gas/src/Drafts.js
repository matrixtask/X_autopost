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
    return { qi: r.idx, answer: String(r.answer || '') +
      (r.followup_answer && String(r.followup_answered_at) !== 'skipped' ? '\n' + r.followup_answer : '') };
  });
  var brief = prepareEditorialCouncil('drafts', { answers: councilSources }, 'generate', councilSources, sessionId);
  if (brief.reflection.no_material) {
    logEvent('drafts_created', sessionId + ' -> 0件（会議で投稿の核なし）');
    return [];
  }

  // 長い回答は短文2案の枠へ押し込まず、独立した分割か一続きの長文かを編集する。
  if (councilSources.some(function (s) { return !fitsInTweet(s.answer); })) {
    return generateEditedDrafts(sessionId, qa, brief);
  }

  var system = buildStylePrompt() + editorialCouncilInstructions(brief);
  var user = [
    '以下は本人へのインタビューの記録です。回答の言葉づかいをできるだけ活かして、',
    'X（Twitter）のポスト下書きを作ってください。',
    '',
    qa.map(function (r) {
      return '[Q' + r.idx + '] 【テーマ: ' + r.theme + ' / カテゴリ: ' + r.category + '】' +
        (String(r.media_url || '') ? '（画像あり）' : '') +
        '\nQ（聞き手の質問。事実の根拠ではない）: ' + r.question + '\nA: ' + interviewAnswerText(r);
    }).join('\n\n'),
    '',
    'ルール:',
    '- 回答1つにつき0〜2案。合計は最大6案。投稿に使える本人の具体的な経験・判断・本音がない回答は0案にする。全回答が材料不足なら空配列 [] を返す',
    '- 【最重要】事実の根拠は本人の回答原文（追加回答を含む）だけ。質問や追問の前提、ニュース見出し、文体見本、聞き手の解釈を本人の経験・事実として使わない。数字・固有名詞・結果を補わない',
    '- 「わからない」「特にない」だけの回答から話を作らない。非公開・投稿しないでという意思や訂正を尊重する。短い回答でも具体があれば使える',
    '- 「Q&Aの回答」をそのまま文にしない。質問の存在を消して、自分から言い出した独り言のつぶやきに変換する',
    '- 内省で選んだanchorsのqiとquoteを使う。各案のcore_quoteにそのquoteを完全一致で入れ、本文にも同じ引用をそのまま残す。核のない別の回答から案を作らない',
    '- 驚きは回答にある判断・比喩・意外な差を残して伝える。他社にも言える教訓に置換しない。「普通は」「実は」だけで意外さを演出しない',
    '- 原文にある条件・留保・選択の代償を削らない。仕事の難しさや判断文化は原文にある場合に伝える。募集職務や裁量を創作せず、採用CTAを足さない',
    '- 全角換算140字（半角280字重み）以内。短くてもいい',
    '- カテゴリ neta はオチやゆるさを残す。無理に学びに落とさない',
    '- カテゴリ news は見出しの受け売りでなく本人の視点を軸にする',
    '',
    '- qi には、この記録に実在する回答済み質問の番号（[Q1] の数字）を必ず入れる。別の回答の事実を混ぜない',
    '',
    'JSON配列で出力: [{"qi": 1, "core_quote":"内省で選んだ回答原文の核", "theme": "...", "category": "...", "text": "..."}]',
  ].join('\n');

  // 6案しか出さないので3000で足りるが、回答が長いと前置きを書きたがることがある。
  // 途中で切れても書けた案だけは救出して先へ進める。
  var drafts = askClaudeJsonSalvageable(system, user, 4000, { purpose: 'generate' });
  if (!Array.isArray(drafts)) throw new Error('下書き生成の出力が不正です');

  // 出典をモデルに決め直させない。回答済みの qi からテーマ・カテゴリ・画像を引き継ぐ。
  var sourceByIdx = {};
  qa.forEach(function (r) {
    sourceByIdx[String(r.idx)] = r;
  });

  var saved = [];
  var retired = 0;
  drafts.forEach(function (d) {
    var text = String(d && d.text || '').trim();
    var source = d && Object.prototype.hasOwnProperty.call(sourceByIdx, String(d.qi))
      ? sourceByIdx[String(d.qi)] : null;
    if (source && isRetiredTopic(text + ' ' + source.theme)) { retired++; return; }
    if (!text || !source) {
      logEvent('draft_source_invalid', sessionId + ': 回答済みの qi または本文がありません');
      return;
    }
    var anchor = brief.reflection.anchors.some(function (a) {
      return String(a.qi) === String(d.qi) && a.quote === d.core_quote && text.indexOf(a.quote) >= 0;
    });
    if (!anchor) {
      logEvent('draft_core_missing', sessionId + ': Q' + d.qi + 'の核が本文に残っていません');
      return;
    }
    if (saved.length >= 6) return;
    if (!fitsInTweet(text)) {
      logEvent('draft_too_long', sessionId + ': Q' + d.qi + 'を棄却（留保・オチの機械切断を防止）');
      return;
    }
    var id = newId('p');
    appendRowObj(SHEET.STOCK, {
      id: id,
      created_at: fmtDateTime(nowJst()),
      theme: String(source.theme || ''),
      category: String(source.category || ''),
      session_id: sessionId,
      source_idx: String(source.idx),
      source_revision_ids: source.article_source_revision_ids,
      text: text,
      score: '',
      score_reason: '',
      status: STATUS.DRAFT,
      scheduled_at: '',
      posted_at: '',
      tweet_id: '',
      notion_page_id: '',
      media_url: String(source.media_url || ''),
      media_type: String(source.media_type || ''),
    });
    saved.push({ id: id, text: text });
    try {
      syncStockRowToNotion(id);
    } catch (e) {
      logEvent('notion_error', id + ': ' + e);
    }
  });
  // 材料不足の [] と、不正な案しか返らなかった生成失敗を分ける。
  if (drafts.length && !saved.length && retired !== drafts.length) throw new Error('回答に対応する有効な下書きがありません: ' + sessionId);
  logEvent('drafts_created', sessionId + ' -> ' + saved.length + '件');
  if (typeof tryArchiveEditorialRows === 'function') tryArchiveEditorialRows(readTable(SHEET.STOCK).filter(function (r) {
    return saved.some(function (d) { return String(d.id) === String(r.id); });
  }), 'model', 'generated');
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
