/**
 * Local progress tracking.
 *
 * GitHub Pages has no backend, so progress lives in localStorage and never
 * leaves the device. The shape is intentionally close to what a server-backed
 * build would need, so adding real Glicko-2 ratings later is additive rather
 * than a migration.
 */

import type { Grade } from './grade';

const STORAGE_KEY = 'mahjong-puzzles:progress:v1';

export interface AttemptRecord {
  puzzleId: string;
  actionId: string;
  grade: Grade;
  score: number;
  loss: number;
  policy?: number;
  at: number;
}

export interface Progress {
  attempts: AttemptRecord[];
  currentStreak: number;
  bestStreak: number;
}

const EMPTY: Progress = { attempts: [], currentStreak: 0, bestStreak: 0 };

export function loadProgress(): Progress {
  if (typeof localStorage === 'undefined') return EMPTY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Progress>;
    return {
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
      currentStreak: parsed.currentStreak ?? 0,
      bestStreak: parsed.bestStreak ?? 0,
    };
  } catch {
    // Corrupt or unreadable storage should never break the app.
    return EMPTY;
  }
}

export function saveProgress(progress: Progress): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Quota exhausted or storage disabled; progress is a convenience, not a
    // requirement, so failing to persist is survivable.
  }
}

export function recordAttempt(progress: Progress, attempt: AttemptRecord, correct: boolean): Progress {
  const currentStreak = correct ? progress.currentStreak + 1 : 0;
  return {
    // Cap history so storage cannot grow without bound.
    attempts: [...progress.attempts, attempt].slice(-2000),
    currentStreak,
    bestStreak: Math.max(progress.bestStreak, currentStreak),
  };
}

export function clearProgress(): Progress {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }
  return EMPTY;
}

export interface ProgressSummary {
  solved: number;
  attempted: number;
  accuracy: number;
  averageScore: number;
  currentStreak: number;
  bestStreak: number;
  gradeCounts: Record<Grade, number>;
}

export function summarize(progress: Progress): ProgressSummary {
  const gradeCounts: Record<Grade, number> = {
    optimal: 0,
    good: 0,
    inaccuracy: 0,
    mistake: 0,
    blunder: 0,
  };
  for (const attempt of progress.attempts) gradeCounts[attempt.grade] += 1;

  const attempted = progress.attempts.length;
  const solved = gradeCounts.optimal;
  const totalScore = progress.attempts.reduce((sum, attempt) => sum + attempt.score, 0);

  return {
    solved,
    attempted,
    accuracy: attempted === 0 ? 0 : solved / attempted,
    averageScore: attempted === 0 ? 0 : totalScore / attempted,
    currentStreak: progress.currentStreak,
    bestStreak: progress.bestStreak,
    gradeCounts,
  };
}

/** Puzzle ids already attempted, so the session can prefer fresh material. */
export function attemptedIds(progress: Progress): Set<string> {
  return new Set(progress.attempts.map((attempt) => attempt.puzzleId));
}
