import { useMemo, useState } from "react";
import type { UseScheduleReturn } from "../hooks/useSchedule";
import { minutesToTime, timeToMinutes } from "../lib/time";
import { MONTH_NAMES_VI } from "../lib/dateFormat";
import {
  WEEKDAY_LABELS_VI,
  WEEKDAY_SHORT_VI,
  datesOfMonth,
  parseIsoDate,
  weekdayKeyOf,
  type WeekdayKey,
} from "../lib/demand";
import {
  defaultWorkHoursForStore,
  type DayBlocks,
  type DayWindow,
  type WorkHoursConfig,
} from "../lib/workHours";
import { holidayNames as holidayNamesOf, HOLIDAY_STATE_LABELS } from "../lib/holidays";
import { isoLabel } from "../lib/shiftOps";
import { STORES } from "../lib/stores";
import { normalizeSurchargeConfig } from "../lib/zuschlaege";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-700 mb-1">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

const timeClass =
  "rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

const WEEKDAY_ORDER: WeekdayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** Ein Zeitfeld-Paar (Beginn/Ende) für einen Block. */
function BlockFields({
  block,
  onChange,
}: {
  block: DayWindow;
  onChange: (next: DayWindow) => void;
}) {
  return (
    <>
      <input
        type="time"
        className={`${timeClass} min-w-0 flex-1 sm:flex-none`}
        value={minutesToTime(block.startMinutes)}
        onChange={(e) => {
          try {
            onChange({ ...block, startMinutes: timeToMinutes(e.target.value) });
          } catch {
            /* nhập chưa xong */
          }
        }}
      />
      <span className="text-slate-400">–</span>
      <input
        type="time"
        className={`${timeClass} min-w-0 flex-1 sm:flex-none`}
        value={minutesToTime(block.endMinutes)}
        onChange={(e) => {
          try {
            onChange({ ...block, endMinutes: timeToMinutes(e.target.value) });
          } catch {
            /* nhập chưa xong */
          }
        }}
      />
    </>
  );
}

/**
 * Zeile für einen Tag. Ein Tag kann einen durchgehenden Block haben oder zwei
 * (mittags geschlossen). Der zweite Block lässt sich hier zu- und abschalten.
 */
function DayRow({
  label,
  hint,
  blocks,
  onChange,
}: {
  label: string;
  hint?: string;
  blocks: DayBlocks;
  onChange: (next: DayBlocks) => void;
}) {
  const split = blocks.length > 1;

  function setBlock(i: number, next: DayWindow) {
    onChange(blocks.map((b, k) => (k === i ? next : b)));
  }

  function toggleSplit() {
    if (split) {
      // Zurück auf durchgehend: vom ersten Beginn bis zum letzten Ende.
      onChange([
        { startMinutes: blocks[0].startMinutes, endMinutes: blocks[blocks.length - 1].endMinutes },
      ]);
    } else {
      // Aufteilen: Vorschlag mittags 15:00–16:30 geschlossen.
      const only = blocks[0];
      onChange([
        { startMinutes: only.startMinutes, endMinutes: 15 * 60 },
        { startMinutes: 16 * 60 + 30, endMinutes: only.endMinutes },
      ]);
    }
  }

  return (
    <div className="py-1.5 border-b border-slate-100 last:border-0">
      <div className="flex items-center gap-2">
        <div className="w-24 sm:w-40 shrink-0">
          <div className="text-sm text-slate-700 leading-tight">{label}</div>
          {hint && <div className="text-[11px] text-slate-400">{hint}</div>}
        </div>
        <BlockFields block={blocks[0]} onChange={(next) => setBlock(0, next)} />
        <button
          type="button"
          onClick={toggleSplit}
          className="ml-auto shrink-0 text-xs text-slate-500 hover:text-slate-900 underline"
        >
          {split ? "Bỏ nghỉ trưa" : "Thêm nghỉ trưa"}
        </button>
      </div>

      {split && (
        <div className="flex items-center gap-2 mt-1.5">
          <div className="w-24 sm:w-40 shrink-0 text-[11px] text-slate-400">
            đóng cửa {minutesToTime(blocks[0].endMinutes)}–
            {minutesToTime(blocks[1].startMinutes)}
          </div>
          <BlockFields block={blocks[1]} onChange={(next) => setBlock(1, next)} />
        </div>
      )}
    </div>
  );
}

