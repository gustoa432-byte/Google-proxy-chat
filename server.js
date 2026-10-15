import express from 'express';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Express middleware
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Health-check endpoint to keep Render container awake and monitor status
app.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// Environment config status check (does not expose secret values)
app.get('/api/status', (req, res) => {
  res.json({
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    hasCustomPin: Boolean(process.env.ACCESS_PIN),
    defaultPinInUse: !process.env.ACCESS_PIN
  });
});

// Main Chat Proxy Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const clientPin = req.headers['x-access-pin'] || req.body?.pin;
    const serverPin = process.env.ACCESS_PIN || '1234';

    if (!clientPin || String(clientPin).trim() !== String(serverPin).trim()) {
      return res.status(401).json({
        error: 'Доступ запрещен: неверный PIN-код. Введите правильный PIN в верхней панели.'
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'Серверная ошибка: GEMINI_API_KEY не задан в переменных окружения на сервере.'
      });
    }

    const {
      model = 'gemini-2.5-flash',
      contents = [],
      systemInstruction,
      temperature = 0.7
    } = req.body;

    if (!Array.isArray(contents) || contents.length === 0) {
      return res.status(400).json({
        error: 'Некорректный запрос: contents должен быть непустым массивом сообщений.'
      });
    }

    // Sanitize conversation contents for Google Gemini API
    const sanitizedContents = contents.map(item => {
      const role = item.role === 'model' ? 'model' : 'user';
      const parts = [];

      if (Array.isArray(item.parts)) {
        for (const part of item.parts) {
          if (typeof part.text === 'string' && part.text.length > 0) {
            parts.push({ text: part.text });
          } else if (part.inlineData && part.inlineData.mimeType && part.inlineData.data) {
            let base64Clean = part.inlineData.data;
            if (base64Clean.includes(',')) {
              base64Clean = base64Clean.split(',')[1];
            }
            parts.push({
              inlineData: {
                mimeType: part.inlineData.mimeType,
                data: base64Clean
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

    // Build Gemini request payload
    const geminiPayload = {
      contents: sanitizedContents,
      generationConfig: {
        temperature: Math.min(Math.max(Number(temperature) || 0.7, 0), 2)
      }
    };

    if (systemInstruction && typeof systemInstruction === 'string' && systemInstruction.trim().length > 0) {
      geminiPayload.systemInstruction = {
        parts: [{ text: systemInstruction.trim() }]
      };
    }

    const targetModel = String(model).trim() || 'gemini-2.5-flash';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    try {
      let geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload),
        signal: controller.signal
      });

      // Auto-fallback if requested model is superseded or unavailable in the user's project
      if (!geminiRes.ok && (geminiRes.status === 404 || geminiRes.status === 400) && targetModel !== 'gemini-3.8-flash') {
        const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;
        try {
          const fallbackRes = await fetch(fallbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiPayload),
            signal: controller.signal
          });
          geminiRes = fallbackRes;
          targetModel = 'gemini-3.8-flash';
        } catch (_) {}
      }

      clearTimeout(timeoutId);

      if (!geminiRes.ok) {
        let errMsg = `Ошибка Gemini API (${geminiRes.status})`;
        try {
          const errData = await geminiRes.json();
          if (errData?.error?.message) {
            errMsg = errData.error.message;
          }
        } catch (_) {}

        if (geminiRes.status === 429) {
          errMsg = 'Превышен лимит запросов Google API (429 Rate Limit / Quota Exceeded). Подождите несколько секунд и повторите.';
        } else if (geminiRes.status === 503) {
          errMsg = 'Google API временно перегружен (503 Service Unavailable / High Demand). Нажмите «Повторить попытку» через пару секунд.';
        } else if (geminiRes.status === 404) {
          errMsg = `Модель "${targetModel}" не найдена в Google API. Проверьте правильность ID модели.`;
        } else if (geminiRes.status === 400) {
          errMsg = `Некорректный запрос к модели (${targetModel}): ${errMsg}`;
        } else if (geminiRes.status === 403) {
          errMsg = `Ошибка доступа API ключа Google: ${errMsg}`;
        }

        return res.status(geminiRes.status).json({ error: errMsg });
      }

      const data = await geminiRes.json();
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
          replyText = `⚠️ Модель остановила генерацию по причине: ${candidate.finishReason}`;
        } else {
          replyText = '⚠️ Модель вернула пустой ответ.';
        }
      }

      return res.json({
        reply: replyText,
        usage: data.usageMetadata || null,
        finishReason: candidate?.finishReason || 'STOP',
        model: targetModel
      });

    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        return res.status(504).json({ error: 'Таймаут запроса к Google Gemini (более 90 секунд).' });
      }
      throw fetchErr;
    }

  } catch (err) {
    console.error('Server chat error:', err);
    return res.status(500).json({
      error: `Внутренняя ошибка прокси-сервера: ${err.message || 'Неизвестная ошибка'}`
    });
  }
});

