// ============================================================================
// Arbeitszeit-Fenster (giờ làm) je Wochentag + Feiertag. Das ist das Fenster,
// in dem Schichten geplant werden dürfen (Früh am Fenster-Beginn, Spät am
// Fenster-Ende). Feiertage (Brandenburg) werden für Nachfrage & Spätquote wie Sonntag
// behandelt, verwenden aber ihr eigenes Zeitfenster.
// ============================================================================

import { parseIsoDate, weekdayKeyOf, type WeekdayKey } from "./demand";

export type DayWindow = { startMinutes: number; endMinutes: number };

/**
 * Ein Tag besteht aus einem ODER zwei Blöcken. Zwei Blöcke = der Laden macht
 * mittags zu (Mo–Do 15:00–16:30). In dieser Lücke wird NICHT geplant, und weil
 * das Personal dann ohnehin ruht, gibt es keine gerechnete Pause mehr.
 *
 * Block 1 trägt die Frühschicht, der letzte Block die Spätschicht.
 */
export type DayBlocks = DayWindow[];

export type WorkHoursConfig = {
  perWeekday: Record<WeekdayKey, DayBlocks>;
  holiday: DayBlocks;
};

/**
 * Ausnahme für ein konkretes Datum (überschreibt Wochentag/Feiertag).
 * closed = an diesem Tag wird nicht geplant (z.B. Betriebsruhe);
 * window = abweichende Arbeitszeiten (z.B. halber Tag).
 */
export type DateOverride = {
  date: string; // ISO yyyy-MM-dd
  closed: boolean;
  window?: DayWindow;
  note?: string;
};

export type OverrideMap = Record<string, DateOverride>;

export type ResolvedDay = { closed: boolean; blocks: DayBlocks };

const w = (start: number, end: number): DayWindow => ({ startMinutes: start, endMinutes: end });

// Öffnungszeiten der beiden Filialen in Heidenheim:
//   Mo–Do  11:00–15:00 und 16:30–22:00 (mittags geschlossen)
//   Fr     11:00–22:00 durchgehend
//   Sa/So  12:00–22:00 durchgehend
const SPLIT_DAY: DayBlocks = [w(11 * 60, 15 * 60), w(16 * 60 + 30, 22 * 60)];
const FRIDAY: DayBlocks = [w(11 * 60, 22 * 60)];
const WEEKEND: DayBlocks = [w(12 * 60, 22 * 60)];

const clone = (blocks: DayBlocks): DayBlocks => blocks.map((b) => ({ ...b }));

/**
 * Version der Öffnungszeiten-Vorgabe. Hochzählen, sobald sich DEFAULT_WORK_HOURS
 * ändert: gespeicherte Stände mit älterer Version werden einmalig überschrieben.
 *
 * Ohne das würde ein alter Speicherstand die neuen Zeiten für immer verdecken –
 * genau das war passiert (Mo–Do ohne Mittagsschließung, Sa ab 11:00 statt 12:00).
 */
export const WORK_HOURS_VERSION = 2;

export const DEFAULT_WORK_HOURS: WorkHoursConfig = {
  perWeekday: {
    monday: clone(SPLIT_DAY),
    tuesday: clone(SPLIT_DAY),
    wednesday: clone(SPLIT_DAY),
    thursday: clone(SPLIT_DAY),
    friday: clone(FRIDAY),
    saturday: clone(WEEKEND),
    sunday: clone(WEEKEND),
  },
  holiday: clone(WEEKEND),
};

/** Längster zusammenhängender Block eines Tages (0 = geschlossen). */
export function longestBlockMinutes(day: ResolvedDay): number {
  if (day.closed) return 0;
  return day.blocks.reduce((max, b) => Math.max(max, b.endMinutes - b.startMinutes), 0);
}

/**
 * Für Nachfrage/Spätquote maßgeblicher Wochentag: Feiertage zählen wie Sonntag
 * (der Nutzer gruppiert „Sonntag & Feiertag").
 */
export function effectiveWeekdayKey(isoDate: string, holidays: Set<string>): WeekdayKey {
  if (holidays.has(isoDate)) return "sunday";
  return weekdayKeyOf(parseIsoDate(isoDate));
}

/** Arbeitszeit-Blöcke für ein konkretes Datum (berücksichtigt Feiertage). */
export function resolveWorkWindow(
  config: WorkHoursConfig,
  isoDate: string,
  holidays: Set<string>,
): DayBlocks {
  if (holidays.has(isoDate)) return config.holiday;
  return config.perWeekday[weekdayKeyOf(parseIsoDate(isoDate))];
}

/**
 * Vollständige Auflösung eines Tages inkl. Ausnahmen:
 * Ausnahme (closed/eigene Zeiten) > Feiertag > Wochentag.
 */
export function resolveDay(
  config: WorkHoursConfig,
  isoDate: string,
  holidays: Set<string>,
  overrides: OverrideMap = {},
): ResolvedDay {
  const ov = overrides[isoDate];
  if (ov?.closed) return { closed: true, blocks: [] };
  // Eine Ausnahme mit eigenen Zeiten ist immer ein einzelner Block.
  if (ov?.window) return { closed: false, blocks: [ov.window] };
  return { closed: false, blocks: resolveWorkWindow(config, isoDate, holidays) };
}

/**
 * Nimmt einen gespeicherten Stand entgegen und bringt ihn aufs aktuelle
 * Schema. Ältere Stände hatten je Tag EIN Objekt statt einer Liste von
 * Blöcken – das wird hier still in eine Ein-Block-Liste umgewandelt.
 */
function toBlocks(value: unknown, fallback: DayBlocks): DayBlocks {
  const isBlock = (b: unknown): b is DayWindow =>
    typeof b === "object" &&
    b !== null &&
    typeof (b as DayWindow).startMinutes === "number" &&
    typeof (b as DayWindow).endMinutes === "number";

  if (Array.isArray(value)) {
    const blocks = value.filter(isBlock).map((b) => ({ ...b }));
    return blocks.length > 0 ? blocks : clone(fallback);
  }
  if (isBlock(value)) return [{ ...value }]; // altes Format
  return clone(fallback);
}

export function normalizeWorkHours(partial: Partial<WorkHoursConfig> | undefined): WorkHoursConfig {
  const base = DEFAULT_WORK_HOURS;
  const perWeekday = {} as Record<WeekdayKey, DayBlocks>;
  for (const key of Object.keys(base.perWeekday) as WeekdayKey[]) {
    perWeekday[key] = toBlocks(partial?.perWeekday?.[key], base.perWeekday[key]);
  }
  return { perWeekday, holiday: toBlocks(partial?.holiday, base.holiday) };
}
