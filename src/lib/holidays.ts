// ============================================================================
// Gesetzliche Feiertage in Brandenburg – der Shop liegt in Herzfelde (15378),
// also Brandenburg. Bewegliche Feiertage werden über die Osterformel
// (Gauß/Computus) berechnet.
//
// Besonderheit Brandenburg (BbgFTG §1): Ostersonntag und Pfingstsonntag sind
// hier gesetzliche Feiertage – anders als in den meisten Bundesländern.
// Fronleichnam und Allerheiligen gibt es in Brandenburg NICHT, dafür den
// Reformationstag (31.10.).
// ============================================================================

import { addDays, format } from "date-fns";

/** Ostersonntag eines Jahres (Gauß'sche Osterformel, gregorianisch). */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = März, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function iso(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/** Datum -> Name aller gesetzlichen Feiertage in Brandenburg eines Jahres. */
export function brandenburgHolidayNames(year: number): Map<string, string> {
  const easter = easterSunday(year);
  const map = new Map<string, string>();
  map.set(iso(new Date(year, 0, 1)), "Neujahr");
  map.set(iso(addDays(easter, -2)), "Karfreitag");
  map.set(iso(easter), "Ostersonntag"); // in Brandenburg gesetzlich
  map.set(iso(addDays(easter, 1)), "Ostermontag");
  map.set(iso(new Date(year, 4, 1)), "Tag der Arbeit");
  map.set(iso(addDays(easter, 39)), "Christi Himmelfahrt");
  map.set(iso(addDays(easter, 49)), "Pfingstsonntag"); // in Brandenburg gesetzlich
  map.set(iso(addDays(easter, 50)), "Pfingstmontag");
  map.set(iso(new Date(year, 9, 3)), "Tag der Deutschen Einheit");
  map.set(iso(new Date(year, 9, 31)), "Reformationstag"); // Brandenburg, 31.10.
  map.set(iso(new Date(year, 11, 25)), "1. Weihnachtstag");
  map.set(iso(new Date(year, 11, 26)), "2. Weihnachtstag");
  return map;
}

/**
 * Alle gesetzlichen Feiertage Brandenburgs eines Jahres als ISO-Set
 * "yyyy-MM-dd". Leitet sich aus brandenburgHolidayNames ab, damit Set und
 * Namen niemals auseinanderlaufen können.
 */
export function brandenburgHolidays(year: number): Set<string> {
  return new Set(brandenburgHolidayNames(year).keys());
}
