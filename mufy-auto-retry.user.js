// ==UserScript==
// @name         Mufy Auto Retry
// @namespace    local.codex
// @version      3.9.6
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
    minGapMinMs: 6500,
    minGapMaxMs: 9500,
    stopDelayMinMs: 120,
    stopDelayMaxMs: 220,
    retrySettleMinMs: 900,
    retrySettleMaxMs: 1400,
    replayWaitTimeoutMs: 50000,
    modelActionDelayMs: 650,
    modelSelectionSettleMs: 900,
    modelCommitTimeoutMs: 12000,
    modelFailureCooldownMs: 30000,
    modelFailureReloadDelayMs: 800,
    verifyModelPollMs: 250,
    idleRetryGraceMs: 2600,
    idleSeedDelayMs: 9000,
    emptySeedDelayMs: 3200,
    retryDialogSettleMs: 180,
    rateLimitRefreshDelayMs: 1500,
    stallTimeoutMs: 120000,
    idleRefreshTimeoutMs: 90000,
    emptyChatDetectMs: 3000,
    emptySeedRetryMs: 15000,
    noOutputFallbackMs: 5000,
    fallbackCooldownMs: 10000,
    refreshCooldownMs: 30000,
    resumeDelayMs: 3000,
    mutationDebounceMs: 140,
    fallbackPollMs: 350,
    expectedModel: 'MUMU-1.5',
  };

  const SCRIPT_VERSION = 'v3.9.6';
  const AUTO_STOP_AT = new Date('2026-11-24T07:55:00+08:00').getTime();
  const AI_ROW_SELECTOR = '.flex.items-start.px-3.py-2';
  const RETRY_BUTTON_SELECTOR = '#mufy_chat_input_replay_btn';
  const MODEL_BUTTON_SELECTOR = '#mufy_chat_input_model_btn';
  const USER_MESSAGE_SELECTOR = '.mufy_user_message_bubble';
  const RESUME_KEY = 'mufy-auto-retry-resume';
  const AUTO_REFRESH_KEY = 'mufy-auto-retry-last-auto-refresh';
  const SEED_KEY = `mufy-auto-retry-seeded:${
    pageUrl.searchParams.get('sessionId') || 'default'
  }`;

  let running = false;
  let retries = 0;
  let lastSeenText = '';
  let lastUserMessageCount = 0;
  let expectingOutput = false;
  let lastOutputActivityAt = 0;
  let nextAllowedAt = 0;
  let lastConflictClickAt = 0;
  let lastModelActionAt = 0;
  let lastModelFailureAt = 0;
  let lastCycleActionAt = 0;
  let lastProgressAt = 0;
  let emptyChatSince = 0;
  let lastFallbackAt = 0;
  let rateLimitUntil = 0;
  let retrySequenceRunning = false;
  let retryDialogActionRunning = false;
  let modelSwitchInProgress = false;
  let seedInProgress = false;
  let seedSent = sessionStorage.getItem(SEED_KEY) === '1';
  let userStopped = false;
  let mutationTimer = null;
  let pollTimer = null;
  let interruptTimer = null;
  let seenOutputRows = new WeakSet();
  let autoStopHandled = false;

  function displayMaxRetries() {
    return Number.isFinite(CONFIG.maxRetries) ? CONFIG.maxRetries : '∞';
  }

  function savedMaxRetries() {
    return Number.isFinite(CONFIG.maxRetries)
      ? CONFIG.maxRetries
      : 'Infinity';
  }

  function randomDelay(min, max) {
    return Math.round(min + Math.random() * (max - min));
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

  function isUiVisible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.pointerEvents !== 'none' &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function dispatchClick(element) {
    if (!element) return;
    if (typeof element.click === 'function') {
      element.click();
      return;
    }
    element.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );
  }

  function pressSendButton(element) {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const hitTarget =
      document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
      ) || element;
    const options = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    hitTarget.focus?.();
    hitTarget.dispatchEvent(new PointerEvent('pointerdown', options));
    hitTarget.dispatchEvent(new MouseEvent('mousedown', options));
    hitTarget.dispatchEvent(new PointerEvent('pointerup', options));
    hitTarget.dispatchEvent(new MouseEvent('mouseup', options));
    hitTarget.dispatchEvent(new MouseEvent('click', options));
  }

  function getAiRows() {
    return Array.from(document.querySelectorAll(AI_ROW_SELECTOR));
  }

  function getLatestAiRow() {
    const rows = getAiRows();
    return rows.length ? rows[rows.length - 1] : null;
  }

  function markAiRowsSeen() {
    getAiRows().forEach((row) => seenOutputRows.add(row));
  }

  function getUnseenOutputRow() {
    const row = getLatestAiRow();
    if (!row || seenOutputRows.has(row)) return null;
    return row.querySelector('.react-markdown') ? row : null;
  }

  function getGoldenOutputLine(row) {
    const line = row?.querySelector(
      '.react-markdown .min-pre-stage .min-pre-bar'
    );
    return isUiVisible(line) ? line : null;
  }

  function getLatestAiText() {
    const rows = getAiRows();
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
    if (!isUiVisible(button)) return null;
    return (button.textContent || '').includes('重说') ? button : null;
  }

  function getStopButton() {
    const candidates = Array.from(
      document.querySelectorAll('#mufy_chat_input_box *')
    ).filter(
      (element) =>
        (element.textContent || '').trim() === '停止' &&
        isUiVisible(element) &&
        (element.matches('button, [role="button"]') ||
          getComputedStyle(element).cursor === 'pointer')
    );
    candidates.sort(
      (a, b) =>
        a.getBoundingClientRect().width * a.getBoundingClientRect().height -
        b.getBoundingClientRect().width * b.getBoundingClientRect().height
    );
    return candidates[0] || null;
  }

  function getRetryDialog() {
    return (
      Array.from(document.querySelectorAll('[role="dialog"]')).find((dialog) => {
        if (!isUiVisible(dialog)) return false;
        const text = (dialog.textContent || '').replace(/\s+/g, '');
        return text.includes('是否进行重说') && text.includes('取消');
      }) || null
    );
  }

  function getModelDialog() {
    return (
      Array.from(document.querySelectorAll('[role="dialog"]')).find((dialog) => {
        if (!isUiVisible(dialog)) return false;
        return (dialog.textContent || '').includes('模型选择');
      }) || null
    );
  }

  function confirmRetryDialog() {
    const dialog = getRetryDialog();
    if (!dialog) return false;
    if (retryDialogActionRunning) return true;

    const checkbox = dialog.querySelector(
      '[role="checkbox"], input[type="checkbox"]'
    );
    const checkboxChecked =
      checkbox instanceof HTMLInputElement
        ? checkbox.checked
        : checkbox?.getAttribute('aria-checked') === 'true';
    if (checkbox && !checkboxChecked) {
      dispatchClick(checkbox);
    }

    const retryButton = Array.from(dialog.querySelectorAll('button')).find(
      (button) =>
        (button.textContent || '').trim() === '重说' && isUiVisible(button)
    );
    if (!retryButton) return false;

    retryDialogActionRunning = true;
    window.setTimeout(() => {
      const currentDialog = getRetryDialog();
      if (!currentDialog) {
        retryDialogActionRunning = false;
        return;
      }
      const currentRetryButton = Array.from(
        currentDialog.querySelectorAll('button')
      ).find(
        (button) =>
          (button.textContent || '').trim() === '重说' && isUiVisible(button)
      );
      if (!currentRetryButton) {
        retryDialogActionRunning = false;
        return;
      }
      updateStatus('已勾选不再提示');
      dispatchClick(currentRetryButton);
      window.setTimeout(() => {
        retryDialogActionRunning = false;
      }, 900);
    }, CONFIG.retryDialogSettleMs);
    return true;
  }

  function confirmSessionConflict() {
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"]')
    ).filter((element) => {
      if ((element.textContent || '').trim() !== '终止冲突对话') return false;
      return isUiVisible(element);
    });

    if (!candidates.length) return false;
    if (Date.now() - lastConflictClickAt < 1800) return true;

    const button = candidates.sort(
      (a, b) =>
        a.getBoundingClientRect().width * a.getBoundingClientRect().height -
        b.getBoundingClientRect().width * b.getBoundingClientRect().height
    )[0];
    lastConflictClickAt = Date.now();
    dispatchClick(button);
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

  function getModelDialogSelection(dialog) {
    const candidates = Array.from(dialog.querySelectorAll('div')).filter(
      (element) => {
        const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
        return (
          isUiVisible(element) &&
          text.startsWith('已选择') &&
          !element.querySelector('button')
        );
      }
    );
    candidates.sort((a, b) => a.children.length - b.children.length);
    return (candidates[0]?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function getModelConfirmButton(dialog) {
    return (
      Array.from(dialog.querySelectorAll('button')).find(
        (button) =>
          (button.textContent || '').trim() === '确定' && isUiVisible(button)
      ) || null
    );
  }

  function failModelSwitch(reason) {
    modelSwitchInProgress = false;
    lastModelFailureAt = Date.now();
    const dialog = getModelDialog();
    const cancelButton = dialog
      ? Array.from(dialog.querySelectorAll('button')).find(
          (button) =>
            (button.textContent || '').trim() === '取消' && isUiVisible(button)
        )
      : null;
    dispatchClick(cancelButton);

    const shouldReload =
      reason.includes(CONFIG.expectedModel) && reason.includes('超时');
    if (shouldReload) {
      saveResumeState();
      updateStatus(`${reason}，自动刷新`);
      window.setTimeout(() => {
        stop('自动刷新中');
        window.location.reload();
      }, CONFIG.modelFailureReloadDelayMs);
      return;
    }

    updateStatus(`${reason}，稍后重试`);
  }

  function isModelFailureCoolingDown() {
    return Boolean(
      lastModelFailureAt &&
        Date.now() - lastModelFailureAt < CONFIG.modelFailureCooldownMs
    );
  }

  function finishModelDialog(dialog) {
    if (modelSwitchInProgress) return true;
    const label = Array.from(dialog.querySelectorAll('span')).find(
      (span) =>
        (span.textContent || '').trim() === CONFIG.expectedModel &&
        isUiVisible(span)
    );
    const selectedText = getModelDialogSelection(dialog);
    const alreadySelected = selectedText.includes(CONFIG.expectedModel);
    const option =
      label?.closest('.cursor-pointer') ||
      label?.closest('button[role="radio"]') ||
      label?.parentElement;

    modelSwitchInProgress = true;
    lastModelActionAt = Date.now();

    if (!alreadySelected && !option) {
      failModelSwitch(`未找到 ${CONFIG.expectedModel}`);
      return true;
    }

    const verifyCommit = () => {
      let attempts = 0;
      const maxAttempts = Math.ceil(
        CONFIG.modelCommitTimeoutMs / CONFIG.verifyModelPollMs
      );
      const verify = () => {
        attempts += 1;
        if (isExpectedModel()) {
          const staleDialog = getModelDialog();
          if (staleDialog) {
            const cancelButton = Array.from(
              staleDialog.querySelectorAll('button')
            ).find(
              (button) =>
                (button.textContent || '').trim() === '取消' &&
                isUiVisible(button)
            );
            dispatchClick(cancelButton);
          }
          modelSwitchInProgress = false;
          lastModelFailureAt = 0;
          updateStatus(`已锁定 ${CONFIG.expectedModel}`);
          return;
        }
        if (attempts < maxAttempts) {
          window.setTimeout(verify, CONFIG.verifyModelPollMs);
          return;
        }
        failModelSwitch(`确认 ${CONFIG.expectedModel} 超时`);
      };
      window.setTimeout(verify, CONFIG.verifyModelPollMs);
    };

    const clickConfirm = () => {
      const currentDialog = getModelDialog();
      const currentConfirm = currentDialog
        ? getModelConfirmButton(currentDialog)
        : null;
      if (!currentDialog || !currentConfirm) {
        failModelSwitch('模型确认按钮丢失');
        return;
      }
      lastModelActionAt = Date.now();
      updateStatus(`已提交 ${CONFIG.expectedModel}，等待切换`);
      dispatchClick(currentConfirm);
      verifyCommit();
    };

    if (alreadySelected) {
      updateStatus(`已选中 ${CONFIG.expectedModel}，等待确认`);
      window.setTimeout(clickConfirm, CONFIG.modelSelectionSettleMs);
      return true;
    }

    updateStatus(`正在选择 ${CONFIG.expectedModel}`);
    dispatchClick(option);
    let selectionAttempts = 0;
    const waitForSelection = () => {
      selectionAttempts += 1;
      const currentDialog = getModelDialog();
      if (!currentDialog) {
        failModelSwitch('模型菜单意外关闭');
        return;
      }
      if (
        getModelDialogSelection(currentDialog).includes(CONFIG.expectedModel)
      ) {
        window.setTimeout(clickConfirm, CONFIG.modelSelectionSettleMs);
        return;
      }
      if (selectionAttempts < 20) {
        window.setTimeout(waitForSelection, 250);
        return;
      }
      failModelSwitch(`选择 ${CONFIG.expectedModel} 超时`);
    };
    window.setTimeout(waitForSelection, 250);
    return true;
  }

  function selectExpectedModel() {
    if (modelSwitchInProgress) return;
    if (isModelFailureCoolingDown()) return;

    const openDialog = getModelDialog();
    if (openDialog) {
      finishModelDialog(openDialog);
      return;
    }
    if (isExpectedModel()) return;
    if (Date.now() - lastModelActionAt < 900) return;

    const modelButton = document.querySelector(MODEL_BUTTON_SELECTOR);
    if (!modelButton) {
      updateStatus('未找到模型按钮');
      return;
    }

    modelSwitchInProgress = true;
    lastModelActionAt = Date.now();
    updateStatus(`正在打开 ${CONFIG.expectedModel}`);
    dispatchClick(modelButton);

    let attempts = 0;
    const waitForDialog = () => {
      attempts += 1;
      const dialog = getModelDialog();
      if (dialog) {
        modelSwitchInProgress = false;
        finishModelDialog(dialog);
        return;
      }
      if (attempts < 24) {
        window.setTimeout(waitForDialog, 220);
        return;
      }
      failModelSwitch('模型菜单未打开');
    };

    window.setTimeout(waitForDialog, 260);
  }

  function getUserMessageCount() {
    return document.querySelectorAll(USER_MESSAGE_SELECTOR).length;
  }

  function getChatRecordCount() {
    const aiMessages = getAiRows().filter((row) =>
      row.querySelector('.react-markdown')
    ).length;
    return getUserMessageCount() + aiMessages;
  }

  function hasActivePageControl() {
    return Boolean(
      getStopButton() ||
        getRetryButton() ||
        getRetryDialog() ||
        getModelDialog()
    );
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
    retrySequenceRunning = false;
    retryDialogActionRunning = false;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (interruptTimer) clearTimeout(interruptTimer);
    interruptTimer = null;
    if (reason !== '自动刷新中') clearResumeState();
    updateStatus(reason);
  }

  function enforceAutoStop() {
    if (Date.now() < AUTO_STOP_AT || autoStopHandled) {
      return Date.now() >= AUTO_STOP_AT;
    }

    autoStopHandled = true;
    userStopped = true;
    const stopButton = getStopButton();
    if (stopButton) dispatchClick(stopButton);
    stop('中国时间 07:55，已全部暂停');
    return true;
  }

  function start(options = {}) {
    if (running) return;
    if (enforceAutoStop()) return;

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
    lastOutputActivityAt = Date.now();
    lastCycleActionAt = Date.now();
    lastProgressAt = Date.now();
    emptyChatSince = getChatRecordCount() === 0 ? Date.now() : 0;
    lastSeenText = getLatestAiText();
    lastUserMessageCount = getUserMessageCount();
    markAiRowsSeen();
    updateStatus('等待新输出');

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(scan, CONFIG.fallbackPollMs);

    if (options.afterRefresh) {
      lastOutputActivityAt = Date.now();
      updateStatus('刷新后恢复');

      let attempts = 0;
      const waitForInitialRetry = () => {
        if (!running) return;
        if (!isExpectedModel()) {
          selectExpectedModel();
          window.setTimeout(waitForInitialRetry, CONFIG.resumeDelayMs);
          return;
        }
        const button = getRetryButton();
        if (button && !getStopButton()) {
          clickRetry(button);
          return;
        }
        attempts += 1;
        if (getStopButton() || attempts >= 4) {
          updateStatus('等待新输出');
          return;
        }
        updateStatus('等待重说按钮');
        window.setTimeout(waitForInitialRetry, CONFIG.resumeDelayMs);
      };
      window.setTimeout(waitForInitialRetry, CONFIG.resumeDelayMs);
    }
  }

  function clickRetry(button) {
    if (!button || !isUiVisible(button)) return false;
    retries += 1;
    nextAllowedAt = Date.now() + randomDelay(
      CONFIG.minGapMinMs,
      CONFIG.minGapMaxMs
    );
    lastCycleActionAt = Date.now();
    lastProgressAt = Date.now();
    emptyChatSince = 0;
    lastSeenText = getLatestAiText();
    expectingOutput = true;
    lastOutputActivityAt = Date.now();
    saveResumeState();
    markAiRowsSeen();

    // Mufy's control is a div, so use a real click event for React's delegated handler.
    dispatchClick(button);

    if (retries >= CONFIG.maxRetries) {
      updateStatus('第 10 次已提交，准备刷新');
      let attempts = 0;
      const finishLastCycle = () => {
        attempts += 1;
        if (confirmRetryDialog()) {
          window.setTimeout(refreshAfterCycle, 4200);
          return;
        }
        const outputStarted =
          Boolean(getStopButton()) ||
          Boolean(getLatestAiText() && getLatestAiText() !== lastSeenText);
        if (outputStarted || attempts >= 16) {
          window.setTimeout(refreshAfterCycle, 4200);
          return;
        }
        window.setTimeout(finishLastCycle, 350);
      };
      window.setTimeout(finishLastCycle, 500);
    } else {
      updateStatus('等待下一次输出');
    }
    return true;
  }

  function beginRetrySequence() {
    if (retrySequenceRunning || !running) return;
    retrySequenceRunning = true;

    const stopButton = getStopButton();
    if (!stopButton) {
      retrySequenceRunning = false;
      return;
    }
    dispatchClick(stopButton);
    updateStatus('检测到输出，正在停止');

    let attempts = 0;
    let stableReplayChecks = 0;
    const maxReplayChecks = Math.ceil(CONFIG.replayWaitTimeoutMs / 350);
    const waitForReplay = () => {
      if (!running) {
        retrySequenceRunning = false;
        return;
      }

      if (confirmSessionConflict()) {
        updateStatus('已终止冲突对话');
        window.setTimeout(waitForReplay, 450);
        return;
      }
      if (confirmRetryDialog()) {
        window.setTimeout(waitForReplay, 450);
        return;
      }

      const stop = getStopButton();
      const retryButton = getRetryButton();
      stableReplayChecks =
        !stop && retryButton ? stableReplayChecks + 1 : 0;

      if (
        !stop &&
        retryButton &&
        stableReplayChecks >= 2 &&
        Date.now() >= nextAllowedAt
      ) {
        retrySequenceRunning = false;
        clickRetry(retryButton);
        return;
      }

      attempts += 1;
      if (attempts < maxReplayChecks) {
        if (attempts === 20) {
          updateStatus('停止后等待重说按钮');
        }
        window.setTimeout(waitForReplay, 350);
      } else {
        retrySequenceRunning = false;
        lastCycleActionAt = Date.now();
        updateStatus('等待重说按钮超时，准备补发');
      }
    };

    window.setTimeout(
      waitForReplay,
      randomDelay(CONFIG.retrySettleMinMs, CONFIG.retrySettleMaxMs)
    );
  }

  function markSeedSent() {
    seedSent = true;
    sessionStorage.setItem(SEED_KEY, '1');
  }

  function sendOneFallback(force = false) {
    if (seedInProgress || (seedSent && !force)) return false;
    const textarea = document.querySelector('#mufy_chat_input_box textarea');
    const inputBox = document.querySelector('#mufy_chat_input_box');
    if (!textarea || !inputBox) {
      updateStatus('未找到输入框');
      return false;
    }

    seedInProgress = true;
    lastCycleActionAt = Date.now();
    lastProgressAt = Date.now();
    lastFallbackAt = Date.now();
    updateStatus(force ? '5 秒无输出，自动发送 1' : '没有输出，发送 1');

    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    if (valueSetter) {
      valueSetter.call(textarea, '1');
    } else {
      textarea.value = '1';
    }
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));

    let attempts = 0;
    const submit = () => {
      attempts += 1;
      const modelNode = document.querySelector(MODEL_BUTTON_SELECTOR);
      const sendButtons = Array.from(inputBox.querySelectorAll('button'))
        .filter(
          (button) =>
            !(modelNode && button.contains(modelNode)) &&
            !button.disabled &&
            button.getBoundingClientRect().width > 0
        )
        .sort(
          (a, b) =>
            b.getBoundingClientRect().right - a.getBoundingClientRect().right
        );
      const sendButton = sendButtons[0];

      if (sendButton) {
        markAiRowsSeen();
        updateStatus('正在提交 1');
        const rowsBefore = getAiRows().length;
        pressSendButton(sendButton);
        window.setTimeout(() => {
          const submitted =
            !(textarea.value || '').trim() ||
            Boolean(getStopButton()) ||
            getAiRows().length > rowsBefore;

          if (!submitted) {
            textarea.focus();
            for (const type of ['keydown', 'keypress', 'keyup']) {
              textarea.dispatchEvent(
                new KeyboardEvent(type, {
                  key: 'Enter',
                  code: 'Enter',
                  keyCode: 13,
                  which: 13,
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                })
              );
            }
          }

          seedInProgress = false;
          markSeedSent();
          expectingOutput = true;
          lastOutputActivityAt = Date.now();
          lastCycleActionAt = Date.now();
          lastUserMessageCount = getUserMessageCount();
          updateStatus('已发送 1，后续只用重说');
        }, 450);
        return;
      }

      if (attempts < 30) {
        window.setTimeout(submit, 100);
        return;
      }

      markAiRowsSeen();
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
      markSeedSent();
      expectingOutput = true;
      lastOutputActivityAt = Date.now();
      lastCycleActionAt = Date.now();
      updateStatus('已发送 1，后续只用重说');
    };

    window.setTimeout(submit, 300);
    return true;
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
    if (!running) return;

    if (hasActivePageControl()) {
      lastProgressAt = Date.now();
      return;
    }

    const stalledFor = Date.now() - lastProgressAt;
    if (stalledFor < CONFIG.idleRefreshTimeoutMs) return;

    const lastRefreshAt = Number(
      sessionStorage.getItem(AUTO_REFRESH_KEY) || 0
    );
    if (Date.now() - lastRefreshAt < CONFIG.refreshCooldownMs) return;

    sessionStorage.setItem(AUTO_REFRESH_KEY, String(Date.now()));
    updateStatus('页面超时，自动刷新');
    saveResumeState();
    stop('自动刷新中');
    window.location.reload();
  }

  function handleRateLimit() {
    if (rateLimitUntil) return true;

    if (
      !/too many requests,\s*please try again later/i.test(getLatestAiText())
    ) {
      return false;
    }

    rateLimitUntil = Date.now() + CONFIG.rateLimitRefreshDelayMs;
    lastCycleActionAt = Date.now();
    updateStatus('触发限流，正在刷新');
    window.setTimeout(() => {
      if (running) refreshAfterCycle();
    }, CONFIG.rateLimitRefreshDelayMs);
    return true;
  }

  function advanceWhenIdle() {
    if (
      retrySequenceRunning ||
      seedInProgress ||
      modelSwitchInProgress ||
      getStopButton() ||
      getRetryDialog() ||
      getModelDialog()
    ) {
      return false;
    }

    const idleFor = Date.now() - lastCycleActionAt;
    const chatRecordCount = getChatRecordCount();

    if (chatRecordCount === 0) {
      if (!emptyChatSince) emptyChatSince = Date.now();
      if (
        Date.now() - emptyChatSince >= CONFIG.emptyChatDetectMs &&
        (!seedSent || idleFor >= CONFIG.emptySeedRetryMs)
      ) {
        seedSent = false;
        sessionStorage.removeItem(SEED_KEY);
        sendOneFallback();
        return true;
      }
      return false;
    }
    emptyChatSince = 0;

    const retryButton = getRetryButton();
    if (retryButton && idleFor >= CONFIG.idleRetryGraceMs) {
      updateStatus('已找到重说按钮');
      clickRetry(retryButton);
      return true;
    }

    if (
      !retryButton &&
      !seedSent &&
      idleFor >=
        (lastSeenText ? CONFIG.idleSeedDelayMs : CONFIG.emptySeedDelayMs)
    ) {
      sendOneFallback();
      return true;
    }
    return false;
  }

  function scan() {
    if (!running || userIsTyping()) return;
    if (enforceAutoStop()) return;

    if (confirmSessionConflict()) {
      updateStatus('已终止冲突对话');
      return;
    }

    if (confirmRetryDialog()) {
      updateStatus('已勾选不再提示');
      return;
    }

    if (handleRateLimit()) return;

    if (retrySequenceRunning) return;

    const modelDialog = getModelDialog();
    if (modelDialog) {
      if (!isModelFailureCoolingDown()) finishModelDialog(modelDialog);
      return;
    }

    if (!isExpectedModel()) {
      selectExpectedModel();
      return;
    }

    const unseenOutputRow = getUnseenOutputRow();
    const userMessageCount = getUserMessageCount();
    if (userMessageCount > lastUserMessageCount) {
      lastUserMessageCount = userMessageCount;
      expectingOutput = true;
      lastOutputActivityAt = Date.now();
      lastProgressAt = Date.now();
      lastSeenText = getLatestAiText();
    }

    const text = getLatestAiText();
    const textAdvanced = Boolean(text && text !== lastSeenText);
    if (textAdvanced) {
      lastSeenText = text;
      expectingOutput = false;
      lastOutputActivityAt = Date.now();
      lastProgressAt = Date.now();
    }

    if (
      !hasActivePageControl() &&
      Date.now() - lastProgressAt >= CONFIG.noOutputFallbackMs &&
      Date.now() - lastFallbackAt >= CONFIG.fallbackCooldownMs
    ) {
      seedSent = false;
      sendOneFallback(true);
      return;
    }

    const goldenLine = getGoldenOutputLine(unseenOutputRow);
    if (unseenOutputRow) {
      const stopButton = getStopButton();
      if (!goldenLine || (!stopButton && !getRetryButton())) {
        reloadForStall();
        return;
      }
      seenOutputRows.add(unseenOutputRow);
      lastOutputActivityAt = Date.now();
      lastProgressAt = Date.now();
      lastSeenText = text;
      if (stopButton) {
        updateStatus('金色线已出现，准备重说');
        if (!interruptTimer) {
          interruptTimer = window.setTimeout(() => {
            interruptTimer = null;
            if (!running || retrySequenceRunning) return;
            if (getStopButton()) beginRetrySequence();
          }, randomDelay(CONFIG.stopDelayMinMs, CONFIG.stopDelayMaxMs));
        }
        return;
      }
    }

    reloadForStall();
    if (advanceWhenIdle()) return;
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
      userStopped = true;
      stop('已停止');
    } else {
      userStopped = false;
      start();
    }
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  const autoStopDelay = AUTO_STOP_AT - Date.now();
  if (autoStopDelay <= 0) {
    window.setTimeout(enforceAutoStop, 0);
  } else {
    window.setTimeout(enforceAutoStop, autoStopDelay);
  }

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

  // Keep trying until Mufy has restored its model UI and the watcher is running.
  window.setInterval(() => {
    if (enforceAutoStop()) return;
    if (userStopped || modelSwitchInProgress) return;
    if (!document.querySelector(MODEL_BUTTON_SELECTOR)) return;

    const modelDialog = getModelDialog();
    if (modelDialog) {
      if (!isModelFailureCoolingDown()) finishModelDialog(modelDialog);
      return;
    }
    if (running) return;
    if (isModelFailureCoolingDown()) return;

    if (isExpectedModel()) {
      start();
    } else {
      selectExpectedModel();
    }
  }, 1100);

  window.mufyAutoRetry = {
    start,
    stop,
    status: () => ({
      version: SCRIPT_VERSION,
      running,
      retries,
      maxRetries: displayMaxRetries(),
      model: getModelName(),
      expectedModel: CONFIG.expectedModel,
      hasStop: Boolean(getStopButton()),
      hasRetry: Boolean(getRetryButton()),
      hasRetryDialog: Boolean(getRetryDialog()),
      hasModelDialog: Boolean(getModelDialog()),
      rateLimitUntil,
      seedSent,
      latestText: getLatestAiText(),
    }),
  };
})();
