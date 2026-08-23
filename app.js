import {
  DEFAULT_DPI,
  DEFAULT_SENSITIVITY,
  calculateEDpi,
  calculateValorantCm360,
  calculateValorantInputScale,
  calculateValorantRawInputScale,
  resolveValorantSettings,
  chooseTargetKind,
  createRoundStats,
  registerClick,
  registerTracking,
  summarizeRound
} from './engine.js?v=20260823-12';

const $ = (id) => document.getElementById(id);
const canvas = $('arena');
const context = canvas.getContext('2d');
const arenaWrap = $('arena-wrap');
const aimCrosshair = $('aim-crosshair');
const ROUND_DURATION_MS = 60_000;

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
const state = {
  running: false,
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
  inputScale: 1,
  fallbackInputScale: 1,
  rawInputScale: 1,
  lockedDpi: DEFAULT_DPI,
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

// Sensitivity is deliberately reset on each page load. A visitor can tune it
// for the current session, while every fresh visit starts from the shared
// Valorant reference preset.
$('dpi-input').value = DEFAULT_DPI;
$('sensitivity-input').value = DEFAULT_SENSITIVITY;

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
      mode: state.mode,
      best: state.bestScores.mixed,
      bestScores: state.bestScores,
      recent: [result, ...recent].slice(0, 10)
    }));
  } catch {
    // Persistence is optional; a blocked browser storage API must not stop training.
  }
}

function formatDecimal(value, digits) {
  return Number(value.toFixed(digits)).toString();
}

function updateSensitivity() {
  const settings = resolveValorantSettings(
    Number($('dpi-input').value),
    Number($('sensitivity-input').value)
  );
  $('edpi-value').textContent = formatDecimal(calculateEDpi(settings.dpi, settings.sensitivity), 3);
  $('effective-sensitivity').textContent = `${calculateValorantInputScale(settings.dpi, settings.sensitivity).toFixed(6)}x`;
  $('cm360-value').textContent = `${calculateValorantCm360(settings.dpi, settings.sensitivity).toFixed(2)} cm`;
}

function normalizeSensitivityInputs() {
  const settings = resolveValorantSettings(
    Number($('dpi-input').value),
    Number($('sensitivity-input').value)
  );
  $('dpi-input').value = settings.dpi;
  $('sensitivity-input').value = settings.sensitivity;
  updateSensitivity();
  return settings;
}

function updateInputMode() {
  $('input-mode').textContent = state.rawInput
    ? '原始鼠标输入 · Valorant'
    : state.rawInputUnavailable
      ? '兼容鼠标输入 · 灵敏度已应用'
      : state.running
        ? '正在选择输入...'
        : '点击开始后自动选择';
}

function setSensitivityControlsDisabled(disabled) {
  ['dpi-input', 'sensitivity-input'].forEach((id) => {
    $(id).disabled = disabled;
  });
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

function requestTrainingPointerLock() {
  if (!canvas.requestPointerLock) {
    enableFallbackInput('当前浏览器未提供原始输入，已自动切换兼容鼠标输入，可直接训练。');
    return;
  }

  state.rawInputRequested = true;
  state.rawInputUnavailable = false;
  updateInputMode();
  const fallback = () => {
    if (state.running && state.rawInputRequested && !state.rawInput) {
      enableFallbackInput();
    }
  };
  try {
    // unadjustedMovement bypasses Windows pointer speed and acceleration.
    // Do not fall back to the legacy pointer-lock form here: its movementX/Y
    // values can already be OS-accelerated coordinates, not Valorant-style
    // raw counts. The normal pointer-event path below is the explicit
    // compatibility mode for browsers that reject unadjusted movement.
    const request = canvas.requestPointerLock({ unadjustedMovement: true });
    request?.catch?.(() => {
      fallback();
    });
    if (state.rawInputRequested) {
      state.rawInputFallbackTimer = window.setTimeout(fallback, 1200);
    }
  } catch {
    fallback();
  }
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
  const remaining = Math.max(0, state.roundEndsAt - performance.now());
  const seconds = Math.ceil(remaining / 1000);
  $('time-value').textContent = `00:${String(seconds).padStart(2, '0')}`;
  $('score-value').textContent = String(state.stats.score).padStart(4, '0');
  $('combo-value').textContent = `${state.stats.combo}x`;
}

function frame(now) {
  if (!state.running) return;

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
  requestAnimationFrame(frame);
}

function startRound() {
  if (state.running) return;

  resize();
  const settings = normalizeSensitivityInputs();
  state.lockedDpi = settings.dpi;
  state.lockedSensitivity = settings.sensitivity;
  state.inputScale = calculateValorantInputScale(state.lockedDpi, state.lockedSensitivity);
  state.fallbackInputScale = state.inputScale;
  state.rawInputScale = calculateValorantRawInputScale(state.lockedSensitivity, state.width);
  state.rawInputUnavailable = false;
  state.rawInput = false;
  state.rawInputRequested = false;
  clearRawInputFallbackTimer();
  state.running = true;
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
  setInputStatus('');
  $('start-button').disabled = true;
  $('start-button').textContent = '训练中...';
  setModeControlsDisabled(true);
  setSensitivityControlsDisabled(true);
  requestTrainingPointerLock();
  createTarget();
  requestAnimationFrame(frame);
}

function finishRound() {
  if (!state.running) return;

  state.running = false;
  setTrainingCursorHidden(false);
  state.rawInputRequested = false;
  state.rawInput = false;
  clearRawInputFallbackTimer();
  document.exitPointerLock?.();
  setAimCrosshairVisible(false);
  const summary = summarizeRound(state.stats);
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
  $('result-overlay').hidden = false;
  $('target-label').textContent = '训练完成';
  updateBestScore();
  $('start-button').disabled = false;
  $('start-button').innerHTML = '开始训练 <span>60S</span>';
  setModeControlsDisabled(false);
  setSensitivityControlsDisabled(false);
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    arenaWrap.requestFullscreen?.().then(() => {
      if (state.running) requestTrainingPointerLock();
    }).catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

function pointerPosition(event) {
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

['dpi-input', 'sensitivity-input'].forEach((id) => {
  $(id).addEventListener('input', updateSensitivity);
  $(id).addEventListener('blur', normalizeSensitivityInputs);
});
document.querySelectorAll('.mode-button').forEach((button) => {
  button.addEventListener('click', () => selectMode(button.dataset.mode));
});
canvas.addEventListener('pointermove', pointerPosition);
canvas.addEventListener('pointerdown', (event) => {
  if (!state.running || state.target?.kind !== 'click') return;

  pointerPosition(event);
  const hit = pointInTarget(state.pointer.x, state.pointer.y, state.target);
  state.stats = registerClick(state.stats, hit, performance.now() - state.targetStartedAt);
  if (hit) createTarget();
});
$('start-button').addEventListener('click', startRound);
$('restart-button').addEventListener('click', startRound);
$('fullscreen-button').addEventListener('click', toggleFullscreen);
window.addEventListener('resize', resize);
document.addEventListener('fullscreenchange', resize);
document.addEventListener('pointerlockchange', () => {
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
  } else if (state.running && state.rawInputRequested) {
    enableFallbackInput('指针锁定未启用，已自动切换兼容鼠标输入，可直接训练。');
  }
  updateInputMode();
});
document.addEventListener('pointerlockerror', () => {
  if (state.running && state.rawInputRequested) enableFallbackInput();
});
window.addEventListener('keydown', (event) => {
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
