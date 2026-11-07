import type { Impact, Issue } from './types.js';

export const IMPACT_ORDER: Record<Impact, number> = {
  minor: 1,
  moderate: 2,
  serious: 3,
  critical: 4,
};

const IMPACT_WEIGHTS: Record<Impact, number> = {
  minor: 1,
  moderate: 2,
  serious: 5,
  critical: 10,
};

export function scoreIssues(issues: Issue[]): number {
  const uniqueRules = new Map<string, Impact>();

  for (const issue of issues) {
    if (!uniqueRules.has(issue.ruleId)) {
      uniqueRules.set(issue.ruleId, issue.impact);
    }
  }

  let penalty = 0;
  for (const impact of uniqueRules.values()) {
    penalty += IMPACT_WEIGHTS[impact];
  }

  return Math.max(0, Math.min(100, 100 - penalty));
}

export function countIssues(issues: Issue[]): Record<Impact, number> {
  const counts: Record<Impact, number> = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  };

  for (const issue of issues) {
    counts[issue.impact] += 1;
  }

  return counts;
}

export function overallScore(ada: number, keyboard: number): number {
  return Math.round((ada + keyboard) / 2);
}
