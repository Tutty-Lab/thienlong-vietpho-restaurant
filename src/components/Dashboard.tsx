import type { UseScheduleReturn } from "../hooks/useSchedule";
import { minutesToDecimalHours } from "../lib/time";

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg bg-white border border-slate-200 px-2.5 py-1.5 sm:px-3 sm:py-2 shadow-sm">
      <div className="text-[11px] sm:text-xs text-slate-500 leading-tight">{label}</div>
      <div className={`text-base sm:text-lg font-semibold leading-tight ${accent ?? "text-slate-900"}`}>
        {value}
      </div>
    </div>
  );
}

export function Dashboard({ store }: { store: UseScheduleReturn }) {
  const { schedule, validation, readiness } = store;
  const vz = schedule.employees.filter((e) => e.employmentType === "VOLLZEIT").length;
  const tz = schedule.employees.filter((e) => e.employmentType === "TEILZEIT").length;
  const az = schedule.employees.filter((e) => e.employmentType === "AZUBI").length;
  const targetMin = schedule.employees.reduce((s, e) => s + e.targetMinutes, 0);
  const plannedMin = schedule.shifts.reduce((s, x) => s + x.paidMinutes, 0);
  const notGenerated = schedule.shifts.length === 0;

  const statusValue = notGenerated
    ? readiness.ready
      ? "Sẵn sàng"
      : "Chưa sẵn sàng"
    : validation.valid
      ? "Hợp lệ"
      : `${validation.errors.length} lỗi`;
  const statusAccent = notGenerated
    ? readiness.ready
      ? "text-emerald-600"
      : "text-amber-600"
    : validation.valid
      ? "text-emerald-600"
      : "text-rose-600";

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
        <Stat label="Số nhân viên" value={String(schedule.employees.length)} />
        <Stat label="Toàn thời gian" value={String(vz)} />
        <Stat label="Bán thời gian" value={String(tz)} />
        <Stat label="Azubi" value={String(az)} />
        <Stat label="Tổng giờ định mức" value={`${minutesToDecimalHours(targetMin)} h`} />
        <Stat label="Tổng giờ đã xếp" value={`${minutesToDecimalHours(plannedMin)} h`} />
        <Stat label="Trạng thái kiểm tra" value={statusValue} accent={statusAccent} />
      </div>
      {notGenerated && readiness.ready && (
        <div className="mt-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">
          Cấu hình đã đầy đủ. Có thể sang tab “Lịch làm việc” để tạo lịch.
        </div>
      )}
      {notGenerated && !readiness.ready && (
        <div className="mt-2 rounded bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">
          <div className="font-medium">Cần hoàn tất cấu hình trước khi tạo lịch:</div>
          <ul className="mt-1 list-disc pl-5">
            {readiness.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      )}
      {validation.valid && schedule.shifts.length > 0 && (
        <div className="mt-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">
          Tất cả giờ định mức đã được phân bổ chính xác.
        </div>
      )}
    </div>
  );
}
