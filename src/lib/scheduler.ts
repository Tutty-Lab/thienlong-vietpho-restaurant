// ============================================================================
// Deterministischer, greedy Scheduler (kein Solver, kein KI-Modell).
//
// Vorgehen:
//  1. Alle Tage des Monats + Nachfrage-Gewichte -> rohes Tages-Soll (Minuten).
//  2. Sollstunden jedes Mitarbeiters in Schicht-Token zerlegen.
//  3. Token rundenweise (rotierend) verteilen; große Vollzeit-Schichten zuerst.
//  4. Für jedes Token die beste Kalender-Datum wählen (Score + harte Regeln).
//  5. Früh/Spät anhand der gewünschten Spätschicht-Quote wählen.
//  6. Reparaturlauf: Schichten zwischen Tagen verschieben, um die Tages-
//     nachfrage besser zu treffen (Sollstunden bleiben exakt erhalten).
//
// Harte Regeln, die IMMER eingehalten werden:
//  - genau ein Dienst pro Mitarbeiter und Tag
//  - höchstens 6 aufeinanderfolgende Arbeitstage
//  - Token-Dauer wird nie verändert  => monatliches Soll bleibt exakt
// ============================================================================

import {
  AZUBI_HOURS_OUT_OF_TERM,
  AZUBI_WEEKLY_TARGET_FLEX_HOURS,
  type Employee,
  type Shift,
  type ShiftSegment,
  type WorkRole,
} from "../types";
import { isEmployeeFixedDayOff } from "./fixedDaysOff";
import { TEILZEIT_SHIFT_HOURS, teilzeitShiftCount } from "./splitTargetHours";
import {
  DAY_WEIGHTS,
  LATE_SHIFT_RATIOS,
  datesOfMonth,
  parseIsoDate,
  weekdayKeyOf,
  type WeekdayKey,
} from "./demand";
import {
  buildSplitShift,
  getShiftTemplateForBlocks,
  MIN_SPLIT_SEGMENT_MINUTES,
  type TemplateType,
} from "./shifts";
import { consecutiveRunLengthWith, seededRandom } from "./consecutive";
import { calculatePause, presenceFromPaid } from "./time";
import {
  effectiveWeekdayKey,
  resolveDay,
  longestBlockMinutes,
  type ResolvedDay,
  type OverrideMap,
  type WorkHoursConfig,
} from "./workHours";
import { holidaysOf, type HolidayState } from "./holidays";
import {
  clipDemandIntervals,
  demandCoverageGain,
  demandCoverageGap,
  thienlongDemandIntervals,
  thienlongDemandWeight,
  thienlongLateShiftRatio,
  thienlongMealPeakDemand,
  thienlongMealPeakIntervals,
  thienlongStaffingProfile,
} from "./thienlongDemand";
import {
  vietphoDemandIntervals,
  vietphoDemandWeight,
  vietphoLateShiftRatio,
  vietphoPeakIntervals,
} from "./vietphoDemand";

export type GenerateInput = {
  year: number;
  month: number; // 1-basiert
  /** Arbeitszeit-Fenster je Wochentag + Feiertag. */
  workHours: WorkHoursConfig;
  /** Ausnahmen für einzelne Daten (geschlossen / abweichende Zeiten). */
  overrides?: OverrideMap;
  employees: Employee[];
  /** Filialschlüssel; aktiviert ausschließlich das passende Nachfrageprofil. */
  storeId?: string;
  /** Feiertage als ISO-Set; sonst aus holidayState berechnet. */
  holidays?: Set<string>;
  /** Bundesland für die Feiertage (Standard: Baden-Württemberg). */
  holidayState?: HolidayState;
  /** Optionaler Seed; sonst aus Eingabedaten abgeleitet. */
  seed?: string;
};

type DateState = {
  totalPaid: number;
  latePaid: number;
  count: number;
};

type SchedulerState = {
  dates: string[];
  rawTarget: Map<string, number>; // ISO -> rohes Tages-Soll in Minuten
  dateState: Map<string, DateState>;
  worked: Map<string, Set<string>>; // employeeId -> Set<ISO>
  weekendCount: Map<string, number>; // employeeId -> Anzahl Fr/Sa-Schichten
  /** employeeId -> Wochenschlüssel -> bereits verplante Minuten (Azubi-Decke). */
  weekMinutes: Map<string, Map<string, number>>;
  remaining: Map<string, number>; // employeeId -> noch zu verplanende Minuten
  shifts: Shift[];
  /** Für Nachfrage/Spätquote maßgeblicher Wochentag (Feiertag = Sonntag). */
  effKeyOf: (isoDate: string) => WeekdayKey;
  /** Filialspezifische Spätquote für dieses konkrete Datum. */
  lateRatioOf: (isoDate: string) => number;
  holidays: Set<string>;
  employeesById: Map<string, Employee>;
  isThienlong: boolean;
  isVietpho: boolean;
  /** Current workforce has enough monthly hours for the 6-7 / 7-8 staffing bands. */
  useThienlongStaffingBands: boolean;
  /** Current workforce has enough visits to keep the requested headcount floor. */
  useThienlongStaffingCounts: boolean;
  /** Aufgelöster Tag (geschlossen? + Arbeitszeit-Fenster) für ein Datum. */
  dayOf: (isoDate: string) => ResolvedDay;
  rng: () => number;
  /** true = Schichtlängen mischen; false = immer die längste (Rückfallmodus). */
  varyLengths: boolean;
  /** Thienlong: Tages-Soll je Rolle (Bếp/Bồi), damit die Rollen gleichmäßig verteilt werden. */
  roleTarget: Map<WorkRole, Map<string, number>>;
  /** Geplante Schichtzahl je Mitarbeiter (null = frei nach Nachfrage). */
  plannedShifts: Map<string, number | null>;
  /** Zusätzliche Köpfe über maxStaff, wenn das Team mehr Einsätze braucht. */
  extraStaff: number;
  /**
   * Mitarbeiter, die JEDEN erlaubten Tag arbeiten müssen (z.B. 6 Tage/Woche
   * bei einem festen Ruhetag). Für sie werden Plätze je Tag freigehalten.
   */
  rigid: Set<string>;
  /**
   * Tempo-Gewicht je Rolle und Tag = Rollen-Soll des Tages / Köpfe dieser
   * Rolle, die an dem Tag überhaupt arbeiten dürfen. Ein Tag mit wenig
   * verfügbaren Leuten (z.B. Sonntag, wenn mehrere fest frei haben) bekommt so
   * längere Schichten statt weniger Stunden.
   */
  paceWeight: Map<WorkRole, Map<string, number>>;
};

/**
 * Tages-Soll rein PROPORTIONAL zu den Nachfrage-Gewichten (Mo–Do 1,0;
 * Fr/Sa 1,35; So 1,1). Dadurch bekommt jeder Wochenendtag mehr Stunden als ein
 * ruhiger Wochentag – unabhängig von der Teamgröße. Es gibt KEINE fest
 * verdrahtete Stundenzahl je Tag (früher 55–60 h für Mo–Do); das hatte bei
 * größeren Teams die Wochenenden künstlich eingeebnet, weil die vielen
 * Wochentage die Stunden vorab „reserviert" haben.
 */
function buildThienlongRawTargets(
  dates: readonly string[],
  totalTargetMinutes: number,
  weightOf: (isoDate: string) => number,
): Map<string, number> {
  const weightedTotal = dates.reduce((sum, date) => sum + weightOf(date), 0);
  return new Map<string, number>(
    dates.map((date) => [
      date,
      weightedTotal > 0 ? (totalTargetMinutes * weightOf(date)) / weightedTotal : 0,
    ]),
  );
}

let shiftIdCounter = 0;
function nextShiftId(): string {
  shiftIdCounter += 1;
  return `gen-${shiftIdCounter}`;
}

function isWeekend(isoDate: string): boolean {
  const key = weekdayKeyOf(parseIsoDate(isoDate));
  return key === "friday" || key === "saturday";
}

/** Montag der Woche, in der das Datum liegt – Schlüssel für die Wochendecke. */
function weekKeyOf(isoDate: string): string {
  const d = parseIsoDate(isoDate);
  const back = (d.getDay() + 6) % 7; // 0 = Montag
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Wochendecke in Minuten – nur Azubis haben eine. */
function weeklyCapMinutes(employee: Employee): number | null {
  if (employee.employmentType !== "AZUBI") return null;
  return Math.round(AZUBI_HOURS_OUT_OF_TERM * 60);
}

// Halbe Stunden sind erlaubt, seit die gerechnete Pause weg ist: der
// Abendblock Mo–Do ist 5,5 h lang und darf jetzt exakt ausgefüllt werden.
// Vorher wurde auf 5 h abgerundet und jeden Abend eine halbe Stunde verschenkt.
/** Obergrenze pro Tag. ArbZG §3 erlaubt bis 10 h, das deckt sich mit den
 *  handgeschriebenen Plänen (dort kommen 9,5 und 10 h vor). */
export const MAX_DAILY_MINUTES = 10 * 60;

const SHIFT_HOURS_DESC = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5, 3] as const;

/**
 * Erlaubte Schichtlängen je Anstellungsart. Reguläre Azubi-Schichten starten
 * bei 3 h; nur ein gesamtes Monatssoll unter 3 h bleibt als kurze Einzelca.
 */
const ALLOWED_HOURS: Record<Employee["employmentType"], readonly number[]> = {
  VOLLZEIT: [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10],
  TEILZEIT: [3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10],
  AZUBI: [3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10],
};

/** Alle überhaupt zulässigen Längen – Rückfall, wenn das Fenster eng ist. */
const ALL_HOURS: readonly number[] = [3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

const VIETPHO_ALLOWED_HOURS: Record<Employee["employmentType"], readonly number[]> = {
  VOLLZEIT: [4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8],
  TEILZEIT: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8],
  AZUBI: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8],
};
const VIETPHO_ALL_HOURS = VIETPHO_ALLOWED_HOURS.TEILZEIT;

/**
 * Lässt sich `hours` restlos in Schichten aus `allowed` zerlegen?
 * Nötig, weil z.B. 11 h mit nur 6/7/8-h-Schichten nicht aufgeht – ohne diese
 * Prüfung liefe der Scheduler in eine Sackgasse und das Soll bliebe offen.
 */
const decomposeCache = new WeakMap<readonly number[], Map<number, boolean>>();
function canDecompose(hours: number, allowed: readonly number[]): boolean {
  if (hours === 0) return true;
  if (hours < Math.min(...allowed)) return false;

  let byHours = decomposeCache.get(allowed);
  if (!byHours) {
    byHours = new Map<number, boolean>();
    decomposeCache.set(allowed, byHours);
  }
  const cached = byHours.get(hours);
  if (cached !== undefined) return cached;

  let ok = false;
  for (const h of allowed) {
    if (canDecompose(hours - h, allowed)) {
      ok = true;
      break;
    }
  }
  byHours.set(hours, ok);
  return ok;
}

/** Größte Schichtlänge (Stunden), deren Anwesenheit noch ins Fenster passt (0 = keine). */
export function maxShiftHoursForWindow(windowMinutes: number): number {
  for (const hours of SHIFT_HOURS_DESC) {
    if (presenceFromPaid(hours * 60) <= windowMinutes) return hours;
  }
  return 0;
}

/**
 * Wählt die Länge (Stunden) der nächsten Schicht eines Mitarbeiters so, dass
 * - sie für die Anstellungsart zulässig ist und ins Tagesfenster passt,
 * - der verbleibende Rest mit denselben Längen exakt aufteilbar bleibt,
 * - Vollzeit möglichst lange, Teilzeit eher kürzere Schichten bekommt.
 * Gibt 0 zurück, wenn an diesem Tag keine gültige Länge möglich ist.
 *
 * Dadurch arbeiten auch Vollzeit-Kräfte an einem „halben Tag" – nur mit einer
 * kürzeren Schicht – und das Monats-Soll bleibt trotzdem exakt.
 */
export function chooseShiftHours(
  remainingMinutes: number,
  maxHours: number,
  employmentType: Employee["employmentType"],
  /** Mindestlänge, um das Soll bis Monatsende noch zu schaffen (Stunden). */
  needHours = 8,
  /** Ohne Zufallsquelle wird deterministisch die kürzeste taugliche gewählt. */
  rng?: () => number,
  profile: "default" | "thienlong" | "vietpho" = "default",
): number {
  const remainingHours = remainingMinutes / 60;
  const allowedByType = profile === "vietpho" ? VIETPHO_ALLOWED_HOURS : ALLOWED_HOURS;
  const allHours = profile === "vietpho" ? VIETPHO_ALL_HOURS : ALL_HOURS;
  const dailyCapHours = profile === "vietpho" ? 8 : MAX_DAILY_MINUTES / 60;
  const cap = Math.min(dailyCapHours, maxHours, remainingHours);
  const employeeMinimum = Math.min(...allowedByType[employmentType]);
  if (employmentType === "AZUBI" && remainingHours < employeeMinimum) {
    return cap >= remainingHours ? remainingHours : 0;
  }
  const minimum =
    employmentType === "AZUBI"
      ? employeeMinimum
      : Math.min(...allHours);
  if (cap < minimum) return 0;

  // Erlaubte Längen je Anstellungsart (Vorgabe des Chefs): Vollzeit macht keine
  // Kurzschichten, Teilzeit darf die ganze Bandbreite.
  const pick = (allowed: readonly number[]): number[] => {
    const out: number[] = [];
    for (const hours of allowed) {
      if (hours > cap) continue;
      // Der Rest muss mit denselben Längen restlos aufgehen. Bei Vollzeit
      // (6/7/8) sind z.B. 9, 10, 11 oder 17 Stunden Sackgassen.
      if (canDecompose(remainingHours - hours, allowed)) out.push(hours);
    }
    return out;
  };

  // Erst die für die Anstellungsart vorgesehenen Längen. Geht dort nichts –
  // etwa an einem halben Tag, an dem keine 6-h-Schicht mehr hineinpasst –
  // greift die volle Bandbreite, damit auch Vollzeit an dem Tag arbeiten kann.
  let valid = pick(allowedByType[employmentType]);
  if (valid.length === 0 && employmentType !== "AZUBI") valid = pick(allHours);
  if (valid.length === 0) return 0;

  // Früher entschied eine feste Rangliste (Vollzeit 8, Teilzeit 5). Ergebnis:
  // jede Vollzeitschicht war 8 h, jede Teilzeitschicht 5 h – keinerlei
  // Abwechslung, und Teilzeit war faktisch auf 5 h/Tag gedeckelt.
  //
  // Jetzt: unter allen Längen zufällig wählen, aber nur solche, die das Tempo
  // halten. Wer noch viel Soll und wenig Tage hat, bekommt zwangsläufig lange
  // Schichten; wer gut liegt, bekommt Abwechslung.
  const onPace = valid.filter((h) => h >= needHours);
  const pool = onPace.length > 0 ? onPace : [valid[valid.length - 1]];

  if (profile === "vietpho" && employmentType !== "VOLLZEIT") {
    const shortestOnPace = pool[0];
    const shortPool = pool.filter((hours) => hours <= shortestOnPace + 0.5);
    if (!rng) return shortPool[0];
    return shortPool[Math.floor(rng() * shortPool.length)];
  }

  if (!rng) {
    return profile === "thienlong"
      ? pool[Math.max(0, pool.length - 2)]
      : pool[pool.length - 1];
  }

  // „Bester von zwei Würfen": erzeugt Abwechslung, gewichtet aber zugunsten
  // längerer Schichten. Rein gleichverteilt würden zu viele kurze Schichten
  // fallen und die verfügbaren Tage wären vor Monatsende aufgebraucht.
  const a = pool[Math.floor(rng() * pool.length)];
  const b = pool[Math.floor(rng() * pool.length)];
  return Math.max(a, b);
}

