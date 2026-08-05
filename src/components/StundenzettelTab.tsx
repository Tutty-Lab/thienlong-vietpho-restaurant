import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { UseScheduleReturn } from "../hooks/useSchedule";
import type { Employee } from "../types";
import { StundenzettelPage } from "./StundenzettelPage";
import { elementsToPdf, safeFileName } from "../lib/pdf";

export function StundenzettelTab({ store }: { store: UseScheduleReturn }) {
  const { schedule } = store;
  const [selectedId, setSelectedId] = useState<string>(schedule.employees[0]?.id ?? "");
  const [printList, setPrintList] = useState<Employee[] | null>(null);
  const [pdfList, setPdfList] = useState<Employee[] | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const pdfStage = useRef<HTMLDivElement>(null);

  const selected =
    schedule.employees.find((e) => e.id === selectedId) ?? schedule.employees[0] ?? null;

  const monthTag = `${schedule.year}-${String(schedule.month).padStart(2, "0")}`;

  // Vùng in phải được render TRƯỚC khi gọi print, và print phải nằm trong cùng
  // thao tác chạm (mobile chặn print ngoài gesture). flushSync render đồng bộ.
  function doPrint(list: Employee[]) {
    if (list.length === 0) return;
    flushSync(() => setPrintList(list));
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
        pdfStage.current?.querySelectorAll<HTMLElement>(".stundenzettel-page") ?? [],
      );
      await elementsToPdf(pages, filename);
    } catch (err) {
      alert(`Không tạo được PDF: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPdfList(null);
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
          {pdfBusy && (
            <span className="text-sm text-slate-500">Đang tạo PDF…</span>
          )}
        </div>

        <p className="text-xs text-slate-500 mb-3">
          Tờ in <span className="font-medium">Stundenaufzeichnung</span> theo mẫu tiếng Đức (dùng nộp
          tại Đức). <span className="font-medium">Xuất PDF</span> tải thẳng file .pdf về máy — trên
          điện thoại sẽ mở bảng <span className="font-medium">Chia sẻ</span> để lưu vào Tệp hoặc gửi
          đi. <span className="font-medium">In</span> mở hộp thoại in; nếu in ra giấy thì chọn lề
          „Chuẩn", tỉ lệ 100 %.
        </p>

        {/* Xem trước trên màn hình cho nhân viên đã chọn */}
        {selected && (
          <div className="rounded-lg border border-slate-300 shadow-sm bg-white overflow-x-auto">
            <StundenzettelPage schedule={schedule} employee={selected} />
          </div>
        )}
      </div>

      {/* Vùng in ẩn: mỗi nhân viên một trang */}
      <div className="print-area">
        {(printList ?? []).map((emp) => (
          <StundenzettelPage key={emp.id} schedule={schedule} employee={emp} />
        ))}
      </div>

      {/* Sân khấu ngoài màn hình – chỉ có nội dung trong lúc tạo PDF */}
      <div ref={pdfStage} aria-hidden="true" className="pdf-stage no-print">
        {(pdfList ?? []).map((emp) => (
          <StundenzettelPage key={emp.id} schedule={schedule} employee={emp} />
        ))}
      </div>
    </>
  );
}
