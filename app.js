import {
  DEFAULT_SENSITIVITY,
  RESUME_COUNTDOWN_MS,
  applyValorantMouseCounts,
  calculateValorantDegreesPerCount,
  calculateValorantProjection,
  getResumeCountdownSeconds,
  moveTargetByScreenVelocity,
  projectValorantAngles,
  resolveEscapeAction,
  resolvePointerUnlockAction,
  screenPointToValorantAngles,
  shiftTrainingTimelineAfterPause,
  chooseTargetKind,
  createRoundStats,
  registerClick,
  registerTracking,
  summarizeRound
} from './engine.js?v=20260824-19';

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
  starting: false,
  startToken: 0,
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
  targetStartedAt: 0,
  targetEndsAt: 0,
  startedAt: 0,
  lastFrame: 0,
  roundEndsAt: 0,
  view: { yawDeg: 0, pitchDeg: 0 },
  projection: calculateValorantProjection(1, 1),
  lockedSensitivity: DEFAULT_SENSITIVITY,
  rawInput: false,
  rawInputRequested: false,
  rawInputUnavailable: false,
  inputRequest: null,
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
      : state.running || state.starting
        ? '正在选择输入...'
        : '点击开始后自动选择';
}

function setSensitivityControlsDisabled(disabled) {
  $('sensitivity-input').disabled = disabled;
}

function resize() {
  const rect = arenaWrap.getBoundingClientRect();
  const width = Math.max(1, arenaWrap.clientWidth || rect.width);
  const height = Math.max(1, arenaWrap.clientHeight || rect.height);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  state.width = width;
  state.height = height;
  state.projection = calculateValorantProjection(state.width, state.height);
  updateAimCrosshair();
}

function updateAimCrosshair() {
  if (!aimCrosshair) return;
  aimCrosshair.style.left = '50%';
  aimCrosshair.style.top = '50%';
}

function setAimCrosshairVisible(visible) {
  if (!aimCrosshair) return;
  aimCrosshair.hidden = !visible;
  if (visible) updateAimCrosshair();
}

function setTrainingCursorHidden(hidden) {
  arenaWrap.classList.toggle('training-active', hidden);
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
  const changed = status.textContent !== message || status.hidden === Boolean(message);
  status.textContent = message;
  status.hidden = !message;
  if (changed && state.width > 0) resize();
}

function setFallbackInput(message = '原始输入未启用，已自动切换兼容鼠标输入，可直接训练。') {
  state.rawInputRequested = false;
  state.rawInput = false;
  state.rawInputUnavailable = true;
  state.pointerClient = null;
  if (document.pointerLockElement === canvas) document.exitPointerLock?.();
  if (state.running || state.starting) setInputStatus(message);
  updateInputMode();
}

function cancelInputRequest() {
  state.inputRequest?.cancel();
}

