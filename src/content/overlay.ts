import { formatClockHMS } from '../shared/format-duration';
import { urlToRegistrableDomain } from '../shared/domain-from-url';
import styles from './overlay.css?inline';

const TOTALS_STORAGE_KEY = 'totalsByDay';
const OVERLAY_POS_KEY = 'fytOverlayPosition';
const LOCKED_DOMAINS_KEY = 'fytLockedDomains';

const VIEW_MARGIN = 12;

type PresetId = 'tl' | 'tr' | 'bl' | 'br' | 'center';

type OverlayPlacement =
  | { mode: 'preset'; preset: PresetId }
  | { mode: 'custom'; left: number; top: number };

type DisplayPayload = {
  storedSeconds: number;
  openSessionStartMs: number | null;
  isLocked: boolean;
};

type SavedPosition = { left: number; top: number };

const DEFAULT_PLACEMENT: OverlayPlacement = { mode: 'preset', preset: 'bl' };

let lastPayload: DisplayPayload | null = null;

function isExtensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function isContextInvalidatedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('Extension context invalidated');
}

function readSize(el: HTMLElement): { w: number; h: number } {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  return { w: w || 1, h: h || 1 };
}

function bottomLeftPx(el: HTMLElement): SavedPosition {
  const { w, h } = readSize(el);
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const top = Math.max(VIEW_MARGIN, vh - h - VIEW_MARGIN);
  const left = VIEW_MARGIN;
  if (w + 2 * VIEW_MARGIN > vw) {
    return { left: VIEW_MARGIN, top };
  }
  return { left, top };
}

function clampToViewport(left: number, top: number, el: HTMLElement): SavedPosition {
  const { w, h } = readSize(el);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (w + 2 * VIEW_MARGIN > vw || h + 2 * VIEW_MARGIN > vh) {
    return bottomLeftPx(el);
  }
  const l = Math.min(
    Math.max(VIEW_MARGIN, left),
    vw - w - VIEW_MARGIN
  );
  const t = Math.min(
    Math.max(VIEW_MARGIN, top),
    vh - h - VIEW_MARGIN
  );
  return { left: Math.round(l), top: Math.round(t) };
}

function computePresetPosition(preset: PresetId, el: HTMLElement): SavedPosition {
  const m = VIEW_MARGIN;
  const { w, h } = readSize(el);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = m;
  let top = m;
  switch (preset) {
    case 'tl':
      left = m;
      top = m;
      break;
    case 'tr':
      left = vw - w - m;
      top = m;
      break;
    case 'bl':
      left = m;
      top = vh - h - m;
      break;
    case 'br':
      left = vw - w - m;
      top = vh - h - m;
      break;
    case 'center':
      left = (vw - w) / 2;
      top = (vh - h) / 2;
      break;
    default:
      break;
  }
  return clampToViewport(left, top, el);
}

function resolveCustomForViewport(saved: SavedPosition, el: HTMLElement): SavedPosition {
  const { w, h } = readSize(el);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (w + 2 * VIEW_MARGIN > vw || h + 2 * VIEW_MARGIN > vh) {
    return bottomLeftPx(el);
  }
  const inside =
    saved.left >= VIEW_MARGIN &&
    saved.top >= VIEW_MARGIN &&
    saved.left + w <= vw - VIEW_MARGIN &&
    saved.top + h <= vh - VIEW_MARGIN;
  if (inside) {
    return { left: saved.left, top: saved.top };
  }
  return bottomLeftPx(el);
}

function applyPosition(el: HTMLElement, pos: SavedPosition): void {
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
}

function applyWrapMode(wrap: HTMLElement, placement: OverlayPlacement): void {
  wrap.classList.toggle('custom-mode', placement.mode === 'custom');
  wrap.classList.toggle('preset-mode', placement.mode === 'preset');
}

