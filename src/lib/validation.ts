// ============================================================================
// Validierung des Dienstplans gegen alle geforderten Regeln.
// ============================================================================

import { AZUBI_HOURS_OUT_OF_TERM, type Employee, type Shift } from "../types";
import { calculatePause } from "./time";
import { maxConsecutiveRun } from "./consecutive";
import { parseIsoDate } from "./demand";

export type ValidationError = {
  employeeId?: string;
  date?: string;
  message: string;
};

export type EmployeeSummary = {
  employee: Employee;
  assignedMinutes: number;
  targetMinutes: number;
  diffMinutes: number; // assigned - target
  maxConsecutiveDays: number;
  shiftCount: number;
};

export type ValidationResult = {
  valid: boolean;
  errors: ValidationError[];
  summaries: EmployeeSummary[];
};

const MAX_PAID_MINUTES = 10 * 60; // ArbZG §3: bis 10 h zulässig
const MAX_CONSECUTIVE_DAYS = 6;

function weekKeyOf(isoDate: string): string {
  const date = parseIsoDate(isoDate);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function validateSchedule(
  employees: Employee[],
  shifts: Shift[],
): ValidationResult {
  const errors: ValidationError[] = [];
  const shiftsByEmployee = new Map<string, Shift[]>();
  for (const emp of employees) shiftsByEmployee.set(emp.id, []);
  for (const shift of shifts) {
    if (!shiftsByEmployee.has(shift.employeeId)) {
      shiftsByEmployee.set(shift.employeeId, []);
    }
    shiftsByEmployee.get(shift.employeeId)!.push(shift);
  }

  // Regeln je einzelner Schicht.
  for (const shift of shifts) {
    // Geteilter Dienst (zwei Stücke): bezahlte Zeit = Summe der Stücke, und
    // es gibt keine gerechnete Pause – die Ladenschließung ist die Ruhezeit.
    const isSplit = Array.isArray(shift.segments) && shift.segments.length > 1;
    const expectedPaid = isSplit
      ? shift.segments!.reduce((a, s) => a + (s.endMinutes - s.startMinutes), 0)
      : shift.endMinutes - shift.startMinutes - shift.pauseMinutes;
    const expectedPause = isSplit ? 0 : calculatePause(shift.paidMinutes);

    if (shift.endMinutes <= shift.startMinutes) {
      errors.push({
        employeeId: shift.employeeId,
        date: shift.date,
        message: `Giờ ra không sau giờ vào (${shift.date}).`,
      });
    }
    if (shift.paidMinutes > MAX_PAID_MINUTES) {
      errors.push({
        employeeId: shift.employeeId,
        date: shift.date,
        message: `Quá ${MAX_PAID_MINUTES / 60} giờ công ngày ${shift.date}.`,
      });
    }
    if (shift.paidMinutes !== expectedPaid) {
      errors.push({
        employeeId: shift.employeeId,
        date: shift.date,
        message: `Giờ công không khớp giờ vào/ra/nghỉ ngày ${shift.date}.`,
      });
    }
    if (shift.pauseMinutes !== expectedPause) {
      errors.push({
        employeeId: shift.employeeId,
        date: shift.date,
        message: `Sai giờ nghỉ ngày ${shift.date}: ${shift.pauseMinutes} thay vì ${expectedPause} phút.`,
      });
    }
  }

  const summaries: EmployeeSummary[] = [];

  for (const emp of employees) {
    const empShifts = shiftsByEmployee.get(emp.id) ?? [];

    // Höchstens ein Dienst pro Tag.
    const seenDates = new Set<string>();
    for (const shift of empShifts) {
      if (seenDates.has(shift.date)) {
        errors.push({
          employeeId: emp.id,
          date: shift.date,
          message: `Có nhiều hơn một ca ngày ${shift.date}.`,
        });
      }
      seenDates.add(shift.date);
    }

    const assignedMinutes = empShifts.reduce((sum, s) => sum + s.paidMinutes, 0);
    const maxRun = maxConsecutiveRun(empShifts.map((s) => s.date));

    if (emp.employmentType === "AZUBI") {
      const weeklyCapMinutes = Math.round(AZUBI_HOURS_OUT_OF_TERM * 60);
      const minutesByWeek = new Map<string, number>();

      for (const shift of empShifts) {
        const weekKey = weekKeyOf(shift.date);
        minutesByWeek.set(weekKey, (minutesByWeek.get(weekKey) ?? 0) + shift.paidMinutes);
      }
      for (const [weekKey, minutes] of minutesByWeek) {
        if (minutes > weeklyCapMinutes) {
          errors.push({
            employeeId: emp.id,
            message: `${emp.name}: tuần ${weekKey} có ${minutes / 60}h, vượt mức ${weeklyCapMinutes / 60}h.`,
          });
        }
      }
    }

    if (assignedMinutes !== emp.targetMinutes) {
      errors.push({
        employeeId: emp.id,
        message: `${emp.name}: chưa đạt giờ định mức: ${assignedMinutes / 60} h thay vì ${emp.targetMinutes / 60} h.`,
      });
    }
    if (maxRun > MAX_CONSECUTIVE_DAYS) {
      errors.push({
        employeeId: emp.id,
        message: `${emp.name}: làm quá 6 ngày liên tiếp (${maxRun}).`,
      });
    }

    summaries.push({
      employee: emp,
      assignedMinutes,
      targetMinutes: emp.targetMinutes,
      diffMinutes: assignedMinutes - emp.targetMinutes,
      maxConsecutiveDays: maxRun,
      shiftCount: empShifts.length,
    });
  }

  return { valid: errors.length === 0, errors, summaries };
}
