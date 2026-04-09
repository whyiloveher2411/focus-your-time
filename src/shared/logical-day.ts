export const RESET_HOUR = 7;

/** Ngày logic: từ 7:00 hôm nay đến trước 7:00 ngày mai (theo giờ địa phương). Trước 7:00 sáng vẫn thuộc "ngày" hôm qua. */
export function getLogicalDayKey(date: Date = new Date()): string {
  const d = new Date(date);
  if (d.getHours() < RESET_HOUR) {
    d.setDate(d.getDate() - 1);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseLogicalDayKey(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

/** Mốc bắt đầu (ms) của ngày logic `key` theo giờ local. */
export function logicalDayStartMs(key: string): number {
  const { y, m, d } = parseLogicalDayKey(key);
  return new Date(y, m - 1, d, RESET_HOUR, 0, 0, 0).getTime();
}

/** Mốc kết thúc (ms, exclusive) — tức 7:00 ngày hôm sau. */
export function logicalDayEndMs(key: string): number {
  const { y, m, d } = parseLogicalDayKey(key);
  return new Date(y, m - 1, d + 1, RESET_HOUR, 0, 0, 0).getTime();
}
