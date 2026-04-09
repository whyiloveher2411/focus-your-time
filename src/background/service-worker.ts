import { getLogicalDayKey } from '../shared/logical-day';
import { urlToRegistrableDomain } from '../shared/domain-from-url';
import {
  addDurationAcrossLogicalDays,
  getStoredSecondsForDomain,
  STORAGE_KEY_TOTALS,
} from '../shared/storage';

const COUNTING_STATE_KEY = 'fytCountingState' as const;

type CountingState = {
  lastFocusedChromeWindowId: number | null;
  countedDomain: string | null;
  sessionStartMs: number | null;
};

type GetDisplayMessage = { type: 'GET_DISPLAY'; url: string };
type SetSiteLockMessage = {
  type: 'SET_SITE_LOCK';
  url: string;
  locked: boolean;
};
type RuntimeMessage = GetDisplayMessage | SetSiteLockMessage;

let lastFocusedChromeWindowId: number | null = null;
/** Domain đang được cộng thời gian (duy nhất): tab active của lastFocusedChromeWindowId. */
let countedDomain: string | null = null;
let sessionStartMs: number | null = null;
const LOCKED_DOMAINS_KEY = 'fytLockedDomains' as const;
let lockedDomains = new Set<string>();

let mutationQueue: Promise<void> = Promise.resolve();

function enqueueMutation(fn: () => Promise<void>): void {
  mutationQueue = mutationQueue.then(fn).catch((e) => {
    console.error('[FocusYourTime]', e);
  });
}

function tabUrlToDomain(url: string | undefined): string | null {
  if (!url || !url.startsWith('http')) return null;
  return urlToRegistrableDomain(url);
}

async function loadLockedDomains(): Promise<void> {
  const r = await chrome.storage.local.get(LOCKED_DOMAINS_KEY);
  const raw = r[LOCKED_DOMAINS_KEY] as Record<string, boolean> | undefined;
  lockedDomains = new Set(
    Object.entries(raw ?? {})
      .filter(([, v]) => v === true)
      .map(([d]) => d)
  );
}

function isDomainLocked(domain: string | null): boolean {
  return domain != null && lockedDomains.has(domain);
}

async function setDomainLocked(domain: string, locked: boolean): Promise<void> {
  const next = new Set(lockedDomains);
  if (locked) {
    next.add(domain);
  } else {
    next.delete(domain);
  }
  const payload: Record<string, true> = {};
  for (const d of next) payload[d] = true;
  await chrome.storage.local.set({ [LOCKED_DOMAINS_KEY]: payload });
  lockedDomains = next;
}

async function broadcastLockStateChanged(domain: string): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    if (t.id == null) continue;
    const d = tabUrlToDomain(t.url);
    if (d !== domain) continue;
    chrome.tabs
      .sendMessage(t.id, { type: 'LOCK_STATE_UPDATED', domain })
      .catch(() => {});
  }
}

async function persistCountingState(): Promise<void> {
  const payload: CountingState = {
    lastFocusedChromeWindowId,
    countedDomain,
    sessionStartMs,
  };
  await chrome.storage.session.set({ [COUNTING_STATE_KEY]: payload });
}

async function restoreCountingState(): Promise<void> {
  const r = await chrome.storage.session.get(COUNTING_STATE_KEY);
  const s = r[COUNTING_STATE_KEY] as CountingState | undefined;
  if (!s) return;
  if (s.lastFocusedChromeWindowId != null) {
    lastFocusedChromeWindowId = s.lastFocusedChromeWindowId;
  }
  countedDomain = s.countedDomain ?? null;
  sessionStartMs = s.sessionStartMs ?? null;
}

async function setCountedDomain(newDomain: string | null, now = Date.now()): Promise<void> {
  if (countedDomain === newDomain) {
    if (newDomain != null && sessionStartMs == null) {
      sessionStartMs = now;
      await persistCountingState();
    }
    return;
  }
  if (countedDomain != null && sessionStartMs != null) {
    await addDurationAcrossLogicalDays(sessionStartMs, now, countedDomain);
  }
  countedDomain = newDomain;
  sessionStartMs = newDomain != null ? now : null;
  await persistCountingState();
}

/**
 * Chỉ tab active của cửa sổ Chrome được focus gần nhất mới quyết định domain đang đếm.
 * Khi WINDOW_ID_NONE (user sang app khác): giữ lastFocusedChromeWindowId — vẫn đếm tab đó.
 */
async function syncCountedDomainFromBrowser(): Promise<void> {
  let winId = lastFocusedChromeWindowId;
  if (winId == null || winId === chrome.windows.WINDOW_ID_NONE) {
    try {
      const w = await chrome.windows.getLastFocused();
      if (w.id != null && w.id !== chrome.windows.WINDOW_ID_NONE) {
        winId = w.id;
        lastFocusedChromeWindowId = winId;
      }
    } catch {
      /* ignore */
    }
  }
  if (winId == null || winId === chrome.windows.WINDOW_ID_NONE) {
    await setCountedDomain(null);
    return;
  }
  try {
    const exists = await chrome.windows.get(winId);
    if (!exists) {
      lastFocusedChromeWindowId = null;
      await setCountedDomain(null);
      return;
    }
  } catch {
    lastFocusedChromeWindowId = null;
    await setCountedDomain(null);
    return;
  }
  const tabs = await chrome.tabs.query({ active: true, windowId: winId });
  const tab = tabs[0];
  const d = tabUrlToDomain(tab?.url);
  await setCountedDomain(isDomainLocked(d) ? null : d);
}

