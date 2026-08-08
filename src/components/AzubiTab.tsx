import type { UseScheduleReturn } from "../hooks/useSchedule";
import { datesOfMonth } from "../lib/demand";
import {
  azubiConfigOf,
  azubiMonthKey,
  azubiMonthMode,
  azubiMonthlyHoursNeedWarning,
  azubiMonthlyHoursOverride,
  azubiMonthlyHoursOutOfTerm,
  azubiSchoolTermRange,
} from "../lib/azubi";
import {
  AZUBI_MONTHLY_WARNING_HOURS,
  type AzubiConfig,
  type WorkRole,
} from "../types";

type TermMonth = {
  year: number;
  month: number;
};

function termMonthsOf(cfg: AzubiConfig): TermMonth[] {
  const range = azubiSchoolTermRange(cfg);
  if (!range) return [];

  let year = Number(range.start.slice(0, 4));
  let month = Number(range.start.slice(5, 7));
  const endYear = Number(range.end.slice(0, 4));
  const endMonth = Number(range.end.slice(5, 7));
  const result: TermMonth[] = [];

  while (year < endYear || (year === endYear && month <= endMonth)) {
    const mode = azubiMonthMode(cfg, year, month);
    if (mode !== "work") result.push({ year, month });
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }

  return result;
}

