import type { Page } from 'playwright';
import type { Issue, KeyboardFinding, KeyboardProbeResult, KeyboardStep } from './types.js';

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'iframe',
  '[tabindex]',
  '[contenteditable="true"]',
  '[onclick]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
].join(', ');

interface Candidate {
  id: string;
  selector: string;
  tabIndex: number;
  explicitTabIndex: string | null;
}

export function emptyKeyboardResult(maxTabs: number): KeyboardProbeResult {
  return {
    maxTabs,
    steps: [],
    findings: [],
    positiveTabindex: [],
    unreachedInteractive: [],
    focusTrap: false,
    focusLost: false,
  };
}

export async function probeKeyboard(page: Page, maxTabs: number): Promise<KeyboardProbeResult> {
  await page.evaluate((selector) => {
    const w = window as unknown as { __canopyCssPath?: (element: Element) => string };

    w.__canopyCssPath = (element: Element) => {
      if (element.id) {
        return `#${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(element.id) : element.id}`;
      }

      const parts: string[] = [];
      let node: Element | null = element;

      while (node && node.nodeType === 1 && parts.length < 4) {
        let part = node.tagName.toLowerCase();
        const parent: Element | null = node.parentElement;

        if (parent) {
          const tagName = node.tagName;
          const siblings = Array.from(parent.children).filter(
            (child: Element) => child.tagName === tagName,
          );
          if (siblings.length > 1) {
            part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          }
        }

        parts.unshift(part);
        node = parent;
      }

      return parts.join(' > ') || element.tagName.toLowerCase();
    };

    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
    elements.forEach((element, index) => {
      element.setAttribute('data-canopy-focus-id', String(index));
    });
  }, INTERACTIVE_SELECTOR);

  const candidates = (await page.evaluate((selector) => {
    const w = window as unknown as { __canopyCssPath: (element: Element) => string };

    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          !element.hasAttribute('disabled')
        );
      })
      .map((element) => ({
        id: element.getAttribute('data-canopy-focus-id') ?? '',
        selector: w.__canopyCssPath(element),
        tabIndex: element.tabIndex,
        explicitTabIndex: element.getAttribute('tabindex'),
      }));
  }, INTERACTIVE_SELECTOR)) as Candidate[];

  if (candidates.length === 0) {
    await cleanupMarkers(page);
    return emptyKeyboardResult(maxTabs);
  }

  const positiveTabindex = candidates
    .filter((candidate) => candidate.tabIndex > 0)
    .map((candidate) => candidate.selector);

  const steps: KeyboardStep[] = [];
  const seen = new Set<string>();
  let focusTrap = false;
  let focusLost = false;
  let lastFocusId: string | null = null;
  let lastFocusSelector = '';
  let repeats = 0;

  for (let index = 1; index <= maxTabs; index += 1) {
    await page.keyboard.press('Tab');

    const info = await page.evaluate(() => {
      const w = window as unknown as { __canopyCssPath: (element: Element) => string };
      const element = document.activeElement as HTMLElement | null;

      if (!element || element === document.body || element === document.documentElement) {
        return { focusLost: true as const };
      }

      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);

      return {
        focusLost: false as const,
        focusId: element.getAttribute('data-canopy-focus-id'),
        selector: w.__canopyCssPath(element),
        tag: element.tagName.toLowerCase(),
        text: (
          element.innerText ||
          element.getAttribute('aria-label') ||
          element.getAttribute('placeholder') ||
          element.getAttribute('title') ||
          ''
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 100),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
        boxShadow: style.boxShadow,
        focusVisible: element.matches(':focus-visible'),
        tabIndex: element.tabIndex,
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    });

    if (info.focusLost) {
      if (steps.length === 0) focusLost = true;
      break;
    }

    const step: KeyboardStep = {
      index,
      focusId: info.focusId,
      selector: info.selector,
      tag: info.tag,
      text: info.text,
      outlineStyle: info.outlineStyle,
      outlineWidth: info.outlineWidth,
      outlineColor: info.outlineColor,
      boxShadow: info.boxShadow,
      focusVisible: info.focusVisible,
      tabIndex: info.tabIndex,
      visible: info.visible,
      rect: info.rect,
    };

    steps.push(step);

    if (info.focusId) {
      if (info.focusId === lastFocusId) {
        repeats += 1;
        if (steps.length >= 3 && repeats >= 2) {
          focusTrap = true;
          break;
        }
      } else {
        repeats = 0;
        lastFocusId = info.focusId;
        lastFocusSelector = info.selector;
      }
      seen.add(info.focusId);
    }
  }

  await cleanupMarkers(page);

  const noIndicator = steps.filter(
    (step) =>
      step.focusVisible &&
      (step.outlineStyle === 'none' || step.outlineWidth === '0px') &&
      step.boxShadow === 'none',
  );

  const unreached = candidates.filter(
    (candidate) =>
      candidate.id !== '' && !seen.has(candidate.id) && candidate.explicitTabIndex !== '-1',
  );

  const findings: KeyboardFinding[] = [];

  if (focusLost) {
    findings.push({
      ruleId: 'keyboard/focus-lost',
      impact: 'serious',
      description: 'Keyboard focus was lost before reaching an interactive element.',
      help: 'Keep focus on a visible, interactive element as the user tabs.',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html',
      selectors: [],
    });
  }

  if (focusTrap) {
    findings.push({
      ruleId: 'keyboard/focus-trap',
      impact: 'serious',
      description: 'Keyboard focus appears trapped on a repeated element.',
      help: 'Ensure Tab and Shift+Tab can leave every component.',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html',
      selectors: lastFocusSelector ? [lastFocusSelector] : [],
    });
  }

  if (noIndicator.length > 0) {
    findings.push({
      ruleId: 'keyboard/no-focus-indicator',
      impact: 'serious',
      description: `${noIndicator.length} focused element(s) have no visible focus indicator.`,
      help: 'Provide a clearly visible focus style for every interactive element.',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html',
      selectors: noIndicator.map((step) => step.selector).slice(0, 25),
    });
  }

  if (positiveTabindex.length > 0) {
    findings.push({
      ruleId: 'keyboard/positive-tabindex',
      impact: 'moderate',
      description: 'Positive tabindex values override the natural focus order.',
      help: 'Use tabindex="0" or -1 instead of positive values.',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html',
      selectors: positiveTabindex.slice(0, 25),
    });
  }

  if (unreached.length > 0) {
    findings.push({
      ruleId: 'keyboard/unreached-interactive',
      impact: 'moderate',
      description: `${unreached.length} interactive element(s) were not reached by Tab.`,
      help: 'Make clickable controls focusable with a native control or tabindex="0".',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html',
      selectors: unreached.map((candidate) => candidate.selector).slice(0, 25),
    });
  }

  return {
    maxTabs,
    steps,
    findings,
    positiveTabindex,
    unreachedInteractive: unreached.map((candidate) => candidate.selector),
    focusTrap,
    focusLost,
  };
}

async function cleanupMarkers(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('[data-canopy-focus-id]').forEach((element) => {
      element.removeAttribute('data-canopy-focus-id');
    });
  });
}

export function keyboardFindingsToIssues(result: KeyboardProbeResult): Issue[] {
  return result.findings.map((finding) => ({
    source: 'keyboard',
    ruleId: finding.ruleId,
    impact: finding.impact,
    description: finding.description,
    help: finding.help,
    ...(finding.helpUrl ? { helpUrl: finding.helpUrl } : {}),
    tags: ['wcag22aa', 'keyboard'],
    nodes: finding.selectors.map((selector) => ({ target: [selector], html: '' })),
  }));
}
