import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const completed = (text, more = {}) => ({ status: 'completed', output: [
  { type: 'reasoning', summary: [] },
  { type: 'message', content: [{ type: 'output_text', text }] },
], ...more });

function harness(props = {}, responses = []) {
  const settings = { OPENAI_API_KEY: 'fake-openai-key', ANTHROPIC_API_KEY: 'fake-claude-key', ...props };
  const requests = [];
  const logs = [];
  const ctx = vm.createContext({
    getProp: (key, fallback) => settings[key] === undefined || settings[key] === '' ? fallback : settings[key],
    requireProp: (key) => { if (!settings[key]) throw new Error('missing ' + key); return settings[key]; },
    logEvent: (event, detail) => logs.push({ event, detail }),
    UrlFetchApp: { fetch: (url, request) => {
      requests.push({ url, ...request, payload: JSON.parse(request.payload) });
      const response = responses.shift() || { body: completed('OK') };
      return { getResponseCode: () => response.code || 200,
        getContentText: () => typeof response.body === 'string' ? response.body : JSON.stringify(response.body) };
    } },
  });
  for (const file of ['Pure', 'Claude', 'OpenAI']) {
    vm.runInContext(readFileSync(new URL(`../gas/src/${file}.js`, import.meta.url), 'utf8'), ctx);
  }
  return { ctx, requests, logs };
}

test('OpenAI: interview and writing use Responses with separate reasoning budgets', () => {
  const h = harness();
  assert.equal(h.ctx.askClaude('system', 'reply', 4000, { purpose: 'interview' }), 'OK');
  assert.equal(h.ctx.askClaude('style', 'draft', 6000, { purpose: 'generate' }), 'OK');
  for (const req of h.requests) {
    assert.equal(req.url, 'https://api.openai.com/v1/responses');
    assert.equal(req.headers.Authorization, 'Bearer fake-openai-key');
    assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.payload.model, 'gpt-6-astra');
    assert.equal(req.payload.store, false);
    for (const unsupported of ['temperature', 'top_p', 'fallbacks', 'max_tokens']) {
      assert.equal(req.payload[unsupported], undefined);
    }
  }
  assert.equal(h.requests[0].payload.instructions, 'system');
  assert.equal(h.requests[0].payload.input, 'reply');
  assert.equal(h.requests[0].payload.max_output_tokens, 4000);
  assert.equal(h.requests[0].payload.reasoning.effort, 'low');
  assert.equal(h.requests[1].payload.reasoning.effort, 'medium');
});

test('OpenAI: scoring and untagged background analysis retain Claude', () => {
  const response = { body: { content: [{ type: 'text', text: 'claude-result' }], stop_reason: 'end_turn' } };
  const h = harness({ CLAUDE_MODEL_SCORE: 'existing-scoring-model' }, [response, response]);
  h.ctx.askClaude('score', 'text', 2000, { purpose: 'score' });
  h.ctx.askClaude('analysis', 'text', 2000);
  assert.ok(h.requests.every((r) => r.url === 'https://api.anthropic.com/v1/messages'));
  assert.equal(h.requests[0].payload.model, 'existing-scoring-model');
  assert.equal(h.requests[0].headers.Authorization, undefined);
});

