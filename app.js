import {
  calculateEDpi,
  calculateValorantInputScale,
  chooseTargetKind,
  createRoundStats,
  registerClick,
  registerTracking,
  summarizeRound
} from './engine.js';

const $ = (id) => document.getElementById(id);
const canvas = $('arena');
const context = canvas.getContext('2d');
const arenaWrap = $('arena-wrap');
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
  scale: 1,
  inputScale: 1,
  pointerClient: null,
  width: 0,
  height: 0,
  bestScores: createBestScores(saved)
};

$('dpi-input').value = saved.dpi || 800;
$('sensitivity-input').value = saved.sensitivity || 0.175;
$('scale-input').value = saved.scale || 100;

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
      dpi: +$('dpi-input').value,
      sensitivity: +$('sensitivity-input').value,
      scale: +$('scale-input').value,
      mode: state.mode,
      best: state.bestScores.mixed,
      bestScores: state.bestScores,
      recent: [result, ...recent].slice(0, 10)
    }));
  } catch {
    // Persistence is optional; a blocked browser storage API must not stop training.
  }
}

function updateSensitivity() {
  const dpi = Number($('dpi-input').value);
  const sensitivity = Number($('sensitivity-input').value);
  $('edpi-value').textContent = calculateEDpi(dpi, sensitivity);
  $('effective-sensitivity').textContent = `${calculateValorantInputScale(dpi, sensitivity).toFixed(2)}x`;
}

function setSensitivityControlsDisabled(disabled) {
  ['dpi-input', 'sensitivity-input', 'scale-input'].forEach((id) => {
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
  state.inputScale = calculateValorantInputScale(
    Number($('dpi-input').value),
    Number($('sensitivity-input').value)
  ) * state.scale;
  state.running = true;
  state.stats = createRoundStats();
  state.history = [];
  state.target = null;
  state.pointer = { x: state.width / 2, y: state.height / 2 };
  state.pointerClient = null;
  state.roundEndsAt = performance.now() + ROUND_DURATION_MS;
  state.lastFrame = performance.now();
  $('ready-overlay').hidden = true;
  $('result-overlay').hidden = true;
  $('start-button').disabled = true;
  $('start-button').textContent = '训练中...';
  setModeControlsDisabled(true);
  setSensitivityControlsDisabled(true);
  canvas.requestPointerLock?.();
  createTarget();
  requestAnimationFrame(frame);
}

function finishRound() {
  if (!state.running) return;

  state.running = false;
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
  if (!document.fullscreenElement) arenaWrap.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
}

function pointerPosition(event) {
  if (document.pointerLockElement === canvas) {
    state.pointer.x = Math.max(0, Math.min(state.width, state.pointer.x + event.movementX * state.inputScale));
    state.pointer.y = Math.max(0, Math.min(state.height, state.pointer.y + event.movementY * state.inputScale));
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const nextClient = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (!state.running || !state.pointerClient) {
    state.pointerClient = nextClient;
    if (!state.running) state.pointer = nextClient;
    return;
  }

  const deltaX = (nextClient.x - state.pointerClient.x) * state.inputScale;
  const deltaY = (nextClient.y - state.pointerClient.y) * state.inputScale;
  state.pointerClient = nextClient;
  state.pointer.x = Math.max(0, Math.min(state.width, state.pointer.x + deltaX));
  state.pointer.y = Math.max(0, Math.min(state.height, state.pointer.y + deltaY));
}

['dpi-input', 'sensitivity-input'].forEach((id) => $(id).addEventListener('input', updateSensitivity));
$('scale-input').addEventListener('input', (event) => {
  state.scale = Number(event.target.value) / 100;
  $('scale-value').textContent = `${event.target.value}%`;
  updateSensitivity();
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
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'f') {
    event.preventDefault();
    toggleFullscreen();
  }
});

state.scale = Number($('scale-input').value) / 100;
setSensitivityControlsDisabled(false);
updateSensitivity();
resize();
renderModeSelection();
