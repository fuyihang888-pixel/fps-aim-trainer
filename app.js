import {
  DEFAULT_SENSITIVITY,
  RESUME_COUNTDOWN_MS,
  calculateValorantDegreesPerCount,
  calculateValorantFallbackInputScale,
  calculateValorantRawInputScale,
  clampTargetToArena,
  getResumeCountdownSeconds,
  resolveEscapeAction,
  resolvePointerUnlockAction,
  shiftTrainingTimelineAfterPause,
  chooseTargetKind,
  createRoundStats,
  registerClick,
  registerTracking,
  summarizeRound
} from './engine.js?v=20260824-16';

const $ = (id) => document.getElementById(id);
const canvas = $('arena');
const context = canvas.getContext('2d');
const arenaWrap = $('arena-wrap');
const aimCrosshair = $('aim-crosshair');
const ROUND_DURATION_MS = 60_000;
const SENSITIVITY_SETTINGS_VERSION = 2;

const MODES = {
  static: {
    label: '静态点按',
    readyCopy: '点击红色靶心，强化甩枪后的停准。'
  },
  tracking: {
    label: '移动靶跟枪',
    readyCopy: '持续覆盖蓝色靶子，积累跟枪分数。'
  },
  mixed: {
    label: '混合训练',
    readyCopy: '静态点按与移动跟枪交替出现。'
  }
};

const saved = readStorage('vector-range') || {};
const initialSensitivity = resolveInitialSensitivity(saved);
const state = {
  running: false,
  paused: false,
  pauseStartedAt: 0,
  pauseMode: null,
  pauseActionPending: false,
  resumeCountdownStartedAt: 0,
  resumeCountdownTimer: 0,
  animationFrameId: 0,
  suppressWindowedEscapeUntil: 0,
  fullscreenActive: document.fullscreenElement === arenaWrap,
  mode: normalizeMode(saved.mode),
  stats: createRoundStats(),
  target: null,
  history: [],
  pointer: { x: -100, y: -100 },
  targetStartedAt: 0,
  targetEndsAt: 0,
  lastFrame: 0,
  roundEndsAt: 0,
  // Fallback pointer deltas are CSS pixels; locked deltas are raw counts.
  fallbackInputScale: 1,
  rawInputScale: 1,
  lockedSensitivity: DEFAULT_SENSITIVITY,
  rawInput: false,
  rawInputRequested: false,
  rawInputUnavailable: false,
  rawInputFallbackTimer: 0,
  pointerClient: null,
  width: 0,
  height: 0,
  bestScores: createBestScores(saved)
};

$('sensitivity-input').value = initialSensitivity;
saveSensitivitySetting(initialSensitivity);

function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function normalizeMode(mode) {
  return Object.hasOwn(MODES, mode) ? mode : 'mixed';
}

