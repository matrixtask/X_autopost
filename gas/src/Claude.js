/**
 * Claude.gs — 旧名を保つ共通LLM呼び出し口。全用途でOpenAI Responses APIを使う。
 * Anthropicへの送信・自動fallbackは行わない。JSON再試行・時間予算・原文検証は維持。
 */

// 保存済みの旧エラーも識別できるよう、識別子は残す。
var CLAUDE_FATAL = 'Claude API 停止中';
var CLAUDE_TRUNCATED = '[出力枠が足りません]';
var CLAUDE_REFUSED = '[Claudeが応答を拒否]';

function isTruncatedError(e) {
  return !!(e && e.llmTruncated) || String(e && e.message ? e.message : e).indexOf(CLAUDE_TRUNCATED) >= 0;
}

function isFatalError(e) {
  return !!(e && e.llmFatal) || String(e && e.message ? e.message : e).indexOf(CLAUDE_FATAL) >= 0;
}

function isRefusalError(e) {
  return !!(e && e.llmRefusal) || String(e && e.message ? e.message : e).indexOf(CLAUDE_REFUSED) >= 0;
}

/** 旧関数名の互換口。モデル名・推論量もOpenAIの実設定を返す。 */
function claudeModelFor(purpose) { return openAIModelFor(purpose); }
function claudeEffortFor(purpose) { return openAIEffortFor(purpose); }
function claudeUsesFallbacks(model) { return false; }

/** 旧接続確認を手で実行しても、採点の実際のプロバイダ・モデルを表示する。 */
function testClaudeScoringConnection() { return testOpenAIScoringConnection(); }

function askClaude(systemPrompt, userPrompt, maxTokens, opts) {
  if (typeof assertEditorialExecutionBudget === 'function') assertEditorialExecutionBudget();
  return openAIMessage(systemPrompt, userPrompt, maxTokens, opts);
}

/** 古い直接呼び出しも同じ時間予算・OpenAI経路を通す。 */
function claudeMessage(systemPrompt, content, maxTokens, opts) {
  return askClaude(systemPrompt, content, maxTokens, opts);
}

function askClaudeWithImages(systemPrompt, userPrompt, images, maxTokens, opts) {
  var content = (images || []).map(function (im) {
    return { type: 'image', source: { type: 'base64', media_type: im.mimeType, data: im.base64 } };
  });
  content.push({ type: 'text', text: userPrompt });
  return askClaude(systemPrompt, content, maxTokens, opts);
}

/** 出力枠を広げて投げ直すときの倍率と上限 */
var TOKEN_ESCALATION = 3;
var TOKEN_CEILING = 16000;

/**
 * JSONを返させる呼び出し。失敗時は**出力枠を3倍にして**1回だけ投げ直す。
 *
 * 同じ枠で投げ直しても、枠が足りていないケースでは何度やっても同じ結果になる。
 * JSONのパース失敗はほとんどが途中で切れたことによるものなので、
 * 空応答・打ち切り・パース失敗のいずれでも枠を広げて再挑戦する。
 */
function askClaudeJson(systemPrompt, userPrompt, maxTokens, opts) {
  var budget = maxTokens || 2000;
  var lastErr = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    var text = null;
    try {
      text = askClaude(systemPrompt, userPrompt + '\n\n出力はJSONのみ。前置きや説明は書かない。', budget, opts);
    } catch (e) {
      if (isFatalError(e) || isRefusalError(e) || (e && e.llmNoRetry)) throw e; // 時間不足も同じ実行内では再試行しない
      lastErr = e;
    }
    if (text !== null) {
      try {
        return parseJsonLoose(text);
      } catch (e2) {
        lastErr = new Error('AIのJSONパースに失敗（応答' + text.length + '文字）');
      }
    }
    if (attempt === 0 && budget < TOKEN_CEILING) {
      budget = Math.min(budget * TOKEN_ESCALATION, TOKEN_CEILING);
      logEvent('llm_retry', '出力枠を' + budget + 'に広げて再試行します');
    }
  }
  throw lastErr;
}

/**
 * 一括採点のように「一部だけでも取れれば前に進める」呼び出し用。
 * max_tokensで応答が切れた場合、完成している要素だけを救出して返す。
 * 救出もできなければ askClaudeJson と同じくエラーを投げる。
 */
function askClaudeJsonSalvageable(systemPrompt, userPrompt, maxTokens, opts) {
  var lastErr = null;
  var budget = maxTokens || 2000;
  for (var attempt = 0; attempt < 2; attempt++) {
    var text;
    if (attempt > 0 && budget < TOKEN_CEILING) {
      budget = Math.min(budget * TOKEN_ESCALATION, TOKEN_CEILING);
      logEvent('llm_retry', '出力枠を' + budget + 'に広げて再試行します');
    }
    try {
      text = askClaude(systemPrompt, userPrompt + '\n\n出力はJSONのみ。前置きや説明は書かない。', budget, opts);
    } catch (e) {
      if (isFatalError(e) || isRefusalError(e) || (e && e.llmNoRetry)) throw e; // 時間不足も同じ実行内では再試行しない
      lastErr = e; // 空応答・一時的なAPIエラー。枠を広げてもう一度だけ投げ直す
      continue;
    }
    var partial = salvageJson(text); // 切れていなければ全部返る
    if (partial) {
      var full = null;
      try { full = parseJsonLoose(text); } catch (e2) { /* 部分救出だった */ }
      if (!full) logEvent('llm_json_salvaged', '応答が途中で切れたため一部のみ採用: ' + text.length + '文字');
      return partial;
    }
    lastErr = new Error('AIのJSONパースに失敗（応答' + text.length + '文字）');
  }
  throw lastErr;
}
