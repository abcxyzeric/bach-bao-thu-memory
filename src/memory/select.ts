/**
 * Thuật toán lựa chọn "phân rã tối thiểu" cho các nút trong rừng —— hàm thuần, không phụ thuộc (tiện cho kiểm thử đơn vị, dùng chung giữa tiêm và danh sách).
 *
 * Bối cảnh: Tóm tắt là một khu rừng, lá (L0, gắn vào extra của tin nhắn) + nút nén (L1/L2…, childIds tham chiếu tầng dưới).
 * Cho trước một tập hợp các lá "đạt chuẩn" (do leafEligible phán đoán), cần chọn cho mỗi lá đạt chuẩn một **nút cao nhất có thể đại diện tổng thể cho nó**
 * (tiết kiệm token): nếu toàn bộ lá hậu duệ của một nút nén đều đạt chuẩn, thì dùng một nút này đại diện cho cả đoạn; nếu không thì hạ cấp, đệ quy từng nút con.
 *
 * Tính nguyên vẹn (intact): nếu một childId nào đó của nút nén trỏ tới lá đã mất hiệu lực (lật sang swipe khác → không có trong byId),
 * thì nút đó **không nguyên vẹn** —— văn bản nén của nó có nhúng tự sự cũ của trang đã mất hiệu lực, không thể làm đại diện tổng thể (sẽ xung đột với chính văn hiện tại).
 * Lúc này hạ cấp đệ quy, đổi sang dùng **các nút con vẫn nguyên vẹn** của nó tự đại diện riêng: nhánh bị ảnh hưởng tách dọc xuống tận tầng lá, bỏ qua lá mất hiệu lực,
 * còn nút con nguyên vẹn ở nhánh bên (như một L1 khác cùng tầng) giữ nguyên cả nhánh. Nút mất hoạt tính chỉ là "hiện tại không hiển thị / không tiêm", dữ liệu rừng không xóa.
 */

/** Nút khung nhìn thống nhất: lá đến từ quét chat, nút nén đến từ rừng, childIds kết nối xuyên lưu trữ */
export interface ViewNode {
  id: string;
  kind: 'leaf' | 'comp';
  level: number; // leaf=0, comp=cấp độ nén đó (phục vụ danh sách hiển thị "Tổng kết L{level}")
  text: string;
  timeStart?: string;
  timeEnd?: string;
  timeLabel?: string; // Dự phòng cho dữ liệu cũ
  createdAt: number;
  childIds: string[]; // chỉ comp mới có
  msgIndex: number; // chỉ leaf mới có ý nghĩa (khóa sắp xếp); comp nhận -1
  active: boolean; // leaf: tin nhắn chứa nó đã bị ẩn
  /** Nút lịch sử nhập vào không có child từng tầng; thuật toán lựa chọn coi nó là điểm cuối hoàn chỉnh cùng loại với leaf. */
  atomic?: boolean;
  /** Phạm vi tầng lầu tường minh của lịch sử nhập vào nguyên tử. */
  floorStart?: number;
  floorEnd?: number;
}

/**
 * Thực hiện lựa chọn trên khung nhìn rừng đã xây dựng (dùng chung cho tiêm / danh sách). Logic xem chú thích đầu file.
 * byId chỉ nhận lá **hợp lệ** + toàn bộ nút nén; roots = các nút không bị bất kỳ childIds nào tham chiếu.
 */