function safeScore(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function createBestScores(settings) {
  const stored = settings.bestScores && typeof settings.bestScores === 'object' ? settings.bestScores : {};
  return {
    static: safeScore(stored.static),
    tracking: safeScore(stored.tracking),
    mixed: safeScore(stored.mixed ?? settings.best)
  };
}

function saveStorage(result) {
  try {
    const previous = readStorage('vector-range') || {};
    const recent = Array.isArray(previous.recent) ? previous.recent : [];
    localStorage.setItem('vector-range', JSON.stringify({
      sensitivitySettingsVersion: SENSITIVITY_SETTINGS_VERSION,
      sensitivity: state.lockedSensitivity,
      mode: state.mode,
      best: state.bestScores.mixed,
      bestScores: state.bestScores,
      recent: [result, ...recent].slice(0, 10)
    }));
  } catch {
    // Persistence is optional; a blocked browser storage API must not stop training.
  }
}

function saveSensitivitySetting(sensitivity) {
  try {
    const previous = readStorage('vector-range') || {};
    const next = {
      ...previous,
      sensitivitySettingsVersion: SENSITIVITY_SETTINGS_VERSION,
      sensitivity
    };
    delete next.dpi;
    localStorage.setItem('vector-range', JSON.stringify(next));
  } catch {
    // The current session remains usable if browser storage is blocked.
  }
}

function formatDecimal(value, digits) {
  return Number(value.toFixed(digits)).toString();
}

function resolveInitialSensitivity(settings) {
  const sensitivityInput = $('sensitivity-input');
  sensitivityInput.value = Number(settings.sensitivity);
  return readSensitivityInput() ?? DEFAULT_SENSITIVITY;
}

function readSensitivityInput() {
  const sensitivityInput = $('sensitivity-input');
  const sensitivity = Number(sensitivityInput.value);
  if (
    !sensitivityInput.value.trim()
    || !sensitivityInput.checkValidity()
    || !Number.isFinite(sensitivity)
    || sensitivity <= 0
  ) return null;
  return sensitivity;
}

function renderSensitivityProfile(sensitivity) {
  $('sensitivity-profile').textContent = sensitivity
    ? formatDecimal(sensitivity, 6)
    : '等待有效参数';
}

function updateSensitivity() {
  const sensitivity = readSensitivityInput();
  if (!sensitivity) {
    $('degrees-per-count').textContent = '—';
    if (!state.running) renderSensitivityProfile(null);
    return null;
  }
  $('degrees-per-count').textContent = `${calculateValorantDegreesPerCount(sensitivity).toFixed(6)}°`;
  if (!state.running) renderSensitivityProfile(sensitivity);
  return sensitivity;
}

function normalizeSensitivityInput() {
  const sensitivity = readSensitivityInput();
  if (!sensitivity) {
    setInputStatus('请输入有效的游戏内灵敏度。');
    const input = $('sensitivity-input');
    input.focus();
    input.reportValidity();
    return null;
  }
  $('sensitivity-input').value = sensitivity;
  updateSensitivity();
  saveSensitivitySetting(sensitivity);
  setInputStatus('');
  return sensitivity;
}

function updateInputMode() {
  $('input-mode').textContent = state.paused
    ? state.pauseMode === 'countdown'
      ? '暂停 · 即将继续'
      : '训练已暂停'
    : state.rawInput
    ? '原始鼠标输入 · Valorant'
    : state.rawInputUnavailable
      ? '兼容鼠标输入 · 近似模式'
      : state.running
        ? '正在选择输入...'
        : '点击开始后自动选择';
}

function setSensitivityControlsDisabled(disabled) {
  $('sensitivity-input').disabled = disabled;
}

function resize() {
  const rect = arenaWrap.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  state.width = rect.width;
  state.height = rect.height;
  state.pointer.x = Math.max(0, Math.min(state.width, state.pointer.x));
  state.pointer.y = Math.max(0, Math.min(state.height, state.pointer.y));
  if (state.running && state.target) {
    state.target = clampTargetToArena(state.target, state.width, state.height);
  }
  if (state.running) {
    state.rawInputScale = calculateValorantRawInputScale(state.lockedSensitivity, state.width);
  }
  updateAimCrosshair();
}

function updateAimCrosshair() {
  if (!aimCrosshair) return;
  aimCrosshair.style.left = `${state.pointer.x}px`;
  aimCrosshair.style.top = `${state.pointer.y}px`;
}

function setAimCrosshairVisible(visible) {
  if (!aimCrosshair) return;
  aimCrosshair.hidden = !visible;
  if (visible) updateAimCrosshair();
}

function setTrainingCursorHidden(hidden) {
  arenaWrap.classList.toggle('training-active', hidden);
}

function pointInTarget(x, y, target) {
  return target && Math.hypot(x - target.x, y - target.y) <= target.radius;
}

function updateBestScore() {
  $('best-score').textContent = `最佳 ${state.bestScores[state.mode]}`;
}

function renderModeSelection() {
  const mode = MODES[state.mode];
  document.querySelectorAll('.mode-button').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
  });
  $('overlay-title').textContent = mode.label;
  $('overlay-copy').textContent = mode.readyCopy;
  $('target-label').textContent = `已选择 ${mode.label}`;
  updateBestScore();
}

function selectMode(mode) {
  if (state.running || !Object.hasOwn(MODES, mode)) return;
  state.mode = mode;
  renderModeSelection();
}

function setModeControlsDisabled(disabled) {
  document.querySelectorAll('.mode-button').forEach((button) => {
    button.disabled = disabled;
  });
}

function clearRawInputFallbackTimer() {
  if (!state.rawInputFallbackTimer) return;
  window.clearTimeout(state.rawInputFallbackTimer);
  state.rawInputFallbackTimer = 0;
}

function clearResumeCountdownTimer() {
  if (!state.resumeCountdownTimer) return;
  window.clearTimeout(state.resumeCountdownTimer);
  state.resumeCountdownTimer = 0;
}

