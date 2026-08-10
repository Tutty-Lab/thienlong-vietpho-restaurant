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
} from "../types";
import { isEmployeeFixedDayOff } from "./fixedDaysOff";
import {
  DAY_WEIGHTS,
  LATE_SHIFT_RATIOS,
  datesOfMonth,
  parseIsoDate,
  weekdayKeyOf,
  type WeekdayKey,
} from "./demand";
import { buildSplitShift, getShiftTemplateForBlocks, type TemplateType } from "./shifts";
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
};

/**
 * Thienlong follows the configured weekday ratios first. The 55-60 hour
 * quiet-day band is only activated when the selected monthly targets can
 * support it without flattening the Friday/Saturday/Sunday ratios.
 */
function buildThienlongRawTargets(
  dates: readonly string[],
  totalTargetMinutes: number,
  weightOf: (isoDate: string) => number,
  dayOf: (isoDate: string) => ResolvedDay,
  holidays: Set<string>,
): Map<string, number> {
  const openDates = dates.filter((date) => !dayOf(date).closed && weightOf(date) > 0);
  const weightedTotal = openDates.reduce((sum, date) => sum + weightOf(date), 0);
  const weighted = new Map<string, number>(
    dates.map((date) => [
      date,
      weightedTotal > 0 ? (totalTargetMinutes * weightOf(date)) / weightedTotal : 0,
    ]),
  );

  const quietDates = openDates.filter((date) => {
    const profile = thienlongStaffingProfile(
      weekdayKeyOf(parseIsoDate(date)),
      holidays.has(date),
    );
    return profile.minHours > 0;
  });
  if (quietDates.length === 0) return weighted;

  const quietFloor = 55 * 60;
  const quietCeiling = 60 * 60;
  // Retain the proportional model when raising quiet days to the floor would
  // consume hours intended for the higher-weight Friday/Saturday/Sunday days.
  if (quietDates.some((date) => (weighted.get(date) ?? 0) < quietFloor)) {
    return weighted;
  }

  const busyDates = openDates.filter((date) => !quietDates.includes(date));

  const result = new Map(weighted);
  const quietMinutes = quietDates.reduce((sum, date) => {
    const target = Math.min(
      quietCeiling,
      Math.max(quietFloor, weighted.get(date) ?? 0),
    );
    result.set(date, target);
    return sum + target;
  }, 0);

  const remaining = totalTargetMinutes - quietMinutes;
  if (remaining < 0 || busyDates.length === 0) return weighted;

  const busyWeight = busyDates.reduce((sum, date) => sum + weightOf(date), 0);
  for (const date of busyDates) {
    result.set(date, busyWeight > 0 ? (remaining * weightOf(date)) / busyWeight : 0);
  }
  return result;
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

function allowedHoursFor(
  employmentType: Employee["employmentType"],
  profile: "default" | "thienlong" | "vietpho",
): readonly number[] {
  return profile === "vietpho"
    ? VIETPHO_ALLOWED_HOURS[employmentType]
    : ALLOWED_HOURS[employmentType];
}

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

const countedDecomposeCache = new WeakMap<readonly number[], Map<string, boolean>>();
function canDecomposeInCount(
  hours: number,
  allowed: readonly number[],
  count: number,
): boolean {
  if (count === 0) return hours === 0;
  const min = Math.min(...allowed);
  const max = Math.max(...allowed);
  if (hours < min * count || hours > max * count) return false;

  let byTarget = countedDecomposeCache.get(allowed);
  if (!byTarget) {
    byTarget = new Map<string, boolean>();
    countedDecomposeCache.set(allowed, byTarget);
  }
  const key = `${hours}:${count}`;
  const cached = byTarget.get(key);
  if (cached !== undefined) return cached;

  const result = allowed.some((item) => canDecomposeInCount(hours - item, allowed, count - 1));
  byTarget.set(key, result);
  return result;
}

function chooseFixedPatternHours(
  remainingMinutes: number,
  maxHours: number,
  employmentType: Employee["employmentType"],
  profile: "default" | "thienlong" | "vietpho",
  shiftsLeft: number,
): number {
  if (shiftsLeft <= 0) return 0;
  const remainingHours = remainingMinutes / 60;
  const allowed = allowedHoursFor(employmentType, profile);
  const cap = Math.min(maxHours, profile === "vietpho" ? 8 : 10, remainingHours);
  const minimumHours = Math.min(...allowed);
  const maximumHours = Math.max(...allowed);
  const minimumCount = Math.ceil(remainingHours / maximumHours);
  const maximumCount = Math.min(
    shiftsLeft,
    Math.floor(remainingHours / minimumHours),
  );
  let count = maximumCount;
  while (count >= minimumCount && !canDecomposeInCount(remainingHours, allowed, count)) {
    count -= 1;
  }
  if (count < minimumCount) return 0;
  const candidates = allowed.filter(
    (hours) =>
      hours <= cap &&
      canDecomposeInCount(remainingHours - hours, allowed, count - 1),
  );
  if (candidates.length === 0) return 0;

  const average = remainingHours / count;
  return [...candidates].sort(
    (a, b) => Math.abs(a - average) - Math.abs(b - average) || a - b,
  )[0];
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
    const minimumLunch = Math.max(60, paidMinutes - eveningCap);
    const maximumLunch = Math.min(lunchCap, paidMinutes - 60);

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

function matchesFixedStoreWeekPattern(
  state: SchedulerState,
  employee: Employee,
  isoDate: string,
): boolean {
  if (!employee.fixedStoreWeekPattern) return true;
  const weekday = weekdayKeyOf(parseIsoDate(isoDate));
  if (state.isVietpho) return weekday === "sunday";
  if (state.isThienlong) return weekday !== "sunday";
  return true;
}

function matchesEmployeeDayRules(
  state: SchedulerState,
  employee: Employee,
  isoDate: string,
): boolean {
  const storeId = state.isThienlong ? "thienlong" : state.isVietpho ? "vietpho" : undefined;
  return (
    !isEmployeeFixedDayOff(employee, isoDate, storeId) &&
    matchesFixedStoreWeekPattern(state, employee, isoDate)
  );
}

/**
 * Platziert genau eine Schicht für einen Mitarbeiter: bestes Datum wählen,
 * Schichtlänge an das Tagesfenster anpassen. Gibt true zurück, wenn platziert.
 */
function placeOneShift(state: SchedulerState, employee: Employee): boolean {
  const remaining = state.remaining.get(employee.id)!;
  if (remaining <= 0) return false;

  const worked = state.worked.get(employee.id)!;
  const weekendCount = state.weekendCount.get(employee.id) ?? 0;
  const weekCap = weeklyCapMinutes(employee);
  const weekUsed = state.weekMinutes.get(employee.id)!;

  // Erst zählen, wie viele Tage überhaupt noch in Frage kommen. Daraus ergibt
  // sich das nötige Tempo (Stunden je verbleibendem Tag) – ohne das würde die
  // zufällige Längenwahl das Monats-Soll reißen.
  let daysLeft = 0;
  for (const isoDate of state.dates) {
    if (worked.has(isoDate)) continue;
    if (!matchesEmployeeDayRules(state, employee, isoDate)) continue;
    const day = state.dayOf(isoDate);
    if (day.closed) continue;
    if (maxPaidForDay(day) === 0) continue;
    if (consecutiveRunLengthWith(worked, isoDate) > 6) continue;
    const weekKey = weekKeyOf(isoDate);
    if (weekCap !== null && (weekUsed.get(weekKey) ?? 0) >= weekCap) continue;
    daysLeft += 1;
  }
  // daysLeft ist eine Obergrenze: greedy belegt nie wirklich JEDEN erlaubten
  // Tag, weil die 6-Tage-Regel Lücken erzwingt. Ohne Sicherheitsabschlag wählt
  // der Zufall zu kurze Schichten und das Soll geht am Monatsende nicht auf.
  const usableDays = Math.max(1, Math.floor(daysLeft * 0.9));
  const needHours = daysLeft > 0 ? Math.ceil(remaining / 60 / usableDays) : 8;

  let bestDate: string | null = null;
  let bestHours = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const isoDate of state.dates) {
    if (worked.has(isoDate)) continue; // max. ein Dienst pro Tag
    if (!matchesEmployeeDayRules(state, employee, isoDate)) continue;
    const day = state.dayOf(isoDate);
    if (day.closed) continue; // Betriebsruhe -> kein Dienst
    const weekKey = weekKeyOf(isoDate);
    const ds = state.dateState.get(isoDate)!;
    const staffingProfile = state.isThienlong
      ? thienlongStaffingProfile(
          weekdayKeyOf(parseIsoDate(isoDate)),
          state.holidays.has(isoDate),
        )
      : null;
    if (staffingProfile && ds.count >= staffingProfile.maxStaff) continue;

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
    const hours = employee.fixedStoreWeekPattern
      ? chooseFixedPatternHours(
          remaining,
          dayCapMinutes / 60,
          employee.employmentType,
          profile,
          daysLeft,
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

    if (employee.fixedStoreWeekPattern) {
      bestDate = isoDate;
      bestHours = hours;
      break;
    }

    const deficitHours = (state.rawTarget.get(isoDate)! - ds.totalPaid) / 60;
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
        .sort((a, b) => b.available - a.available || a.shift.date.localeCompare(b.shift.date));

      const option = options[0];
      if (!option) break;

      const added = Math.min(remaining, option.available);
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
  const overStaff = Math.max(0, count - profile.maxStaff);

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
        if (employee.fixedStoreWeekPattern) continue;
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
        if (state.dateState.get(to)!.count >= targetProfile.maxStaff) continue;
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

        const delta = after - before;
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
      if (employee.fixedStoreWeekPattern) continue;
      // Moving a fixed-role Thienlong shift would undo its interval coverage.
      if (state.isThienlong && employee.workRole) continue;
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
          if (state.dateState.get(to)!.count >= profile.maxStaff) continue;
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

        const oldCostTo = dateCost(state, to);
        const newCostFrom = Math.abs(
          state.dateState.get(from)!.totalPaid - shift.paidMinutes - state.rawTarget.get(from)!,
        );
        const newCostTo = Math.abs(
          state.dateState.get(to)!.totalPaid + shift.paidMinutes - state.rawTarget.get(to)!,
        );
        const delta = newCostFrom + newCostTo - (oldCostFrom + oldCostTo);
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
    ? buildThienlongRawTargets(dates, totalTargetMin, weightOf, dayOf, holidays)
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
  const n = ordered.length;

  /**
   * Ein kompletter Belegungsversuch. varyLengths=true mischt die Schichtlängen
   * (4..8 h statt immer die längste); das ist schöner, kann aber bei knappem
   * Soll die Tage aufbrauchen. Deshalb gibt es den zweiten, strengen Versuch.
   */
  function attempt(varyLengths: boolean, salt = ""): SchedulerState {
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
    };

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

  if (incomplete(state)) extendExistingShiftsToTargets(state);
  if (incomplete(state) && state.isThienlong) {
    extendExistingShiftsToTargets(
      state,
      AZUBI_WEEKLY_TARGET_FLEX_HOURS * 60,
    );
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

  // Stabil sortieren: nach Datum, dann Startzeit, dann Mitarbeiter.
  state.shifts.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.startMinutes - b.startMinutes ||
      a.employeeId.localeCompare(b.employeeId),
  );
  return state.shifts;
}
