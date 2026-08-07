import type { Shift, WorkRole } from "../types";
import type { WeekdayKey } from "./demand";

export type RoleDemandInterval = {
  startMinutes: number;
  endMinutes: number;
  /** Dynamisch aus dem Tages-Soll berechnete Personenminuten. */
  personMinutes: number;
};

export type RoleDemandShareInterval = {
  startMinutes: number;
  endMinutes: number;
  /** Anteil dieses Rollen-/Zeitblocks am gesamten Tages-Soll (0..1). */
  share: number;
};

type ReferenceInterval = {
  startMinutes: number;
  endMinutes: number;
  /** Nur die Ist-Stunden der Beispielwoche, niemals ein fixes Soll. */
  personHours: number;
};

type ReferenceProfile = Record<WorkRole, readonly ReferenceInterval[]>;

export const THIENLONG_REFERENCE_INVOICES = 150;

const referenceInterval = (
  startMinutes: number,
  endMinutes: number,
  personHours: number,
): ReferenceInterval => ({
  startMinutes,
  endMinutes,
  personHours,
});

const WEEKDAY: ReferenceProfile = {
  KITCHEN: [
    referenceInterval(10 * 60 + 30, 12 * 60, 3),
    referenceInterval(12 * 60, 14 * 60, 7),
    referenceInterval(14 * 60, 15 * 60, 2),
    referenceInterval(16 * 60 + 30, 18 * 60, 3),
    referenceInterval(18 * 60, 20 * 60, 7),
    referenceInterval(20 * 60, 22 * 60, 4),
  ],
  SERVICE: [
    referenceInterval(10 * 60 + 30, 12 * 60, 1.5),
    referenceInterval(12 * 60, 14 * 60, 4),
    referenceInterval(14 * 60, 15 * 60, 1),
    referenceInterval(16 * 60 + 30, 18 * 60, 3),
    referenceInterval(18 * 60, 20 * 60, 4),
    referenceInterval(20 * 60, 22 * 60, 2),
  ],
};

const FRIDAY: ReferenceProfile = {
  KITCHEN: [
    referenceInterval(10 * 60 + 30, 12 * 60, 3),
    referenceInterval(12 * 60, 21 * 60, 25),
    referenceInterval(21 * 60, 22 * 60, 3),
  ],
  SERVICE: [
    referenceInterval(10 * 60 + 30, 12 * 60, 1.5),
    referenceInterval(12 * 60, 15 * 60, 6),
    referenceInterval(15 * 60, 18 * 60, 3),
    referenceInterval(18 * 60, 21 * 60, 6),
    referenceInterval(21 * 60, 22 * 60, 1),
  ],
};

const WEEKEND: ReferenceProfile = {
  KITCHEN: [
    referenceInterval(11 * 60 + 30, 12 * 60, 1),
    referenceInterval(12 * 60, 21 * 60, 25),
    referenceInterval(21 * 60, 22 * 60, 2),
  ],
  SERVICE: [
    referenceInterval(10 * 60 + 30, 12 * 60, 1.5),
    referenceInterval(12 * 60, 15 * 60, 6),
    referenceInterval(15 * 60, 18 * 60, 3),
    referenceInterval(18 * 60, 21 * 60, 6),
    referenceInterval(21 * 60, 22 * 60, 1),
  ],
};

function referenceProfileOf(weekday: WeekdayKey, isHoliday: boolean): ReferenceProfile {
  if (isHoliday || weekday === "saturday" || weekday === "sunday") return WEEKEND;
  if (weekday === "friday") return FRIDAY;
  return WEEKDAY;
}

function referenceTotalHours(profile: ReferenceProfile): number {
  return (["KITCHEN", "SERVICE"] as const).reduce(
    (total, role) =>
      total + profile[role].reduce((roleTotal, item) => roleTotal + item.personHours, 0),
    0,
  );
}

/** Die Beispielwoche wird ausschließlich in dimensionslose Anteile umgerechnet. */
export function thienlongDemandShares(
  weekday: WeekdayKey,
  role: WorkRole,
  isHoliday = false,
): readonly RoleDemandShareInterval[] {
  const profile = referenceProfileOf(weekday, isHoliday);
  const totalHours = referenceTotalHours(profile);
  return profile[role].map((item) => ({
    startMinutes: item.startMinutes,
    endMinutes: item.endMinutes,
    share: totalHours > 0 ? item.personHours / totalHours : 0,
  }));
}

export function thienlongRoleShare(
  weekday: WeekdayKey,
  role: WorkRole,
  isHoliday = false,
): number {
  return thienlongDemandShares(weekday, role, isHoliday).reduce(
    (total, demand) => total + demand.share,
    0,
  );
}

/** Skaliert die aus der Beispielwoche abgeleiteten Anteile auf das Tages-Soll. */
export function thienlongDemandIntervals(
  weekday: WeekdayKey,
  role: WorkRole,
  totalTargetMinutes: number,
  isHoliday = false,
): readonly RoleDemandInterval[] {
  return thienlongDemandShares(weekday, role, isHoliday).map((item) => ({
    startMinutes: item.startMinutes,
    endMinutes: item.endMinutes,
    personMinutes: Math.max(0, totalTargetMinutes) * item.share,
  }));
}

/** Freitag und Samstag sind am stärksten; Sonntag liegt nur leicht über Mo-Do. */
export function thienlongDemandWeight(weekday: WeekdayKey, isHoliday = false): number {
  if (isHoliday) return 1.5;
  if (weekday === "friday" || weekday === "saturday") return 1.5;
  if (weekday === "sunday") return 1.1;
  return 1;
}

export function thienlongLateShiftRatio(weekday: WeekdayKey, isHoliday = false): number {
  if (isHoliday || weekday === "friday" || weekday === "saturday") return 0.78;
  if (weekday === "sunday") return 0.6;
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
