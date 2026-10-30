import type { MemNpc, NpcAffinity, NpcAffinityLevel, NpcPresence } from './types';

function oneLine(value: string | undefined): string {
  return (value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function relationKey(value: string): string {
  return value.toLowerCase().replace(/[；;]/g, ';').replace(/\s+/g, ' ').trim();
}

/**
 * Kết xuất sơ đồ quan hệ dài hạn của NPC không bị ảnh hưởng bởi việc phân mức có mặt.
 *
 * Trong trạng thái dẫn xuất bình thường tên NPC là duy nhất; ở đây vẫn gộp theo tên chuẩn hóa, để tương thích với các bản ghi trùng tên
 * do dữ liệu cũ hoặc nhập liệu bất thường gây ra. Quan hệ hoàn toàn giống nhau chỉ xuất một lần, các quan hệ khác nhau giữ lại toàn bộ, tránh bỏ sót ngầm.
 */
export function fmtNpcTiesContext(npcs: Pick<MemNpc, 'name' | 'ties'>[]): string {
  const grouped = new Map<string, { name: string; ties: string[]; seen: Set<string> }>();
  for (const npc of npcs) {
    const name = oneLine(npc.name);
    const ties = oneLine(npc.ties);
    if (!name || !ties) continue;

    const nameKey = name.toLowerCase();
    let entry = grouped.get(nameKey);
    if (!entry) {
      entry = { name, ties: [], seen: new Set<string>() };
      grouped.set(nameKey, entry);
    }
    // Định dạng quy ước của ties là liệt kê phân cách bằng dấu chấm phẩy. Gộp từng mục giúp xử lý trường hợp tập quan hệ của NPC trùng tên trong dữ liệu cũ bất thường có giao nhau,
    // vừa không lặp nguyên dòng, vừa không vì kiểu đơn giản "giữ lại mục đầu tiên" mà làm mất quan hệ riêng có ở phía sau.
    for (const tie of ties.split(/[；;]/).map(one => one.trim()).filter(Boolean)) {
      const tieKey = relationKey(tie);
      if (entry.seen.has(tieKey)) continue;
      entry.seen.add(tieKey);
      entry.ties.push(tie);
    }
  }

  const rows = [...grouped.values()].map(entry => `  - ${entry.name}:${entry.ties.join(';')}`);
  return rows.length ? `Quan hệ dài hạn của nhân vật (huyết thống/hôn nhân/chủ tớ/kẻ thù truyền kiếp, v.v., không mất hiệu lực vì có mặt hay không):\n${rows.join('\n')}` : '';
}

export interface NpcSummaryView extends NpcAffinity {
  name: string;
  gender?: string;
  age?: string;
  ageTime?: string;
  relation?: string;
  ties?: string;
  title?: string;
  personality?: string;
  important?: boolean;
  outfit?: string;
  condition?: string;
  follow?: boolean;
  location?: string;
  /** Nhãn có mặt trong danh sách tóm tắt: do engine dùng classifyNpcPresence tính sẵn theo trạng thái "trước tầng này"; mặc định không hiển thị nhãn */
  presence?: NpcPresence;
}

/** Danh sách NPC đã xuất hiện cung cấp cho mô hình tóm tắt. Quan hệ dài hạn bắt buộc phải đưa cho mô hình cùng với trạng thái hiện có thì mới làm cập nhật ghi đè tổng thể được. */
export function fmtNpcSummaryList(npcs: NpcSummaryView[]): string {
  if (!npcs.length) return '  (Không có)';
  return npcs
    .map(n => {
      const star = n.important ? '★ ' : '';
      const inBracket: string[] = [];
      if (oneLine(n.gender)) inBracket.push(oneLine(n.gender));
      if (oneLine(n.age)) inBracket.push(`${oneLine(n.age)}${n.ageTime ? `·ghi vào ${oneLine(n.ageTime)}` : ''}`);
      const bracket = inBracket.length ? `(${inBracket.join('·')})` : '';
      // Nhãn có mặt: chỉ dùng cho danh sách tóm tắt (presence do engine tính), cần AI lấy nó để đối chiếu rời trường / quay lại hiện trường chứ không tự suy luận.
      const mark = n.presence === 'present' ? '〔Có mặt〕'
        : n.presence === 'nearby' ? '〔Cùng khu vực〕'
          : n.presence === 'absent' ? '〔Vắng mặt〕' : '';
      const place = n.follow ? ' [Đi cùng]'
        : oneLine(n.location) ? ` [Ở:${oneLine(n.location)}]`
          : n.presence ? ' [Không rõ nơi ở]' : '';
      const tail: string[] = [];
      if (oneLine(n.title)) tail.push(oneLine(n.title));
      if (oneLine(n.relation)) tail.push(`Với nhân vật chính:${oneLine(n.relation)}`);
      if (oneLine(n.ties)) tail.push(`Nhân tế:${oneLine(n.ties)}`);
      if (oneLine(n.personality)) tail.push(`Tính cách:${oneLine(n.personality)}`);
      const affinity = fmtNpcAffinity(n);
      if (affinity) tail.push(`Ước lượng hảo cảm và thái độ với nhân vật chính[${affinity}]`);
      const title = tail.length ? ` —— ${tail.join(';')}` : '';
      const state: string[] = [];
      if (oneLine(n.outfit)) state.push(`Trang phục:${oneLine(n.outfit)}`);
      if (oneLine(n.condition)) state.push(`Trạng thái:${oneLine(n.condition)}`);
      const stateStr = state.length ? ` 〔${state.join(';')}〕` : '';
      return `  - ${star}${oneLine(n.name)}${bracket}${mark}${place}${title}${stateStr}`;
    })
    .join('\n');
}

export const NPC_AFFINITY_LABELS = {
  affinityInner: ['Phản cảm mãnh liệt', 'Không thích', 'Không rõ yêu ghét', 'Có thiện cảm', 'Tình cảm sâu đậm'],
  affinityOuter: ['Thù địch rõ rệt', 'Lạnh nhạt xa cách', 'Không rõ thân sơ', 'Thân thiện gần gũi', 'Gần gũi rõ rệt, thể hiện tích cực'],
} as const;

/** Trang giao diện và chỉnh sửa tầng dùng chung các mức, chỉ hiển thị chữ, không cung cấp cộng trừ điểm hay thanh tiến độ. */
export const NPC_AFFINITY_FIELDS = (['affinityInner', 'affinityOuter'] as const).map(key => ({
  key,
  label: key === 'affinityInner' ? 'Hảo cảm nội tâm' : 'Thái độ bên ngoài',
  options: [
    { value: '', label: 'Chưa rõ' },
    ...NPC_AFFINITY_LABELS[key].map((label, i) => ({ value: String(i - 2), label })),
  ],
}));

/** Từ chối thang điểm 100, số thập phân, chuỗi và giá trị boolean, không được cắt gọn giá trị phi pháp thành một mức thực nào đó. */
export function cleanNpcAffinityLevel(value: unknown): NpcAffinityLevel | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= -2 && value <= 2
    ? value as NpcAffinityLevel : undefined;
}

/** Tùy chọn trống của hộp thả xuống biểu thị chưa rõ, không phải mức trung lập có được từ Number(''). */
export function affinityLevelFromInput(value: string): NpcAffinityLevel | null | undefined {
  return cleanNpcAffinityLevel(value === '' ? null : Number(value));
}

/** Bản vá ghi đè độc lập; add trùng lặp chỉ bù phần chưa rõ, không được dùng lời thuật lại để ghi đè khuynh hướng đã xác lập. */
export function applyNpcAffinity(target: NpcAffinity, patch: NpcAffinity, fillMissing = false): void {
  for (const { key } of NPC_AFFINITY_FIELDS) {
    const value = cleanNpcAffinityLevel(patch[key]);
    if (value !== undefined && (!fillMissing || target[key] == null)) target[key] = value;
  }
  if (typeof patch.affinityNote === 'string' && (!fillMissing || !target.affinityNote)) {
    target.affinityNote = patch.affinityNote.trim();
  }
}

/** Trạng thái đầy đủ hiển thị cả hai phía (thiếu thì là Chưa rõ); delta của tầng chỉ hiển thị trường thực sự được cung cấp lần này. */
export function fmtNpcAffinity(npc: NpcAffinity, partial = false, includeNote = true): string {
  const hasLevels = NPC_AFFINITY_FIELDS.some(({ key }) => cleanNpcAffinityLevel(npc[key]) !== undefined);
  if (!hasLevels && !npc.affinityNote?.trim() && !(partial && npc.affinityNote === '')) return '';
  const parts: string[] = [];
  for (const { key, label } of NPC_AFFINITY_FIELDS) {
    const value = cleanNpcAffinityLevel(npc[key]);
    if (partial && value === undefined) continue;
    parts.push(`${label}:${value == null ? 'Chưa rõ' : NPC_AFFINITY_LABELS[key][value + 2]}`);
  }
  if (includeNote && npc.affinityNote?.trim()) parts.push(`Giải thích:${npc.affinityNote.trim().replace(/\s*[\r\n]+\s*/g, ' ')}`);
  else if (includeNote && partial && npc.affinityNote === '') parts.push('Giải thích hảo cảm:Xóa trống');
  return parts.join(';');
}

/** Chỉ tiêm khi thực sự có bản ghi hảo cảm; ước lượng không được biến thành đọc tâm trí, sự thật cốt truyện hay mệnh lệnh hành vi cưỡng chế. */
export const NPC_AFFINITY_BRIEFING = 'Hảo cảm nội tâm và thái độ bên ngoài là ước lượng định tính 5 mức đối với nhân vật chính, không phải điểm số chính xác hay sự thật đã định. Nội tâm là ước lượng khuynh hướng thực sự, bên ngoài là cách đối xử tương đối ổn định, hai bên độc lập và thường duy trì; một lần thay đổi giọng điệu/cảm xúc không đồng nghĩa với quan hệ nhảy mức. Chưa rõ không đồng nghĩa với trung lập. Lấy cốt truyện rõ ràng và thiết lập nhân vật làm chuẩn, hảo cảm không đồng nghĩa với tình yêu, sự tin tưởng, phục tùng hay đồng ý; ước lượng nội tâm không đại diện cho việc nhân vật chính hay nhân vật khác biết chuyện, không được đọc tâm trí, vạch trần ngụy trang hay thuật lại tên mức, cứ thể hiện tự nhiên theo góc nhìn là được. Ước lượng là tổng kết cốt truyện đã có, không phải giới hạn trần hay lệnh cấm đối với lượt này, quan hệ vẫn có thể tiếp tục phát triển hoặc chuyển ngoặt theo cốt truyện.';
