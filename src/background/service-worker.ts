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
type TimerScheduleMessage = {
  type: 'SET_TIMER_SCHEDULE';
  title: string;
  timeHHMM: string;
};
type UpdateTimerScheduleMessage = {
  type: 'UPDATE_TIMER_SCHEDULE';
  id: string;
  title: string;
  timeHHMM: string;
};
type DeleteTimerScheduleMessage = {
  type: 'DELETE_TIMER_SCHEDULE';
  id: string;
};
type AcknowledgeReminderMessage = {
  type: 'ACK_ACTIVE_REMINDER';
  reminderId: string;
};
type RuntimeMessage =
  | GetDisplayMessage
  | SetSiteLockMessage
  | TimerScheduleMessage
  | UpdateTimerScheduleMessage
  | DeleteTimerScheduleMessage
  | AcknowledgeReminderMessage;

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

let lastFocusedChromeWindowId: number | null = null;
/** Domain đang được cộng thời gian (duy nhất): tab active của lastFocusedChromeWindowId. */
let countedDomain: string | null = null;
let sessionStartMs: number | null = null;
const LOCKED_DOMAINS_KEY = 'fytLockedDomains' as const;
const TIMER_SCHEDULES_KEY = 'fytTimerSchedules' as const;
const LEGACY_TIMER_SCHEDULE_KEY = 'fytTimerSchedule' as const;
const ACTIVE_REMINDER_KEY = 'fytActiveReminder' as const;
const TIMER_ALARM_PREFIX = 'fytTimerReminder:' as const;
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

function isValidTimeHHMM(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hStr, mStr] = value.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  return Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function computeNextWhenMs(timeHHMM: string, nowMs = Date.now()): number {
  const now = new Date(nowMs);
  const [hStr, mStr] = timeHHMM.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= nowMs) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

function parseSchedule(raw: unknown): TimerSchedule | null {
  const item = raw as Partial<TimerSchedule> | undefined;
  if (!item) return null;
  if (
    typeof item.id !== 'string' ||
    typeof item.title !== 'string' ||
    typeof item.timeHHMM !== 'string' ||
    typeof item.whenMs !== 'number' ||
    typeof item.createdAtMs !== 'number'
  ) {
    return null;
  }
  if (!isValidTimeHHMM(item.timeHHMM)) return null;
  return {
    id: item.id,
    title: item.title,
    timeHHMM: item.timeHHMM,
    whenMs: item.whenMs,
    createdAtMs: item.createdAtMs,
  };
}

function sortSchedules(schedules: TimerSchedule[]): TimerSchedule[] {
  return schedules
    .slice()
    .sort(
      (a, b) =>
        a.timeHHMM.localeCompare(b.timeHHMM) || a.createdAtMs - b.createdAtMs
    );
}

async function readTimerSchedules(): Promise<TimerSchedule[]> {
  const r = await chrome.storage.local.get([
    TIMER_SCHEDULES_KEY,
    LEGACY_TIMER_SCHEDULE_KEY,
  ]);
  const listRaw = r[TIMER_SCHEDULES_KEY] as unknown;
  if (Array.isArray(listRaw)) {
    return sortSchedules(
      listRaw.map((x) => parseSchedule(x)).filter((x): x is TimerSchedule => x != null)
    );
  }
  const legacy = parseSchedule(r[LEGACY_TIMER_SCHEDULE_KEY]);
  if (!legacy) return [];
  const migrated = [legacy];
  await chrome.storage.local.set({
    [TIMER_SCHEDULES_KEY]: migrated,
    [LEGACY_TIMER_SCHEDULE_KEY]: null,
  });
  return migrated;
}

async function readActiveReminder(): Promise<ActiveReminder | null> {
  const r = await chrome.storage.local.get(ACTIVE_REMINDER_KEY);
  const raw = r[ACTIVE_REMINDER_KEY] as ActiveReminder | undefined;
  if (!raw) return null;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.title !== 'string' ||
    typeof raw.timeHHMM !== 'string' ||
    typeof raw.whenMs !== 'number' ||
    typeof raw.triggeredAtMs !== 'number'
  ) {
    return null;
  }
  return raw;
}

async function broadcastReminderStateChanged(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    if (t.id == null) continue;
    chrome.tabs.sendMessage(t.id, { type: 'REMINDER_STATE_UPDATED' }).catch(() => {});
  }
}

function alarmNameForSchedule(id: string): string {
  return `${TIMER_ALARM_PREFIX}${id}`;
}

async function scheduleAlarmForTimer(item: TimerSchedule): Promise<void> {
  chrome.alarms.create(alarmNameForSchedule(item.id), { when: item.whenMs });
}

async function removeAlarmForTimer(id: string): Promise<void> {
  await chrome.alarms.clear(alarmNameForSchedule(id));
}

async function createTimerSchedule(
  title: string,
  timeHHMM: string
): Promise<TimerSchedule[]> {
  const whenMs = computeNextWhenMs(timeHHMM);
  const schedule: TimerSchedule = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: title.trim(),
    timeHHMM,
    whenMs,
    createdAtMs: Date.now(),
  };
  const current = await readTimerSchedules();
  const next = sortSchedules([...current, schedule]);
  await chrome.storage.local.set({
    [TIMER_SCHEDULES_KEY]: next,
  });
  await scheduleAlarmForTimer(schedule);
  await broadcastReminderStateChanged();
  return next;
}