function cancelScheduledFrame() {
  if (!state.animationFrameId) return;
  window.cancelAnimationFrame(state.animationFrameId);
  state.animationFrameId = 0;
}

function scheduleFrame() {
  if (state.animationFrameId || !state.running || state.paused) return;
  state.animationFrameId = window.requestAnimationFrame(frame);
}

function setPauseActionsDisabled(disabled) {
  document.querySelectorAll('#pause-menu button').forEach((button) => {
    button.disabled = disabled;
  });
}

function setInputStatus(message) {
  const status = $('input-error');
  status.textContent = message;
  status.hidden = !message;
}

function enableFallbackInput(message = '原始输入未启用，已自动切换兼容鼠标输入，可直接训练。') {
  state.rawInputRequested = false;
  state.rawInput = false;
  state.rawInputUnavailable = true;
  // A delayed lock request can still complete after the fallback timer. Release
  // it so subsequent pointer events continue through the normal client path.
  if (document.pointerLockElement === canvas) document.exitPointerLock?.();
  state.pointerClient = null;
  clearRawInputFallbackTimer();
  if (state.running) setInputStatus(message);
  updateInputMode();
}

function requestTrainingPointerLock({ allowPaused = false, timeoutMs = 1200 } = {}) {
  if (!state.running || (state.paused && !allowPaused)) return Promise.resolve(false);
  if (document.pointerLockElement === canvas) {
    state.rawInputRequested = true;
    state.rawInput = true;
    state.rawInputUnavailable = false;
    clearRawInputFallbackTimer();
    setInputStatus('');
    updateInputMode();
    return Promise.resolve(true);
  }
  if (!canvas.requestPointerLock) {
    enableFallbackInput('当前浏览器未提供原始输入，已自动切换兼容鼠标输入，可直接训练。');
    return Promise.resolve(false);
  }

  state.rawInputRequested = true;
  state.rawInputUnavailable = false;
  clearRawInputFallbackTimer();
  updateInputMode();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (locked) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('pointerlockchange', handleChange);
      document.removeEventListener('pointerlockerror', handleError);
      if (locked) {
        clearRawInputFallbackTimer();
        state.rawInput = true;
        state.rawInputUnavailable = false;
        setInputStatus('');
        updateInputMode();
      }
      resolve(locked);
    };
    const fallback = () => {
      if (state.running && state.rawInputRequested && !state.rawInput) enableFallbackInput();
      finish(false);
    };
    const handleChange = () => {
      if (document.pointerLockElement === canvas) finish(true);
      else fallback();
    };
    const handleError = () => fallback();

    document.addEventListener('pointerlockchange', handleChange);
    document.addEventListener('pointerlockerror', handleError);
    try {
      // unadjustedMovement bypasses Windows pointer speed and acceleration.
      // Do not fall back to legacy Pointer Lock: its deltas may be adjusted by
      // the operating system, unlike Valorant's raw hardware counts.
      const request = canvas.requestPointerLock({ unadjustedMovement: true });
      request?.then?.(() => {
        if (document.pointerLockElement === canvas) finish(true);
        else fallback();
      }, fallback);
      state.rawInputFallbackTimer = window.setTimeout(fallback, timeoutMs);
    } catch {
      fallback();
    }
  });
}

function synchronizePointerLockAfterFullscreenExit(requestSucceeded) {
  const locked = requestSucceeded && document.pointerLockElement === canvas;
  clearRawInputFallbackTimer();
  state.rawInputRequested = locked;
  state.rawInput = locked;
  state.rawInputUnavailable = !locked;
  state.pointerClient = null;
  setInputStatus(locked ? '' : '原始输入未启用，已自动切换兼容鼠标输入，可直接训练。');
  updateInputMode();
}

function createTarget() {
  const kind = chooseTargetKind(state.mode, state.history);
  state.history.push(kind);

  const margin = kind === 'click' ? 70 : 95;
  const radius = kind === 'click' ? 25 + Math.random() * 9 : 34;
  const x = margin + Math.random() * Math.max(1, state.width - margin * 2);
  const y = margin + Math.random() * Math.max(1, state.height - margin * 2);
  const duration = kind === 'click' ? 1050 : 2300;
  const speed = kind === 'track' ? 210 : 0;
  const angle = Math.random() * Math.PI * 2;

  state.target = {
    kind,
    x,
    y,
    radius,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    duration
  };
  state.targetStartedAt = performance.now();
  state.targetEndsAt = state.targetStartedAt + duration;
  $('target-label').textContent = kind === 'click' ? 'CLICK · 点击靶心' : 'TRACK · 保持覆盖';
}

