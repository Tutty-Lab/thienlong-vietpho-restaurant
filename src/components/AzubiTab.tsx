import type { UseScheduleReturn } from "../hooks/useSchedule";
import { WEEKDAY_LABELS_VI } from "../lib/demand";
import {
  azubiConfigOf,
  azubiMonthlyHoursNeedWarning,
  azubiMonthlyHoursOutOfTerm,
} from "../lib/azubi";
import {
  AZUBI_MONTHLY_WARNING_HOURS,
  type AzubiConfig,
  type WeekdayName,
} from "../types";

const WEEKDAYS: WeekdayName[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export function AzubiTab({ store }: { store: UseScheduleReturn }) {
  const { schedule, updateEmployee } = store;
  const azubis = schedule.employees.filter((employee) => employee.employmentType === "AZUBI");

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
      <section className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Azubi — kỳ học nghề</h2>
        <p className="mt-1 text-xs text-slate-500">
          Trong kỳ học, định mức đi làm là <b>0h</b> và hệ thống không xếp ca. Chủ có thể chọn tùy ý
          từ <b>0 đến 7 ngày học</b>. Ngoài kỳ học, chủ nhập trực tiếp định mức theo tháng; từ
          <b> {AZUBI_MONTHLY_WARNING_HOURS}h/tháng</b> trở lên chỉ hiện cảnh báo, không khóa và không
          tự giảm số giờ.
        </p>
      </section>

      {azubis.map((employee) => {
        const cfg: AzubiConfig = azubiConfigOf(employee.azubi);
        const monthlyHours = azubiMonthlyHoursOutOfTerm(cfg);
        const needsWarning = !cfg.inSchoolTerm && azubiMonthlyHoursNeedWarning(cfg);
        const monthlyInputId = `azubi-${employee.id}-monthly-hours`;
        const warningId = `${monthlyInputId}-warning`;

        const setCfg = (next: Partial<AzubiConfig>) =>
          updateEmployee(employee.id, { azubi: { ...cfg, ...next } });

        const toggleDay = (day: WeekdayName) =>
          setCfg({
            schoolDays: cfg.schoolDays.includes(day)
              ? cfg.schoolDays.filter((current) => current !== day)
              : [...cfg.schoolDays, day],
          });

        return (
          <section
            key={employee.id}
            className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-slate-900">{employee.name}</h3>
              <span className="text-sm text-slate-500">
                <b className="text-slate-900">{employee.targetMinutes / 60}h/tháng</b>
                {cfg.inSchoolTerm ? " · kỳ học" : " · chủ đặt"}
              </span>
            </div>

            <label className="mt-3 flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={cfg.inSchoolTerm}
                onChange={(event) => setCfg({ inSchoolTerm: event.target.checked })}
                className="h-5 w-5 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
              />
              <span className="text-sm text-slate-700">
                Đang trong kỳ học nghề
                <span className="text-slate-400"> — bỏ tích nếu nghỉ hè / hết kỳ</span>
              </span>
            </label>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
                <div className="text-xs font-medium text-emerald-800">Trong kỳ học</div>
                <div className="mt-1 text-lg font-semibold text-emerald-900">0h/tháng</div>
                <p className="mt-1 text-xs text-emerald-700">Không tạo ca đi làm.</p>
              </div>

              <div
                className={`rounded border p-3 ${
                  needsWarning ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"
                }`}
              >
                <label htmlFor={monthlyInputId} className="block text-xs font-medium text-slate-700">
                  Giờ/tháng ngoài kỳ học
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
                    ⚠ Từ {AZUBI_MONTHLY_WARNING_HOURS}h/tháng: lịch có thể khó xếp. Hệ thống vẫn giữ
                    nguyên {monthlyHours}h do chủ nhập.
                  </p>
                )}
              </div>
            </div>

            {cfg.inSchoolTerm && (
              <div className="mt-3">
                <div className="text-xs text-slate-600 mb-1.5">
                  Ngày đi học — chọn tùy ý ({cfg.schoolDays.length}/7):
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((day) => {
                    const selected = cfg.schoolDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleDay(day)}
                        className={`px-3 py-1.5 rounded-full border text-sm ${
                          selected
                            ? "bg-slate-900 text-white border-slate-900"
                            : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
                        }`}
                      >
                        {WEEKDAY_LABELS_VI[day]}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Số ngày học không ảnh hưởng định mức: trong kỳ luôn là 0h đi làm.
                </p>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