function requestTrainingPointerLock({ allowPaused = false, timeoutMs = 1200, token = state.startToken } = {}) {
  const canRequest = state.starting || (state.running && (!state.paused || allowPaused));
  if (!canRequest) return Promise.resolve('cancelled');
  cancelInputRequest();

  if (document.pointerLockElement === canvas) {
    state.rawInputRequested = true;
    state.rawInput = true;
    state.rawInputUnavailable = false;
    setInputStatus('');
    updateInputMode();
    return Promise.resolve('raw');
  }
  if (!canvas.requestPointerLock) {
    setFallbackInput('当前浏览器未提供原始输入，已自动切换兼容鼠标输入，可直接训练。');
    return Promise.resolve('fallback');
  }

  state.rawInputRequested = true;
  state.rawInput = false;
  state.rawInputUnavailable = false;
  updateInputMode();
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = 0;
    const cleanup = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      document.removeEventListener('pointerlockchange', handleChange);
      document.removeEventListener('pointerlockerror', handleError);
      if (state.inputRequest?.token === token) state.inputRequest = null;
    };
    const finish = (mode, message) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (mode === 'raw') {
        state.rawInputRequested = true;
        state.rawInput = true;
        state.rawInputUnavailable = false;
        setInputStatus('');
        updateInputMode();
      } else if (mode === 'fallback') {
        setFallbackInput(message);
      } else {
        state.rawInputRequested = false;
        state.rawInput = false;
        if (document.pointerLockElement === canvas) document.exitPointerLock?.();
      }
      resolve(mode);
    };
    const fallback = () => {
      finish('fallback');
    };
    const handleChange = () => {
      if (document.pointerLockElement === canvas) finish('raw');
      else fallback();
    };
    const handleError = () => fallback();

    state.inputRequest = {
      token,
      cancel: () => finish('cancelled')
    };
    document.addEventListener('pointerlockchange', handleChange);
    document.addEventListener('pointerlockerror', handleError);
    try {
      // unadjustedMovement bypasses Windows pointer speed and acceleration.
      // Do not fall back to legacy Pointer Lock: its deltas may be adjusted by
      // the operating system, unlike Valorant's raw hardware counts.
      const request = canvas.requestPointerLock({ unadjustedMovement: true });
      request?.then?.(() => {
        if (document.pointerLockElement === canvas) finish('raw');
        else fallback();
      }, fallback);
      if (!settled) timeoutId = window.setTimeout(fallback, timeoutMs);
    } catch {
      fallback();
    }
  });
}

function synchronizePointerLockAfterFullscreenExit(inputMode) {
  if (inputMode === 'raw' && document.pointerLockElement === canvas) return;
  setFallbackInput();
}

function projectTarget(target) {
  if (!target) return null;
  return projectValorantAngles(
    target.yawDeg,
    target.pitchDeg,
    state.view,
    state.width,
    state.height
  );
}

function crosshairCoversTarget(target) {
  const point = projectTarget(target);
  return point?.visible && Math.hypot(
    point.x - state.projection.width / 2,
    point.y - state.projection.height / 2
  ) <= target.radius;
}

function createTarget(now = performance.now()) {
  const kind = chooseTargetKind(state.mode, state.history);
  state.history.push(kind);

  const margin = kind === 'click' ? 70 : 95;
  const radius = kind === 'click' ? 25 + Math.random() * 9 : 34;
  const x = margin + Math.random() * Math.max(1, state.projection.width - margin * 2);
  const y = margin + Math.random() * Math.max(1, state.projection.height - margin * 2);
  const duration = kind === 'click' ? 1050 : 2300;
  const speed = kind === 'track' ? 210 : 0;
  const angle = Math.random() * Math.PI * 2;
  const angles = screenPointToValorantAngles(
    x,
    y,
    state.view,
    state.projection.width,
    state.projection.height
  );

  state.target = {
    kind,
    ...angles,
    radius,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    duration
  };
  state.targetStartedAt = now;
  state.targetEndsAt = state.targetStartedAt + duration;
  $('target-label').textContent = kind === 'click' ? 'CLICK · 点击靶心' : 'TRACK · 保持覆盖';
}

function drawTarget(target, now) {
  const point = projectTarget(target);
  if (!point?.visible) return;
  const progress = Math.min(1, (now - state.targetStartedAt) / target.duration);
  const color = target.kind === 'click' ? '#ff5b6e' : '#4acbff';

  context.save();
  context.translate(point.x, point.y);
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
    state.target = moveTargetByScreenVelocity(
      target,
      state.view,
      state.width,
      state.height,
      elapsed
    );
    const covered = crosshairCoversTarget(state.target) ? elapsed : 0;
    state.stats = registerTracking(state.stats, covered, elapsed);
  }

  if (now >= state.targetEndsAt) createTarget(now);
  drawTarget(state.target, now);
  updateHud();
  scheduleFrame();
}

function restoreStartControls() {
  $('start-button').disabled = false;
  $('start-button').innerHTML = '开始训练 <span>60S</span>';
  setModeControlsDisabled(false);
  setSensitivityControlsDisabled(false);
}

