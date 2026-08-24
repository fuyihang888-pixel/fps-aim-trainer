export const DEFAULT_DPI = 1000;
export const DEFAULT_SENSITIVITY = 1;
export const VALORANT_YAW_DEGREES_PER_COUNT = 0.07;
export const VALORANT_HORIZONTAL_FOV_DEGREES = 103;
export const RESUME_COUNTDOWN_MS = 3000;

export const resolveValorantSettings = (dpi, sensitivity) => ({
  dpi: Number.isFinite(dpi) && dpi > 0 ? dpi : DEFAULT_DPI,
  sensitivity: Number.isFinite(sensitivity) && sensitivity > 0 ? sensitivity : DEFAULT_SENSITIVITY
});

export const calculateEDpi = (dpi, sensitivity) => {
  const resolved = resolveValorantSettings(dpi, sensitivity);
  return resolved.dpi * resolved.sensitivity;
};

// Valorant applies 0.07 degrees of yaw for each unadjusted mouse count.
// DPI changes how many counts a physical mouse movement produces, but it must
// not be multiplied into a Pointer Lock delta a second time.
export const calculateValorantCountsPer360 = (sensitivity) => {
  const resolved = resolveValorantSettings(DEFAULT_DPI, sensitivity);
  return 360 / (resolved.sensitivity * VALORANT_YAW_DEGREES_PER_COUNT);
};

export const calculateValorantCm360 = (dpi, sensitivity) => {
  const resolved = resolveValorantSettings(dpi, sensitivity);
  return (calculateValorantCountsPer360(resolved.sensitivity) / resolved.dpi) * 2.54;
};

// The browser canvas is calibrated to the default 1000 DPI x 1.0 preset.
// The ratio is the same DPI * in-game sensitivity ratio used by Valorant.
export const calculateValorantInputScale = (dpi, sensitivity) => {
  const resolved = resolveValorantSettings(dpi, sensitivity);
  const referenceEDpi = DEFAULT_DPI * DEFAULT_SENSITIVITY;
  return (resolved.dpi * resolved.sensitivity) / referenceEDpi;
};

// Standard pointer events already include the user's hardware DPI and Windows
// pointer processing. Apply only the in-game sensitivity here so DPI is not
// counted twice. This remains an approximation because the OS may accelerate it.
export const calculateValorantFallbackInputScale = (sensitivity) => {
  const resolved = resolveValorantSettings(DEFAULT_DPI, sensitivity);
  return resolved.sensitivity / DEFAULT_SENSITIVITY;
};

// Pointer Lock movementX/movementY are hardware counts when
// `unadjustedMovement` is enabled. Project each count through the same
// counts-per-360 relationship as Valorant and the arena's horizontal FOV.
// The DPI is intentionally absent: the browser's raw count already reflects
// the selected mouse DPI, so adding it here would apply DPI twice.
export const calculateValorantRawInputScale = (
  sensitivity,
  viewportWidth,
  fovDegrees = VALORANT_HORIZONTAL_FOV_DEGREES
) => {
  const resolved = resolveValorantSettings(DEFAULT_DPI, sensitivity);
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1;
  const fov = Number.isFinite(fovDegrees) && fovDegrees > 0
    ? fovDegrees
    : VALORANT_HORIZONTAL_FOV_DEGREES;
  const countsPer360 = calculateValorantCountsPer360(resolved.sensitivity);
  return (width * 360) / (countsPer360 * fov);
};

export const shiftTrainingTimelineAfterPause = (timeline, pausedAt, resumedAt) => {
  const pauseDuration = Math.max(0, resumedAt - pausedAt);
  return {
    roundEndsAt: timeline.roundEndsAt + pauseDuration,
    targetStartedAt: timeline.targetStartedAt + pauseDuration,
    targetEndsAt: timeline.targetEndsAt + pauseDuration,
    lastFrame: resumedAt
  };
};

export const getResumeCountdownSeconds = (
  startedAt,
  now,
  durationMs = RESUME_COUNTDOWN_MS
) => {
  const elapsed = Math.max(0, now - startedAt);
  return Math.max(0, Math.ceil((durationMs - elapsed) / 1000));
};

