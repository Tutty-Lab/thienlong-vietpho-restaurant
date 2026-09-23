// ============================================================================
// Lưu lịch theo tháng: khi đổi tháng, lịch của tháng đang mở được cất vào
// archive, và lịch đã lưu của tháng đích (nếu có) được mở lại.
// ============================================================================

import type { Schedule, Shift } from "../types";

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