export function AzubiTab({ store }: { store: UseScheduleReturn }) {
  const { schedule, updateEmployee } = store;
  const showWorkRole = store.storeId === "thienlong";
  const azubis = schedule.employees.filter((employee) => employee.employmentType === "AZUBI");
  const monthDates = datesOfMonth(schedule.year, schedule.month);
  const monthStart = monthDates[0];
  const monthEnd = monthDates[monthDates.length - 1];

  if (azubis.length === 0) {
    return (
      <section className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Azubi</h2>
        <p className="mt-2 text-sm text-slate-500">
          Chưa có Azubi nào. Sang tab <span className="font-medium">Nhân viên</span>, thêm người rồi
          chọn hình thức <span className="font-medium">Azubi (học nghề)</span>.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {azubis.map((employee) => {
        const cfg: AzubiConfig = azubiConfigOf(employee.azubi);
        const monthlyHours = azubiMonthlyHoursOutOfTerm(cfg);
        const monthMode = azubiMonthMode(cfg, schedule.year, schedule.month);
        const needsWarning = azubiMonthlyHoursNeedWarning(
          cfg,
          schedule.year,
          schedule.month,
        );
        const schoolStart = cfg.schoolTermStart ?? monthStart;
        const schoolEnd = cfg.schoolTermEnd ?? monthEnd;
        const displayedTermCfg =
          cfg.schoolTermStart || cfg.schoolTermEnd
            ? cfg
            : { ...cfg, schoolTermStart: schoolStart, schoolTermEnd: schoolEnd };
        const termMonths = termMonthsOf(displayedTermCfg);
        const monthlyInputId = `azubi-${employee.id}-monthly-hours`;
        const warningId = `${monthlyInputId}-warning`;
        const schoolStartId = `azubi-${employee.id}-school-start`;
        const schoolEndId = `azubi-${employee.id}-school-end`;

        const setCfg = (next: Partial<AzubiConfig>) =>
          updateEmployee(employee.id, { azubi: { ...cfg, ...next } });

        const setTermMonthHours = (year: number, month: number, rawValue: string) => {
          const key = azubiMonthKey(year, month);
          const nextHours = { ...(cfg.monthlyHoursByMonth ?? {}) };
          if (rawValue === "") {
            delete nextHours[key];
          } else {
            const value = Number(rawValue);
            if (!Number.isFinite(value)) return;
            nextHours[key] = Math.max(0, value);
          }
          setCfg({
            monthlyHoursByMonth:
              Object.keys(nextHours).length > 0 ? nextHours : undefined,
          });
        };

        return (
          <section
            key={employee.id}
            className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <h3 className="font-semibold text-slate-900">{employee.name}</h3>
                {showWorkRole && (
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <span className="text-xs text-slate-500">Vị trí</span>
                    <select
                      value={employee.workRole ?? ""}
                      onChange={(event) =>
                        updateEmployee(employee.id, {
                          workRole: (event.target.value || undefined) as WorkRole | undefined,
                        })
                      }
                      aria-label={`Vị trí làm việc của ${employee.name}`}
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                    >
                      <option value="">Chọn vị trí</option>
                      <option value="KITCHEN">Bếp</option>
                      <option value="SERVICE">Bồi</option>
                    </select>
                  </label>
                )}
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={cfg.inSchoolTerm}
                    onChange={(event) =>
                      setCfg(
                        event.target.checked
                          ? {
                              inSchoolTerm: true,
                              schoolTermStart: cfg.schoolTermStart ?? monthStart,
                              schoolTermEnd: cfg.schoolTermEnd ?? monthEnd,
                            }
                          : { inSchoolTerm: false },
                      )
                    }
                    className="h-5 w-5 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
                  />
                  <span className="text-sm text-slate-700">Đang trong kỳ học nghề</span>
                </label>
              </div>
              <span className="text-sm text-slate-500">
                <b className="text-slate-900">{employee.targetMinutes / 60}h/tháng</b>
                {monthMode === "school"
                  ? " · kỳ học"
                  : monthMode === "mixed"
                    ? " · học/làm"
                    : " · chủ đặt"}
              </span>
            </div>

            {cfg.inSchoolTerm && (
              <div className="mt-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:max-w-lg">
                  <label htmlFor={schoolStartId} className="block text-sm font-medium text-slate-700">
                    Từ ngày
                    <input
                      id={schoolStartId}
                      type="date"
                      value={schoolStart}
                      max={schoolEnd}
                      onChange={(event) => {
                        const nextStart = event.target.value || monthStart;
                        setCfg({
                          schoolTermStart: nextStart,
                          schoolTermEnd: nextStart > schoolEnd ? nextStart : schoolEnd,
                        });
                      }}
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                    />
                  </label>
                  <label htmlFor={schoolEndId} className="block text-sm font-medium text-slate-700">
                    Đến ngày
                    <input
                      id={schoolEndId}
                      type="date"
                      value={schoolEnd}
                      min={schoolStart}
                      onChange={(event) => {
                        const nextEnd = event.target.value || monthEnd;
                        setCfg({
                          schoolTermStart: nextEnd < schoolStart ? nextEnd : schoolStart,
                          schoolTermEnd: nextEnd,
                        });
                      }}
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                    />
                  </label>
                </div>

                <div className="mt-4">
                  <h4 className="text-sm font-semibold text-slate-900">
                    Giờ làm từng tháng
                  </h4>
                  <div className="mt-2 divide-y divide-slate-200 rounded border border-slate-200">
                    {termMonths.map(({ year, month }) => {
                      const key = azubiMonthKey(year, month);
                      const override = azubiMonthlyHoursOverride(cfg, year, month);
                      const warning = azubiMonthlyHoursNeedWarning(cfg, year, month);
                      const isSelectedMonth =
                        year === schedule.year && month === schedule.month;
                      const inputId = `azubi-${employee.id}-${key}-hours`;

                      return (
                        <div
                          key={key}
                          className={`flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between ${
                            isSelectedMonth ? "bg-slate-50" : "bg-white"
                          }`}
                        >
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <label htmlFor={inputId} className="text-sm font-medium text-slate-800">
                                Tháng {month}/{year}
                              </label>
                              {isSelectedMonth && (
                                <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">
                                  đang chọn
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="sm:text-right">
                            <div className="flex items-center gap-2 sm:justify-end">
                              <input
                                id={inputId}
                                type="number"
                                min={0}
                                step={0.5}
                                value={override ?? ""}
                                placeholder="0"
                                aria-describedby={warning ? `${inputId}-warning` : undefined}
                                onChange={(event) =>
                                  setTermMonthHours(year, month, event.target.value)
                                }
                                className={`w-24 rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 ${
                                  warning
                                    ? "border-amber-400 focus:border-amber-500 focus:ring-amber-500"
                                    : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
                                }`}
                              />
                              <span className="text-xs text-slate-500">h/tháng</span>
                            </div>
                            {warning && (
                              <p
                                id={`${inputId}-warning`}
                                className="mt-1 text-xs font-medium text-amber-800"
                                role="alert"
                              >
                                Cảnh báo &gt;{AZUBI_MONTHLY_WARNING_HOURS}h
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {monthMode === "work" && (
              <div className="mt-4 max-w-sm">
                <label htmlFor={monthlyInputId} className="block text-sm font-medium text-slate-700">
                  Giờ làm tháng {schedule.month}/{schedule.year} ngoài kỳ học
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    id={monthlyInputId}
                    type="number"
                    min={0}
                    step={0.5}
                    value={monthlyHours}
                    aria-describedby={needsWarning ? warningId : undefined}
                    onChange={(event) =>
                      setCfg({ monthlyHoursOutOfTerm: Math.max(0, Number(event.target.value)) })
                    }
                    className={`w-28 rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 ${
                      needsWarning
                        ? "border-amber-400 focus:border-amber-500 focus:ring-amber-500"
                        : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
                    }`}
                  />
                  <span className="text-xs text-slate-500">h/tháng</span>
                </div>
                {needsWarning && (
                  <p id={warningId} className="mt-2 text-xs font-medium text-amber-800" role="alert">
                    ⚠ Trên {AZUBI_MONTHLY_WARNING_HOURS}h/tháng: lịch có thể khó xếp. Hệ thống vẫn giữ
                    nguyên {monthlyHours}h do chủ nhập.
                  </p>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