// Single Page Application Frontend (No build step, served directly)
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Gemini Radio · Персональный Web-Proxy</title>
  <meta name="description" content="Ультралегкий персональный веб-прокси чат для Google Gemini API. Работает без VPN на Render.com">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⚡</text></svg>">
  
  <!-- CDNs for Markdown and Syntax Highlighting -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark-dimmed.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>

  <style>
    :root {
      --bg-base: #090a0f;
      --bg-surface: #12141c;
      --bg-surface-elevated: #1a1c27;
      --bg-card: rgba(22, 25, 36, 0.82);
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-active: rgba(99, 102, 241, 0.45);
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --accent-gradient: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
      --text-main: #f3f4f6;
      --text-muted: #94a3b8;
      --text-subtle: #64748b;
      --user-bubble: #1e2433;
      --bot-bubble: #13151f;
      --danger: #ef4444;
      --success: #10b981;
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 18px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      background-color: var(--bg-base);
      color: var(--text-main);
      height: 100dvh;
      width: 100vw;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }

    /* Top Control Bar */
    .topbar {
      background: rgba(18, 20, 28, 0.85);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border-subtle);
      padding: 10px 16px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      z-index: 40;
      flex-shrink: 0;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 15px;
      letter-spacing: -0.3px;
    }

    .brand-icon {
      width: 26px;
      height: 26px;
      border-radius: 7px;
      background: var(--accent-gradient);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 14px rgba(99, 102, 241, 0.4);
    }

    .brand-icon svg {
      width: 15px;
      height: 15px;
      fill: #ffffff;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.05);
      padding: 3px 8px;
      border-radius: 12px;
      border: 1px solid var(--border-subtle);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
      animation: pulse 2.5s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    .controls-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    /* PIN input wrapper */
    .pin-box {
      display: flex;
      align-items: center;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 0 8px;
      height: 32px;
      transition: border-color 0.2s;
    }

    .pin-box:focus-within {
      border-color: var(--border-active);
    }

    .pin-box label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      margin-right: 6px;
      user-select: none;
    }

    .pin-input {
      background: transparent;
      border: none;
      outline: none;
      color: var(--text-main);
      font-size: 12px;
      width: 75px;
      letter-spacing: 1px;
      font-family: monospace;
    }

    .pin-toggle-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      padding: 2px;
    }

    .pin-toggle-btn:hover {
      color: var(--text-main);
    }

    /* Model select */
    .select-wrapper {
      position: relative;
    }

    .model-select {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-main);
      border-radius: var(--radius-sm);
      height: 32px;
      padding: 0 24px 0 10px;
      font-size: 12px;
      outline: none;
      appearance: none;
      -webkit-appearance: none;
      cursor: pointer;
    }

    .model-select:focus {
      border-color: var(--border-active);
    }

    .select-wrapper::after {
      content: '';
      position: absolute;
      right: 9px;
      top: 50%;
      transform: translateY(-50%);
      width: 0;
      height: 0;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 5px solid var(--text-muted);
      pointer-events: none;
    }

    .custom-model-input {
      display: none;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-main);
      border-radius: var(--radius-sm);
      height: 32px;
      padding: 0 8px;
      font-size: 12px;
      outline: none;
      width: 140px;
    }

    .custom-model-input:focus {
      border-color: var(--border-active);
    }

    .btn-icon {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
      border-radius: var(--radius-sm);
      height: 32px;
      padding: 0 10px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-icon:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .btn-icon svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
    }

    .indicator-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      display: none;
    }

    .indicator-dot.active {
      display: inline-block;
    }

    /* Main Chat Viewport */
    .chat-viewport {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      scroll-behavior: smooth;
    }

    .chat-viewport::-webkit-scrollbar {
      width: 6px;
    }
    .chat-viewport::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
    }

    .chat-container {
      max-width: 860px;
      width: 100%;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    /* Welcome / Empty state */
    .empty-state {
      margin: auto;
      max-width: 520px;
      text-align: center;
      padding: 30px 16px;
    }

    .radio-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(99, 102, 241, 0.12);
      color: #818cf8;
      border: 1px solid rgba(99, 102, 241, 0.25);
      border-radius: 20px;
      padding: 4px 12px;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 16px;
      letter-spacing: 0.5px;
    }

    .empty-title {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 8px;
      background: linear-gradient(180deg, #ffffff 0%, #cbd5e1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .empty-desc {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 24px;
    }

    .features-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      text-align: left;
      margin-bottom: 24px;
    }

    @media (max-width: 480px) {
      .features-grid {
        grid-template-columns: 1fr;
      }
    }

    .feature-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 12px;
      font-size: 12px;
    }

    .feature-card b {
      display: block;
      color: var(--text-main);
      margin-bottom: 3px;
      font-size: 12px;
    }

    .feature-card span {
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.3;
    }

    .starter-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
    }

    .chip-btn {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
      border-radius: 20px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .chip-btn:hover {
      color: var(--text-main);
      border-color: var(--border-active);
      background: rgba(99, 102, 241, 0.1);
    }

    /* Message Bubbles */
    .msg-row {
      display: flex;
      width: 100%;
      gap: 12px;
      animation: fadeIn 0.25s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .msg-row.user {
      justify-content: flex-end;
    }

    .msg-row.bot {
      justify-content: flex-start;
    }

    .avatar {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 600;
    }

    .avatar.bot-avatar {
      background: var(--accent-gradient);
      box-shadow: 0 0 12px rgba(99, 102, 241, 0.3);
    }

    .avatar.user-avatar {
      background: #334155;
      color: #94a3b8;
    }

    .msg-content-wrapper {
      max-width: 82%;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .msg-bubble {
      padding: 12px 16px;
      border-radius: var(--radius-md);
      font-size: 14px;
      line-height: 1.6;
      word-break: break-word;
      position: relative;
    }

    .user .msg-bubble {
      background: var(--user-bubble);
      color: #f8fafc;
      border-top-right-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      white-space: pre-wrap;
    }

    .bot .msg-bubble {
      background: var(--bot-bubble);
      color: var(--text-main);
      border-top-left-radius: 4px;
      border: 1px solid var(--border-subtle);
    }

    .msg-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--text-subtle);
      padding: 0 4px;
    }

    .timer-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: #818cf8;
      font-family: monospace;
      font-size: 11px;
    }

    /* Attached image preview in user message */
    .msg-attachment-img {
      max-width: 240px;
      max-height: 180px;
      border-radius: var(--radius-sm);
      margin-bottom: 8px;
      display: block;
      border: 1px solid rgba(255, 255, 255, 0.15);
      cursor: pointer;
    }

    .msg-attachment-file {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(255, 255, 255, 0.08);
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-family: monospace;
      margin-bottom: 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    /* Markdown Styling Inside Bot Messages */
    .msg-bubble h1, .msg-bubble h2, .msg-bubble h3, .msg-bubble h4 {
      margin: 14px 0 6px 0;
      color: #ffffff;
      line-height: 1.3;
    }
    .msg-bubble h1:first-child, .msg-bubble h2:first-child, .msg-bubble h3:first-child {
      margin-top: 0;
    }
    .msg-bubble h1 { font-size: 18px; }
    .msg-bubble h2 { font-size: 16px; }
    .msg-bubble h3 { font-size: 14px; }
    .msg-bubble p { margin-bottom: 10px; }
    .msg-bubble p:last-child { margin-bottom: 0; }
    .msg-bubble ul, .msg-bubble ol { margin: 8px 0 10px 20px; }
    .msg-bubble li { margin-bottom: 4px; }
    .msg-bubble blockquote {
      border-left: 3px solid var(--accent);
      padding-left: 10px;
      color: var(--text-muted);
      margin: 8px 0;
    }
    .msg-bubble table {
      border-collapse: collapse;
      width: 100%;
      margin: 10px 0;
      font-size: 13px;
    }
    .msg-bubble th, .msg-bubble td {
      border: 1px solid var(--border-subtle);
      padding: 6px 10px;
      text-align: left;
    }
    .msg-bubble th {
      background: rgba(255, 255, 255, 0.05);
    }

    .msg-bubble :not(pre) > code {
      background: rgba(255, 255, 255, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      font-size: 12px;
      color: #e2e8f0;
    }

    /* Code Blocks with Copy Header */
    .code-container {
      position: relative;
      background: #14161f;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: var(--radius-sm);
      margin: 12px 0;
      overflow: hidden;
    }

    .code-header {
      background: #191b26;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 12px;
      font-family: monospace;
      font-size: 11px;
      color: var(--text-muted);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .copy-btn {
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s;
    }

    .copy-btn:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.15);
    }

    .code-container pre {
      margin: 0;
      padding: 12px;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.45;
      font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      background: transparent !important;
    }

    .code-container pre code {
      background: transparent !important;
      padding: 0 !important;
    }

    /* Thinking / Live Timer State */
    .thinking-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font-size: 13px;
      color: var(--text-muted);
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(99, 102, 241, 0.2);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Error Message Card with Retry */
    .error-card {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      padding: 12px 16px;
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 13px;
    }

    .retry-btn {
      align-self: flex-start;
      background: #ef4444;
      color: #fff;
      border: none;
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .retry-btn:hover {
      background: #dc2626;
    }

    /* Bottom Input Bar */
    .input-section {
      background: rgba(18, 20, 28, 0.92);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-top: 1px solid var(--border-subtle);
      padding: 12px 16px;
      flex-shrink: 0;
    }

    .input-container {
      max-width: 860px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* Attached chips preview above input */
    .attachment-preview-bar {
      display: none;
      flex-wrap: wrap;
      gap: 8px;
    }

    .attachment-preview-bar.active {
      display: flex;
    }

    .attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-active);
      border-radius: 8px;
      padding: 4px 8px;
      font-size: 12px;
      color: var(--text-main);
    }

    .attachment-chip img {
      width: 22px;
      height: 22px;
      object-fit: cover;
      border-radius: 4px;
    }

    .attachment-chip .remove-att-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 2px;
    }

    .attachment-chip .remove-att-btn:hover {
      color: var(--danger);
    }

    .input-box {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 8px 12px;
      display: flex;
      align-items: flex-end;
      gap: 10px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .input-box:focus-within {
      border-color: var(--border-active);
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
    }

    .attach-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.15s;
    }

    .attach-btn:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.08);
    }

    .chat-textarea {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text-main);
      font-family: inherit;
      font-size: 14px;
      line-height: 1.45;
      resize: none;
      max-height: 160px;
      min-height: 24px;
      padding: 4px 0;
    }

    .chat-textarea::placeholder {
      color: var(--text-subtle);
    }

    .send-btn {
      background: var(--accent-gradient);
      color: #fff;
      border: none;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.2s;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.35);
    }

    .send-btn:hover:not(:disabled) {
      transform: scale(1.05);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.5);
    }

    .send-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    .input-hint {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: var(--text-subtle);
      padding: 0 4px;
    }

    /* Modal / Drawer for System Prompt */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 16px;
    }

    .modal-overlay.open {
      display: flex;
    }

    .modal-card {
      background: #171923;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      max-width: 520px;
      width: 100%;
      padding: 20px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-title {
      font-size: 16px;
      font-weight: 600;
    }

    .modal-close-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 18px;
    }

    .system-textarea {
      width: 100%;
      height: 120px;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      color: var(--text-main);
      padding: 10px;
      font-family: inherit;
      font-size: 13px;
      resize: vertical;
      outline: none;
    }

    .system-textarea:focus {
      border-color: var(--border-active);
    }

    .presets-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .preset-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      cursor: pointer;
    }

    .preset-btn:hover {
      color: var(--text-main);
      border-color: var(--border-active);
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 6px;
    }

    .btn-secondary {
      background: transparent;
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
      padding: 6px 14px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      cursor: pointer;
    }

    .btn-primary {
      background: var(--accent);
      border: none;
      color: #fff;
      padding: 6px 14px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }

    .btn-primary:hover {
      background: var(--accent-hover);
    }

    /* Mobile Adaptations */
    @media (max-width: 640px) {
      .topbar {
        padding: 8px 12px;
      }
      .brand span {
        display: none;
      }
      .pin-box {
        padding: 0 4px;
      }
      .pin-input {
        width: 60px;
      }
      .btn-icon span {
        display: none;
      }
      .msg-content-wrapper {
        max-width: 92%;
      }
      .custom-model-input {
        width: 100px;
      }
    }
  </style>
