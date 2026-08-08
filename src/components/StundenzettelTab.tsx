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
  const showThienlongExtras = store.storeId === "thienlong";
  const dates = useMemo(
    () => datesOfMonth(schedule.year, schedule.month),
    [schedule.year, schedule.month],
  );
  const [selectedId, setSelectedId] = useState<string>(schedule.employees[0]?.id ?? "");
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

  const selected =
    schedule.employees.find((e) => e.id === selectedId) ?? schedule.employees[0] ?? null;

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
        `Tagesdienstplan_${safeFileName(schedule.companyName || "Betrieb")}_${selectedDate}.pdf`,
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
        <div
          aria-label="In hoặc xuất lịch làm việc theo ngày"
          className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3"
        >
          <label className="min-w-[190px] flex-1 text-sm text-slate-600">
            <span className="mb-1 block text-xs font-medium text-slate-500">Ngày cần in / xuất</span>
            <select
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            >
              {dates.map((date) => (
                <option key={date} value={date}>
                  {WEEKDAY_SHORT_VI[weekdayKeyOf(parseIsoDate(date))]} · {isoLabel(date)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={pdfBusy}
            onClick={() => void exportSelectedDatePdf()}
            className="w-full rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 active:bg-slate-800 disabled:opacity-40 sm:w-auto"
          >
            Xuất PDF — ngày đã chọn
          </button>
          <button
            type="button"
            disabled={pdfBusy}
            onClick={printSelectedDate}
            className="w-full rounded border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-40 sm:w-auto"
          >
            In — ngày đã chọn
          </button>
          {pdfBusy && pdfDate && (
            <span className="self-center text-sm text-slate-500">Đang tạo PDF…</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <label className="text-sm text-slate-600">Nhân viên:</label>
          <select
            className="rounded border border-slate-300 px-2 py-2 text-sm"
            value={selected?.id ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {schedule.employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>

        {/* 4 thao tác: PDF / In, cho một người hoặc tất cả */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <button
            disabled={pdfBusy || !selected}
            onClick={() =>
              selected &&
              void doPdf(
                [selected],
                `Stundenzettel_${safeFileName(selected.name)}_${monthTag}.pdf`,
              )
            }
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 active:bg-slate-800 disabled:opacity-40"
          >
            Xuất PDF — người đang chọn
          </button>
          <button
            disabled={pdfBusy}
            onClick={() => void doPdf(schedule.employees, `Stundenzettel_tat_ca_${monthTag}.pdf`)}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 active:bg-slate-800 disabled:opacity-40"
          >
            Xuất PDF — tất cả
          </button>
          <button
            disabled={pdfBusy || !selected}
            onClick={() => selected && doPrint([selected])}
            className="rounded border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-40"
          >
            In — người đang chọn
          </button>
          <button
            disabled={pdfBusy}
            onClick={() => doPrint(schedule.employees)}
            className="rounded border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-40"
          >
            In — tất cả
          </button>
          {pdfBusy && !pdfDate && (
            <span className="text-sm text-slate-500">Đang tạo PDF…</span>
          )}
        </div>

        <p className="text-xs text-slate-500 mb-3">
          Tờ in <span className="font-medium">Stundenaufzeichnung</span> theo mẫu tiếng Đức (dùng nộp
          tại Đức). <span className="font-medium">Xuất PDF</span> tải trực tiếp file .pdf về máy.{" "}
          <span className="font-medium">In</span> mở hộp thoại in; nếu in ra giấy thì chọn lề „Chuẩn",
          tỉ lệ 100 %.
        </p>

        {/* Xem trước trên màn hình cho nhân viên đã chọn */}
        {selected && (
          <div className="rounded-lg border border-slate-300 shadow-sm bg-white overflow-x-auto">
            <StundenzettelPage
              schedule={schedule}
              employee={selected}
              showThienlongExtras={showThienlongExtras}
            />
          </div>
        )}
      </div>

      {/* Vùng in ẩn: mỗi nhân viên một trang */}
      <div className="print-area">
        {(printList ?? []).map((emp) => (
          <StundenzettelPage
            key={emp.id}
            schedule={schedule}
            employee={emp}
            showThienlongExtras={showThienlongExtras}
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
            showThienlongExtras={showThienlongExtras}
          />
        ))}
      </div>

      <div ref={dailyPdfStage} aria-hidden="true" className="pdf-stage no-print">
        {pdfDate && <DailySchedulePage schedule={schedule} date={pdfDate} />}
      </div>
    </>
  );
}
