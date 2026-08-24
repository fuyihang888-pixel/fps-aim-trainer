export const DEFAULT_SENSITIVITY = 1;
export const VALORANT_YAW_DEGREES_PER_COUNT = 0.07;
export const VALORANT_HORIZONTAL_FOV_DEGREES = 103;
export const VALORANT_MAX_PITCH_DEGREES = 89;
export const RESUME_COUNTDOWN_MS = 3000;

const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

export const resolveValorantSensitivity = (sensitivity) => (
  Number.isFinite(sensitivity) && sensitivity > 0
    ? sensitivity
    : DEFAULT_SENSITIVITY
);

// Valorant applies 0.07 degrees of yaw for each unadjusted mouse count.
// Hardware DPI determines how many counts the user's mouse produces and is
// already represented by Pointer Lock movement, so the page only applies the
// in-game sensitivity.
export const calculateValorantDegreesPerCount = (sensitivity) => (
  resolveValorantSensitivity(sensitivity) * VALORANT_YAW_DEGREES_PER_COUNT
);

export const calculateValorantCountsPer360 = (sensitivity) => (
  360 / calculateValorantDegreesPerCount(sensitivity)
);

// Kept for compatibility with older integrations. The active camera path
// below applies degrees directly and does not use pixel scaling.
export const calculateValorantFallbackInputScale = (sensitivity) => (
  resolveValorantSensitivity(sensitivity) / DEFAULT_SENSITIVITY
);

export const calculateValorantRawInputScale = (
  sensitivity,
  viewportWidth,
  fovDegrees = VALORANT_HORIZONTAL_FOV_DEGREES
) => {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1;
  const fov = Number.isFinite(fovDegrees) && fovDegrees > 0 ? fovDegrees : VALORANT_HORIZONTAL_FOV_DEGREES;
  return (width * calculateValorantDegreesPerCount(sensitivity)) / fov;
};

const normalizeYawDegrees = (degrees) => {
  const normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
};

export const shortestYawDeltaDegrees = (targetYawDeg, viewYawDeg) => (
  normalizeYawDegrees(
    (Number.isFinite(targetYawDeg) ? targetYawDeg : 0)
      - (Number.isFinite(viewYawDeg) ? viewYawDeg : 0)
  )
);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const resolveFovDegrees = (fovDegrees) => (
  Number.isFinite(fovDegrees) && fovDegrees > 0 && fovDegrees < 180
    ? fovDegrees
    : VALORANT_HORIZONTAL_FOV_DEGREES
);

export const applyValorantMouseCounts = (
  view,
  movementX,
  movementY,
  sensitivity
) => {
  const degreesPerCount = calculateValorantDegreesPerCount(sensitivity);
  const yaw = Number.isFinite(view?.yawDeg) ? view.yawDeg : 0;
  const pitch = Number.isFinite(view?.pitchDeg) ? view.pitchDeg : 0;
  const horizontalCounts = Number.isFinite(movementX) ? movementX : 0;
  const verticalCounts = Number.isFinite(movementY) ? movementY : 0;
  return {
    yawDeg: normalizeYawDegrees(yaw + horizontalCounts * degreesPerCount),
    pitchDeg: clamp(
      // Inverted Y axis: positive browser movement (mouse down) increases
      // pitch, while negative movement (mouse up) decreases it.
      pitch + verticalCounts * degreesPerCount,
      -VALORANT_MAX_PITCH_DEGREES,
      VALORANT_MAX_PITCH_DEGREES
    )
  };
};

export const calculateValorantProjection = (
  viewportWidth,
  viewportHeight,
  fovDegrees = VALORANT_HORIZONTAL_FOV_DEGREES
) => {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1;
  const horizontalFovDegrees = resolveFovDegrees(fovDegrees);
  const horizontalFovRadians = horizontalFovDegrees * DEGREES_TO_RADIANS;
  const focalLengthPx = width / (2 * Math.tan(horizontalFovRadians / 2));
  const verticalFovRadians = 2 * Math.atan((height / width) * Math.tan(horizontalFovRadians / 2));
  return {
    width,
    height,
    horizontalFovDegrees,
    verticalFovDegrees: verticalFovRadians * RADIANS_TO_DEGREES,
    focalLengthPx
  };
};

const directionFromAngles = (yawDeg, pitchDeg) => {
  const yaw = (Number.isFinite(yawDeg) ? yawDeg : 0) * DEGREES_TO_RADIANS;
  const pitch = clamp(
    Number.isFinite(pitchDeg) ? pitchDeg : 0,
    -VALORANT_MAX_PITCH_DEGREES,
    VALORANT_MAX_PITCH_DEGREES
  ) * DEGREES_TO_RADIANS;
  const cosPitch = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: Math.cos(yaw) * cosPitch
  };
};

