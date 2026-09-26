import { useState } from "react";
import type { UseScheduleReturn } from "../hooks/useSchedule";
import type { ValidationError, ValidationErrorKind } from "../lib/validation";
import { parseIsoDate, WEEKDAY_SHORT_VI, weekdayKeyOf } from "../lib/demand";
import {
  describeChanges,
  findRoleSwitchOptions,
  type RoleSwitchResult,
} from "../lib/suggestions";

const GROUPS: { kind: ValidationErrorKind; title: string }[] = [
  { kind: "coverage", title: "Thiếu người theo giờ" },
  { kind: "hours", title: "Giờ định mức" },
  { kind: "rule", title: "Luật xếp lịch" },
  { kind: "shift", title: "Ca làm" },
];

function dayLabel(iso: string): string {
  const d = parseIsoDate(iso);
  return `${WEEKDAY_SHORT_VI[weekdayKeyOf(d)]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** „Ngày 2026-09-12: …" → „…" (das Datum steht schon in der Gruppenzeile). */
const withoutDatePrefix = (message: string) => message.replace(/^Ngày \d{4}-\d{2}-\d{2}: /, "");

function ErrorItem({ error }: { error: ValidationError }) {
  return (
    <li className="py-2">
      <div className="font-medium text-slate-900">{withoutDatePrefix(error.message)}</div>
      {error.reason && (
        <div className="mt-0.5 text-slate-600">
          <span className="font-medium text-slate-500">Vì sao: </span>
          {error.reason}
        </div>
      )}
      {error.suggestion && (
        <div className="mt-0.5 text-emerald-800">
          <span className="font-medium">Gợi ý: </span>
          {error.suggestion}
        </div>
      )}
    </li>
  );
}

/** Suche nach Rollenwechseln für den Monat, mit Vorher/Nachher und „Áp dụng". */
function RoleSwitchFinder({ store }: { store: UseScheduleReturn }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [result, setResult] = useState<RoleSwitchResult | null>(null);
  const { schedule } = store;

  const run = async () => {
    setBusy(true);
    setResult(null);
    const { employees, ...ctx } = store.suggestionContext;
    const found = await findRoleSwitchOptions(employees, ctx, (done, total) => setProgress([done, total]));
    setResult(found);
    setBusy(false);
    setProgress(null);
  };

  const baselineText = (r: RoleSwitchResult) =>
    Number.isFinite(r.baselineErrors) ? `${r.baselineErrors} lỗi` : "không tạo được lịch";

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[12rem] text-sm text-emerald-900">
          <b>Tìm cách xếp khác:</b> app thử cho từng người đổi vị trí (Bếp ↔ Bồi) cả tháng{" "}
          {schedule.month}/{schedule.year}, tạo lịch thử và chỉ gợi ý cách nào ít lỗi hơn.
        </div>
        <button
          onClick={run}
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {busy ? `Đang thử${progress ? ` ${progress[0]}/${progress[1]}` : ""}…` : "Tìm cách xếp khác"}
        </button>
      </div>

      {result && (
        <div className="mt-3 space-y-2">
          {result.options.length === 0 ? (
            <p className="text-sm text-slate-700">
              Đã thử đổi vị trí từng người: không cách nào ít lỗi hơn hiện tại ({baselineText(result)}). Tháng
              này thiếu người thật – cần thêm giờ cho nhân viên, thêm người, hoặc đổi ngày nghỉ cố định.
            </p>
          ) : (
            <>
              <p className="text-xs text-slate-600">
                Lịch tạo lại theo cách hiện tại: {baselineText(result)}.
                {result.triedUnflagged &&
                  " Chưa ai được bật “Làm được cả Bếp và Bồi”, nên app thử với mọi người; áp dụng sẽ bật luôn cho người đó."}
              </p>
              <ul className="space-y-2">
                {result.options.map((o) => (
                  <li
                    key={describeChanges(o.changes)}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2"
                  >
                    <div className="flex-1 min-w-[12rem] text-sm">
                      <div className="font-medium text-slate-900">
                        Tháng {schedule.month}/{schedule.year}: {describeChanges(o.changes)}
                      </div>
                      <div className="text-xs text-slate-600">
                        Còn <b className={o.errors === 0 ? "text-emerald-700" : "text-slate-900"}>{o.errors} lỗi</b>
                        {Number.isFinite(result.baselineErrors) && ` (thay vì ${result.baselineErrors})`}
                        {o.needsFlag && " · sẽ bật “Làm được cả Bếp và Bồi”"}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Áp dụng: ${describeChanges(o.changes)} cho tháng ${schedule.month}/${schedule.year} và tạo lại lịch? Các ca đã sửa tay trong tháng sẽ bị thay.`,
                          )
                        )
                          return;
                        store.applyRoleChangesAndGenerate(o.changes);
                        setResult(null);
                      }}
                      className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
                    >
                      Áp dụng
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Lỗi kiểm tra: nach Art gruppiert, mit „Vì sao" und „Gợi ý". */
export function ValidationPanel({ store }: { store: UseScheduleReturn }) {
  const { validation, genError, schedule } = store;
  const hasPlan = schedule.shifts.length > 0;
  const errors = hasPlan ? validation.errors : [];
  if (!genError && errors.length === 0) return null;
  const isThienlong = store.storeId === "thienlong";
  const hasRoleProblems = !!genError || errors.some((e) => e.kind === "coverage");

  return (
    <div className="mb-3 space-y-2">
      {genError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm">
          <div className="font-semibold text-rose-800">Không tạo được lịch</div>
          <div className="mt-0.5 text-rose-700">{genError}</div>
        </div>
      )}

      {errors.length > 0 && (
        <div className="rounded-lg border border-rose-200 bg-white text-sm">
          <div className="border-b border-rose-100 bg-rose-50 px-3 py-2 font-semibold text-rose-800">
            {errors.length} lỗi kiểm tra – lịch vẫn in được, nhưng nên xem lại
          </div>
          {GROUPS.map(({ kind, title }, gi) => {
            const list = errors.filter((e) => (e.kind ?? "rule") === kind);
            if (list.length === 0) return null;
            // Thiếu người: theo ngày
            const byDate = new Map<string, ValidationError[]>();
            for (const e of list) {
              const key = e.date ?? "";
              byDate.set(key, [...(byDate.get(key) ?? []), e]);
            }
            return (
              <details key={kind} open={gi === 0 || list.length <= 3} className="group border-b border-slate-100 last:border-0">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
                  <span className="font-semibold text-slate-900">{title}</span>
                  <span className="rounded-full bg-rose-100 px-2 text-xs font-medium text-rose-700">{list.length}</span>
                  <span className="ml-auto text-xs text-slate-400 group-open:hidden">Mở ▾</span>
                  <span className="ml-auto hidden text-xs text-slate-400 group-open:inline">Thu gọn ▴</span>
                </summary>
                <div className="max-h-[50vh] overflow-y-auto px-3 pb-2">
                  {[...byDate.entries()]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([date, items]) => (
                      <div key={date || "none"} className="border-t border-slate-100 first:border-0">
                        {date && kind === "coverage" && (
                          <div className="pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            {dayLabel(date)}
                          </div>
                        )}
                        <ul className="divide-y divide-slate-100">
                          {items.map((e, i) => (
                            <ErrorItem key={i} error={e} />
                          ))}
                        </ul>
                      </div>
                    ))}
                </div>
              </details>
            );
          })}
        </div>
      )}

      {isThienlong && hasRoleProblems && <RoleSwitchFinder store={store} />}
    </div>
  );
}
