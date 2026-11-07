import type { Page } from 'playwright';

export type SimulationMode = 'ada' | 'keyboard' | 'both';

const PATCH_SOURCE = String.raw`(() => {
  if (window.__canopySimulation) return;
  const state = {
    active: false,
    mode: 'both',
    style: null,
    observer: null,
    button: null,
    originals: new WeakMap(),
  };

  const ATTRS = [
    'role','aria-label','aria-labelledby','aria-describedby','aria-hidden','aria-live','aria-expanded',
    'aria-controls','aria-haspopup','aria-pressed','aria-selected','aria-current','aria-required',
    'aria-invalid','aria-checked','alt','lang','tabindex','for'
  ];
  const LANDMARKS = new Set(['main','nav','header','footer','aside','section','article','form']);
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[tabindex],[onclick]';

  function remember(el, key, value) {
    let rec = state.originals.get(el);
    if (!rec) { rec = {}; state.originals.set(el, rec); }
    if (!(key in rec)) rec[key] = value;
  }

  function stripAda(root) {
    const all = root.querySelectorAll ? [root, ...root.querySelectorAll('*')] : [root];
    for (const el of all) {
      if (!(el instanceof Element)) continue;
      for (const attr of ATTRS) {
        if (el.hasAttribute(attr)) { remember(el, 'attr:' + attr, el.getAttribute(attr)); el.removeAttribute(attr); }
      }
      if (LANDMARKS.has(el.tagName.toLowerCase())) {
        remember(el, 'landmark', el.tagName);
        // Keep layout/content; semantic meaning is removed via role/landmark attrs above.
      }
      if (el.tagName === 'IMG') { remember(el, 'attr:alt', null); el.removeAttribute('alt'); }
      if (el.tagName === 'A' && /skip/i.test(el.textContent || '')) {
        remember(el, 'style:display', el.style.display);
        el.style.display = 'none';
      }
    }
  }

  function stripKeyboard(root) {
    const els = root.querySelectorAll ? root.querySelectorAll(INTERACTIVE) : [];
    for (const el of els) {
      if (!(el instanceof Element)) continue;
      remember(el, 'attr:tabindex', el.getAttribute('tabindex'));
      el.setAttribute('tabindex', '-1');
      remember(el, 'prop:onclick', el.onclick);
      el.onclick = null;
    }
  }

  function apply(root) {
    if (state.mode === 'ada' || state.mode === 'both') stripAda(root || document);
    if (state.mode === 'keyboard' || state.mode === 'both') stripKeyboard(root || document);
  }

  function restore() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    document.removeEventListener('keydown', blockKeys, true);
    if (state.style) { state.style.remove(); state.style = null; }
    // Best-effort restore: reload is the exact fallback, but try attribute restoration.
    document.querySelectorAll('[data-canopy-sim]').forEach((el) => el.removeAttribute('data-canopy-sim'));
    if (state.button) { state.button.remove(); state.button = null; }
    state.active = false;
  }

  function blockKeys(event) {
    if (!state.active || (state.mode !== 'keyboard' && state.mode !== 'both')) return;
    const keys = ['Tab', 'Enter', ' ', 'Spacebar', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (keys.includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function enable(mode) {
    restore();
    state.active = true;
    state.mode = mode || 'both';

    state.style = document.createElement('style');
    state.style.setAttribute('data-canopy-sim-style', '');
    state.style.textContent = (state.mode === 'keyboard' || state.mode === 'both')
      ? '*:focus,*:focus-visible{outline:none !important;box-shadow:none !important;}'
      : '';
    document.documentElement.appendChild(state.style);

    apply(document);

    if (state.mode === 'keyboard' || state.mode === 'both') {
      document.addEventListener('keydown', blockKeys, true);
    }

    state.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) apply(node);
        }
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });

    if (!state.button) {
      state.button = document.createElement('button');
      state.button.type = 'button';
      state.button.textContent = 'Restore Canopy simulation';
      state.button.setAttribute('data-canopy-sim-ui', '');
      Object.assign(state.button.style, {
        position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
        padding: '10px 12px', borderRadius: '8px', border: '2px solid #fff',
        background: '#b42318', color: '#fff', font: '600 13px system-ui, sans-serif',
        cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,.25)'
      });
      state.button.addEventListener('click', () => { restore(); location.reload(); });
      document.documentElement.appendChild(state.button);
    }
  }

  window.__canopySimulation = { enable, restore, state };
})();`;

export async function installSimulation(page: Page): Promise<void> {
  await page.addInitScript({ content: PATCH_SOURCE });
  await page.evaluate((source) => {
    (0, eval)(source);
  }, PATCH_SOURCE);
}

export async function enableSimulation(page: Page, mode: SimulationMode): Promise<void> {
  await installSimulation(page);
  await page.evaluate((m) => {
    const w = window as unknown as { __canopySimulation?: { enable: (mode: string) => void } };
    w.__canopySimulation?.enable(m);
  }, mode);
}

export async function restoreSimulation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __canopySimulation?: { restore: () => void } };
    w.__canopySimulation?.restore();
  });
}
