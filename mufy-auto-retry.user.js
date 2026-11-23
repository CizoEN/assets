// ==UserScript==
// @name         Mufy Auto Retry
// @namespace    local.codex
// @version      1.9
// @description  Automatically retries Mufy responses on MUMU-1.5, dismisses the retry prompt, and refreshes after every 10 retries.
// @match        https://chat.mufy.ai/*
// @downloadURL  https://raw.githubusercontent.com/CizoEN/assets/main/mufy-auto-retry.user.js
// @updateURL    https://raw.githubusercontent.com/CizoEN/assets/main/mufy-auto-retry.user.js
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  if (window.__mufyAutoRetryInstalled) return;
  window.__mufyAutoRetryInstalled = true;

  const TARGET_ROLE_ID = '303ec8a5-54eb-42df-9e6e-72272be87359';
  const pageUrl = new URL(location.href);
  if (
    pageUrl.hostname !== 'chat.mufy.ai' ||
    pageUrl.pathname !== '/chat' ||
    pageUrl.searchParams.get('roleId') !== TARGET_ROLE_ID
  ) {
    return;
  }

  const CONFIG = {
    maxRetries: 10,
    minGapMs: 1200,
    stallTimeoutMs: 120000,
    resumeDelayMs: 2200,
    mutationDebounceMs: 80,
    fallbackPollMs: 250,
    expectedModel: 'MUMU-1.5',
  };

  const SCRIPT_VERSION = 'v1.9';
  const AI_ROW_SELECTOR = '.flex.items-start.px-3.py-2';
  const RETRY_BUTTON_SELECTOR = '#mufy_chat_input_replay_btn';
  const MODEL_BUTTON_SELECTOR = '#mufy_chat_input_model_btn';
  const USER_MESSAGE_SELECTOR = '.mufy_user_message_bubble';
  const RESUME_KEY = 'mufy-auto-retry-resume';

  let running = false;
  let retries = 0;
  let lastSeenText = '';
  let lastUserMessageCount = 0;
  let expectingOutput = false;
  let lastOutputActivityAt = 0;
  let nextAllowedAt = 0;
  let lastConflictClickAt = 0;
  let retrySequenceRunning = false;
  let modelSwitchInProgress = false;
  let seedInProgress = false;
  let mutationTimer = null;
  let pollTimer = null;

  function displayMaxRetries() {
    return Number.isFinite(CONFIG.maxRetries) ? CONFIG.maxRetries : '∞';
  }

  function savedMaxRetries() {
    return Number.isFinite(CONFIG.maxRetries)
      ? CONFIG.maxRetries
      : 'Infinity';
  }

  const panel = document.createElement('div');
  panel.id = 'mufy-auto-retry-panel';
  panel.style.cssText = `
    position: fixed;
    top: 84px;
    right: 16px;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid rgba(255,255,255,.2);
    border-radius: 12px;
    background: rgba(18,18,22,.9);
    color: #fff;
    font: 12px/1.3 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    box-shadow: 0 8px 24px rgba(0,0,0,.32);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    user-select: none;
  `;

  const toggleButton = document.createElement('button');
  toggleButton.type = 'button';
  toggleButton.style.cssText = `
    border: 0;
    border-radius: 8px;
    padding: 6px 10px;
    background: #6959d7;
    color: #fff;
    cursor: pointer;
    font: inherit;
  `;
  toggleButton.textContent = '启动自动重说';

  const status = document.createElement('span');
  status.style.cssText = 'min-width: 96px; color: rgba(255,255,255,.76);';
  status.textContent = `${SCRIPT_VERSION} · 0 / ${displayMaxRetries()}`;

  panel.append(toggleButton, status);
  document.documentElement.appendChild(panel);

  function getLatestAiText() {
    const rows = Array.from(document.querySelectorAll(AI_ROW_SELECTOR));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const markdown = rows[i].querySelector('.react-markdown');
      if (!markdown) continue;
      const text = (markdown.innerText || '')
        .replace(/偷看剧本中/g, '')
        .trim();
      if (text) return text;
    }
    return '';
  }

  function getRetryButton() {
    const button = document.querySelector(RETRY_BUTTON_SELECTOR);
    if (!button) return null;

    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.pointerEvents === 'none' ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }

    return button;
  }

  function getStopButton() {
    return (
      Array.from(
        document.querySelectorAll('#mufy_chat_input_box button, #mufy_chat_input_box div')
      ).find((element) => {
        if ((element.textContent || '').trim() !== '停止') return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.pointerEvents !== 'none' &&
          rect.width > 0 &&
          rect.height > 0
        );
      }) || null
    );
  }

  function confirmRetryDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const dialog = dialogs.find((item) => {
      const text = (item.textContent || '').replace(/\s+/g, '');
      return text.includes('是否进行重说') && text.includes('取消');
    });
    if (!dialog) return false;

    const checkbox = dialog.querySelector(
      '[role="checkbox"], input[type="checkbox"]'
    );
    if (checkbox && checkbox.getAttribute('aria-checked') !== 'true') {
      checkbox.click();
    }

    const retryButton = Array.from(dialog.querySelectorAll('button')).find(
      (button) => (button.textContent || '').trim() === '重说'
    );
    if (!retryButton) return false;

    window.setTimeout(() => retryButton.click(), 40);
    return true;
  }

  function confirmSessionConflict() {
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"], div')
    ).filter((element) => {
      if ((element.textContent || '').trim() !== '终止冲突对话') return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.pointerEvents !== 'none' &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    if (!candidates.length) return false;
    if (Date.now() - lastConflictClickAt < 1800) return true;

    const button = candidates.sort(
      (a, b) =>
        a.getBoundingClientRect().width * a.getBoundingClientRect().height -
        b.getBoundingClientRect().width * b.getBoundingClientRect().height
    )[0];
    lastConflictClickAt = Date.now();
    button.click();
    lastOutputActivityAt = Date.now();
    expectingOutput = true;
    return true;
  }

  function getModelName() {
    const button = document.querySelector(MODEL_BUTTON_SELECTOR);
    return (button?.textContent || '').replace(/\s+/g, '').toUpperCase();
  }

  function isExpectedModel() {
    return getModelName().includes(
      CONFIG.expectedModel.replace(/\s+/g, '').toUpperCase()
    );
  }

  function selectExpectedModel() {
    if (modelSwitchInProgress || isExpectedModel()) return;
    modelSwitchInProgress = true;
    updateStatus(`正在切换 ${CONFIG.expectedModel}`);

    const modelButton = document.querySelector(MODEL_BUTTON_SELECTOR);
    if (!modelButton) {
      modelSwitchInProgress = false;
      updateStatus('未找到模型按钮');
      return;
    }

    modelButton.click();
    let attempts = 0;
    const chooseOption = () => {
      attempts += 1;
      const label = Array.from(document.querySelectorAll('span')).find(
        (span) => (span.textContent || '').trim() === CONFIG.expectedModel
      );
      const option = label?.closest('.cursor-pointer');

      if (!option) {
        if (attempts < 30) {
          window.setTimeout(chooseOption, 100);
        } else {
          modelSwitchInProgress = false;
          updateStatus(`未找到 ${CONFIG.expectedModel}`);
        }
        return;
      }

      option.click();
      window.setTimeout(() => {
        const radio = Array.from(
          document.querySelectorAll('button[role="radio"]')
        ).find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        radio?.click();

        window.setTimeout(() => {
          const confirm = Array.from(
            document.querySelectorAll('button')
          ).find(
            (element) =>
              (element.textContent || '').trim() === '确定' &&
              element.getBoundingClientRect().width > 0
          );
          confirm?.click();

          window.setTimeout(() => {
            modelSwitchInProgress = false;
            updateStatus(
              isExpectedModel()
                ? `已切换 ${CONFIG.expectedModel}`
                : `切换 ${CONFIG.expectedModel} 失败`
            );
          }, 350);
        }, 80);
      }, 100);
    };

    window.setTimeout(chooseOption, 100);
  }

  function getUserMessageCount() {
    return document.querySelectorAll(USER_MESSAGE_SELECTOR).length;
  }

  function saveResumeState() {
    sessionStorage.setItem(
      RESUME_KEY,
      JSON.stringify({
        retries,
        maxRetries: savedMaxRetries(),
        savedAt: Date.now(),
      })
    );
  }

  function clearResumeState() {
    sessionStorage.removeItem(RESUME_KEY);
  }

  function userIsTyping() {
    const active = document.activeElement;
    return (
      active instanceof HTMLTextAreaElement &&
      Boolean((active.value || '').trim())
    );
  }

  function updateStatus(extra = '') {
    status.textContent = `${SCRIPT_VERSION} · ${retries} / ${displayMaxRetries()}${extra ? ` · ${extra}` : ''}`;
    toggleButton.textContent = running
      ? `停止自动重说 ${SCRIPT_VERSION}`
      : `启动自动重说 ${SCRIPT_VERSION}`;
    toggleButton.style.background = running ? '#a33d4b' : '#6959d7';
  }

  function stop(reason = '') {
    running = false;
    expectingOutput = false;
    nextAllowedAt = 0;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (reason !== '自动刷新中') clearResumeState();
    updateStatus(reason);
  }

  function start(options = {}) {
    if (!isExpectedModel()) {
      selectExpectedModel();
      window.setTimeout(() => {
        if (isExpectedModel()) start(options);
      }, 900);
      return;
    }

    running = true;
    retries = Number.isFinite(options.resumeRetries)
      ? options.resumeRetries
      : 0;
    if (retries >= CONFIG.maxRetries) {
      stop('已达上限');
      return;
    }
    nextAllowedAt = 0;
    expectingOutput = false;
    lastOutputActivityAt = 0;
    lastSeenText = getLatestAiText();
    lastUserMessageCount = getUserMessageCount();
    updateStatus('等待新输出');

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(scan, CONFIG.fallbackPollMs);

    if (!lastSeenText) {
      window.setTimeout(() => {
        if (
          running &&
          !getLatestAiText() &&
          !getRetryButton() &&
          !getStopButton()
        ) {
          sendOneFallback();
        }
      }, 3000);
    }

    if (options.afterRefresh) {
      expectingOutput = true;
      lastOutputActivityAt = Date.now();
      updateStatus('刷新后恢复');

      window.setTimeout(() => {
        if (!running || !isExpectedModel()) return;
        const button = getRetryButton();
        if (button) {
          clickRetry(button);
        } else {
          lastOutputActivityAt = Date.now();
          updateStatus('等待重说按钮');
        }
      }, CONFIG.resumeDelayMs);
    }
  }

  function clickRetry(button) {
    retries += 1;
    nextAllowedAt = Date.now() + CONFIG.minGapMs;
    lastSeenText = getLatestAiText();
    expectingOutput = true;
    lastOutputActivityAt = Date.now();
    saveResumeState();

    // Mufy's control is a div, so use a real click event for React's delegated handler.
    button.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );

    if (retries >= CONFIG.maxRetries) {
      window.setTimeout(() => {
        if (!confirmRetryDialog()) {
          refreshAfterCycle();
        } else {
          window.setTimeout(refreshAfterCycle, 800);
        }
      }, 120);
    } else {
      updateStatus('等待下一次输出');
    }
  }

  function beginRetrySequence() {
    if (retrySequenceRunning || !running) return;
    retrySequenceRunning = true;

    const stopButton = getStopButton();
    if (stopButton) {
      stopButton.click();
      updateStatus('检测到输出，正在停止');
    } else {
      updateStatus('检测到输出，准备重说');
    }

    let attempts = 0;
    const waitForReplay = () => {
      if (!running) {
        retrySequenceRunning = false;
        return;
      }

      if (confirmSessionConflict()) {
        updateStatus('已终止冲突对话');
      }
      confirmRetryDialog();

      const retryButton = getRetryButton();
      if (retryButton) {
        retrySequenceRunning = false;
        clickRetry(retryButton);
        return;
      }

      attempts += 1;
      if (attempts < 50) {
        window.setTimeout(waitForReplay, 100);
      } else {
        retrySequenceRunning = false;
        sendOneFallback();
      }
    };

    window.setTimeout(waitForReplay, 80);
  }

  function sendOneFallback() {
    if (seedInProgress) return;
    const textarea = document.querySelector('#mufy_chat_input_box textarea');
    const inputBox = document.querySelector('#mufy_chat_input_box');
    if (!textarea || !inputBox) {
      updateStatus('未找到输入框');
      return;
    }

    seedInProgress = true;
    updateStatus('没有输出，发送 1');

    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    valueSetter?.call(textarea, '1');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    let attempts = 0;
    const submit = () => {
      attempts += 1;
      const sendButton = Array.from(
        inputBox.querySelectorAll('button')
      ).find(
        (button) =>
          button !== document.querySelector(MODEL_BUTTON_SELECTOR) &&
          !button.disabled &&
          button.getBoundingClientRect().width > 0
      );

      if (sendButton) {
        sendButton.click();
        seedInProgress = false;
        expectingOutput = true;
        lastOutputActivityAt = Date.now();
        lastUserMessageCount = getUserMessageCount();
        return;
      }

      if (attempts < 20) {
        window.setTimeout(submit, 100);
        return;
      }

      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
      seedInProgress = false;
    };

    window.setTimeout(submit, 80);
  }

  function refreshAfterCycle() {
    stop('自动刷新中');
    sessionStorage.setItem(
      RESUME_KEY,
      JSON.stringify({
        retries: 0,
        maxRetries: savedMaxRetries(),
        savedAt: Date.now(),
      })
    );
    window.location.reload();
  }

  function reloadForStall() {
    if (!running || !expectingOutput) return;
    if (Date.now() - lastOutputActivityAt < CONFIG.stallTimeoutMs) return;

    saveResumeState();
    stop('自动刷新中');
    window.location.reload();
  }

  function scan() {
    if (!running || document.hidden || userIsTyping()) return;

    if (confirmSessionConflict()) {
      updateStatus('已终止冲突对话');
      return;
    }

    if (confirmRetryDialog()) {
      updateStatus('已勾选不再提示');
      return;
    }

    if (retrySequenceRunning) return;

    if (!isExpectedModel()) {
      selectExpectedModel();
      return;
    }

    const userMessageCount = getUserMessageCount();
    if (userMessageCount > lastUserMessageCount) {
      lastUserMessageCount = userMessageCount;
      expectingOutput = true;
      lastOutputActivityAt = Date.now();
      lastSeenText = getLatestAiText();
    }

    const text = getLatestAiText();
    if (text && text !== lastSeenText) {
      lastSeenText = text;
      expectingOutput = false;
      lastOutputActivityAt = Date.now();
    }

    reloadForStall();
    if (!text || Date.now() < nextAllowedAt) return;

    beginRetrySequence();
  }

  function scheduleScan() {
    if (!running || mutationTimer) return;
    mutationTimer = window.setTimeout(() => {
      mutationTimer = null;
      scan();
    }, CONFIG.mutationDebounceMs);
  }

  toggleButton.addEventListener('click', () => {
    if (running) {
      stop('已停止');
    } else {
      start();
    }
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  function resumeAfterReload() {
    let resumeData = null;
    try {
      resumeData = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
    } catch {
      clearResumeState();
      return;
    }

    if (!resumeData) return;

    let attempts = 0;
    const resumeTimer = setInterval(() => {
      attempts += 1;
      const modelButton = document.querySelector(MODEL_BUTTON_SELECTOR);
      if (
        modelButton &&
        (modelButton.textContent || '').trim() !== '选择模型'
      ) {
        clearInterval(resumeTimer);
        if (resumeData.maxRetries !== savedMaxRetries()) {
          clearResumeState();
          updateStatus('重试上限已变更，请手动启动');
          return;
        }
        start({
          resumeRetries: resumeData.retries || 0,
          afterRefresh: true,
        });
      } else if (attempts >= 40) {
        clearInterval(resumeTimer);
        clearResumeState();
        updateStatus(`刷新后未找到 ${CONFIG.expectedModel}`);
      }
    }, 500);
  }

  resumeAfterReload();

  window.mufyAutoRetry = {
    start,
    stop,
    status: () => ({
      running,
      retries,
      maxRetries: displayMaxRetries(),
      latestText: getLatestAiText(),
    }),
  };
})();
