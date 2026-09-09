/**
 * Claude.js — Claude API クライアント
 */

/**
 * リトライしても直らないエラーの目印。
 * 残高切れやAPIキー不正で、2回投げ直したりバッチを半分にして粘ったりしても
 * 全部無駄になる。この文字列を含むエラーは即座に諦める。
 */
var CLAUDE_FATAL = 'Claude API 停止中';

/**
 * max_tokens で打ち切られたことを示す目印。
 * モデルが thinking ブロックだけを返して本文が0文字になることがある
 * （実例: 入力2702トークン / max_tokens=1500 で blocks=thinking のみ）。
 * この場合は枠を広げて投げ直せば通るので、諦めずに再試行する。
 */
var CLAUDE_TRUNCATED = '[出力枠が足りません]';

function isTruncatedError(e) {
  return String(e && e.message ? e.message : e).indexOf(CLAUDE_TRUNCATED) >= 0;
}

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

/**
 * 安全分類器に拒否されたことを示す目印。
 * Fable 5.1 系は、危険とみなした依頼を HTTP 200 のまま stop_reason=refusal で
 * 返す。同じ内容を投げ直しても同じ結果になるので、出力枠を広げる再試行の
 * 対象にしない（枠の問題ではない）。
 */
var CLAUDE_REFUSED = '[Claudeが応答を拒否]';

function isRefusalError(e) {
  return String(e && e.message ? e.message : e).indexOf(CLAUDE_REFUSED) >= 0;
}

/**
 * 用途ごとのモデル。
 *
 *   generate … 下書き生成・リライト。文体の質が直接ポストに出るので、
 *              ここだけ上位モデル（CLAUDE_MODEL_GENERATE）を使う
 *   score    … 採点・遡及採点。数百件を回すうえ、途中でモデルを変えると
 *              過去のスコアと比較できなくなる。CLAUDE_MODEL_SCORE で固定
 *   それ以外 … 質問生成・分析など。CLAUDE_MODEL（既定 claude-sonnet-5）
 *
 * 用途別の設定が無ければ CLAUDE_MODEL に落ちる。
 */
function claudeModelFor(purpose) {
  var base = getProp('CLAUDE_MODEL', 'claude-sonnet-5');
  if (purpose === 'generate') return getProp('CLAUDE_MODEL_GENERATE', base);
  if (purpose === 'score') return getProp('CLAUDE_MODEL_SCORE', base);
  return base;
}

/**
 * 用途ごとの effort（思考の深さ）。
 *
 * Fable 5.1 は思考が常時オンで、放っておくと定型作業でも深く考えて
 * 出力枠を思考で使い切る（本文が0文字で返る claude_empty の再来）。
 * 生成のような定型作業は medium で十分。未設定なら送らない
 * （effort を受け付けないモデルで 400 にしないため）。
 */
function claudeEffortFor(purpose) {
  if (purpose === 'generate') return getProp('CLAUDE_EFFORT_GENERATE', 'medium');
  if (purpose === 'score') return getProp('CLAUDE_EFFORT_SCORE', '');
  return getProp('CLAUDE_EFFORT', '');
}

/**
 * 拒否時に別モデルへ自動で引き継ぐか。
 *
 * Fable 5.1 / Opus 5 系は安全分類器が誤検知することがある（技術系の話題で
 * 起きうる）。fallbacks: "default" を付けると、拒否された依頼を同じ
 * リクエストの中で別モデルに流し、その答えが返る。それ以外のモデルには
 * 付けない（既定 auto）。CLAUDE_FALLBACKS=off で止められる。
 */
function claudeUsesFallbacks(model) {
  var mode = String(getProp('CLAUDE_FALLBACKS', 'auto')).toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return /fable|mythos|opus-5/.test(String(model));
}

function askClaude(systemPrompt, userPrompt, maxTokens, opts) {
  return claudeMessage(systemPrompt, userPrompt, maxTokens, opts);
}

/**
 * 画像つきで問い合わせる。
 * @param {Array} images [{base64, mimeType}]（先に置くほうが精度が上がる）
 */
function askClaudeWithImages(systemPrompt, userPrompt, images, maxTokens, opts) {
  var content = (images || []).map(function (im) {
    return { type: 'image', source: { type: 'base64', media_type: im.mimeType, data: im.base64 } };
  });
  content.push({ type: 'text', text: userPrompt });
  return claudeMessage(systemPrompt, content, maxTokens, opts);
}

