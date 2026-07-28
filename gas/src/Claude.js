/**
 * Claude.js — Claude API クライアント
 */

function askClaude(systemPrompt, userPrompt, maxTokens) {
  var apiKey = requireProp('ANTHROPIC_API_KEY');
  var model = getProp('CLAUDE_MODEL', 'claude-sonnet-5');
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: model,
      max_tokens: maxTokens || 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code >= 300) {
    logEvent('claude_error', code + ': ' + body.slice(0, 500));
    throw new Error('Claude API error ' + code + ': ' + body.slice(0, 200));
  }
  var json = JSON.parse(body);
  var blocks = json.content || [];
  var text = blocks
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n');

  // 空応答をそのまま返すと呼び出し側では「JSONパースに失敗（中身なし）」としか
  // 分からず原因が追えない。何が起きたかを記録してから落とす。
  if (!text.trim()) {
    var detail = 'stop_reason=' + json.stop_reason +
      ' blocks=' + (blocks.length ? blocks.map(function (b) { return b.type; }).join(',') : 'なし') +
      ' usage=' + JSON.stringify(json.usage || {}) +
      ' max_tokens=' + (maxTokens || 2000);
    logEvent('claude_empty', detail);
    throw new Error('Claudeが空の応答を返しました: ' + detail);
  }
  if (json.stop_reason === 'max_tokens') {
    logEvent('claude_truncated', 'max_tokens=' + (maxTokens || 2000) + 'で打ち切られました。usage=' + JSON.stringify(json.usage || {}));
  }
  return text;
}

/** JSONを返させる呼び出し。パース失敗時は1回だけリトライ */
function askClaudeJson(systemPrompt, userPrompt, maxTokens) {
  for (var attempt = 0; attempt < 2; attempt++) {
    var text = askClaude(systemPrompt, userPrompt + '\n\n出力はJSONのみ。前置きや説明は書かない。', maxTokens);
    try {
      return parseJsonLoose(text);
    } catch (e) {
      if (attempt === 1) throw new Error('ClaudeのJSONパースに失敗（応答' + text.length + '文字）: ' + text.slice(0, 300));
    }
  }
}

/**
 * 一括採点のように「一部だけでも取れれば前に進める」呼び出し用。
 * max_tokensで応答が切れた場合、完成している要素だけを救出して返す。
 * 救出もできなければ askClaudeJson と同じくエラーを投げる。
 */
function askClaudeJsonSalvageable(systemPrompt, userPrompt, maxTokens) {
  var lastErr = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    var text;
    try {
      text = askClaude(systemPrompt, userPrompt + '\n\n出力はJSONのみ。前置きや説明は書かない。', maxTokens);
    } catch (e) {
      lastErr = e; // 空応答・APIエラー。もう一度だけ投げ直す
      continue;
    }
    var partial = salvageJson(text); // 切れていなければ全部返る
    if (partial) {
      var full = null;
      try { full = parseJsonLoose(text); } catch (e2) { /* 部分救出だった */ }
      if (!full) logEvent('claude_json_salvaged', '応答が途中で切れたため一部のみ採用: ' + text.length + '文字');
      return partial;
    }
    lastErr = new Error('ClaudeのJSONパースに失敗（応答' + text.length + '文字）: ' + text.slice(0, 300));
  }
  throw lastErr;
}