/** Stabile Basisordnung: Vollzeit zuerst, dann nach Id. */
function orderedEmployees(employees: Employee[]): Employee[] {
  return [...employees].sort((a, b) => {
    const aFullTime = a.employmentType === "VOLLZEIT";
    const bFullTime = b.employmentType === "VOLLZEIT";
    if (aFullTime !== bFullTime) return aFullTime ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

function chooseTemplateType(
  state: SchedulerState,
  isoDate: string,
  employmentType: Employee["employmentType"],
): TemplateType {
  const ds = state.dateState.get(isoDate)!;
  const desired = state.lateRatioOf(isoDate);
  const currentLateRatio = ds.totalPaid > 0 ? ds.latePaid / ds.totalPaid : 0;

  // Teilzeit tendenziell in Spätschichten. Früher wurde sonntags zusätzlich
  // auf 0,95 hochgezwungen – damit stand am Sonntag praktisch niemand zur
  // Öffnung um 11:00 im Laden. Jetzt gilt die konfigurierte Quote.
  let threshold = desired;
  if (employmentType === "TEILZEIT") threshold += 0.15;

  return currentLateRatio < threshold ? "LATE" : "EARLY";
}

function makeShift(
  state: SchedulerState,
  employee: Employee,
  isoDate: string,
  paidMinutes: number,
  typeOverride?: TemplateType,
): Shift {
  const type = typeOverride ?? chooseTemplateType(state, isoDate, employee.employmentType);
  const blocks = state.dayOf(isoDate).blocks;

  const presence = presenceFromPaid(paidMinutes);
  const fitsFirstBlock = blocks[0].endMinutes - blocks[0].startMinutes >= presence;

  // Early shifts that do not fit in the opening block are split even if they
  // would fit in the evening. This keeps them anchored to opening time.
  if (!fitsSingleBlock(paidMinutes, blocks) || (type === "EARLY" && !fitsFirstBlock)) {
    const split = buildSplitShift(paidMinutes, type, blocks);
    if (split) {
      return {
        id: nextShiftId(),
        employeeId: employee.id,
        date: isoDate,
        startMinutes: split.segments[0].startMinutes,
        endMinutes: split.segments[split.segments.length - 1].endMinutes,
        pauseMinutes: 0,
        segments: split.segments,
        paidMinutes: split.paidMinutes,
        shiftType: type,
        generated: true,
      };
    }
  }

  const tpl = getShiftTemplateForBlocks(paidMinutes / 60, type, blocks);
  return {
    id: nextShiftId(),
    employeeId: employee.id,
    date: isoDate,
    startMinutes: tpl.startMinutes,
    endMinutes: tpl.endMinutes,
    pauseMinutes: tpl.pauseMinutes,
    paidMinutes: tpl.paidMinutes,
    shiftType: tpl.type,
    generated: true,
  };
}

function roleDemandOf(state: SchedulerState, employee: Employee, isoDate: string) {
  if (!state.isThienlong || !employee.workRole) {
    return null;
  }
  return clipDemandIntervals(
    thienlongDemandIntervals(
      weekdayKeyOf(parseIsoDate(isoDate)),
      employee.workRole,
      state.rawTarget.get(isoDate) ?? 0,
      state.holidays.has(isoDate),
    ),
    state.dayOf(isoDate).blocks,
  );
}

function thienlongPeakDemandOf(
  state: SchedulerState,
  employee: Employee,
  isoDate: string,
) {
  if (!state.isThienlong || !employee.workRole) return [];
  return clipDemandIntervals(
    thienlongMealPeakDemand(
      weekdayKeyOf(parseIsoDate(isoDate)),
      employee.workRole,
      state.rawTarget.get(isoDate) ?? 0,
      state.holidays.has(isoDate),
    ),
    state.dayOf(isoDate).blocks,
  );
}

function roleShiftsOnDate(
  state: SchedulerState,
  employee: Employee,
  isoDate: string,
): Shift[] {
  if (!employee.workRole) return [];
  return state.shifts.filter(
    (shift) =>
      shift.date === isoDate &&
      state.employeesById.get(shift.employeeId)?.workRole === employee.workRole,
  );
}

function vietphoDemandOf(state: SchedulerState, isoDate: string) {
  if (!state.isVietpho) return null;
  return clipDemandIntervals(
    vietphoDemandIntervals(
      weekdayKeyOf(parseIsoDate(isoDate)),
      state.rawTarget.get(isoDate) ?? 0,
      state.holidays.has(isoDate),
    ),
    state.dayOf(isoDate).blocks,
  );
}

function vietphoShiftsOnDate(state: SchedulerState, isoDate: string): Shift[] {
  return state.shifts.filter((shift) => shift.date === isoDate);
}

function vietphoPeakDemand(state: SchedulerState, isoDate: string) {
  const blocks = state.dayOf(isoDate).blocks;
  return vietphoPeakIntervals()
    .filter((peak) =>
      blocks.some(
        (block) =>
          block.startMinutes <= peak.startMinutes && block.endMinutes >= peak.endMinutes,
      ),
    )
    .map((peak) => ({
      startMinutes: peak.startMinutes,
      endMinutes: peak.endMinutes,
      personMinutes: (peak.endMinutes - peak.startMinutes) * peak.minStaff,
    }));
}

function customContinuousShift(
  employee: Employee,
  isoDate: string,
  paidMinutes: number,
  startMinutes: number,
): Shift {
  const pauseMinutes = calculatePause(paidMinutes);
  return {
    id: nextShiftId(),
    employeeId: employee.id,
    date: isoDate,
    startMinutes,
    endMinutes: startMinutes + paidMinutes + pauseMinutes,
    pauseMinutes,
    paidMinutes,
    shiftType: "CUSTOM",
    generated: true,
  };
}

function startsAroundInterval(
  block: { startMinutes: number; endMinutes: number },
  interval: { startMinutes: number; endMinutes: number },
  duration: number,
): number[] {
  const centered = Math.round(
    ((interval.startMinutes + interval.endMinutes - duration) / 2) / 30,
  ) * 30;
  return [
    interval.startMinutes,
    interval.endMinutes - duration,
    centered,
  ].map((start) =>
    Math.max(block.startMinutes, Math.min(start, block.endMinutes - duration)),
  );
}

function customSplitShift(
  employee: Employee,
  isoDate: string,
  paidMinutes: number,
  lunchStart: number,
  lunchMinutes: number,
  eveningStart: number,
): Shift {
  const eveningMinutes = paidMinutes - lunchMinutes;
  const segments = [
    { startMinutes: lunchStart, endMinutes: lunchStart + lunchMinutes },
    { startMinutes: eveningStart, endMinutes: eveningStart + eveningMinutes },
  ];
  return {
    id: nextShiftId(),
    employeeId: employee.id,
    date: isoDate,
    startMinutes: segments[0].startMinutes,
    endMinutes: segments[1].endMinutes,
    pauseMinutes: 0,
    segments,
    paidMinutes,
    shiftType: "CUSTOM",
    generated: true,
  };
}

function thienlongCandidates(
  state: SchedulerState,
  employee: Employee,
  isoDate: string,
  paidMinutes: number,
): Shift[] {
  const blocks = state.dayOf(isoDate).blocks;
  const preferredType = chooseTemplateType(state, isoDate, employee.employmentType);
  const candidates = [
    makeShift(state, employee, isoDate, paidMinutes, preferredType),
    makeShift(
      state,
      employee,
      isoDate,
      paidMinutes,
      preferredType === "EARLY" ? "LATE" : "EARLY",
    ),
  ];
  const peaks = thienlongMealPeakIntervals();
  const presence = presenceFromPaid(paidMinutes);

  for (const block of blocks) {
    if (presence > block.endMinutes - block.startMinutes) continue;
    const starts = [
      block.startMinutes,
      block.endMinutes - presence,
      ...peaks.flatMap((peak) => startsAroundInterval(block, peak, presence)),
    ];
    for (const startMinutes of starts) {
      if (startMinutes < block.startMinutes || startMinutes + presence > block.endMinutes) continue;
      candidates.push(customContinuousShift(employee, isoDate, paidMinutes, startMinutes));
    }
  }

  if (blocks.length >= 2) {
    const lunch = blocks[0];
    const evening = blocks[blocks.length - 1];
    const lunchPeak = peaks[0];
    const eveningPeak = peaks[1];
    const lunchCap = lunch.endMinutes - lunch.startMinutes;
    const eveningCap = evening.endMinutes - evening.startMinutes;
    const minimumLunch = Math.max(MIN_SPLIT_SEGMENT_MINUTES, paidMinutes - eveningCap);
    const maximumLunch = Math.min(lunchCap, paidMinutes - MIN_SPLIT_SEGMENT_MINUTES);

    for (let lunchMinutes = minimumLunch; lunchMinutes <= maximumLunch; lunchMinutes += 30) {
      const eveningMinutes = paidMinutes - lunchMinutes;
      for (const lunchStart of startsAroundInterval(lunch, lunchPeak, lunchMinutes)) {
        for (const eveningStart of startsAroundInterval(
          evening,
          eveningPeak,
          eveningMinutes,
        )) {
          candidates.push(
            customSplitShift(
              employee,
              isoDate,
              paidMinutes,
              lunchStart,
              lunchMinutes,
              eveningStart,
            ),
          );
        }
      }
    }
  }

  const unique = new Map<string, Shift>();
  for (const candidate of candidates) {
    const key = (candidate.segments ?? [candidate])
      .map((segment) => `${segment.startMinutes}-${segment.endMinutes}`)
      .join("|");
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

function customVietphoSplitShift(
  employee: Employee,
  isoDate: string,
  paidMinutes: number,
  blocks: ResolvedDay["blocks"],
): Shift | null {
  if (paidMinutes < 2.5 * 60) return null;
  const lunchPeak = { startMinutes: 12 * 60 + 30, endMinutes: 13 * 60 };
  const eveningPeak = { startMinutes: 18 * 60, endMinutes: 20 * 60 };
  const lunchIndex = blocks.findIndex(
    (block) =>
      block.startMinutes <= lunchPeak.startMinutes && block.endMinutes >= lunchPeak.endMinutes,
  );
  const eveningIndex = blocks.findIndex(
    (block) =>
      block.startMinutes <= eveningPeak.startMinutes && block.endMinutes >= eveningPeak.endMinutes,
  );
  if (lunchIndex < 0 || eveningIndex < 0) return null;

  const lunch = blocks[lunchIndex];
  const evening = blocks[eveningIndex];

  const lunchCap = lunch.endMinutes - lunch.startMinutes;
  const sameBlock = lunchIndex === eveningIndex;
  const eveningCap =
    evening.endMinutes - (sameBlock ? lunchPeak.endMinutes : evening.startMinutes);
  const minimumLunchMinutes = lunchPeak.endMinutes - lunchPeak.startMinutes;
  const minimumEveningMinutes = eveningPeak.endMinutes - eveningPeak.startMinutes;
  const eveningMinutes = Math.min(paidMinutes - minimumLunchMinutes, eveningCap);
  const lunchMinutes = paidMinutes - eveningMinutes;
  if (
    lunchMinutes < minimumLunchMinutes ||
    lunchMinutes > lunchCap ||
    eveningMinutes < minimumEveningMinutes
  ) {
    return null;
  }

  let lunchStart = Math.max(lunch.startMinutes, lunchPeak.endMinutes - lunchMinutes);
  if (lunchStart + lunchMinutes > lunch.endMinutes) {
    lunchStart = lunch.endMinutes - lunchMinutes;
  }
  const eveningStart = Math.max(
    evening.startMinutes,
    Math.min(eveningPeak.startMinutes, evening.endMinutes - eveningMinutes),
  );
  const segments = [
    { startMinutes: lunchStart, endMinutes: lunchStart + lunchMinutes },
    { startMinutes: eveningStart, endMinutes: eveningStart + eveningMinutes },
  ];
  if (
    segments[0].startMinutes > lunchPeak.startMinutes ||
    segments[0].endMinutes < lunchPeak.endMinutes ||
    segments[1].startMinutes > eveningPeak.startMinutes ||
    segments[1].endMinutes < eveningPeak.endMinutes ||
    segments[0].endMinutes > segments[1].startMinutes
  ) {
    return null;
  }

  return {
    id: nextShiftId(),
    employeeId: employee.id,
    date: isoDate,
    startMinutes: segments[0].startMinutes,
    endMinutes: segments[1].endMinutes,
    pauseMinutes: 0,
    segments,
    paidMinutes,
    shiftType: "CUSTOM",
    generated: true,
  };
}

function vietphoCandidates(
  state: SchedulerState,
  employee: Employee,
  isoDate: string,
  paidMinutes: number,
): Shift[] {
  const blocks = state.dayOf(isoDate).blocks;
  const candidates = [
    makeShift(state, employee, isoDate, paidMinutes, "EARLY"),
    makeShift(state, employee, isoDate, paidMinutes, "LATE"),
  ];
  const split = customVietphoSplitShift(employee, isoDate, paidMinutes, blocks);
  if (split) candidates.push(split);

  const presence = presenceFromPaid(paidMinutes);
  const alignments = vietphoPeakIntervals().flatMap((peak) => [
    peak.startMinutes,
    peak.endMinutes - presence,
  ]);
  for (const block of blocks) {
    for (const startMinutes of [block.startMinutes, block.endMinutes - presence, ...alignments]) {
      if (startMinutes < block.startMinutes || startMinutes + presence > block.endMinutes) continue;
      candidates.push(
        customContinuousShift(employee, isoDate, paidMinutes, startMinutes),
      );
    }
  }

  const unique = new Map<string, Shift>();
  for (const candidate of candidates) {
    const segments = (candidate.segments ?? [candidate])
      .map((segment) => `${segment.startMinutes}-${segment.endMinutes}`)
      .join("|");
    unique.set(segments, candidate);
  }
  return [...unique.values()];
}

function makeVietphoDemandAwareShift(
  state: SchedulerState,
  employee: Employee,
  isoDate: string,
  paidMinutes: number,
): Shift {
  const demand = vietphoDemandOf(state, isoDate) ?? [];
  const peakDemand = vietphoPeakDemand(state, isoDate);
  const existing = vietphoShiftsOnDate(state, isoDate);
  const candidates = vietphoCandidates(state, employee, isoDate, paidMinutes);

  return candidates.reduce((best, candidate) => {
    const bestScore =
      demandCoverageGain(best, existing, demand) +
      demandCoverageGain(best, existing, peakDemand) * 8;
    const candidateScore =
      demandCoverageGain(candidate, existing, demand) +
      demandCoverageGain(candidate, existing, peakDemand) * 8;
    return candidateScore > bestScore ? candidate : best;
  });
}

function shiftCoversInterval(
  shift: Shift,
  interval: { startMinutes: number; endMinutes: number },
): boolean {
  return (shift.segments ?? [shift]).some(
    (segment) =>
      segment.startMinutes <= interval.startMinutes &&
      segment.endMinutes >= interval.endMinutes,
  );
}

function replaceShiftPlacement(state: SchedulerState, shift: Shift, candidate: Shift): void {
  const ds = state.dateState.get(shift.date)!;
  if (shift.shiftType === "LATE") ds.latePaid -= shift.paidMinutes;
  shift.startMinutes = candidate.startMinutes;
  shift.endMinutes = candidate.endMinutes;
  shift.pauseMinutes = candidate.pauseMinutes;
  shift.shiftType = candidate.shiftType;
  if (candidate.segments) shift.segments = candidate.segments;
  else delete shift.segments;
  if (shift.shiftType === "LATE") ds.latePaid += shift.paidMinutes;
}

/** Repositions existing Vietpho shifts without changing dates or paid hours. */
function balanceVietphoPeaks(state: SchedulerState): void {
  for (const isoDate of state.dates) {
    const peaks = vietphoPeakDemand(state, isoDate).map((peak) => ({
      startMinutes: peak.startMinutes,
      endMinutes: peak.endMinutes,
      minStaff: Math.round(peak.personMinutes / (peak.endMinutes - peak.startMinutes)),
    }));
    const onDay = state.shifts.filter((shift) => shift.date === isoDate);
    if (peaks.length === 0 || onDay.length === 0) continue;

    const count = (peak: (typeof peaks)[number], without?: Shift, withShift?: Shift) =>
      onDay.reduce(
        (total, shift) =>
          total + (shift !== without && shiftCoversInterval(shift, peak) ? 1 : 0),
        withShift && shiftCoversInterval(withShift, peak) ? 1 : 0,
      );

    for (const peak of peaks) {
      while (count(peak) < peak.minStaff) {
        let best: { shift: Shift; candidate: Shift; score: number } | null = null;
        for (const shift of onDay) {
          if (shiftCoversInterval(shift, peak)) continue;
          const employee = state.employeesById.get(shift.employeeId)!;
          for (const candidate of vietphoCandidates(
            state,
            employee,
            isoDate,
            shift.paidMinutes,
          )) {
            if (!shiftCoversInterval(candidate, peak)) continue;
            const preservesCoveredPeaks = peaks.every(
              (otherPeak) =>
                count(otherPeak) < otherPeak.minStaff ||
                count(otherPeak, shift, candidate) >= otherPeak.minStaff,
            );
            if (!preservesCoveredPeaks) continue;
            const score = peaks.reduce(
              (total, otherPeak) => total + count(otherPeak, shift, candidate),
              0,
            );
            if (!best || score > best.score) best = { shift, candidate, score };
          }
        }
        if (!best) break;
        replaceShiftPlacement(state, best.shift, best.candidate);
      }
    }
  }
}

/** Pick the placement that closes the largest uncovered Kitchen/Service gap. */
function makeRoleAwareShift(
  state: SchedulerState,
  employee: Employee,
  isoDate: string,
  paidMinutes: number,
): Shift {
  if (state.isVietpho) {
    return makeVietphoDemandAwareShift(state, employee, isoDate, paidMinutes);
  }
  const demand = roleDemandOf(state, employee, isoDate);
  if (!demand) return makeShift(state, employee, isoDate, paidMinutes);

  const existing = roleShiftsOnDate(state, employee, isoDate);
  const peakDemand = thienlongPeakDemandOf(state, employee, isoDate);
  const candidates = thienlongCandidates(state, employee, isoDate, paidMinutes);

  return candidates.reduce((best, candidate) => {
    const score = (shift: Shift) =>
      demandCoverageGain(shift, existing, demand) +
      demandCoverageGain(shift, existing, peakDemand) * 2;
    return score(candidate) > score(best) ? candidate : best;
  });
}

function roleGapHours(state: SchedulerState, employee: Employee, isoDate: string): number {
  if (state.isVietpho) {
    const existing = vietphoShiftsOnDate(state, isoDate);
    const demandGap = demandCoverageGap(existing, vietphoDemandOf(state, isoDate) ?? []);
    const peakGap = demandCoverageGap(existing, vietphoPeakDemand(state, isoDate));
    return (demandGap + peakGap * 8) / 60;
  }
  const demand = roleDemandOf(state, employee, isoDate);
  if (!demand) return 0;
  return demandCoverageGap(roleShiftsOnDate(state, employee, isoDate), demand) / 60;
}

/** Passt diese bezahlte Zeit (inkl. nötiger Pause) in EINEN Block? */
function fitsSingleBlock(paidMinutes: number, blocks: ResolvedDay["blocks"]): boolean {
  const presence = presenceFromPaid(paidMinutes);
  return blocks.some((b) => b.endMinutes - b.startMinutes >= presence);
}

/** Längste Schicht, die der Tag hergibt – einzeln ODER geteilt. */
function maxPaidForDay(day: ResolvedDay): number {
  if (day.closed) return 0;
  const single = maxShiftHoursForWindow(longestBlockMinutes(day)) * 60;
  if (day.blocks.length < 2) return single;
  // Geteilt: beide Blöcke zusammen, ohne Pause.
  const both = day.blocks.reduce((a, b) => a + (b.endMinutes - b.startMinutes), 0);
  return Math.max(single, Math.min(both, MAX_DAILY_MINUTES));
}

function applyShift(state: SchedulerState, shift: Shift): void {
  const ds = state.dateState.get(shift.date)!;
  ds.totalPaid += shift.paidMinutes;
  if (shift.shiftType === "LATE") ds.latePaid += shift.paidMinutes;
  ds.count += 1;
  state.worked.get(shift.employeeId)!.add(shift.date);
  const wkA = state.weekMinutes.get(shift.employeeId)!;
  const kA = weekKeyOf(shift.date);
  wkA.set(kA, (wkA.get(kA) ?? 0) + shift.paidMinutes);
  if (isWeekend(shift.date)) {
    state.weekendCount.set(
      shift.employeeId,
      (state.weekendCount.get(shift.employeeId) ?? 0) + 1,
    );
  }
  state.shifts.push(shift);
}

function matchesEmployeeDayRules(
  _state: SchedulerState,
  employee: Employee,
  isoDate: string,
): boolean {
  return !isEmployeeFixedDayOff(employee, isoDate);
}

/**
 * Platziert genau eine Schicht für einen Mitarbeiter: bestes Datum wählen,
 * Schichtlänge an das Tagesfenster anpassen. Gibt true zurück, wenn platziert.
 */
/**
 * Obergrenze der Arbeitstage je Woche, wenn der Mitarbeiter „Số ngày làm/tuần"
 * gesetzt hat: höchstens N Arbeitstage je Woche. Passt das Monats-Soll nicht mit
 * N Tagen (bei bis zu 10 h/Tag), wird um genau einen Tag gelockert (N+1); reicht
 * auch das nicht, entfällt die Grenze, damit das Soll erfüllbar bleibt. Ohne
 * Einstellung: kein Limit (Infinity).
 *
 * Thienlong plant diese Tage zusätzlich fest ein (plannedShiftCount /
 * placeRigidShifts): die Person arbeitet wirklich N Tage, die Länge folgt dem
 * Tempo Rest/Tage, am Wochenende etwas länger.
 */
function desiredWeeklyDayCap(state: SchedulerState, employee: Employee): number {
  const n = employee.desiredDaysPerWeek;
  if (!n || n <= 0) return Number.POSITIVE_INFINITY;

  const weekKeys = new Set<string>();
  for (const isoDate of state.dates) {
    const day = state.dayOf(isoDate);
    if (day.closed || maxPaidForDay(day) === 0) continue;
    if (!matchesEmployeeDayRules(state, employee, isoDate)) continue;
    weekKeys.add(weekKeyOf(isoDate));
  }
  const numWeeks = Math.max(1, weekKeys.size);
  const weeklyNeed = employee.targetMinutes / numWeeks;
  const maxDay = state.isVietpho ? 8 * 60 : MAX_DAILY_MINUTES;

  // ±1 Tag Toleranz: N Tage, wenn das Soll passt; sonst N+1; sonst kein Limit.
  if (weeklyNeed <= n * maxDay) return n;
  if (weeklyNeed <= (n + 1) * maxDay) return n + 1;
  return Number.POSITIVE_INFINITY;
}

/**
 * Geplante Anzahl Schichten im Monat (nur Thienlong):
 *  - „Số ngày làm/tuần" gesetzt: je Woche so viele Tage, wie die Einstellung
 *    (und die festen Ruhetage) zulassen – die Person arbeitet wirklich N Tage.
 *  - sonst Teilzeit/Minijob: viele kurze Einsätze (≈ Soll / 2,5 h, je 2–4 h,
 *    nur zu Stoßzeiten) – keine 9-h-Tage mit wochenlanger Pause.
 *  - Vollzeit/Azubi ohne Einstellung: null (Länge frei nach Nachfrage).
 */
function plannedShiftCount(state: SchedulerState, employee: Employee): number | null {
  if (!state.isThienlong) return null;
  if (employee.targetMinutes <= 0) return null;

  const cap = desiredWeeklyDayCap(state, employee);
  if (Number.isFinite(cap)) {
    const eligibleByWeek = new Map<string, number>();
    for (const isoDate of state.dates) {
      const day = state.dayOf(isoDate);
      if (day.closed || maxPaidForDay(day) === 0) continue;
      if (!matchesEmployeeDayRules(state, employee, isoDate)) continue;
      const k = weekKeyOf(isoDate);
      eligibleByWeek.set(k, (eligibleByWeek.get(k) ?? 0) + 1);
    }
    let total = 0;
    for (const count of eligibleByWeek.values()) total += Math.min(count, cap);
    return total > 0 ? total : null;
  }

  if (employee.employmentType !== "TEILZEIT") return null;
  const openDays = state.dates.filter((d) => {
    const day = state.dayOf(d);
    return !day.closed && maxPaidForDay(day) > 0 && matchesEmployeeDayRules(state, employee, d);
  }).length;
  // Höchstens 6 von 7 Tagen (6-Tage-Regel).
  const count = teilzeitShiftCount(employee.targetMinutes / 60, Math.floor((openDays * 6) / 7));
  return count > 0 ? count : null;
}

/** Würde ein Umzug von `from` nach `to` die gewünschten Tage/Woche überschreiten? */
function exceedsWeeklyDayCap(
  state: SchedulerState,
  employee: Employee,
  from: string,
  to: string,
): boolean {
  const cap = desiredWeeklyDayCap(state, employee);
  if (!Number.isFinite(cap)) return false;
  const week = weekKeyOf(to);
  if (weekKeyOf(from) === week) return false;
  let days = 0;
  for (const iso of state.worked.get(employee.id)!) if (weekKeyOf(iso) === week) days += 1;
  return days >= cap;
}

/** Bereits verplante Minuten einer Rolle an einem Tag. */
function rolePaidOn(state: SchedulerState, role: WorkRole, isoDate: string): number {
  let sum = 0;
  for (const shift of state.shifts) {
    if (shift.date !== isoDate) continue;
    if (state.employeesById.get(shift.employeeId)?.workRole === role) sum += shift.paidMinutes;
  }
  return sum;
}

/** Abweichung (Minuten) der Rolle vom Tages-Soll, optional nach einer Änderung. */
function roleDeviation(
  state: SchedulerState,
  role: WorkRole | undefined,
  isoDate: string,
  paidDelta = 0,
): number {
  if (!role) return 0;
  const target = state.roleTarget.get(role)?.get(isoDate);
  if (target === undefined) return 0;
  return Math.abs(rolePaidOn(state, role, isoDate) + paidDelta - target);
}

/**
 * Länge für Mitarbeiter mit geplanter Schichtzahl: möglichst nah an
 * `wantHours` (= Rest / verbleibende Schichten, leicht nach Tagesnachfrage
 * gewichtet), nie kürzer als `floorHours` (sonst reicht der Monat nicht).
 */
function choosePacedHours(
  remainingMinutes: number,
  maxHours: number,
  employmentType: Employee["employmentType"],
  wantHours: number,
  floorHours: number,
  allowedOverride?: readonly number[],
): number {
  const remainingHours = remainingMinutes / 60;
  const cap = Math.min(MAX_DAILY_MINUTES / 60, maxHours, remainingHours);
  const pick = (allowed: readonly number[]) =>
    allowed.filter((h) => h <= cap && canDecompose(remainingHours - h, allowed));
  let valid = pick(allowedOverride ?? ALLOWED_HOURS[employmentType]);
  if (valid.length === 0 && employmentType !== "AZUBI") valid = pick(ALL_HOURS);
  if (valid.length === 0) {
    // Azubi-Rest unter 3 h bleibt als kurze Einzelschicht erlaubt.
    if (employmentType === "AZUBI" && remainingHours < 3 && cap >= remainingHours) {
      return remainingHours;
    }
    return 0;
  }
  const want = Math.max(wantHours, floorHours);
  let best = valid[0];
  for (const h of valid) {
    // Gleichstand -> die längere (sicherer fürs Monats-Soll).
    if (Math.abs(h - want) <= Math.abs(best - want) + 1e-9) best = h;
  }
  return best;
}

/**
 * „Feste" Mitarbeiter (arbeiten jeden erlaubten Tag, z.B. 6 Tage/Woche mit
 * einem festen Ruhetag) haben keine Wahl beim Datum. Sie werden deshalb VOR
 * allen anderen Tag für Tag eingeplant; die Länge folgt dem Tempo
 * (Rest / verbleibende Tage), leicht gewichtet nach Tagesnachfrage.
 */
/** Weiche Untergrenze für feste Mitarbeiter (Tempo-Planung): an vollen Tagen
 *  darf auch Vollzeit kürzer arbeiten, damit dünn besetzte Tage mehr bekommen. */
const RIGID_MIN_HOURS: Record<Employee["employmentType"], number> = {
  VOLLZEIT: 5,
  TEILZEIT: 3,
  AZUBI: 3,
};
const RIGID_ALLOWED_HOURS: Record<Employee["employmentType"], readonly number[]> = {
  VOLLZEIT: ALL_HOURS.filter((h) => h >= RIGID_MIN_HOURS.VOLLZEIT),
  TEILZEIT: ALL_HOURS,
  AZUBI: ALL_HOURS,
};

/**
 * Stunden-Plan eines festen Mitarbeiters über den Monat ("Wasserfüllung"):
 * Soll proportional zum Tempo-Gewicht verteilen, dann Tagesgrenzen
 * [min, Tagesmax] und die Azubi-Wochendecke einhalten; was ein Tag/eine Woche
 * nicht aufnehmen kann, geht gleichmäßig auf die übrigen Tage – statt sich am
 * Monatsende auf einem Tag zu stauen.
 */
/**
 * Wochendecke für feste Azubis inkl. der erlaubten Reserve
 * (AZUBI_WEEKLY_TARGET_FLEX_HOURS, von der Validierung akzeptiert). Ohne sie
 * staut sich der Monatsrest auf den angeschnittenen Rand-Wochen (z.B. ein
 * Samstag am Monatsanfang mit drei 9,5-h-Azubis).
 */
function rigidWeeklyCapMinutes(employee: Employee): number | null {
  const cap = weeklyCapMinutes(employee);
  return cap === null ? null : cap + AZUBI_WEEKLY_TARGET_FLEX_HOURS * 60;
}

function planRigidHours(
  state: SchedulerState,
  employee: Employee,
  dates: readonly string[],
  weightOf: (d: string) => number,
): Map<string, number> {
  const target = employee.targetMinutes / 60;
  const minH = RIGID_MIN_HOURS[employee.employmentType];
  const dayMax = (d: string) => Math.min(MAX_DAILY_MINUTES, maxPaidForDay(state.dayOf(d))) / 60;
  const weekCapMin = rigidWeeklyCapMinutes(employee);
  const weekCap = weekCapMin === null ? Number.POSITIVE_INFINITY : weekCapMin / 60;

  const fixed = new Map<string, number>();
  let plan = new Map<string, number>();
  for (let iter = 0; iter < 50; iter++) {
    const free = dates.filter((d) => !fixed.has(d));
    if (free.length === 0) break;
    const rest = target - [...fixed.values()].reduce((a, h) => a + h, 0);
    const wSum = free.reduce((a, d) => a + weightOf(d), 0);
    plan = new Map(fixed);
    for (const d of free) plan.set(d, wSum > 0 ? (rest * weightOf(d)) / wSum : rest / free.length);

    let changed = false;
    for (const d of free) {
      const h = plan.get(d)!;
      if (h > dayMax(d)) { fixed.set(d, dayMax(d)); changed = true; }
      else if (h < minH) { fixed.set(d, minH); changed = true; }
    }
    if (changed) continue;

    const byWeek = new Map<string, string[]>();
    for (const d of dates) {
      const k = weekKeyOf(d);
      byWeek.set(k, [...(byWeek.get(k) ?? []), d]);
    }
    for (const days of byWeek.values()) {
      const sum = days.reduce((a, d) => a + plan.get(d)!, 0);
      if (sum <= weekCap + 1e-9) continue;
      const fixedSum = days.filter((d) => fixed.has(d)).reduce((a, d) => a + fixed.get(d)!, 0);
      const freeDays = days.filter((d) => !fixed.has(d));
      const freeSum = freeDays.reduce((a, d) => a + plan.get(d)!, 0);
      const scale = freeSum > 0 ? Math.max(0, weekCap - fixedSum) / freeSum : 0;
      for (const d of freeDays) fixed.set(d, plan.get(d)! * scale);
      changed = true;
    }
    if (!changed) break;
  }
  return plan;
}

function placeRigidShifts(state: SchedulerState): void {
  const rigid = [...state.rigid].map((id) => state.employeesById.get(id)!);
  const eligibleDates = new Map(
    rigid.map((e) => [
      e.id,
      state.dates.filter((d) => {
        const day = state.dayOf(d);
        return !day.closed && maxPaidForDay(day) > 0 && matchesEmployeeDayRules(state, e, d);
      }),
    ]),
  );
  const weightOf = (employee: Employee, d: string) =>
    (employee.workRole && state.paceWeight.get(employee.workRole)?.get(d)) ||
    thienlongDemandWeight(weekdayKeyOf(parseIsoDate(d)), state.holidays.has(d));

  const plans = new Map(
    rigid.map((e) => [
      e.id,
      planRigidHours(state, e, eligibleDates.get(e.id)!, (d) => weightOf(e, d)),
    ]),
  );

  for (const isoDate of state.dates) {
    for (const employee of rigid) {
      const remaining = state.remaining.get(employee.id)!;
      if (remaining <= 0) continue;
      const dates = eligibleDates.get(employee.id)!;
      const idx = dates.indexOf(isoDate);
      if (idx < 0) continue;
      const worked = state.worked.get(employee.id)!;
      if (consecutiveRunLengthWith(worked, isoDate) > 6) continue;

      const left = dates.slice(idx);
      // Rest proportional zum Tempo-Gewicht auf die restlichen Tage verteilen:
      // Tage mit wenig Kollegen derselben Rolle bekommen längere Schichten.
      const plan = plans.get(employee.id)!;
      const planSum = left.reduce((sum, d) => sum + (plan.get(d) ?? 0), 0);
      const share = planSum > 0 ? (plan.get(isoDate) ?? 0) / planSum : 1 / left.length;
      const want = left.length === 1
        ? remaining / 60
        : Math.min(10, Math.max(RIGID_MIN_HOURS[employee.employmentType], (remaining / 60) * share));

      let dayCapMinutes = maxPaidForDay(state.dayOf(isoDate));
      const weekCap = rigidWeeklyCapMinutes(employee);
      if (weekCap !== null) {
        const used = state.weekMinutes.get(employee.id)!.get(weekKeyOf(isoDate)) ?? 0;
        dayCapMinutes = Math.min(dayCapMinutes, weekCap - used);
      }
      if (dayCapMinutes <= 0) continue;

      const hours = choosePacedHours(
        remaining,
        dayCapMinutes / 60,
        employee.employmentType,
        want,
        0,
        RIGID_ALLOWED_HOURS[employee.employmentType],
      );
      if (hours === 0) continue;
      const shift = makeRoleAwareShift(state, employee, isoDate, hours * 60);
      applyShift(state, shift);
      state.remaining.set(employee.id, remaining - shift.paidMinutes);
    }
  }
}


function placeOneShift(state: SchedulerState, employee: Employee): boolean {
  const remaining = state.remaining.get(employee.id)!;
  if (remaining <= 0) return false;

  const worked = state.worked.get(employee.id)!;
  const weekendCount = state.weekendCount.get(employee.id) ?? 0;
  const weekCap = weeklyCapMinutes(employee);
  const weekUsed = state.weekMinutes.get(employee.id)!;

  // „Số ngày làm/tuần": bereits belegte Tage je Woche zählen, damit die Grenze
  // greifen kann. Ohne Einstellung ist der Cap Infinity und ändert nichts.
  const dayCapPerWeek = desiredWeeklyDayCap(state, employee);
  const weekDayCount = new Map<string, number>();
  if (Number.isFinite(dayCapPerWeek)) {
    for (const iso of worked) {
      const k = weekKeyOf(iso);
      weekDayCount.set(k, (weekDayCount.get(k) ?? 0) + 1);
    }
  }
  const weekAtDayCap = (weekKey: string): boolean =>
    Number.isFinite(dayCapPerWeek) && (weekDayCount.get(weekKey) ?? 0) >= dayCapPerWeek;

  // Erst zählen, wie viele Tage überhaupt noch in Frage kommen. Daraus ergibt
  // sich das nötige Tempo (Stunden je verbleibendem Tag) – ohne das würde die
  // zufällige Längenwahl das Monats-Soll reißen.
  const eligibleByWeek = new Map<string, number>();
  let eligibleWeightSum = 0;
  let eligibleCount = 0;
  for (const isoDate of state.dates) {
    if (worked.has(isoDate)) continue;
    if (!matchesEmployeeDayRules(state, employee, isoDate)) continue;
    const day = state.dayOf(isoDate);
    if (day.closed) continue;
    if (maxPaidForDay(day) === 0) continue;
    if (consecutiveRunLengthWith(worked, isoDate) > 6) continue;
    const weekKey = weekKeyOf(isoDate);
    if (weekCap !== null && (weekUsed.get(weekKey) ?? 0) >= weekCap) continue;
    eligibleByWeek.set(weekKey, (eligibleByWeek.get(weekKey) ?? 0) + 1);
    if (state.isThienlong) {
      eligibleWeightSum += thienlongDemandWeight(
        weekdayKeyOf(parseIsoDate(isoDate)),
        state.holidays.has(isoDate),
      );
      eligibleCount += 1;
    }
  }
  // Je Woche höchstens so viele Tage zählen, wie der Tages-Cap noch zulässt –
  // sonst wählt die Längenwahl zu kurze Schichten für zu viele Tage.
  let daysLeft = 0;
  for (const [weekKey, count] of eligibleByWeek) {
    const slots = Number.isFinite(dayCapPerWeek)
      ? Math.max(0, dayCapPerWeek - (weekDayCount.get(weekKey) ?? 0))
      : count;
    daysLeft += Math.min(count, slots);
  }
  // daysLeft ist eine Obergrenze: greedy belegt nie wirklich JEDEN erlaubten
  // Tag, weil die 6-Tage-Regel Lücken erzwingt. Ohne Sicherheitsabschlag wählt
  // der Zufall zu kurze Schichten und das Soll geht am Monatsende nicht auf.
  const usableDays = Math.max(1, Math.floor(daysLeft * 0.9));
  const needHours = daysLeft > 0 ? Math.ceil(remaining / 60 / usableDays) : 8;

  // Geplante Schichtzahl (Tage/Woche bzw. „x ca" aus der Mitarbeiterliste):
  // Tempo = Rest / verbleibende Schichten. Untergrenze nur so hoch, dass die
  // tatsächlich noch freien Tage reichen.
  const planned = state.plannedShifts.get(employee.id) ?? null;
  const shiftsLeft = planned !== null ? Math.max(1, planned - worked.size) : 0;
  const paceHours = planned !== null ? remaining / 60 / shiftsLeft : 0;
  const paceFloorHours = daysLeft > 0 ? remaining / 60 / daysLeft : 0;
  const avgEligibleWeight = eligibleCount > 0 ? eligibleWeightSum / eligibleCount : 1;

  let bestDate: string | null = null;
  let bestHours = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const isoDate of state.dates) {
    if (worked.has(isoDate)) continue; // max. ein Dienst pro Tag
    if (!matchesEmployeeDayRules(state, employee, isoDate)) continue;
    const day = state.dayOf(isoDate);
    if (day.closed) continue; // Betriebsruhe -> kein Dienst
    const weekKey = weekKeyOf(isoDate);
    if (weekAtDayCap(weekKey)) continue; // gewünschte Tage/Woche erreicht
    const ds = state.dateState.get(isoDate)!;
    const staffingProfile = state.isThienlong
      ? thienlongStaffingProfile(
          weekdayKeyOf(parseIsoDate(isoDate)),
          state.holidays.has(isoDate),
        )
      : null;
    if (staffingProfile) {
      // Plätze für „feste" Kollegen freihalten, die an diesem Tag noch fehlen.
      let reserved = 0;
      if (!state.rigid.has(employee.id)) {
        for (const id of state.rigid) {
          if ((state.remaining.get(id) ?? 0) <= 0) continue;
          if (state.worked.get(id)!.has(isoDate)) continue;
          if (!matchesEmployeeDayRules(state, state.employeesById.get(id)!, isoDate)) continue;
          reserved += 1;
        }
      }
      if (ds.count + reserved >= staffingProfile.maxStaff + state.extraStaff) continue;
    }

    // Azubi-Wochendecke: was in dieser Woche noch frei ist.
    let dayCapMinutes = maxPaidForDay(day);
    if (state.isVietpho) dayCapMinutes = Math.min(dayCapMinutes, 8 * 60);
    if (weekCap !== null) {
      const free = weekCap - (weekUsed.get(weekKey) ?? 0);
      if (free <= 0) continue; // Woche ist voll
      dayCapMinutes = Math.min(dayCapMinutes, free);
    }

    // Längste Schicht, die ins Fenster passt UND den Rest exakt aufteilbar lässt.
    const profile = state.isVietpho ? "vietpho" : state.isThienlong ? "thienlong" : "default";
    const pacedWeight = planned !== null
      ? thienlongDemandWeight(weekdayKeyOf(parseIsoDate(isoDate)), state.holidays.has(isoDate))
      : 1;
    const hours = planned !== null
      ? choosePacedHours(
          remaining,
          dayCapMinutes / 60,
          employee.employmentType,
          paceHours * (1 + (pacedWeight / avgEligibleWeight - 1) * 0.6) +
            (state.varyLengths ? (state.rng() - 0.5) * 0.5 : 0),
          paceFloorHours,
          employee.employmentType === "TEILZEIT" && state.isThienlong
            ? TEILZEIT_SHIFT_HOURS
            : undefined,
        )
      : chooseShiftHours(
          remaining,
          dayCapMinutes / 60,
          employee.employmentType,
          needHours,
          state.varyLengths ? state.rng : undefined,
          profile,
        );
    if (hours === 0) continue; // hier passt keine gültige Schicht

    // Harte Regel. Früher gab es hier einen Ausweichtag, der diese Prüfung
    // übersprungen hat – dabei entstanden lautlos Pläne mit bis zu 28
    // Arbeitstagen am Stück. Lieber gar keinen Plan als einen unzulässigen:
    // ohne gültigen Tag bleibt das Soll offen und generateSchedule wirft.
    const runLength = consecutiveRunLengthWith(worked, isoDate);
    if (runLength > 6) continue;

    // Thienlong mit fester Rolle: Defizit der eigenen Rolle (Bếp/Bồi) zählt,
    // sonst landen Köche und Service ungleich auf den Tagen.
    const roleTargetMin = employee.workRole
      ? state.roleTarget.get(employee.workRole)?.get(isoDate)
      : undefined;
    const deficitHours = roleTargetMin !== undefined
      ? (roleTargetMin - rolePaidOn(state, employee.workRole!, isoDate)) / 60
      : (state.rawTarget.get(isoDate)! - ds.totalPaid) / 60;
    const dayWeight = state.isThienlong
      ? thienlongDemandWeight(
          weekdayKeyOf(parseIsoDate(isoDate)),
          state.holidays.has(isoDate),
        )
      : state.isVietpho
        ? vietphoDemandWeight(
            weekdayKeyOf(parseIsoDate(isoDate)),
            state.holidays.has(isoDate),
          )
        : DAY_WEIGHTS[state.effKeyOf(isoDate)];
    const uncoveredRoleHours = roleGapHours(state, employee, isoDate);
    const staffingGap = staffingProfile && state.useThienlongStaffingCounts
      ? Math.max(0, staffingProfile.minStaff - ds.count)
      : 0;
    const staffingOverflow = staffingProfile && state.useThienlongStaffingCounts
      ? Math.max(0, ds.count - staffingProfile.minStaff)
      : 0;

    const consecutivePenalty = runLength >= 5 ? (runLength - 4) * 8 : 0;
    const weekendPenalty = isWeekend(isoDate) ? weekendCount * 1.5 : 0;
    const weekBalancePenalty =
      employee.employmentType === "AZUBI"
        ? ((weekUsed.get(weekKey) ?? 0) / 60) * 2
        : 0;

    const jitter = state.rng() * 0.01; // deterministisch (seeded), nur Tie-Break

    const score =
      deficitHours * 10 +
      dayWeight * 3 -
      consecutivePenalty -
      weekendPenalty -
      weekBalancePenalty +
      staffingGap * 10 -
      staffingOverflow * 3 +
      uncoveredRoleHours * 1.5 +
      jitter;

    if (score > bestScore) {
      bestScore = score;
      bestDate = isoDate;
      bestHours = hours;
    }
  }

  if (bestDate === null || bestHours === 0) return false;

  const shift = makeRoleAwareShift(state, employee, bestDate, bestHours * 60);
  applyShift(state, shift);
  state.remaining.set(employee.id, remaining - shift.paidMinutes);
  return true;
}

/** Kosten eines Tages = |zugewiesene - rohe Soll-Minuten|. */
function dateCost(state: SchedulerState, isoDate: string): number {
  return Math.abs(
    state.dateState.get(isoDate)!.totalPaid - state.rawTarget.get(isoDate)!,
  );
}

function removeShift(state: SchedulerState, shift: Shift): void {
  const ds = state.dateState.get(shift.date)!;
  ds.totalPaid -= shift.paidMinutes;
  if (shift.shiftType === "LATE") ds.latePaid -= shift.paidMinutes;
  ds.count -= 1;
  state.worked.get(shift.employeeId)!.delete(shift.date);
  const wkR = state.weekMinutes.get(shift.employeeId)!;
  const kR = weekKeyOf(shift.date);
  wkR.set(kR, (wkR.get(kR) ?? 0) - shift.paidMinutes);
  if (isWeekend(shift.date)) {
    state.weekendCount.set(
      shift.employeeId,
      (state.weekendCount.get(shift.employeeId) ?? 0) - 1,
    );
  }
  const idx = state.shifts.indexOf(shift);
  if (idx >= 0) state.shifts.splice(idx, 1);
}

/**
 * Uses spare capacity in already assigned visits before giving up on a target.
 * This is important for high monthly targets: an extra half-hour should make
 * an existing visit longer (ideally across a meal peak), not create a ninth
 * person on a busy date.
 */
function extendExistingShiftsToTargets(
  state: SchedulerState,
  weeklyFlexMinutes = 0,
): void {
  for (const employee of state.employeesById.values()) {
    let remaining = state.remaining.get(employee.id) ?? 0;
    if (remaining <= 0) continue;

    while (remaining > 0) {
      const options = state.shifts
        .filter((shift) => shift.employeeId === employee.id)
        .map((shift) => {
          const dayCapacity = Math.min(
            maxPaidForDay(state.dayOf(shift.date)),
            state.isVietpho ? 8 * 60 : MAX_DAILY_MINUTES,
          );
          const weekCap = weeklyCapMinutes(employee);
          const weekUsed = state.weekMinutes.get(employee.id)?.get(weekKeyOf(shift.date)) ?? 0;
          const weekCapacity = weekCap === null
            ? Number.POSITIVE_INFINITY
            : weekCap + weeklyFlexMinutes - weekUsed;
          const available = Math.min(dayCapacity - shift.paidMinutes, weekCapacity);
          return { shift, available: Math.max(0, Math.floor(available / 30) * 30) };
        })
        .filter((option) => option.available > 0)
        // Kürzeste Schicht zuerst und nur 30 min je Schritt: der Rest verteilt
        // sich gleichmäßig (z.B. mehrere 4-h-Einsätze auf 4,5 h) statt einen
        // einzelnen Tag auf 8–10 h aufzublähen.
        .sort(
          (a, b) =>
            a.shift.paidMinutes - b.shift.paidMinutes ||
            b.available - a.available ||
            a.shift.date.localeCompare(b.shift.date),
        );

      const option = options[0];
      if (!option) break;

      const added = Math.min(remaining, option.available, 30);
      const date = option.shift.date;
      const paidMinutes = option.shift.paidMinutes + added;
      removeShift(state, option.shift);
      applyShift(state, makeRoleAwareShift(state, employee, date, paidMinutes));
      remaining -= added;
      state.remaining.set(employee.id, remaining);
    }
  }
}

function thienlongDateCost(
  state: SchedulerState,
  isoDate: string,
  paidDelta = 0,
  countDelta = 0,
): number {
  const ds = state.dateState.get(isoDate)!;
  const profile = thienlongStaffingProfile(
    weekdayKeyOf(parseIsoDate(isoDate)),
    state.holidays.has(isoDate),
  );
  const hours = (ds.totalPaid + paidDelta) / 60;
  const rawHours = (state.rawTarget.get(isoDate) ?? 0) / 60;
  const underHours = state.useThienlongStaffingBands
    ? Math.max(0, profile.minHours - hours)
    : 0;
  const overHours = state.useThienlongStaffingBands
    ? Math.max(0, hours - profile.maxHours)
    : 0;
  const count = ds.count + countDelta;
  const underStaff = state.useThienlongStaffingCounts
    ? Math.max(0, profile.minStaff - count)
    : 0;
  const overStaff = Math.max(0, count - profile.maxStaff - state.extraStaff);

  const cost =
    Math.abs(hours - rawHours) +
    underHours * 30 +
    overHours * 30 +
    underStaff * 50 +
    overStaff * 2_000;

  return cost;
}

/**
 * Moves existing Thienlong shifts between dates until the requested staffing
 * bands are closer, without changing any employee target or stored setting.
 */
function repairThienlongStaffing(state: SchedulerState): void {
  const MAX_MOVES = state.dates.length;
  for (let pass = 0; pass < MAX_MOVES; pass++) {
    let best: { shift: Shift; target: string; delta: number } | null = null;
    const underfilledDates = state.dates.filter((date) => {
      if (state.dayOf(date).closed) return false;
      const profile = thienlongStaffingProfile(
        weekdayKeyOf(parseIsoDate(date)),
        state.holidays.has(date),
      );
      return state.dateState.get(date)!.count < profile.minStaff;
    });
    const targetDates = underfilledDates.length > 0
      ? underfilledDates
      : state.useThienlongStaffingBands
        ? state.dates
        : [];
    if (targetDates.length === 0) break;

    for (const to of targetDates) {
      for (const shift of [...state.shifts]) {
        const employee = state.employeesById.get(shift.employeeId)!;
        const from = shift.date;
        const worked = state.worked.get(employee.id)!;
        if (to === from || worked.has(to)) continue;
        if (!matchesEmployeeDayRules(state, employee, to)) continue;
        const day = state.dayOf(to);
        if (day.closed || maxPaidForDay(day) < shift.paidMinutes) continue;

        const targetProfile = thienlongStaffingProfile(
          weekdayKeyOf(parseIsoDate(to)),
          state.holidays.has(to),
        );
        if (state.dateState.get(to)!.count >= targetProfile.maxStaff + state.extraStaff) continue;
        if (state.useThienlongStaffingCounts) {
          const sourceProfile = thienlongStaffingProfile(
            weekdayKeyOf(parseIsoDate(from)),
            state.holidays.has(from),
          );
          if (state.dateState.get(from)!.count <= sourceProfile.minStaff) continue;
        }

        const trialWorked = new Set(worked);
        trialWorked.delete(from);
        if (consecutiveRunLengthWith(trialWorked, to) > 6) continue;
        if (exceedsWeeklyDayCap(state, employee, from, to)) continue;

        const weekCap = weeklyCapMinutes(employee);
        if (weekCap !== null) {
          const weekMinutes = state.weekMinutes.get(employee.id)!;
          const fromWeek = weekKeyOf(from);
          const toWeek = weekKeyOf(to);
          const usedAfterMove =
            (weekMinutes.get(toWeek) ?? 0) +
            shift.paidMinutes -
            (fromWeek === toWeek ? shift.paidMinutes : 0);
          if (usedAfterMove > weekCap) continue;
        }

        const before = thienlongDateCost(state, from) + thienlongDateCost(state, to);
        const after =
          thienlongDateCost(state, from, -shift.paidMinutes, -1) +
          thienlongDateCost(state, to, shift.paidMinutes, 1);

        // Rollen-Gleichgewicht mitzählen, damit ein Umzug Bếp/Bồi nicht kippt.
        const roleBefore =
          roleDeviation(state, employee.workRole, from) + roleDeviation(state, employee.workRole, to);
        const roleAfter =
          roleDeviation(state, employee.workRole, from, -shift.paidMinutes) +
          roleDeviation(state, employee.workRole, to, shift.paidMinutes);

        const delta = after - before + (roleAfter - roleBefore) / 60;
        if (delta < -1e-6 && (!best || delta < best.delta)) {
          best = { shift, target: to, delta };
        }
      }
    }

    if (!best) break;
    const employee = state.employeesById.get(best.shift.employeeId)!;
    removeShift(state, best.shift);
    applyShift(state, makeRoleAwareShift(state, employee, best.target, best.shift.paidMinutes));
  }
}

/**
 * Reparaturlauf: verschiebt einzelne Schichten auf andere Tage, wenn dadurch
 * die Tagesnachfrage besser getroffen wird. Ändert nie die Dauer eines Tokens
 * und verletzt nie die harten Regeln => Sollstunden bleiben exakt erhalten.
 */
function repairDemand(state: SchedulerState, employeesById: Map<string, Employee>): void {
  const MAX_PASSES = 6;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false;
    // Kopie, da wir state.shifts während der Iteration verändern.
    for (const shift of [...state.shifts]) {
      const employee = employeesById.get(shift.employeeId)!;
      // Thienlong: Zeiten werden am Ende ohnehin neu an die Stoßzeiten gelegt
      // (optimizeThienlongPlacement), daher darf auch eine Bếp/Bồi-Schicht den
      // Tag wechseln – bewertet nach dem Soll IHRER Rolle.
      const role = state.isThienlong ? employee.workRole : undefined;
      const from = shift.date;
      const worked = state.worked.get(employee.id)!;

      let bestTarget: string | null = null;
      let bestDelta = -1e-6; // nur echte Verbesserungen

      const oldCostFrom = dateCost(state, from);

      for (const to of state.dates) {
        if (to === from || worked.has(to)) continue;
        if (!matchesEmployeeDayRules(state, employee, to)) continue;
        const day = state.dayOf(to);
        if (day.closed || maxPaidForDay(day) < shift.paidMinutes) continue; // passt nicht
        if (state.isThienlong) {
          const profile = thienlongStaffingProfile(
            weekdayKeyOf(parseIsoDate(to)),
            state.holidays.has(to),
          );
          if (state.dateState.get(to)!.count >= profile.maxStaff + state.extraStaff) continue;
        }
        // Regeln prüfen, als ob die alte Schicht bereits entfernt wäre.
        const trial = new Set(worked);
        trial.delete(from);
        const weekCap = weeklyCapMinutes(employee);
        if (weekCap !== null) {
          const weekMinutes = state.weekMinutes.get(employee.id)!;
          const fromWeek = weekKeyOf(from);
          const toWeek = weekKeyOf(to);
          const usedAfterMove =
            (weekMinutes.get(toWeek) ?? 0) +
            shift.paidMinutes -
            (fromWeek === toWeek ? shift.paidMinutes : 0);
          if (usedAfterMove > weekCap) continue;
        }
        // 6-Tage-Regel prüfen.
        if (consecutiveRunLengthWith(trial, to) > 6) continue;
        if (exceedsWeeklyDayCap(state, employee, from, to)) continue;

        const oldCostTo = dateCost(state, to);
        const newCostFrom = Math.abs(
          state.dateState.get(from)!.totalPaid - shift.paidMinutes - state.rawTarget.get(from)!,
        );
        const newCostTo = Math.abs(
          state.dateState.get(to)!.totalPaid + shift.paidMinutes - state.rawTarget.get(to)!,
        );
        const roleDelta = role
          ? roleDeviation(state, role, from, -shift.paidMinutes) +
            roleDeviation(state, role, to, shift.paidMinutes) -
            roleDeviation(state, role, from) -
            roleDeviation(state, role, to)
          : 0;
        const delta = newCostFrom + newCostTo - (oldCostFrom + oldCostTo) + roleDelta;
        if (delta < bestDelta) {
          bestDelta = delta;
          bestTarget = to;
        }
      }

      if (bestTarget) {
        removeShift(state, shift);
        applyShift(state, makeRoleAwareShift(state, employee, bestTarget, shift.paidMinutes));
        improved = true;
      }
    }
    if (!improved) break;
  }
}

/** Dreht NUR Früh/Spät um. Dauer bleibt gleich => Monats-Soll bleibt exakt. */
function retypeShift(state: SchedulerState, shift: Shift, type: TemplateType): void {
  if (shift.shiftType === type) return;
  const blocks = state.dayOf(shift.date).blocks;
  const ds = state.dateState.get(shift.date)!;

  // Ein geteilter Dienst bleibt geteilt – nur das Abendstück wandert an den
  // Anfang oder ans Ende des Abendblocks. Wird das übersehen, bekommt die
  // Schicht plötzlich eine gerechnete Pause und der Plan wird ungültig.
  const presence = presenceFromPaid(shift.paidMinutes);
  const fitsFirstBlock = blocks[0].endMinutes - blocks[0].startMinutes >= presence;
  const needsSplit =
    blocks.length > 1 &&
    (Boolean(shift.segments && shift.segments.length > 1) || (type === "EARLY" && !fitsFirstBlock));
  const split = needsSplit ? buildSplitShift(shift.paidMinutes, type, blocks) : null;
  const tpl = split
    ? {
        startMinutes: split.segments[0].startMinutes,
        endMinutes: split.segments[split.segments.length - 1].endMinutes,
        pauseMinutes: 0,
        type,
      }
    : getShiftTemplateForBlocks(shift.paidMinutes / 60, type, blocks);

  if (shift.shiftType === "LATE") ds.latePaid -= shift.paidMinutes;
  if (split) shift.segments = split.segments;
  shift.startMinutes = tpl.startMinutes;
  shift.endMinutes = tpl.endMinutes;
  shift.pauseMinutes = tpl.pauseMinutes;
  shift.shiftType = tpl.type;
  if (tpl.type === "LATE") ds.latePaid += shift.paidMinutes;
}

/**
 * Nachlauf über die Schichttypen. Zwei Ziele, in dieser Reihenfolge:
 *  1. Die Spätquote je Tag näher an den Sollwert bringen (vorher schwankte
 *     sie stark, obwohl für alle ruhigen Tage derselbe Wert gilt).
 *  2. Wichtiger als jede Quote: an jedem offenen Tag muss jemand aufsperren
 *     UND jemand zusperren. Vorher kam es vor, dass um 11:00 niemand da war.
 * Es wird ausschließlich der Typ gedreht, nie die Dauer – das Soll bleibt exakt.
 */
function balanceShiftTypes(state: SchedulerState): void {
  for (const isoDate of state.dates) {
    const day = state.dayOf(isoDate);
    if (day.closed) continue;

    const onDay = state.shifts.filter((s) => s.date === isoDate);
    if (onDay.length === 0) continue;

    const ds = state.dateState.get(isoDate)!;
    const desired = state.lateRatioOf(isoDate);
    const quotaCandidates = onDay.filter(
      (shift) => {
        const employee = state.employeesById.get(shift.employeeId);
        return !state.isThienlong || !employee?.workRole;
      },
    );

    // 1. Quote annähern: jeweils die Schicht drehen, die am meisten hilft.
    for (let step = 0; step < quotaCandidates.length * 2; step++) {
      if (ds.totalPaid === 0) break;
      let best: Shift | null = null;
      let bestDiff = Math.abs(ds.latePaid / ds.totalPaid - desired);
      for (const s of quotaCandidates) {
        const late =
          s.shiftType === "LATE" ? ds.latePaid - s.paidMinutes : ds.latePaid + s.paidMinutes;
        const diff = Math.abs(late / ds.totalPaid - desired);
        if (diff < bestDiff - 1e-9) {
          bestDiff = diff;
          best = s;
        }
      }
      if (!best) break;
      retypeShift(state, best, best.shiftType === "LATE" ? "EARLY" : "LATE");
    }

    // 2. Öffnen/Schließen sichern. Mit nur einer Schicht am Tag geht beides
    //    nicht – dann bleibt es bei der Quote-Entscheidung.
    if (onDay.length < 2) continue;

    const shortestOf = (list: Shift[]) => {
      if (list.length === 0) return null;
      return [...list].sort((a, b) => {
        const aEmployee = state.employeesById.get(a.employeeId);
        const bEmployee = state.employeesById.get(b.employeeId);
        const aFixed = Boolean(aEmployee?.workRole);
        const bFixed = Boolean(bEmployee?.workRole);
        if (aFixed !== bFixed) return aFixed ? 1 : -1;
        return a.paidMinutes - b.paidMinutes;
      })[0];
    };

    const startsAtOpening = (shift: Shift) =>
      (shift.segments?.[0]?.startMinutes ?? shift.startMinutes) === day.blocks[0].startMinutes;

    const flipped: Shift[] = [];
    while (onDay.filter(startsAtOpening).length < Math.min(2, onDay.length)) {
      const victim = shortestOf(
        onDay.filter((s) => !startsAtOpening(s) && !flipped.includes(s)),
      );
      if (!victim) break;
      retypeShift(state, victim, "EARLY");
      flipped.push(victim);
    }
    if (!onDay.some((s) => s.endMinutes === day.blocks[day.blocks.length - 1].endMinutes)) {
      const openerCount = onDay.filter(startsAtOpening).length;
      const victim = shortestOf(
        onDay.filter(
          (s) =>
            s.shiftType === "EARLY" &&
            !flipped.includes(s) &&
            (!startsAtOpening(s) || openerCount > 2),
        ),
      );
      if (victim) retypeShift(state, victim, "LATE");
    }
  }
}

/**
 * Lückenlose Abdeckung je Rolle: In jedem Block muss durchgehend ≥1 Bếp und ≥1
 * Bồi anwesend sein. Bleibt eine Lücke (typisch das Ende des Mittagsblocks, wenn
 * alle Mittagsstücke schon um 13:30 enden), wird das Stück einer Rollenschicht in
 * DEMSELBEN Block verschoben (gleiche Länge → Soll bleibt exakt) – aber nur, wenn
 * die verlassene Stelle weiterhin von einer anderen Schicht gedeckt ist.
 */
function repairContinuousCoverage(state: SchedulerState): void {
  if (!state.isThienlong) return;
  const roleOf = (s: Shift): WorkRole | undefined =>
    state.employeesById.get(s.employeeId)?.workRole;

  const setSegment = (shift: Shift, index: number, start: number, end: number) => {
    if (shift.segments && shift.segments.length > 1) {
      shift.segments[index] = { startMinutes: start, endMinutes: end };
      shift.startMinutes = Math.min(...shift.segments.map((g) => g.startMinutes));
      shift.endMinutes = Math.max(...shift.segments.map((g) => g.endMinutes));
    } else {
      shift.startMinutes = start;
      shift.endMinutes = end;
      shift.segments = undefined;
    }
  };

  for (const date of state.dates) {
    const day = state.dayOf(date);
    if (day.closed) continue;
    for (const role of ["KITCHEN", "SERVICE"] as const) {
      for (const block of day.blocks) {
        for (let iter = 0; iter < 8; iter++) {
          const roleShifts = state.shifts.filter((s) => s.date === date && roleOf(s) === role);
          type Entry = { shift: Shift; i: number; rawStart: number; rawEnd: number; cs: number; ce: number };
          const entries: Entry[] = [];
          for (const s of roleShifts) {
            const segs = s.segments ?? [{ startMinutes: s.startMinutes, endMinutes: s.endMinutes }];
            for (let i = 0; i < segs.length; i++) {
              const g = segs[i];
              if (g.startMinutes < block.endMinutes && g.endMinutes > block.startMinutes) {
                entries.push({
                  shift: s,
                  i,
                  rawStart: g.startMinutes,
                  rawEnd: g.endMinutes,
                  cs: Math.max(g.startMinutes, block.startMinutes),
                  ce: Math.min(g.endMinutes, block.endMinutes),
                });
              }
            }
          }
          if (entries.length === 0) break;
          const coveredBy = (list: Entry[], t: number) => list.some((e) => e.cs <= t && e.ce > t);
          let gap = -1;
          for (let t = block.startMinutes; t < block.endMinutes; t += 15) {
            if (!coveredBy(entries, t)) { gap = t; break; }
          }
          if (gap < 0) break; // Block ist lückenlos

          let fixed = false;
          const near = [...entries].sort((a, b) => Math.abs(a.cs - gap) - Math.abs(b.cs - gap));
          for (const e of near) {
            const len = e.rawEnd - e.rawStart;
            let ns = gap;
            let ne = gap + len;
            if (ne > block.endMinutes) { ne = block.endMinutes; ns = ne - len; }
            if (ns < block.startMinutes) continue;
            if (!(ns <= gap && ne > gap)) continue; // deckt die Lücke wirklich?
            const others = entries.filter((x) => x !== e);
            let vacatedOk = true;
            for (let t = e.cs; t < e.ce; t += 15) {
              if (!(t >= ns && t < ne) && !coveredBy(others, t)) { vacatedOk = false; break; }
            }
            if (!vacatedOk) continue;
            setSegment(e.shift, e.i, ns, ne);
            fixed = true;
            break;
          }

          if (!fixed) break; // keine sichere Verschiebung im Block möglich
        }
      }
    }
  }
}

/**
 * Letzter Feinschliff (Thienlong): verschiebt nur Beginn/Ende bzw. die
 * Aufteilung jeder Schicht innerhalb ihres Tages – Datum und bezahlte Minuten
 * bleiben, die Monats-Sollzahlen also exakt. Ziel je 30-Minuten-Slot und Rolle:
 * so viele Leute wie das Nachfrageprofil verlangt (quadratische Abweichung),
 * und NIE ein Slot ohne Bếp bzw. ohne Bồi. Zusätzlich bleiben die Tagesregeln
 * erhalten: zwei Öffner und abends (19:00) nicht schwächer als mittags (13:00).
 *
 * Geteilte Dienste sind an JEDEM Tag erlaubt (auch Fr–So, wo der Laden
 * durchgehend offen ist), damit Mittag UND Abend besetzt sind statt eines
 * überbesetzten Nachmittags. Kurze Stücke/Teilung sind nur weiche Regeln
 * (kleiner Aufschlag): Stück 2–6 h, mind. 1 h Pause dazwischen.
 */
/** Stoßzeit-Fenster für Teilzeit/Minijob: Mittag bzw. Abend. */
const TEILZEIT_PEAK_WINDOWS = [
  { startMinutes: 10 * 60 + 30, endMinutes: 15 * 60 },
  { startMinutes: 16 * 60 + 30, endMinutes: 22 * 60 },
] as const;

/**
 * Harte Regel (Thienlong): kein 30-Minuten-Slot eines offenen Tages ohne Bếp
 * bzw. ohne Bồi. Bleibt nach der Optimierung doch eine Lücke (z.B. Sonntag ohne
 * Vollzeit-Service, nur kurze Teilzeit-Einsätze), wird eine Kollegin/ein
 * Kollege derselben Rolle – Teilzeit zuerst – dort eingesetzt bzw. deren
 * Einsatz verlängert (Teilzeit dann bis 6 h). Die zusätzlichen Minuten werden
 * von den längsten eigenen Schichten an anderen Tagen abgezogen, sodass das
 * Monatssoll exakt bleibt.
 */
function repairRoleGaps(state: SchedulerState): boolean {
  if (!state.isThienlong) return false;
  const SLOT = 30;
  const GAP_SHIFT_MAX = 6 * 60; // am Stück ohne Pause
  const minPaidOf = (e: Employee) =>
    e.employmentType === "TEILZEIT" ? 2 * 60 : e.employmentType === "AZUBI" ? 3 * 60 : 5 * 60;
  const segmentsOf = (sh: Shift) =>
    sh.segments ?? [{ startMinutes: sh.startMinutes, endMinutes: sh.endMinutes }];
  const roleOf = (sh: Shift) => state.employeesById.get(sh.employeeId)?.workRole;
  const typeRank = (e: Employee) =>
    e.employmentType === "TEILZEIT" ? 0 : e.employmentType === "AZUBI" ? 1 : 2;

  /** Kürzt eine Schicht um 30 min (Ende des längsten Stücks). */
  const shorten = (sh: Shift): Shift => {
    const paid = sh.paidMinutes - SLOT;
    if (sh.segments && sh.segments.length > 1) {
      const segs = sh.segments.map((g) => ({ ...g }));
      const i = segs.reduce((best, g, k) =>
        g.endMinutes - g.startMinutes > segs[best].endMinutes - segs[best].startMinutes ? k : best, 0);
      segs[i].endMinutes -= SLOT;
      return { ...sh, segments: segs, paidMinutes: paid, endMinutes: segs[segs.length - 1].endMinutes };
    }
    const pause = calculatePause(paid);
    return { ...sh, paidMinutes: paid, pauseMinutes: pause, endMinutes: sh.startMinutes + paid + pause, segments: undefined };
  };

  /** Offene Slots einer Rolle an einem Tag (optional mit ersetzter Schicht). */
  const roleGapsOn = (date: string, role: WorkRole | undefined, swap?: [Shift, Shift]): number => {
    const day = state.dayOf(date);
    if (day.closed || !role) return 0;
    const list = state.shifts
      .filter((sh) => sh.date === date && roleOf(sh) === role)
      .map((sh) => (swap && sh === swap[0] ? swap[1] : sh));
    let n = 0;
    for (const b of day.blocks) {
      for (let t = b.startMinutes; t + SLOT <= b.endMinutes; t += SLOT) {
        if (!list.some((x) => segmentsOf(x).some((q) => q.startMinutes <= t && q.endMinutes >= t + SLOT))) n += 1;
      }
    }
    return n;
  };
  /** Darf diese Schicht um 30 min kürzer werden, ohne dort eine Lücke zu reißen? */
  const canShorten = (sh: Shift, e: Employee) =>
    sh.paidMinutes - SLOT >= minPaidOf(e) &&
    roleGapsOn(sh.date, e.workRole, [sh, shorten(sh)]) <= roleGapsOn(sh.date, e.workRole);

  /** Nimmt `minutes` von anderen Tagen der Person weg; false, wenn nicht genug Luft. */
  const takeFromOtherDays = (e: Employee, exceptDate: string, minutes: number): boolean => {
    const own = () => state.shifts.filter((sh) => sh.employeeId === e.id && sh.date !== exceptDate);
    const slack = own().reduce((a, sh) => a + Math.max(0, sh.paidMinutes - minPaidOf(e)), 0);
    if (slack < minutes) return false;
    // Zuerst an Tagen kürzen, an denen die Rolle am stärksten besetzt ist –
    // dort reißt das Kürzen keine neue Lücke.
    const sameRoleCount = (d: string) =>
      state.shifts.filter((sh) => sh.date === d && roleOf(sh) === e.workRole).length;
    // Ganz oder gar nicht: reicht die Luft nicht, alles zurückdrehen.
    const done: [Shift, Shift][] = [];
    for (let left = minutes; left > 0; left -= SLOT) {
      const longest = own()
        .filter((sh) => canShorten(sh, e))
        .sort(
          (a, b) =>
            sameRoleCount(b.date) - sameRoleCount(a.date) || b.paidMinutes - a.paidMinutes,
        )[0];
      if (!longest) {
        for (const [before, after] of done.reverse()) {
          removeShift(state, after);
          applyShift(state, before);
        }
        return false;
      }
      const next = shorten(longest);
      removeShift(state, longest);
      applyShift(state, next);
      done.push([longest, next]);
    }
    return true;
  };

  let changed = false;
  for (const date of state.dates) {
    const day = state.dayOf(date);
    if (day.closed) continue;
    for (const role of ["KITCHEN", "SERVICE"] as const) {
      for (let guard = 0; guard < 6; guard++) {
        // Erste Lücke (zusammenhängend) dieser Rolle suchen.
        const roleShifts = state.shifts.filter((sh) => sh.date === date && roleOf(sh) === role);
        let gap: { block: ResolvedDay["blocks"][number]; start: number; end: number } | null = null;
        for (const block of day.blocks) {
          for (let t = block.startMinutes; t + SLOT <= block.endMinutes; t += SLOT) {
            const covered = roleShifts.some((sh) =>
              segmentsOf(sh).some((g) => g.startMinutes <= t && g.endMinutes >= t + SLOT),
            );
            if (!covered) {
              if (!gap) gap = { block, start: t, end: t + SLOT };
              else if (gap.block === block && gap.end === t) gap.end = t + SLOT;
            }
          }
          if (gap) break;
        }
        if (!gap) break;

        const candidates = [...state.employeesById.values()]
          .filter((e) => e.workRole === role && e.targetMinutes > 0)
          .sort((a, b) => typeRank(a) - typeRank(b));
        const gapCount = (list: Shift[]) => {
          let n = 0;
          for (const b of day.blocks) {
            for (let t = b.startMinutes; t + SLOT <= b.endMinutes; t += SLOT) {
              const hit = list.some((x) =>
                segmentsOf(x).some((q) => q.startMinutes <= t && q.endMinutes >= t + SLOT),
              );
              if (!hit) n += 1;
            }
          }
          return n;
        };
        const weekOk = (e: Employee, extra: number) => {
          const weekCap = weeklyCapMinutes(e);
          if (weekCap === null) return true;
          const used = state.weekMinutes.get(e.id)!.get(weekKeyOf(date)) ?? 0;
          return used + extra <= weekCap + AZUBI_WEEKLY_TARGET_FLEX_HOURS * 60;
        };
        let fixed = false;

        // (a) Geteilten Dienst derselben Rolle verlängern: das Stück im Block
        //     der Lücke Richtung Lücke ziehen (Stück ≤ 6 h, Tag ≤ 10 h).
        for (const sh of roleShifts) {
          if (fixed) break;
          if (!sh.segments || sh.segments.length < 2) continue;
          const e = state.employeesById.get(sh.employeeId)!;
          const segs = sh.segments.map((g) => ({ ...g }));
          const g = segs.find(
            (x) => x.startMinutes >= gap!.block.startMinutes && x.endMinutes <= gap!.block.endMinutes,
          );
          if (!g) continue;
          if (gap.start >= g.endMinutes) g.endMinutes = Math.min(gap.end, g.startMinutes + GAP_SHIFT_MAX);
          else if (gap.end <= g.startMinutes) g.startMinutes = Math.max(gap.start, g.endMinutes - GAP_SHIFT_MAX);
          else continue;
          const paid = segs.reduce((a, x) => a + x.endMinutes - x.startMinutes, 0);
          const extra = paid - sh.paidMinutes;
          const next: Shift = {
            ...sh,
            segments: segs,
            startMinutes: segs[0].startMinutes,
            endMinutes: segs[segs.length - 1].endMinutes,
            paidMinutes: paid,
            pauseMinutes: 0,
            shiftType: "CUSTOM",
          };
          if (paid > MAX_DAILY_MINUTES || extra <= 0 || !weekOk(e, extra)) continue;
          if (gapCount(roleShifts.map((x) => (x === sh ? next : x))) >= gapCount(roleShifts)) continue;
          if (!takeFromOtherDays(e, date, extra)) continue;
          removeShift(state, sh);
          applyShift(state, next);
          fixed = true;
          changed = true;
        }

        // (b) Einen Einsatz am Stück in die Lücke verlegen (Länge bleibt), wenn
        //     dadurch insgesamt weniger Lücken bleiben.
        for (const sh of roleShifts) {
          if (fixed) break;
          if (sh.segments && sh.segments.length > 1) continue;
          const len = sh.endMinutes - sh.startMinutes;
          const start = Math.min(gap.start, gap.block.endMinutes - len);
          if (start < gap.block.startMinutes) continue;
          const moved: Shift = { ...sh, startMinutes: start, endMinutes: start + len };
          if (gapCount(roleShifts.map((x) => (x === sh ? moved : x))) >= gapCount(roleShifts)) continue;
          removeShift(state, sh);
          applyShift(state, moved);
          fixed = true;
          changed = true;
        }

        for (const e of candidates) {
          if (fixed) break;
          const existing = state.shifts.find((sh) => sh.employeeId === e.id && sh.date === date);
          if (existing && existing.segments && existing.segments.length > 1) continue;
          if (!existing) {
            if (!matchesEmployeeDayRules(state, e, date)) continue;
            if (consecutiveRunLengthWith(state.worked.get(e.id)!, date) > 6) continue;
            const cap = desiredWeeklyDayCap(state, e);
            if (Number.isFinite(cap)) {
              const week = weekKeyOf(date);
              const days = [...state.worked.get(e.id)!].filter((d) => weekKeyOf(d) === week).length;
              if (days >= cap) continue;
            }
          }
          // Neuer bzw. verlängerter Einsatz am Stück, der die Lücke abdeckt.
          let start = gap.start;
          let end = Math.min(gap.end, gap.start + GAP_SHIFT_MAX);
          if (existing) {
            if (existing.startMinutes < gap.block.startMinutes || existing.endMinutes > gap.block.endMinutes) continue;
            if (existing.paidMinutes >= GAP_SHIFT_MAX) continue;
            // Richtung Lücke verlängern, höchstens auf 6 h am Stück.
            if (gap.start >= existing.endMinutes) {
              start = existing.startMinutes;
              end = Math.min(gap.end, existing.startMinutes + GAP_SHIFT_MAX);
            } else if (gap.end <= existing.startMinutes) {
              end = existing.endMinutes;
              start = Math.max(gap.start, existing.endMinutes - GAP_SHIFT_MAX);
            } else {
              start = Math.min(gap.start, existing.startMinutes);
              end = Math.max(gap.end, existing.endMinutes);
              if (end - start > GAP_SHIFT_MAX) continue;
            }
            // Deckt der verlängerte Einsatz den Lückenbeginn überhaupt ab?
            if (!(start <= gap.start && end > gap.start) && !(start < gap.end && end >= gap.end)) continue;
          }
          while (end - start < minPaidOf(e) && (start > gap.block.startMinutes || end < gap.block.endMinutes)) {
            if (end < gap.block.endMinutes) end += SLOT;
            else start -= SLOT;
          }
          const paid = end - start; // ≤ 6 h => keine Pause
          const extra = paid - (existing?.paidMinutes ?? 0);
          if (!weekOk(e, extra)) continue;
          if (!takeFromOtherDays(e, date, extra)) continue;
          if (existing) removeShift(state, existing);
          applyShift(state, {
            id: existing?.id ?? nextShiftId(),
            employeeId: e.id,
            date,
            startMinutes: start,
            endMinutes: end,
            pauseMinutes: 0,
            paidMinutes: paid,
            shiftType: "CUSTOM",
            generated: true,
          });
          fixed = true;
          changed = true;
          break;
        }
        if (!fixed) break; // niemand verfügbar – bleibt als Warnung sichtbar
      }
    }
  }
  return changed;
}

function optimizeThienlongPlacement(state: SchedulerState): void {
  if (!state.isThienlong) return;
  const SLOT = 30;
  const MIN_PIECE = 2 * 60;
  const MAX_PIECE = 6 * 60;
  const MIN_GAP = 60;
  const segmentsOf = (sh: Shift) =>
    sh.segments ?? [{ startMinutes: sh.startMinutes, endMinutes: sh.endMinutes }];

  for (const date of state.dates) {
    const day = state.dayOf(date);
    if (day.closed || day.blocks.length === 0) continue;
    const dayShifts = state.shifts.filter((sh) => sh.date === date);
    if (dayShifts.length === 0) continue;
    const weekday = weekdayKeyOf(parseIsoDate(date));
    const isHoliday = state.holidays.has(date);
    const openMinutes = day.blocks[0].startMinutes;
    const slots: number[] = [];
    for (const b of day.blocks) for (let t = b.startMinutes; t + SLOT <= b.endMinutes; t += SLOT) slots.push(t);
    const slotIndex = new Map(slots.map((t, i) => [t, i]));
    const lunchIdx = slots.findIndex((t) => t <= 13 * 60 && t + SLOT > 13 * 60);
    const dinnerIdx = slots.findIndex((t) => t <= 19 * 60 && t + SLOT > 19 * 60);
    const blockOf = (start: number, end: number) =>
      day.blocks.find((b) => b.startMinutes <= start && end <= b.endMinutes);

    const roleOf = (sh: Shift): WorkRole => state.employeesById.get(sh.employeeId)?.workRole ?? "SERVICE";
    const roles = (["KITCHEN", "SERVICE"] as const).filter((r) => dayShifts.some((sh) => roleOf(sh) === r));

    // Soll-Köpfe je Slot und Rolle: Nachfrageprofil, skaliert auf die
    // tatsächlich verplanten Minuten dieser Rolle an diesem Tag.
    const need = new Map<WorkRole, number[]>();
    const have = new Map<WorkRole, number[]>();
    for (const role of roles) {
      const paid = dayShifts.filter((sh) => roleOf(sh) === role).reduce((acc, sh) => acc + sh.paidMinutes, 0);
      const intervals = clipDemandIntervals(thienlongDemandIntervals(weekday, role, 1000, isHoliday), day.blocks);
      const raw = slots.map((t) => {
        const iv = intervals.find((i) => i.startMinutes <= t && i.endMinutes > t);
        return iv ? iv.personMinutes / (iv.endMinutes - iv.startMinutes) : 0;
      });
      const rawSum = raw.reduce((acc, x) => acc + x, 0) * SLOT;
      need.set(role, raw.map((x) => (rawSum > 0 ? (x * paid) / rawSum : 0)));
      have.set(role, slots.map(() => 0));
    }

    // Belegung einer Platzierung als Slot-Indizes (+ weicher Aufschlag).
    type Placement = { idx: number[]; opens: boolean; penalty: number; apply: (sh: Shift) => void };
    const placementOf = (segs: ShiftSegment[], pause: number, split: boolean): Placement => {
      const idx: number[] = [];
      for (const g of segs) for (let t = g.startMinutes; t + SLOT <= g.endMinutes; t += SLOT) {
        const i = slotIndex.get(t);
        if (i !== undefined) idx.push(i);
      }
      let penalty = 0;
      if (split && day.blocks.length === 1) penalty += 0.3;
      for (const g of segs) if (split && g.endMinutes - g.startMinutes < MIN_SPLIT_SEGMENT_MINUTES) penalty += 0.4;
      return {
        idx,
        opens: segs[0].startMinutes === openMinutes,
        penalty,
        apply: (sh) => {
          sh.startMinutes = segs[0].startMinutes;
          sh.endMinutes = segs[segs.length - 1].endMinutes;
          sh.pauseMinutes = pause;
          sh.segments = split ? segs.map((g) => ({ ...g })) : undefined;
          sh.shiftType = "CUSTOM";
        },
      };
    };
    const current = (sh: Shift): Placement => {
      const split = !!sh.segments && sh.segments.length > 1;
      return placementOf(segmentsOf(sh).map((g) => ({ ...g })), sh.pauseMinutes, split);
    };
    const isPeakOnly = (sh: Shift) =>
      state.employeesById.get(sh.employeeId)?.employmentType === "TEILZEIT";
    const candidatesFor = (sh: Shift): Placement[] => {
      const out: Placement[] = [];
      const paid = sh.paidMinutes;
      const pause = calculatePause(paid);
      const presence = paid + pause;
      if (isPeakOnly(sh)) {
        // Teilzeit/Minijob: ein kurzer Einsatz am Stück, möglichst nur Mittag
        // ODER Abend. Außerhalb davon nur, wenn sonst niemand die Rolle
        // abdeckt (hoher Aufschlag, aber kleiner als ein leerer Slot).
        for (const b of day.blocks) {
          for (let start = b.startMinutes; start + presence <= b.endMinutes; start += SLOT) {
            const pl = placementOf([{ startMinutes: start, endMinutes: start + presence }], pause, false);
            const inPeak = TEILZEIT_PEAK_WINDOWS.some(
              (w) => start >= w.startMinutes && start + presence <= w.endMinutes,
            );
            if (!inPeak) pl.penalty += 50;
            out.push(pl);
          }
        }
        return out;
      }
      for (const b of day.blocks) {
        for (let start = b.startMinutes; start + presence <= b.endMinutes; start += SLOT) {
          out.push(placementOf([{ startMinutes: start, endMinutes: start + presence }], pause, false));
        }
      }
      for (let first = MIN_PIECE; first <= Math.min(MAX_PIECE, paid - MIN_PIECE); first += SLOT) {
        const second = paid - first;
        if (second > MAX_PIECE) continue;
        for (const t1 of slots) {
          if (!blockOf(t1, t1 + first)) continue;
          for (const t2 of slots) {
            if (t2 < t1 + first + MIN_GAP) continue;
            if (!blockOf(t2, t2 + second)) continue;
            out.push(placementOf(
              [{ startMinutes: t1, endMinutes: t1 + first }, { startMinutes: t2, endMinutes: t2 + second }],
              0,
              true,
            ));
          }
        }
      }
      return out;
    };

    const placements = new Map<Shift, Placement>(dayShifts.map((sh) => [sh, current(sh)]));
    let openers = 0;
    for (const [sh, pl] of placements) {
      for (const i of pl.idx) have.get(roleOf(sh))![i] += 1;
      if (pl.opens) openers += 1;
    }
    const total = (i: number) => roles.reduce((acc, r) => acc + have.get(r)![i], 0);
    const slotCost = (role: WorkRole, i: number, count: number) =>
      (count - need.get(role)![i]) ** 2 + (count === 0 ? 1000 : 0);
    const dayRuleCost = (openCount: number, lunch: number, dinner: number) =>
      300 * Math.max(0, Math.min(2, dayShifts.length) - openCount) +
      300 * Math.max(0, lunch - dinner);

    for (let pass = 0; pass < 6; pass++) {
      let improved = false;
      for (const sh of dayShifts) {
        const role = roleOf(sh);
        const h = have.get(role)!;
        const cur = placements.get(sh)!;
        // Schicht vorübergehend herausnehmen.
        for (const i of cur.idx) h[i] -= 1;
        const baseOpeners = openers - (cur.opens ? 1 : 0);
        const baseLunch = lunchIdx >= 0 ? total(lunchIdx) : 0;
        const baseDinner = dinnerIdx >= 0 ? total(dinnerIdx) : 0;
        const scoreOf = (pl: Placement) => {
          let c = pl.penalty;
          for (const i of pl.idx) c += slotCost(role, i, h[i] + 1) - slotCost(role, i, h[i]);
          const inLunch = lunchIdx >= 0 && pl.idx.includes(lunchIdx) ? 1 : 0;
          const inDinner = dinnerIdx >= 0 && pl.idx.includes(dinnerIdx) ? 1 : 0;
          c += dayRuleCost(baseOpeners + (pl.opens ? 1 : 0), baseLunch + inLunch, baseDinner + inDinner);
          return c;
        };
        const candidates = candidatesFor(sh);
        // Teilzeit-Einsätze werden immer aus der Kandidatenliste gewählt (dort
        // ist der Stoßzeit-Aufschlag eingepreist) – ein geteilter Altstand zählt nicht.
        let best = cur;
        let bestScore = isPeakOnly(sh) ? Number.POSITIVE_INFINITY : scoreOf(cur) - 1e-6;
        for (const pl of candidates) {
          const sc = scoreOf(pl);
          if (sc < bestScore) {
            bestScore = sc;
            best = pl;
          }
        }
        for (const i of best.idx) h[i] += 1;
        openers = baseOpeners + (best.opens ? 1 : 0);
        if (best !== cur) {
          placements.set(sh, best);
          best.apply(sh);
          improved = true;
        }
      }
      if (!improved) break;
    }
  }
}

/**
 * Jede Rolle (Bếp/Bồi) muss an JEDEM offenen Tag mindestens EINMAL vorkommen.
 * Fehlt eine Rolle ganz (z.B. kein Bồi an einem Sonntag in der Azubi-Schulzeit),
 * wird eine Schicht dieser Rolle von einem Tag mit Überschuss (≥2 gleiche Rolle)
 * hierher verschoben. Datum/Länge bleiben – nur der Tag wechselt, damit die
 * Monats-Sollzahlen exakt bleiben. Läuft VOR der Öffnungs-/Schluss-Reparatur.
 */
function repairRoleDayPresence(state: SchedulerState): void {
  if (!state.isThienlong) return;
  const roleOf = (shift: Shift): WorkRole | undefined =>
    state.employeesById.get(shift.employeeId)?.workRole;

  for (const role of ["KITCHEN", "SERVICE"] as const) {
    for (const date of state.dates) {
      const day = state.dayOf(date);
      if (day.closed || maxPaidForDay(day) === 0) continue;
      const hasRole = () => state.shifts.some((s) => s.date === date && roleOf(s) === role);
      if (hasRole()) continue;

      // Spender-Tage mit den meisten gleichrollen Schichten zuerst.
      const donorDates = [...new Set(state.shifts.filter((s) => roleOf(s) === role).map((s) => s.date))]
        .filter((d) => d !== date)
        .map((d) => ({ d, n: state.shifts.filter((s) => s.date === d && roleOf(s) === role).length }))
        .filter((x) => x.n >= 2)
        .sort((a, b) => b.n - a.n)
        .map((x) => x.d);

      let moved = false;
      for (const donor of donorDates) {
        if (moved) break;
        const roleShifts = state.shifts.filter((s) => s.date === donor && roleOf(s) === role);
        for (const shift of roleShifts) {
          const emp = state.employeesById.get(shift.employeeId);
          if (!emp) continue;
          const worked = state.worked.get(emp.id)!;
          if (worked.has(date)) continue;
          if (!matchesEmployeeDayRules(state, emp, date)) continue;
          if (maxPaidForDay(day) < shift.paidMinutes) continue;
          const prof = thienlongStaffingProfile(weekdayKeyOf(parseIsoDate(date)), state.holidays.has(date));
          if (state.dateState.get(date)!.count >= prof.maxStaff + state.extraStaff) continue;
          const trial = new Set(worked);
          trial.delete(donor);
          if (consecutiveRunLengthWith(trial, date) > 6) continue;
          if (exceedsWeeklyDayCap(state, emp, donor, date)) continue;
          const weekCap = weeklyCapMinutes(emp);
          if (weekCap !== null) {
            const wm = state.weekMinutes.get(emp.id)!;
            const used =
              (wm.get(weekKeyOf(date)) ?? 0) +
              shift.paidMinutes -
              (weekKeyOf(donor) === weekKeyOf(date) ? shift.paidMinutes : 0);
            if (used > weekCap) continue;
          }
          removeShift(state, shift);
          applyShift(state, makeRoleAwareShift(state, emp, date, shift.paidMinutes));
          moved = true;
          break;
        }
      }
    }
  }
}

/**
 * Harte Rollen-Abdeckung (Thienlong): An jedem offenen Tag muss JEDE Rolle
 * (Bếp/Bồi) sowohl die Öffnung als auch den Ladenschluss abdecken – sonst steht
 * z.B. bei Öffnung kein Koch oder zum Schluss kein Service da. Es werden nur
 * Anfangs-/Endzeiten umgelegt (Früh-/Spätanker), die bezahlten Minuten und das
 * Datum bleiben gleich, damit die Monats-Sollzahlen exakt erhalten bleiben.
 *
 * Läuft als LETZTER Schritt, hat also Vorrang vor der Quotenverteilung. Wo eine
 * Rolle an einem Tag nur eine (zu kurze) Schicht hat, lässt sich nicht beides
 * erzwingen – dann wird best­möglich die Öffnung gesichert.
 */
function repairRoleCoverage(state: SchedulerState): void {
  if (!state.isThienlong) return;
  const roleOf = (shift: Shift): WorkRole | undefined =>
    state.employeesById.get(shift.employeeId)?.workRole;
  const segmentsOf = (shift: Shift) =>
    shift.segments ?? [{ startMinutes: shift.startMinutes, endMinutes: shift.endMinutes }];

  for (const date of state.dates) {
    const day = state.dayOf(date);
    if (day.closed) continue;
    const openMinutes = day.blocks[0].startMinutes;
    const closeMinutes = day.blocks[day.blocks.length - 1].endMinutes;
    const coversOpen = (shift: Shift) =>
      segmentsOf(shift).some((seg) => seg.startMinutes <= openMinutes);
    const coversClose = (shift: Shift) =>
      segmentsOf(shift).some((seg) => seg.endMinutes >= closeMinutes);

    const longest = (list: Shift[]): Shift =>
      list.reduce((best, s) => (s.paidMinutes > best.paidMinutes ? s : best));

    for (const role of ["KITCHEN", "SERVICE"] as const) {
      const roleShifts = () => state.shifts.filter((s) => s.date === date && roleOf(s) === role);

      // Nur wenn die Rolle an dem Tag mindestens zwei Schichten hat, lassen sich
      // Öffnung UND Schluss belegen. Bei nur einer Schicht ist beides unmöglich –
      // dann bleibt die nachfrageoptimale (auf die Spitzen gelegte) Platzierung.
      let shifts = roleShifts();
      if (shifts.length < 2) continue;

      // 1) Öffnung sichern: die längste Rollenschicht als Frühanker legen. Lange
      //    Schichten decken über den geteilten Dienst die Öffnung verlässlich ab
      //    (Mittagsstück ab Ladenöffnung).
      if (!shifts.some(coversOpen)) {
        retypeShift(state, longest(shifts), "EARLY");
      }

      // 2) Ladenschluss sichern: die längste Rollenschicht als Spätanker legen,
      //    ohne die (evtl. einzige) Öffnungsschicht wieder zu opfern.
      shifts = roleShifts();
      if (!shifts.some(coversClose)) {
        const openers = shifts.filter(coversOpen);
        const pool = shifts.filter((s) => !(coversOpen(s) && openers.length <= 1));
        if (pool.length > 0) retypeShift(state, longest(pool), "LATE");
      }
    }
  }
}

/**
 * Öffnungs-Regel: an jedem offenen Tag sollen MINDESTENS ZWEI Schichten genau
 * zur Öffnungszeit beginnen (Validierung: „2 Personen zum Öffnen"). Reicht die
 * Rollen-Abdeckung dafür nicht (nur eine Öffnungsschicht), wird eine weitere
 * Schicht auf Frühanker gelegt – aber NUR, wenn sie danach wirklich zur Öffnung
 * beginnt UND dadurch keine Rolle ihren letzten Ladenschluss verliert. An sehr
 * dünn besetzten Tagen (zu wenig Personal) bleibt die Warnung bewusst stehen.
 */
function repairOpeningCount(state: SchedulerState): void {
  if (state.isVietpho) return; // Vietpho hat eigene Peak-Validierung, keine Öffner-Regel
  const roleOf = (shift: Shift): WorkRole | undefined =>
    state.employeesById.get(shift.employeeId)?.workRole;
  const segmentsOf = (shift: Shift) =>
    shift.segments ?? [{ startMinutes: shift.startMinutes, endMinutes: shift.endMinutes }];

  for (const date of state.dates) {
    const day = state.dayOf(date);
    if (day.closed) continue;
    const openMinutes = day.blocks[0].startMinutes;
    const closeMinutes = day.blocks[day.blocks.length - 1].endMinutes;
    const onDay = () => state.shifts.filter((s) => s.date === date);

    if (onDay().length < 2) continue; // mit einer Schicht sind keine zwei Öffner möglich
    const opensAt = (s: Shift) =>
      (s.segments?.[0]?.startMinutes ?? s.startMinutes) === openMinutes;
    const coversClose = (s: Shift) => segmentsOf(s).some((g) => g.endMinutes >= closeMinutes);
    // Würde die Schicht als Frühanker tatsächlich zur Öffnung beginnen?
    const canOpen = (s: Shift): boolean => {
      const presence = presenceFromPaid(s.paidMinutes);
      if (day.blocks[0].endMinutes - day.blocks[0].startMinutes >= presence) return true;
      return day.blocks.length >= 2 && buildSplitShift(s.paidMinutes, "EARLY", day.blocks) !== null;
    };
    // Priorität einer Kandidatenschicht: kleiner = lieber verschieben.
    // 0 = verliert keinen letzten Schließer · 1 = letzter Bồi-Schließer (Notnagel)
    // · 2 = letzter Bếp-Schließer (nur wenn gar nichts anderes geht).
    const penalty = (s: Shift, lastCloserRoles: Set<WorkRole | undefined>): number => {
      if (!coversClose(s) || !lastCloserRoles.has(roleOf(s))) return 0;
      return roleOf(s) === "KITCHEN" ? 2 : 1;
    };

    const tried = new Set<string>();
    while (onDay().filter(opensAt).length < 2) {
      const shifts = onDay();
      const closerCount = new Map<WorkRole | undefined, number>();
      for (const s of shifts) {
        if (coversClose(s)) closerCount.set(roleOf(s), (closerCount.get(roleOf(s)) ?? 0) + 1);
      }
      const lastCloserRoles = new Set(
        [...closerCount.entries()].filter(([, n]) => n <= 1).map(([r]) => r),
      );
      const cand = shifts
        .filter((s) => !tried.has(s.id) && !opensAt(s) && canOpen(s))
        .sort(
          (a, b) =>
            penalty(a, lastCloserRoles) - penalty(b, lastCloserRoles) ||
            a.paidMinutes - b.paidMinutes,
        )[0];
      if (!cand) break; // kein möglicher Frühanker mehr
      tried.add(cand.id);
      retypeShift(state, cand, "EARLY");
    }
  }
}

/**
 * Abend NIE schwächer als Mittag: das Abendgeschäft ist stärker, also sollen zum
 * Abend-Peak (19:00) mindestens so viele Leute da sein wie zum Mittag (13:00).
 * Ist es weniger, wird eine reine Mittagsschicht auf den Abend gelegt – aber nur
 * wenn danach (a) jede Rolle mittags noch besetzt ist, (b) noch zwei Öffner
 * bleiben und (c) die Schicht abends wirklich zählt.
 */
function repairEveningPeak(state: SchedulerState): void {
  if (state.isVietpho) return;
  const segmentsOf = (s: Shift) =>
    s.segments ?? [{ startMinutes: s.startMinutes, endMinutes: s.endMinutes }];
  const roleOf = (s: Shift): WorkRole | undefined =>
    state.employeesById.get(s.employeeId)?.workRole;
  const LUNCH = 13 * 60;
  const DINNER = 19 * 60;
  const at = (s: Shift, t: number) => segmentsOf(s).some((g) => g.startMinutes <= t && g.endMinutes > t);

  for (const date of state.dates) {
    const day = state.dayOf(date);
    if (day.closed) continue;
    const openMinutes = day.blocks[0].startMinutes;
    const onDay = () => state.shifts.filter((s) => s.date === date);
    const opensAt = (s: Shift) => (s.segments?.[0]?.startMinutes ?? s.startMinutes) === openMinutes;

    let guard = 0;
    while (guard++ < onDay().length) {
      const shifts = onDay();
      const lunch = shifts.filter((s) => at(s, LUNCH)).length;
      const dinner = shifts.filter((s) => at(s, DINNER)).length;
      if (dinner >= lunch) break;

      // reine Mittagsschichten (mittags da, abends nicht), die abends zählen würden
      const openers = shifts.filter(opensAt).length;
      const cand = shifts
        .filter((s) => {
          if (!at(s, LUNCH) || at(s, DINNER)) return false; // muss Mittag→nicht-Abend sein
          // Als Spätschicht muss sie abends wirklich zählen.
          const p = presenceFromPaid(s.paidMinutes);
          const last = day.blocks[day.blocks.length - 1];
          if (last.endMinutes - last.startMinutes < p && day.blocks.length < 2) return false;
          // Mittag muss für ihre Rolle noch besetzt bleiben.
          const roleLunchOthers = shifts.filter(
            (o) => o.id !== s.id && roleOf(o) === roleOf(s) && at(o, LUNCH),
          ).length;
          if (roleLunchOthers < 1) return false;
          // Zwei Öffner müssen bleiben.
          if (opensAt(s) && openers <= 2) return false;
          return true;
        })
        .sort((a, b) => a.paidMinutes - b.paidMinutes)[0];
      if (!cand) break;
      retypeShift(state, cand, "LATE");
      if (!at(cand, DINNER)) break; // hat nicht geholfen -> abbrechen
    }
  }
}

/** Fallback only for genuinely impossible inputs; no speculative monthly cap. */
function buildUnmetMessage(
  state: SchedulerState,
  unmet: Employee[],
  dates: string[],
  dayOf: (isoDate: string) => ResolvedDay,
): string {
  const openDays = dates.filter((date) => !dayOf(date).closed).length;
  const missing = unmet
    .map((e) => {
      const short = state.remaining.get(e.id)!;
      const done = (e.targetMinutes - short) / 60;
      return `${e.name}: ${done}h / ${e.targetMinutes / 60}h, còn thiếu ${short / 60}h`;
    })
    .join("; ");

  if (openDays === 0) {
    return (
      `Không xếp được ca nào (${missing}). ` +
      "Tháng này không có ngày mở cửa; hãy kiểm tra ngày đóng cửa và giờ làm."
    );
  }

  return (
    `Không xếp đủ định mức: ${missing}. ` +
    "Hãy kiểm tra ngày nghỉ cố định hoặc giờ mở cửa của tháng này."
  );
}

/**
 * Hauptfunktion: erzeugt die Schichten für den Monat.
 * Gibt eine neue Liste generierter Shifts zurück (verändert keine Eingaben).
 */
export function generateSchedule(input: GenerateInput): Shift[] {
  shiftIdCounter = 0;
  const { year, month, workHours, employees } = input;
  const holidays = input.holidays ?? holidaysOf(year, input.holidayState ?? "BW");
  const overrides = input.overrides ?? {};
  const isThienlong = input.storeId === "thienlong";
  const isVietpho = input.storeId === "vietpho";

  const effKeyOf = (isoDate: string): WeekdayKey => effectiveWeekdayKey(isoDate, holidays);
  const dayOf = (isoDate: string): ResolvedDay => resolveDay(workHours, isoDate, holidays, overrides);
  // Nachfrage-Gewicht: geschlossene Tage tragen 0 (bekommen keine Stunden).
  const weightOf = (isoDate: string): number => {
    if (dayOf(isoDate).closed) return 0;
    return isThienlong
      ? thienlongDemandWeight(
          weekdayKeyOf(parseIsoDate(isoDate)),
          holidays.has(isoDate),
        )
      : isVietpho
        ? vietphoDemandWeight(
            weekdayKeyOf(parseIsoDate(isoDate)),
            holidays.has(isoDate),
          )
        : DAY_WEIGHTS[effKeyOf(isoDate)];
  };
  const lateRatioOf = (isoDate: string): number =>
    isThienlong
      ? thienlongLateShiftRatio(
          weekdayKeyOf(parseIsoDate(isoDate)),
          holidays.has(isoDate),
        )
      : isVietpho
        ? vietphoLateShiftRatio(
            weekdayKeyOf(parseIsoDate(isoDate)),
            holidays.has(isoDate),
          )
        : LATE_SHIFT_RATIOS[effKeyOf(isoDate)];

  const dates = datesOfMonth(year, month);
  const totalTargetMin = employees.reduce((sum, e) => sum + e.targetMinutes, 0);
  const totalWeight = dates.reduce((sum, d) => sum + weightOf(d), 0);

  const rawTarget = isThienlong
    ? buildThienlongRawTargets(dates, totalTargetMin, weightOf)
    : new Map<string, number>(
        dates.map((d) => [
          d,
          totalWeight > 0 ? (totalTargetMin * weightOf(d)) / totalWeight : 0,
        ]),
      );
  const thienlongQuietDates = isThienlong
    ? dates.filter((date) => {
        if (dayOf(date).closed) return false;
        return thienlongStaffingProfile(
          weekdayKeyOf(parseIsoDate(date)),
          holidays.has(date),
        ).minHours > 0;
      })
    : [];
  const useThienlongStaffingBands =
    thienlongQuietDates.length > 0 &&
    thienlongQuietDates.every((date) => (rawTarget.get(date) ?? 0) >= 55 * 60);
  const openThienlongDates = isThienlong
    ? dates.filter((date) => !dayOf(date).closed && weightOf(date) > 0)
    : [];
  const minimumThienlongVisits = openThienlongDates.reduce((total, date) => {
    const profile = thienlongStaffingProfile(
      weekdayKeyOf(parseIsoDate(date)),
      holidays.has(date),
    );
    return total + profile.minStaff;
  }, 0);
  // A three-hour minimum visit is a conservative feasibility check. If the
  // workforce is smaller, keep proportional scheduling instead of forcing a
  // headcount promise it cannot satisfy.
  const useThienlongStaffingCounts =
    isThienlong &&
    employees.length >= 6 &&
    totalTargetMin >= minimumThienlongVisits * 3 * 60;

  const dateState = new Map<string, DateState>();
  const worked = new Map<string, Set<string>>();
  const weekendCount = new Map<string, number>();
  const remaining = new Map<string, number>();
  for (const d of dates) dateState.set(d, { totalPaid: 0, latePaid: 0, count: 0 });
  for (const e of employees) {
    worked.set(e.id, new Set());
    weekendCount.set(e.id, 0);
    remaining.set(e.id, e.targetMinutes);
  }

  const seed =
    input.seed ??
    `${year}-${month}-${employees.map((e) => `${e.id}:${e.targetMinutes}`).join("|")}`;

  const employeesById = new Map(employees.map((e) => [e.id, e] as const));
  const ordered = orderedEmployees(employees);

  // Tages-Soll je Rolle, gleiche Nachfrage-Gewichte wie das Gesamt-Soll.
  const roleTarget = new Map<WorkRole, Map<string, number>>();
  if (isThienlong) {
    for (const role of ["KITCHEN", "SERVICE"] as const) {
      const roleTotal = employees
        .filter((e) => e.workRole === role)
        .reduce((sum, e) => sum + e.targetMinutes, 0);
      if (roleTotal > 0) roleTarget.set(role, buildThienlongRawTargets(dates, roleTotal, weightOf));
    }
  }
  const n = ordered.length;

  /**
   * Ein kompletter Belegungsversuch. varyLengths=true mischt die Schichtlängen
   * (4..8 h statt immer die längste); das ist schöner, kann aber bei knappem
   * Soll die Tage aufbrauchen. Deshalb gibt es den zweiten, strengen Versuch.
   */
  function attempt(varyLengths: boolean, salt = "", staffBoost = 0): SchedulerState {
    shiftIdCounter = 0;
    const st: SchedulerState = {
      dates,
      rawTarget,
      dateState: new Map(dates.map((d) => [d, { totalPaid: 0, latePaid: 0, count: 0 }])),
      worked: new Map(employees.map((e) => [e.id, new Set<string>()])),
      weekendCount: new Map(employees.map((e) => [e.id, 0])),
      weekMinutes: new Map(employees.map((e) => [e.id, new Map<string, number>()])),
      remaining: new Map(employees.map((e) => [e.id, e.targetMinutes])),
      shifts: [],
      effKeyOf,
      lateRatioOf,
      holidays,
      employeesById,
      isThienlong,
      isVietpho,
      useThienlongStaffingBands,
      useThienlongStaffingCounts,
      dayOf,
      rng: seededRandom(seed + salt),
      varyLengths,
      roleTarget,
      plannedShifts: new Map(),
      extraStaff: 0,
      rigid: new Set(),
      paceWeight: new Map(),
    };
    for (const [role, targets] of roleTarget) {
      const weights = new Map<string, number>();
      for (const d of dates) {
        const heads = employees.filter(
          (e) => e.workRole === role && e.targetMinutes > 0 && matchesEmployeeDayRules(st, e, d),
        ).length;
        weights.set(d, (targets.get(d) ?? 0) / Math.max(1, heads));
      }
      st.paceWeight.set(role, weights);
    }
    for (const e of employees) {
      const planned = plannedShiftCount(st, e);
      st.plannedShifts.set(e.id, planned);
      if (planned === null || !Number.isFinite(desiredWeeklyDayCap(st, e))) continue;
      const eligible = dates.filter(
        (d) => !dayOf(d).closed && maxPaidForDay(dayOf(d)) > 0 && matchesEmployeeDayRules(st, e, d),
      ).length;
      if (planned >= eligible) st.rigid.add(e.id);
    }

    // Braucht das Team (Tage/Woche, „x ca") mehr Einsätze, als die Kopf-
    // Obergrenze je Tag zulässt, wird die Obergrenze gleichmäßig angehoben –
    // die Einstellungen der Mitarbeiter haben Vorrang.
    if (isThienlong && openThienlongDates.length > 0) {
      const visits = employees.reduce((sum, e) => {
        const planned = st.plannedShifts.get(e.id);
        // Ohne feste Planung zählt die kleinstmögliche Zahl Einsätze (10-h-Tage).
        return sum + (planned ?? Math.ceil(e.targetMinutes / MAX_DAILY_MINUTES));
      }, 0);
      const capacity = openThienlongDates.reduce(
        (sum, date) =>
          sum + thienlongStaffingProfile(weekdayKeyOf(parseIsoDate(date)), holidays.has(date)).maxStaff,
        0,
      );
      st.extraStaff = Math.max(0, Math.ceil((visits - capacity) / openThienlongDates.length));
    }
    if (isThienlong) {
      // Notlösung: das Monatssoll ist hart, die Kopf-Obergrenze nur weich.
      st.extraStaff += staffBoost;

    }

    placeRigidShifts(st);

    // Rundenweise, rotierend platzieren: pro Runde eine Schicht je Mitarbeiter,
    // bis jedes Monats-Soll exakt erreicht ist.
    for (let round = 0; ; round++) {
      if (ordered.every((e) => st.remaining.get(e.id)! <= 0)) break;
      let progress = false;
      for (let i = 0; i < n; i++) {
        const emp = ordered[(i + round) % n];
        if (st.remaining.get(emp.id)! <= 0) continue;
        if (placeOneShift(st, emp)) progress = true;
      }
      if (!progress) break; // keine Platzierung mehr möglich
    }
    return st;
  }

  const incomplete = (st: SchedulerState) =>
    employees.some((e) => st.remaining.get(e.id)! > 0);

  // Mehrere Anläufe mit gemischten Längen (jeweils anderer Zufallsstrom).
  // Klappt keiner, wird streng die längste Schicht genommen – damit ist das
  // Ergebnis nie schlechter als ohne Abwechslung.
  let state = attempt(true);
  for (let k = 1; k < 5 && incomplete(state); k++) {
    state = attempt(true, `#${k}`);
  }
  if (incomplete(state)) state = attempt(false);

  // Rest zuerst in bestehende Einsätze legen (keine zusätzlichen Köpfe).
  const finish = (st: SchedulerState) => {
    if (incomplete(st)) extendExistingShiftsToTargets(st);
    if (incomplete(st) && st.isThienlong) {
      extendExistingShiftsToTargets(st, AZUBI_WEEKLY_TARGET_FLEX_HOURS * 60);
    }
  };
  finish(state);

  // Reicht es trotzdem nicht, eine weitere Person je Tag erlauben (Thienlong):
  // das Monatssoll ist eine harte Regel, die Kopf-Obergrenze nur eine weiche.
  for (let k = 0; k < 3 && incomplete(state) && state.isThienlong; k++) {
    const retry = attempt(true, `+${k}`, 1);
    finish(retry);
    if (!incomplete(retry)) state = retry;
  }

  const unmet = employees.filter((e) => state.remaining.get(e.id)! > 0);
  if (unmet.length > 0) {
    throw new Error(buildUnmetMessage(state, unmet, dates, dayOf));
  }

  repairDemand(state, employeesById);
  if (state.isThienlong && (state.useThienlongStaffingBands || state.useThienlongStaffingCounts)) {
    repairThienlongStaffing(state);
  }
  if (state.isVietpho) balanceVietphoPeaks(state);
  else balanceShiftTypes(state);
  // Jede Rolle kommt an jedem offenen Tag mindestens einmal vor.
  repairRoleDayPresence(state);
  // Harte Regel zuletzt: jede Rolle deckt Öffnung UND Schluss ab.
  repairRoleCoverage(state);
  // Danach: möglichst zwei Öffner je Tag (ohne einen Ladenschluss zu opfern).
  repairOpeningCount(state);
  // Zum Schluss: Abend nie schwächer besetzt als Mittag.
  repairEveningPeak(state);
  // Ganz zuletzt: verbleibende Lücken innerhalb der Blöcke schließen.
  repairContinuousCoverage(state);
  // Feinschliff: Zeiten je Tag an das Nachfrageprofil anpassen (Dauer bleibt).
  optimizeThienlongPlacement(state);
  // Harte Regel: Lücken ohne Bếp/Bồi schließen, danach Zeiten neu ausrichten.
  for (let round = 0; round < 6 && repairRoleGaps(state); round++) {
    optimizeThienlongPlacement(state);
  }

  // Stabil sortieren: nach Datum, dann Startzeit, dann Mitarbeiter.
  state.shifts.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.startMinutes - b.startMinutes ||
      a.employeeId.localeCompare(b.employeeId),
  );
  return state.shifts;
}
