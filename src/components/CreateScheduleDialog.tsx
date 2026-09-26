import { useState } from "react";
import type { UseScheduleReturn } from "../hooks/useSchedule";
import { MONTH_NAMES_VI } from "../lib/dateFormat";

/**
 * „Tạo lịch làm việc": fragt Monat und Jahr ab und erzeugt danach sofort den
 * Plan für diesen Monat (App wechselt vorher in den Monat).
 */
export function CreateScheduleDialog({
  store,
  onClose,
  onCreate,
}: {
  store: UseScheduleReturn;
  onClose: () => void;
  onCreate: (year: number, month: number) => void;
}) {
  const { schedule, savedMonths } = store;
  const [month, setMonth] = useState(schedule.month);
  const [year, setYear] = useState(schedule.year);
  const thisYear = new Date().getFullYear();
  const years = [...new Set([thisYear - 1, thisYear, thisYear + 1, schedule.year])].sort();
  const existing = savedMonths.find((m) => m.year === year && m.month === month);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-lg bg-white shadow-xl border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-200 px-4 py-3">
          <h3 className="font-semibold text-slate-900">Tạo lịch làm việc</h3>
          <p className="text-xs text-slate-500">Chọn tháng và năm cần tạo lịch.</p>
        </div>
        <div className="px-4 py-4 grid grid-cols-2 gap-3">
          <label className="flex flex-col">
            <span className="text-xs text-slate-600 mb-1">Tháng</span>
            <select
              className="rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base sm:text-sm"
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
            >
              {MONTH_NAMES_VI.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-slate-600 mb-1">Năm</span>
            <select
              className="rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base sm:text-sm"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          {existing && (
            <p className="col-span-2 rounded bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              Tháng {month}/{year} đã có lịch ({existing.shiftCount} ca). Tạo lại sẽ thay lịch này, kể cả
              những ca đã sửa tay.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-slate-200 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            onClick={() => onCreate(year, month)}
            className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-700"
          >
            {existing ? "Tạo lại lịch" : "Tạo lịch"}
          </button>
          <button
            onClick={onClose}
            className="ml-auto rounded px-3 py-2 text-sm text-slate-500 hover:text-slate-800"
          >
            Huỷ
          </button>
        </div>
      </div>
    </div>
  );
}
