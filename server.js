import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import {
  isValidApiKey,
  buildGeminiPayload,
  formatErrorMessage
} from './src/chat-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Security Headers Middleware (P2)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Express body parsers - 25MB for large attachments and images
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Serve static frontend files from /public
app.use(express.static(path.join(__dirname, 'public')));

// In-memory sliding rate limiter (40 req/min per IP)
const ipRateLimitMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, item] of ipRateLimitMap.entries()) {
    if (now > item.resetTime) {
      ipRateLimitMap.delete(ip);
    }
  }
}, 300000);

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60000;
  const maxAllowed = 40;
  const entry = ipRateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    ipRateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
    return false;
  }
  if (entry.count >= maxAllowed) {
    return true;
  }
  entry.count++;
  return false;
}

// Health-check endpoint for Render keep-alive
app.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// Diagnostic status endpoint (Zero-leak of credentials)
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    serverHasOwnerKey: Boolean(process.env.GEMINI_API_KEY),
    serverHasOwnerPin: Boolean(process.env.ACCESS_PIN)
  });
});

// Main Chat Proxy Endpoint (Supports SSE Streaming and standard JSON)
app.post('/api/chat', async (req, res) => {
  // 1. IP Rate Limiting Check
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(clientIp)) {
    return res.status(429).json({
      error: 'Превышен лимит частоты запросов (максимум 40 запросов в минуту с одного IP). Подождите несколько секунд.'
    });
  }

  // 2. Authentication: BYOK (User Key) vs Owner PIN
  const userApiKey = req.headers['x-gemini-api-key'] || req.body?.apiKey;
  const clientPin = req.headers['x-access-pin'] || req.body?.pin;
  const serverPin = process.env.ACCESS_PIN ? String(process.env.ACCESS_PIN).trim() : null;

  let apiKey = '';

  if (userApiKey && typeof userApiKey === 'string' && userApiKey.trim().length > 0) {
    const cleanKey = userApiKey.trim();
    if (!isValidApiKey(cleanKey)) {
      return res.status(400).json({
        error: 'Некорректный формат Google Gemini API Key. Ключ должен начинаться с "AIzaSy" и содержать ровно 39 символов.'
      });
    }
    apiKey = cleanKey;
  } else if (serverPin && clientPin && String(clientPin).trim() === serverPin) {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'Серверный GEMINI_API_KEY не задан в переменных окружения Render. Пожалуйста, подключите собственный ключ через кнопку «Настройки доступа».'
      });
    }
    apiKey = process.env.GEMINI_API_KEY;
  } else {
    if (!serverPin) {
      return res.status(401).json({
        error: 'Ключ не задан. Для отправки сообщений укажите собственный Gemini API Key в настройках доступа (кнопка вверху).'
      });
    }
    return res.status(401).json({
      error: 'Требуется авторизация: укажите собственный Gemini API Key в настройках или введите административный PIN владельца.'
    });
  }

  const {
    model = 'gemini-3.5-flash',
    contents = [],
    systemInstruction,
    temperature = 0.7,
    maxOutputTokens,
    stream = true
  } = req.body;

  if (!Array.isArray(contents) || contents.length === 0) {
    return res.status(400).json({
      error: 'Некорректный запрос: contents должен быть непустым массивом сообщений.'
    });
  }

  // Build sanitized Google Gemini request payload
  const geminiPayload = buildGeminiPayload({
    contents,
    systemInstruction,
    temperature,
    maxOutputTokens
  });

  const targetModel = String(model).trim() || 'gemini-3.5-flash';

  // Fallback models pool if requested model is deprecated (404), overloaded (503), or rate-limited (429)
  const fallbackCandidates = [
    targetModel,
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash'
  ];

  // Upstream AbortController & Client Disconnect Listener
  const upstreamAbortController = new AbortController();
  const timeoutId = setTimeout(() => upstreamAbortController.abort(), 90000);

  const onClientClose = () => {
    if (!res.writableEnded) {
      upstreamAbortController.abort();
    }
  };
  res.on('close', onClientClose);

  const triedModels = new Set();
  let upstreamFetchRes = null; // CRITICAL: Distinct variable name to prevent shadowing Express res
  let actualModel = targetModel;
  let lastErrorJson = null;

  try {
    // --- 1. STREAMING MODE (SSE) ---
    if (stream) {
      for (const m of fallbackCandidates) {
        if (triedModels.has(m)) continue;
        triedModels.add(m);

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse&key=${apiKey}`;

        try {
          const upstreamRes = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiPayload),
            signal: upstreamAbortController.signal
          });

          if (upstreamRes.ok) {
            upstreamFetchRes = upstreamRes;
            actualModel = m;
            break;
          }

          const errData = await upstreamRes.json().catch(() => ({}));
          lastErrorJson = errData;
          upstreamFetchRes = upstreamRes;
          actualModel = m;

          // If unauthorized (401/403) or out of quota (429), stop fallback cascade immediately
          if (
            upstreamRes.status === 401 ||
            upstreamRes.status === 403 ||
            (upstreamRes.status === 429 && /quota|exceeded/i.test(errData?.error?.message || ''))
          ) {
            break;
          }
        } catch (fetchErr) {
          if (fetchErr.name === 'AbortError') throw fetchErr;
          console.warn(`[Proxy] Model ${m} stream attempt notice:`, fetchErr.message);
        }
      }

      if (!upstreamFetchRes || !upstreamFetchRes.ok) {
        res.off('close', onClientClose);
        clearTimeout(timeoutId);
        const status = upstreamFetchRes ? upstreamFetchRes.status : 500;
        const errMsg = formatErrorMessage(status, lastErrorJson, targetModel);
        return res.status(status).json({ error: errMsg });
      }

      // Upstream stream connected successfully - Set SSE response headers on Express res
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const reader = upstreamFetchRes.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Retain partial trailing line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(dataStr);
              const candidate = parsed.candidates?.[0];
              let chunkText = '';
              if (candidate?.content?.parts) {
                chunkText = candidate.content.parts
                  .map(p => p.text || '')
                  .filter(Boolean)
                  .join('');
              }

              const ssePayload = {
                text: chunkText,
                model: actualModel !== targetModel ? `${actualModel} (авто-fallback с ${targetModel})` : actualModel,
                finishReason: candidate?.finishReason || null,
                usage: parsed.usageMetadata || null
              };

              res.write(`data: ${JSON.stringify(ssePayload)}\n\n`);
            } catch {
              // Ignore non-JSON line
            }
          }
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } catch (streamPipeErr) {
        if (streamPipeErr.name !== 'AbortError') {
          console.warn('[Proxy] Stream read error:', streamPipeErr.message);
        }
      } finally {
        res.off('close', onClientClose);
        clearTimeout(timeoutId);
      }
      return;
    }

    // --- 2. NON-STREAMING MODE (Standard JSON) ---
    for (const m of fallbackCandidates) {
      if (triedModels.has(m)) continue;
      triedModels.add(m);

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${apiKey}`;

      try {
        const upstreamRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiPayload),
          signal: upstreamAbortController.signal
        });

        if (upstreamRes.ok) {
          upstreamFetchRes = upstreamRes;
          actualModel = m;
          break;
        }

        const errData = await upstreamRes.json().catch(() => ({}));
        lastErrorJson = errData;
        upstreamFetchRes = upstreamRes;
        actualModel = m;

        if (
          upstreamRes.status === 401 ||
          upstreamRes.status === 403 ||
          (upstreamRes.status === 429 && /quota|exceeded/i.test(errData?.error?.message || ''))
        ) {
          break;
        }
      } catch (fetchErr) {
        if (fetchErr.name === 'AbortError') throw fetchErr;
        console.warn(`[Proxy] Model ${m} fetch notice:`, fetchErr.message);
      }
    }

    res.off('close', onClientClose);
    clearTimeout(timeoutId);

    if (!upstreamFetchRes || !upstreamFetchRes.ok) {
      const status = upstreamFetchRes ? upstreamFetchRes.status : 500;
      const errMsg = formatErrorMessage(status, lastErrorJson, targetModel);
      return res.status(status).json({ error: errMsg });
    }

    const data = await upstreamFetchRes.json();
    const candidate = data.candidates?.[0];
    let replyText = '';

    if (candidate?.content?.parts) {
      replyText = candidate.content.parts
        .map(p => p.text || '')
        .filter(Boolean)
        .join('\n');
    }

    if (!replyText) {
      if (candidate?.finishReason === 'SAFETY') {
        replyText = '⚠️ Ответ заблокирован фильтрами безопасности Google Gemini (Safety Policy).';
      } else if (candidate?.finishReason) {
        replyText = `⚠️ Модель завершила генерацию по причине: ${candidate.finishReason}`;
      } else {
        replyText = '⚠️ Модель вернула пустой ответ.';
      }
    }

    return res.json({
      reply: replyText,
      usage: data.usageMetadata || null,
      finishReason: candidate?.finishReason || 'STOP',
      model: actualModel !== targetModel ? `${actualModel} (авто-fallback с ${targetModel})` : actualModel
    });

  } catch (err) {
    res.off('close', onClientClose);
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      if (req.destroyed || req.aborted) {
        if (!res.headersSent) {
          return res.status(499).json({ error: 'Запрос остановлен пользователем.' });
        }
      }
      if (!res.headersSent) {
        return res.status(504).json({ error: 'Таймаут запроса к Google Gemini (более 90 секунд).' });
      }
    }

    if (!res.headersSent) {
      return res.status(500).json({
        error: `Внутренняя ошибка прокси-сервера: ${err.message || 'Неизвестная ошибка'}`
      });
    }
  }
});

// Fallback route to serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, HOST, () => {
  console.log(`[Proxy] Gemini Proxy Chat running on http://${HOST}:${PORT}`);
});
