import { normalizeLifeDetailText } from './lifeDetails';
import type { KnowledgeOp, MemKnowledge } from './types';

/**
 * Danh sách hiểu biết: những chuyện về nhân vật chính mà mỗi nhân vật biết / tưởng là vậy.
 * Công dụng là chống "toàn tri" do thiết lập nhân vật / sách thế giới thường trú gây ra —— khi tiêm sẽ báo cho mô hình chính biết chuyện riêng tư chưa ghi thì nhân vật đó mặc định không biết.
 */

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** ID mục hiểu biết: id lá tạo ra nó + số thứ tự của thao tác đó trong nhật ký knowledge của lá (nhật ký chỉ nối thêm, số thứ tự ổn định) */
export function knowledgeId(leafId: string, opIndex: number): string {
  return `know:${leafId}#${opIndex}`;
}

/** Mục đồng nghĩa của cùng một nhân vật tính là trùng lặp; nhân vật khác nhau biết cùng một việc thì mỗi người ghi riêng */
export function sameKnowledge(a: { subject: string; text: string }, b: { subject: string; text: string }): boolean {
  return norm(a.subject) === norm(b.subject) && normalizeLifeDetailText(a.text) === normalizeLifeDetailText(b.text);
}

/** Toàn bộ mục của một nhân vật (tên khớp theo chuẩn hóa) */
export function knowledgeOf(list: MemKnowledge[], name: string): MemKnowledge[] {
  const key = norm(name);
  return key ? list.filter(k => norm(k.subject) === key) : [];
}

/** Làm sạch nhật ký lưu trữ: bỏ các thao tác thiếu trường (sửa dữ liệu tay, v.v.), phần còn lại giữ nguyên thứ tự gốc */
export function cleanKnowledgeOps(raw: unknown): KnowledgeOp[] {
  const out: KnowledgeOp[] = [];
  for (const r of arr(raw)) {
    if (!isRecord(r)) continue;
    if (r.op === 'add') {
      const subject = text(r.subject);
      const t = text(r.text);
      if (subject && t) out.push({ op: 'add', subject, text: t });
    } else if (r.op === 'update') {
      const id = text(r.id);
      const subject = text(r.subject);
      const t = text(r.text);
      if (!id || (!subject && !t)) continue;
      const u: Extract<KnowledgeOp, { op: 'update' }> = { op: 'update', id };
      if (subject) u.subject = subject;
      if (t) u.text = t;
      out.push(u);
    } else if (r.op === 'remove') {
      const id = text(r.id);
      if (id) out.push({ op: 'remove', id });
    }
  }
  return out;
}

/** Áp dụng tuần tự các thao tác của một lá lên danh sách (dùng khi phát lại); add cùng nhân vật đồng nghĩa thì khử trùng lặp, mục đã update thì chuyển xuống cuối */
export function applyKnowledgeOps(list: MemKnowledge[], ops: KnowledgeOp[], leaf: { id: string; createdAt: number; time: string }): void {
  ops.forEach((op, i) => {
    if (op.op === 'add') {
      if (list.some(k => sameKnowledge(k, op))) return;
      list.push({ id: knowledgeId(leaf.id, i), subject: op.subject, text: op.text, createdTime: leaf.time || undefined, createdAt: leaf.createdAt });
      return;
    }
    const idx = list.findIndex(k => k.id === op.id);
    if (idx < 0) return;
    const [k] = list.splice(idx, 1);
    if (op.op === 'remove') return;
    if (op.subject) k.subject = op.subject;
    if (op.text) k.text = op.text;
    // Sửa xong lại đụng thành cùng một câu với mục khác → bỏ mục vừa sửa này đi (câu đó đã có mục ghi rồi)
    if (list.some(o => sameKnowledge(o, k))) return;
    // Chuyển xuống cuối: khi tiêm chỉ gửi vài mục gần nhất, nhận thức được đính chính thường quan trọng nhất, không thể bị cắt mất theo thời gian ghi lần đầu
    list.push(k);
  });
}

/**
 * Đầu ra AI (chia nhóm) → nhật ký lưu trữ có thứ tự.
 *  - k1/k2… dịch thành id ổn định theo thứ tự hiển thị trong prompt; đã là know: thì giữ nguyên, tra không thấy thì hủy bỏ;
 *  - who chỉ nhận nhân vật trong danh sách (gồm cả nhân vật mới xuất hiện ở tầng này), quy chuẩn theo cách viết trong danh sách; nhân vật chính hoặc tra không thấy người này thì hủy cả mục;
 *  - Sửa/xóa mục cũ trước, thêm mục mới sau: khi đính chính nhận thức kiểu "xóa cũ thêm mới" sẽ không xóa nhầm mục mới thêm.
 */
