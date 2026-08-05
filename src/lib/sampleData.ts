// ============================================================================
// Beispieldaten für die Tests. Die Sollstunden sind auf die Öffnungszeiten der
// Filialen abgestimmt: Mo–Do ist die längste Schicht nur 5 h (Abendblock),
// deshalb liegt die Monatsdecke deutlich unter den früheren 176 h.
// ============================================================================

import type { Employee, Schedule } from "../types";
import { DEFAULT_WORK_HOURS } from "./workHours";

export function makeEmployee(
  id: string,
  name: string,
  employmentType: Employee["employmentType"],
  targetHours: number,
): Employee {
  return { id, name, employmentType, targetMinutes: targetHours * 60 };
}

export const SAMPLE_EMPLOYEES: Employee[] = [
  makeEmployee("VZ1", "VZ1", "VOLLZEIT", 120),
  makeEmployee("VZ2", "VZ2", "VOLLZEIT", 124),
  makeEmployee("VZ3", "VZ3", "VOLLZEIT", 118),
  makeEmployee("VZ4", "VZ4", "VOLLZEIT", 122),
  makeEmployee("TZ1", "TZ1", "TEILZEIT", 40),
  makeEmployee("TZ2", "TZ2", "TEILZEIT", 55),
  makeEmployee("TZ3", "TZ3", "TEILZEIT", 55),
  makeEmployee("TZ4", "TZ4", "TEILZEIT", 79),
  makeEmployee("TZ5", "TZ5", "TEILZEIT", 80),
];

export function createSampleSchedule(): Schedule {
  return {
    companyName: "Muster Restaurant GmbH",
    address: "Hauptstrasse 24, 15378 Herzfelde",
    holidayState: "BW",
    year: 2026,
    month: 8, // August
    workHours: structuredClone(DEFAULT_WORK_HOURS),
    dateOverrides: [],
    employees: SAMPLE_EMPLOYEES.map((e) => ({ ...e })),
    shifts: [],
  };
}
