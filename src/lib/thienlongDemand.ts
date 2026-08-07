import type { Shift, WorkRole } from "../types";
import type { WeekdayKey } from "./demand";

export type RoleDemandInterval = {
  startMinutes: number;
  endMinutes: number;
  /** Benötigte Personenminuten innerhalb des Intervalls. */
  personMinutes: number;
};

export const THIENLONG_REFERENCE_INVOICES = 150;

const interval = (
  startMinutes: number,
  endMinutes: number,
  personHours: number,
): RoleDemandInterval => ({
  startMinutes,
  endMinutes,
  personMinutes: personHours * 60,
});

const WEEKDAY: Record<WorkRole, readonly RoleDemandInterval[]> = {
  KITCHEN: [
    interval(10 * 60 + 30, 12 * 60, 3),
    interval(12 * 60, 14 * 60, 7),
    interval(14 * 60, 15 * 60, 2),
    interval(16 * 60 + 30, 18 * 60, 3),
    interval(18 * 60, 20 * 60, 7),
    interval(20 * 60, 22 * 60, 4),
  ],
  SERVICE: [
    interval(10 * 60 + 30, 12 * 60, 1.5),
    interval(12 * 60, 14 * 60, 4),
    interval(14 * 60, 15 * 60, 1),
    interval(16 * 60 + 30, 18 * 60, 3),
    interval(18 * 60, 20 * 60, 4),
    interval(20 * 60, 22 * 60, 2),
  ],
};

const FRIDAY: Record<WorkRole, readonly RoleDemandInterval[]> = {
  KITCHEN: [
    interval(10 * 60 + 30, 12 * 60, 3),
    interval(12 * 60, 21 * 60, 25),
    interval(21 * 60, 22 * 60, 3),
  ],
  SERVICE: [
    interval(10 * 60 + 30, 12 * 60, 1.5),
    interval(12 * 60, 15 * 60, 6),
    interval(15 * 60, 18 * 60, 3),
    interval(18 * 60, 21 * 60, 6),
    interval(21 * 60, 22 * 60, 1),
  ],
};

const WEEKEND: Record<WorkRole, readonly RoleDemandInterval[]> = {
  KITCHEN: [
    interval(11 * 60 + 30, 12 * 60, 1),
    interval(12 * 60, 21 * 60, 25),
    interval(21 * 60, 22 * 60, 2),
  ],
  SERVICE: [
    interval(10 * 60 + 30, 12 * 60, 1.5),
    interval(12 * 60, 15 * 60, 6),
    interval(15 * 60, 18 * 60, 3),
    interval(18 * 60, 21 * 60, 6),
    interval(21 * 60, 22 * 60, 1),
  ],
};

export function thienlongDemandIntervals(
  weekday: WeekdayKey,
  role: WorkRole,
  isHoliday = false,
): readonly RoleDemandInterval[] {
  if (isHoliday || weekday === "saturday" || weekday === "sunday") return WEEKEND[role];
  if (weekday === "friday") return FRIDAY[role];
  return WEEKDAY[role];
}

export function thienlongDemandHours(
  weekday: WeekdayKey,
  role: WorkRole,
  isHoliday = false,
): number {
  return thienlongDemandIntervals(weekday, role, isHoliday).reduce(
    (total, demand) => total + demand.personMinutes,
    0,
  ) / 60;
}

/** Freitag und Samstag sind gleich stark; Sonntag bleibt bewusst darunter. */
export function thienlongDemandWeight(weekday: WeekdayKey, isHoliday = false): number {
  if (isHoliday) return 1.5;
  if (weekday === "friday" || weekday === "saturday") return 1.5;
  if (weekday === "sunday") return 1.3;
  return 1;
}

export function thienlongLateShiftRatio(weekday: WeekdayKey, isHoliday = false): number {
  if (isHoliday || weekday === "friday" || weekday === "saturday") return 0.78;
  if (weekday === "sunday") return 0.68;
  return 23 / 41.5;
}

function overlapMinutes(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

/** Beschränkt ein Nachfrageprofil auf die tatsächlich planbaren Tagesblöcke. */
export function clipDemandIntervals(
  demandIntervals: readonly RoleDemandInterval[],
  blocks: readonly { startMinutes: number; endMinutes: number }[],
): RoleDemandInterval[] {
  return demandIntervals.flatMap((demand) => {
    const duration = demand.endMinutes - demand.startMinutes;
    if (duration <= 0) return [];
    return blocks.flatMap((block) => {
      const startMinutes = Math.max(demand.startMinutes, block.startMinutes);
      const endMinutes = Math.min(demand.endMinutes, block.endMinutes);
      if (endMinutes <= startMinutes) return [];
      return [{
        startMinutes,
        endMinutes,
        personMinutes: demand.personMinutes * ((endMinutes - startMinutes) / duration),
      }];
    });
  });
}

function shiftOverlapWithInterval(shift: Shift, demand: RoleDemandInterval): number {
  const segments = shift.segments ?? [
    { startMinutes: shift.startMinutes, endMinutes: shift.endMinutes },
  ];
  const presenceMinutes = segments.reduce(
    (total, segment) => total + segment.endMinutes - segment.startMinutes,
    0,
  );
  if (presenceMinutes <= 0) return 0;

  const presenceOverlap = segments.reduce(
    (total, segment) =>
      total +
      overlapMinutes(
        segment.startMinutes,
        segment.endMinutes,
        demand.startMinutes,
        demand.endMinutes,
      ),
    0,
  );

  // Durchgehende lange Dienste enthalten eine nicht lokalisierte Pause. Sie
  // wird proportional abgezogen, damit eine 8h-Schicht nicht 9h Bedarf deckt.
  return presenceOverlap * Math.min(1, shift.paidMinutes / presenceMinutes);
}

/** Zusätzliche ungedeckte Personenminuten, die eine Kandidatenschicht füllt. */
export function demandCoverageGain(
  candidate: Shift,
  existingRoleShifts: readonly Shift[],
  demandIntervals: readonly RoleDemandInterval[],
): number {
  return demandIntervals.reduce((total, demand) => {
    const covered = existingRoleShifts.reduce(
      (sum, shift) => sum + shiftOverlapWithInterval(shift, demand),
      0,
    );
    const uncovered = Math.max(0, demand.personMinutes - covered);
    return total + Math.min(uncovered, shiftOverlapWithInterval(candidate, demand));
  }, 0);
}

/** Tatsächlich gedeckte Personenminuten, gedeckelt auf den Sollwert je Intervall. */
export function demandCoveredMinutes(
  roleShifts: readonly Shift[],
  demandIntervals: readonly RoleDemandInterval[],
): number {
  return demandIntervals.reduce((total, demand) => {
    const covered = roleShifts.reduce(
      (sum, shift) => sum + shiftOverlapWithInterval(shift, demand),
      0,
    );
    return total + Math.min(demand.personMinutes, covered);
  }, 0);
}

/** Noch ungedeckte Personenminuten eines Rollenprofils. */
export function demandCoverageGap(
  roleShifts: readonly Shift[],
  demandIntervals: readonly RoleDemandInterval[],
): number {
  return demandIntervals.reduce((total, demand) => {
    const covered = roleShifts.reduce(
      (sum, shift) => sum + shiftOverlapWithInterval(shift, demand),
      0,
    );
    return total + Math.max(0, demand.personMinutes - covered);
  }, 0);
}