async function loadPlacement(): Promise<OverlayPlacement> {
  const r = await chrome.storage.local.get(OVERLAY_POS_KEY);
  const p = r[OVERLAY_POS_KEY] as Record<string, unknown> | undefined;
  if (!p) {
    return DEFAULT_PLACEMENT;
  }
  if (p.mode === 'preset' && typeof p.preset === 'string') {
    const id = p.preset as PresetId;
    if (['tl', 'tr', 'bl', 'br', 'center'].includes(id)) {
      return { mode: 'preset', preset: id };
    }
  }
  if (
    p.mode === 'custom' &&
    typeof p.left === 'number' &&
    typeof p.top === 'number' &&
    Number.isFinite(p.left) &&
    Number.isFinite(p.top)
  ) {
    return { mode: 'custom', left: p.left, top: p.top };
  }
  if (
    typeof p.left === 'number' &&
    typeof p.top === 'number' &&
    Number.isFinite(p.left) &&
    Number.isFinite(p.top)
  ) {
    return { mode: 'custom', left: p.left, top: p.top };
  }
  return DEFAULT_PLACEMENT;
}

async function persistPlacement(placement: OverlayPlacement): Promise<void> {
  await chrome.storage.local.set({ [OVERLAY_POS_KEY]: placement });
}

function placementToPosition(
  placement: OverlayPlacement,
  panel: HTMLElement
): SavedPosition {
  if (placement.mode === 'preset') {
    return computePresetPosition(placement.preset, panel);
  }
  return resolveCustomForViewport(
    { left: placement.left, top: placement.top },
    panel
  );
}

function updateMenuSelection(
  menu: HTMLElement,
  placement: OverlayPlacement
): void {
  const cells = menu.querySelectorAll<HTMLButtonElement>('.pos-cell');
  cells.forEach((btn) => {
    const id = btn.dataset.preset as string | undefined;
    if (!id) return;
    const sel =
      (placement.mode === 'preset' && placement.preset === id) ||
      (placement.mode === 'custom' && id === 'custom');
    btn.classList.toggle('selected', Boolean(sel));
  });
}

function mountShadow(): {
  timeEl: HTMLElement;
  wrap: HTMLElement;
  panel: HTMLElement;
  menu: HTMLElement;
  toggle: HTMLButtonElement;
  lockToggle: HTMLButtonElement;
  shadowHost: HTMLElement;
} {
  const shadowHost = document.createElement('div');
  shadowHost.id = 'fyt-domain-time-overlay';
  document.documentElement.appendChild(shadowHost);
  const shadowRoot = shadowHost.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = styles;
  shadowRoot.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'panel';

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pos-toggle';
  toggle.setAttribute('aria-label', 'Vị trí');
  toggle.setAttribute('title', 'Vị trí');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-haspopup', 'true');
  toggle.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<circle cx="12" cy="6" r="2"/>' +
    '<circle cx="12" cy="12" r="2"/>' +
    '<circle cx="12" cy="18" r="2"/>' +
    '</svg>';

  const lockToggle = document.createElement('button');
  lockToggle.type = 'button';
  lockToggle.className = 'lock-toggle';
  lockToggle.setAttribute('aria-label', 'Khóa website');
  lockToggle.setAttribute('title', 'Khóa website');
  lockToggle.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M17 8h-1V6a4 4 0 10-8 0v2H7a2 2 0 00-2 2v8a2 2 0 002 2h10a2 2 0 002-2v-8a2 2 0 00-2-2zm-7-2a2 2 0 114 0v2h-4V6z"/>' +
    '</svg>';

  const menu = document.createElement('div');
  menu.className = 'pos-menu';
  menu.setAttribute('role', 'menu');

  const hint = document.createElement('p');
  hint.className = 'pos-menu-hint';
  hint.textContent = 'Vị trí hiển thị.';

  const frame = document.createElement('div');
  frame.className = 'pos-screen-frame';

  const grid = document.createElement('div');
  grid.className = 'pos-grid';

  const cells: { preset: PresetId | 'custom'; label: string; wide?: boolean }[] =
    [
      { preset: 'tl', label: 'Góc\ntrên trái' },
      { preset: 'tr', label: 'Góc\ntrên phải' },
      { preset: 'center', label: 'Giữa màn hình', wide: true },
      { preset: 'bl', label: 'Góc\ndưới trái' },
      { preset: 'br', label: 'Góc\ndưới phải' },
    ];

  for (const c of cells) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pos-cell' + (c.wide ? ' pos-cell-wide' : '');
    btn.dataset.preset = c.preset;
    const span = document.createElement('span');
    span.textContent = c.label;
    btn.appendChild(span);
    grid.appendChild(btn);
  }

  const customBtn = document.createElement('button');
  customBtn.type = 'button';
  customBtn.className = 'pos-cell pos-cell-custom';
  customBtn.dataset.preset = 'custom';
  const customSpan = document.createElement('span');
  customSpan.textContent = 'Tùy chỉnh — kéo thả ô đồng hồ';
  customBtn.appendChild(customSpan);

  frame.appendChild(grid);
  frame.appendChild(customBtn);
  menu.appendChild(hint);
  menu.appendChild(frame);

  toolbar.appendChild(lockToggle);
  toolbar.appendChild(toggle);
  toolbar.appendChild(menu);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  const timeEl = document.createElement('div');
  timeEl.className = 'time';
  timeEl.textContent = '00:00:00';
  wrap.appendChild(timeEl);

  panel.appendChild(toolbar);
  panel.appendChild(wrap);
  shadowRoot.appendChild(panel);

  return { timeEl, wrap, panel, menu, toggle, lockToggle, shadowHost };
}

