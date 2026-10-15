/**
 * Gemini Proxy Chat - Client Application Logic (v2.0)
 * Features: SSE Streaming, BYOK & PIN Auth, Temperature & Token Controls,
 * History Trimming, Markdown Rendering with Code Highlighting & Copy,
 * File Attachments, Theme Switcher, and Export.
 */

(function () {
  'use strict';

  // --- Constants & Storage Keys ---
  const STORAGE_KEYS = {
    MESSAGES: 'gemini_chat_history',
    API_KEY: 'gemini_custom_api_key',
    PIN: 'gemini_access_pin',
    MODEL: 'gemini_selected_model',
    TEMPERATURE: 'gemini_temperature',
    MAX_TOKENS: 'gemini_max_tokens',
    SYSTEM_PROMPT: 'gemini_system_prompt',
    THEME: 'gemini_theme'
  };

  // --- State ---
  let messages = [];
  let attachments = [];
  let isGenerating = false;
  let activeAbortController = null;
  let serverStatus = { serverHasOwnerKey: false, serverHasOwnerPin: false };

  // --- DOM Elements ---
  const el = {
    // Header
    authStatusBtn: document.getElementById('authStatusBtn'),
    authStatusText: document.getElementById('authStatusText'),
    modelSelect: document.getElementById('modelSelect'),
    tempRange: document.getElementById('tempRange'),
    tempVal: document.getElementById('tempVal'),
    maxTokensSelect: document.getElementById('maxTokensSelect'),
    msgCountBadge: document.getElementById('msgCountBadge'),
    trimHistoryBtn: document.getElementById('trimHistoryBtn'),
    systemPromptBtn: document.getElementById('systemPromptBtn'),
    exportBtn: document.getElementById('exportBtn'),
    clearChatBtn: document.getElementById('clearChatBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    settingsBtn: document.getElementById('settingsBtn'),

    // Chat
    chatContainer: document.getElementById('chatContainer'),
    historyWarningBanner: document.getElementById('historyWarningBanner'),
    quickTrimBtn: document.getElementById('quickTrimBtn'),
    welcomeHero: document.getElementById('welcomeHero'),
    messageList: document.getElementById('messageList'),

    // Input
    attachmentBar: document.getElementById('attachmentBar'),
    attachBtn: document.getElementById('attachBtn'),
    fileInput: document.getElementById('fileInput'),
    userInput: document.getElementById('userInput'),
    sendBtn: document.getElementById('sendBtn'),
    sendBtnIcon: document.getElementById('sendBtnIcon'),
    sendBtnText: document.getElementById('sendBtnText'),

    // Modals
    authModal: document.getElementById('authModal'),
    userApiKeyInput: document.getElementById('userApiKeyInput'),
    toggleApiKeyVisBtn: document.getElementById('toggleApiKeyVisBtn'),
    saveApiKeyBtn: document.getElementById('saveApiKeyBtn'),
    deleteApiKeyBtn: document.getElementById('deleteApiKeyBtn'),
    ownerPinInput: document.getElementById('ownerPinInput'),
    togglePinVisBtn: document.getElementById('togglePinVisBtn'),
    savePinBtn: document.getElementById('savePinBtn'),
    deletePinBtn: document.getElementById('deletePinBtn'),

    systemPromptModal: document.getElementById('systemPromptModal'),
    systemPromptInput: document.getElementById('systemPromptInput'),
    saveSysPromptBtn: document.getElementById('saveSysPromptBtn'),
    clearSysPromptBtn: document.getElementById('clearSysPromptBtn'),

    trimModal: document.getElementById('trimModal'),
    trimTo10Btn: document.getElementById('trimTo10Btn'),
    trimTo20Btn: document.getElementById('trimTo20Btn'),
    trimTo30Btn: document.getElementById('trimTo30Btn')
  };

  // --- Initializer ---
  function init() {
    loadSettings();
    initTheme();
    initMarkdown();
    loadMessages();
    setupEventListeners();
    fetchServerStatus();
    updateUIState();
  }

  // --- Settings Persistence ---
  function loadSettings() {
    // Model
    const savedModel = localStorage.getItem(STORAGE_KEYS.MODEL) || 'gemini-3.5-flash';
    let optionExists = false;
    for (const opt of el.modelSelect.options) {
      if (opt.value === savedModel) {
        opt.selected = true;
        optionExists = true;
        break;
      }
    }
    if (!optionExists && savedModel && savedModel !== '__custom__') {
      const customOpt = new Option(savedModel + ' (Кастомная)', savedModel, true, true);
      el.modelSelect.add(customOpt, el.modelSelect.options[el.modelSelect.options.length - 1]);
    }

    // Temperature (P1)
    const savedTemp = localStorage.getItem(STORAGE_KEYS.TEMPERATURE) || '0.7';
    el.tempRange.value = savedTemp;
    el.tempVal.textContent = savedTemp;

    // Max tokens (P2)
    const savedMaxTokens = localStorage.getItem(STORAGE_KEYS.MAX_TOKENS) || 'auto';
    el.maxTokensSelect.value = savedMaxTokens;

    // Keys in Inputs
    const savedKey = localStorage.getItem(STORAGE_KEYS.API_KEY) || '';
    el.userApiKeyInput.value = savedKey;

    const savedPin = localStorage.getItem(STORAGE_KEYS.PIN) || '';
    el.ownerPinInput.value = savedPin;

    // System prompt
    el.systemPromptInput.value = localStorage.getItem(STORAGE_KEYS.SYSTEM_PROMPT) || '';
  }

  // --- Theme Management ---
  function initTheme() {
    const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || 
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    applyTheme(savedTheme);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
    el.themeToggleBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
    el.themeToggleBtn.title = theme === 'dark' ? 'Переключить на светлую тему' : 'Переключить на тёмную тему';
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  // --- Markdown Setup ---
  function initMarkdown() {
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,
        gfm: true,
        highlight: function (code, lang) {
          if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            try {
              return hljs.highlight(code, { language: lang }).value;
            } catch {}
          }
          if (typeof hljs !== 'undefined') {
            try {
              return hljs.highlightAuto(code).value;
            } catch {}
          }
          return code;
        }
      });
    }
  }

  // --- Server Status Check ---
  async function fetchServerStatus() {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        serverStatus = await res.json();
      }
    } catch (e) {
      console.warn('[Proxy Client] Server status check notice:', e.message);
    }
    updateAuthBadge();
  }

  // --- Auth Status UI ---
  function updateAuthBadge() {
    const key = (localStorage.getItem(STORAGE_KEYS.API_KEY) || '').trim();
    const pin = (localStorage.getItem(STORAGE_KEYS.PIN) || '').trim();

    el.authStatusBtn.className = 'auth-badge';

    if (key) {
      el.authStatusBtn.classList.add('active-byok');
      el.authStatusText.textContent = 'Свой ключ (BYOK)';
      el.authStatusBtn.title = 'Используется ваш личный Gemini API Key. Нажмите для изменения.';
    } else if (pin) {
      el.authStatusBtn.classList.add('active-pin');
      el.authStatusText.textContent = 'Owner PIN';
      el.authStatusBtn.title = 'Активен PIN владельца сервера. Нажмите для изменения.';
    } else {
      el.authStatusBtn.classList.add('no-key');
      el.authStatusText.textContent = 'Ключ не задан';
      el.authStatusBtn.title = 'Нажмите здесь, чтобы ввести Gemini API Key для работы с чатом.';
    }
  }

  // --- Message Persistence ---
  function loadMessages() {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.MESSAGES);
      if (stored) {
        messages = JSON.parse(stored);
      }
    } catch (e) {
      console.error('Failed to parse messages from localStorage:', e);
      messages = [];
    }
    renderAllMessages();
  }

  function saveMessages() {
    try {
      localStorage.setItem(STORAGE_KEYS.MESSAGES, JSON.stringify(messages));
    } catch (e) {
      console.warn('Failed to save to localStorage (quota exceeded?):', e);
      // If quota exceeded due to big images, attempt saving text only
      try {
        const textOnlyMessages = messages.map(m => {
          return {
            ...m,
            parts: m.parts.map(p => p.inlineData ? { text: '[Прикрепленное медиа]' } : p)
          };
        });
        localStorage.setItem(STORAGE_KEYS.MESSAGES, JSON.stringify(textOnlyMessages));
      } catch {}
    }
    updateUIState();
  }

  // --- Render Messages ---
  function renderAllMessages() {
    el.messageList.innerHTML = '';

    if (messages.length === 0) {
      el.welcomeHero.style.display = 'block';
    } else {
      el.welcomeHero.style.display = 'none';
      messages.forEach((msg, index) => {
        const itemEl = createMessageElement(msg, index);
        el.messageList.appendChild(itemEl);
      });
    }

    scrollToBottom();
    updateUIState();
  }

  function createMessageElement(msg, index) {
    const isUser = msg.role === 'user';
    const item = document.createElement('div');
    item.className = `message-item ${isUser ? 'user' : 'assistant'}`;
    item.dataset.index = index;

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = isUser ? '👤' : '⚡';
    item.appendChild(avatar);

    // Body
    const body = document.createElement('div');
    body.className = 'msg-body';

    // Header info
    const header = document.createElement('div');
    header.className = 'msg-header';
    const roleName = isUser ? 'Вы' : (msg.model || 'Gemini');
    const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    header.innerHTML = `<span>${escapeHtml(roleName)}</span> <span>${timeStr}</span>`;
    body.appendChild(header);

    // Bubble
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    // If user message with media attachments
    if (isUser && Array.isArray(msg.parts)) {
      const mediaParts = msg.parts.filter(p => p.inlineData);
      if (mediaParts.length > 0) {
        const attachBox = document.createElement('div');
        attachBox.className = 'msg-attachments';
        mediaParts.forEach(m => {
          if (m.inlineData.mimeType.startsWith('image/')) {
            const img = document.createElement('img');
            img.className = 'msg-img-thumb';
            img.src = `data:${m.inlineData.mimeType};base64,${m.inlineData.data}`;
            img.alt = 'Вложение';
            attachBox.appendChild(img);
          } else {
            const pill = document.createElement('div');
            pill.className = 'msg-file-pill';
            pill.innerHTML = `📄 <span>${escapeHtml(m.inlineData.mimeType)}</span>`;
            attachBox.appendChild(pill);
          }
        });
        bubble.appendChild(attachBox);
      }
    }

    // Main text
    const textPart = (msg.parts || []).find(p => typeof p.text === 'string')?.text || '';
    if (textPart) {
      const textContainer = document.createElement('div');
      if (typeof marked !== 'undefined') {
        textContainer.innerHTML = marked.parse(textPart);
      } else {
        textContainer.textContent = textPart;
      }
      enhanceCodeBlocks(textContainer);
      bubble.appendChild(textContainer);
    }

    // Aborted notice
    if (msg.aborted) {
      const abortedBadge = document.createElement('span');
      abortedBadge.className = 'aborted-badge';
      abortedBadge.textContent = '⏹ (Генерация остановлена пользователем)';
      bubble.appendChild(abortedBadge);
    } else if (msg.finishReason && msg.finishReason !== 'STOP') {
      const finishBadge = document.createElement('span');
      finishBadge.className = 'aborted-badge';
      if (msg.finishReason === 'MAX_TOKENS') {
        finishBadge.textContent = '⚠️ Достигнут лимит токенов генерации (MAX_TOKENS)';
      } else if (msg.finishReason === 'SAFETY') {
        finishBadge.textContent = '🛡️ Остановлено фильтром безопасности (SAFETY)';
      } else {
        finishBadge.textContent = `ℹ️ Завершено по причине: ${escapeHtml(msg.finishReason)}`;
      }
      bubble.appendChild(finishBadge);
    }

    body.appendChild(bubble);

    // Assistant Footer (Metadata & Actions)
    if (!isUser) {
      const footer = document.createElement('div');
      footer.className = 'msg-footer';

      // Usage tokens (P2)
      if (msg.usage) {
        const totalTokens = msg.usage.totalTokenCount || 
          ((msg.usage.promptTokenCount || 0) + (msg.usage.candidatesTokenCount || 0));
        if (totalTokens) {
          const usageSpan = document.createElement('span');
          usageSpan.className = 'meta-badge';
          usageSpan.title = `Входных токенов: ${msg.usage.promptTokenCount || 0}, выходных: ${msg.usage.candidatesTokenCount || 0}`;
          usageSpan.innerHTML = `⚡ ${totalTokens} токенов`;
          footer.appendChild(usageSpan);
        }
      }

      // Copy text button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'msg-action-btn';
      copyBtn.innerHTML = '📋 Копировать';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(textPart).then(() => {
          copyBtn.innerHTML = '✅ Скопировано';
          setTimeout(() => { copyBtn.innerHTML = '📋 Копировать'; }, 1500);
        });
      };
      footer.appendChild(copyBtn);

      // Retry button
      const retryBtn = document.createElement('button');
      retryBtn.className = 'msg-action-btn';
      retryBtn.innerHTML = '🔄 Повторить';
      retryBtn.onclick = () => retryFromMessage(index);
      footer.appendChild(retryBtn);

      body.appendChild(footer);
    }

    item.appendChild(body);
    return item;
  }

  // --- Code Blocks Enhancement ---
  function enhanceCodeBlocks(container) {
    const preBlocks = container.querySelectorAll('pre');
    preBlocks.forEach(pre => {
      if (pre.querySelector('.code-header')) return;

      const code = pre.querySelector('code');
      const lang = code ? (code.className.match(/language-([a-z0-9_-]+)/i)?.[1] || 'code') : 'code';

      const header = document.createElement('div');
      header.className = 'code-header';
      header.innerHTML = `
        <span>${escapeHtml(lang)}</span>
        <button type="button" class="copy-code-btn">Копировать</button>
      `;

      const copyBtn = header.querySelector('.copy-code-btn');
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        const codeText = code ? code.innerText : pre.innerText;
        navigator.clipboard.writeText(codeText).then(() => {
          copyBtn.textContent = 'Скопировано!';
          setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1500);
        });
      };

      pre.insertBefore(header, pre.firstChild);
    });
  }

  // --- UI State & Counter Updates ---
  function updateUIState() {
    const count = messages.length;
    el.msgCountBadge.textContent = `${count} сообщ.`;

    // History warning for > 40 messages (P1)
    if (count > 40) {
      el.historyWarningBanner.style.display = 'flex';
    } else {
      el.historyWarningBanner.style.display = 'none';
    }
  }

  // --- History Trimming (P1) ---
  function trimHistory(keepCount) {
    if (messages.length <= keepCount) {
      alert(`В истории всего ${messages.length} сообщений (меньше или равно ${keepCount}).`);
      return;
    }
    const removedCount = messages.length - keepCount;
    messages = messages.slice(-keepCount);
    saveMessages();
    renderAllMessages();
    closeAllModals();
    showToast(`Обрезано ${removedCount} старых сообщений. Оставлено последних ${keepCount}.`);
  }

  // --- Event Listeners ---
  function setupEventListeners() {
    // Model change
    el.modelSelect.addEventListener('change', () => {
      if (el.modelSelect.value === '__custom__') {
        const customName = prompt('Введите точное название модели Gemini (например, gemini-3.5-flash):');
        if (customName && customName.trim()) {
          const val = customName.trim();
          const newOpt = new Option(val + ' (Кастомная)', val, true, true);
          el.modelSelect.add(newOpt, el.modelSelect.options[el.modelSelect.options.length - 1]);
          localStorage.setItem(STORAGE_KEYS.MODEL, val);
        } else {
          el.modelSelect.value = localStorage.getItem(STORAGE_KEYS.MODEL) || 'gemini-3.5-flash';
        }
      } else {
        localStorage.setItem(STORAGE_KEYS.MODEL, el.modelSelect.value);
      }
    });

    // Temperature Slider (P1)
    el.tempRange.addEventListener('input', () => {
      el.tempVal.textContent = el.tempRange.value;
    });
    el.tempRange.addEventListener('change', () => {
      localStorage.setItem(STORAGE_KEYS.TEMPERATURE, el.tempRange.value);
    });

    // Max Tokens Select (P2)
    el.maxTokensSelect.addEventListener('change', () => {
      localStorage.setItem(STORAGE_KEYS.MAX_TOKENS, el.maxTokensSelect.value);
    });

    // Theme Toggle
    el.themeToggleBtn.addEventListener('click', toggleTheme);

    // Auth & Settings Buttons
    el.authStatusBtn.addEventListener('click', () => openModal('authModal'));
    el.settingsBtn.addEventListener('click', () => openModal('authModal'));

    // Trim History Buttons
    el.trimHistoryBtn.addEventListener('click', () => openModal('trimModal'));
    el.quickTrimBtn.addEventListener('click', () => trimHistory(20));
    el.trimTo10Btn.addEventListener('click', () => trimHistory(10));
    el.trimTo20Btn.addEventListener('click', () => trimHistory(20));
    el.trimTo30Btn.addEventListener('click', () => trimHistory(30));

    // Clear Chat
    el.clearChatBtn.addEventListener('click', () => {
      if (messages.length === 0) return;
      if (confirm('Вы уверены, что хотите полностью очистить историю диалога?')) {
        messages = [];
        saveMessages();
        renderAllMessages();
      }
    });

    // Export Markdown
    el.exportBtn.addEventListener('click', exportToMarkdown);

    // System Prompt Modal
    el.systemPromptBtn.addEventListener('click', () => openModal('systemPromptModal'));
    el.saveSysPromptBtn.addEventListener('click', () => {
      localStorage.setItem(STORAGE_KEYS.SYSTEM_PROMPT, el.systemPromptInput.value.trim());
      closeAllModals();
      showToast('Системный промпт сохранен!');
    });
    el.clearSysPromptBtn.addEventListener('click', () => {
      el.systemPromptInput.value = '';
      localStorage.removeItem(STORAGE_KEYS.SYSTEM_PROMPT);
      showToast('Системный промпт сброшен');
    });

    // Preset Chips
    document.querySelectorAll('.preset-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        el.systemPromptInput.value = chip.dataset.preset;
      });
    });

    // Modals Close
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.close;
        const target = document.getElementById(modalId);
        if (target) target.classList.add('hidden');
      });
    });

    window.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) {
        e.target.classList.add('hidden');
      }
    });

    // BYOK Key Actions
    el.saveApiKeyBtn.addEventListener('click', () => {
      const key = el.userApiKeyInput.value.trim();
      if (!key) {
        alert('Пожалуйста, введите ваш Google Gemini API Key.');
        return;
      }
      if (!/^AIzaSy[A-Za-z0-9_-]{33}$/.test(key)) {
        alert('Некорректный формат Google Gemini API Key. Ключ должен начинаться с "AIzaSy" и содержать ровно 39 символов.');
        return;
      }
      localStorage.setItem(STORAGE_KEYS.API_KEY, key);
      updateAuthBadge();
      closeAllModals();
      showToast('API-ключ сохранён в браузере!');
    });

    el.deleteApiKeyBtn.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEYS.API_KEY);
      el.userApiKeyInput.value = '';
      updateAuthBadge();
      showToast('API-ключ удален из браузера');
    });

    el.toggleApiKeyVisBtn.addEventListener('click', () => {
      const isPass = el.userApiKeyInput.type === 'password';
      el.userApiKeyInput.type = isPass ? 'text' : 'password';
      el.toggleApiKeyVisBtn.textContent = isPass ? '🔒' : '👁️';
    });

    // Owner PIN Actions
    el.savePinBtn.addEventListener('click', () => {
      const pin = el.ownerPinInput.value.trim();
      if (!pin) {
        alert('Введите административный PIN.');
        return;
      }
      localStorage.setItem(STORAGE_KEYS.PIN, pin);
      updateAuthBadge();
      closeAllModals();
      showToast('PIN сохранен в браузере!');
    });

    el.deletePinBtn.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEYS.PIN);
      el.ownerPinInput.value = '';
      updateAuthBadge();
      showToast('PIN удален');
    });

    el.togglePinVisBtn.addEventListener('click', () => {
      const isPass = el.ownerPinInput.type === 'password';
      el.ownerPinInput.type = isPass ? 'text' : 'password';
      el.togglePinVisBtn.textContent = isPass ? '🔒' : '👁️';
    });

    // File Attachments
    el.attachBtn.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', handleFileSelection);

    // Chat Input Auto-Resize & Key Handling
    el.userInput.addEventListener('input', autoResizeTextarea);
    el.userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });

    // Send / Stop Generation Button
    el.sendBtn.addEventListener('click', () => {
      if (isGenerating) {
        stopGeneration();
      } else {
        handleSendMessage();
      }
    });
  }

  // --- Modal Helpers ---
  function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('hidden');
  }

  function closeAllModals() {
    document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.add('hidden'));
  }

  function autoResizeTextarea() {
    el.userInput.style.height = 'auto';
    el.userInput.style.height = Math.min(el.userInput.scrollHeight, 160) + 'px';
  }

  function scrollToBottom() {
    el.chatContainer.scrollTop = el.chatContainer.scrollHeight;
  }

  function showToast(text) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
      box-shadow: var(--shadow-md);
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
      z-index: 1000;
      animation: fadeIn 0.2s ease-out;
    `;
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  // --- File Attachments Handling ---
  async function handleFileSelection(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        alert(`Файл ${file.name} слишком большой (максимум 20 МБ).`);
        continue;
      }

      if (file.type.startsWith('image/')) {
        const base64 = await readFileAsBase64(file);
        attachments.push({
          name: file.name,
          type: 'image',
          mimeType: file.type,
          data: base64
        });
      } else {
        // Text / Code file
        const textContent = await readFileAsText(file);
        attachments.push({
          name: file.name,
          type: 'text',
          mimeType: file.type || 'text/plain',
          textContent: textContent
        });
      }
    }

    el.fileInput.value = '';
    renderAttachmentPreviews();
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  function renderAttachmentPreviews() {
    if (attachments.length === 0) {
      el.attachmentBar.style.display = 'none';
      el.attachmentBar.innerHTML = '';
      return;
    }

    el.attachmentBar.style.display = 'flex';
    el.attachmentBar.innerHTML = '';

    attachments.forEach((att, i) => {
      const tag = document.createElement('div');
      tag.className = 'attach-tag';
      const icon = att.type === 'image' ? '🖼️' : '📄';
      tag.innerHTML = `
        <span>${icon} ${escapeHtml(att.name)}</span>
        <button type="button" class="attach-tag-remove" title="Удалить">✕</button>
      `;
      tag.querySelector('.attach-tag-remove').onclick = () => {
        attachments.splice(i, 1);
        renderAttachmentPreviews();
      };
      el.attachmentBar.appendChild(tag);
    });
  }

  // --- Stop Generation (P0 + P1) ---
  function stopGeneration() {
    if (activeAbortController) {
      activeAbortController.abort();
    }
  }

  // --- Core Chat Request & Streaming Logic (P1 / v2.1 Refactoring) ---
  async function executeChatRequest({ isRetry = false } = {}) {
    if (isGenerating) return;

    // Check Auth Credentials
    const apiKey = (localStorage.getItem(STORAGE_KEYS.API_KEY) || '').trim();
    const pin = (localStorage.getItem(STORAGE_KEYS.PIN) || '').trim();

    if (!apiKey && !pin) {
      openModal('authModal');
      el.userApiKeyInput.focus();
      alert('Для отправки сообщений укажите ваш Google Gemini API Key или Owner PIN в настройках.');
      return;
    }

    if (messages.length === 0) return;

    // Model, temperature, tokens, system instruction
    const currentModel = el.modelSelect.value === '__custom__' ? 
      (localStorage.getItem(STORAGE_KEYS.MODEL) || 'gemini-3.5-flash') : el.modelSelect.value;
    const currentTemp = parseFloat(el.tempRange.value) || 0.7;
    const currentMaxTokens = el.maxTokensSelect.value !== 'auto' ? parseInt(el.maxTokensSelect.value) : undefined;
    const sysPrompt = localStorage.getItem(STORAGE_KEYS.SYSTEM_PROMPT) || '';

    // Prepare Assistant Message Placeholder in DOM and State
    const assistantPlaceholder = {
      role: 'model',
      parts: [{ text: '' }],
      timestamp: Date.now(),
      model: currentModel
    };

    const assistantIndex = messages.length;
    messages.push(assistantPlaceholder);

    const assistantEl = createMessageElement(assistantPlaceholder, assistantIndex);
    el.messageList.appendChild(assistantEl);
    scrollToBottom();

    const bubbleEl = assistantEl.querySelector('.msg-bubble');
    bubbleEl.innerHTML = '<span class="streaming-cursor"></span>';

    // Enter Generating State
    isGenerating = true;
    el.sendBtn.classList.add('stop-mode');
    el.sendBtnIcon.textContent = '⏹';
    el.sendBtnText.textContent = 'Прервать';
    el.userInput.disabled = true;

    activeAbortController = new AbortController();

    let accumulatedText = '';
    let finalUsage = null;
    let finalModel = currentModel;
    let finalFinishReason = null;
    let wasAborted = false;

    try {
      // Build request contents for server (all messages except assistant placeholder)
      const reqContents = messages.slice(0, -1).map(m => ({
        role: m.role,
        parts: m.parts
      }));

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-gemini-api-key': apiKey,
          'x-access-pin': pin
        },
        body: JSON.stringify({
          model: currentModel,
          contents: reqContents,
          systemInstruction: sysPrompt,
          temperature: currentTemp,
          maxOutputTokens: currentMaxTokens,
          stream: true // Enable SSE Streaming
        }),
        signal: activeAbortController.signal
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Ошибка сервера (${response.status})`);
      }

      // Check if response is Event-Stream
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream')) {
        // Read SSE Stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Keep partial line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            const dataContent = trimmed.slice(5).trim();
            if (dataContent === '[DONE]') break;

            try {
              const parsed = JSON.parse(dataContent);
              if (parsed.text) {
                accumulatedText += parsed.text;
                // Live render markdown + cursor
                bubbleEl.innerHTML = marked.parse(accumulatedText) + '<span class="streaming-cursor"></span>';
                enhanceCodeBlocks(bubbleEl);
                scrollToBottom();
              }
              if (parsed.usage) finalUsage = parsed.usage;
              if (parsed.model) finalModel = parsed.model;
              if (parsed.finishReason) finalFinishReason = parsed.finishReason;
            } catch {
              // Ignore partial JSON parse errors in SSE lines
            }
          }
        }
      } else {
        // Fallback standard JSON response
        const data = await response.json();
        accumulatedText = data.reply || '';
        finalUsage = data.usage;
        finalModel = data.model || currentModel;
        finalFinishReason = data.finishReason;
      }

    } catch (err) {
      if (err.name === 'AbortError') {
        wasAborted = true;
      } else {
        console.error('Chat error:', err);
        const actionLabel = isRetry ? 'повторе запроса' : 'получении ответа';
        accumulatedText = `❌ **Ошибка при ${actionLabel}:**\n\n${escapeHtml(err.message || 'Сбой сети')}`;
      }
    } finally {
      // Exit Generating State
      isGenerating = false;
      activeAbortController = null;
      el.sendBtn.classList.remove('stop-mode');
      el.sendBtnIcon.textContent = '✈️';
      el.sendBtnText.textContent = 'Отправить';
      el.userInput.disabled = false;
      el.userInput.focus();

      // Finalize Assistant Message
      if (!accumulatedText && !wasAborted) {
        accumulatedText = '⚠️ Модель вернула пустой ответ.';
      }

      messages[assistantIndex] = {
        role: 'model',
        parts: [{ text: accumulatedText }],
        timestamp: Date.now(),
        model: finalModel,
        usage: finalUsage,
        finishReason: finalFinishReason,
        aborted: wasAborted
      };

      saveMessages();
      renderAllMessages();
    }
  }

  // --- Send Message Flow ---
  async function handleSendMessage() {
    if (isGenerating) return;

    const rawText = el.userInput.value.trim();
    if (!rawText && attachments.length === 0) return;

    // Check Auth Credentials
    const apiKey = (localStorage.getItem(STORAGE_KEYS.API_KEY) || '').trim();
    const pin = (localStorage.getItem(STORAGE_KEYS.PIN) || '').trim();

    if (!apiKey && !pin) {
      openModal('authModal');
      el.userApiKeyInput.focus();
      alert('Для отправки сообщений укажите ваш Google Gemini API Key или Owner PIN в настройках.');
      return;
    }

    // Build User Message Object
    const parts = [];

    // Text part
    if (rawText) {
      parts.push({ text: rawText });
    }

    // Media & Text Attachment parts
    attachments.forEach(att => {
      if (att.type === 'image') {
        parts.push({
          inlineData: {
            mimeType: att.mimeType,
            data: att.data
          }
        });
      } else if (att.type === 'text') {
        parts.push({
          text: `\n\n--- [Файл: ${att.name}] ---\n${att.textContent}\n--- [Конец файла] ---\n`
        });
      }
    });

    const userMessage = {
      role: 'user',
      parts: parts,
      timestamp: Date.now()
    };

    messages.push(userMessage);
    saveMessages();
    renderAllMessages();

    // Reset Input
    el.userInput.value = '';
    el.userInput.style.height = 'auto';
    attachments = [];
    renderAttachmentPreviews();

    // Trigger execution
    await executeChatRequest({ isRetry: false });
  }

  // --- Retry Functionality ---
  function retryFromMessage(index) {
    if (isGenerating) return;
    // Remove messages from this index onward
    messages = messages.slice(0, index);
    saveMessages();
    renderAllMessages();

    // Trigger re-generation with the last user message
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg && lastUserMsg.role === 'user') {
      executeChatRequest({ isRetry: true });
    }
  }

  // --- Export to Markdown ---
  function exportToMarkdown() {
    if (messages.length === 0) {
      alert('История диалога пуста.');
      return;
    }

    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let md = `# Gemini Proxy Chat Export\nДата: ${new Date().toLocaleString()}\n\n---\n\n`;

    messages.forEach(m => {
      const isUser = m.role === 'user';
      const roleTitle = isUser ? '### 👤 Пользователь' : `### ⚡ Gemini (${m.model || 'Flash'})`;
      const text = (m.parts || []).find(p => typeof p.text === 'string')?.text || '';
      md += `${roleTitle}\n\n${text}\n\n`;
      if (m.aborted) {
        md += `*(генерация остановлена пользователем)*\n\n`;
      }
      md += `---\n\n`;
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gemini-chat-${dateStr}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('История экспортирована в Markdown');
  }

  // --- Utilities ---
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
