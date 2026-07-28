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
  return json.content
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n');
}

/** JSONを返させる呼び出し。パース失敗時は1回だけリトライ */
function askClaudeJson(systemPrompt, userPrompt, maxTokens) {
  for (var attempt = 0; attempt < 2; attempt++) {
    var text = askClaude(systemPrompt, userPrompt + '\n\n出力はJSONのみ。前置きや説明は書かない。', maxTokens);
    try {
      return parseJsonLoose(text);
    } catch (e) {
      if (attempt === 1) throw new Error('ClaudeのJSONパースに失敗: ' + text.slice(0, 300));
    }
  }
}

/**
 * 一括採点のように「一部だけでも取れれば前に進める」呼び出し用。
 * max_tokensで応答が切れた場合、完成している要素だけを救出して返す。
 * 救出もできなければ askClaudeJson と同じくエラーを投げる。
 */
function askClaudeJsonSalvageable(systemPrompt, userPrompt, maxTokens) {
  var text = askClaude(systemPrompt, userPrompt + '\n\n出力はJSONのみ。前置きや説明は書かない。', maxTokens);
  try {
    return parseJsonLoose(text);
  } catch (e) {
    var partial = salvageJson(text);
    if (partial) {
      logEvent('claude_json_salvaged', '応答が途中で切れたため一部のみ採用: ' + text.length + '文字');
      return partial;
    }
    throw new Error('ClaudeのJSONパースに失敗: ' + text.slice(0, 300));
  }
}