export function selectViewNodes(
  view: { byId: Map<string, ViewNode>; roots: ViewNode[] },
  leafEligible: (n: ViewNode) => boolean,
): ViewNode[] {
  const { byId, roots } = view;

  const collectLeaves = (n: ViewNode, acc: ViewNode[]): void => {
    if (n.kind === 'leaf' || n.atomic) {
      acc.push(n);
      return;
    }
    for (const cid of n.childIds) {
      const c = byId.get(cid);
      if (c) collectLeaves(c, acc);
    }
  };
  // Nguyên vẹn: mỗi childId đều phân giải được (không treo lơ lửng) và bản thân nút con cũng nguyên vẹn; lá luôn nguyên vẹn. Được ghi nhớ (memoized).
  const intactMemo = new Map<string, boolean>();
  const isIntact = (n: ViewNode): boolean => {
    if (n.kind === 'leaf' || n.atomic) return true;
    const cached = intactMemo.get(n.id);
    if (cached !== undefined) return cached;
    intactMemo.set(n.id, false); // Chống vòng lặp: trước khi đệ quy quay về thì giữ chỗ false trước
    let ok = n.childIds.length > 0;
    for (const cid of n.childIds) {
      const c = byId.get(cid);
      if (!c || !isIntact(c)) { ok = false; break; } // child treo lơ lửng ⇒ không nguyên vẹn
    }
    intactMemo.set(n.id, ok);
    return ok;
  };
  // Có thể làm đại diện tổng thể: nguyên vẹn + toàn bộ lá hậu duệ đều đạt chuẩn.
  const canRepresent = (n: ViewNode): boolean => {
    if (!isIntact(n)) return false;
    const ls: ViewNode[] = [];
    collectLeaves(n, ls);
    return ls.length > 0 && ls.every(leafEligible);
  };

  const chosen: ViewNode[] = [];
  const visited = new Set<string>(); // Chống vòng lặp / chống trùng: rừng bình thường là cây, nhưng dưới đầu vào có vòng bệnh lý thì tránh tràn ngăn xếp
  const visit = (n: ViewNode): void => {
    if (visited.has(n.id)) return;
    visited.add(n.id);
    if (n.kind === 'leaf' || n.atomic) {
      if (leafEligible(n)) chosen.push(n);
      return;
    }
    if (canRepresent(n)) {
      chosen.push(n);
      return;
    }
    for (const cid of n.childIds) {
      const c = byId.get(cid);
      if (c) visit(c);
    }
  };
  for (const r of roots) visit(r);

  // Ghép theo thứ tự thời gian: lá dùng thứ tự tầng; nút nén dùng thứ tự tầng của lá hậu duệ sớm nhất của nó
  const sortKey = (n: ViewNode): number => {
    if (n.kind === 'leaf') return n.msgIndex;
    if (n.atomic) return n.floorStart ?? n.msgIndex;
    const ls: ViewNode[] = [];
    collectLeaves(n, ls);
    return ls.length
      ? Math.min(...ls.map(l => l.atomic ? (l.floorStart ?? l.msgIndex) : l.msgIndex))
      : Number.MAX_SAFE_INTEGER;
  };
  return chosen.sort((a, b) => sortKey(a) - sortKey(b));
}

/* ============ Hồ sơ nhỏ đời sống: Lựa chọn ba tầng phân phối (hàm thuần, dùng chung cho tiêm và kiểm thử) ============ */

/**
 * Chọn ra các chi tiết đời sống sẽ tiêm trong lượt này —— cổng chắn cốt lõi của nguyên tắc "Ghi nhớ ≠ lượt nào cũng phải nhắc":
 *  - pinned: ghim thủ công lên đầu, thường trú (≤5 mục);
 *  - active: tầng thời hiệu, chưa hết hạn và liên quan tới ngữ cảnh gần đây mới tiêm; active dài hạn không có từ khóa thì tiêm dự phòng;
 *  - archive: tầng lắng đọng, chỉ khi anchors/topics trúng ngữ cảnh gần đây mới nổi lên.
 * Khống chế tổng lượng (ghim đầu 5 + kích hoạt bù cho đủ 6), chống việc chất đống quá nhiều cùng lúc khiến mô hình chính nhắc từng mục một.
 * Chỉ cắt gọt ở tầng lựa chọn tiêm, tuyệt đối không xóa sửa lá nguồn chân lý.
 */
export function selectLifeDetailsForInjection(
  details: import('./types').MemLifeDetail[],
  contextText: string,
  nowTime: string,
  compareDays?: (fromDate: string, toDate: string) => number | null,
): import('./types').MemLifeDetail[] {
  const PIN_CAP = 5;
  const TOTAL_CAP = 6;
  const pinned = details.filter(d => d.tier === 'pinned').slice(0, PIN_CAP);
  const picked: MemLifeDetailImport[] = [];
  for (const d of details) {
    if (d.tier === 'pinned') continue;
    if (pinned.length + picked.length >= TOTAL_CAP) break;
    // Hết hạn thời hiệu (ngày tháng hai đầu đều phân tích được và now đã vượt quá until) → không tiêm; dữ liệu giữ lại, có thể lắng đọng / xóa thủ công
    if (d.tier === 'active' && d.until && nowTime && compareDays) {
      const gap = compareDays(d.until, nowTime);
      if (gap !== null && gap > 0) continue;
    }
    const keys = [...d.anchors, ...d.topics].map(s => s.trim()).filter(Boolean);
    const hit = keys.length ? keys.some(k => contextText.includes(k)) : d.tier === 'active';
    if (hit) picked.push(d);
  }
  return [...pinned, ...picked];
}

type MemLifeDetailImport = import('./types').MemLifeDetail;