async function initLastFocusedWindow(): Promise<void> {
  try {
    const w = await chrome.windows.getLastFocused();
    if (w.id != null && w.id !== chrome.windows.WINDOW_ID_NONE && w.focused) {
      lastFocusedChromeWindowId = w.id;
    } else if (w.id != null && w.id !== chrome.windows.WINDOW_ID_NONE) {
      lastFocusedChromeWindowId = w.id;
    }
  } catch {
    /* ignore */
  }
}

async function rolloverAt(endMs: number): Promise<void> {
  if (countedDomain != null && sessionStartMs != null) {
    await addDurationAcrossLogicalDays(sessionStartMs, endMs, countedDomain);
  }
  sessionStartMs =
    countedDomain != null ? endMs : null;
  await persistCountingState();
}

function scheduleRolloverAlarm(): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(7, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  chrome.alarms.create('logicalDayRollover', { when: next.getTime() });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleRolloverAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleRolloverAlarm();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  lastFocusedChromeWindowId = windowId;
  enqueueMutation(() => syncCountedDomainFromBrowser());
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === lastFocusedChromeWindowId) {
    lastFocusedChromeWindowId = null;
    enqueueMutation(() => syncCountedDomainFromBrowser());
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (
    lastFocusedChromeWindowId != null &&
    activeInfo.windowId !== lastFocusedChromeWindowId
  ) {
    return;
  }
  if (lastFocusedChromeWindowId == null) {
    lastFocusedChromeWindowId = activeInfo.windowId;
  }
  enqueueMutation(() => syncCountedDomainFromBrowser());
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url === undefined && info.status !== 'complete') {
    return;
  }
  enqueueMutation(async () => {
    const winId = lastFocusedChromeWindowId;
    if (winId == null || winId === chrome.windows.WINDOW_ID_NONE) {
      return;
    }
    const [active] = await chrome.tabs.query({ active: true, windowId: winId });
    if (active?.id === tabId) {
      await syncCountedDomainFromBrowser();
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueMutation(async () => {
    const winId = lastFocusedChromeWindowId;
    if (winId == null || winId === chrome.windows.WINDOW_ID_NONE) {
      return;
    }
    const [active] = await chrome.tabs.query({ active: true, windowId: winId });
    if (active == null || active.id === tabId) {
      await syncCountedDomainFromBrowser();
    }
  });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'logicalDayRollover') {
    enqueueMutation(async () => {
      const end = Date.now();
      await rolloverAt(end);
      scheduleRolloverAlarm();
    });
  }
});

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, _sender, sendResponse) => {
    if (message?.type === 'GET_DISPLAY' && typeof message.url === 'string') {
      void (async () => {
        const pageDomain = urlToRegistrableDomain(message.url);
        const dayKey = getLogicalDayKey();
        let stored = 0;
        if (pageDomain) {
          stored = await getStoredSecondsForDomain(dayKey, pageDomain);
        }
        const locked = isDomainLocked(pageDomain);
        const isThisDomainCounting =
          !locked &&
          pageDomain != null &&
          countedDomain === pageDomain &&
          sessionStartMs != null;
        sendResponse({
          storedSeconds: stored,
          openSessionStartMs: isThisDomainCounting ? sessionStartMs : null,
          isLocked: locked,
        });
      })();
      return true;
    }

    if (
      message?.type === 'SET_SITE_LOCK' &&
      typeof message.url === 'string' &&
      typeof message.locked === 'boolean'
    ) {
      void (async () => {
        const pageDomain = urlToRegistrableDomain(message.url);
        if (!pageDomain) {
          sendResponse({ ok: false });
          return;
        }
        await setDomainLocked(pageDomain, message.locked);
        await syncCountedDomainFromBrowser();
        await broadcastLockStateChanged(pageDomain);
        sendResponse({ ok: true, locked: message.locked });
      })();
      return true;
    }

    return false;
  }
);

void (async () => {
  await loadLockedDomains();
  await restoreCountingState();
  await initLastFocusedWindow();
  enqueueMutation(() => syncCountedDomainFromBrowser());
  await mutationQueue;
  scheduleRolloverAlarm();
})();

chrome.runtime.onSuspend.addListener(() => {
  enqueueMutation(async () => {
    const end = Date.now();
    if (countedDomain != null && sessionStartMs != null) {
      await addDurationAcrossLogicalDays(sessionStartMs, end, countedDomain);
    }
    sessionStartMs =
      countedDomain != null ? end : null;
    await persistCountingState();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[LOCKED_DOMAINS_KEY] != null) {
    void (async () => {
      await loadLockedDomains();
      await syncCountedDomainFromBrowser();
    })();
  }
  if (changes[STORAGE_KEY_TOTALS] == null) return;
  void chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    for (const t of tabs) {
      if (t.id != null) {
        chrome.tabs.sendMessage(t.id, { type: 'TOTALS_UPDATED' }).catch(() => {});
      }
    }
  });
});
