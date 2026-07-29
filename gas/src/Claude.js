/**
 * Claude.js — Claude API クライアント
 */

/**
 * リトライしても直らないエラーの目印。
 * 残高切れやAPIキー不正で、2回投げ直したりバッチを半分にして粘ったりしても
 * 全部無駄になる。この文字列を含むエラーは即座に諦める。
 */
var CLAUDE_FATAL = 'Claude API 停止中';

function isFatalClaudeError(body) {
  var s = String(body || '');
  return /credit balance|billing|authentication_error|invalid x-api-key|permission_error/i.test(s);
}

function extractClaudeMessage(body) {
  try {
    var j = JSON.parse(body);
    if (j && j.error && j.error.message) return String(j.error.message);
  } catch (e) { /* JSONでなければそのまま返す */ }
  return String(body || '').slice(0, 200);
}

function isFatalError(e) {
  return String(e && e.message ? e.message : e).indexOf(CLAUDE_FATAL) >= 0;
}

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
    // 残高切れ・APIキー不正はリトライしても直らない。呼び出し側が
    // すぐ諦められるよう、目印を付けて区別できるようにする
    if (isFatalClaudeError(body)) {
      throw new Error(CLAUDE_FATAL + ': ' + extractClaudeMessage(body));
    }
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
      if (isFatalError(e)) throw e; // 残高切れ等は投げ直しても無駄
      lastErr = e; // 空応答・一時的なAPIエラー。もう一度だけ投げ直す
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