const cameraBasis = (view) => {
  const yaw = (Number.isFinite(view?.yawDeg) ? view.yawDeg : 0) * DEGREES_TO_RADIANS;
  const pitch = clamp(
    Number.isFinite(view?.pitchDeg) ? view.pitchDeg : 0,
    -VALORANT_MAX_PITCH_DEGREES,
    VALORANT_MAX_PITCH_DEGREES
  ) * DEGREES_TO_RADIANS;
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const sinPitch = Math.sin(pitch);
  const cosPitch = Math.cos(pitch);
  return {
    right: { x: cosYaw, y: 0, z: -sinYaw },
    down: { x: -sinYaw * sinPitch, y: cosPitch, z: -cosYaw * sinPitch },
    forward: { x: sinYaw * cosPitch, y: sinPitch, z: cosYaw * cosPitch }
  };
};

const dot = (left, right) => left.x * right.x + left.y * right.y + left.z * right.z;

export const projectValorantAngles = (
  targetYawDeg,
  targetPitchDeg,
  view,
  viewportWidth,
  viewportHeight,
  fovDegrees = VALORANT_HORIZONTAL_FOV_DEGREES
) => {
  const projection = calculateValorantProjection(viewportWidth, viewportHeight, fovDegrees);
  const basis = cameraBasis(view);
  const direction = directionFromAngles(targetYawDeg, targetPitchDeg);
  const cameraX = dot(direction, basis.right);
  const cameraY = dot(direction, basis.down);
  const cameraZ = dot(direction, basis.forward);
  const visible = Number.isFinite(cameraZ) && cameraZ > 1e-6;
  const x = visible
    ? projection.width / 2 + projection.focalLengthPx * cameraX / cameraZ
    : projection.width / 2;
  const y = visible
    ? projection.height / 2 + projection.focalLengthPx * cameraY / cameraZ
    : projection.height / 2;
  return {
    x: Number.isFinite(x) ? x : projection.width / 2,
    y: Number.isFinite(y) ? y : projection.height / 2,
    visible,
    inside: visible && x >= 0 && x <= projection.width && y >= 0 && y <= projection.height
  };
};

export const screenPointToValorantAngles = (
  screenX,
  screenY,
  view,
  viewportWidth,
  viewportHeight,
  fovDegrees = VALORANT_HORIZONTAL_FOV_DEGREES
) => {
  const projection = calculateValorantProjection(viewportWidth, viewportHeight, fovDegrees);
  const basis = cameraBasis(view);
  const x = clamp(Number.isFinite(screenX) ? screenX : projection.width / 2, 0, projection.width);
  const y = clamp(Number.isFinite(screenY) ? screenY : projection.height / 2, 0, projection.height);
  const cameraX = (x - projection.width / 2) / projection.focalLengthPx;
  const cameraY = (y - projection.height / 2) / projection.focalLengthPx;
  const world = {
    x: basis.right.x * cameraX + basis.down.x * cameraY + basis.forward.x,
    y: basis.right.y * cameraX + basis.down.y * cameraY + basis.forward.y,
    z: basis.right.z * cameraX + basis.down.z * cameraY + basis.forward.z
  };
  const length = Math.hypot(world.x, world.y, world.z) || 1;
  const normalized = { x: world.x / length, y: world.y / length, z: world.z / length };
  return {
    yawDeg: normalizeYawDegrees(Math.atan2(normalized.x, normalized.z) * RADIANS_TO_DEGREES),
    pitchDeg: Math.asin(clamp(normalized.y, -1, 1)) * RADIANS_TO_DEGREES
  };
};

export const moveTargetByScreenVelocity = (
  target,
  view,
  viewportWidth,
  viewportHeight,
  elapsedMs,
  padding = 18,
  fovDegrees = VALORANT_HORIZONTAL_FOV_DEGREES
) => {
  if (!target) return target;

  const projection = calculateValorantProjection(viewportWidth, viewportHeight, fovDegrees);
  const radius = Number.isFinite(target.radius) && target.radius > 0 ? target.radius : 0;
  const inset = radius + Math.max(0, padding);
  const minX = Math.min(projection.width / 2, inset);
  const maxX = Math.max(minX, projection.width - inset);
  const minY = Math.min(projection.height / 2, inset);
  const maxY = Math.max(minY, projection.height - inset);
  const point = projectValorantAngles(
    target.yawDeg,
    target.pitchDeg,
    view,
    projection.width,
    projection.height,
    fovDegrees
  );
  const seconds = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000;
  let nextX = clamp(point.x, minX, maxX)
    + (Number.isFinite(target.vx) ? target.vx : 0) * seconds;
  let nextY = clamp(point.y, minY, maxY)
    + (Number.isFinite(target.vy) ? target.vy : 0) * seconds;
  let nextVx = Number.isFinite(target.vx) ? target.vx : 0;
  let nextVy = Number.isFinite(target.vy) ? target.vy : 0;

  if (nextX < minX || nextX > maxX) {
    nextX = clamp(nextX, minX, maxX);
    nextVx *= -1;
  }
  if (nextY < minY || nextY > maxY) {
    nextY = clamp(nextY, minY, maxY);
    nextVy *= -1;
  }

  return {
    ...target,
    ...screenPointToValorantAngles(
      nextX,
      nextY,
      view,
      projection.width,
      projection.height,
      fovDegrees
    ),
    vx: nextVx,
    vy: nextVy
  };
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
