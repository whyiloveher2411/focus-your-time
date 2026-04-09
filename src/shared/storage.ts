import { getLogicalDayKey, logicalDayEndMs } from './logical-day';

export const STORAGE_KEY_TOTALS = 'totalsByDay' as const;

export type TotalsByDay = Record<string, Record<string, number>>;

export async function readTotalsByDay(): Promise<TotalsByDay> {
  const r = await chrome.storage.local.get(STORAGE_KEY_TOTALS);
  return (r[STORAGE_KEY_TOTALS] as TotalsByDay) ?? {};
}

export async function writeTotalsByDay(totals: TotalsByDay): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_TOTALS]: totals });
}

/** Cộng thời lượng [startMs, endMs) vào đúng các ngày logic (xử lý qua mốc 7:00). */
export async function addDurationAcrossLogicalDays(
  startMs: number,
  endMs: number,
  domain: string
): Promise<void> {
  if (endMs <= startMs) return;
  const totals = await readTotalsByDay();
  let t = startMs;
  while (t < endMs) {
    const key = getLogicalDayKey(new Date(t));
    const dayEnd = logicalDayEndMs(key);
    const segEnd = Math.min(endMs, dayEnd);
    const seconds = (segEnd - t) / 1000;
    if (seconds > 0) {
      if (!totals[key]) totals[key] = {};
      totals[key][domain] = (totals[key][domain] ?? 0) + seconds;
    }
    t = segEnd;
  }
  await writeTotalsByDay(totals);
}

export async function getStoredSecondsForDomain(
  dayKey: string,
  domain: string
): Promise<number> {
  const totals = await readTotalsByDay();
  return totals[dayKey]?.[domain] ?? 0;
}
