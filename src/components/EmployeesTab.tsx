import { useMemo, useState } from "react";
import type { UseScheduleReturn } from "../hooks/useSchedule";
import {
  AZUBI_MONTHLY_WARNING_HOURS,
  type AzubiConfig,
  type Employee,
  type EmploymentType,
  type WeekdayName,
  type WorkRole,
} from "../types";
import { splitTargetHours } from "../lib/splitTargetHours";
import {
  azubiConfigOf,
  azubiMonthKey,
  azubiMonthMode,
  azubiMonthlyHoursNeedWarning,
  azubiMonthlyHoursForMonth,
} from "../lib/azubi";
import {
  hasRequiredFixedDaysOff,
  requiredFixedDaysOff,
  WEEKDAY_ORDER,
} from "../lib/fixedDaysOff";

const inputClass =
  "rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

export const WARN_HOURS = 192;

const WEEKDAY_LABELS: Record<WeekdayName, string> = {
  monday: "T2",
  tuesday: "T3",
  wednesday: "T4",
  thursday: "T5",
  friday: "T6",
  saturday: "T7",
  sunday: "CN",
};

const TYPE_SHORT: Record<EmploymentType, string> = {
  VOLLZEIT: "TT",
  TEILZEIT: "BT",
  AZUBI: "Azubi",
};

function splitInfo(targetHours: number, type: EmploymentType): { ok: boolean; text: string } {
  if (targetHours <= 0) return { ok: true, text: "—" };
  try {
    const parts = splitTargetHours(Math.round(targetHours), type);
    return { ok: true, text: `${parts.length} ca` };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : "không hợp lệ" };
  }
}

type Draft = {
  name: string;
  employmentType: EmploymentType;
  workRole: WorkRole | "";
  hours: string;
  fixedStoreWeekPattern: boolean;
  saved: boolean;
  fixedDaysOff: WeekdayName[];
  azubi: AzubiConfig;
};

function draftFrom(emp?: Employee): Draft {
  return {
    name: emp?.name ?? "",
    employmentType: emp?.employmentType ?? "VOLLZEIT",
    workRole: emp?.workRole ?? "",
    hours: emp ? String(emp.targetMinutes / 60) : "176",
    fixedStoreWeekPattern: emp?.fixedStoreWeekPattern === true,
    saved: emp?.saved === true,
    fixedDaysOff: emp?.fixedDaysOff ?? [],
    azubi: azubiConfigOf(emp?.azubi),
  };
}

function draftToEmployee(d: Draft): Omit<Employee, "id"> {
  const isAzubi = d.employmentType === "AZUBI";
  const stunden = Math.max(0, Math.round(Number(d.hours) || 0));
  return {
    name: d.name.trim() || "Nhân viên mới",
    employmentType: d.employmentType,
    // Bei Azubi wird targetMinutes vom Hook (withAutomaticAzubiTarget) aus der
    // Konfiguration neu berechnet; hier nur ein Platzhalter.
    targetMinutes: isAzubi ? 0 : stunden * 60,
    azubi: isAzubi ? d.azubi : undefined,
    workRole: d.workRole || undefined,
    fixedStoreWeekPattern: d.fixedStoreWeekPattern || undefined,
    saved: d.saved || undefined,
    // Teilzeit hat keine festen Ruhetage; Vollzeit/Azubi schon.
    fixedDaysOff: d.employmentType === "TEILZEIT" ? undefined : d.fixedDaysOff,
  };
}

