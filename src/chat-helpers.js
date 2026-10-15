/**
 * Pure helper functions for Gemini Proxy Chat.
 * Decoupled for reliability, unit testing, and maintainability.
 */

/**
 * Validates Google Gemini API key format (starts with AIzaSy, 39 characters)
 * @param {string} key
 * @returns {boolean}
 */
export function isValidApiKey(key) {
  if (!key || typeof key !== 'string') return false;
  const clean = key.trim();
  return /^AIzaSy[A-Za-z0-9_-]{33}$/.test(clean);
}

/**
 * Validates and clamps temperature between 0.0 and 2.0
 * @param {any} temp
 * @param {number} defaultVal
 * @returns {number}
 */
export function clampTemperature(temp, defaultVal = 0.7) {
  const num = Number(temp);
  if (isNaN(num)) return defaultVal;
  return Math.min(Math.max(Math.round(num * 10) / 10, 0), 2.0);
}

/**
 * Validates and clamps maxOutputTokens
 * @param {any} tokens
 * @returns {number|undefined}
 */
export function clampMaxTokens(tokens) {
  const num = Number(tokens);
  if (isNaN(num) || num <= 0) return undefined;
  return Math.min(Math.max(Math.floor(num), 128), 65536);
}

/**
 * Sanitizes chat contents for Google Gemini API format
 * @param {Array} contents
 * @returns {Array}
 */
export function sanitizeContents(contents) {
  if (!Array.isArray(contents)) return [];

  return contents.map(item => {
    const role = item.role === 'model' ? 'model' : 'user';
    const parts = [];

    if (Array.isArray(item.parts)) {
      for (const part of item.parts) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          parts.push({ text: part.text });
        } else if (part.inlineData && part.inlineData.mimeType && part.inlineData.data) {
          let base64Clean = String(part.inlineData.data);
          if (base64Clean.includes(',')) {
            base64Clean = base64Clean.split(',')[1];
          }
          parts.push({
            inlineData: {
              mimeType: String(part.inlineData.mimeType).trim(),
              data: base64Clean.trim()
            }
          });
        }
      }
    }

    if (parts.length === 0) {
      parts.push({ text: ' ' });
    }

    return { role, parts };
  });
}

/**
 * Builds the payload for Google Gemini generateContent or streamGenerateContent
 * @param {Object} params
 * @returns {Object}
 */
export function buildGeminiPayload({
  contents,
  systemInstruction,
  temperature = 0.7,
  maxOutputTokens
}) {
  const sanitized = sanitizeContents(contents);
  const payload = {
    contents: sanitized,
    generationConfig: {
      temperature: clampTemperature(temperature)
    }
  };

  const clampedTokens = clampMaxTokens(maxOutputTokens);
  if (clampedTokens) {
    payload.generationConfig.maxOutputTokens = clampedTokens;
  }

  if (systemInstruction && typeof systemInstruction === 'string' && systemInstruction.trim().length > 0) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction.trim() }]
    };
  }

  return payload;
}

/**
 * Formats user-friendly error messages from Gemini API response
 * @param {number} status
 * @param {Object} lastErrorJson
 * @param {string} targetModel
 * @returns {string}
 */
export function formatErrorMessage(status, lastErrorJson, targetModel) {
  const rawMsg = lastErrorJson?.error?.message || '';

  if (/API_KEY|API key|not valid/i.test(rawMsg) || status === 400 && /API_KEY/i.test(rawMsg) || status === 403) {
    return 'Недействительный Google Gemini API Key. Проверьте правильность введенного ключа в настройках доступа.';
  }
  if (status === 429) {
    return 'Превышен лимит запросов Google API (429 Quota Exceeded). Подождите несколько секунд и повторите.';
  }
  if (status === 503) {
    return 'Модели Google API временно перегружены (503 High Demand). Запрос перенаправлен, повторите через пару секунд.';
  }
  if (status === 404) {
    return `Модель "${targetModel}" недоступна или устарела. Рекомендуется использовать gemini-3.5-flash.`;
  }
  if (rawMsg) {
    return `Ошибка Google Gemini: ${rawMsg}`;
  }
  return `Ошибка Gemini API (${status}). Пожалуйста, попробуйте снова.`;
}

/**
 * Parses Gemini SSE lines into structured tokens
 * @param {string} line
 * @returns {Object|null}
 */
export function parseGeminiSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data:')) return null;

  const dataStr = trimmed.slice(5).trim();
  if (dataStr === '[DONE]') {
    return { done: true };
  }

  try {
    const parsed = JSON.parse(dataStr);
    const candidate = parsed.candidates?.[0];
    let text = '';
    if (candidate?.content?.parts) {
      text = candidate.content.parts
        .map(p => p.text || '')
        .filter(Boolean)
        .join('');
    }
    return {
      text,
      usage: parsed.usageMetadata || null,
      finishReason: candidate?.finishReason || null,
      modelVersion: parsed.modelVersion || null
    };
  } catch {
    return null;
  }
}
