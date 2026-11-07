import { describe, expect, it } from 'vitest';
import { axeTagsForConfig } from '../src/core/axe.js';
import { CanopyConfigSchema } from '../src/core/config.js';

describe('axeTagsForConfig', () => {
  it('maps the ada profile to WCAG 2.2 A/AA and Section 508 tags', () => {
    const config = CanopyConfigSchema.parse({
      audit: { profile: 'ada', includeBestPractices: false },
    });
    expect(axeTagsForConfig(config)).toEqual([
      'wcag2a',
      'wcag2aa',
      'wcag21a',
      'wcag21aa',
      'wcag22aa',
      'section508',
    ]);
  });

  it('maps the wcag22aa profile without Section 508 when requested', () => {
    const config = CanopyConfigSchema.parse({
      audit: { profile: 'wcag22aa', includeBestPractices: false },
    });
    expect(axeTagsForConfig(config)).toEqual([
      'wcag2a',
      'wcag2aa',
      'wcag21a',
      'wcag21aa',
      'wcag22aa',
    ]);
  });

  it('adds best-practice rules when enabled', () => {
    const config = CanopyConfigSchema.parse({
      audit: { profile: 'wcag22aa', includeBestPractices: true },
    });
    expect(axeTagsForConfig(config)).toContain('best-practice');
  });

  it('supports a best-practice-only profile', () => {
    const config = CanopyConfigSchema.parse({
      audit: { profile: 'best-practice', includeBestPractices: false },
    });
    expect(axeTagsForConfig(config)).toEqual(['best-practice']);
  });
});
