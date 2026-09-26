// ============================================================================
// Operationen für manuelles Bearbeiten von Schichten (immer neue Objekte,
// nie Mutation der Eingabe). Bezahlte Minuten werden automatisch neu berechnet.
// ============================================================================

import type { Shift, ShiftSegment } from "../types";
import { format } from "date-fns";
import { MONTH_NAMES_VI } from "./dateFormat";

let manualCounter = 0;
export function nextManualShiftId(): string {
  manualCounter += 1;
  return `manual-${Date.now()}-${manualCounter}`;
}

export function paidFromTimes(
  startMinutes: number,
  endMinutes: number,
  pauseMinutes: number,
): number {
  return endMinutes - startMinutes - pauseMinutes;
}

/**
 * Zeiten einer Schicht aus 1 oder 2 Stücken (ca gãy). Zwei Stücke => geteilter
 * Dienst: keine Pause (die Lücke ist die Ruhezeit), bezahlt = Summe der Stücke.
 */
export function shiftTimesFromPieces(
  pieces: readonly ShiftSegment[],
  pauseMinutes: number,
): Pick<Shift, "startMinutes" | "endMinutes" | "pauseMinutes" | "paidMinutes" | "segments"> {
  const sorted = [...pieces].sort((a, b) => a.startMinutes - b.startMinutes);
  if (sorted.length > 1) {
    return {
      startMinutes: sorted[0].startMinutes,
      endMinutes: sorted[sorted.length - 1].endMinutes,
      pauseMinutes: 0,
      paidMinutes: sorted.reduce((sum, g) => sum + g.endMinutes - g.startMinutes, 0),
      segments: sorted.map((g) => ({ ...g })),
    };
  }
  const [only] = sorted;
  return {
    startMinutes: only.startMinutes,
    endMinutes: only.endMinutes,
    pauseMinutes,
    paidMinutes: paidFromTimes(only.startMinutes, only.endMinutes, pauseMinutes),
    segments: undefined,
  };
}

/** Fehler in den Stücken (Ende vor Beginn, Überlappung) – oder null. */
export function piecesError(pieces: readonly ShiftSegment[]): string | null {
  for (const g of pieces) {
    if (g.endMinutes <= g.startMinutes) return "Giờ ra phải sau giờ vào.";
  }
  const sorted = [...pieces].sort((a, b) => a.startMinutes - b.startMinutes);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMinutes < sorted[i - 1].endMinutes) return "Ca 2 phải bắt đầu sau khi ca 1 kết thúc.";
  }
  return null;
}

/** Neue, manuell angelegte Schicht (1 Stück oder ca gãy mit 2 Stücken). */
export function createManualShift(
  employeeId: string,
  date: string,
  pieces: readonly ShiftSegment[],
  pauseMinutes: number,
): Shift {
  return {
    id: nextManualShiftId(),
    employeeId,
    date,
    ...shiftTimesFromPieces(pieces, pauseMinutes),
    shiftType: "CUSTOM",
    generated: false,
  };
}

/** Setzt die Stücke einer bestehenden Schicht neu (behält geteilte Dienste bei). */
export function updateShiftPieces(
  shift: Shift,
  pieces: readonly ShiftSegment[],
  pauseMinutes: number,
): Shift {
  return {
    ...shift,
    ...shiftTimesFromPieces(pieces, pauseMinutes),
    shiftType: "CUSTOM",
    generated: false,
  };
}

/** App-Oberfläche: vietnamesisch, z.B. "Tháng 8 2026". */
export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES_VI[month - 1]} / ${year}`;
}

export function isoLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return format(new Date(y, m - 1, d), "dd.MM.yyyy");
}
