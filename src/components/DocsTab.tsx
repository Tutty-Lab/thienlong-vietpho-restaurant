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
          <li>Tối đa <b>10 giờ công</b> mỗi ngày; ca liên tục có thể kéo dài đến <b>11 giờ có mặt</b> gồm giờ nghỉ.</li>
          <li>Mỗi người làm tối đa <b>một ngày công/ngày</b>, có thể gồm <b>hai khung giờ tách rời</b>.</li>
          <li>Không làm quá <b>6 ngày liên tiếp</b>, nên luôn có ít nhất một ngày nghỉ mỗi tuần.</li>
          <li>Mỗi ngày mở cửa có ít nhất <b>2 nhân viên đến trước giờ mở cửa 30 phút</b>.</li>
          <li>
            Mỗi người phải đạt <b>đúng định mức tháng</b> (Sollstunden) — không thừa, không thiếu.
          </li>
          <li>
            Ca liên tục trên 6 giờ có giờ nghỉ theo quy định. Với ca tách đôi Thứ 2–5, khoảng tiệm
            đóng cửa 15:00–16:30 đã là thời gian nghỉ nên không trừ thêm Pause.
          </li>
          <li>
            <b>Không xếp ai vào quãng đóng cửa.</b> Một ngày công có thể gồm hai đoạn nằm ở hai
            khung trước và sau giờ đóng cửa buổi trưa.
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
          còn lại là ca sáng). <b>Tối luôn đông hơn sáng</b> (đều trên 50%), trong đó Thứ Bảy được ưu tiên hơn Chủ nhật.
        </p>
        <WeekdayTable
          values={LATE_SHIFT_RATIOS}
          format={(v) => Math.round(v * 100) + "%"}
          highlight={(k) => LATE_SHIFT_RATIOS[k] >= 0.7}
        />
        <p className="text-slate-600">
          Ngoài ra: Teilzeit (bán thời gian) thiên về ca tối; Vollzeit (toàn thời gian) cân bằng
          sáng/tối; cuối tuần và ngày lễ dồn mạnh vào buổi tối.
        </p>
      </Section>

      <Section title="3) Độ dài ca co theo khung giờ trong ngày">
        <p>
          Ca sáng nằm trong <b>khung đầu</b>, ca tối nằm trong <b>khung cuối</b>. Ngày có nghỉ trưa
          (Thứ 2–5) có hai khung; một ngày công dài có thể được tách thành hai đoạn. Nếu một ngày mở{" "}
          <b>ngắn hơn</b> (VD nửa buổi), ca sẽ <b>tự co ngắn lại</b> cho vừa khung — kể cả nhân viên toàn
          thời gian vẫn đi làm ca ngắn hôm đó, và <b>định mức tháng vẫn được bù đủ</b> ở các ngày khác.
        </p>
        <p className="text-slate-600">
          Độ dài ca cho phép: <b>3 đến 10 giờ, bước nửa giờ</b> (3; 3,5; 4 … 10). Nhờ nửa giờ mà
          khung chiều 16:30–22:00 được lấp vừa khít 5,5h thay vì phí nửa tiếng.
          <br />
          Toàn thời gian ưu tiên ca <b>từ 6h trở lên</b>, bán thời gian nhận cả dải 3–10h. Khi khung giờ
          quá hẹp cho ca 6h thì toàn thời gian vẫn được xếp ca ngắn hơn để không phải nghỉ cả ngày.
        </p>
      </Section>

      <Section title="4) Ngày lễ (tự phát hiện — theo bang của cửa hàng)">
        <p>
          Ngày lễ được tính <b>theo bang của cửa hàng đang chọn</b>, gồm cả lễ cố định và lễ theo
          Phục Sinh. Hai tiệm ở <b>Heidenheim</b> nên áp ngày lễ <b>Baden-Württemberg</b>. Ngày lễ
          được xử lý <b>như Chủ nhật</b> (nhu cầu + khung giờ riêng). Danh sách lễ trong tháng hiện ở
          tab <b>Cài đặt</b>.
        </p>
        <p className="mt-2">
          Baden-Württemberg có <b>Heilige Drei Könige (6.1)</b>, <b>Fronleichnam</b> và{" "}
          <b>Allerheiligen (1.11)</b>. Không có Reformationstag, cũng không tính Ostersonntag và
          Pfingstsonntag là lễ chính thức — khác hẳn Brandenburg, lệch nhau 6 ngày mỗi năm.
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
