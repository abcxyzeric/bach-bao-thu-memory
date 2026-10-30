import type { MemLifeDetail, StoredDelta } from './types';

type LifeDetailsDelta = NonNullable<StoredDelta['lifeDetails']>;
type LifeDetailAdd = NonNullable<LifeDetailsDelta['add']>[number];
type LifeDetailUpdate = NonNullable<LifeDetailsDelta['update']>[number];

export interface MergeLifeDetailsOptions {
  /** ID lá mục tiêu hiện tại, dùng để nhận diện id ổn định sinh ra từ mảng add của lá đó. */
  leafId?: string;
  /** Hồ sơ đời sống phát lại đến trước lá mục tiêu, dùng để khôi phục mục có cùng văn bản ở lá sớm hơn từng bị lá này xóa. */
  existingDetails?: MemLifeDetail[];
}

export function normalizeLifeDetailText(text: string): string {
  return text.trim().toLowerCase().replace(/[，。！？!?、；;：:\s]+$/u, '');
}

/** Hồ sơ cũ vốn chỉ ghi nhận nhân vật chính; khi thiếu chủ ngữ thì kế thừa ngữ nghĩa cũ, không đoán nhân vật từ chính văn. */
export function lifeDetailSubject(detail: { subject?: string }): string {
  return detail.subject?.trim() || 'user';
}

/** Cùng một câu sở thích thuộc về những nhân vật khác nhau thì bắt buộc phải giữ lại riêng cho từng người. */
export function sameLifeDetail(a: { subject?: string; text: string }, b: { subject?: string; text: string }): boolean {
  return lifeDetailSubject(a).toLowerCase() === lifeDetailSubject(b).toLowerCase()
    && normalizeLifeDetailText(a.text) === normalizeLifeDetailText(b.text);
}

/** Giao diện trang / API phụ / tiêm mô hình chính dùng chung: mỗi một mục đều ghi rõ là của ai, không phụ thuộc tiêu đề đoạn để đoán chủ ngữ. */
export function fmtLifeDetail(detail: { subject?: string; text: string }, userName = 'Nhân vật chính'): string {
  const subject = lifeDetailSubject(detail);
  return `${subject === 'user' ? userName : subject}：${detail.text}`;
}

function upsertUpdate(out: LifeDetailsDelta, update: LifeDetailUpdate): void {
  const updates = (out.update ??= []);
  const index = updates.findIndex(existing => existing.id === update.id);
  if (index >= 0) updates[index] = { ...updates[index], ...update };
  else updates.push(update);
}

function sameLeafAddIndex(id: string, leafId?: string): number | null {
  if (!leafId) return null;
  const prefix = `detail:${leafId}#`;
  if (!id.startsWith(prefix)) return null;
  const index = Number(id.slice(prefix.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function effectiveRemovedDetail(
  out: LifeDetailsDelta,
  id: string,
  options: MergeLifeDetailsOptions,
): LifeDetailAdd | undefined {
  const sameLeafIndex = sameLeafAddIndex(id, options.leafId);
  const base = sameLeafIndex === null
    ? options.existingDetails?.find(detail => detail.id === id)
    : out.add?.[sameLeafIndex];
  const update = out.update?.find(entry => entry.id === id);
  return base ? { ...base, ...update } : undefined;
}

function reviveRemovedDetail(
  out: LifeDetailsDelta,
  add: LifeDetailAdd,
  options: MergeLifeDetailsOptions,
): boolean {
  const id = out.remove?.find(removedId => {
    const detail = effectiveRemovedDetail(out, removedId, options);
    return !!detail && sameLifeDetail(detail, add);
  });
  if (!id) return false;

  out.remove = out.remove?.filter(existing => existing !== id);
  if (!out.remove?.length) delete out.remove;
  out.archive = out.archive?.filter(existing => existing !== id);
  if (!out.archive?.length) delete out.archive;

  const sameLeafIndex = sameLeafAddIndex(id, options.leafId);
  if (sameLeafIndex !== null && out.add?.[sameLeafIndex]) {
    // Mục gốc do add của lá này tạo ra: thay thế tại chỗ, id ổn định và số thứ tự add phía sau đều không đổi.
    out.add[sameLeafIndex] = add;
    if (out.update) {
      out.update = out.update.filter(existing => existing.id !== id);
      if (!out.update.length) delete out.update;
    }
  } else {
    // Mục gốc đến từ lá sớm hơn: hoàn tác việc xóa, và dùng bản vá đầy đủ khôi phục thành một bản ghi thủ công active hoàn toàn mới.
    upsertUpdate(out, {
      id,
      text: add.text,
      ...(add.subject ? { subject: add.subject } : {}),
      topics: add.topics ?? [],
      anchors: add.anchors ?? [],
      until: add.until ?? '',
      tier: 'active',
    });
  }
  return true;
}

/**
 * Gộp một đoạn thao tác thủ công hồ sơ nhỏ đời sống vào delta của lá.
 * update nén theo id thành last-write-wins; add không cắt gọt, vì id ổn định của mục phụ thuộc số thứ tự mảng add.
 */
export function mergeLifeDetailsOp(
  target: StoredDelta,
  incoming: StoredDelta['lifeDetails'],
  options: MergeLifeDetailsOptions = {},
): boolean {
  if (!incoming) return false;
  const hasOps = !!(
    incoming.add?.length
    || incoming.update?.length
    || incoming.archive?.length
    || incoming.remove?.length
  );
  if (!hasOps) return false;

  const out: LifeDetailsDelta = (target.lifeDetails ??= {});

  for (const add of incoming.add ?? []) {
    if (!reviveRemovedDetail(out, add, options)) (out.add ??= []).push(add);
  }

  for (const update of incoming.update ?? []) {
    upsertUpdate(out, update);

    // Chuyển đổi tầng thủ công bắt buộc phải ghi đè chỉ thị archive mà AI đưa ra trước đó trong cùng một lá.
    if (update.tier && out.archive) {
      out.archive = out.archive.filter(id => id !== update.id);
      if (!out.archive.length) delete out.archive;
    }
  }

  for (const id of incoming.archive ?? []) {
    out.archive = [...(out.archive ?? []).filter(existing => existing !== id), id];
  }

  for (const id of incoming.remove ?? []) {
    out.remove = [...(out.remove ?? []).filter(existing => existing !== id), id];
  }

  return true;
}
