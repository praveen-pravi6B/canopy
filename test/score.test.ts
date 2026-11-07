import { describe, expect, it } from 'vitest';
import { countIssues, IMPACT_ORDER, overallScore, scoreIssues } from '../src/core/score.js';
import type { Impact, Issue } from '../src/core/types.js';

function issue(ruleId: string, impact: Impact): Issue {
  return {
    source: 'axe',
    ruleId,
    impact,
    description: ruleId,
    help: ruleId,
    tags: [],
    nodes: [],
  };
}

describe('scoreIssues', () => {
  it('returns 100 for no issues', () => {
    expect(scoreIssues([])).toBe(100);
  });

  it('subtracts weighted penalties', () => {
    expect(scoreIssues([issue('a', 'minor')])).toBe(99);
    expect(scoreIssues([issue('a', 'moderate')])).toBe(98);
    expect(scoreIssues([issue('a', 'serious')])).toBe(95);
    expect(scoreIssues([issue('a', 'critical')])).toBe(90);
  });

  it('counts a rule only once regardless of node count', () => {
    const manyNodes: Issue = {
      ...issue('image-alt', 'critical'),
      nodes: [{ target: ['img'], html: '<img>' }, { target: ['img'], html: '<img>' }],
    };
    expect(scoreIssues([manyNodes, issue('image-alt', 'critical')])).toBe(90);
  });

  it('sums distinct rules', () => {
    expect(scoreIssues([issue('a', 'serious'), issue('b', 'serious')])).toBe(90);
  });

  it('clamps at zero', () => {
    const issues = Array.from({ length: 20 }, (_, index) => issue(`rule-${index}`, 'critical'));
    expect(scoreIssues(issues)).toBe(0);
  });
});

describe('countIssues', () => {
  it('counts each impact', () => {
    expect(
      countIssues([
        issue('a', 'critical'),
        issue('b', 'serious'),
        issue('c', 'serious'),
        issue('d', 'minor'),
      ]),
    ).toEqual({ critical: 1, serious: 2, moderate: 0, minor: 1 });
  });
});

describe('overallScore', () => {
  it('averages and rounds', () => {
    expect(overallScore(100, 100)).toBe(100);
    expect(overallScore(90, 95)).toBe(93);
    expect(overallScore(0, 100)).toBe(50);
  });
});

describe('IMPACT_ORDER', () => {
  it('orders impacts from least to most severe', () => {
    expect(IMPACT_ORDER.minor).toBeLessThan(IMPACT_ORDER.moderate);
    expect(IMPACT_ORDER.moderate).toBeLessThan(IMPACT_ORDER.serious);
    expect(IMPACT_ORDER.serious).toBeLessThan(IMPACT_ORDER.critical);
  });
});
