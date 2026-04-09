import { formatClockHMS } from '../shared/format-duration';
import styles from './overlay.css?inline';

const TOTALS_STORAGE_KEY = 'totalsByDay';
const OVERLAY_POS_KEY = 'fytOverlayPosition';

const VIEW_MARGIN = 12;

type PresetId = 'tl' | 'tr' | 'bl' | 'br' | 'center';

type OverlayPlacement =
  | { mode: 'preset'; preset: PresetId }
  | { mode: 'custom'; left: number; top: number };

type DisplayPayload = {
  storedSeconds: number;
  openSessionStartMs: number | null;
  isLocked: boolean;
  activeReminder: ActiveReminder | null;
  timerSchedules: TimerSchedule[];
};

type SavedPosition = { left: number; top: number };
type TimerSchedule = {
  id: string;
  title: string;
  timeHHMM: string;
  whenMs: number;
  createdAtMs: number;
};
type ActiveReminder = {
  id: string;
  title: string;
  timeHHMM: string;
  whenMs: number;
  triggeredAtMs: number;
};

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
  timerToggle: HTMLButtonElement;
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
  const timerToggle = document.createElement('button');
  timerToggle.type = 'button';
  timerToggle.className = 'timer-toggle';
  timerToggle.setAttribute('aria-label', 'Hẹn giờ');
  timerToggle.setAttribute('title', 'Hẹn giờ');
  timerToggle.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M15 1H9v2h6V1zm-3 4a8 8 0 100 16 8 8 0 000-16zm0 14a6 6 0 110-12 6 6 0 010 12zm.5-10h-1.5v5l4.2 2.5.8-1.3-3.5-2.1V9z"/>' +
    '</svg>';
  toolbar.appendChild(timerToggle);
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

  return { timeEl, wrap, panel, menu, toggle, lockToggle, timerToggle, shadowHost };
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
  const { timeEl, wrap, panel, menu, toggle, lockToggle, timerToggle, shadowHost } =
    mountShadow();
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
  const lockScheduleBtn = document.createElement('button');
  lockScheduleBtn.type = 'button';
  lockScheduleBtn.setAttribute('aria-label', 'Xem lịch hẹn giờ');
  lockScheduleBtn.setAttribute('title', 'Xem lịch hẹn giờ');
  lockScheduleBtn.style.position = 'fixed';
  lockScheduleBtn.style.top = '8px';
  lockScheduleBtn.style.left = '8px';
  lockScheduleBtn.style.width = '34px';
  lockScheduleBtn.style.height = '34px';
  lockScheduleBtn.style.borderRadius = '999px';
  lockScheduleBtn.style.border = '1px solid rgba(250, 204, 21, 0.75)';
  lockScheduleBtn.style.background = 'rgba(15, 23, 42, 0.45)';
  lockScheduleBtn.style.color = '#fde68a';
  lockScheduleBtn.style.cursor = 'pointer';
  lockScheduleBtn.style.display = 'inline-flex';
  lockScheduleBtn.style.alignItems = 'center';
  lockScheduleBtn.style.justifyContent = 'center';
  lockScheduleBtn.style.boxShadow = '0 6px 20px rgba(15, 23, 42, 0.45)';
  lockScheduleBtn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M19 3h-1V1h-2v2H8V1H6v2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm0 16H5V9h14v10zM7 11h5v5H7z"/>' +
    '</svg>';
  const lockScheduleDropdown = document.createElement('div');
  lockScheduleDropdown.style.position = 'fixed';
  lockScheduleDropdown.style.top = '48px';
  lockScheduleDropdown.style.left = '8px';
  lockScheduleDropdown.style.display = 'none';
  lockScheduleDropdown.style.width = 'min(300px, calc(92vw - 34px))';
  lockScheduleDropdown.style.padding = '10px';
  lockScheduleDropdown.style.borderRadius = '10px';
  lockScheduleDropdown.style.border = '1px solid rgba(250, 204, 21, 0.45)';
  lockScheduleDropdown.style.background = 'rgba(15, 23, 42, 0.96)';
  lockScheduleDropdown.style.boxShadow = '0 10px 28px rgba(2, 6, 23, 0.6)';
  lockScheduleDropdown.style.textAlign = 'left';
  lockScheduleDropdown.style.zIndex = '3';
  const lockScheduleHeader = document.createElement('div');
  lockScheduleHeader.style.display = 'flex';
  lockScheduleHeader.style.alignItems = 'center';
  lockScheduleHeader.style.justifyContent = 'space-between';
  lockScheduleHeader.style.gap = '8px';
  lockScheduleHeader.style.marginBottom = '8px';
  const lockScheduleTitle = document.createElement('p');
  lockScheduleTitle.textContent = 'Lịch đã hẹn';
  lockScheduleTitle.style.margin = '0';
  lockScheduleTitle.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
  lockScheduleTitle.style.fontSize = '12px';
  lockScheduleTitle.style.fontWeight = '700';
  lockScheduleTitle.style.color = 'rgba(248,250,252,0.85)';
  const lockScheduleAddBtn = document.createElement('button');
  lockScheduleAddBtn.type = 'button';
  lockScheduleAddBtn.textContent = '+ Thêm lịch';
  lockScheduleAddBtn.style.padding = '5px 10px';
  lockScheduleAddBtn.style.fontSize = '11px';
  lockScheduleAddBtn.style.fontWeight = '800';
  lockScheduleAddBtn.style.borderRadius = '7px';
  lockScheduleAddBtn.style.border = '1px solid rgba(74,222,128,0.5)';
  lockScheduleAddBtn.style.background = 'rgba(22,163,74,0.22)';
  lockScheduleAddBtn.style.color = '#bbf7d0';
  lockScheduleAddBtn.style.cursor = 'pointer';
  const lockScheduleItems = document.createElement('div');
  lockScheduleItems.style.display = 'flex';
  lockScheduleItems.style.flexDirection = 'column';
  lockScheduleItems.style.gap = '6px';
  lockScheduleHeader.appendChild(lockScheduleTitle);
  lockScheduleHeader.appendChild(lockScheduleAddBtn);
  lockScheduleDropdown.appendChild(lockScheduleHeader);
  lockScheduleDropdown.appendChild(lockScheduleItems);
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
  lockScreen.appendChild(lockScheduleBtn);
  lockScreen.appendChild(lockScheduleDropdown);
  lockScreen.appendChild(lockModal);
  document.documentElement.appendChild(lockScreen);
  const reminderScreen = document.createElement('div');
  reminderScreen.id = 'fyt-reminder-screen';
  reminderScreen.style.position = 'fixed';
  reminderScreen.style.inset = '0';
  reminderScreen.style.zIndex = '2147483647';
  reminderScreen.style.background = '#030712';
  reminderScreen.style.pointerEvents = 'auto';
  reminderScreen.style.display = 'none';
  reminderScreen.style.alignItems = 'center';
  reminderScreen.style.justifyContent = 'center';
  reminderScreen.style.padding = '20px';
  reminderScreen.style.boxSizing = 'border-box';
  const reminderModal = document.createElement('div');
  reminderModal.style.minWidth = 'min(580px, 92vw)';
  reminderModal.style.maxWidth = '92vw';
  reminderModal.style.padding = '28px 20px';
  reminderModal.style.borderRadius = '14px';
  reminderModal.style.textAlign = 'center';
  reminderModal.style.background =
    'linear-gradient(135deg, #0b1020 0%, #1d1b4d 60%, #4c1d95 100%)';
  reminderModal.style.boxShadow =
    '0 0 0 2px rgba(250, 204, 21, 0.95), 0 12px 40px rgba(15, 23, 42, 0.6), 0 0 56px rgba(168, 85, 247, 0.45)';
  const reminderTitle = document.createElement('p');
  reminderTitle.style.margin = '0';
  reminderTitle.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
  reminderTitle.style.fontWeight = '800';
  reminderTitle.style.fontSize = '40px';
  reminderTitle.style.lineHeight = '1.2';
  reminderTitle.style.color = '#f8fafc';
  const reminderTime = document.createElement('p');
  reminderTime.style.margin = '12px 0 0';
  reminderTime.style.fontFamily = 'ui-monospace, Menlo, monospace';
  reminderTime.style.fontWeight = '700';
  reminderTime.style.fontSize = '26px';
  reminderTime.style.color = '#facc15';
  const reminderHint = document.createElement('p');
  reminderHint.textContent = 'Website sẽ bị chặn cho tới khi bạn xác nhận đã thực hiện.';
  reminderHint.style.margin = '14px 0 0';
  reminderHint.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
  reminderHint.style.fontWeight = '600';
  reminderHint.style.fontSize = '14px';
  reminderHint.style.color = 'rgba(248,250,252,0.82)';
  const confirmReminderBtn = document.createElement('button');
  confirmReminderBtn.type = 'button';
  confirmReminderBtn.textContent = 'Tôi đã thực hiện';
  confirmReminderBtn.style.marginTop = '20px';
  confirmReminderBtn.style.padding = '12px 18px';
  confirmReminderBtn.style.border = '1px solid rgba(74, 222, 128, 0.95)';
  confirmReminderBtn.style.borderRadius = '10px';
  confirmReminderBtn.style.background = 'rgba(22, 163, 74, 0.22)';
  confirmReminderBtn.style.color = '#bbf7d0';
  confirmReminderBtn.style.fontSize = '18px';
  confirmReminderBtn.style.fontWeight = '800';
  confirmReminderBtn.style.cursor = 'pointer';
  reminderModal.appendChild(reminderTitle);
  reminderModal.appendChild(reminderTime);
  reminderModal.appendChild(reminderHint);
  reminderModal.appendChild(confirmReminderBtn);
  reminderScreen.appendChild(reminderModal);
  document.documentElement.appendChild(reminderScreen);

  let destroyed = false;
  let lockScheduleDropdownOpen = false;
  const intervalIds: number[] = [];
  const htmlOverflow = document.documentElement.style.overflow;
  const bodyOverflow = document.body?.style.overflow ?? '';
  const preventScroll = (e: Event) => e.preventDefault();
  lockScreen.addEventListener('wheel', preventScroll, { passive: false });
  lockScreen.addEventListener('touchmove', preventScroll, { passive: false });
  reminderScreen.addEventListener('wheel', preventScroll, { passive: false });
  reminderScreen.addEventListener('touchmove', preventScroll, { passive: false });

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
    if (onLockScreenPointerDown) {
      document.removeEventListener('pointerdown', onLockScreenPointerDown, true);
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.documentElement.style.overflow = htmlOverflow;
    if (document.body) {
      document.body.style.overflow = bodyOverflow;
    }
    lockScreen.removeEventListener('wheel', preventScroll);
    lockScreen.removeEventListener('touchmove', preventScroll);
    reminderScreen.removeEventListener('wheel', preventScroll);
    reminderScreen.removeEventListener('touchmove', preventScroll);
    lockScreen.remove();
    reminderScreen.remove();
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
  let onLockScreenPointerDown: ((e: PointerEvent) => void) | null = null;

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
  let activeReminder: ActiveReminder | null = null;
  let timerSchedules: TimerSchedule[] = [];
  let currentPlacement: OverlayPlacement = DEFAULT_PLACEMENT;
  const getPlacement = () => currentPlacement;
  const setPlacement = (p: OverlayPlacement) => {
    currentPlacement = p;
  };
  const refreshPanelPositionWhenVisible = () => {
    if (panel.style.display === 'none') return;
    requestAnimationFrame(() => {
      const pos = placementToPosition(currentPlacement, panel);
      applyPosition(panel, pos);
    });
  };
  const renderLockScheduleList = () => {
    lockScheduleItems.replaceChildren();
    if (timerSchedules.length > 0) {
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      for (const schedule of timerSchedules) {
        const [hStr, mStr] = schedule.timeHHMM.split(':');
        const scheduleMinutes = Number(hStr) * 60 + Number(mStr);
        const passedToday = Number.isFinite(scheduleMinutes) && scheduleMinutes <= nowMinutes;
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.justifyContent = 'space-between';
        row.style.gap = '8px';
        row.style.padding = '8px 9px';
        row.style.borderRadius = '8px';
        row.style.border = '1px solid rgba(56,189,248,0.45)';
        row.style.background = 'rgba(30,41,59,0.75)';
        row.style.opacity = passedToday ? '0.52' : '1';
        const text = document.createElement('div');
        text.style.color = '#e2e8f0';
        text.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
        text.style.fontSize = '12px';
        text.style.lineHeight = '1.35';
        text.textContent = `${schedule.timeHHMM} - ${schedule.title} (lặp mỗi ngày)`;
        const actions = document.createElement('div');
        actions.style.display = 'inline-flex';
        actions.style.gap = '6px';
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.textContent = 'Sửa';
        editBtn.style.padding = '4px 8px';
        editBtn.style.fontSize = '11px';
        editBtn.style.fontWeight = '700';
        editBtn.style.borderRadius = '6px';
        editBtn.style.border = '1px solid rgba(250,204,21,0.45)';
        editBtn.style.background = 'rgba(30,41,59,0.8)';
        editBtn.style.color = '#fde68a';
        editBtn.style.cursor = 'pointer';
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void editTimerScheduleInteractive(schedule);
        });
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.textContent = 'Xóa';
        deleteBtn.style.padding = '4px 8px';
        deleteBtn.style.fontSize = '11px';
        deleteBtn.style.fontWeight = '700';
        deleteBtn.style.borderRadius = '6px';
        deleteBtn.style.border = '1px solid rgba(248,113,113,0.45)';
        deleteBtn.style.background = 'rgba(30,41,59,0.8)';
        deleteBtn.style.color = '#fecaca';
        deleteBtn.style.cursor = 'pointer';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void deleteTimerScheduleInteractive(schedule);
        });
        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        row.appendChild(text);
        row.appendChild(actions);
        lockScheduleItems.appendChild(row);
      }
      return;
    }
    const empty = document.createElement('p');
    empty.textContent = 'Chưa có lịch hẹn.';
    empty.style.margin = '0';
    empty.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
    empty.style.fontSize = '12px';
    empty.style.color = 'rgba(226,232,240,0.8)';
    lockScheduleItems.appendChild(empty);
  };
  const closeLockScheduleDropdown = () => {
    lockScheduleDropdownOpen = false;
    lockScheduleDropdown.style.display = 'none';
  };
  const askScheduleInput = (seed?: {
    title: string;
    timeHHMM: string;
  }): { title: string; timeHHMM: string } | null => {
    const title = window.prompt(
      'Tiêu đề nhắc việc (ví dụ: Làm việc A):',
      seed?.title ?? ''
    );
    if (title == null) return null;
    const cleanTitle = title.trim();
    if (!cleanTitle) return null;
    const defaultTime = (() => {
      const d = new Date(Date.now() + 60_000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    })();
    const timeInput = window.prompt(
      'Nhập giờ nhắc theo HH:mm (24h):',
      seed?.timeHHMM ?? defaultTime
    );
    if (timeInput == null) return null;
    const cleanTime = timeInput.trim();
    if (!/^\d{2}:\d{2}$/.test(cleanTime)) return null;
    return { title: cleanTitle, timeHHMM: cleanTime };
  };
  const createTimerScheduleSafe = async (
    title: string,
    timeHHMM: string
  ): Promise<boolean> => {
    if (destroyed) return false;
    if (!isExtensionAlive()) {
      destroy();
      return false;
    }
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'SET_TIMER_SCHEDULE',
        title,
        timeHHMM,
      } as const)) as { ok?: boolean } | undefined;
      return Boolean(res?.ok);
    } catch (e) {
      if (isContextInvalidatedError(e)) destroy();
      return false;
    }
  };
  const updateTimerScheduleSafe = async (
    id: string,
    title: string,
    timeHHMM: string
  ): Promise<boolean> => {
    if (destroyed) return false;
    if (!isExtensionAlive()) {
      destroy();
      return false;
    }
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'UPDATE_TIMER_SCHEDULE',
        id,
        title,
        timeHHMM,
      } as const)) as { ok?: boolean } | undefined;
      return Boolean(res?.ok);
    } catch (e) {
      if (isContextInvalidatedError(e)) destroy();
      return false;
    }
  };
  const deleteTimerScheduleSafe = async (id: string): Promise<boolean> => {
    if (destroyed) return false;
    if (!isExtensionAlive()) {
      destroy();
      return false;
    }
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'DELETE_TIMER_SCHEDULE',
        id,
      } as const)) as { ok?: boolean } | undefined;
      return Boolean(res?.ok);
    } catch (e) {
      if (isContextInvalidatedError(e)) destroy();
      return false;
    }
  };
  const editTimerScheduleInteractive = async (schedule: TimerSchedule) => {
    const input = askScheduleInput({
      title: schedule.title,
      timeHHMM: schedule.timeHHMM,
    });
    if (!input) return;
    const ok = await updateTimerScheduleSafe(schedule.id, input.title, input.timeHHMM);
    if (!ok) return;
    await sync();
  };
  const createTimerScheduleInteractive = async () => {
    const input = askScheduleInput();
    if (!input) return;
    const ok = await createTimerScheduleSafe(input.title, input.timeHHMM);
    if (!ok) return;
    await sync();
  };
  lockScheduleAddBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void createTimerScheduleInteractive();
  });
  const deleteTimerScheduleInteractive = async (schedule: TimerSchedule) => {
    const accepted = window.confirm(
      `Xóa lịch "${schedule.title}" lúc ${schedule.timeHHMM}?`
    );
    if (!accepted) return;
    const ok = await deleteTimerScheduleSafe(schedule.id);
    if (!ok) return;
    await sync();
  };
  const applyReminderUi = (reminder: ActiveReminder | null) => {
    activeReminder = reminder;
    const visible = Boolean(reminder);
    reminderScreen.style.display = visible ? 'flex' : 'none';
    if (visible && reminder) {
      reminderTitle.textContent = reminder.title;
      reminderTime.textContent = `Nhắc lúc ${reminder.timeHHMM}`;
    }
    if (visible) {
      closeLockScheduleDropdown();
      panel.style.display = 'none';
      lockScreen.style.display = 'none';
      document.documentElement.style.overflow = 'hidden';
      if (document.body) {
        document.body.style.overflow = 'hidden';
      }
    }
  };
  const applyLockUi = (locked: boolean) => {
    isLocked = locked;
    if (!locked) {
      closeLockScheduleDropdown();
    }
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
    if (!locked) {
      refreshPanelPositionWhenVisible();
    }
  };

  const updateTimerButtonUi = (schedules: TimerSchedule[]) => {
    timerSchedules = schedules;
    renderLockScheduleList();
    if (schedules.length > 0) {
      const first = schedules[0];
      timerToggle.setAttribute(
        'title',
        `Đang có ${schedules.length} lịch - gần nhất: ${first.timeHHMM}`
      );
      timerToggle.classList.add('has-schedule');
    } else {
      timerToggle.setAttribute('title', 'Hẹn giờ');
      timerToggle.classList.remove('has-schedule');
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
      // Optimistic UI to avoid hidden panel race after page reload.
      applyLockUi(false);
      const ok = await setLockSafe(false);
      if (!ok) {
        retrySyncShort();
        return;
      }
      await sync();
      retrySyncShort();
    })();
  });

  lockScheduleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (lockScheduleDropdownOpen) {
      closeLockScheduleDropdown();
      return;
    }
    renderLockScheduleList();
    lockScheduleDropdownOpen = true;
    lockScheduleDropdown.style.display = 'block';
  });
  onLockScreenPointerDown = (e: PointerEvent) => {
    if (!lockScheduleDropdownOpen) return;
    const path = e.composedPath();
    if (path.includes(lockScheduleBtn) || path.includes(lockScheduleDropdown)) return;
    closeLockScheduleDropdown();
  };
  document.addEventListener('pointerdown', onLockScreenPointerDown, true);

  const ackReminder = async (reminderId: string): Promise<boolean> => {
    if (destroyed) return false;
    if (!isExtensionAlive()) {
      destroy();
      return false;
    }
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'ACK_ACTIVE_REMINDER',
        reminderId,
      } as const)) as { ok?: boolean } | undefined;
      return Boolean(res?.ok);
    } catch (e) {
      if (isContextInvalidatedError(e)) destroy();
      return false;
    }
  };

  const retrySyncShort = () => {
    const delays = [120, 320, 700];
    for (const ms of delays) {
      window.setTimeout(() => {
        if (destroyed) return;
        void sync().catch((e) => {
          if (isContextInvalidatedError(e)) destroy();
        });
      }, ms);
    }
  };

  timerToggle.addEventListener('click', () => {
    void createTimerScheduleInteractive();
  });

  confirmReminderBtn.addEventListener('click', () => {
    if (!activeReminder) return;
    void (async () => {
      const ok = await ackReminder(activeReminder.id);
      if (!ok) return;
      await sync();
    })();
  });

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
    applyReminderUi(data?.activeReminder ?? null);
    updateTimerButtonUi(data?.timerSchedules ?? []);
    if (data?.activeReminder) return;
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
    if (
      type === 'TOTALS_UPDATED' ||
      type === 'LOCK_STATE_UPDATED' ||
      type === 'REMINDER_STATE_UPDATED'
    ) {
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