export const clampTargetToArena = (target, width, height, padding = 18) => {
  if (!target) return target;

  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  const radius = Number.isFinite(target.radius) && target.radius > 0 ? target.radius : 0;
  const inset = radius + Math.max(0, padding);
  const clampCoordinate = (value, size) => {
    const minimum = Math.min(size / 2, inset);
    const maximum = Math.max(minimum, size - inset);
    const coordinate = Number.isFinite(value) ? value : size / 2;
    return Math.max(minimum, Math.min(maximum, coordinate));
  };

  return {
    ...target,
    x: clampCoordinate(target.x, safeWidth),
    y: clampCoordinate(target.y, safeHeight)
  };
};

export const resolveEscapeAction = (trainingState, now) => {
  if (!trainingState.running) return 'ignore';
  if (!trainingState.paused) return trainingState.fullscreenActive ? 'pause' : 'cancel';
  if (trainingState.fullscreenActive) return 'ignore';
  if (now <= trainingState.suppressWindowedEscapeUntil) return 'suppress';
  return 'cancel';
};

export const resolvePointerUnlockAction = (trainingState) => {
  if (!trainingState.running) return 'ignore';
  if (trainingState.paused) {
    return trainingState.pauseMode === 'countdown' && !trainingState.fullscreenActive
      ? 'cancel'
      : 'fallback';
  }
  return trainingState.fullscreenActive ? 'pause' : 'cancel';
};

export const createRoundStats = () => ({
  clickHits: 0,
  clickShots: 0,
  reactionTotal: 0,
  combo: 0,
  bestCombo: 0,
  trackCoveredMs: 0,
  trackVisibleMs: 0,
  score: 0,
  clickScore: 0,
  trackingScore: 0,
  trackingRemainderMs: 0
});

export const chooseTargetKind = (mode, history, random = Math.random) => {
  if (Array.isArray(mode)) {
    random = typeof history === 'function' ? history : random;
    history = mode;
    mode = 'mixed';
  }

  if (mode === 'static') return 'click';
  if (mode === 'tracking') return 'track';

  const lastTwo = history.slice(-2);
  if (lastTwo.length === 2 && lastTwo[0] === lastTwo[1]) return lastTwo[0] === 'click' ? 'track' : 'click';
  return random() < 0.56 ? 'click' : 'track';
};

export const registerClick = (stats, hit, reactionMs) => {
  const clickShots = stats.clickShots + 1;
  if (!hit) return { ...stats, clickShots, combo: 0 };
  const combo = stats.combo + 1;
  return {
    ...stats,
    clickHits: stats.clickHits + 1,
    clickShots,
    reactionTotal: stats.reactionTotal + Math.max(0, reactionMs),
    combo,
    bestCombo: Math.max(stats.bestCombo, combo),
    score: stats.score + 100,
    clickScore: stats.clickScore + 100
  };
};

export const registerTracking = (stats, coveredMs, visibleMs) => {
  const safeCoveredMs = Math.max(0, coveredMs);
  const accumulatedMs = stats.trackingRemainderMs + safeCoveredMs;
  const earned = Math.floor(accumulatedMs / 20);

  return {
    ...stats,
    trackCoveredMs: stats.trackCoveredMs + safeCoveredMs,
    trackVisibleMs: stats.trackVisibleMs + Math.max(0, visibleMs),
    score: stats.score + earned,
    trackingScore: stats.trackingScore + earned,
    trackingRemainderMs: accumulatedMs % 20
  };
};

export const summarizeRound = (stats) => ({
  totalScore: stats.score,
  clickScore: stats.clickScore,
  trackingScore: stats.trackingScore,
  clickAccuracy: stats.clickShots ? Math.round((stats.clickHits / stats.clickShots) * 100) : 0,
  averageReaction: stats.clickHits ? Math.round(stats.reactionTotal / stats.clickHits) : 0,
  trackCoverage: stats.trackVisibleMs ? Math.round((stats.trackCoveredMs / stats.trackVisibleMs) * 100) : 0,
  trackCoveredMs: stats.trackCoveredMs,
  bestCombo: stats.bestCombo
});
