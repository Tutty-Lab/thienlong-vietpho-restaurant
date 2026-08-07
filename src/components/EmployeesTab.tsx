import { useState } from "react";
import type { UseScheduleReturn } from "../hooks/useSchedule";
import {
  AZUBI_MONTHLY_WARNING_HOURS,
  type EmploymentType,
  type WorkRole,
} from "../types";
import { splitTargetHours } from "../lib/splitTargetHours";
import {
  azubiConfigOf,
  azubiMonthKey,
  azubiMonthMode,
  azubiMonthlyHoursNeedWarning,
  azubiMonthlyHoursForMonth,
  azubiMonthlyMinutes,
  DEFAULT_AZUBI_CONFIG,
} from "../lib/azubi";

const inputClass =
  "rounded border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

/**
 * Ab hier wird gewarnt. 192 h = 24 Tage à 8 h; darüber wird der Monat sehr
 * eng (6-Tage-Regel) und arbeitsrechtlich heikel.
 */
export const WARN_HOURS = 192;

/** Số ngày làm (= số ca) cho một mục tiêu, hoặc thông báo lỗi. */
function splitInfo(targetHours: number, type: EmploymentType): { ok: boolean; text: string } {
  try {
    const parts = splitTargetHours(targetHours, type);
    return { ok: true, text: `${parts.length} ca` };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : "không hợp lệ" };
  }
}

