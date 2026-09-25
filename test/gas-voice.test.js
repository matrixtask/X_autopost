import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('voice without registered samples uses the original answer rather than a generic invented persona', () => {
  const ctx = vm.createContext({
    SHEET: { VOICE: 'Voice' }, readTable: () => [], useOutcomeQuality: () => true,
    outcomeWritingGuidance: () => '', editorialFocusPrompt: () => '', topPostSamples: () => [], buildMemoryPrompt: () => '',
  });
  vm.runInContext(readFileSync(new URL('../gas/src/Voice.js', import.meta.url), 'utf8'), ctx);
  const prompt = ctx.buildStylePrompt();
  assert.match(prompt, /今回の本人回答原文を口調の手本/);
  assert.match(prompt, /必要な主語・対象・状況は冒頭に自然に置く/);
  assert.match(prompt, /文体サンプルの出来事は事実の補完に使わない/);
  assert.doesNotMatch(prompt, /お題の説明は書かない|文体サンプル未登録。自然な日本語/);
});