export function finalizeKnowledge(raw: unknown, shown: { id: string }[], npcNames: string[]): KnowledgeOp[] {
  if (!isRecord(raw)) return [];
  const canon = new Map<string, string>();
  for (const n of npcNames) if (n.trim()) canon.set(norm(n), n.trim());
  const resolveRef = (ref: unknown): string | null => {
    const t = isRecord(ref) ? text(ref.id) : text(ref);
    if (!t) return null;
    if (t.startsWith('know:')) return t;
    const m = t.match(/^k(\d+)$/i);
    return m ? shown[Number(m[1]) - 1]?.id ?? null : null;
  };
  const out: KnowledgeOp[] = [];
  for (const u of arr(raw.update)) {
    if (!isRecord(u)) continue;
    const id = resolveRef(u.id);
    const t = text(u.text);
    if (id && t) out.push({ op: 'update', id, text: t });
  }
  for (const r of arr(raw.remove)) {
    const id = resolveRef(r);
    if (id) out.push({ op: 'remove', id });
  }
  for (const a of arr(raw.add)) {
    if (!isRecord(a)) continue;
    const subject = canon.get(norm(text(a.who) || text(a.subject) || text(a.name)));
    const t = text(a.text);
    if (subject && t) out.push({ op: 'add', subject, text: t });
  }
  return out;
}

/** API phụ chỉ xem danh sách của các nhân vật được chỉ định (tiết kiệm token); thứ tự trả về chính là đánh số k1/k2…, gom nhóm theo thứ tự names */
export function selectKnowledgeForSummary(list: MemKnowledge[], names: string[]): MemKnowledge[] {
  const out: MemKnowledge[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(...knowledgeOf(list, name));
  }
  return out;
}

/** Kết xuất cho API phụ: gom nhóm theo nhân vật, đánh số liên tục toàn cục (phải khớp với thứ tự của selectKnowledgeForSummary) */
export function fmtKnowledgeForSummary(shown: MemKnowledge[]): string {
  if (!shown.length) return '  (Không có)';
  const lines: string[] = [];
  let current = '';
  shown.forEach((k, i) => {
    if (norm(k.subject) !== current) {
      current = norm(k.subject);
      lines.push(`  ${oneLine(k.subject)}:`);
    }
    lines.push(`    k${i + 1}. ${oneLine(k.text)}`);
  });
  return lines.join('\n');
}

/** Khi tiêm mỗi nhân vật gửi tối đa bao nhiêu mục (lấy gần nhất): ở bên nhau lâu danh sách sẽ rất dài, gửi hết quá tốn ngữ cảnh */
export const KNOWLEDGE_INJECT_CAP = 15;

/**
 * Kết xuất khối tiêm. Chỉ gửi các nhân vật được chỉ định (có mặt / nhân vật chính yếu); chưa có bản ghi cũng liệt kê "Chưa có ghi chép", để quy tắc "chưa ghi = không biết" có hiệu lực với họ.
 * Lời dặn chỉ khóa chuyện riêng tư: những thứ nhìn thấy được, công khai, theo quan hệ vốn phải biết, hoặc trong cốt truyện đã nói rõ là biết được thì vẫn biết như thường, tránh uốn nắn quá đà thành mất trí nhớ
 * (khi bật trên bản lưu cũ danh sách đang trống, những việc biết được trước đó nhờ bản ghi cốt truyện đỡ hộ).
 */
export function fmtKnowledgeInjection(list: MemKnowledge[], names: string[], userName: string, cap = KNOWLEDGE_INJECT_CAP): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const name of names) {
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const own = knowledgeOf(list, name);
    if (!own.length) {
      rows.push(`${oneLine(name)}:Chưa có ghi chép`);
      continue;
    }
    const shown = own.slice(-cap);
    const more = own.length - shown.length;
    rows.push(`${oneLine(name)}:${more > 0 ? `(còn ${more} mục cũ hơn được lược bớt)` : ''}\n${shown.map(k => `  - ${oneLine(k.text)}`).join('\n')}`);
  }
  if (!rows.length) return '';
  const u = userName || 'Nhân vật chính';
  return `Sự hiểu biết của nhân vật về ${u} (các nhân vật dưới đây chỉ biết những chuyện riêng tư của ${u} được ghi lại tại đây: thân thế, trải nghiệm quá khứ, bí mật, sở thích cá nhân, cùng với tên của ${u}, những gì không viết thì coi như nhân vật đó không biết, trừ khi trong cốt truyện đã nói rõ nhân vật đó được biết; đừng để nhân vật dựa vào thiết lập nhân vật hay sách thế giới mà nói ra điều mình không nên biết. Ngoại hình cử chỉ nhìn thấy được, thân phận công khai, cũng như những điều vốn phải biết theo quan hệ với ${u}, thì vẫn biết như thường. Các mục là nhận thức của riêng nhân vật, chưa chắc là chân tướng: nhân vật nói năng hành xử theo những gì mình tưởng, đừng nhìn thấu thay cho nhân vật):\n`
    + rows.join('\n');
}
