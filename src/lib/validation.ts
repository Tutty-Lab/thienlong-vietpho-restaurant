// ============================================================================
// Validierung des Dienstplans gegen alle geforderten Regeln.
// ============================================================================

import {
  AZUBI_HOURS_OUT_OF_TERM,
  AZUBI_WEEKLY_TARGET_FLEX_HOURS,
  type Employee,
  type Shift,
  type WorkRole,
} from "../types";
import { calculatePause, minutesToTime } from "./time";
import { maxConsecutiveRun } from "./consecutive";
import { datesOfMonth, parseIsoDate, weekdayKeyOf } from "./demand";
import { holidaysOf, type HolidayState } from "./holidays";
import { resolveDay, type OverrideMap, type WorkHoursConfig } from "./workHours";
import { vietphoPeakIntervals } from "./vietphoDemand";
import { isEmployeeFixedDayOff } from "./fixedDaysOff";
import { unavailableReason } from "./availability";
import { ROLES, dayRoleIssues, roleCountAt, roleLabel } from "./roleCoverage";

export type ValidationErrorKind = "coverage" | "hours" | "shift" | "rule";

export type ValidationError = {
  employeeId?: string;
  date?: string;
  /** Kurz: was ist falsch. */
  message: string;
  /** Gruppe in der Anzeige (Thiếu người / Giờ định mức / Ca / Luật). */
  kind?: ValidationErrorKind;
  /** Warum das passiert. */
  reason?: string;
  /** Wie man es anders planen kann. */
  suggestion?: string;
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
        kind: "shift",
        suggestion: "Mở ca này và sửa giờ vào/ra.",
      });
    }
    if (shift.paidMinutes > MAX_PAID_MINUTES) {
      errors.push({
        employeeId: shift.employeeId,
        date: shift.date,
        message: `Quá ${MAX_PAID_MINUTES / 60} giờ công ngày ${shift.date}.`,
        kind: "shift",
        reason: "Luật lao động Đức: tối đa 10 giờ công mỗi ngày.",
        suggestion: "Rút ngắn ca, hoặc chuyển bớt giờ sang ngày khác của người này.",
      });
    }
    if (shift.paidMinutes !== expectedPaid) {
      errors.push({
        employeeId: shift.employeeId,
        date: shift.date,
        message: `Giờ công không khớp giờ vào/ra/nghỉ ngày ${shift.date}.`,
        kind: "shift",
        suggestion: "Mở ca này và bấm Lưu lại để tính lại giờ công.",
      });
    }
    if (shift.pauseMinutes !== expectedPause) {
      errors.push({
        employeeId: shift.employeeId,
        date: shift.date,
        message: `Sai giờ nghỉ ngày ${shift.date}: ${shift.pauseMinutes} thay vì ${expectedPause} phút.`,
        kind: "shift",
        reason: "Ca liền trên 6 giờ cần nghỉ 30 phút, trên 9 giờ cần 45 phút.",
        suggestion: `Đặt nghỉ = ${expectedPause} phút, hoặc chia thành ca gãy (Ca 1 / Ca 2).`,
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
          kind: "shift",
          suggestion: "Xoá một ca, hoặc gộp thành ca gãy (Ca 1 / Ca 2).",
        });
      }
      seenDates.add(shift.date);
      const inactive = unavailableReason(emp, shift.date);
      if (inactive) {
        errors.push({
          employeeId: emp.id,
          date: shift.date,
          message: `${emp.name}: ngày ${shift.date} ${inactive.toLowerCase()} (không được xếp ca).`,
          kind: "shift",
          suggestion: "Xoá ca này hoặc chuyển ca sang người khác (bấm vào ca).",
        });
      }
      if (isEmployeeFixedDayOff(emp, shift.date)) {
        errors.push({
          employeeId: emp.id,
          date: shift.date,
          message: `${emp.name}: ngày ${shift.date} là ngày nghỉ cố định.`,
          kind: "shift",
          suggestion: "Chuyển ca sang người khác, hoặc đổi ngày nghỉ cố định trong tab Nhân viên.",
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
            kind: "hours",
            reason: `Azubi tối đa ${weeklyCapMinutes / 60}h mỗi tuần.`,
            suggestion: "Bớt giờ trong tuần đó, hoặc đặt giờ riêng tháng này thấp hơn (tab Nhân viên).",
          });
        }
      }
    }

    if (assignedMinutes !== emp.targetMinutes) {
      errors.push({
        employeeId: emp.id,
        message: `${emp.name}: chưa đạt giờ định mức: ${assignedMinutes / 60} h thay vì ${emp.targetMinutes / 60} h.`,
        kind: "hours",
        reason:
          assignedMinutes < emp.targetMinutes
            ? `Thiếu ${(emp.targetMinutes - assignedMinutes) / 60}h so với giờ tháng – thường do sửa/xoá ca bằng tay.`
            : `Thừa ${(assignedMinutes - emp.targetMinutes) / 60}h so với giờ tháng – thường do sửa/thêm ca bằng tay.`,
        suggestion:
          assignedMinutes < emp.targetMinutes
            ? "Kéo dài một vài ca của người này, hoặc bấm “+ Tạo lịch làm việc” để tạo lại."
            : "Rút ngắn một vài ca của người này, hoặc tạo lại lịch.",
      });
    }
    if (maxRun > MAX_CONSECUTIVE_DAYS) {
      errors.push({
        employeeId: emp.id,
        message: `${emp.name}: làm quá 6 ngày liên tiếp (${maxRun}).`,
        kind: "rule",
        reason: "Mỗi người cần ít nhất 1 ngày nghỉ sau 6 ngày làm liên tiếp.",
        suggestion: "Cho người này nghỉ 1 ngày trong chuỗi đó và chuyển ca sang người khác.",
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
              kind: "coverage",
              suggestion: "Dời một ca vào khung giờ cao điểm này hoặc kéo dài ca.",
              message:
                `Ngày ${date}: cần ít nhất ${peak.minStaff} nhân viên trong giờ cao điểm ` +
                `${minutesToTime(peak.startMinutes)}–${minutesToTime(peak.endMinutes)} ` +
                `(hiện có ${coveringCount}).`,
            });
          }
        }
        continue;
      }

      // Thienlong: Bếp/Bồi-Regeln (Lücke, Fr/Sa/So-Mindestbesetzung, Abend ≥ Mittag)
      // – gleiche Rechnung wie im Planer (roleCoverage.ts), inkl. Rollenwechsel.
      if (context.storeId === "thienlong") {
        roleErrorsForDay(employees, shifts, date, day.blocks).forEach((e) => errors.push(e));
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
          kind: "rule",
          reason: "Quán cần 2 người vào sớm để chuẩn bị trước giờ mở cửa.",
          suggestion: `Cho thêm 1 người bắt đầu lúc ${minutesToTime(openingStart)} (dời giờ vào của một ca sớm hơn).`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, summaries };
}

