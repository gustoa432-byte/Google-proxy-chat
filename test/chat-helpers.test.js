import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidApiKey,
  clampTemperature,
  clampMaxTokens,
  sanitizeContents,
  buildGeminiPayload,
  formatErrorMessage,
  parseGeminiSseLine
} from '../src/chat-helpers.js';

test('isValidApiKey correctly validates standard 39-character AIzaSy Google API keys', () => {
  assert.equal(isValidApiKey('AIzaSyD-TEST_KEY_1234567890123456789012'), true);
  assert.equal(isValidApiKey('12345'), false);
  assert.equal(isValidApiKey(''), false);
  assert.equal(isValidApiKey(null), false);
  assert.equal(isValidApiKey('sk-ant-api03-1234567890'), false);
});

test('clampTemperature restricts values strictly between 0 and 2.0', () => {
  assert.equal(clampTemperature(0.7), 0.7);
  assert.equal(clampTemperature(-0.5), 0);
  assert.equal(clampTemperature(2.5), 2.0);
  assert.equal(clampTemperature('invalid', 0.7), 0.7);
  assert.equal(clampTemperature(1.23), 1.2);
});

test('clampMaxTokens validates token bounds or returns undefined', () => {
  assert.equal(clampMaxTokens(2048), 2048);
  assert.equal(clampMaxTokens(10), 128); // minimum 128
  assert.equal(clampMaxTokens(100000), 65536); // maximum 65536
  assert.equal(clampMaxTokens(undefined), undefined);
  assert.equal(clampMaxTokens('auto'), undefined);
});

test('sanitizeContents handles user/model text and inline images correctly', () => {
  const input = [
    { role: 'user', parts: [{ text: 'Привет' }] },
    { role: 'model', parts: [{ text: 'Здравствуйте' }] },
    {
      role: 'user',
      parts: [
        { text: 'Вот картинка' },
        { inlineData: { mimeType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' } }
      ]
    }
  ];

  const sanitized = sanitizeContents(input);
  assert.equal(sanitized.length, 3);
  assert.equal(sanitized[0].role, 'user');
  assert.equal(sanitized[0].parts[0].text, 'Привет');
  assert.equal(sanitized[1].role, 'model');
  assert.equal(sanitized[2].parts[1].inlineData.data, 'iVBORw0KGgoAAAANSUhEUg==');
});

test('buildGeminiPayload attaches system instruction and generationConfig', () => {
  const payload = buildGeminiPayload({
    contents: [{ role: 'user', parts: [{ text: 'Тест' }] }],
    systemInstruction: 'Отвечай кратко',
    temperature: 0.3,
    maxOutputTokens: 2048
  });

  assert.equal(payload.generationConfig.temperature, 0.3);
  assert.equal(payload.generationConfig.maxOutputTokens, 2048);
  assert.equal(payload.systemInstruction.parts[0].text, 'Отвечай кратко');
  assert.equal(payload.contents[0].parts[0].text, 'Тест');
});

test('formatErrorMessage returns human-friendly Russian descriptions without secrets', () => {
  const msg429 = formatErrorMessage(429, {}, 'gemini-3.5-flash');
  assert.match(msg429, /Превышен лимит запросов/);

  const msg401 = formatErrorMessage(401, { error: { message: 'API key not valid' } }, 'gemini-3.5-flash');
  assert.match(msg401, /Недействительный Google Gemini API Key/);

  const msg503 = formatErrorMessage(503, {}, 'gemini-3.5-flash');
  assert.match(msg503, /перегружены/);
});

test('parseGeminiSseLine correctly extracts candidate text and token usage', () => {
  const sseLine = 'data: {"candidates": [{"content": {"parts": [{"text": "Привет, мир!"}]}}], "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 4}}';
  const parsed = parseGeminiSseLine(sseLine);

  assert.equal(parsed.text, 'Привет, мир!');
  assert.equal(parsed.usage.promptTokenCount, 5);
  assert.equal(parsed.usage.candidatesTokenCount, 4);

  const doneLine = 'data: [DONE]';
  assert.equal(parseGeminiSseLine(doneLine).done, true);
  assert.equal(parseGeminiSseLine('keep-alive comment'), null);
});
