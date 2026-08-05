import type { UseScheduleReturn } from "../hooks/useSchedule";
import {
  AZUBI_HOURS_IN_TERM,
  AZUBI_HOURS_OUT_OF_TERM,
  AZUBI_WORKDAYS_IN_TERM,
  type AzubiConfig,
  type WeekdayName,
} from "../types";
import { WEEKDAY_LABELS_VI } from "../lib/demand";
import {
  AZUBI_MONTHLY_WEEKS,
  azubiConfigOf,
  azubiConfiguredWeeklyHours,
  azubiEffectiveWeeklyHours,
  azubiExceedsWeeklyMaximum,
  azubiWeeklyHours,
} from "../lib/azubi";

const WEEKDAYS: WeekdayName[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** Wie viele Schultage der Chef vorgibt, wenn die Berufsschule läuft. */
const SCHOOL_DAYS_EXPECTED = 2;

export function AzubiTab({ store }: { store: UseScheduleReturn }) {
  const { schedule, updateEmployee } = store;
  const azubis = schedule.employees.filter((e) => e.employmentType === "AZUBI");

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
          Trong kỳ học: chủ chọn <b>{SCHOOL_DAYS_EXPECTED} ngày đi học</b>, hệ thống
          chia giờ làm trên <b>{AZUBI_WORKDAYS_IN_TERM} ngày/tuần</b> để còn 2 ngày nghỉ. Giờ làm do chủ
          đặt nhưng không vượt <b>{AZUBI_HOURS_IN_TERM}h/tuần</b>. Ngoài kỳ học:
          không có ngày học, mức tối đa là <b>{AZUBI_HOURS_OUT_OF_TERM}h/tuần</b>.
          Định mức tháng luôn tính cố định <b>{AZUBI_MONTHLY_WEEKS} tuần</b>: tối đa
          <b> {AZUBI_HOURS_IN_TERM * AZUBI_MONTHLY_WEEKS}h</b> trong kỳ và
          <b> {AZUBI_HOURS_OUT_OF_TERM * AZUBI_MONTHLY_WEEKS}h</b> ngoài kỳ.
        </p>
      </section>

      {azubis.map((emp) => {
        const cfg: AzubiConfig = azubiConfigOf(emp.azubi);
        const weekly = azubiWeeklyHours(cfg);
        const termHours = azubiConfiguredWeeklyHours(cfg, true);
        const outOfTermHours = azubiConfiguredWeeklyHours(cfg, false);
        const termExceeded = azubiExceedsWeeklyMaximum(cfg, true);
        const outOfTermExceeded = azubiExceedsWeeklyMaximum(cfg, false);
        const termInputId = `azubi-${emp.id}-term-hours`;
        const outOfTermInputId = `azubi-${emp.id}-out-hours`;

        const setCfg = (next: Partial<AzubiConfig>) =>
          updateEmployee(emp.id, { azubi: { ...cfg, ...next } });

        const toggleDay = (d: WeekdayName) =>
          setCfg({
            schoolDays: cfg.schoolDays.includes(d)
              ? cfg.schoolDays.filter((x) => x !== d)
              : cfg.schoolDays.length < SCHOOL_DAYS_EXPECTED
                ? [...cfg.schoolDays, d]
                : cfg.schoolDays,
          });

        return (
          <section
            key={emp.id}
            className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-slate-900">{emp.name}</h3>
              <span className="text-sm text-slate-500">
                <b className="text-slate-900">{emp.targetMinutes / 60}h/tháng</b>
                {" · "}{weekly}h/tuần
              </span>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded border border-slate-200 bg-slate-50 p-3">
                <label
                  htmlFor={termInputId}
                  className="block text-xs font-medium text-slate-700"
                >
                  Giờ/tuần trong kỳ học
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    id={termInputId}
                    type="number"
                    min={0}
                    step={0.5}
                    value={termHours}
                    aria-invalid={termExceeded}
                    onChange={(e) =>
                      setCfg({ weeklyHoursInTerm: Math.max(0, Number(e.target.value)) })
                    }
                    className={`w-28 rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 ${
                      termExceeded
                        ? "border-amber-400 focus:border-amber-500 focus:ring-amber-500"
                        : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
                    }`}
                  />
                  <span className="text-xs text-slate-500">tối đa {AZUBI_HOURS_IN_TERM}h</span>
                </div>
                {termExceeded && (
                  <p className="mt-2 text-xs font-medium text-amber-700" role="alert">
                    ⚠ Đã nhập {termHours}h, vượt mức tối đa {AZUBI_HOURS_IN_TERM}h.
                    Hệ thống chỉ dùng {azubiEffectiveWeeklyHours(cfg, true)}h/tuần để
                    tính và xếp lịch.
                  </p>
                )}
              </div>

              <div className="rounded border border-slate-200 bg-slate-50 p-3">
                <label
                  htmlFor={outOfTermInputId}
                  className="block text-xs font-medium text-slate-700"
                >
                  Giờ/tuần ngoài kỳ học
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    id={outOfTermInputId}
                    type="number"
                    min={0}
                    step={0.5}
                    value={outOfTermHours}
                    aria-invalid={outOfTermExceeded}
                    onChange={(e) =>
                      setCfg({ weeklyHoursOutOfTerm: Math.max(0, Number(e.target.value)) })
                    }
                    className={`w-28 rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 ${
                      outOfTermExceeded
                        ? "border-amber-400 focus:border-amber-500 focus:ring-amber-500"
                        : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
                    }`}
                  />
                  <span className="text-xs text-slate-500">
                    tối đa {AZUBI_HOURS_OUT_OF_TERM}h
                  </span>
                </div>
                {outOfTermExceeded && (
                  <p className="mt-2 text-xs font-medium text-amber-700" role="alert">
                    ⚠ Đã nhập {outOfTermHours}h, vượt mức tối đa {AZUBI_HOURS_OUT_OF_TERM}h.
                    Hệ thống chỉ dùng {azubiEffectiveWeeklyHours(cfg, false)}h/tuần để
                    tính và xếp lịch.
                  </p>
                )}
              </div>
            </div>

            <label className="mt-3 flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={cfg.inSchoolTerm}
                onChange={(e) => setCfg({ inSchoolTerm: e.target.checked })}
                className="h-5 w-5 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
              />
              <span className="text-sm text-slate-700">
                Đang trong kỳ học nghề
                <span className="text-slate-400">
                  {" "}
                  — bỏ tích nếu nghỉ hè / hết kỳ
                </span>
              </span>
            </label>

            {cfg.inSchoolTerm && (
              <div className="mt-3">
                <div className="text-xs text-slate-600 mb-1.5">
                  Ngày đi học (không xếp ca những ngày này):
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((d) => {
                    const on = cfg.schoolDays.includes(d);
                    const disabled = !on && cfg.schoolDays.length >= SCHOOL_DAYS_EXPECTED;
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        disabled={disabled}
                        onClick={() => toggleDay(d)}
                        className={`px-3 py-1.5 rounded-full border text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                          on
                            ? "bg-slate-900 text-white border-slate-900"
                            : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
                        }`}
                      >
                        {WEEKDAY_LABELS_VI[d]}
                      </button>
                    );
                  })}
                </div>

                {cfg.schoolDays.length !== SCHOOL_DAYS_EXPECTED && (
                  <p className="mt-2 text-xs text-amber-600">
                    ⚠ Đang chọn {cfg.schoolDays.length} ngày học, quy định là{" "}
                    {SCHOOL_DAYS_EXPECTED} ngày.
                  </p>
                )}
                <p className="mt-2 text-xs text-slate-500">
                  Ngoài 2 ngày học, hệ thống chia số giờ đã đặt trên {AZUBI_WORKDAYS_IN_TERM} ngày làm;
                  2 ngày còn lại sẽ nghỉ.
                </p>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