export function SettingsTab({ store }: { store: UseScheduleReturn }) {
  const { schedule, updateMeta, upsertOverride, removeOverride } = store;
  const surchargeConfig = normalizeSurchargeConfig(schedule.surchargeConfig);
  const years = Array.from({ length: 7 }, (_, i) => new Date().getFullYear() - 1 + i);

  // ---- Ngày đặc biệt (Ausnahmen) ----
  const monthDates = useMemo(
    () => datesOfMonth(schedule.year, schedule.month),
    [schedule.year, schedule.month],
  );
  const [ovDate, setOvDate] = useState<string>("");
  const [ovMode, setOvMode] = useState<"closed" | "custom">("closed");
  const [ovStart, setOvStart] = useState("10:30");
  const [ovEnd, setOvEnd] = useState("16:00");
  const [ovNote, setOvNote] = useState("");

  const effectiveOvDate = ovDate || monthDates[0];

  function addOverride() {
    if (!effectiveOvDate) return;
    if (ovMode === "closed") {
      upsertOverride({ date: effectiveOvDate, closed: true, note: ovNote.trim() || undefined });
    } else {
      try {
        upsertOverride({
          date: effectiveOvDate,
          closed: false,
          window: { startMinutes: timeToMinutes(ovStart), endMinutes: timeToMinutes(ovEnd) },
          note: ovNote.trim() || undefined,
        });
      } catch {
        return;
      }
    }
    setOvNote("");
  }

  function setWeekdayBlocks(key: WeekdayKey, next: DayBlocks) {
    const workHours: WorkHoursConfig = {
      ...schedule.workHours,
      perWeekday: { ...schedule.workHours.perWeekday, [key]: next },
    };
    updateMeta({ workHours });
  }

  function setHolidayBlocks(next: DayBlocks) {
    updateMeta({ workHours: { ...schedule.workHours, holiday: next } });
  }

  const overridesByDate = useMemo(
    () => new Map(schedule.dateOverrides.map((o) => [o.date, o] as const)),
    [schedule.dateOverrides],
  );

  // Feiertage (Brandenburg) im gewählten Monat.
  const holidaysThisMonth = useMemo(() => {
    const names = holidayNamesOf(schedule.year, schedule.holidayState);
    const monthDates = new Set(datesOfMonth(schedule.year, schedule.month));
    return [...names.entries()]
      .filter(([iso]) => monthDates.has(iso))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [schedule.year, schedule.month]);

  return (
    <div className="space-y-4 max-w-3xl">
      <section className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Cài đặt chung</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <Field label="Cửa hàng">
              <select
                className={inputClass}
                value={store.storeId}
                onChange={(e) => store.setStoreId(e.target.value)}
              >
                {STORES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">
                Đổi cửa hàng là chuyển sang dữ liệu riêng của cửa hàng đó — nhân viên, lịch làm việc
                và giờ làm đều tách biệt.
              </p>
            </Field>
          </div>

          <div className="md:col-span-2">
            <Field label="Tên công ty / cửa hàng">
              <div className="w-full rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                {schedule.companyName}
              </div>
            </Field>
          </div>

          <div className="md:col-span-2">
            <Field label="Địa chỉ (in trên tờ chấm công)">
              <div className="w-full rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                {schedule.address}
              </div>
            </Field>
          </div>

          <Field label="Tháng">
            <select
              className={inputClass}
              value={schedule.month}
              onChange={(e) => updateMeta({ month: Number(e.target.value) })}
            >
              {MONTH_NAMES_VI.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Năm">
            <select
              className={inputClass}
              value={schedule.year}
              onChange={(e) => updateMeta({ year: Number(e.target.value) })}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      {store.storeId === "thienlong" && (
        <section className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900 mb-1">Hệ số Zuschläge</h2>
          <p className="text-xs text-slate-500 mb-3">
            Dùng để quy đổi số giờ được cộng thêm trên bảng chấm công. Nếu một giờ vừa là
            Chủ Nhật vừa sau 20:00 thì được cộng cả hai mức.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Làm sau 20:00 (%)">
              <input
                type="number"
                min="0"
                step="0.5"
                inputMode="decimal"
                className={inputClass}
                value={surchargeConfig.after20Percent}
                onChange={(e) =>
                  updateMeta({
                    surchargeConfig: {
                      ...surchargeConfig,
                      after20Percent: Math.max(0, Number(e.target.value) || 0),
                    },
                  })
                }
              />
            </Field>
            <Field label="Làm Chủ Nhật (%)">
              <input
                type="number"
                min="0"
                step="0.5"
                inputMode="decimal"
                className={inputClass}
                value={surchargeConfig.sundayPercent}
                onChange={(e) =>
                  updateMeta({
                    surchargeConfig: {
                      ...surchargeConfig,
                      sundayPercent: Math.max(0, Number(e.target.value) || 0),
                    },
                  })
                }
              />
            </Field>
          </div>
        </section>
      )}

      <section className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Giờ làm theo ngày</h2>
        <p className="text-xs text-slate-500 mb-3">
          Đây là <span className="font-medium">khung giờ làm</span> (giờ xếp ca) cho mỗi ngày trong
          tuần. Ca sáng nằm trong khung đầu, ca tối nằm trong khung cuối. Ngày nào đóng cửa nghỉ
          trưa thì bấm <span className="font-medium">Thêm nghỉ trưa</span> để tách làm hai khung —
          lịch sẽ không bao giờ xếp ai vào quãng đóng cửa đó.
        </p>

        <div>
          {WEEKDAY_ORDER.map((key) => (
            <DayRow
              key={key}
              label={WEEKDAY_LABELS_VI[key]}
              blocks={schedule.workHours.perWeekday[key]}
              onChange={(next) => setWeekdayBlocks(key, next)}
            />
          ))}
          <div className="my-2 border-t border-slate-200" />
          <DayRow
            label="Ngày lễ"
            hint={`Tự áp dụng cho ngày lễ ${HOLIDAY_STATE_LABELS[schedule.holidayState]}`}
            blocks={schedule.workHours.holiday}
            onChange={setHolidayBlocks}
          />
        </div>

        <button
          type="button"
          onClick={() => {
            if (confirm("Đặt lại toàn bộ giờ làm về mặc định của cửa hàng?")) {
              updateMeta({ workHours: defaultWorkHoursForStore(store.storeId) });
            }
          }}
          className="mt-3 text-xs text-slate-500 hover:text-slate-900 underline"
        >
          {store.storeId === "vietpho"
            ? "Đặt lại giờ mặc định Vietpho (nhân viên bắt đầu đúng giờ mở cửa)"
            : "Đặt lại giờ mặc định Thienlong (nhân viên đến trước giờ mở cửa 30 phút)"}
        </button>

        {holidaysThisMonth.length > 0 && (
          <div className="mt-3 rounded bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            <div className="font-medium mb-1">
              Ngày lễ {HOLIDAY_STATE_LABELS[schedule.holidayState]} trong {MONTH_NAMES_VI[schedule.month - 1]} {schedule.year}:
            </div>
            <ul className="space-y-1">
              {holidaysThisMonth.map(([iso, name]) => {
                const ov = overridesByDate.get(iso);
                return (
                  <li key={iso} className="flex items-center gap-2 flex-wrap">
                    <span>
                      {isoLabel(iso)} — {name}
                    </span>
                    {ov?.closed ? (
                      <span className="text-rose-600 font-medium">· đã đóng cửa</span>
                    ) : (
                      <button
                        onClick={() =>
                          upsertOverride({ date: iso, closed: true, note: name })
                        }
                        className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100"
                      >
                        Đóng cửa ngày này
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Ngày đặc biệt</h2>
        <p className="text-xs text-slate-500 mb-3">
          Cài đặt riêng cho một ngày cụ thể: <span className="font-medium">đóng cửa cả ngày</span> hoặc
          <span className="font-medium"> giờ làm riêng</span> (VD nghỉ nửa ngày). Sẽ ghi đè giờ theo thứ
          và ngày lễ khi tạo lịch.
        </p>

        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3 rounded bg-slate-50 border border-slate-200 p-3">
          <label className="flex flex-col sm:w-40">
            <span className="text-xs text-slate-600 mb-1">Ngày</span>
            <input
              type="date"
              className={`${timeClass} w-full`}
              min={monthDates[0]}
              max={monthDates[monthDates.length - 1]}
              value={effectiveOvDate}
              onChange={(e) => setOvDate(e.target.value)}
            />
          </label>
          <label className="flex flex-col sm:w-44">
            <span className="text-xs text-slate-600 mb-1">Kiểu</span>
            <select
              className={`${timeClass} w-full`}
              value={ovMode}
              onChange={(e) => setOvMode(e.target.value as "closed" | "custom")}
            >
              <option value="closed">Đóng cửa cả ngày</option>
              <option value="custom">Giờ làm riêng</option>
            </select>
          </label>
          {ovMode === "custom" && (
            <label className="flex flex-col">
              <span className="text-xs text-slate-600 mb-1">Giờ làm</span>
              <div className="flex items-center gap-1">
                <input
                  type="time"
                  className={`${timeClass} min-w-0 flex-1 sm:flex-none`}
                  value={ovStart}
                  onChange={(e) => setOvStart(e.target.value)}
                />
                <span className="text-slate-400">–</span>
                <input
                  type="time"
                  className={`${timeClass} min-w-0 flex-1 sm:flex-none`}
                  value={ovEnd}
                  onChange={(e) => setOvEnd(e.target.value)}
                />
              </div>
            </label>
          )}
          <label className="flex flex-col sm:grow sm:min-w-[140px]">
            <span className="text-xs text-slate-600 mb-1">Ghi chú (tuỳ chọn)</span>
            <input
              className={`${timeClass} w-full`}
              value={ovNote}
              onChange={(e) => setOvNote(e.target.value)}
              placeholder="VD: nghỉ nửa ngày"
            />
          </label>
          <button
            onClick={addOverride}
            className="rounded bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 active:bg-slate-800"
          >
            Lưu ngày này
          </button>
        </div>

        {schedule.dateOverrides.length > 0 ? (
          <ul className="mt-3 divide-y divide-slate-100">
            {schedule.dateOverrides.map((ov) => {
              const wd = WEEKDAY_SHORT_VI[weekdayKeyOf(parseIsoDate(ov.date))];
              return (
                <li key={ov.date} className="flex items-center gap-2 py-2 text-sm flex-wrap">
                  <span className="font-medium w-28">
                    {isoLabel(ov.date)} ({wd})
                  </span>
                  {ov.closed ? (
                    <span className="text-rose-600 font-medium">Đóng cửa</span>
                  ) : (
                    <span className="text-slate-700">
                      {minutesToTime(ov.window!.startMinutes)}–{minutesToTime(ov.window!.endMinutes)}
                    </span>
                  )}
                  {ov.note && <span className="text-slate-400">· {ov.note}</span>}
                  <button
                    onClick={() => {
                      setOvDate(ov.date);
                      setOvMode(ov.closed ? "closed" : "custom");
                      if (ov.window) {
                        setOvStart(minutesToTime(ov.window.startMinutes));
                        setOvEnd(minutesToTime(ov.window.endMinutes));
                      }
                      setOvNote(ov.note ?? "");
                    }}
                    className="ml-auto text-slate-500 hover:text-slate-800"
                  >
                    Sửa
                  </button>
                  <button
                    onClick={() => removeOverride(ov.date)}
                    className="text-rose-600 hover:text-rose-800"
                  >
                    Xoá
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-slate-400">Chưa có ngày đặc biệt nào.</p>
        )}
      </section>

    </div>
  );
}
