// ============================================================================
// Buổi trưa / buổi tối của một ca – dùng chung cho nhãn thẻ và bảng thống kê.
// Ai có mặt ít nhất 1 tiếng trong buổi đó thì được tính là làm buổi đó
// (vd. 17:30–20:30, 19:30–22:00 hay 16:30–18:30 đều là ca tối; ca tách đôi
// tính cả hai buổi; ca liền 11:30–17:30 chỉ là ca trưa).
// ============================================================================

import type { Shift } from "../types";

/** Buổi trưa kết thúc lúc 15:00 (T2–T5 quán đóng cửa giữa trưa). */
export const LUNCH_END_MINUTES = 15 * 60;
/** Buổi tối bắt đầu lúc 17:00. */
export const DINNER_START_MINUTES = 17 * 60;

/** Có mặt tối thiểu bấy nhiêu phút trong buổi thì mới tính. */
const MIN_PRESENCE_MINUTES = 60;

function segmentsOf(shift: Shift) {
  return shift.segments ?? [{ startMinutes: shift.startMinutes, endMinutes: shift.endMinutes }];
}

function minutesWithin(shift: Shift, from: number, to: number): number {
  return segmentsOf(shift).reduce(
    (sum, g) => sum + Math.max(0, Math.min(g.endMinutes, to) - Math.max(g.startMinutes, from)),
    0,
  );
}

export function worksLunch(shift: Shift): boolean {
  return minutesWithin(shift, 0, LUNCH_END_MINUTES) >= MIN_PRESENCE_MINUTES;
}

export function worksDinner(shift: Shift): boolean {
  return minutesWithin(shift, DINNER_START_MINUTES, 24 * 60) >= MIN_PRESENCE_MINUTES;
}

/** „Ca trưa" / „Ca tối" / „Trưa + tối". */
export function mealLabel(shift: Shift): string {
  const lunch = worksLunch(shift);
  const dinner = worksDinner(shift);
  if (lunch && dinner) return "Trưa + tối";
  return lunch ? "Ca trưa" : "Ca tối";
}
