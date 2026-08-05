// ============================================================================
// Zentrale Datentypen. Intern wird IMMER in Minuten (Integer) gerechnet,
// niemals mit Fließkomma-Stunden.
// ============================================================================

import type { DateOverride, WorkHoursConfig } from "./lib/workHours";
import type { HolidayState } from "./lib/holidays";

export type EmploymentType = "VOLLZEIT" | "TEILZEIT";

export type ShiftType = "EARLY" | "LATE" | "CUSTOM";

export type Employee = {
  id: string;
  name: string;
  employmentType: EmploymentType;
  /** Monatliches Soll in Minuten (Integer). 176 h => 10560. */
  targetMinutes: number;
  /**
   * Häkchen „Lưu" in der Mitarbeiterliste: vom Nutzer gesetzte Bestätigung,
   * dass die Daten dieser Person geprüft und übernommen sind. Rein als Merker
   * gedacht – auf die Planung hat das Feld keinen Einfluss.
   */
  saved?: boolean;
};

/** Ein zusammenhängendes Stück Arbeitszeit. */
export type ShiftSegment = { startMinutes: number; endMinutes: number };

export type Shift = {
  id: string;
  employeeId: string;
  /** ISO-Datum "yyyy-MM-dd". */
  date: string;
  /** Beginn des ERSTEN Stücks. */
  startMinutes: number;
  /** Ende des LETZTEN Stücks. */
  endMinutes: number;
  pauseMinutes: number;
  /**
   * Geteilter Dienst: zwei Stücke, dazwischen ist der Laden zu (Mo–Do
   * 15:00–16:30). Fehlt das Feld, ist es ein durchgehender Dienst.
   * Bei geteiltem Dienst gibt es KEINE gerechnete Pause – die Lücke ist
   * die Ruhezeit.
   */
  segments?: ShiftSegment[];
  /** Bezahlte Arbeitszeit in Minuten = Summe der Stücke. */
  paidMinutes: number;
  shiftType: ShiftType;
  /** true = automatisch generiert, false = manuell hinzugefügt/geändert. */
  generated: boolean;
};

export type Schedule = {
  companyName: string;
  /** Bundesland der Filiale – bestimmt die gesetzlichen Feiertage. */
  holidayState: HolidayState;
  /** Anschrift des Betriebs (erscheint auf dem Stundenzettel). */
  address: string;
  year: number;
  /** 1-basiert: 1 = Januar ... 12 = Dezember. */
  month: number;
  /** Arbeitszeit-Fenster (giờ làm) je Wochentag + Feiertag. */
  workHours: WorkHoursConfig;
  /** Ausnahmen für einzelne Daten (geschlossen / abweichende Zeiten). */
  dateOverrides: DateOverride[];
  employees: Employee[];
  shifts: Shift[];
};

/** Ein einzelnes zu verplanendes Schicht-Token (Ergebnis von splitTargetHours). */
export type ShiftToken = {
  employeeId: string;
  paidMinutes: number;
};
