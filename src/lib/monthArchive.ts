// ============================================================================
// Lưu lịch theo tháng: khi đổi tháng, lịch của tháng đang mở được cất vào
// archive, và lịch đã lưu của tháng đích (nếu có) được mở lại.
// ============================================================================

import type { MonthArchive, Schedule, Shift } from "../types";

/** Schlüssel eines Monats im Archiv, z.B. "2026-08". */
export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Wechselt den Monat, ohne einen erzeugten Plan zu verlieren (rein, ohne Seiteneffekte). */
export function switchMonth(
  schedule: Schedule,
  originalShifts: Shift[],
  year: number,
  month: number,
  savedAt: string = new Date().toISOString(),
): { schedule: Schedule; originalShifts: Shift[] } {
  if (year === schedule.year && month === schedule.month) return { schedule, originalShifts };
  const archive = { ...(schedule.archive ?? {}) };
  if (schedule.shifts.length > 0) {
    archive[monthKey(schedule.year, schedule.month)] = {
      shifts: schedule.shifts,
      originalShifts,
      savedAt,
    };
  }
  const targetKey = monthKey(year, month);
  const saved = archive[targetKey];
  delete archive[targetKey];
  return {
    schedule: { ...schedule, year, month, shifts: saved?.shifts ?? [], archive },
    originalShifts: saved?.originalShifts ?? [],
  };
}

export type SavedMonth = {
  key: string;
  year: number;
  month: number;
  shiftCount: number;
  totalMinutes: number;
  /** true = đây là tháng đang mở. */
  current: boolean;
  /** Lúc cất vào kho (ISO); tháng đang mở thì không có. */
  savedAt?: string;
};

/** Alle Monate mit Plan (Archiv + aktuell geöffneter), chronologisch. */
export function listSavedMonths(schedule: Schedule): SavedMonth[] {
  const total = (shifts: Shift[]) => shifts.reduce((sum, sh) => sum + sh.paidMinutes, 0);
  const list: SavedMonth[] = Object.entries(schedule.archive ?? {}).map(([key, a]) => ({
    key,
    year: Number(key.slice(0, 4)),
    month: Number(key.slice(5, 7)),
    shiftCount: a.shifts.length,
    totalMinutes: total(a.shifts),
    current: false,
    savedAt: a.savedAt,
  }));
  if (schedule.shifts.length > 0) {
    list.push({
      key: monthKey(schedule.year, schedule.month),
      year: schedule.year,
      month: schedule.month,
      shiftCount: schedule.shifts.length,
      totalMinutes: total(schedule.shifts),
      current: true,
    });
  }
  return list.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Gộp kho lưu của một bản khác (tab/máy khác, hoặc bản đang nằm trong
 * localStorage/Supabase) vào bản của mình: tháng nào mình chưa có thì giữ lại,
 * để một tab cũ không bao giờ xoá mất tháng đã lưu. Tháng đang mở của mình
 * không nằm trong kho; tháng đang mở của bản kia được cất vào kho nếu khác.
 * Trả về chính `mine` nếu không có gì mới.
 */
export function mergeArchives(mine: Schedule, other: Schedule | undefined | null): Schedule {
  if (!other) return mine;
  const openKey = monthKey(mine.year, mine.month);
  const archive = { ...(mine.archive ?? {}) };
  let changed = false;
  const add = (key: string, entry: MonthArchive) => {
    if (key === openKey || archive[key]) return;
    archive[key] = entry;
    changed = true;
  };
  for (const [key, entry] of Object.entries(other.archive ?? {})) add(key, entry);
  if (Array.isArray(other.shifts) && other.shifts.length > 0 && other.year && other.month) {
    add(monthKey(other.year, other.month), {
      shifts: other.shifts,
      originalShifts: [],
      savedAt: new Date().toISOString(),
    });
  }
  return changed ? { ...mine, archive } : mine;
}
