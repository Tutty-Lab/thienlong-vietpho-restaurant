import {
  DAY_WEIGHTS,
  LATE_SHIFT_RATIOS,
  WEEKDAY_LABELS_VI,
  type WeekdayKey,
} from "../lib/demand";

const WEEKDAY_ORDER: WeekdayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg bg-white border border-slate-200 p-4 sm:p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900 mb-2">{title}</h2>
      <div className="text-sm text-slate-700 space-y-2 leading-relaxed">{children}</div>
    </section>
  );
}

/** Bảng hằng số theo thứ (đọc trực tiếp từ code nên luôn khớp). */
function WeekdayTable({
  values,
  format,
  highlight,
}: {
  values: Record<WeekdayKey, number>;
  format: (v: number) => string;
  highlight: (key: WeekdayKey) => boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="text-sm border-collapse">
        <thead>
          <tr>
            {WEEKDAY_ORDER.map((k) => (
              <th
                key={k}
                className={`border border-slate-200 px-3 py-1 font-medium ${
                  highlight(k) ? "bg-indigo-50 text-indigo-900" : "bg-slate-50 text-slate-600"
                }`}
              >
                {WEEKDAY_LABELS_VI[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {WEEKDAY_ORDER.map((k) => (
              <td
                key={k}
                className={`border border-slate-200 px-3 py-1 text-center font-semibold ${
                  highlight(k) ? "bg-indigo-50 text-indigo-900" : ""
                }`}
              >
                {format(values[k])}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function DocsTab() {
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="rounded-lg bg-slate-900 text-white p-4 sm:p-5">
        <h1 className="text-lg font-semibold">Tài liệu — cách xếp lịch hoạt động</h1>
        <p className="text-sm text-slate-300 mt-1">
          Các hệ số dưới đây được <span className="font-medium">cố định trong ứng dụng</span> (không
          chỉnh trong giao diện). Bảng bên dưới đọc trực tiếp từ mã nguồn nên luôn đúng với lịch thực tế.
        </p>
      </div>

      <Section title="Nguyên tắc bắt buộc (luôn đúng)">
        <ul className="list-disc pl-5 space-y-1">
          <li>Tối đa <b>8 giờ công</b> mỗi ngày cho một người.</li>
          <li>Mỗi người <b>một ca mỗi ngày</b>.</li>
          <li>Không làm quá <b>6 ngày liên tiếp</b>.</li>
          <li>
            Mỗi người phải đạt <b>đúng định mức tháng</b> (Sollstunden) — không thừa, không thiếu.
          </li>
          <li>
            <b>Giờ nghỉ (Pause) không tính</b> vào định mức: dưới 6h công = 0 phút, ca 6h và 7h = 30 phút, từ 8h trở lên = 60 phút.
          </li>
        </ul>
      </Section>

      <Section title="1) Trọng số nhu cầu theo ngày">
        <p>
          Dùng để chia <b>tổng giờ công cả tháng</b> ra từng ngày: ngày trọng số cao được xếp nhiều giờ
          hơn. Đây là hệ số tương đối, ngày thường = 1.0.
        </p>
        <WeekdayTable
          values={DAY_WEIGHTS}
          format={(v) => v.toFixed(2).replace(".", ",")}
          highlight={(k) => DAY_WEIGHTS[k] > 1}
        />
        <p className="text-slate-600">
          Công thức mỗi ngày: <code>giờ ngày = tổng giờ tháng × trọng số ngày ÷ tổng trọng số</code>.
          <br />
          <b>Thứ 6, Thứ 7, Chủ nhật</b> đông hơn hẳn ngày thường (Thứ 2–Thứ 4). Ngày{" "}
          <b>đóng cửa</b> có trọng số 0 (không xếp giờ, giờ dồn sang ngày khác).
        </p>
      </Section>

      <Section title="2) Tỉ lệ ca tối vs ca sáng">
        <p>
          Với số giờ đã chia cho mỗi ngày, phần trăm dưới đây là <b>tỉ lệ giờ dành cho ca tối</b> (phần
          còn lại là ca sáng). <b>Tối luôn đông hơn sáng</b> (đều trên 50%), cuối tuần và Chủ nhật đậm hơn.
        </p>
        <WeekdayTable
          values={LATE_SHIFT_RATIOS}
          format={(v) => Math.round(v * 100) + "%"}
          highlight={(k) => LATE_SHIFT_RATIOS[k] >= 0.7}
        />
        <p className="text-slate-600">
          Ngoài ra: Teilzeit (bán thời gian) thiên về ca tối; Vollzeit (toàn thời gian) cân bằng
          sáng/tối; Chủ nhật &amp; ngày lễ dồn mạnh vào buổi tối.
        </p>
      </Section>

      <Section title="3) Độ dài ca co theo khung giờ trong ngày">
        <p>
          Ca sáng bắt đầu ở đầu khung giờ, ca tối kết thúc ở cuối khung. Nếu một ngày mở{" "}
          <b>ngắn hơn</b> (VD nửa buổi), ca sẽ <b>tự co ngắn lại</b> cho vừa khung — kể cả nhân viên toàn
          thời gian vẫn đi làm ca ngắn hôm đó, và <b>định mức tháng vẫn được bù đủ</b> ở các ngày khác.
        </p>
        <p className="text-slate-600">Độ dài ca cho phép: 4, 5, 6, 7, 8 giờ (không có ca dưới 4h).</p>
      </Section>

      <Section title="4) Ngày lễ (tự phát hiện — bang Brandenburg)">
        <p>
          Ứng dụng tự tính <b>ngày lễ chính thức của Brandenburg</b> (Herzfelde thuộc Brandenburg)
          cho năm đang chọn, gồm cả lễ cố định và lễ theo Phục Sinh. Ngày lễ được xử lý{" "}
          <b>như Chủ nhật</b> (nhu cầu + khung giờ riêng, mặc định 11:00–22:00). Danh sách lễ trong
          tháng hiện ở tab <b>Cài đặt</b>.
        </p>
        <p className="mt-2">
          Riêng Brandenburg có <b>Ostersonntag</b> và <b>Pfingstsonntag</b> là lễ chính thức (ít bang
          nào có), và có <b>Reformationstag (31.10)</b>; ngược lại <b>không</b> có Fronleichnam và
          Allerheiligen.
        </p>
      </Section>

      <Section title="5) Ngày đặc biệt (bạn tự đặt)">
        <p>
          Trong tab <b>Cài đặt → Ngày đặc biệt</b>, bạn có thể ghi đè một ngày cụ thể:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <b>Đóng cửa cả ngày</b>: hôm đó không xếp ai, giờ được dồn sang các ngày khác.
          </li>
          <li>
            <b>Giờ làm riêng</b> (VD nghỉ nửa ngày): mọi người làm ca ngắn lọt khung giờ đó.
          </li>
        </ul>
      </Section>

      <Section title="Lưu ý về tờ Stundenzettel">
        <p>
          Giao diện app bằng tiếng Việt, nhưng tờ in <b>Stundenaufzeichnung</b> giữ nguyên{" "}
          <b>tiếng Đức</b> theo mẫu để nộp tại Đức. Ngày lễ/ngày đóng cửa được ghi chú trên tờ này
          (VD <i>Feiertag</i>, <i>Betriebsruhe</i>).
        </p>
      </Section>
    </div>
  );
}
