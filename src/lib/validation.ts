// ============================================================================
// Validierung des Dienstplans gegen alle geforderten Regeln.
// ============================================================================

import {
  AZUBI_HOURS_OUT_OF_TERM,
  AZUBI_WEEKLY_TARGET_FLEX_HOURS,
  type Employee,
  type Shift,
} from "../types";
import { calculatePause, minutesToTime } from "./time";
import { maxConsecutiveRun } from "./consecutive";
import { datesOfMonth, parseIsoDate, weekdayKeyOf } from "./demand";
import { holidaysOf, type HolidayState } from "./holidays";
import { resolveDay, type OverrideMap, type WorkHoursConfig } from "./workHours";
import { vietphoPeakIntervals } from "./vietphoDemand";
import { isEmployeeFixedDayOff } from "./fixedDaysOff";
import { unavailableReason } from "./availability";
import { worksDinner, worksLunch } from "./shiftMeals";
import { thienlongMinStaffWindows } from "./thienlongDemand";

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

export type ValidationContext = {
  year: number;
  month: number;
  workHours: WorkHoursConfig;
  holidayState: HolidayState;
  storeId?: string;
  overrides?: OverrideMap;
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
  context?: ValidationContext,
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
      const inactive = unavailableReason(emp, shift.date);
      if (inactive) {
        errors.push({
          employeeId: emp.id,
          date: shift.date,
          message: `${emp.name}: ngày ${shift.date} ${inactive.toLowerCase()} (không được xếp ca).`,
        });
      }
      if (isEmployeeFixedDayOff(emp, shift.date)) {
        errors.push({
          employeeId: emp.id,
          date: shift.date,
          message: `${emp.name}: ngày ${shift.date} là ngày nghỉ cố định.`,
        });
      }
    }

    const assignedMinutes = empShifts.reduce((sum, s) => sum + s.paidMinutes, 0);
    const maxRun = maxConsecutiveRun(empShifts.map((s) => s.date));

    if (emp.employmentType === "AZUBI") {
      const weeklyCapMinutes = Math.round(
        (AZUBI_HOURS_OUT_OF_TERM + AZUBI_WEEKLY_TARGET_FLEX_HOURS) * 60,
      );
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

  if (context && shifts.length > 0) {
    const holidays = holidaysOf(context.year, context.holidayState);
    for (const date of datesOfMonth(context.year, context.month)) {
      const day = resolveDay(context.workHours, date, holidays, context.overrides);
      if (day.closed) continue;

      if (context.storeId === "vietpho") {
        for (const peak of vietphoPeakIntervals()) {
          const existsInWorkHours = day.blocks.some(
            (block) =>
              block.startMinutes <= peak.startMinutes && block.endMinutes >= peak.endMinutes,
          );
          if (!existsInWorkHours) continue;
          const coveringCount = shifts.filter((shift) => {
            if (shift.date !== date) return false;
            return (shift.segments ?? [shift]).some(
              (segment) =>
                segment.startMinutes <= peak.startMinutes && segment.endMinutes >= peak.endMinutes,
            );
          }).length;
          if (coveringCount < peak.minStaff) {
            errors.push({
              date,
              message:
                `Ngày ${date}: cần ít nhất ${peak.minStaff} nhân viên trong giờ cao điểm ` +
                `${minutesToTime(peak.startMinutes)}–${minutesToTime(peak.endMinutes)} ` +
                `(hiện có ${coveringCount}).`,
            });
          }
        }
        continue;
      }

      // Thienlong: kein 30-Minuten-Slot ohne Bếp bzw. ohne Bồi.
      if (context.storeId === "thienlong") {
        const roleById = new Map(employees.map((e) => [e.id, e.workRole] as const));
        const nameById = new Map(employees.map((e) => [e.id, e.name] as const));
        const dayShifts = shifts.filter((shift) => shift.date === date);
        const presentAt = (role: "KITCHEN" | "SERVICE", t: number) =>
          dayShifts.filter(
            (shift) =>
              roleById.get(shift.employeeId) === role &&
              (shift.segments ?? [shift]).some(
                (segment) => segment.startMinutes <= t && segment.endMinutes >= t + 30,
              ),
          );
        const kitchenNeed = (t: number) =>
          thienlongMinStaffWindows(weekdayKeyOf(parseIsoDate(date)), "KITCHEN").reduce(
            (max, w) => (t >= w.startMinutes && t + 30 <= w.endMinutes ? Math.max(max, w.minStaff) : max),
            1,
          );
        // Wie viele dieser Rolle können an dem Tag überhaupt arbeiten?
        const availableCount = (role: "KITCHEN" | "SERVICE") =>
          employees.filter(
            (e) =>
              e.workRole === role &&
              e.targetMinutes > 0 &&
              !isEmployeeFixedDayOff(e, date) &&
              unavailableReason(e, date) === null,
          ).length;
        // Thiếu Bồi mà Bếp dư người đúng lúc đó → gợi ý cho một Bếp phụ Bồi.
        const kitchenHelpHint = (times: number[]): string => {
          if (times.length === 0) return "";
          const spare = times.every((t) => presentAt("KITCHEN", t).length > kitchenNeed(t));
          if (!spare) return "";
          const names = [...new Set(presentAt("KITCHEN", times[0]).map((sh) => nameById.get(sh.employeeId)))];
          return ` Gợi ý: cho 1 Bếp phụ Bồi lúc đó (đang có ${names.join(", ")}).`;
        };
        for (const role of ["KITCHEN", "SERVICE"] as const) {
          if (!employees.some((e) => e.workRole === role && e.targetMinutes > 0)) continue;
          const roleShifts = dayShifts.filter((shift) => roleById.get(shift.employeeId) === role);
          const ranges: [number, number][] = [];
          for (const block of day.blocks) {
            for (let t = block.startMinutes; t + 30 <= block.endMinutes; t += 30) {
              const covered = roleShifts.some((shift) =>
                (shift.segments ?? [shift]).some(
                  (segment) => segment.startMinutes <= t && segment.endMinutes >= t + 30,
                ),
              );
              if (covered) continue;
              const last = ranges[ranges.length - 1];
              if (last && last[1] === t) last[1] = t + 30;
              else ranges.push([t, t + 30]);
            }
          }
          // Buổi tối luôn ít nhất bằng buổi trưa (cùng cách đếm với bảng thống kê).
          const lunch = roleShifts.filter(worksLunch).length;
          const dinner = roleShifts.filter(worksDinner).length;
          if (dinner < lunch) {
            const label = role === "KITCHEN" ? "Bếp" : "Bồi";
            errors.push({
              date,
              message: `Ngày ${date}: ${label} tối (${dinner}) ít hơn trưa (${lunch}).`,
            });
          }
          // Fr/Sa/So: Mindestbesetzung je Rolle (14–17, 20–22 Uhr).
          const windows = thienlongMinStaffWindows(weekdayKeyOf(parseIsoDate(date)), role);
          for (const w of windows) {
            const short: number[] = [];
            for (let t = w.startMinutes; t + 30 <= w.endMinutes; t += 30) {
              if (!day.blocks.some((b) => b.startMinutes <= t && b.endMinutes >= t + 30)) continue;
              const count = roleShifts.filter((shift) =>
                (shift.segments ?? [shift]).some(
                  (segment) => segment.startMinutes <= t && segment.endMinutes >= t + 30,
                ),
              ).length;
              if (count < w.minStaff) short.push(t);
            }
            if (short.length > 0) {
              const label = role === "KITCHEN" ? "Bếp" : "Bồi";
              const available = availableCount(role);
              const notEnough =
                available < w.minStaff
                  ? ` Hôm nay chỉ có ${available} ${label} đi làm được (nghỉ cố định/đi học/nghỉ việc) – không đủ người.`
                  : "";
              errors.push({
                date,
                message:
                  `Ngày ${date}: cần ít nhất ${w.minStaff} ${label} từ ` +
                  `${minutesToTime(w.startMinutes)}–${minutesToTime(w.endMinutes)} ` +
                  `(thiếu lúc ${short.map(minutesToTime).join(", ")}).` +
                  notEnough +
                  (role === "SERVICE" ? kitchenHelpHint(short) : ""),
              });
            }
          }
          if (ranges.length > 0) {
            const label = role === "KITCHEN" ? "Bếp" : "Bồi";
            const text = ranges
              .map(([a, b]) => `${minutesToTime(a)}–${minutesToTime(b)}`)
              .join(", ");
            const slots = ranges.flatMap(([a, b]) => {
              const out: number[] = [];
              for (let t = a; t < b; t += 30) out.push(t);
              return out;
            });
            errors.push({
              date,
              message:
                `Ngày ${date}: không có ${label} lúc ${text}.` +
                (role === "SERVICE" ? kitchenHelpHint(slots) : ""),
            });
          }
        }
      }

      const openingStart = day.blocks[0].startMinutes;
      const openerCount = shifts.filter((shift) => {
        if (shift.date !== date) return false;
        return (shift.segments?.[0]?.startMinutes ?? shift.startMinutes) === openingStart;
      }).length;
      if (openerCount < 2) {
        errors.push({
          date,
          message: `Ngày ${date}: cần ít nhất 2 nhân viên mở cửa trước 30 phút (hiện có ${openerCount}).`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, summaries };
}
