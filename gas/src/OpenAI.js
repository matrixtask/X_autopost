/**
 * OpenAI.js → GASの OpenAI.gs。質問・会話・下書き生成のResponses APIクライアント。
 * 既存の askClaude* から用途で振り分ける。採点・裏方分析はClaudeを維持する。
 */

function responseProviderFor(purpose) {
  if (purpose !== 'interview' && purpose !== 'generate') return 'claude';
  var provider = String(getProp('RESPONSE_PROVIDER', 'openai')).trim().toLowerCase();
  if (provider !== 'openai' && provider !== 'claude') {
    throw openAIError('RESPONSE_PROVIDER は openai または claude を指定してください', 'fatal');
  }
  return provider;
}

function openAIModelFor(purpose) {
  var base = getProp('OPENAI_MODEL', 'gpt-6-astra');
  return purpose === 'generate' ? getProp('OPENAI_MODEL_GENERATE', base) : base;
}

function openAIError(message, kind) {
  var error = new Error('OpenAI: ' + message);
  error.llmFatal = kind === 'fatal';
  error.llmRefusal = kind === 'refusal';
  error.llmTruncated = kind === 'truncated';
  return error;
}

/** Claude形式の既存画像ブロックをResponsesの入力へ変換する */
function openAIInput(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw openAIError('入力形式が不正です', 'fatal');
  return [{ role: 'user', content: content.map(function (block) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      return { type: 'input_text', text: block.text };
    }
    var source = block && block.source;
    if (block && block.type === 'image' && source && source.type === 'base64' &&
      /^image\/(png|jpeg|gif|webp)$/.test(source.media_type) && typeof source.data === 'string' && source.data) {
      return { type: 'input_image', image_url: 'data:' + source.media_type + ';base64,' + source.data };
    }
    throw openAIError('未対応の入力ブロックです', 'fatal');
  }) }];
}

/** 既存のJSON再試行・部分救出処理へ本文を返す。プロバイダ間の自動fallbackはしない */
function openAIMessage(systemPrompt, content, maxTokens, opts) {
  var o = opts || {};
  var apiKey = String(getProp('OPENAI_API_KEY', '')).trim();
  if (!apiKey) throw openAIError('OPENAI_API_KEY をGASのスクリプトプロパティに設定してください', 'fatal');
  var model = openAIModelFor(o.purpose);
  var effort = o.effort || (o.purpose === 'generate'
    ? getProp('OPENAI_EFFORT_GENERATE', 'medium') : getProp('OPENAI_EFFORT_INTERVIEW', 'low'));
  var payload = {
    model: model,
    instructions: systemPrompt,
    input: openAIInput(content),
    max_output_tokens: maxTokens || 4000,
    store: false,
  };
  if (effort) payload.reasoning = { effort: effort };
  var res = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var json;
  try { json = JSON.parse(res.getContentText()); } catch (e) { json = null; }
  // レスポンス本文にはキーや入力が含まれる場合があるため、ログに丸ごと出さない。
  var errorCode = json && json.error && String(json.error.code || json.error.type || '');
  var safeCode = /^[a-z0-9_]{1,80}$/i.test(errorCode || '') ? errorCode : 'unknown';
  if (code >= 300 || (json && json.error)) {
    logEvent('openai_error', 'HTTP=' + code + ' code=' + safeCode);
    var fatal = [400, 401, 403, 404, 422].indexOf(code) >= 0 ||
      /insufficient_quota|billing|invalid_api_key|model_not_found/.test(safeCode);
    throw openAIError('APIエラー HTTP ' + code + ' / ' + safeCode, fatal ? 'fatal' : '');
  }
  if (!json || !Array.isArray(json.output)) throw openAIError('APIの応答形式が不正です');

  var parts = [];
  var refused = false;
  json.output.forEach(function (item) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) return;
    item.content.forEach(function (part) {
      if (!part) return;
      if (part.type === 'refusal') refused = true;
      if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    });
  });
  var reason = json.incomplete_details && json.incomplete_details.reason;
  if (refused || reason === 'content_filter') {
    logEvent('openai_refusal', 'purpose=' + String(o.purpose || ''));
    throw openAIError('モデルが応答を拒否しました', 'refusal');
  }
  if (json.status !== 'completed' && !(json.status === 'incomplete' && reason === 'max_output_tokens')) {
    throw openAIError('応答が完了していません（status=' + String(json.status) + '）');
  }
  var text = parts.join('\n');
  var usage = json.usage || {};
  logEvent('openai_response', 'model=' + model + ' purpose=' + String(o.purpose || '') +
    ' input=' + Number(usage.input_tokens || 0) + ' output=' + Number(usage.output_tokens || 0));
  if (reason === 'max_output_tokens') {
    logEvent('openai_truncated', 'max_output_tokens=' + payload.max_output_tokens);
    if (!text.trim()) throw openAIError('出力枠が足りません', 'truncated');
    // テキストがある場合は既存のJSON部分救出へ渡す。
  }
  if (!text.trim()) throw openAIError('本文が空の応答です');
  return text;
}

/** OpenAI.gsで手動実行する接続確認。Log以外のシート変更・投稿・Slack送信はしない */
function testOpenAIConnection() {
  var text = openAIMessage('接続確認です。OK とだけ返してください。', 'OK', 1000, { purpose: 'interview' });
  var result = 'OpenAI接続OK / model=' + openAIModelFor('interview') + ' / 応答=' + text;
  console.log(result);
  return result;
}
