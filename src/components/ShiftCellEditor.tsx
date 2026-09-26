import { useState } from "react";
import type { UseScheduleReturn } from "../hooks/useSchedule";
import { calculatePause, minutesToShortHours, minutesToTime, timeToMinutes } from "../lib/time";
import { isoLabel, piecesError } from "../lib/shiftOps";
import { WEEKDAY_LABELS_VI, weekdayKeyOf, parseIsoDate } from "../lib/demand";
import { resolveDay } from "../lib/workHours";
import { holidaysOf } from "../lib/holidays";
import { isEmployeeFixedDayOff } from "../lib/fixedDaysOff";
import { employmentPeriodLabel } from "../lib/employmentPeriod";
import { isEmployeeAvailableOn, unavailableReason } from "../lib/availability";

const inputClass =
  "rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

export function ShiftCellEditor({
  store,
  employeeId,
  date,
  onClose,
}: {
  store: UseScheduleReturn;
  employeeId: string;
  date: string;
  onClose: () => void;
}) {
  const { schedule, findShift, editShiftPieces, addShift, deleteShift, setFrei, moveShiftToEmployee } =
    store;
  const employee = schedule.employees.find((e) => e.id === employeeId)!;
  const shift = findShift(employeeId, date);
  const fixedDayOff = isEmployeeFixedDayOff(employee, date);
  const inactive = unavailableReason(employee, date);
  const blocked = fixedDayOff || !!inactive;

  // Standardzeiten für eine neue Schicht = Arbeitszeit-Fenster dieses Tages
  // (inkl. Ausnahmen / Feiertag).
  const overrideMap = Object.fromEntries(schedule.dateOverrides.map((o) => [o.date, o]));
  const resolved = resolveDay(schedule.workHours, date, holidaysOf(schedule.year, schedule.holidayState), overrideMap);
  const win = resolved.closed ? schedule.workHours.holiday[0] : resolved.blocks[0];
  // Ca gãy: zwei Stücke (Ca 1 / Ca 2), jeweils Giờ vào / Giờ ra.
  const initialPieces = shift
    ? (shift.segments && shift.segments.length > 1
        ? shift.segments
        : [{ startMinutes: shift.startMinutes, endMinutes: shift.endMinutes }])
    : [{ startMinutes: win.startMinutes, endMinutes: win.endMinutes }];
  const [pieces, setPieces] = useState(
    initialPieces.map((g) => ({ start: minutesToTime(g.startMinutes), end: minutesToTime(g.endMinutes) })),
  );
  const [pause, setPause] = useState(String(shift?.pauseMinutes ?? 30));
  const split = pieces.length > 1;
  const setPiece = (i: number, key: "start" | "end", value: string) =>
    setPieces((prev) => prev.map((p, j) => (j === i ? { ...p, [key]: value } : p)));
  const addSecondPiece = () => {
    const lastBlock = resolved.closed ? win : resolved.blocks[resolved.blocks.length - 1];
    let firstEnd = 15 * 60;
    try {
      firstEnd = timeToMinutes(pieces[0].end);
    } catch {
      // Ungültige Eingabe – Standard 15:00 nehmen.
    }
    const start = Math.max(firstEnd + 60, Math.min(17 * 60, lastBlock.endMinutes - 3 * 60));
    setPieces((prev) => [
      prev[0],
      { start: minutesToTime(start), end: minutesToTime(Math.max(start + 60, lastBlock.endMinutes)) },
    ]);
  };

  let paidPreview = 0;
  let parseError = "";
  let parsed: { startMinutes: number; endMinutes: number }[] = [];
  try {
    parsed = pieces.map((p) => ({ startMinutes: timeToMinutes(p.start), endMinutes: timeToMinutes(p.end) }));
    parseError = piecesError(parsed) ?? "";
    paidPreview = split
      ? parsed.reduce((sum, g) => sum + g.endMinutes - g.startMinutes, 0)
      : parsed[0].endMinutes - parsed[0].startMinutes - Number(pause);
  } catch (e) {
    parseError = e instanceof Error ? e.message : "Giờ không hợp lệ";
  }
  const suggestedPause = calculatePause(Math.max(0, paidPreview));

  // Nhân viên còn rảnh trong ngày này (để „chuyển ca").
  const freeEmployees = schedule.employees.filter(
    (e) =>
      e.id !== employeeId &&
      !findShift(e.id, date) &&
      !isEmployeeFixedDayOff(e, date) &&
      isEmployeeAvailableOn(e, date),
  );

  const weekday = WEEKDAY_LABELS_VI[weekdayKeyOf(parseIsoDate(date))];

  function save() {
    if (parseError || blocked) return;
    const p = split ? 0 : Number(pause);
    if (shift) {
      editShiftPieces(shift.id, parsed, p);
    } else {
      addShift(employeeId, date, parsed, p);
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md rounded-t-2xl sm:rounded-lg bg-white shadow-xl border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-200 px-4 py-3">
          <h3 className="font-semibold text-slate-900">{employee.name}</h3>
          <p className="text-xs text-slate-500">
            {weekday}, {isoLabel(date)}
          </p>
          {resolved.closed && (
            <p className="text-xs text-rose-600 mt-0.5">
              Ngày này được đặt „đóng cửa" — ca thêm ở đây là ngoại lệ.
            </p>
          )}
          {inactive && (
            <p className="mt-0.5 text-xs font-medium text-violet-700">
              {inactive}{employmentPeriodLabel(employee) && ` (${employmentPeriodLabel(employee)})`}. Không thể thêm ca ở ngày này.
            </p>
          )}
          {fixedDayOff && (
            <p className="mt-0.5 text-xs font-medium text-amber-700">
              Đây là ngày nghỉ cố định của nhân viên. Không thể thêm hoặc chỉnh ca ở ngày này.
            </p>
          )}
        </div>

        <div className="px-4 py-4 space-y-3">
          {pieces.map((p, i) => (
            <div key={i}>
              {split && (
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700">Ca {i + 1}</span>
                  {i === 1 && (
                    <button
                      type="button"
                      onClick={() => setPieces((prev) => [prev[0]])}
                      className="text-xs text-rose-600 hover:underline"
                    >
                      Bỏ ca 2
                    </button>
                  )}
                </div>
              )}
              <div className="grid grid-cols-3 gap-3">
                <label className="flex flex-col">
                  <span className="text-xs text-slate-600 mb-1">Giờ vào</span>
                  <input
                    type="time"
                    className={inputClass}
                    value={p.start}
                    onChange={(e) => setPiece(i, "start", e.target.value)}
                  />
                </label>
                <label className="flex flex-col">
                  <span className="text-xs text-slate-600 mb-1">Giờ ra</span>
                  <input
                    type="time"
                    className={inputClass}
                    value={p.end}
                    onChange={(e) => setPiece(i, "end", e.target.value)}
                  />
                </label>
                {!split ? (
                  <label className="flex flex-col">
                    <span className="text-xs text-slate-600 mb-1">Nghỉ (phút)</span>
                    <input
                      type="number"
                      min={0}
                      step={5}
                      className={inputClass}
                      value={pause}
                      onChange={(e) => setPause(e.target.value)}
                    />
                  </label>
                ) : (
                  <div className="flex flex-col justify-end pb-2 text-xs text-slate-500">
                    {parsed[i] && parsed[i].endMinutes > parsed[i].startMinutes
                      ? minutesToShortHours(parsed[i].endMinutes - parsed[i].startMinutes)
                      : ""}
                  </div>
                )}
              </div>
            </div>
          ))}
          {!split && (
            <button
              type="button"
              onClick={addSecondPiece}
              className="text-sm font-medium text-slate-700 hover:underline"
            >
              + Thêm ca 2 (ca gãy)
            </button>
          )}

          {parseError ? (
            <div className="text-sm text-rose-600">{parseError}</div>
          ) : (
            <div className="text-sm text-slate-600">
              Giờ công: <span className="font-medium">{minutesToShortHours(paidPreview)}</span>
              {split && <span className="text-slate-500"> (ca gãy, khoảng giữa không tính giờ)</span>}
              {paidPreview > 10 * 60 && <span className="text-rose-600"> · quá 10 giờ!</span>}
              {!split && Number(pause) !== suggestedPause && (
                <span className="text-amber-600"> · nghỉ đề xuất: {suggestedPause} phút</span>
              )}
            </div>
          )}

          {freeEmployees.length > 0 && shift && (
            <label className="flex flex-col">
              <span className="text-xs text-slate-600 mb-1">Chuyển ca sang</span>
              <select
                className={inputClass}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    moveShiftToEmployee(shift.id, e.target.value);
                    onClose();
                  }
                }}
              >
                <option value="">— Chọn nhân viên —</option>
                {freeEmployees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-3">
          <button
            onClick={save}
            disabled={!!parseError || blocked}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 active:bg-slate-800 disabled:opacity-40"
          >
            {inactive ?? (fixedDayOff ? "Ngày nghỉ cố định" : shift ? "Lưu" : "Thêm ca")}
          </button>
          {shift && (
            <>
              <button
                onClick={() => {
                  setFrei(employeeId, date);
                  onClose();
                }}
                className="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
              >
                Đánh dấu nghỉ
              </button>
              <button
                onClick={() => {
                  deleteShift(shift.id);
                  onClose();
                }}
                className="rounded border border-rose-300 text-rose-600 px-3 py-2 text-sm hover:bg-rose-50"
              >
                Xoá
              </button>
            </>
          )}
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
