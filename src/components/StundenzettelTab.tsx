import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { UseScheduleReturn } from "../hooks/useSchedule";
import type { Employee } from "../types";
import { StundenzettelPage } from "./StundenzettelPage";
import { DailySchedulePage } from "./DailySchedulePage";
import { elementsToPdf, safeFileName } from "../lib/pdf";
import { datesOfMonth, parseIsoDate, WEEKDAY_SHORT_VI, weekdayKeyOf } from "../lib/demand";
import { isoLabel } from "../lib/shiftOps";

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function StundenzettelTab({ store }: { store: UseScheduleReturn }) {
  const { schedule } = store;
  const dates = useMemo(
    () => datesOfMonth(schedule.year, schedule.month),
    [schedule.year, schedule.month],
  );
  // who: "all" = ganzer Laden, sonst eine employeeId. what: Monats-Stundenzettel
  // oder der Tagesplan.
  const [who, setWho] = useState<string>("all");
  const [what, setWhat] = useState<"stundenzettel" | "daily">("stundenzettel");
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = localIsoDate(new Date());
    return dates.includes(today) ? today : dates[0];
  });
  const [printList, setPrintList] = useState<Employee[] | null>(null);
  const [printDate, setPrintDate] = useState<string | null>(null);
  const [pdfList, setPdfList] = useState<Employee[] | null>(null);
  const [pdfDate, setPdfDate] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const timesheetPdfStage = useRef<HTMLDivElement>(null);
  const dailyPdfStage = useRef<HTMLDivElement>(null);

  const chosenEmployees =
    who === "all" ? schedule.employees : schedule.employees.filter((e) => e.id === who);
  const previewEmployee =
    who === "all" ? schedule.employees[0] ?? null : chosenEmployees[0] ?? null;
  const whoTag = who === "all" ? "tat_ca" : safeFileName(previewEmployee?.name ?? who);

  const monthTag = `${schedule.year}-${String(schedule.month).padStart(2, "0")}`;

  useEffect(() => {
    if (!dates.includes(selectedDate)) {
      const today = localIsoDate(new Date());
      setSelectedDate(dates.includes(today) ? today : dates[0]);
    }
  }, [dates, selectedDate]);

  // Vùng in phải được render TRƯỚC khi gọi print, và print phải nằm trong cùng
  // thao tác chạm (mobile chặn print ngoài gesture). flushSync render đồng bộ.
  function doPrint(list: Employee[]) {
    if (list.length === 0) return;
    flushSync(() => {
      setPrintDate(null);
      setPrintList(list);
    });
    window.print();
  }

  /**
   * PDF: các trang phải được render thật (không display:none) thì html2canvas
   * mới chụp được – vì vậy dùng "sân khấu" nằm ngoài màn hình.
   */
  async function doPdf(list: Employee[], filename: string) {
    if (list.length === 0 || pdfBusy) return;
    setPdfBusy(true);
    flushSync(() => setPdfList(list));
    try {
      const pages = Array.from(
        timesheetPdfStage.current?.querySelectorAll<HTMLElement>(".stundenzettel-page") ?? [],
      );
      await elementsToPdf(pages, filename);
    } catch (err) {
      alert(`Không tạo được PDF: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPdfList(null);
      setPdfBusy(false);
    }
  }

  function printSelectedDate() {
    flushSync(() => {
      setPrintList(null);
      setPrintDate(selectedDate);
    });
    window.print();
  }

  async function exportSelectedDatePdf() {
    if (pdfBusy) return;
    setPdfBusy(true);
    flushSync(() => setPdfDate(selectedDate));
    try {
      const pages = Array.from(
        dailyPdfStage.current?.querySelectorAll<HTMLElement>(".daily-schedule-page") ?? [],
      );
      await elementsToPdf(
        pages,
        `Stundenaufzeichnung_Tag_${safeFileName(schedule.companyName || "Betrieb")}_${selectedDate}.pdf`,
      );
    } catch (err) {
      alert(`Không tạo được PDF: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPdfDate(null);
      setPdfBusy(false);
    }
  }

  // Vùng in KHÔNG được dọn theo sự kiện "afterprint": trên Android sự kiện đó
  // bắn ra ngay khi gọi window.print(), trước lúc trình duyệt dựng xong trang
  // — nội dung bị xoá mất và tờ in ra trắng. Vùng này vốn đã ẩn trên màn hình
  // nên cứ để nguyên; lần in sau sẽ ghi đè bằng danh sách mới.

  if (schedule.employees.length === 0) {
    return (
      <div className="no-print rounded bg-white border border-slate-200 p-6 text-center text-slate-400">
        Vui lòng thêm nhân viên và tạo lịch làm việc trước.
      </div>
    );
  }

  return (
    <>
      {/* Điều khiển (không in) */}
      <div className="no-print">
        {/* ---- In & Xuất ---- */}
        <div className="rounded-lg border border-slate-200 bg-white p-3 mb-4">
          <div className="text-sm font-medium text-slate-700 mb-2">In &amp; Xuất file</div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">Cho ai</span>
              <select
                className="rounded border border-slate-300 px-2 py-2 text-sm min-w-[10rem]"
                value={who}
                onChange={(e) => setWho(e.target.value)}
              >
                <option value="all">Tất cả (cả quán)</option>
                {schedule.employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">Nội dung</span>
              <select
                className="rounded border border-slate-300 px-2 py-2 text-sm min-w-[14rem]"
                value={what}
                onChange={(e) => setWhat(e.target.value as "stundenzettel" | "daily")}
              >
                <option value="stundenzettel">Bảng chấm công (Stundenzettel) — cả tháng</option>
                <option value="daily">Lịch làm việc — theo ngày</option>
              </select>
            </label>

            {what === "daily" && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-500">Ngày</span>
                <select
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  className="rounded border border-slate-300 bg-white px-2 py-2 text-sm text-slate-800 min-w-[10rem]"
                >
                  {dates.map((date) => (
                    <option key={date} value={date}>
                      {WEEKDAY_SHORT_VI[weekdayKeyOf(parseIsoDate(date))]} · {isoLabel(date)}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pdfBusy}
                onClick={() => {
                  if (what === "daily") printSelectedDate();
                  else doPrint(chosenEmployees);
                }}
                className="rounded border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-40"
              >
                🖨 In
              </button>
              <button
                type="button"
                disabled={pdfBusy}
                onClick={() => {
                  if (what === "daily") void exportSelectedDatePdf();
                  else void doPdf(chosenEmployees, `Stundenzettel_${whoTag}_${monthTag}.pdf`);
                }}
                className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 active:bg-slate-800 disabled:opacity-40"
              >
                ⬇ Xuất PDF
              </button>
              {pdfBusy && <span className="text-sm text-slate-500">Đang tạo PDF…</span>}
            </div>
          </div>

          <p className="mt-2 text-xs text-slate-500">
            <b>Bảng chấm công (Stundenzettel)</b> theo mẫu tiếng Đức để nộp — một tờ mỗi người, cả
            tháng. <b>Lịch làm việc theo ngày</b> in lịch cả quán cho một ngày. Xuất PDF tải thẳng
            file .pdf về máy; In mở hộp thoại in (lề „Chuẩn", tỉ lệ 100 %).
          </p>
        </div>

        {/* Xem trước trên màn hình cho nhân viên đã chọn */}
        {previewEmployee && (
          <>
            <div className="mb-1 text-xs text-slate-500">
              Xem trước bảng chấm công: <b>{previewEmployee.name}</b>
              {who === "all" && " (chọn một người ở ô „Cho ai“ để xem người khác)"}
            </div>
            <div className="rounded-lg border border-slate-300 shadow-sm bg-white overflow-x-auto">
              <StundenzettelPage
                schedule={schedule}
                employee={previewEmployee}
              />
            </div>
          </>
        )}
      </div>

      {/* Vùng in ẩn: mỗi nhân viên một trang */}
      <div className="print-area">
        {(printList ?? []).map((emp) => (
          <StundenzettelPage
            key={emp.id}
            schedule={schedule}
            employee={emp}
          />
        ))}
        {printDate && <DailySchedulePage schedule={schedule} date={printDate} />}
      </div>

      {/* Sân khấu ngoài màn hình – chỉ có nội dung trong lúc tạo PDF */}
      <div ref={timesheetPdfStage} aria-hidden="true" className="pdf-stage no-print">
        {(pdfList ?? []).map((emp) => (
          <StundenzettelPage
            key={emp.id}
            schedule={schedule}
            employee={emp}
          />
        ))}
      </div>

      <div ref={dailyPdfStage} aria-hidden="true" className="pdf-stage no-print">
        {pdfDate && <DailySchedulePage schedule={schedule} date={pdfDate} />}
      </div>
    </>
  );
}