test('OpenAI: explicit Claude rollback retains existing writing model', () => {
  const h = harness({ RESPONSE_PROVIDER: 'claude', CLAUDE_MODEL_GENERATE: 'existing-writing-model' }, [
    { body: { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' } },
  ]);
  h.ctx.askClaude('style', 'draft', 2000, { purpose: 'generate' });
  assert.equal(h.requests[0].payload.model, 'existing-writing-model');
  assert.match(h.requests[0].url, /anthropic/);
});

test('OpenAI: models and efforts can be overridden without changing Claude settings', () => {
  const h = harness({ OPENAI_MODEL: 'selected-model', OPENAI_MODEL_GENERATE: 'writing-model',
    OPENAI_EFFORT_INTERVIEW: 'medium', OPENAI_EFFORT_GENERATE: 'high' });
  h.ctx.askClaude('', '', 2000, { purpose: 'interview' });
  h.ctx.askClaude('', '', 2000, { purpose: 'generate' });
  assert.equal(h.requests[0].payload.model, 'selected-model');
  assert.equal(h.requests[0].payload.reasoning.effort, 'medium');
  assert.equal(h.requests[1].payload.model, 'writing-model');
  assert.equal(h.requests[1].payload.reasoning.effort, 'high');
});

test('OpenAI: Slack images become data URL input_image blocks', () => {
  const h = harness();
  h.ctx.askClaudeWithImages('read', 'caption', [{ base64: 'AA==', mimeType: 'image/png' }], 4000, { purpose: 'interview' });
  const content = h.requests[0].payload.input[0].content;
  assert.deepEqual(content, [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' },
    { type: 'input_text', text: 'caption' }]);
  assert.throws(() => h.ctx.openAIInput([{ type: 'unknown' }]), /未対応/);
});

test('OpenAI: missing key or invalid provider fails without network or silent Claude fallback', () => {
  for (const props of [{ OPENAI_API_KEY: '' }, { RESPONSE_PROVIDER: 'typo' }]) {
    const h = harness(props);
    assert.throws(() => h.ctx.askClaudeJson('', '', 2000, { purpose: 'interview' }), (e) => h.ctx.isFatalError(e));
    assert.equal(h.requests.length, 0);
  }
});

test('OpenAI: permanent HTTP errors stop retry and never expose the server error body', () => {
  for (const [code, errorCode] of [[401, 'invalid_api_key'], [403, 'permission_denied'],
    [404, 'model_not_found'], [429, 'insufficient_quota'], [400, 'invalid_request_error']]) {
    const h = harness({}, [{ code, body: { error: { code: errorCode, message: 'SECRET echoed by server' } } }]);
    assert.throws(() => h.ctx.askClaudeJson('', '', 2000, { purpose: 'generate' }), (e) => {
      assert.equal(h.ctx.isFatalError(e), true);
      assert.doesNotMatch(e.message, /SECRET/);
      return true;
    });
    assert.equal(h.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(h.logs), /SECRET|fake-openai-key/);
  }
});

test('OpenAI: refusal and content filter discard partial output without retry', () => {
  for (const body of [completed('[]', { output: [{ type: 'message', content: [
    { type: 'output_text', text: '[]' }, { type: 'refusal', refusal: 'no' },
  ] }] }), completed('[]', { status: 'incomplete', incomplete_details: { reason: 'content_filter' } })]) {
    const h = harness({}, [{ body }]);
    assert.throws(() => h.ctx.askClaudeJsonSalvageable('', '', 2000, { purpose: 'generate' }), (e) => h.ctx.isRefusalError(e));
    assert.equal(h.requests.length, 1);
  }
});

test('OpenAI: reasoning-only truncation escalates output budget once in JSON wrapper', () => {
  const h = harness({}, [{ body: completed('', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) },
    { body: completed('[{"text":"recovered"}]') }]);
  assert.equal(h.ctx.askClaudeJson('', '', 2000, { purpose: 'generate' })[0].text, 'recovered');
  assert.deepEqual(h.requests.map((r) => r.payload.max_output_tokens), [2000, 6000]);
});

test('OpenAI: completed JSON elements survive an output-token cutoff', () => {
  const h = harness({}, [{ body: completed('[{"text":"saved"},{"text":', {
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
  }) }]);
  assert.equal(h.ctx.askClaudeJsonSalvageable('', '', 2000, { purpose: 'generate' })[0].text, 'saved');
  assert.equal(h.requests.length, 1);
});

test('OpenAI: transient rate limits retry within the existing bounded JSON wrapper', () => {
  const h = harness({}, [{ code: 429, body: { error: { code: 'rate_limit_exceeded' } } }, { body: completed('[]') }]);
  assert.equal(h.ctx.askClaudeJson('', '', 2000, { purpose: 'interview' }).length, 0);
  assert.equal(h.requests.length, 2);
});

test('OpenAI: malformed, failed, and empty responses cannot become publishable text', () => {
  for (const body of ['not json', { status: 'completed' }, completed(''), completed('draft', { status: 'failed' })]) {
    const h = harness({}, [{ body }]);
    assert.throws(() => h.ctx.askClaude('', '', 2000, { purpose: 'interview' }));
  }
});