function attachPositionControls(
  panel: HTMLElement,
  wrap: HTMLElement,
  menu: HTMLElement,
  toggle: HTMLButtonElement,
  shadowHost: HTMLElement,
  getPlacement: () => OverlayPlacement,
  setPlacement: (p: OverlayPlacement) => void,
  applyFromPlacement: (p: OverlayPlacement) => Promise<void>,
  persistSafe: (p: OverlayPlacement) => Promise<void>
): { closeMenu: () => void; dispose: () => void } {
  let menuOpen = false;

  const adjustMenuIntoViewport = () => {
    menu.style.transform = '';
    const m = 12;
    const innerW = window.innerWidth;
    const r = menu.getBoundingClientRect();
    const w = r.width;
    const maxLeft = innerW - m - w;
    let idealLeft = r.left;
    if (idealLeft < m) idealLeft = m;
    if (idealLeft > maxLeft) idealLeft = maxLeft;
    idealLeft = Math.max(m, Math.min(idealLeft, maxLeft));
    const dx = idealLeft - r.left;
    if (Math.abs(dx) > 0.5) {
      menu.style.transform = `translateX(${Math.round(dx)}px)`;
    }
  };

  const closeMenu = () => {
    menuOpen = false;
    menu.style.transform = '';
    menu.classList.remove('open', 'pos-menu--up');
    toggle.setAttribute('aria-expanded', 'false');
  };

  const openMenu = () => {
    menuOpen = true;
    menu.style.transform = '';
    menu.classList.remove('pos-menu--up');
    menu.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
    updateMenuSelection(menu, getPlacement());
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const margin = 10;
        const innerH = window.innerHeight;
        const mRect = menu.getBoundingClientRect();
        const tRect = toggle.getBoundingClientRect();
        const overflowsBottom = mRect.bottom > innerH - margin;
        const menuH = mRect.height;
        if (overflowsBottom && tRect.top > menuH + margin) {
          menu.classList.add('pos-menu--up');
        }
        adjustMenuIntoViewport();
      });
    });
  };

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menuOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  menu.addEventListener('click', (e) => e.stopPropagation());

  menu.querySelectorAll<HTMLButtonElement>('.pos-cell').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.preset;
      if (id === 'custom') {
        const rect = panel.getBoundingClientRect();
        void (async () => {
          const next: OverlayPlacement = {
            mode: 'custom',
            left: rect.left,
            top: rect.top,
          };
          setPlacement(next);
          await persistSafe(next);
          await applyFromPlacement(next);
          updateMenuSelection(menu, next);
          closeMenu();
        })();
        return;
      }
      if (
        id === 'tl' ||
        id === 'tr' ||
        id === 'bl' ||
        id === 'br' ||
        id === 'center'
      ) {
        void (async () => {
          const next: OverlayPlacement = { mode: 'preset', preset: id };
          setPlacement(next);
          await persistSafe(next);
          await applyFromPlacement(next);
          updateMenuSelection(menu, next);
          closeMenu();
        })();
      }
    });
  });

  const onDocPointerDown = (e: PointerEvent) => {
    if (!menuOpen) return;
    const path = e.composedPath();
    if (path.includes(panel) || path.includes(shadowHost)) {
      return;
    }
    closeMenu();
  };
  document.addEventListener('pointerdown', onDocPointerDown, true);

  const dispose = () => {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
  };

  return { closeMenu, dispose };
}