export function EmployeesTab({ store }: { store: UseScheduleReturn }) {
  const { schedule, addEmployee, updateEmployee, removeEmployee } = store;

  const [offen, setOffen] = useState<null | "new" | string>(null);
  const bearbeitet = useMemo(
    () =>
      typeof offen === "string" && offen !== "new"
        ? schedule.employees.find((e) => e.id === offen)
        : undefined,
    [offen, schedule.employees],
  );

  return (
    <section className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-semibold text-slate-900">
          Nhân viên
          {schedule.employees.length > 0 && (
            <span className="ml-2 text-sm font-normal text-slate-400">
              {schedule.employees.length}
            </span>
          )}
        </h2>
        <button
          onClick={() => setOffen("new")}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 active:bg-slate-800"
        >
          + Thêm
        </button>
      </div>
      <p className="mb-4 text-xs text-slate-500">
        Bấm vào một người để sửa. Bật “Lịch 2 quán” cho nhân viên làm cả hai cửa hàng
        (Thienlong T2–T7, Vietpho Chủ Nhật). Vollzeit chọn 1 ngày nghỉ cố định, Azubi 2 ngày.
      </p>

      {schedule.employees.length === 0 ? (
        <div className="py-8 text-center text-slate-400">
          Chưa có nhân viên. Bấm <b>+ Thêm</b> để tạo.
        </div>
      ) : (
        <ul className="space-y-2">
          {schedule.employees.map((emp) => (
            <li key={emp.id}>
              <button
                onClick={() => setOffen(emp.id)}
                className="w-full text-left rounded-lg border border-slate-200 p-3 flex items-center gap-3 hover:bg-slate-50 active:bg-slate-100 transition-colors"
              >
                <EmployeeSummaryRow
                  emp={emp}
                  year={schedule.year}
                  month={schedule.month}
                  storeId={store.storeId}
                />
                <span className="text-slate-300 text-lg leading-none">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        onClick={() => setOffen("new")}
        aria-label="Thêm nhân viên"
        className="sm:hidden fixed bottom-5 right-5 z-40 h-14 w-14 rounded-full bg-slate-900 text-white text-2xl shadow-lg active:bg-slate-700 flex items-center justify-center"
      >
        +
      </button>

      {offen !== null && (
        <EmployeeSheet
          key={bearbeitet?.id ?? "new"}
          employee={bearbeitet}
          year={schedule.year}
          month={schedule.month}
          storeId={store.storeId}
          onClose={() => setOffen(null)}
          onSave={(felder) => {
            if (bearbeitet) updateEmployee(bearbeitet.id, felder);
            else addEmployee(felder);
            setOffen(null);
          }}
          onDelete={
            bearbeitet
              ? () => {
                  removeEmployee(bearbeitet.id);
                  setOffen(null);
                }
              : undefined
          }
        />
      )}
    </section>
  );
}

function EmployeeSummaryRow({
  emp,
  year,
  month,
  storeId,
}: {
  emp: Employee;
  year: number;
  month: number;
  storeId: string;
}) {
  const isAzubi = emp.employmentType === "AZUBI";
  const azubiConfig = isAzubi ? azubiConfigOf(emp.azubi) : null;
  const azubiMonthlyHours = azubiConfig ? azubiMonthlyHoursForMonth(azubiConfig, year, month) : 0;
  const stunden = emp.targetMinutes / 60;
  const info = isAzubi
    ? { ok: true, text: `${azubiMonthlyHours}h · Azubi` }
    : splitInfo(stunden, emp.employmentType);
  const tooMany = !isAzubi && stunden > WARN_HOURS;
  const requiredDaysOff = requiredFixedDaysOff(emp.employmentType);
  const daysOffOk = hasRequiredFixedDaysOff(emp, storeId);

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="font-medium text-slate-900 truncate">{emp.name}</span>
        <span className="shrink-0 rounded bg-slate-100 text-slate-600 text-[11px] px-1.5 py-0.5">
          {TYPE_SHORT[emp.employmentType]}
        </span>
        {emp.workRole ? (
          <span
            className={`shrink-0 rounded text-[11px] px-1.5 py-0.5 ${
              emp.workRole === "KITCHEN" ? "bg-orange-50 text-orange-700" : "bg-sky-50 text-sky-700"
            }`}
          >
            {emp.workRole === "KITCHEN" ? "Bếp" : "Bồi"}
          </span>
        ) : null}
        {emp.fixedStoreWeekPattern ? (
          <span className="shrink-0 rounded bg-sky-100 text-sky-800 text-[11px] px-1.5 py-0.5">
            2 quán
          </span>
        ) : null}
        {tooMany && <span className="shrink-0 text-amber-600 text-xs">⚠</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
        <span>
          {!isAzubi && `${stunden}h · `}
          <span className={info.ok ? "" : "text-rose-600"}>{info.text}</span>
        </span>
        {requiredDaysOff > 0 && (
          <span className={daysOffOk ? "text-slate-400" : "text-amber-700 font-medium"}>
            · nghỉ {(emp.fixedDaysOff ?? []).map((d) => WEEKDAY_LABELS[d]).join(" ") || "—"}
            {!daysOffOk && ` (cần ${requiredDaysOff})`}
          </span>
        )}
      </div>
    </div>
  );
}

function EmployeeSheet({
  employee,
  year,
  month,
  storeId,
  onClose,
  onSave,
  onDelete,
}: {
  employee?: Employee;
  year: number;
  month: number;
  storeId: string;
  onClose: () => void;
  onSave: (felder: Omit<Employee, "id">) => void;
  onDelete?: () => void;
}) {
  const [d, setD] = useState<Draft>(() => draftFrom(employee));
  const [loeschFrage, setLoeschFrage] = useState(false);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));

  const showWorkRole = storeId === "thienlong";
  const isAzubi = d.employmentType === "AZUBI";
  const stunden = Math.max(0, Math.round(Number(d.hours) || 0));
  const info = splitInfo(stunden, d.employmentType);
  const tooMany = !isAzubi && stunden > WARN_HOURS;

  const azubiMode = azubiMonthMode(d.azubi, year, month);
  const azubiMonthlyHours = azubiMonthlyHoursForMonth(d.azubi, year, month);
  const azubiWarning = azubiMonthlyHoursNeedWarning(d.azubi, year, month);

  const setAzubiHours = (value: number) => {
    const v = Math.max(0, value);
    if (azubiMode !== "work") {
      set("azubi", {
        ...d.azubi,
        monthlyHoursByMonth: {
          ...(d.azubi.monthlyHoursByMonth ?? {}),
          [azubiMonthKey(year, month)]: v,
        },
      });
    } else {
      set("azubi", { ...d.azubi, monthlyHoursOutOfTerm: v });
    }
  };

  const requiredDaysOff = requiredFixedDaysOff(d.employmentType);
  const draftEmp: Employee = { id: "draft", ...draftToEmployee(d) };
  const daysOffOk = hasRequiredFixedDaysOff(draftEmp, storeId);

  const toggleDayOff = (weekday: WeekdayName) => {
    const selected = d.fixedDaysOff.includes(weekday);
    const next = selected
      ? d.fixedDaysOff.filter((day) => day !== weekday)
      : requiredDaysOff === 1
        ? [weekday]
        : [...d.fixedDaysOff, weekday];
    set("fixedDaysOff", next);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-lg bg-white shadow-xl border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900">
            {employee ? "Sửa nhân viên" : "Thêm nhân viên"}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
            ✕
          </button>
        </div>

        <div className="px-4 py-3 space-y-4">
          <label className="block">
            <span className="text-xs text-slate-600">Tên</span>
            <input
              autoFocus={!employee}
              className={`${inputClass} w-full mt-1`}
              value={d.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Tên nhân viên"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-600">Hình thức</span>
              <select
                className={`${inputClass} w-full mt-1`}
                value={d.employmentType}
                onChange={(e) => set("employmentType", e.target.value as EmploymentType)}
              >
                <option value="VOLLZEIT">Toàn thời gian</option>
                <option value="TEILZEIT">Bán thời gian</option>
                <option value="AZUBI">Azubi (học nghề)</option>
              </select>
            </label>
            {showWorkRole ? (
              <label className="block">
                <span className="text-xs text-slate-600">Vị trí</span>
                <select
                  className={`${inputClass} w-full mt-1`}
                  value={d.workRole}
                  onChange={(e) => set("workRole", e.target.value as WorkRole | "")}
                >
                  <option value="">Chọn</option>
                  <option value="KITCHEN">Bếp</option>
                  <option value="SERVICE">Bồi</option>
                </select>
              </label>
            ) : (
              <span />
            )}
          </div>

          {isAzubi ? (
            <label className="block">
              <span className="text-xs text-slate-600">
                Giờ Azubi tháng {month}/{year}{" "}
                {azubiMode === "school" ? "· kỳ học" : azubiMode === "mixed" ? "· học/làm" : "· chủ đặt"}
              </span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  className={`${inputClass} w-32 ${azubiWarning ? "border-amber-400 text-amber-900" : ""}`}
                  value={azubiMonthlyHours}
                  onChange={(e) => setAzubiHours(Number(e.target.value))}
                />
                <span className="text-slate-400 text-sm">h</span>
              </div>
              {azubiWarning && (
                <span className="mt-1 block text-[11px] text-amber-700">
                  Trên {AZUBI_MONTHLY_WARNING_HOURS}h/tháng lịch có thể khó xếp; số giờ vẫn giữ.
                </span>
              )}
            </label>
          ) : (
            <label className="block">
              <span className="text-xs text-slate-600">Giờ định mức / tháng</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                className={`${inputClass} w-full mt-1`}
                value={d.hours}
                onChange={(e) => set("hours", e.target.value)}
              />
              <span className={`mt-1 block text-xs ${info.ok ? "text-slate-500" : "text-rose-600"}`}>
                {info.text}
                {tooMany && (
                  <span className="text-amber-600 font-medium"> · ⚠ &gt;{WARN_HOURS}h/tháng</span>
                )}
              </span>
            </label>
          )}

          {/* Lịch 2 quán + Lưu */}
          <div className="flex flex-wrap gap-4 border-t border-slate-100 pt-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={d.fixedStoreWeekPattern}
                onChange={(e) => set("fixedStoreWeekPattern", e.target.checked)}
                className="h-5 w-5 rounded border-slate-300 text-sky-700 focus:ring-sky-600"
              />
              <span className={`text-sm ${d.fixedStoreWeekPattern ? "font-medium text-sky-800" : "text-slate-600"}`}>
                Lịch 2 quán
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={d.saved}
                onChange={(e) => set("saved", e.target.checked)}
                className="h-5 w-5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span className={`text-sm ${d.saved ? "text-emerald-700 font-medium" : "text-slate-600"}`}>
                Lưu (đã kiểm tra)
              </span>
            </label>
          </div>

          {/* Ngày nghỉ cố định (= chọn ngày làm trong tuần) */}
          {requiredDaysOff > 0 && (
            <div
              className={`rounded-md border px-3 py-2 ${
                daysOffOk ? "border-emerald-200 bg-emerald-50/70" : "border-amber-200 bg-amber-50/70"
              }`}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-700">
                  Ngày nghỉ cố định · chọn {requiredDaysOff} ngày/tuần
                </span>
                <span className={`text-xs ${daysOffOk ? "text-emerald-700" : "text-amber-700"}`}>
                  {d.fixedDaysOff.length}/{requiredDaysOff}
                </span>
              </div>
              <div className="grid grid-cols-7 gap-1.5">
                {WEEKDAY_ORDER.map((weekday) => {
                  const selected = d.fixedDaysOff.includes(weekday);
                  const lockedByStorePattern = d.fixedStoreWeekPattern && weekday === "sunday";
                  const maxReached =
                    requiredDaysOff > 1 && d.fixedDaysOff.length >= requiredDaysOff && !selected;
                  return (
                    <button
                      key={weekday}
                      type="button"
                      aria-pressed={selected}
                      disabled={maxReached || lockedByStorePattern}
                      onClick={() => toggleDayOff(weekday)}
                      className={`rounded border px-2 py-1.5 text-xs font-medium transition-colors ${
                        selected
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-300 bg-white text-slate-600 hover:border-slate-500"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      {WEEKDAY_LABELS[weekday]}
                    </button>
                  );
                })}
              </div>
              {d.fixedStoreWeekPattern && (
                <p className="mt-1.5 text-[11px] text-sky-700">
                  {storeId === "thienlong"
                    ? "Lịch 2 quán khóa CN là ngày nghỉ tại Thienlong."
                    : "Lịch 2 quán khóa CN là ngày làm tại Vietpho."}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-white border-t border-slate-200 px-4 py-3">
          {loeschFrage ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-slate-600">Xoá nhân viên này?</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setLoeschFrage(false)}
                  className="rounded px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
                >
                  Không
                </button>
                <button
                  onClick={onDelete}
                  className="rounded bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700"
                >
                  Xoá
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              {onDelete ? (
                <button
                  onClick={() => setLoeschFrage(true)}
                  className="text-rose-600 hover:text-rose-800 text-sm font-medium"
                >
                  Xoá
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  className="rounded px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
                >
                  Huỷ
                </button>
                <button
                  onClick={() => onSave(draftToEmployee(d))}
                  disabled={showWorkRole && !d.workRole}
                  className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Lưu
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