export function EmployeesTab({ store }: { store: UseScheduleReturn }) {
  const { schedule, addEmployee, updateEmployee, removeEmployee } = store;
  const showWorkRole = store.storeId === "thienlong";
  const [name, setName] = useState("");
  const [type, setType] = useState<EmploymentType>("VOLLZEIT");
  const [hours, setHours] = useState(176);
  const [workRole, setWorkRole] = useState<WorkRole | "">("");
  const newAzubiHours =
    azubiMonthlyMinutes(DEFAULT_AZUBI_CONFIG, schedule.year, schedule.month) / 60;

  return (
    <section className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900 mb-4">Nhân viên</h2>

      {/* Thêm nhân viên mới */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3 mb-5 rounded bg-slate-50 border border-slate-200 p-3">
        <label className="flex flex-col sm:flex-1 sm:min-w-[140px]">
          <span className="text-xs text-slate-600 mb-1">Tên</span>
          <input
            className={`${inputClass} w-full`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tên nhân viên"
          />
        </label>
        <label className="flex flex-col sm:w-40">
          <span className="text-xs text-slate-600 mb-1">Hình thức làm việc</span>
          <select
            className={`${inputClass} w-full`}
            value={type}
            onChange={(e) => setType(e.target.value as EmploymentType)}
          >
            <option value="VOLLZEIT">Toàn thời gian</option>
            <option value="TEILZEIT">Bán thời gian</option>
            <option value="AZUBI">Azubi (học nghề)</option>
          </select>
        </label>
        {showWorkRole && (
          <label className="flex flex-col sm:w-32">
            <span className="text-xs text-slate-600 mb-1">Vị trí</span>
            <select
              className={`${inputClass} w-full`}
              value={workRole}
              onChange={(event) => setWorkRole(event.target.value as WorkRole | "")}
            >
              <option value="">Chọn</option>
              <option value="KITCHEN">Bếp</option>
              <option value="SERVICE">Bồi</option>
            </select>
          </label>
        )}
        {type === "AZUBI" ? (
          <div className="flex flex-col sm:w-40" aria-live="polite">
            <span className="text-xs text-slate-600 mb-1">Giờ định mức</span>
            <div className="rounded border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700">
              <b>{newAzubiHours}h</b> · kỳ học
            </div>
          </div>
        ) : (
          <label className="flex flex-col sm:w-32">
            <span className="text-xs text-slate-600 mb-1">Giờ định mức</span>
            <input
              type="number"
              min={0}
              step={1}
              className={`${inputClass} w-full`}
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
            />
          </label>
        )}
        <button
          disabled={showWorkRole && !workRole}
          onClick={() => {
            addEmployee(name, type, hours, workRole || undefined);
            setName("");
            setWorkRole("");
          }}
          className="rounded bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 active:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Thêm nhân viên
        </button>
      </div>

      {/* Danh sách – thẻ xếp dọc trên mobile, 1 dòng trên màn lớn (không cuộn ngang) */}
      {schedule.employees.length === 0 ? (
        <div className="py-6 text-center text-slate-400">
          Chưa có nhân viên. Thêm nhân viên ở khung phía trên.
        </div>
      ) : (
        <div className="space-y-2">
          {schedule.employees.map((emp) => {
            const isAzubi = emp.employmentType === "AZUBI";
            const azubiConfig = isAzubi ? azubiConfigOf(emp.azubi) : null;
            const azubiMode = azubiConfig
              ? azubiMonthMode(azubiConfig, schedule.year, schedule.month)
              : "work";
            const azubiMonthlyHours = azubiConfig
              ? azubiMonthlyHoursForMonth(azubiConfig, schedule.year, schedule.month)
              : 0;
            const azubiWarning =
              azubiConfig !== null &&
              azubiMonthlyHoursNeedWarning(azubiConfig, schedule.year, schedule.month);
            const info = isAzubi
              ? {
                  ok: !azubiWarning,
                  text: azubiMode === "school"
                    ? azubiWarning
                      ? `⚠ ${azubiMonthlyHours}h · kỳ học`
                      : `${azubiMonthlyHours}h · kỳ học`
                    : azubiMode === "mixed"
                      ? azubiWarning
                        ? `⚠ ${azubiMonthlyHours}h · học/làm`
                        : `${azubiMonthlyHours}h · học/làm`
                      : azubiWarning
                        ? `⚠ ${azubiMonthlyHours}h/tháng`
                        : `${azubiMonthlyHours}h/tháng · chủ đặt`,
                }
              : splitInfo(emp.targetMinutes / 60, emp.employmentType);
            const tooMany = !isAzubi && emp.targetMinutes / 60 > WARN_HOURS;
            return (
              <div
                key={emp.id}
                className="rounded-lg border border-slate-200 p-3 flex flex-col sm:flex-row sm:flex-wrap sm:items-end lg:flex-nowrap gap-3"
              >
                <label className="flex flex-col sm:flex-1">
                  <span className="text-xs text-slate-500 mb-1 sm:hidden">Tên</span>
                  <input
                    className={`${inputClass} w-full`}
                    value={emp.name}
                    onChange={(e) => updateEmployee(emp.id, { name: e.target.value })}
                  />
                </label>
                <label className="flex flex-col sm:w-40">
                  <span className="text-xs text-slate-500 mb-1 sm:hidden">Hình thức</span>
                  <select
                    className={`${inputClass} w-full`}
                    value={emp.employmentType}
                    onChange={(e) =>
                      updateEmployee(emp.id, {
                        employmentType: e.target.value as EmploymentType,
                      })
                    }
                  >
                    <option value="VOLLZEIT">Toàn thời gian</option>
                    <option value="TEILZEIT">Bán thời gian</option>
                    <option value="AZUBI">Azubi (học nghề)</option>
                  </select>
                </label>
                {showWorkRole && (
                  <label className="flex flex-col sm:w-32">
                    <span className="text-xs text-slate-500 mb-1 sm:hidden">Vị trí</span>
                    <select
                      className={`${inputClass} w-full`}
                      value={emp.workRole ?? ""}
                      onChange={(event) =>
                        updateEmployee(emp.id, {
                          workRole: (event.target.value || undefined) as WorkRole | undefined,
                        })
                      }
                      aria-label={`Vị trí làm việc của ${emp.name}`}
                    >
                      <option value="">Chọn vị trí</option>
                      <option value="KITCHEN">Bếp</option>
                      <option value="SERVICE">Bồi</option>
                    </select>
                  </label>
                )}
                <label className="flex flex-col sm:w-32">
                  <span className="text-xs text-slate-500 mb-1 sm:hidden">Giờ định mức</span>
                  {isAzubi ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        className={`${inputClass} w-full ${
                          azubiWarning ? "border-amber-400 text-amber-900" : ""
                        }`}
                        value={azubiMonthlyHours}
                        aria-label={
                          azubiMode !== "work"
                            ? `Giờ làm tháng ${schedule.month}/${schedule.year} của ${emp.name}`
                            : `Giờ tháng ngoài kỳ học của ${emp.name}`
                        }
                        aria-describedby={azubiWarning ? `azubi-warning-${emp.id}` : undefined}
                        onChange={(event) =>
                          updateEmployee(emp.id, {
                            azubi:
                              azubiMode !== "work"
                                ? {
                                    ...azubiConfigOf(emp.azubi),
                                    monthlyHoursByMonth: {
                                      ...(azubiConfigOf(emp.azubi).monthlyHoursByMonth ?? {}),
                                      [azubiMonthKey(schedule.year, schedule.month)]: Math.max(
                                        0,
                                        Number(event.target.value),
                                      ),
                                    },
                                  }
                                : {
                                    ...azubiConfigOf(emp.azubi),
                                    monthlyHoursOutOfTerm: Math.max(
                                      0,
                                      Number(event.target.value),
                                    ),
                                  },
                          })
                        }
                      />
                      <span className="text-slate-400">h</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        className={`${inputClass} w-full`}
                        value={emp.targetMinutes / 60}
                        onChange={(e) =>
                          updateEmployee(emp.id, {
                            targetMinutes: Math.max(0, Math.round(Number(e.target.value))) * 60,
                          })
                        }
                      />
                      <span className="text-slate-400">h</span>
                    </div>
                  )}
                </label>
                <label className="flex items-center gap-2 sm:pb-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={emp.saved === true}
                    onChange={(e) => updateEmployee(emp.id, { saved: e.target.checked })}
                    className="h-5 w-5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span
                    className={`text-sm ${emp.saved ? "text-emerald-700 font-medium" : "text-slate-500"}`}
                  >
                    Lưu
                  </span>
                </label>
                <div className="flex items-center justify-between sm:flex-col sm:items-end sm:justify-end gap-1 sm:w-24">
                  <span
                    className={`text-xs ${
                      azubiWarning
                        ? "font-medium text-amber-700"
                        : info.ok
                          ? "text-slate-500"
                          : "text-rose-600"
                    }`}
                  >
                    {info.text}
                  </span>
                  {azubiWarning && (
                    <span
                      id={`azubi-warning-${emp.id}`}
                      className="text-xs font-medium text-amber-700"
                      title={`Từ ${AZUBI_MONTHLY_WARNING_HOURS}h/tháng lịch có thể khó xếp; số giờ vẫn được giữ nguyên.`}
                    >
                      cảnh báo ≥{AZUBI_MONTHLY_WARNING_HOURS}h
                    </span>
                  )}
                  {tooMany && (
                    <span
                      className="text-xs text-amber-600 font-medium"
                      title={`Trên ${WARN_HOURS}h/tháng rất khó xếp (tối đa 6 ngày làm liên tiếp) và dễ vượt giới hạn giờ làm theo luật Đức.`}
                    >
                      ⚠ &gt;{WARN_HOURS}h
                    </span>
                  )}
                  <button
                    onClick={() => removeEmployee(emp.id)}
                    className="text-rose-600 hover:text-rose-800 text-sm font-medium"
                  >
                    Xoá
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