const employeesByIdOf = (employees: Employee[]) => new Map(employees.map((e) => [e.id, e] as const));
const slotText = (slots: number[]) => {
  const ranges: [number, number][] = [];
  for (const t of slots) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === t) last[1] = t + 30;
    else ranges.push([t, t + 30]);
  }
  return ranges.map(([a, b]) => `${minutesToTime(a)}–${minutesToTime(b)}`).join(", ");
};

/** Rollen-Fehler eines Tages mit Grund und Vorschlag. */
function roleErrorsForDay(
  employees: Employee[],
  shifts: Shift[],
  date: string,
  blocks: { startMinutes: number; endMinutes: number }[],
): ValidationError[] {
  const byId = employeesByIdOf(employees);
  const roleOf = (s: Shift) => byId.get(s.employeeId)?.workRole;
  const dayShifts = shifts.filter((s) => s.date === date);
  const weekday = weekdayKeyOf(parseIsoDate(date));
  const rolesInTeam = ROLES.filter((r) => employees.some((e) => e.workRole === r && e.targetMinutes > 0));
  const issues = dayRoleIssues(dayShifts, roleOf, blocks, weekday, rolesInTeam);

  // Wer kann an dem Tag in dieser Rolle arbeiten (Rolle dieses Monats)?
  const availableFor = (role: WorkRole) =>
    employees.filter(
      (e) =>
        e.workRole === role &&
        e.targetMinutes > 0 &&
        !isEmployeeFixedDayOff(e, date) &&
        unavailableReason(e, date) === null,
    ).length;
  const suggestionFor = (role: WorkRole, times: number[]): string => {
    const other: WorkRole = role === "KITCHEN" ? "SERVICE" : "KITCHEN";
    const spare =
      times.length > 0 &&
      times.every((t) => roleCountAt(dayShifts, roleOf, other, t) > (other === "KITCHEN" ? 2 : 1));
    return spare
      ? `Lúc đó ${roleLabel(other)} dư người. Bấm “Tìm cách xếp khác” để thử cho một người làm ${roleLabel(role)} cả tháng.`
      : `Kéo dài hoặc dời ca của một ${roleLabel(role)} vào giờ đó (bấm vào ca), hoặc bấm “Tìm cách xếp khác”.`;
  };

  const out: ValidationError[] = [];
  for (const g of issues.gaps) {
    out.push({
      date,
      kind: "coverage",
      message: `Ngày ${date}: không có ${roleLabel(g.role)} lúc ${slotText(g.slots)}.`,
      reason: `Hôm nay chỉ có ${availableFor(g.role)} ${roleLabel(g.role)} đi làm được (còn lại nghỉ cố định, đi học hoặc nghỉ việc) và giờ làm của họ không phủ hết.`,
      suggestion: suggestionFor(g.role, g.slots),
    });
  }
  for (const m of issues.minStaff) {
    const label = roleLabel(m.role);
    const available = availableFor(m.role);
    out.push({
      date,
      kind: "coverage",
      message:
        `Ngày ${date}: cần ít nhất ${m.minStaff} ${label} từ ` +
        `${minutesToTime(m.startMinutes)}–${minutesToTime(m.endMinutes)} (thiếu lúc ${m.short.map(minutesToTime).join(", ")}).`,
      reason:
        available < m.minStaff
          ? `Hôm nay chỉ có ${available} ${label} đi làm được (nghỉ cố định/đi học/nghỉ việc) – không đủ người.`
          : `Có ${available} người làm ${label} hôm nay nhưng giờ làm của họ không trùng đủ khung này.`,
      suggestion: suggestionFor(m.role, m.short),
    });
  }
  for (const e of issues.eveningBelowLunch) {
    out.push({
      date,
      kind: "coverage",
      message: `Ngày ${date}: ${roleLabel(e.role)} tối (${e.dinner}) ít hơn trưa (${e.lunch}).`,
      reason: "Buổi tối đông khách hơn, nên mỗi vị trí phải có ít nhất bằng số người buổi trưa.",
      suggestion: `Dời một ca ${roleLabel(e.role)} chỉ làm trưa sang buổi tối, hoặc cho một người làm ca gãy trưa + tối.`,
    });
  }
  return out;
}