function cancelPendingStart() {
  if (!state.starting) return;
  state.starting = false;
  state.startToken += 1;
  state.rawInputRequested = false;
  state.rawInput = false;
  state.rawInputUnavailable = false;
  cancelInputRequest();
  setTrainingCursorHidden(false);
  setAimCrosshairVisible(false);
  document.exitPointerLock?.();
  setInputStatus('');
  restoreStartControls();
  renderModeSelection();
  updateInputMode();
}

function beginRoundAfterInput(token, inputMode) {
  if (!state.starting || token !== state.startToken || inputMode === 'cancelled') return;
  if (inputMode === 'raw' && document.pointerLockElement !== canvas) {
    setFallbackInput('原始输入在训练开始前已释放，已自动切换兼容鼠标输入。');
  }

  const startedAt = performance.now();
  state.starting = false;
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
  state.view = { yawDeg: 0, pitchDeg: 0 };
  state.pointerClient = null;
  state.startedAt = startedAt;
  state.roundEndsAt = startedAt + ROUND_DURATION_MS;
  state.lastFrame = startedAt;
  setTrainingCursorHidden(true);
  setAimCrosshairVisible(true);
  $('ready-overlay').hidden = true;
  $('result-overlay').hidden = true;
  $('pause-overlay').hidden = true;
  $('start-button').textContent = '训练中...';
  createTarget(startedAt);
  updateHud();
  updateInputMode();
  scheduleFrame();
}

async function startRound() {
  if (state.running || state.starting) return;

  resize();
  const sensitivity = normalizeSensitivityInput();
  if (!sensitivity) return;
  state.lockedSensitivity = sensitivity;
  renderSensitivityProfile(sensitivity);
  state.rawInputUnavailable = false;
  state.rawInput = false;
  state.rawInputRequested = false;
  clearResumeCountdownTimer();
  cancelScheduledFrame();
  state.starting = true;
  const token = ++state.startToken;
  setInputStatus('');
  $('time-value').textContent = '01:00';
  $('score-value').textContent = '0000';
  $('combo-value').textContent = '0x';
  $('start-button').disabled = true;
  $('start-button').textContent = '正在启用输入...';
  setModeControlsDisabled(true);
  setSensitivityControlsDisabled(true);
  updateInputMode();

  // Pointer Lock must be requested synchronously inside the click activation.
  const inputMode = await requestTrainingPointerLock({ token });
  beginRoundAfterInput(token, inputMode);
}

