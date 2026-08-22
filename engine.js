export const calculateEDpi = (dpi, sensitivity) => {
  const safeDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : 800;
  const safeSensitivity = Number.isFinite(sensitivity) && sensitivity > 0 ? sensitivity : 0.175;
  return Math.round(safeDpi * safeSensitivity * 100) / 100;
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