function attachCustomDrag(
  panel: HTMLElement,
  wrap: HTMLElement,
  menu: HTMLElement,
  getPlacement: () => OverlayPlacement,
  setPlacement: (p: OverlayPlacement) => void,
  persistSafe: (p: OverlayPlacement) => Promise<void>,
  /** Tránh reposition theo storage khi đang kéo (resize/visualViewport sẽ không ghi đè vị trí). */
  dragActiveRef: { active: boolean }
): void {
  let dragging = false;
  let grabOffsetX = 0;
  let grabOffsetY = 0;

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || getPlacement().mode !== 'custom') return;
    const rawLeft = e.clientX - grabOffsetX;
    const rawTop = e.clientY - grabOffsetY;
    applyPosition(panel, clampToViewport(rawLeft, rawTop, panel));
  };

  const endDrag = async (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      wrap.classList.remove('dragging');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      try {
        wrap.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (getPlacement().mode !== 'custom') return;
      const r = panel.getBoundingClientRect();
      const clamped = clampToViewport(r.left, r.top, panel);
      applyPosition(panel, clamped);
      const next: OverlayPlacement = {
        mode: 'custom',
        left: clamped.left,
        top: clamped.top,
      };
      setPlacement(next);
      await persistSafe(next);
    } finally {
      dragActiveRef.active = false;
    }
  };

  wrap.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;

    if (getPlacement().mode !== 'custom') {
      const pr = panel.getBoundingClientRect();
      const clamped = clampToViewport(pr.left, pr.top, panel);
      applyPosition(panel, clamped);
      const switched: OverlayPlacement = {
        mode: 'custom',
        left: clamped.left,
        top: clamped.top,
      };
      setPlacement(switched);
      applyWrapMode(wrap, switched);
      void persistSafe(switched);
      updateMenuSelection(menu, switched);
    }

    dragActiveRef.active = true;
    dragging = true;
    wrap.classList.add('dragging');
    const r = panel.getBoundingClientRect();
    grabOffsetX = e.clientX - r.left;
    grabOffsetY = e.clientY - r.top;
    wrap.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  });
}