function drawTarget(target, now) {
  const progress = Math.min(1, (now - state.targetStartedAt) / target.duration);
  const color = target.kind === 'click' ? '#ff5b6e' : '#4acbff';

  context.save();
  context.translate(target.x, target.y);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 2;
  context.globalAlpha = 0.2;
  context.beginPath();
  context.arc(0, 0, target.radius + 12, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;
  context.beginPath();
  context.arc(0, 0, target.radius, 0, Math.PI * 2);
  context.stroke();

  if (target.kind === 'click') {
    context.beginPath();
    context.arc(0, 0, target.radius * 0.43, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 0.7;
    context.beginPath();
    context.arc(0, 0, target.radius + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - progress));
    context.stroke();
  } else {
    context.globalAlpha = 0.65;
    context.beginPath();
    context.arc(0, 0, target.radius + 7, 0, Math.PI * 2);
    context.stroke();
    context.globalAlpha = 1;
    context.fillStyle = '#071016';
    context.fillRect(-7, -1, 14, 2);
    context.fillRect(-1, -7, 2, 14);
  }

  context.restore();
}

function updateHud() {
  const now = state.paused ? state.pauseStartedAt : performance.now();
  const remaining = Math.max(0, state.roundEndsAt - now);
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  $('time-value').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  $('score-value').textContent = String(state.stats.score).padStart(4, '0');
  $('combo-value').textContent = `${state.stats.combo}x`;
}

function frame(now) {
  state.animationFrameId = 0;
  if (!state.running || state.paused) return;

  const elapsed = now - state.lastFrame;
  state.lastFrame = now;
  if (now >= state.roundEndsAt) {
    finishRound();
    return;
  }

  context.clearRect(0, 0, state.width, state.height);
  if (!state.target) createTarget();
  const target = state.target;

  if (target.kind === 'track') {
    target.x += target.vx * elapsed / 1000;
    target.y += target.vy * elapsed / 1000;
    if (target.x < target.radius + 18 || target.x > state.width - target.radius - 18) target.vx *= -1;
    if (target.y < target.radius + 18 || target.y > state.height - target.radius - 18) target.vy *= -1;
    const covered = pointInTarget(state.pointer.x, state.pointer.y, target) ? elapsed : 0;
    state.stats = registerTracking(state.stats, covered, elapsed);
  }

  if (now >= state.targetEndsAt) createTarget();
  drawTarget(state.target, now);
  updateHud();
  scheduleFrame();
}

function startRound() {
  if (state.running) return;

  resize();
  const sensitivity = normalizeSensitivityInput();
  if (!sensitivity) return;
  state.lockedSensitivity = sensitivity;
  renderSensitivityProfile(sensitivity);
  state.fallbackInputScale = calculateValorantFallbackInputScale(state.lockedSensitivity);
  state.rawInputScale = calculateValorantRawInputScale(state.lockedSensitivity, state.width);
  state.rawInputUnavailable = false;
  state.rawInput = false;
  state.rawInputRequested = false;
  clearRawInputFallbackTimer();
  clearResumeCountdownTimer();
  cancelScheduledFrame();
  state.running = true;
  state.paused = false;
  state.pauseStartedAt = 0;
  state.pauseMode = null;
  state.pauseActionPending = false;
  state.resumeCountdownStartedAt = 0;
  state.suppressWindowedEscapeUntil = 0;
  state.fullscreenActive = document.fullscreenElement === arenaWrap;
  state.stats = createRoundStats();
  state.history = [];
  state.target = null;
  state.pointer = { x: state.width / 2, y: state.height / 2 };
  state.pointerClient = null;
  setTrainingCursorHidden(true);
  setAimCrosshairVisible(true);
  state.roundEndsAt = performance.now() + ROUND_DURATION_MS;
  state.lastFrame = performance.now();
  $('ready-overlay').hidden = true;
  $('result-overlay').hidden = true;
  $('pause-overlay').hidden = true;
  setInputStatus('');
  $('start-button').disabled = true;
  $('start-button').textContent = '训练中...';
  setModeControlsDisabled(true);
  setSensitivityControlsDisabled(true);
  requestTrainingPointerLock();
  createTarget();
  scheduleFrame();
}

function resetRoundInteraction() {
  clearResumeCountdownTimer();
  cancelScheduledFrame();
  state.running = false;
  state.paused = false;
  state.pauseStartedAt = 0;
  state.pauseMode = null;
  state.pauseActionPending = false;
  state.resumeCountdownStartedAt = 0;
  state.suppressWindowedEscapeUntil = 0;
  state.rawInputRequested = false;
  state.rawInput = false;
  state.rawInputUnavailable = false;
  state.pointerClient = null;
  clearRawInputFallbackTimer();
  setTrainingCursorHidden(false);
  setAimCrosshairVisible(false);
  $('pause-overlay').hidden = true;
  $('pause-menu').hidden = false;
  $('resume-countdown').hidden = true;
  setPauseActionsDisabled(false);
  document.exitPointerLock?.();
  setInputStatus('');
  updateInputMode();
}

function finishRound() {
  if (!state.running) return;

  const summary = summarizeRound(state.stats);
  resetRoundInteraction();
  state.bestScores[state.mode] = Math.max(state.bestScores[state.mode], summary.totalScore);
  saveStorage({
    mode: state.mode,
    modeLabel: MODES[state.mode].label,
    ...summary,
    finishedAt: new Date().toISOString()
  });

  $('result-mode').textContent = MODES[state.mode].label;
  $('result-score').textContent = summary.totalScore;
  $('result-click-score').textContent = summary.clickScore;
  $('result-tracking-score').textContent = summary.trackingScore;
  $('result-accuracy').textContent = `${summary.clickAccuracy}%`;
  $('result-reaction').textContent = `${summary.averageReaction} ms`;
  $('result-coverage').textContent = `${summary.trackCoverage}%`;
  $('result-track-time').textContent = `${(summary.trackCoveredMs / 1000).toFixed(1)} s`;
  $('result-combo').textContent = `${summary.bestCombo}x`;
  $('time-value').textContent = '00:00';
  $('result-overlay').hidden = false;
  $('target-label').textContent = '训练完成';
  updateBestScore();
  $('start-button').disabled = false;
  $('start-button').innerHTML = '开始训练 <span>60S</span>';
  setModeControlsDisabled(false);
  setSensitivityControlsDisabled(false);
}

function cancelRound() {
  if (!state.running) return;

  resetRoundInteraction();
  state.stats = createRoundStats();
  state.target = null;
  state.history = [];
  context.clearRect(0, 0, state.width, state.height);
  $('time-value').textContent = '01:00';
  $('score-value').textContent = '0000';
  $('combo-value').textContent = '0x';
  $('result-overlay').hidden = true;
  $('ready-overlay').hidden = false;
  $('start-button').disabled = false;
  $('start-button').innerHTML = '开始训练 <span>60S</span>';
  setModeControlsDisabled(false);
  setSensitivityControlsDisabled(false);
  setInputStatus('');
  renderModeSelection();
  updateInputMode();
}

function pauseRound() {
  if (!state.running || state.paused) return;

  state.paused = true;
  state.pauseStartedAt = performance.now();
  state.pauseMode = 'menu';
  state.pauseActionPending = false;
  state.rawInputRequested = false;
  state.rawInput = false;
  state.pointerClient = null;
  clearRawInputFallbackTimer();
  clearResumeCountdownTimer();
  cancelScheduledFrame();
  document.exitPointerLock?.();
  setTrainingCursorHidden(false);
  setAimCrosshairVisible(false);
  $('pause-overlay').hidden = false;
  $('pause-menu').hidden = false;
  $('resume-countdown').hidden = true;
  setPauseActionsDisabled(false);
  $('target-label').textContent = '训练已暂停';
  updateHud();
  updateInputMode();
  $('continue-training-button').focus();
}

function resumeRound({ requestInput = true } = {}) {
  if (!state.running || !state.paused) return;

  const resumedAt = performance.now();
  const timeline = shiftTrainingTimelineAfterPause({
    roundEndsAt: state.roundEndsAt,
    targetStartedAt: state.targetStartedAt,
    targetEndsAt: state.targetEndsAt,
    lastFrame: state.lastFrame
  }, state.pauseStartedAt, resumedAt);
  Object.assign(state, timeline);
  clearResumeCountdownTimer();
  state.paused = false;
  state.pauseStartedAt = 0;
  state.pauseMode = null;
  state.pauseActionPending = false;
  state.resumeCountdownStartedAt = 0;
  state.suppressWindowedEscapeUntil = 0;
  $('pause-overlay').hidden = true;
  $('pause-menu').hidden = false;
  $('resume-countdown').hidden = true;
  setPauseActionsDisabled(false);
  setTrainingCursorHidden(true);
  setAimCrosshairVisible(true);
  $('target-label').textContent = state.target?.kind === 'click'
    ? 'CLICK · 点击靶心'
    : 'TRACK · 保持覆盖';
  updateHud();
  updateInputMode();
  if (requestInput && document.pointerLockElement !== canvas) requestTrainingPointerLock();
  scheduleFrame();
}

function renderResumeCountdown() {
  if (!state.running || !state.paused || state.pauseMode !== 'countdown') return;

  const now = performance.now();
  const seconds = getResumeCountdownSeconds(state.resumeCountdownStartedAt, now);
  if (seconds === 0) {
    resumeRound({ requestInput: false });
    return;
  }

  $('resume-countdown-value').textContent = seconds;
  const elapsed = Math.max(0, now - state.resumeCountdownStartedAt);
  const nextBoundary = Math.min(
    RESUME_COUNTDOWN_MS,
    (Math.floor(elapsed / 1000) + 1) * 1000
  );
  state.resumeCountdownTimer = window.setTimeout(
    renderResumeCountdown,
    Math.max(16, nextBoundary - elapsed)
  );
}

function startWindowedResumeCountdown() {
  if (!state.running || !state.paused) return;

  clearResumeCountdownTimer();
  state.pauseMode = 'countdown';
  state.resumeCountdownStartedAt = performance.now();
  state.suppressWindowedEscapeUntil = 0;
  $('pause-menu').hidden = true;
  $('resume-countdown').hidden = false;
  $('resume-countdown-value').textContent = '3';
  $('target-label').textContent = '3 秒后继续';
  updateInputMode();
  renderResumeCountdown();
}

function beginPauseAction() {
  if (!state.running || !state.paused || state.pauseActionPending || state.pauseMode !== 'menu') return false;
  state.pauseActionPending = true;
  setPauseActionsDisabled(true);
  return true;
}

async function continueTraining() {
  if (!beginPauseAction()) return;

  if (document.pointerLockElement !== canvas) {
    requestTrainingPointerLock({ allowPaused: true });
  }
  let fullscreenRequest;
  if (document.fullscreenElement !== arenaWrap) {
    try {
      fullscreenRequest = arenaWrap.requestFullscreen?.();
    } catch {
      // Continuing in windowed mode is still preferable to discarding the run.
    }
  }
  try {
    await fullscreenRequest;
  } catch {
    // Continuing in windowed mode is still preferable to discarding the run.
  }
  resumeRound({ requestInput: false });
}

async function exitFullscreenAndResume() {
  if (!beginPauseAction()) return;

  const pointerLockRequest = document.pointerLockElement === canvas
    ? Promise.resolve(true)
    : requestTrainingPointerLock({ allowPaused: true, timeoutMs: 500 });
  let exitRequest;
  if (document.fullscreenElement) {
    try {
      exitRequest = document.exitFullscreen?.();
    } catch {
      // The browser may already have completed its native Escape transition.
    }
  }
  try {
    await exitRequest;
  } catch {
    // The browser may already have completed its native Escape transition.
  }
  const pointerLockGranted = await pointerLockRequest;
  synchronizePointerLockAfterFullscreenExit(pointerLockGranted);
  startWindowedResumeCountdown();
}

async function exitFullscreenAndCancel() {
  if (!beginPauseAction()) return;

  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen?.();
    } catch {
      // Cancel the round even if the browser already left fullscreen.
    }
  }
  cancelRound();
}