async function updateTimerSchedule(
  id: string,
  title: string,
  timeHHMM: string
): Promise<TimerSchedule[] | null> {
  const current = await readTimerSchedules();
  const idx = current.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  const prev = current[idx];
  const updated: TimerSchedule = {
    ...prev,
    title: title.trim(),
    timeHHMM,
    whenMs: computeNextWhenMs(timeHHMM),
  };
  const next = sortSchedules([
    ...current.slice(0, idx),
    updated,
    ...current.slice(idx + 1),
  ]);
  await chrome.storage.local.set({ [TIMER_SCHEDULES_KEY]: next });
  await removeAlarmForTimer(id);
  await scheduleAlarmForTimer(updated);
  await broadcastReminderStateChanged();
  return next;
}

async function deleteTimerSchedule(id: string): Promise<TimerSchedule[]> {
  const current = await readTimerSchedules();
  const next = current.filter((x) => x.id !== id);
  await chrome.storage.local.set({ [TIMER_SCHEDULES_KEY]: next });
  await removeAlarmForTimer(id);
  await broadcastReminderStateChanged();
  return next;
}

async function triggerActiveReminderFromSchedule(scheduleId: string): Promise<void> {
  const schedules = await readTimerSchedules();
  const schedule = schedules.find((x) => x.id === scheduleId);
  if (!schedule) return;
  const nextWhenMs = computeNextWhenMs(schedule.timeHHMM, Date.now() + 1000);
  const nextSchedule: TimerSchedule = {
    ...schedule,
    whenMs: nextWhenMs,
  };
  const active: ActiveReminder = {
    id: schedule.id,
    title: schedule.title,
    timeHHMM: schedule.timeHHMM,
    whenMs: schedule.whenMs,
    triggeredAtMs: Date.now(),
  };
  await chrome.storage.local.set({
    [TIMER_SCHEDULES_KEY]: schedules.map((x) =>
      x.id === scheduleId ? nextSchedule : x
    ),
    [ACTIVE_REMINDER_KEY]: active,
  });
  await scheduleAlarmForTimer(nextSchedule);
  await broadcastReminderStateChanged();
}

async function acknowledgeActiveReminder(reminderId: string): Promise<boolean> {
  const active = await readActiveReminder();
  if (!active) return true;
  if (active.id !== reminderId) return false;
  await chrome.storage.local.set({ [ACTIVE_REMINDER_KEY]: null });
  await broadcastReminderStateChanged();
  return true;
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
    return;
  }
  if (a.name.startsWith(TIMER_ALARM_PREFIX)) {
    const scheduleId = a.name.slice(TIMER_ALARM_PREFIX.length);
    enqueueMutation(async () => {
      if (!scheduleId) return;
      await triggerActiveReminderFromSchedule(scheduleId);
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
          activeReminder: await readActiveReminder(),
          timerSchedules: await readTimerSchedules(),
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

    if (
      message?.type === 'SET_TIMER_SCHEDULE' &&
      typeof message.title === 'string' &&
      typeof message.timeHHMM === 'string'
    ) {
      void (async () => {
        const title = message.title.trim();
        const timeHHMM = message.timeHHMM.trim();
        if (!title || !isValidTimeHHMM(timeHHMM)) {
          sendResponse({ ok: false, error: 'INVALID_INPUT' });
          return;
        }
        const schedules = await createTimerSchedule(title, timeHHMM);
        sendResponse({ ok: true, schedules });
      })();
      return true;
    }

    if (
      message?.type === 'UPDATE_TIMER_SCHEDULE' &&
      typeof message.id === 'string' &&
      typeof message.title === 'string' &&
      typeof message.timeHHMM === 'string'
    ) {
      void (async () => {
        const title = message.title.trim();
        const timeHHMM = message.timeHHMM.trim();
        if (!message.id || !title || !isValidTimeHHMM(timeHHMM)) {
          sendResponse({ ok: false, error: 'INVALID_INPUT' });
          return;
        }
        const schedules = await updateTimerSchedule(message.id, title, timeHHMM);
        if (!schedules) {
          sendResponse({ ok: false, error: 'NOT_FOUND' });
          return;
        }
        sendResponse({ ok: true, schedules });
      })();
      return true;
    }

    if (message?.type === 'DELETE_TIMER_SCHEDULE' && typeof message.id === 'string') {
      void (async () => {
        const schedules = await deleteTimerSchedule(message.id);
        sendResponse({ ok: true, schedules });
      })();
      return true;
    }

    if (
      message?.type === 'ACK_ACTIVE_REMINDER' &&
      typeof message.reminderId === 'string'
    ) {
      void (async () => {
        const ok = await acknowledgeActiveReminder(message.reminderId);
        sendResponse({ ok });
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
  const pendingSchedules = await readTimerSchedules();
  const activeReminder = await readActiveReminder();
  if (activeReminder) {
    await broadcastReminderStateChanged();
  }
  for (const schedule of pendingSchedules) {
    if (schedule.whenMs <= Date.now()) {
      await triggerActiveReminderFromSchedule(schedule.id);
    } else {
      await scheduleAlarmForTimer(schedule);
    }
  }
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
