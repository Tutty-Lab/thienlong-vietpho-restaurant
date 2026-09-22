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

export type ThienlongStaffingProfile = {
  /** Soft lower bound used to spread visits across the day. */
  minStaff: number;
  /** Hard upper bound for people assigned to one date. */
  maxStaff: number;
  /** Preferred paid-hour band for a quiet day. */
  minHours: number;
  maxHours: number;
};

type ReferenceInterval = {
  startMinutes: number;
  endMinutes: number;
  /** Nur die Ist-Stunden der Beispielwoche, niemals ein fixes Soll. */
  personHours: number;
};

type ReferenceProfile = Record<WorkRole, readonly ReferenceInterval[]>;

export const THIENLONG_REFERENCE_INVOICES = 150;

const MEAL_PEAKS = [
  { startMinutes: 11 * 60 + 30, endMinutes: 14 * 60 + 30 },
  { startMinutes: 17 * 60 + 30, endMinutes: 20 * 60 + 30 },
] as const;

// Each meal window should absorb roughly 30% of the role's daily hours before
// quieter edges are preferred. This is a soft placement priority only.
const MEAL_PEAK_SHARE_OF_ROLE = 0.3;

const referenceInterval = (
  startMinutes: number,
  endMinutes: number,
  personHours: number,
): ReferenceInterval => ({
  startMinutes,
  endMinutes,
  personHours,
});

// Die Zahlen sind reine RELATIVE Gewichte (dimensionslos, werden zu Anteilen
// normiert). Sie bestimmen nur die FORM des Tages – wie viele echte Leute
// daraus werden, ergibt sich aus dem tatsächlichen Team und seinen Stunden.
//
// Mo–Do: 10:30 Öffnung braucht wenig Personal, am dichtesten 12:00–14:00 und
// 17:30–20:30, gegen 22:00 wieder dünn. Blocks: 10:30–15:00 + 16:30–22:00.
const WEEKDAY: ReferenceProfile = {
  KITCHEN: [
    referenceInterval(10 * 60 + 30, 11 * 60 + 30, 1), // Öffnung: dünn
    referenceInterval(11 * 60 + 30, 12 * 60, 1.5),
    referenceInterval(12 * 60, 14 * 60, 7), // Mittag: Spitze
    referenceInterval(14 * 60, 15 * 60, 2),
    referenceInterval(16 * 60 + 30, 17 * 60 + 30, 1.5), // früher Abend: dünn
    referenceInterval(17 * 60 + 30, 20 * 60 + 30, 9), // Abend: Spitze
    referenceInterval(20 * 60 + 30, 22 * 60, 2), // Schließung: dünn
  ],
  SERVICE: [
    referenceInterval(10 * 60 + 30, 11 * 60 + 30, 0.5),
    referenceInterval(11 * 60 + 30, 12 * 60, 1),
    referenceInterval(12 * 60, 14 * 60, 4),
    referenceInterval(14 * 60, 15 * 60, 1),
    referenceInterval(16 * 60 + 30, 17 * 60 + 30, 1),
    referenceInterval(17 * 60 + 30, 20 * 60 + 30, 5.5),
    referenceInterval(20 * 60 + 30, 22 * 60, 1),
  ],
};

// Freitag: tagsüber dünn, am dichtesten 17:30–21:00. Ein Block 10:30–22:00.
const FRIDAY: ReferenceProfile = {
  KITCHEN: [
    referenceInterval(10 * 60 + 30, 11 * 60 + 30, 1),
    referenceInterval(11 * 60 + 30, 14 * 60, 5),
    referenceInterval(14 * 60, 17 * 60 + 30, 3),
    referenceInterval(17 * 60 + 30, 21 * 60, 13), // Spitze
    referenceInterval(21 * 60, 22 * 60, 2),
  ],
  SERVICE: [
    referenceInterval(10 * 60 + 30, 11 * 60 + 30, 0.5),
    referenceInterval(11 * 60 + 30, 14 * 60, 3),
    referenceInterval(14 * 60, 17 * 60 + 30, 2),
    referenceInterval(17 * 60 + 30, 21 * 60, 7.5),
    referenceInterval(21 * 60, 22 * 60, 1),
  ],
};

// Sa/So: 11:30–12:00 dünn, 12:00–15:00 dicht, 17:30–20:00 dicht, gegen 22:00
// wieder dünn. Ein Block 11:30–22:00 (Personal ab 11:30).
const WEEKEND: ReferenceProfile = {
  KITCHEN: [
    referenceInterval(11 * 60 + 30, 12 * 60, 1),
    referenceInterval(12 * 60, 15 * 60, 10), // Mittag: dicht
    referenceInterval(15 * 60, 17 * 60 + 30, 3),
    referenceInterval(17 * 60 + 30, 20 * 60, 9), // Abend: dicht
    referenceInterval(20 * 60, 21 * 60, 2),
    referenceInterval(21 * 60, 22 * 60, 1), // Schließung: dünn
  ],
  SERVICE: [
    referenceInterval(11 * 60 + 30, 12 * 60, 0.5),
    referenceInterval(12 * 60, 15 * 60, 6),
    referenceInterval(15 * 60, 17 * 60 + 30, 2),
    referenceInterval(17 * 60 + 30, 20 * 60, 6),
    referenceInterval(20 * 60, 21 * 60, 1),
    referenceInterval(21 * 60, 22 * 60, 0.5),
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

export function thienlongMealPeakIntervals(): readonly {
  startMinutes: number;
  endMinutes: number;
}[] {
  return MEAL_PEAKS.map((peak) => ({ ...peak }));
}

/** Extra soft demand used to keep longer shifts around lunch and dinner. */
export function thienlongMealPeakDemand(
  weekday: WeekdayKey,
  role: WorkRole,
  totalTargetMinutes: number,
  isHoliday = false,
): readonly RoleDemandInterval[] {
  const roleMinutes =
    Math.max(0, totalTargetMinutes) * thienlongRoleShare(weekday, role, isHoliday);
  return MEAL_PEAKS.map((peak) => ({
    ...peak,
    personMinutes: roleMinutes * MEAL_PEAK_SHARE_OF_ROLE,
  }));
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

/** Mo-Do are the base; Friday/Saturday are busiest, Sunday is moderately busier. */
export function thienlongDemandWeight(weekday: WeekdayKey, isHoliday = false): number {
  if (isHoliday) return 1.35;
  if (weekday === "friday" || weekday === "saturday") return 1.35;
  if (weekday === "sunday") return 1.2;
  return 1;
}

/**
 * Personal-Bandbreite je Tag: nur noch relative KÖPFE-Grenzen zum Verteilen der
 * Besuche (Wochenende darf mehr Leute haben als ein ruhiger Wochentag). Es gibt
 * KEINE fest verdrahtete Stundenzahl mehr (früher 55–60 h Mo–Do) – die Stunden
 * ergeben sich rein proportional aus den Nachfrage-Gewichten und dem Team.
 */
export function thienlongStaffingProfile(
  weekday: WeekdayKey,
  isHoliday = false,
): ThienlongStaffingProfile {
  const band = { minHours: 0, maxHours: Number.POSITIVE_INFINITY };
  if (isHoliday || weekday === "friday" || weekday === "saturday") {
    return { minStaff: 7, maxStaff: 8, ...band };
  }
  if (weekday === "sunday") {
    return { minStaff: 6, maxStaff: 8, ...band };
  }
  return { minStaff: 6, maxStaff: 7, ...band };
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