</head>
<body>

  <!-- Top Control Bar -->
  <header class="topbar">
    <div class="brand">
      <div class="brand-icon">
        <svg viewBox="0 0 24 24">
          <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
        </svg>
      </div>
      <span>Gemini Radio</span>
      <div class="status-pill" id="statusPill" title="Анти-сон: сервер опрашивается каждые 4 минуты">
        <span class="status-dot"></span>
        <span id="statusText">Онлайн</span>
      </div>
    </div>

    <div class="controls-group">
      <!-- PIN Input -->
      <div class="pin-box" title="PIN-код для защиты доступа к вашему Render proxy">
        <label for="pinInput">PIN:</label>
        <input type="password" id="pinInput" class="pin-input" placeholder="1234" autocomplete="off" />
        <button type="button" id="pinToggleBtn" class="pin-toggle-btn" title="Показать/скрыть PIN">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>
      </div>

      <!-- Model Select -->
      <div class="select-wrapper">
        <select id="modelSelect" class="model-select" title="Выберите модель Gemini">
          <option value="gemini-2.5-flash">gemini-2.5-flash (Быстрый)</option>
          <option value="gemini-2.5-pro">gemini-2.5-pro (Флагман)</option>
          <option value="gemini-2.0-flash">gemini-2.0-flash (Скорость)</option>
          <option value="gemini-3.8-flash">gemini-3.8-flash (Новейший)</option>
          <option value="__custom__">Свой ID модели...</option>
        </select>
      </div>
      <input type="text" id="customModelInput" class="custom-model-input" placeholder="например: gemini-2.5-pro" />

      <!-- System Prompt Button -->
      <button type="button" id="systemPromptBtn" class="btn-icon" title="Системная инструкция (System Instruction)">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        <span>Системный</span>
        <span id="systemIndicator" class="indicator-dot"></span>
      </button>

      <!-- Export Markdown Button -->
      <button type="button" id="exportBtn" class="btn-icon" title="Скачать диалог в формате Markdown (.md)">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>Экспорт</span>
      </button>

      <!-- Clear Chat Button -->
      <button type="button" id="clearBtn" class="btn-icon" title="Очистить историю диалога">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        <span>Очистить</span>
      </button>
    </div>
  </header>

  <!-- Chat Viewport -->
  <main class="chat-viewport" id="chatViewport">
    <div class="chat-container" id="chatContainer">
      <!-- Empty state injected if no messages -->
    </div>
  </main>

  <!-- Input Section -->
  <footer class="input-section">
    <div class="input-container">
      <!-- Attachment preview chip -->
      <div class="attachment-preview-bar" id="attachmentPreviewBar">
        <div class="attachment-chip" id="attachmentChip">
          <span id="attachmentIcon">📎</span>
          <img id="attachmentThumbnail" style="display:none;" alt="Превью" />
          <span id="attachmentName">file.txt</span>
          <button type="button" class="remove-att-btn" id="removeAttachmentBtn" title="Удалить прикрепленный файл">×</button>
        </div>
      </div>

      <div class="input-box">
        <!-- Hidden file input -->
        <input type="file" id="fileInput" style="display:none;" accept="image/png,image/jpeg,image/webp,image/gif,text/*,.ts,.tsx,.js,.jsx,.json,.py,.html,.css,.scss,.md,.sql,.sh,.yml,.yaml,.csv,.env" />
        <button type="button" class="attach-btn" id="attachBtn" title="Прикрепить изображение или файл с кодом">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
          </svg>
        </button>

        <textarea
          id="chatInput"
          class="chat-textarea"
          rows="1"
          placeholder="Напишите сообщение Gemini... (Enter для отправки, Shift+Enter для новой строки)"
        ></textarea>

        <button type="button" class="send-btn" id="sendBtn" title="Отправить сообщение (Enter)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>

      <div class="input-hint">
        <span>Render ⟷ Google API туннель</span>
        <span>Enter — отправить · Shift+Enter — перенос строки</span>
      </div>
    </div>
  </footer>

  <!-- System Prompt Modal -->
  <div class="modal-overlay" id="systemModal">
    <div class="modal-card">
      <div class="modal-header">
        <h3 class="modal-title">Системная инструкция (System Prompt)</h3>
        <button type="button" class="modal-close-btn" id="closeSystemModalBtn">✕</button>
      </div>
      <p style="font-size: 12px; color: var(--text-muted);">
        Укажите роль или правила поведения модели. Инструкция сохраняется в браузере и передается при каждом запросе.
      </p>

      <textarea id="systemPromptInput" class="system-textarea" placeholder="Например: Ты опытный Senior Full-Stack разработчик..."></textarea>

      <div class="presets-row">
        <button type="button" class="preset-btn" data-preset="dev">👨‍💻 Senior Dev</button>
        <button type="button" class="preset-btn" data-preset="concise">⚡ Краткий ответ</button>
        <button type="button" class="preset-btn" data-preset="translate">🌐 Переводчик</button>
        <button type="button" class="preset-btn" data-preset="clear">🧹 Очистить</button>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancelSystemBtn">Отмена</button>
        <button type="button" class="btn-primary" id="saveSystemBtn">Сохранить</button>
      </div>
    </div>
  </div>

  <script>
    // State management
    var STORAGE_KEY_PIN = 'gemini_proxy_pin';
    var STORAGE_KEY_MODEL = 'gemini_proxy_model';
    var STORAGE_KEY_SYSTEM = 'gemini_proxy_system_prompt';
    var STORAGE_KEY_HISTORY = 'gemini_proxy_chat_history';

    var conversationHistory = [];
    var isWaitingResponse = false;
    var pendingAttachment = null;
    var liveTimerInterval = null;
    var requestStartTime = 0;

    // DOM Elements
    var pinInput = document.getElementById('pinInput');
    var pinToggleBtn = document.getElementById('pinToggleBtn');
    var modelSelect = document.getElementById('modelSelect');
    var customModelInput = document.getElementById('customModelInput');
    var systemPromptBtn = document.getElementById('systemPromptBtn');
    var systemIndicator = document.getElementById('systemIndicator');
    var systemModal = document.getElementById('systemModal');
    var closeSystemModalBtn = document.getElementById('closeSystemModalBtn');
    var cancelSystemBtn = document.getElementById('cancelSystemBtn');
    var saveSystemBtn = document.getElementById('saveSystemBtn');
    var systemPromptInput = document.getElementById('systemPromptInput');
    var exportBtn = document.getElementById('exportBtn');
    var clearBtn = document.getElementById('clearBtn');
    var chatViewport = document.getElementById('chatViewport');
    var chatContainer = document.getElementById('chatContainer');
    var chatInput = document.getElementById('chatInput');
    var sendBtn = document.getElementById('sendBtn');
    var attachBtn = document.getElementById('attachBtn');
    var fileInput = document.getElementById('fileInput');
    var attachmentPreviewBar = document.getElementById('attachmentPreviewBar');
    var attachmentThumbnail = document.getElementById('attachmentThumbnail');
    var attachmentName = document.getElementById('attachmentName');
    var attachmentIcon = document.getElementById('attachmentIcon');
    var removeAttachmentBtn = document.getElementById('removeAttachmentBtn');
    var statusText = document.getElementById('statusText');

    // Markdown configuration
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(code, { language: lang }).value;
          } catch (_) {}
        }
        return hljs.highlightAuto(code).value;
      }
    });

    // Initialize application
    function initApp() {
      // Restore PIN
      var savedPin = localStorage.getItem(STORAGE_KEY_PIN) || '1234';
      pinInput.value = savedPin;

      // Restore Model
      var savedModel = localStorage.getItem(STORAGE_KEY_MODEL) || 'gemini-2.5-flash';
      var presetOption = Array.from(modelSelect.options).find(function(opt) { return opt.value === savedModel; });
      if (presetOption) {
        modelSelect.value = savedModel;
        customModelInput.style.display = 'none';
      } else {
        modelSelect.value = '__custom__';
        customModelInput.value = savedModel;
        customModelInput.style.display = 'inline-block';
      }

      // Restore System prompt
      var savedSystem = localStorage.getItem(STORAGE_KEY_SYSTEM) || '';
      systemPromptInput.value = savedSystem;
      updateSystemIndicator(savedSystem);

      // Restore Chat History
      try {
        var savedHistory = localStorage.getItem(STORAGE_KEY_HISTORY);
        if (savedHistory) {
          conversationHistory = JSON.parse(savedHistory);
        }
      } catch (e) {
        conversationHistory = [];
      }

      renderMessages();

      // Start Anti-Sleep Heartbeat
      pingServer();
      setInterval(pingServer, 240000); // Every 4 minutes
    }

    // Ping heartbeat function to keep Render container awake
    async function pingServer() {
      try {
        var res = await fetch('/ping');
        if (res.ok) {
          statusText.textContent = 'Онлайн';
        } else {
          statusText.textContent = 'Офлайн';
        }
      } catch (err) {
        statusText.textContent = 'Нет связи';
      }
    }

    // PIN toggle visibility
    pinToggleBtn.addEventListener('click', function() {
      if (pinInput.type === 'password') {
        pinInput.type = 'text';
      } else {
        pinInput.type = 'password';
      }
    });

    pinInput.addEventListener('input', function(e) {
      localStorage.setItem(STORAGE_KEY_PIN, e.target.value.trim());
    });

    // Model selection handling
    modelSelect.addEventListener('change', function() {
      if (modelSelect.value === '__custom__') {
        customModelInput.style.display = 'inline-block';
        customModelInput.focus();
        if (customModelInput.value.trim()) {
          localStorage.setItem(STORAGE_KEY_MODEL, customModelInput.value.trim());
        }
      } else {
        customModelInput.style.display = 'none';
        localStorage.setItem(STORAGE_KEY_MODEL, modelSelect.value);
      }
    });

    customModelInput.addEventListener('input', function() {
      localStorage.setItem(STORAGE_KEY_MODEL, customModelInput.value.trim());
    });

    function getSelectedModel() {
      if (modelSelect.value === '__custom__') {
        return customModelInput.value.trim() || 'gemini-2.5-flash';
      }
      return modelSelect.value;
    }

    // System prompt modal
    function updateSystemIndicator(text) {
      if (text && text.trim().length > 0) {
        systemIndicator.classList.add('active');
      } else {
        systemIndicator.classList.remove('active');
      }
    }

    systemPromptBtn.addEventListener('click', function() {
      systemPromptInput.value = localStorage.getItem(STORAGE_KEY_SYSTEM) || '';
      systemModal.classList.add('open');
      systemPromptInput.focus();
    });

    function closeSystemModal() {
      systemModal.classList.remove('open');
    }

    closeSystemModalBtn.addEventListener('click', closeSystemModal);
    cancelSystemBtn.addEventListener('click', closeSystemModal);

    saveSystemBtn.addEventListener('click', function() {
      var val = systemPromptInput.value.trim();
      localStorage.setItem(STORAGE_KEY_SYSTEM, val);
      updateSystemIndicator(val);
      closeSystemModal();
    });

    // Preset chips in modal
    document.querySelectorAll('.preset-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        var preset = e.target.dataset.preset;
        if (preset === 'dev') {
          systemPromptInput.value = 'Ты опытный Senior Full-Stack разработчик и архитектор ПО. Отвечай прямо, точно и профессионально. Предоставляй чистый, надежный, оптимизированный код.';
        } else if (preset === 'concise') {
          systemPromptInput.value = 'Отвечай максимально кратко, по существу, без вводных фраз и лишних пояснений.';
        } else if (preset === 'translate') {
          systemPromptInput.value = 'Ты профессиональный технический переводчик. Переводи точно, сохраняя структуру, терминологию и блоки кода без изменений.';
        } else if (preset === 'clear') {
          systemPromptInput.value = '';
        }
      });
    });

    // Auto-resizing textarea
    chatInput.addEventListener('input', function() {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
      updateSendButtonState();
    });

    chatInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    function updateSendButtonState() {
      var hasText = chatInput.value.trim().length > 0;
      var hasAttachment = Boolean(pendingAttachment);
      sendBtn.disabled = (!hasText && !hasAttachment) || isWaitingResponse;
    }

    // Attachment Handling
    attachBtn.addEventListener('click', function() {
      fileInput.click();
    });

    fileInput.addEventListener('change', function(e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;

      var fileName = file.name;
      var fileSize = (file.size / 1024).toFixed(1) + ' KB';

      if (file.type.startsWith('image/')) {
        var reader = new FileReader();
        reader.onload = function(event) {
          var dataUrl = event.target.result;
          pendingAttachment = {
            type: 'image',
            mimeType: file.type,
            data: dataUrl,
            name: fileName,
            sizeText: fileSize
          };
          showAttachmentPreview();
        };
        reader.readAsDataURL(file);
      } else {
        var txtReader = new FileReader();
        txtReader.onload = function(event) {
          var content = event.target.result;
          var ext = fileName.split('.').pop() || 'txt';
          pendingAttachment = {
            type: 'file',
            name: fileName,
            sizeText: fileSize,
            content: content,
            ext: ext
          };
          showAttachmentPreview();
        };
        txtReader.readAsText(file);
      }
      fileInput.value = '';
    });

    function showAttachmentPreview() {
      if (!pendingAttachment) {
        attachmentPreviewBar.classList.remove('active');
        updateSendButtonState();
        return;
      }

      attachmentName.textContent = pendingAttachment.name + ' (' + pendingAttachment.sizeText + ')';

      if (pendingAttachment.type === 'image') {
        attachmentThumbnail.src = pendingAttachment.data;
        attachmentThumbnail.style.display = 'block';
        attachmentIcon.style.display = 'none';
      } else {
        attachmentThumbnail.style.display = 'none';
        attachmentIcon.style.display = 'inline';
        attachmentIcon.textContent = '📄';
      }

      attachmentPreviewBar.classList.add('active');
      updateSendButtonState();
    }

    removeAttachmentBtn.addEventListener('click', function() {
      pendingAttachment = null;
      showAttachmentPreview();
    });

    // Render Chat Messages
    function renderMessages() {
      if (conversationHistory.length === 0) {
        chatContainer.innerHTML = [
          '<div class="empty-state">',
            '<div class="radio-badge">⚡ RENDER · EMERGENCY PROXY</div>',
            '<h1 class="empty-title">Gemini Proxy Chat</h1>',
            '<p class="empty-desc">',
              'Прямой туннель к моделям Google Gemini через ваш личный Node.js сервер на Render.',
              ' Работает без VPN с любых мобильных и настольных устройств.',
            '</p>',
            '<div class="features-grid">',
              '<div class="feature-card">',
                '<b>🛡️ Персональный PIN</b>',
                '<span>Каждый запрос защищен серверной проверкой.</span>',
              '</div>',
              '<div class="feature-card">',
                '<b>⚡ Zero-Build Node.js</b>',
                '<span>Быстрый старт, потребление памяти менее 35 МБ RAM.</span>',
              '</div>',
              '<div class="feature-card">',
                '<b>📎 Картинки и код</b>',
                '<span>Анализ прикрепленных изображений и файлов исходного кода.</span>',
              '</div>',
              '<div class="feature-card">',
                '<b>⏱️ Таймер и Markdown</b>',
                '<span>Подсветка синтаксиса и быстрое копирование кода в буфер.</span>',
              '</div>',
            '</div>',
            '<div class="starter-chips">',
              '<button class="chip-btn" onclick="sendPromptPreset(\\'Напиши надежный скрипт проверки пинга и восстановления сервиса на bash\\')">⚡ Bash скрипт пинга</button>',
              '<button class="chip-btn" onclick="sendPromptPreset(\\'Объясни просто, как устроен механизм Server-Sent Events (SSE) в Node.js\\')">🌐 Как устроен SSE</button>',
              '<button class="chip-btn" onclick="sendPromptPreset(\\'Как оптимизировать расход памяти в Express.js до минимума?\\')">🚀 Оптимизация Express</button>',
            '</div>',
          '</div>'
        ].join('');
        return;
      }

      chatContainer.innerHTML = '';

      conversationHistory.forEach(function(msg) {
        var row = document.createElement('div');
        row.className = 'msg-row ' + (msg.role === 'user' ? 'user' : 'bot');

        var avatar = document.createElement('div');
        avatar.className = 'avatar ' + (msg.role === 'user' ? 'user-avatar' : 'bot-avatar');
        avatar.innerHTML = msg.role === 'user' ? '👤' : '✨';

        var contentWrapper = document.createElement('div');
        contentWrapper.className = 'msg-content-wrapper';

        var bubble = document.createElement('div');
        bubble.className = 'msg-bubble';

        if (msg.role === 'user') {
          if (msg.image) {
            var img = document.createElement('img');
            img.className = 'msg-attachment-img';
            img.src = 'data:' + msg.image.mimeType + ';base64,' + msg.image.data;
            img.title = 'Нажмите для просмотра';
            img.onclick = function() {
              var w = window.open();
              if (w) {
                w.document.write('<img src="' + img.src + '" style="max-width:100%;height:auto;margin:auto;display:block;">');
              }
            };
            bubble.appendChild(img);
          }
          if (msg.fileName) {
            var fileBadge = document.createElement('div');
            fileBadge.className = 'msg-attachment-file';
            fileBadge.textContent = '📄 ' + msg.fileName;
            bubble.appendChild(fileBadge);
          }
          var textNode = document.createElement('div');
          textNode.textContent = msg.text;
          bubble.appendChild(textNode);
        } else {
          bubble.innerHTML = marked.parse(msg.text || '');
          decorateCodeBlocks(bubble);
        }

        contentWrapper.appendChild(bubble);

        var meta = document.createElement('div');
        meta.className = 'msg-meta';
        var timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        if (msg.role === 'model' && msg.duration) {
          meta.innerHTML = '<span>' + timeStr + '</span> <span class="timer-badge">⏱️ ' + (msg.duration / 1000).toFixed(2) + 's</span>';
        } else {
          meta.innerHTML = '<span>' + timeStr + '</span>';
        }
        contentWrapper.appendChild(meta);

        if (msg.role === 'user') {
          row.appendChild(contentWrapper);
          row.appendChild(avatar);
        } else {
          row.appendChild(avatar);
          row.appendChild(contentWrapper);
        }

        chatContainer.appendChild(row);
      });

      scrollChatToBottom();
    }

    // Helper for starter chips
    window.sendPromptPreset = function(text) {
      chatInput.value = text;
      chatInput.focus();
      sendMessage();
    };

    // Decorate code blocks with headers and copy buttons
    function decorateCodeBlocks(container) {
      var pres = container.querySelectorAll('pre');
      pres.forEach(function(pre) {
        if (pre.parentElement.classList.contains('code-container')) return;

        var code = pre.querySelector('code');
        var langMatch = code ? code.className.match(/language-([a-z0-9_-]+)/i) : null;
        var lang = langMatch ? langMatch[1] : 'code';

        var wrapper = document.createElement('div');
        wrapper.className = 'code-container';

        var header = document.createElement('div');
        header.className = 'code-header';
        header.innerHTML = [
          '<span>' + lang + '</span>',
          '<button type="button" class="copy-btn">',
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">',
              '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>',
              '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
            '</svg>',
            '<span>Копировать</span>',
          '</button>'
        ].join('');

        var copyBtn = header.querySelector('.copy-btn');
        copyBtn.addEventListener('click', async function() {
          var rawCode = code ? code.innerText : pre.innerText;
          try {
            await navigator.clipboard.writeText(rawCode);
            copyBtn.innerHTML = '<span>Скопировано! ✓</span>';
            setTimeout(function() {
              copyBtn.innerHTML = [
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">',
                  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>',
                  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
                '</svg>',
                '<span>Копировать</span>'
              ].join('');
            }, 2000);
          } catch (err) {
            copyBtn.textContent = 'Ошибка';
          }
        });

        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(header);
        wrapper.appendChild(pre);
      });
    }

    function scrollChatToBottom() {
      chatViewport.scrollTop = chatViewport.scrollHeight;
    }

    // Send Message
    async function sendMessage() {
      var text = chatInput.value.trim();
      var att = pendingAttachment;

      if ((!text && !att) || isWaitingResponse) return;

      var pin = pinInput.value.trim();
      if (!pin) {
        showErrorMessage('Пожалуйста, введите PIN-код в верхней панели (по умолчанию 1234)');
        pinInput.focus();
        return;
      }

      // Format user message
      var fullText = text;
      var attachedImage = null;
      var attachedFileName = null;

      if (att) {
        if (att.type === 'image') {
          var cleanBase64 = att.data.includes(',') ? att.data.split(',')[1] : att.data;
          attachedImage = {
            mimeType: att.mimeType,
            data: cleanBase64
          };
          attachedFileName = att.name;
        } else if (att.type === 'file') {
          attachedFileName = att.name;
          var codeBlock = String.fromCharCode(10, 10, 96, 96, 96) + att.ext + String.fromCharCode(10) + '// [Файл: ' + att.name + ']' + String.fromCharCode(10) + att.content + String.fromCharCode(10, 96, 96, 96, 10);
          fullText = fullText ? (fullText + codeBlock) : ('[Прикрепленный файл: ' + att.name + ']' + codeBlock);
        }
      }

      var userMessage = {
        role: 'user',
        text: fullText,
        image: attachedImage,
        fileName: attachedFileName,
        timestamp: Date.now()
      };

      conversationHistory.push(userMessage);
      saveHistory();

      // Reset input area
      chatInput.value = '';
      chatInput.style.height = 'auto';
      pendingAttachment = null;
      showAttachmentPreview();
      renderMessages();

      // Create live waiting / thinking indicator
      showThinkingIndicator();
      await executeApiCall();
    }

    function showThinkingIndicator() {
      isWaitingResponse = true;
      updateSendButtonState();
      requestStartTime = Date.now();

      var thinkingRow = document.createElement('div');
      thinkingRow.className = 'msg-row bot';
      thinkingRow.id = 'thinkingRow';

      thinkingRow.innerHTML = [
        '<div class="avatar bot-avatar">✨</div>',
        '<div class="msg-content-wrapper">',
          '<div class="thinking-card">',
            '<div class="spinner"></div>',
            '<span>Генерация ответа через Render прокси...</span>',
            '<span class="timer-badge" id="liveTimer">⏱️ 0.0s</span>',
          '</div>',
        '</div>'
      ].join('');

      chatContainer.appendChild(thinkingRow);
      scrollChatToBottom();

      var timerSpan = document.getElementById('liveTimer');
      liveTimerInterval = setInterval(function() {
        var elapsed = (Date.now() - requestStartTime) / 1000;
        if (timerSpan) {
          timerSpan.textContent = '⏱️ ' + elapsed.toFixed(1) + 's';
        }
      }, 100);
    }

    function removeThinkingIndicator() {
      if (liveTimerInterval) {
        clearInterval(liveTimerInterval);
        liveTimerInterval = null;
      }
      var row = document.getElementById('thinkingRow');
      if (row) row.remove();
      isWaitingResponse = false;
      updateSendButtonState();
    }

    async function executeApiCall() {
      var pin = pinInput.value.trim();
      var model = getSelectedModel();
      var systemInstruction = localStorage.getItem(STORAGE_KEY_SYSTEM) || '';

      var contentsPayload = conversationHistory.map(function(item) {
        var parts = [];
        if (item.image) {
          parts.push({
            inlineData: {
              mimeType: item.image.mimeType,
              data: item.image.data
            }
          });
        }
        if (item.text) {
          parts.push({ text: item.text });
        }
        if (parts.length === 0) {
          parts.push({ text: ' ' });
        }
        return {
          role: item.role === 'model' ? 'model' : 'user',
          parts: parts
        };
      });

      try {
        var res = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-pin': pin
          },
          body: JSON.stringify({
            pin: pin,
            model: model,
            contents: contentsPayload,
            systemInstruction: systemInstruction,
            temperature: 0.7
          })
        });

        var elapsedMs = Date.now() - requestStartTime;
        removeThinkingIndicator();

        if (!res.ok) {
          var errData = await res.json().catch(function() { return {}; });
          var errMsg = errData.error || ('Ошибка сервера (HTTP ' + res.status + ')');
          showErrorMessage(errMsg);
          return;
        }

        var data = await res.json();
        var botReply = data.reply || 'Пустой ответ.';

        conversationHistory.push({
          role: 'model',
          text: botReply,
          timestamp: Date.now(),
          duration: elapsedMs
        });

        saveHistory();
        renderMessages();

      } catch (err) {
        removeThinkingIndicator();
        showErrorMessage('Сетевая ошибка: ' + (err.message || 'Не удалось связаться с сервером.'));
      }
    }

    function showErrorMessage(errorText) {
      var errRow = document.createElement('div');
      errRow.className = 'msg-row bot';
      errRow.innerHTML = [
        '<div class="avatar bot-avatar" style="background:#ef4444;">⚠️</div>',
        '<div class="msg-content-wrapper">',
          '<div class="error-card">',
            '<div>' + escapeHtml(errorText) + '</div>',
            '<button type="button" class="retry-btn" onclick="retryLastMessage()">',
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">',
                '<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>',
              '</svg>',
              'Повторить попытку',
            '</button>',
          '</div>',
        '</div>'
      ].join('');
      chatContainer.appendChild(errRow);
      scrollChatToBottom();
    }

    window.retryLastMessage = function() {
      document.querySelectorAll('.error-card').forEach(function(el) {
        var row = el.closest('.msg-row');
        if (row) row.remove();
      });

      if (conversationHistory.length > 0 && conversationHistory[conversationHistory.length - 1].role === 'user') {
        showThinkingIndicator();
        executeApiCall();
      }
    };

    function escapeHtml(str) {
      var div = document.createElement('div');
      div.innerText = str;
      return div.innerHTML;
    }

    function saveHistory() {
      try {
        localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(conversationHistory));
      } catch (e) {
        console.warn('LocalStorage limit reached', e);
      }
    }

    // Export conversation to Markdown
    exportBtn.addEventListener('click', function() {
      if (conversationHistory.length === 0) {
        showErrorMessage('Диалог пуст. Нечего экспортировать.');
        return;
      }

      var dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
      var model = getSelectedModel();

      var md = '# Gemini Chat Export\\n';
      md += '- **Дата:** ' + dateStr + '\\n';
      md += '- **Модель:** ' + model + '\\n';
      var sys = localStorage.getItem(STORAGE_KEY_SYSTEM);
      if (sys) {
        md += '- **Системный промпт:** ' + sys + '\\n';
      }
      md += '\\n---\\n\\n';

      conversationHistory.forEach(function(msg) {
        if (msg.role === 'user') {
          md += '### 👤 Пользователь\\n\\n' + msg.text + '\\n\\n';
        } else {
          md += '### ✨ Gemini (' + model + ')\\n\\n' + msg.text + '\\n\\n---\\n\\n';
        }
      });

      var blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'gemini-chat-' + new Date().toISOString().slice(0, 10) + '.md';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    // Clear history
    clearBtn.addEventListener('click', function() {
      if (conversationHistory.length === 0) return;
      if (confirm('Очистить всю историю диалога?')) {
        conversationHistory = [];
        localStorage.removeItem(STORAGE_KEY_HISTORY);
        renderMessages();
      }
    });

    // Start on DOM ready
    window.addEventListener('DOMContentLoaded', initApp);
  </script>
</body>
</html>
`;

// Serve the Single-Page Application on GET /
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML_CONTENT);
});

// Fallback for any unknown route -> redirect to /
app.get('*', (req, res) => {
  res.redirect('/');
});

// Start Server
app.listen(PORT, HOST, () => {
  console.log(`[Gemini Proxy] Сервер запущен на http://${HOST}:${PORT}`);
  console.log(`[Gemini Proxy] Uptime пинг доступен на /ping`);
});