function resetRoundInteraction() {
  clearResumeCountdownTimer();
  cancelScheduledFrame();
  state.starting = false;
  state.running = false;
  state.startToken += 1;
  state.paused = false;
  state.pauseStartedAt = 0;
  state.pauseMode = null;
  state.pauseActionPending = false;
  state.resumeCountdownStartedAt = 0;
  state.suppressWindowedEscapeUntil = 0;
  state.startedAt = 0;
  state.lastFrame = 0;
  state.roundEndsAt = 0;
  state.targetStartedAt = 0;
  state.targetEndsAt = 0;
  state.rawInputRequested = false;
  state.rawInput = false;
  state.rawInputUnavailable = false;
  state.pointerClient = null;
  cancelInputRequest();
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
  restoreStartControls();
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
  cancelInputRequest();
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

function resumeRound({ requestInput = false } = {}) {
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
  state.pointerClient = null;
  $('target-label').textContent = state.target?.kind === 'click'
    ? 'CLICK · 点击靶心'
    : 'TRACK · 保持覆盖';
  updateHud();
  updateInputMode();
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

  const token = ++state.startToken;
  const inputRequest = requestTrainingPointerLock({ allowPaused: true, token });
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
  const inputMode = await inputRequest;
  if (
    token !== state.startToken
    || inputMode === 'cancelled'
    || !state.running
    || !state.paused
    || !state.pauseActionPending
  ) return;
  if (inputMode === 'raw' && document.pointerLockElement !== canvas) setFallbackInput();
  resumeRound({ requestInput: false });
}

async function exitFullscreenAndResume() {
  if (!beginPauseAction()) return;

  const token = ++state.startToken;
  const pointerLockRequest = document.pointerLockElement === canvas
    ? Promise.resolve('raw')
    : requestTrainingPointerLock({ allowPaused: true, timeoutMs: 500, token });
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
  const inputMode = await pointerLockRequest;
  if (
    token !== state.startToken
    || inputMode === 'cancelled'
    || !state.running
    || !state.paused
    || !state.pauseActionPending
  ) return;
  synchronizePointerLockAfterFullscreenExit(inputMode);
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
  if (state.paused || state.starting) return;
  if (!document.fullscreenElement) {
    arenaWrap.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

function pointerPosition(event) {
  if (!state.running || state.paused) return;
  if (document.pointerLockElement === canvas) {
    if (!state.rawInput) return;
    // Raw Pointer Lock movement is already expressed in hardware counts.
    state.view = applyValorantMouseCounts(
      state.view,
      event.movementX,
      event.movementY,
      state.lockedSensitivity
    );
    return;
  } else if (!state.rawInputUnavailable) {
    return;
  }

  let movementX = Number.isFinite(event.movementX) ? event.movementX : 0;
  let movementY = Number.isFinite(event.movementY) ? event.movementY : 0;
  // Derive compatible-mode deltas from client coordinates when the browser
  // does not populate movementX/movementY outside Pointer Lock.
  const rect = canvas.getBoundingClientRect();
  if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
    const nextClient = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
    if (!state.pointerClient) {
      state.pointerClient = nextClient;
      return;
    }
    movementX = nextClient.x - state.pointerClient.x;
    movementY = nextClient.y - state.pointerClient.y;
    state.pointerClient = nextClient;
  }

  // Unadjusted Pointer Lock reports hardware counts. Compatible movement is a
  // CSS-pixel approximation, but follows the identical Valorant angle formula.
  state.view = applyValorantMouseCounts(
    state.view,
    movementX,
    movementY,
    state.lockedSensitivity
  );
}

// Pointer Lock is specified in terms of `mousemove`; some browsers also emit
// `pointermove`, while others do not. Keep the fallback pointer path available
// without applying one physical sample twice when both events are delivered.
let lastMouseMoveTimeStamp = null;
function pointerMoveEvent(event) {
  if (event.type === 'pointermove' && event.timeStamp === lastMouseMoveTimeStamp) return;
  if (event.type === 'mousemove') lastMouseMoveTimeStamp = event.timeStamp;
  pointerPosition(event);
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
canvas.addEventListener('mousemove', pointerMoveEvent);
canvas.addEventListener('pointermove', pointerMoveEvent);
canvas.addEventListener('pointerdown', (event) => {
  if (!state.running || state.paused || state.target?.kind !== 'click') return;

  const hit = crosshairCoversTarget(state.target);
  state.stats = registerClick(state.stats, hit, performance.now() - state.targetStartedAt);
  if (hit) createTarget(performance.now());
});
$('start-button').addEventListener('click', startRound);
$('restart-button').addEventListener('click', startRound);
$('exit-fullscreen-button').addEventListener('click', exitFullscreenAndResume);
$('continue-training-button').addEventListener('click', continueTraining);
$('exit-and-end-button').addEventListener('click', exitFullscreenAndCancel);
$('fullscreen-button').addEventListener('click', toggleFullscreen);
window.addEventListener('resize', resize);
if (typeof ResizeObserver === 'function') {
  const arenaResizeObserver = new ResizeObserver(resize);
  arenaResizeObserver.observe(arenaWrap);
}
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
  // A timed-out or cancelled request may still complete later. Never let that
  // stale event change the input formula in the middle of an active segment.
  if (lockedToCanvas && !state.rawInputRequested) {
    state.rawInput = false;
    document.exitPointerLock?.();
    updateInputMode();
    return;
  }

  state.rawInput = state.rawInputRequested && lockedToCanvas;
  if (state.rawInput) {
    state.rawInputUnavailable = false;
    setInputStatus('');
  } else if (wasRawInput && state.running) {
    state.rawInputRequested = false;
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
  }
  updateInputMode();
});
window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  if (event.key === 'Escape' && state.starting) {
    cancelPendingStart();
    return;
  }
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
