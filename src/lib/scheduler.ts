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

import type { Employee, Shift } from "../types";
import {
  DAY_WEIGHTS,
  LATE_SHIFT_RATIOS,
  datesOfMonth,
  parseIsoDate,
  weekdayKeyOf,
  type WeekdayKey,
} from "./demand";
import { getShiftTemplate, type TemplateType } from "./shifts";
import { consecutiveRunLengthWith, seededRandom } from "./consecutive";
import { presenceFromPaid } from "./time";
import {
  effectiveWeekdayKey,
  resolveDay,
  type ResolvedDay,
  type OverrideMap,
  type WorkHoursConfig,
} from "./workHours";
import { brandenburgHolidays } from "./holidays";

export type GenerateInput = {
  year: number;
  month: number; // 1-basiert
  /** Arbeitszeit-Fenster je Wochentag + Feiertag. */
  workHours: WorkHoursConfig;
  /** Ausnahmen für einzelne Daten (geschlossen / abweichende Zeiten). */
  overrides?: OverrideMap;
  employees: Employee[];
  /** Feiertage als ISO-Set; Standard: Brandenburger Feiertage des Jahres. */
  holidays?: Set<string>;
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
  remaining: Map<string, number>; // employeeId -> noch zu verplanende Minuten
  shifts: Shift[];
  /** Für Nachfrage/Spätquote maßgeblicher Wochentag (Feiertag = Sonntag). */
  effKeyOf: (isoDate: string) => WeekdayKey;
  /** Aufgelöster Tag (geschlossen? + Arbeitszeit-Fenster) für ein Datum. */
  dayOf: (isoDate: string) => ResolvedDay;
  rng: () => number;
  /** true = Schichtlängen mischen; false = immer die längste (Rückfallmodus). */
  varyLengths: boolean;
};