/**
 * Claude APIの本体。content は文字列でもブロック配列でもよい。
 *
 * @param {Object} opts {purpose: 'generate'|'score'|undefined, effort: 'low'..'max'}
 *   purpose で用途別のモデルと effort を選ぶ。effort を直接渡すと用途の既定より優先。
 *
 * 送るのは model / max_tokens / system / messages と、あれば output_config.effort と
 * fallbacks だけ。thinking や temperature は送らない（Fable 5.1 系は
 * thinking の明示指定も temperature も 400 を返す）。
 */
function claudeMessage(systemPrompt, content, maxTokens, opts) {
  var o = opts || {};
  var apiKey = requireProp('ANTHROPIC_API_KEY');
  var model = claudeModelFor(o.purpose);
  var effort = o.effort || claudeEffortFor(o.purpose);
  var useFallbacks = claudeUsesFallbacks(model);

  var payload = {
    model: model,
    max_tokens: maxTokens || 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: content }],
  };
  if (effort) payload.output_config = { effort: effort };
  if (useFallbacks) payload.fallbacks = 'default';

  var headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  // fallbacks: "default" はこのベータヘッダとセットでないと 400 になる
  if (useFallbacks) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code >= 300) {
    logEvent('claude_error', model + ' ' + code + ': ' + body.slice(0, 500));
    // 残高切れ・APIキー不正はリトライしても直らない。呼び出し側が
    // すぐ諦められるよう、目印を付けて区別できるようにする
    if (isFatalClaudeError(body)) {
      throw new Error(CLAUDE_FATAL + ': ' + extractClaudeMessage(body));
    }
    throw new Error('Claude API error ' + code + ': ' + body.slice(0, 200));
  }
  var json = JSON.parse(body);
  var blocks = json.content || [];

  // 拒否は HTTP 200 で返る。content が空のまま text を探しても「空応答」に
  // しか見えず、枠を広げて投げ直す無駄なループに入る。先に見分ける。
  if (json.stop_reason === 'refusal') {
    var sd = json.stop_details || {};
    var why = 'category=' + (sd.category === undefined ? '不明' : String(sd.category)) +
      (sd.explanation ? ' / ' + String(sd.explanation).slice(0, 200) : '') +
      (json.model && json.model !== model ? ' / 引き継ぎ先 ' + json.model + ' も拒否' : '');
    logEvent('claude_refusal', model + ' ' + why);
    throw new Error(CLAUDE_REFUSED + ' ' + why);
  }
  // 拒否されて別モデルが答えた場合は、どこで引き継がれたかを残す
  blocks.forEach(function (b) {
    if (b.type === 'fallback') {
      logEvent('claude_fallback', ((b.from || {}).model || model) + ' が拒否 → ' +
        ((b.to || {}).model || json.model) + ' が応答');
    }
  });
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
    throw new Error((json.stop_reason === 'max_tokens' ? CLAUDE_TRUNCATED + ' ' : '') +
      'Claudeが空の応答を返しました: ' + detail);
  }
  if (json.stop_reason === 'max_tokens') {
    logEvent('claude_truncated', 'max_tokens=' + (maxTokens || 2000) + 'で打ち切られました。usage=' + JSON.stringify(json.usage || {}));
  }
  return text;
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
      if (isFatalError(e) || isRefusalError(e)) throw e; // 残高切れ・拒否は投げ直しても無駄
      lastErr = e;
    }
    if (text !== null) {
      try {
        return parseJsonLoose(text);
      } catch (e2) {
        lastErr = new Error('ClaudeのJSONパースに失敗（応答' + text.length + '文字）: ' + text.slice(0, 300));
      }
    }
    if (attempt === 0 && budget < TOKEN_CEILING) {
      budget = Math.min(budget * TOKEN_ESCALATION, TOKEN_CEILING);
      logEvent('claude_retry', '出力枠を' + budget + 'に広げて再試行します');
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
      logEvent('claude_retry', '出力枠を' + budget + 'に広げて再試行します');
    }
    try {
      text = askClaude(systemPrompt, userPrompt + '\n\n出力はJSONのみ。前置きや説明は書かない。', budget, opts);
    } catch (e) {
      if (isFatalError(e) || isRefusalError(e)) throw e; // 残高切れ・拒否は投げ直しても無駄
      lastErr = e; // 空応答・一時的なAPIエラー。枠を広げてもう一度だけ投げ直す
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