function toggleFullscreen() {
  if (state.paused) return;
  if (!document.fullscreenElement) {
    arenaWrap.requestFullscreen?.().then(() => {
      if (state.running) requestTrainingPointerLock();
    }).catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

function pointerPosition(event) {
  if (!state.running || state.paused) return;
  if (document.pointerLockElement === canvas) {
    if (!state.rawInput) return;
    state.pointer.x = Math.max(0, Math.min(state.width, state.pointer.x + event.movementX * state.rawInputScale));
    state.pointer.y = Math.max(0, Math.min(state.height, state.pointer.y + event.movementY * state.rawInputScale));
    updateAimCrosshair();
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const nextClient = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (!state.running || !state.pointerClient) {
    state.pointerClient = nextClient;
    state.pointer = nextClient;
    updateAimCrosshair();
    return;
  }

  const deltaX = (nextClient.x - state.pointerClient.x) * state.fallbackInputScale;
  const deltaY = (nextClient.y - state.pointerClient.y) * state.fallbackInputScale;
  state.pointerClient = nextClient;
  state.pointer.x = Math.max(0, Math.min(state.width, state.pointer.x + deltaX));
  state.pointer.y = Math.max(0, Math.min(state.height, state.pointer.y + deltaY));
  updateAimCrosshair();
}

$('sensitivity-input').addEventListener('input', () => {
  const sensitivity = updateSensitivity();
  if (sensitivity) {
    saveSensitivitySetting(sensitivity);
    setInputStatus('');
  }
});
$('sensitivity-input').addEventListener('blur', normalizeSensitivityInput);
document.querySelectorAll('.mode-button').forEach((button) => {
  button.addEventListener('click', () => selectMode(button.dataset.mode));
});
canvas.addEventListener('pointermove', pointerPosition);
canvas.addEventListener('pointerdown', (event) => {
  if (!state.running || state.paused || state.target?.kind !== 'click') return;

  pointerPosition(event);
  const hit = pointInTarget(state.pointer.x, state.pointer.y, state.target);
  state.stats = registerClick(state.stats, hit, performance.now() - state.targetStartedAt);
  if (hit) createTarget();
});
$('start-button').addEventListener('click', startRound);
$('restart-button').addEventListener('click', startRound);
$('exit-fullscreen-button').addEventListener('click', exitFullscreenAndResume);
$('continue-training-button').addEventListener('click', continueTraining);
$('exit-and-end-button').addEventListener('click', exitFullscreenAndCancel);
$('fullscreen-button').addEventListener('click', toggleFullscreen);
window.addEventListener('resize', resize);
document.addEventListener('fullscreenchange', () => {
  const wasFullscreen = state.fullscreenActive;
  state.fullscreenActive = document.fullscreenElement === arenaWrap;
  resize();
  if (wasFullscreen && !state.fullscreenActive && state.running) {
    if (!state.paused) pauseRound();
    if (state.pauseMode === 'menu' && !state.pauseActionPending) {
      state.suppressWindowedEscapeUntil = performance.now() + 250;
    }
  }
});
document.addEventListener('pointerlockchange', () => {
  const wasRawInput = state.rawInput;
  const lockedToCanvas = document.pointerLockElement === canvas;
  // A lock promise/event can arrive after the fallback path has already
  // invalidated the request. Do not leave the document locked in that state:
  // pointerPosition would otherwise ignore all compatible pointer events.
  if (lockedToCanvas && !state.rawInputRequested) {
    state.rawInput = false;
    document.exitPointerLock?.();
    updateInputMode();
    return;
  }

  state.rawInput = state.rawInputRequested && lockedToCanvas;
  if (state.rawInput) {
    clearRawInputFallbackTimer();
    state.rawInputUnavailable = false;
    setInputStatus('');
  } else if (wasRawInput && state.running) {
    state.rawInputRequested = false;
    clearRawInputFallbackTimer();
    state.pointerClient = null;
    const action = resolvePointerUnlockAction(state);
    if (action === 'fallback') {
      state.rawInputUnavailable = true;
      setInputStatus('原始输入已释放，继续时将使用兼容鼠标输入。');
    } else if (action === 'pause') {
      pauseRound();
    } else if (action === 'cancel') {
      cancelRound();
      return;
    }
  } else if (state.running && !state.paused && state.rawInputRequested) {
    enableFallbackInput('指针锁定未启用，已自动切换兼容鼠标输入，可直接训练。');
  }
  updateInputMode();
});
document.addEventListener('pointerlockerror', () => {
  if (state.running && state.rawInputRequested) enableFallbackInput();
});
window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  if (event.key === 'Escape' && state.running) {
    const action = resolveEscapeAction(state, performance.now());
    if (action === 'suppress') state.suppressWindowedEscapeUntil = 0;
    else if (action === 'pause') pauseRound();
    else if (action === 'cancel') cancelRound();
    return;
  }
  if (event.key.toLowerCase() === 'f') {
    event.preventDefault();
    toggleFullscreen();
  }
});

setSensitivityControlsDisabled(false);
updateInputMode();
updateSensitivity();
resize();
renderModeSelection();