async function main(): Promise<void> {
  const { timeEl, wrap, panel, menu, toggle, lockToggle, shadowHost } = mountShadow();
  const lockScreen = document.createElement('div');
  lockScreen.id = 'fyt-site-lock-screen';
  lockScreen.style.position = 'fixed';
  lockScreen.style.inset = '0';
  lockScreen.style.zIndex = '2147483647';
  lockScreen.style.background = '#020617';
  lockScreen.style.pointerEvents = 'auto';
  lockScreen.style.display = 'none';
  lockScreen.style.alignItems = 'center';
  lockScreen.style.justifyContent = 'center';
  lockScreen.style.padding = '20px';
  lockScreen.style.boxSizing = 'border-box';
  lockScreen.style.cursor = 'not-allowed';
  const lockModal = document.createElement('div');
  lockModal.style.minWidth = 'min(520px, 92vw)';
  lockModal.style.maxWidth = '92vw';
  lockModal.style.padding = '26px 20px';
  lockModal.style.borderRadius = '14px';
  lockModal.style.textAlign = 'center';
  lockModal.style.background = 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 55%, #4c1d95 100%)';
  lockModal.style.boxShadow =
    '0 0 0 2px rgba(250, 204, 21, 0.95), 0 12px 40px rgba(15, 23, 42, 0.55), 0 0 48px rgba(168, 85, 247, 0.35)';
  const lockLabel = document.createElement('p');
  lockLabel.textContent = 'Website này đang bị khóa';
  lockLabel.style.margin = '0';
  lockLabel.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
  lockLabel.style.fontWeight = '800';
  lockLabel.style.fontSize = '38px';
  lockLabel.style.lineHeight = '1.2';
  lockLabel.style.color = '#f8fafc';
  const unlockBtn = document.createElement('button');
  unlockBtn.type = 'button';
  unlockBtn.textContent = 'Mở khóa website';
  unlockBtn.style.marginTop = '18px';
  unlockBtn.style.padding = '10px 16px';
  unlockBtn.style.border = '1px solid rgba(74, 222, 128, 0.95)';
  unlockBtn.style.borderRadius = '10px';
  unlockBtn.style.background = 'rgba(22, 163, 74, 0.2)';
  unlockBtn.style.color = '#bbf7d0';
  unlockBtn.style.fontSize = '18px';
  unlockBtn.style.fontWeight = '700';
  unlockBtn.style.cursor = 'pointer';
  lockModal.appendChild(lockLabel);
  lockModal.appendChild(unlockBtn);
  lockScreen.appendChild(lockModal);
  document.documentElement.appendChild(lockScreen);

  let destroyed = false;
  const intervalIds: number[] = [];
  const htmlOverflow = document.documentElement.style.overflow;
  const bodyOverflow = document.body?.style.overflow ?? '';
  const preventScroll = (e: Event) => e.preventDefault();
  lockScreen.addEventListener('wheel', preventScroll, { passive: false });
  lockScreen.addEventListener('touchmove', preventScroll, { passive: false });

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const id of intervalIds) {
      clearInterval(id);
    }
    disposeDoc?.();
    if (onResizeHandler) {
      window.removeEventListener('resize', onResizeHandler);
    }
    if (onVvResizeHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', onVvResizeHandler);
    }
    if (msgListener) {
      chrome.runtime.onMessage.removeListener(msgListener);
    }
    if (storageListener) {
      chrome.storage.onChanged.removeListener(storageListener);
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.documentElement.style.overflow = htmlOverflow;
    if (document.body) {
      document.body.style.overflow = bodyOverflow;
    }
    lockScreen.removeEventListener('wheel', preventScroll);
    lockScreen.removeEventListener('touchmove', preventScroll);
    lockScreen.remove();
    shadowHost.remove();
  };

  let disposeDoc: (() => void) | null = null;
  let onResizeHandler: (() => void) | null = null;
  let onVvResizeHandler: (() => void) | null = null;
  let msgListener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] | null =
    null;
  let storageListener: Parameters<
    typeof chrome.storage.onChanged.addListener
  >[0] | null = null;

  const loadSafe = async (): Promise<OverlayPlacement | null> => {
    if (!isExtensionAlive()) return null;
    try {
      return await loadPlacement();
    } catch (e) {
      if (isContextInvalidatedError(e)) return null;
      throw e;
    }
  };

  const persistSafe = async (placement: OverlayPlacement): Promise<void> => {
    if (destroyed) return;
    if (!isExtensionAlive()) {
      destroy();
      return;
    }
    try {
      await persistPlacement(placement);
    } catch (e) {
      if (isContextInvalidatedError(e)) destroy();
    }
  };

  const fetchSafe = async (url: string): Promise<DisplayPayload | null> => {
    if (destroyed) return null;
    if (!isExtensionAlive()) {
      destroy();
      return null;
    }
    try {
      return await chrome.runtime.sendMessage({
        type: 'GET_DISPLAY',
        url,
      } as const);
    } catch (e) {
      if (isContextInvalidatedError(e)) {
        destroy();
        return null;
      }
      return null;
    }
  };

  const setLockSafe = async (locked: boolean): Promise<boolean> => {
    if (destroyed) return false;
    if (!isExtensionAlive()) {
      destroy();
      return false;
    }
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'SET_SITE_LOCK',
        url: window.location.href,
        locked,
      } as const)) as { ok?: boolean; locked?: boolean } | undefined;
      return Boolean(res?.ok);
    } catch (e) {
      if (isContextInvalidatedError(e)) {
        destroy();
      }
      return false;
    }
  };

  let isLocked = false;
  const applyLockUi = (locked: boolean) => {
    isLocked = locked;
    panel.classList.toggle('site-locked', locked);
    panel.style.display = locked ? 'none' : '';
    lockScreen.style.display = locked ? 'flex' : 'none';
    document.documentElement.style.overflow = locked ? 'hidden' : htmlOverflow;
    if (document.body) {
      document.body.style.overflow = locked ? 'hidden' : bodyOverflow;
    }
    timeEl.style.display = locked ? 'none' : '';
    lockToggle.setAttribute(
      'aria-label',
      locked ? 'Mở khóa website' : 'Khóa website'
    );
    lockToggle.setAttribute(
      'title',
      locked ? 'Mở khóa website' : 'Khóa website'
    );
    lockToggle.classList.toggle('locked', locked);
    lockToggle.innerHTML = locked
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a5 5 0 00-5 5v1H6a2 2 0 00-2 2v8a2 2 0 002 2h10a2 2 0 002-2v-8a2 2 0 00-2-2h-1V7a5 5 0 00-5-5zm3 7H9V7a3 3 0 116 0v2z"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17 8h-1V6a4 4 0 10-8 0v2H7a2 2 0 00-2 2v8a2 2 0 002 2h10a2 2 0 002-2v-8a2 2 0 00-2-2zm-7-2a2 2 0 114 0v2h-4V6z"/></svg>';
  };

  const applyInitialLockState = async () => {
    try {
      const domain = urlToRegistrableDomain(window.location.href);
      if (!domain) return;
      const r = await chrome.storage.local.get(LOCKED_DOMAINS_KEY);
      const lockedMap = r[LOCKED_DOMAINS_KEY] as Record<string, boolean> | undefined;
      applyLockUi(Boolean(lockedMap?.[domain]));
    } catch {
      /* ignore initial lock lookup errors */
    }
  };

  lockToggle.addEventListener('click', () => {
    void (async () => {
      const ok = await setLockSafe(!isLocked);
      if (!ok) return;
      await sync();
    })();
  });

  unlockBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await setLockSafe(false);
      if (!ok) return;
      await sync();
    })();
  });

  void applyInitialLockState();

  let currentPlacement: OverlayPlacement = DEFAULT_PLACEMENT;
  const getPlacement = () => currentPlacement;
  const setPlacement = (p: OverlayPlacement) => {
    currentPlacement = p;
  };

  const applyFromPlacement = async (placement: OverlayPlacement) => {
    if (destroyed) return;
    const pos = placementToPosition(placement, panel);
    applyPosition(panel, pos);
    applyWrapMode(wrap, placement);
    if (
      placement.mode === 'custom' &&
      (pos.left !== placement.left || pos.top !== placement.top)
    ) {
      const fixed: OverlayPlacement = {
        mode: 'custom',
        left: pos.left,
        top: pos.top,
      };
      setPlacement(fixed);
      await persistSafe(fixed);
    }
  };

  const applyInitial = async () => {
    const p = await loadSafe();
    if (p == null) {
      destroy();
      return;
    }
    currentPlacement = p;
    await applyFromPlacement(currentPlacement);
    updateMenuSelection(menu, currentPlacement);
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void applyInitial().catch((e) => {
        if (isContextInvalidatedError(e)) destroy();
      });
    });
  });

  const { dispose: disposePosControls } = attachPositionControls(
    panel,
    wrap,
    menu,
    toggle,
    shadowHost,
    getPlacement,
    setPlacement,
    applyFromPlacement,
    persistSafe
  );
  disposeDoc = disposePosControls;

  const panelDragActive = { active: false };
  attachCustomDrag(
    panel,
    wrap,
    menu,
    getPlacement,
    setPlacement,
    persistSafe,
    panelDragActive
  );

  const repositionForViewport = async () => {
    if (destroyed || panelDragActive.active) return;
    const pos = placementToPosition(currentPlacement, panel);
    applyPosition(panel, pos);
    if (currentPlacement.mode === 'custom') {
      const inside =
        pos.left === currentPlacement.left && pos.top === currentPlacement.top;
      if (!inside) {
        const next: OverlayPlacement = {
          mode: 'custom',
          left: pos.left,
          top: pos.top,
        };
        setPlacement(next);
        await persistSafe(next);
      }
    }
  };

  onResizeHandler = () => {
    void repositionForViewport().catch((e) => {
      if (isContextInvalidatedError(e)) destroy();
    });
  };
  window.addEventListener('resize', onResizeHandler);

  onVvResizeHandler = () => {
    void repositionForViewport().catch((e) => {
      if (isContextInvalidatedError(e)) destroy();
    });
  };
  window.visualViewport?.addEventListener('resize', onVvResizeHandler);

  const sync = async () => {
    if (destroyed) return;
    const data = await fetchSafe(window.location.href);
    if (destroyed) return;
    lastPayload = data;
    applyLockUi(Boolean(data?.isLocked));
    if (data?.isLocked) return;
    renderFromPayload(timeEl, data);
  };

  const runIfVisible = () => {
    if (destroyed) return;
    if (document.visibilityState === 'visible') {
      void sync().catch((e) => {
        if (isContextInvalidatedError(e)) destroy();
      });
    }
  };

  const onVisibilityChange = () => runIfVisible();

  runIfVisible();
  intervalIds.push(window.setInterval(runIfVisible, 1000));
  intervalIds.push(
    window.setInterval(() => {
      if (destroyed) return;
      if (document.visibilityState === 'visible' && !isLocked) {
        renderFromPayload(timeEl, lastPayload);
      }
    }, 100)
  );
  document.addEventListener('visibilitychange', onVisibilityChange);

  msgListener = (msg: unknown) => {
    if (destroyed) return;
    const type = (msg as { type?: string })?.type;
    if (type === 'TOTALS_UPDATED' || type === 'LOCK_STATE_UPDATED') {
      runIfVisible();
    }
  };
  chrome.runtime.onMessage.addListener(msgListener);

  storageListener = (changes, area) => {
    if (destroyed) return;
    if (area === 'local' && changes[TOTALS_STORAGE_KEY]) {
      runIfVisible();
    }
    if (area === 'local' && changes[OVERLAY_POS_KEY]?.newValue) {
      void (async () => {
        try {
          const p = await loadSafe();
          if (p == null) {
            destroy();
            return;
          }
          setPlacement(p);
          await applyFromPlacement(p);
          updateMenuSelection(menu, p);
        } catch (e) {
          if (isContextInvalidatedError(e)) destroy();
        }
      })();
    }
  };
  chrome.storage.onChanged.addListener(storageListener);
}

function renderFromPayload(timeEl: HTMLElement, p: DisplayPayload | null): void {
  if (!p || p.isLocked) {
    timeEl.textContent = '--:--:--';
    return;
  }
  const live =
    p.openSessionStartMs != null
      ? (Date.now() - p.openSessionStartMs) / 1000
      : 0;
  timeEl.textContent = formatClockHMS(p.storedSeconds + live);
}

void main();