/** Länge des Zeitfensters in Minuten (0 wenn geschlossen). */
function windowLength(day: ResolvedDay): number {
  return day.closed ? 0 : day.window.endMinutes - day.window.startMinutes;
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

const SHIFT_HOURS_DESC = [8, 7, 6, 5, 4] as const;

/**
 * Erlaubte Schichtlängen je Anstellungsart (Vorgabe des Chefs):
 * Vollzeit 6/7/8 h, Teilzeit die volle Bandbreite 4..8 h.
 */
const ALLOWED_HOURS: Record<Employee["employmentType"], readonly number[]> = {
  VOLLZEIT: [6, 7, 8],
  TEILZEIT: [4, 5, 6, 7, 8],
};

/** Alle überhaupt zulässigen Längen – Rückfall, wenn das Fenster eng ist. */
const ALL_HOURS: readonly number[] = [4, 5, 6, 7, 8];

/**
 * Lässt sich `hours` restlos in Schichten aus `allowed` zerlegen?
 * Nötig, weil z.B. 11 h mit nur 6/7/8-h-Schichten nicht aufgeht – ohne diese
 * Prüfung liefe der Scheduler in eine Sackgasse und das Soll bliebe offen.
 */
const decomposeCache = new Map<string, boolean>();
function canDecompose(hours: number, allowed: readonly number[]): boolean {
  if (hours === 0) return true;
  if (hours < Math.min(...allowed)) return false;

  const key = `${allowed.length}:${hours}`;
  const cached = decomposeCache.get(key);
  if (cached !== undefined) return cached;

  let ok = false;
  for (const h of allowed) {
    if (canDecompose(hours - h, allowed)) {
      ok = true;
      break;
    }
  }
  decomposeCache.set(key, ok);
  return ok;
}

/** Längstmögliche Schicht je Anstellungsart – für die Kapazitätsrechnung. */
const PREFERRED_HOURS: Record<Employee["employmentType"], number> = {
  VOLLZEIT: 8,
  TEILZEIT: 8,
};

/** Größte Schichtlänge (Stunden), deren Anwesenheit noch ins Fenster passt (0 = keine). */
export function maxShiftHoursForWindow(windowMinutes: number): number {
  for (const hours of SHIFT_HOURS_DESC) {
    if (presenceFromPaid(hours * 60) <= windowMinutes) return hours;
  }
  return 0;
}

/**
 * Wählt die Länge (Stunden) der nächsten Schicht eines Mitarbeiters so, dass
 * - sie 4..8 h ist und ins Tagesfenster passt (<= maxHours),
 * - der verbleibende Rest exakt aufteilbar bleibt (0 oder >= 4 h),
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
): number {
  const remainingHours = remainingMinutes / 60;
  const cap = Math.min(8, maxHours, remainingHours);
  if (cap < 4) return 0;

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
  let valid = pick(ALLOWED_HOURS[employmentType]);
  if (valid.length === 0) valid = pick(ALL_HOURS);
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

  if (!rng) return pool[pool.length - 1];

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
    if (a.employmentType !== b.employmentType) {
      return a.employmentType === "VOLLZEIT" ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });
}

function chooseTemplateType(
  state: SchedulerState,
  isoDate: string,
  employmentType: Employee["employmentType"],
): TemplateType {
  const ds = state.dateState.get(isoDate)!;
  const effKey = state.effKeyOf(isoDate);
  const desired = LATE_SHIFT_RATIOS[effKey];
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
): Shift {
  const type = chooseTemplateType(state, isoDate, employee.employmentType);
  const win = state.dayOf(isoDate).window;
  const tpl = getShiftTemplate(paidMinutes / 60, type, win.startMinutes, win.endMinutes);
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

function applyShift(state: SchedulerState, shift: Shift): void {
  const ds = state.dateState.get(shift.date)!;
  ds.totalPaid += shift.paidMinutes;
  if (shift.shiftType === "LATE") ds.latePaid += shift.paidMinutes;
  ds.count += 1;
  state.worked.get(shift.employeeId)!.add(shift.date);
  if (isWeekend(shift.date)) {
    state.weekendCount.set(
      shift.employeeId,
      (state.weekendCount.get(shift.employeeId) ?? 0) + 1,
    );
  }
  state.shifts.push(shift);
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

  // Erst zählen, wie viele Tage überhaupt noch in Frage kommen. Daraus ergibt
  // sich das nötige Tempo (Stunden je verbleibendem Tag) – ohne das würde die
  // zufällige Längenwahl das Monats-Soll reißen.
  let daysLeft = 0;
  for (const isoDate of state.dates) {
    if (worked.has(isoDate)) continue;
    const day = state.dayOf(isoDate);
    if (day.closed) continue;
    if (maxShiftHoursForWindow(windowLength(day)) === 0) continue;
    if (consecutiveRunLengthWith(worked, isoDate) > 6) continue;
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
    const day = state.dayOf(isoDate);
    if (day.closed) continue; // Betriebsruhe -> kein Dienst

    // Längste Schicht, die ins Fenster passt UND den Rest exakt aufteilbar lässt.
    const maxHours = maxShiftHoursForWindow(windowLength(day));
    const hours = chooseShiftHours(
      remaining,
      maxHours,
      employee.employmentType,
      needHours,
      state.varyLengths ? state.rng : undefined,
    );
    if (hours === 0) continue; // hier passt keine gültige Schicht

    // Harte Regel. Früher gab es hier einen Ausweichtag, der diese Prüfung
    // übersprungen hat – dabei entstanden lautlos Pläne mit bis zu 28
    // Arbeitstagen am Stück. Lieber gar keinen Plan als einen unzulässigen:
    // ohne gültigen Tag bleibt das Soll offen und generateSchedule wirft.
    const runLength = consecutiveRunLengthWith(worked, isoDate);
    if (runLength > 6) continue;

    const ds = state.dateState.get(isoDate)!;
    const deficitHours = (state.rawTarget.get(isoDate)! - ds.totalPaid) / 60;
    const dayWeight = DAY_WEIGHTS[state.effKeyOf(isoDate)];

    const consecutivePenalty = runLength >= 5 ? (runLength - 4) * 8 : 0;
    const weekendPenalty = isWeekend(isoDate) ? weekendCount * 1.5 : 0;

    const jitter = state.rng() * 0.01; // deterministisch (seeded), nur Tie-Break

    const score =
      deficitHours * 10 +
      dayWeight * 3 -
      consecutivePenalty -
      weekendPenalty +
      jitter;

    if (score > bestScore) {
      bestScore = score;
      bestDate = isoDate;
      bestHours = hours;
    }
  }

  if (bestDate === null || bestHours === 0) return false;

  const shift = makeShift(state, employee, bestDate, bestHours * 60);
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
      const from = shift.date;
      const worked = state.worked.get(employee.id)!;

      let bestTarget: string | null = null;
      let bestDelta = -1e-6; // nur echte Verbesserungen

      const oldCostFrom = dateCost(state, from);

      const presence = presenceFromPaid(shift.paidMinutes);
      for (const to of state.dates) {
        if (to === from || worked.has(to)) continue;
        const day = state.dayOf(to);
        if (day.closed || windowLength(day) < presence) continue; // geschlossen / passt nicht
        // 6-Tage-Regel prüfen, als ob "from" bereits entfernt wäre.
        const trial = new Set(worked);
        trial.delete(from);
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
        applyShift(state, makeShift(state, employee, bestTarget, shift.paidMinutes));
        improved = true;
      }
    }
    if (!improved) break;
  }
}

/** Dreht NUR Früh/Spät um. Dauer bleibt gleich => Monats-Soll bleibt exakt. */
function retypeShift(state: SchedulerState, shift: Shift, type: TemplateType): void {
  if (shift.shiftType === type) return;
  const win = state.dayOf(shift.date).window;
  const tpl = getShiftTemplate(shift.paidMinutes / 60, type, win.startMinutes, win.endMinutes);
  const ds = state.dateState.get(shift.date)!;

  if (shift.shiftType === "LATE") ds.latePaid -= shift.paidMinutes;
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
    const desired = LATE_SHIFT_RATIOS[state.effKeyOf(isoDate)];

    // 1. Quote annähern: jeweils die Schicht drehen, die am meisten hilft.
    for (let step = 0; step < onDay.length * 2; step++) {
      if (ds.totalPaid === 0) break;
      let best: Shift | null = null;
      let bestDiff = Math.abs(ds.latePaid / ds.totalPaid - desired);
      for (const s of onDay) {
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

    const shortestOf = (list: Shift[]) =>
      list.length === 0 ? null : list.reduce((a, b) => (a.paidMinutes <= b.paidMinutes ? a : b));

    let flipped: Shift | null = null;
    if (!onDay.some((s) => s.startMinutes === day.window.startMinutes)) {
      const victim = shortestOf(onDay.filter((s) => s.shiftType === "LATE"));
      if (victim) {
        retypeShift(state, victim, "EARLY");
        flipped = victim;
      }
    }
    if (!onDay.some((s) => s.endMinutes === day.window.endMinutes)) {
      const victim = shortestOf(
        onDay.filter((s) => s.shiftType === "EARLY" && s !== flipped),
      );
      if (victim) retypeShift(state, victim, "LATE");
    }
  }
}

/**
 * Obergrenze für EINEN Mitarbeiter: wie viele Tage und Stunden im Monat
 * überhaupt möglich sind. Greedy von vorn – an jedem offenen Tag arbeiten,
 * solange die 6-Tage-Regel es zulässt; danach zwingend ein freier Tag.
 * Das ist das Maximum, mehr geht rein rechnerisch nicht.
 */
function monthCapacity(
  dates: string[],
  dayOf: (isoDate: string) => ResolvedDay,
  capHours = 8,
): { openDays: number; maxDays: number; maxMinutes: number } {
  let openDays = 0;
  let maxDays = 0;
  let maxMinutes = 0;
  let run = 0;

  for (const isoDate of dates) {
    const day = dayOf(isoDate);
    if (day.closed) {
      run = 0; // geschlossener Tag zählt als Pause
      continue;
    }
    openDays += 1;
    const hours = Math.min(maxShiftHoursForWindow(windowLength(day)), capHours);
    if (hours < 4) continue; // Fenster zu kurz für die kürzeste Schicht

    if (run >= 6) {
      run = 0; // Pflicht-Ruhetag
      continue;
    }
    run += 1;
    maxDays += 1;
    maxMinutes += hours * 60;
  }

  return { openDays, maxDays, maxMinutes };
}

/** Fehlermeldung, die auch sagt WARUM es nicht aufgeht. */
function buildUnmetMessage(
  state: SchedulerState,
  unmet: Employee[],
  dates: string[],
  dayOf: (isoDate: string) => ResolvedDay,
): string {
  const full = monthCapacity(dates, dayOf, PREFERRED_HOURS.VOLLZEIT);


  const missing = unmet
    .map((e) => {
      const short = state.remaining.get(e.id)!;
      const done = (e.targetMinutes - short) / 60;
      const capMin = full.maxMinutes;
      const overCap = e.targetMinutes > capMin ? ` — vượt trần ${capMin / 60}h` : "";
      return `${e.name} chỉ xếp được ${done}h / ${e.targetMinutes / 60}h${overCap}`;
    })
    .join("; ");

  if (full.maxDays === 0) {
    return (
      `Không xếp được ca nào (${missing}). ` +
      `Tháng này có ${full.openDays} ngày mở cửa nhưng khung giờ làm quá ngắn — ` +
      `không đủ cho cả ca ngắn nhất (4h). Hãy nới khung giờ làm ở tab Cài đặt.`
    );
  }

  // maxMinutes ist eine OBERGRENZE (jeden erlaubten Tag die längste Schicht).
  // Der greedy Scheduler erreicht sie nicht immer – daher als Decke formulieren.
  return (
    `Không xếp đủ định mức: ${missing}. ` +
    `Tháng này có ${full.openDays} ngày mở cửa; do quy tắc tối đa 6 ngày làm ` +
    `liên tiếp, mỗi người làm được nhiều nhất ${full.maxDays} ngày — trần lý ` +
    `thuyết ${full.maxMinutes / 60}h/người, thực tế thấp hơn. ` +
    `Hãy giảm định mức, nới khung giờ làm, bớt ngày đóng cửa, hoặc thêm người.`
  );
}

/**
 * Hauptfunktion: erzeugt die Schichten für den Monat.
 * Gibt eine neue Liste generierter Shifts zurück (verändert keine Eingaben).
 */
export function generateSchedule(input: GenerateInput): Shift[] {
  shiftIdCounter = 0;
  const { year, month, workHours, employees } = input;
  const holidays = input.holidays ?? brandenburgHolidays(year);
  const overrides = input.overrides ?? {};

  const effKeyOf = (isoDate: string): WeekdayKey => effectiveWeekdayKey(isoDate, holidays);
  const dayOf = (isoDate: string): ResolvedDay => resolveDay(workHours, isoDate, holidays, overrides);
  // Nachfrage-Gewicht: geschlossene Tage tragen 0 (bekommen keine Stunden).
  const weightOf = (isoDate: string): number =>
    dayOf(isoDate).closed ? 0 : DAY_WEIGHTS[effKeyOf(isoDate)];

  const dates = datesOfMonth(year, month);
  const totalTargetMin = employees.reduce((sum, e) => sum + e.targetMinutes, 0);
  const totalWeight = dates.reduce((sum, d) => sum + weightOf(d), 0);

  const rawTarget = new Map<string, number>();
  for (const d of dates) {
    rawTarget.set(d, totalWeight > 0 ? (totalTargetMin * weightOf(d)) / totalWeight : 0);
  }

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
      remaining: new Map(employees.map((e) => [e.id, e.targetMinutes])),
      shifts: [],
      effKeyOf,
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

  const unmet = employees.filter((e) => state.remaining.get(e.id)! > 0);
  if (unmet.length > 0) {
    throw new Error(buildUnmetMessage(state, unmet, dates, dayOf));
  }

  repairDemand(state, employeesById);
  balanceShiftTypes(state);

  // Stabil sortieren: nach Datum, dann Startzeit, dann Mitarbeiter.
  state.shifts.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.startMinutes - b.startMinutes ||
      a.employeeId.localeCompare(b.employeeId),
  );
  return state.shifts;
}
