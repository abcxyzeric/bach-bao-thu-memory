<script setup lang="ts">
/**
 * Trang biến số tùy chỉnh (kiểu MVU: một cây trạng thái JSON + lệnh đường dẫn). Ba khối:
 *  ① Trạng thái hiện tại: JSON do AI tạo/sửa bằng lệnh trong cốt truyện (dẫn xuất, hiển thị chỉ đọc; có thể chỉnh sửa thủ công toàn bộ → ghi lại vào lá mới nhất).
 *  ② Mẫu ban đầu và giải thích: ba tầng (Toàn cục / Nhân vật / Trò chuyện) mỗi tầng một cấu trúc ban đầu + giải thích cho AI, gộp lại làm điểm xuất phát phát lại.
 *  ③ Nhập / Xuất: chia sẻ cấu trúc biến số (mẫu + giải thích, không chứa giá trị).
 * Giá trị luôn độc lập theo từng cuộc trò chuyện (phát lại từ varOps trong lá của từng cuộc trò chuyện); sửa mẫu không cần tóm tắt, sửa "Giá trị hiện tại" cần có tóm tắt (ghi vào lá mới nhất).
 */
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import JsonTreeEditor from '@/components/JsonTreeEditor.vue';
import { currentCharKey } from '@/api/settings';
import { mergeTemplates, setVarsRoot } from '@/memory/apply';
import { refreshInjection } from '@/memory/inject';
import { derivedMeta, memory, replaceVarsTemplate } from '@/memory/store';
import type { JsonValue, VarTier } from '@/memory/types';
import { toast } from '@/st/toast';
import { computed, ref, watch } from 'vue';

const hasLeaf = computed(() => derivedMeta.hasLeaf);
// rev tự tăng mỗi lần tính lại dẫn xuất (bao gồm chuyển trò chuyện / chuyển nhân vật), mượn nó để "có nhân vật hay không" và "trạng thái hiện tại" làm mới theo
const charAvailable = computed(() => { void derivedMeta.rev; return currentCharKey() !== null; });

const TIER_META: Record<VarTier, { label: string; hint: string }> = {
  global: { label: 'Toàn cục', hint: 'Mọi nhân vật mọi cuộc trò chuyện dùng chung mẫu ban đầu' },
  char: { label: 'Nhân vật', hint: 'Mọi cuộc trò chuyện của nhân vật hiện tại dùng chung mẫu ban đầu' },
  chat: { label: 'Trò chuyện', hint: 'Chỉ cuộc trò chuyện hiện tại' },
};
const TIER_ORDER: VarTier[] = ['global', 'char', 'chat'];

/** Phân tích thành đối tượng JSON (gốc phải là đối tượng); thất bại trả về null. */
function parseObj(text: string): Record<string, JsonValue> | null {
  try {
    const o = JSON.parse(text || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/* ============ Trạng thái hiện tại ============ */
const stateJson = computed(() => {
  void derivedMeta.rev;
  try {
    return JSON.stringify(memory.vars, null, 2);
  } catch {
    return '{}';
  }
});
const hasState = computed(() => Object.keys(memory.vars).length > 0);

const editStateOpen = ref(false);
const stateEdit = ref('');
const stateEditErr = ref('');
function openEditState() {
  if (!hasLeaf.value) return;
  stateEdit.value = stateJson.value;
  stateEditErr.value = '';
  editStateOpen.value = true;
}
function saveState() {
  const json = parseObj(stateEdit.value);
  if (!json) { stateEditErr.value = 'JSON không hợp lệ hoặc gốc không phải là đối tượng {…}'; return; }
  if (!setVarsRoot(json)) { stateEditErr.value = 'Lưu thất bại: cần có tóm tắt trước mới có thể ghi vào'; return; }
  refreshInjection();
  editStateOpen.value = false;
}

/* ============ Mẫu ban đầu và giải thích (ba tầng) ============ */
const defaultEditorTier = (): VarTier => (charAvailable.value ? 'char' : 'chat');
const editorTier = ref<VarTier>(defaultEditorTier());
const editorMode = ref<'tree' | 'source'>('tree'); // Trình chỉnh sửa cấu trúc (mặc định) / Mã nguồn
const editorTree = ref<Record<string, JsonValue>>({}); // Bản sao làm việc của chế độ hình cây
const editorJson = ref(''); // Văn bản chế độ mã nguồn
const editorMeaning = ref(''); // Ý nghĩa: các trường là gì (cả API chính/phụ đều nhận)
const editorRule = ref('');    // Quy tắc biến đổi: khi nào sửa thế nào / có được tạo mới không (chỉ API phụ)
const jsonError = ref('');

function loadTier(t: VarTier) {
  const tpl = memory.varTemplates[t];
  editorTree.value = JSON.parse(JSON.stringify(tpl.json ?? {}));
  editorJson.value = Object.keys(tpl.json).length ? JSON.stringify(tpl.json, null, 2) : '{\n\n}';
  editorMeaning.value = tpl.meaning;
  editorRule.value = tpl.rule;
  jsonError.value = '';
}
function switchTier(t: VarTier) {
  if (t === 'char' && !charAvailable.value) return;
  editorTier.value = t;
  loadTier(t);
}
loadTier(editorTier.value); // Ban đầu ưu tiên tải tầng Nhân vật; khi trò chuyện nhóm / chưa vào thì lùi về tầng Trò chuyện

// Thay đổi chỉnh sửa hình cây → đồng bộ một bản sang văn bản mã nguồn (khi chuyển sang mã nguồn không bị tụt hậu)
watch(editorTree, v => { editorJson.value = JSON.stringify(v, null, 2); }, { deep: true });

// Chuyển chế độ: khi vào hình cây thì dùng văn bản mã nguồn phân tích lại (đón nhận chỉnh sửa của người dùng trong mã nguồn); khi vào mã nguồn thì dùng cây kết xuất lại
function switchMode(m: 'tree' | 'source') {
  if (m === editorMode.value) return;
  if (m === 'tree') {
    const obj = parseObj(editorJson.value);
    if (!obj) { jsonError.value = 'JSON mã nguồn không hợp lệ, phải sửa đúng mới chuyển sang chế độ xem cấu trúc được'; return; }
    editorTree.value = obj;
    jsonError.value = '';
  } else {
    editorJson.value = JSON.stringify(editorTree.value, null, 2);
  }
  editorMode.value = m;
}

/** Lấy json đang chỉnh sửa hiện tại (theo nguồn của chế độ); không hợp lệ trả về null. */
function currentEditorJson(): Record<string, JsonValue> | null {
  return editorMode.value === 'tree' ? editorTree.value : parseObj(editorJson.value);
}

function saveTemplate() {
  const t = editorTier.value;
  if (t === 'char' && !charAvailable.value) return;
  const json = currentEditorJson();
  if (!json) { jsonError.value = 'JSON không hợp lệ hoặc gốc không phải là đối tượng {…}'; return; }
  jsonError.value = '';
  replaceVarsTemplate(t, { json, meaning: editorMeaning.value, rule: editorRule.value });
  refreshInjection();
  toast(`Đã lưu mẫu ${TIER_META[t].label}`, 'success');
}

/* ============ Nhập / Xuất (mẫu + giải thích, không chứa giá trị) ============ */
const exportOpen = ref(false);
const importOpen = ref(false);
const importText = ref('');
const importTier = ref<VarTier>('chat');

const exportText = computed(() => {
  const json = mergeTemplates(memory.varTemplates);
  const meaning = TIER_ORDER.map(t => memory.varTemplates[t].meaning.trim()).filter(Boolean).join('\n\n');
  const rule = TIER_ORDER.map(t => memory.varTemplates[t].rule.trim()).filter(Boolean).join('\n\n');
  return JSON.stringify({ app: 'ST-BaiBai-Book', kind: 'vars', version: 3, json, meaning, rule }, null, 2);
});
const hasAnyTemplate = computed(() => {
  void derivedMeta.rev;
  return TIER_ORDER.some(t => Object.keys(memory.varTemplates[t].json).length || memory.varTemplates[t].meaning.trim() || memory.varTemplates[t].rule.trim());
});

function openExport() {
  if (!hasAnyTemplate.value) return;
  exportOpen.value = true;
}
function openImport() {
  importText.value = '';
  importTier.value = 'chat';
  importOpen.value = true;
}
async function copyExport() {
  try {
    await navigator.clipboard.writeText(exportText.value);
    toast('Đã sao chép vào bộ nhớ tạm', 'success');
  } catch {
    toast('Sao chép thất bại, vui lòng chọn và sao chép thủ công trong khung', 'error');
  }
}
function downloadExport() {
  const blob = new Blob([exportText.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'baibai-vars.json';
  a.click();
  URL.revokeObjectURL(url);
}
function onImportFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { importText.value = String(reader.result ?? ''); };
  reader.readAsText(f);
}
function applyImport() {
  let parsed: unknown;
  try { parsed = JSON.parse(importText.value); } catch { toast('Phân tích JSON thất bại, vui lòng kiểm tra lại', 'error'); return; }
  // Chấp nhận gói {json,meaning,rule} (tương thích guide cũ → gộp vào rule), hoặc đối tượng trần (coi là json)
  let json: Record<string, JsonValue> = {};
  let meaning = '';
  let rule = '';
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (o.json && typeof o.json === 'object' && !Array.isArray(o.json)) {
      json = o.json as Record<string, JsonValue>;
      meaning = typeof o.meaning === 'string' ? o.meaning : '';
      rule = typeof o.rule === 'string' ? o.rule : '';
      if (!meaning && !rule && typeof o.guide === 'string') rule = o.guide; // Tương thích giải thích đơn lẻ cũ
    } else if (!o.kind) {
      json = o as Record<string, JsonValue>; // Đối tượng trần
    }
  }
  if (!Object.keys(json).length && !meaning.trim() && !rule.trim()) { toast('Không phân tích được cấu trúc nào có thể nhập', 'error'); return; }
  let tier = importTier.value;
  if (tier === 'char' && !charAvailable.value) tier = 'chat';
  const cur = memory.varTemplates[tier];
  const mergedJson = { ...cur.json, ...json }; // Gộp nông tầng đỉnh (trùng tên ghi đè toàn bộ)
  const mergedMeaning = [cur.meaning.trim(), meaning.trim()].filter(Boolean).join('\n\n');
  const mergedRule = [cur.rule.trim(), rule.trim()].filter(Boolean).join('\n\n');
  replaceVarsTemplate(tier, { json: mergedJson, meaning: mergedMeaning, rule: mergedRule });
  refreshInjection();
  if (editorTier.value === tier) loadTier(tier); // Nếu đang chỉnh sửa tầng đó thì làm mới trình chỉnh sửa
  importOpen.value = false;
  toast(`Đã nhập vào mẫu ${TIER_META[tier].label}`, 'success');
}
</script>

<template>
  <section class="bbs-page">
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">Biến số</h2>
      <div class="bbs-var-tools">
        <button class="bbs-add-mini" type="button" :disabled="!hasAnyTemplate" title="Xuất mẫu (chia sẻ)" @click="openExport">
          <Icon name="upload" />
        </button>
        <button class="bbs-add-mini" type="button" title="Nhập mẫu" @click="openImport">
          <Icon name="download" />
        </button>
      </div>
    </div>

    <hr class="bbs-rule" />

    <!-- Trạng thái hiện tại -->
    <div class="bbs-var-blockhead">
      <span class="bbs-var-sub">Trạng thái hiện tại</span>
      <button class="bbs-mini-btn" type="button" :disabled="!hasLeaf" title="Chỉnh sửa thủ công toàn bộ JSON" @click="openEditState">
        <Icon name="edit" />Chỉnh sửa
      </button>
    </div>
    <pre v-if="hasState" class="bbs-json-view">{{ stateJson }}</pre>
    <p v-else class="bbs-var-emptyline">Chưa có trạng thái biến số. Hãy định nghĩa mẫu ban đầu ở bên dưới, hoặc để AI tự tạo trong cốt truyện (như thế lực mới, mục mới).</p>
    <p v-if="hasState && !hasLeaf" class="bbs-modal-hint">Sửa "Giá trị hiện tại" cần có tóm tắt trước; hiện đang hiển thị là trạng thái ban đầu.</p>

    <!-- Mẫu ban đầu và giải thích -->
    <div class="bbs-var-blockhead bbs-var-tmplhead">
      <span class="bbs-var-sub">Mẫu ban đầu và giải thích</span>
    </div>
    <p class="bbs-modal-hint bbs-var-tmpltip">
      Cấu trúc ban đầu + giải thích cho AI. Ba tầng gộp lại (Trò chuyện &gt; Nhân vật &gt; Toàn cục) làm điểm xuất phát phát lại, AI dùng lệnh thêm/xóa/sửa trong cốt truyện. Sửa giá trị ban đầu sẽ ảnh hưởng tới giá trị hiện tại của toàn bộ cuộc trò chuyện.
    </p>

    <div class="bbs-typegrid bbs-var-tierpick">
      <button
        v-for="t in TIER_ORDER"
        :key="t"
        class="bbs-typebtn"
        :class="{ on: editorTier === t }"
        type="button"
        :disabled="t === 'char' && !charAvailable"
        @click="switchTier(t)"
      >
        {{ TIER_META[t].label }}
      </button>
    </div>
    <span class="bbs-modal-hint">
      {{ editorTier === 'char' && !charAvailable ? 'Hiện không có nhân vật đơn lẻ (trò chuyện nhóm / chưa vào), tạm thời không thể chỉnh sửa tầng Nhân vật' : TIER_META[editorTier].hint }}
    </span>

    <div class="bbs-modal-field">
      <div class="bbs-jte-fieldhead">
        <span class="bbs-modal-label">Cấu trúc ban đầu (có thể để trống cho AI xây dựng từ đầu)</span>
        <div class="bbs-mode-toggle">
          <button class="bbs-mode-btn" :class="{ on: editorMode === 'tree' }" type="button" @click="switchMode('tree')">Cấu trúc</button>
          <button class="bbs-mode-btn" :class="{ on: editorMode === 'source' }" type="button" @click="switchMode('source')">Mã nguồn</button>
        </div>
      </div>
      <div v-if="editorMode === 'tree'" class="bbs-jte-wrap">
        <JsonTreeEditor v-model="editorTree" />
        <p v-if="!Object.keys(editorTree).length" class="bbs-jte-empty">Cấu trúc trống. Nhấn "Thêm trường" để dựng cấu trúc muốn theo dõi, hoặc để trống cho AI tự tạo trong cốt truyện.</p>
      </div>
      <textarea v-else v-model="editorJson" class="bbs-input bbs-json-edit" spellcheck="false" rows="7"></textarea>
      <span v-if="jsonError" class="bbs-json-err">{{ jsonError }}</span>
    </div>
    <label class="bbs-modal-field">
      <span class="bbs-modal-label">Ý nghĩa (các trường là gì; cả AI chính văn và AI tóm tắt đều sẽ nhìn thấy để hiểu giá trị hiện tại)</span>
      <textarea
        v-model="editorMeaning"
        class="bbs-input bbs-modal-textarea"
        rows="5"
        placeholder="VD: Độ hảo cảm xxx chỉ độ hảo cảm của nhân vật đó đối với {{user}}, độ hảo cảm của nhân vật khác nhau thì biểu hiện hành vi cũng sẽ khác nhau."
      ></textarea>
    </label>
    <label class="bbs-modal-field">
      <span class="bbs-modal-label">Quy tắc biến đổi (khi nào sửa thế nào, có được tạo mới không; chỉ gửi cho AI tóm tắt, không đưa vào chính văn để tránh chính văn thuật lại biến số)</span>
      <textarea
        v-model="editorRule"
        class="bbs-input bbs-modal-textarea"
        rows="5"
        placeholder="VD: Mỗi lần nhân vật kích hoạt sự kiện với {{user}}, độ hảo cảm đều sẽ thay đổi, nhưng mỗi lần dao động không được vượt quá 5"
      ></textarea>
    </label>
    <div class="bbs-modal-foot bbs-var-savefoot">
      <button
        class="bbs-btn bbs-btn-primary"
        type="button"
        :disabled="editorTier === 'char' && !charAvailable"
        @click="saveTemplate"
      >
        <Icon name="check" />Lưu mẫu {{ TIER_META[editorTier].label }}
      </button>
    </div>

    <!-- Chỉnh sửa giá trị hiện tại -->
    <ModalMask :open="editStateOpen" @close="editStateOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa giá trị biến số hiện tại">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa giá trị hiện tại</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="editStateOpen = false"><Icon name="close" /></button>
        </header>
        <p class="bbs-modal-hint">Sửa trực tiếp toàn bộ JSON, lưu lại sẽ ghi vào tầng tóm tắt mới nhất (xóa tầng đó có thể hoàn tác).</p>
        <textarea v-model="stateEdit" class="bbs-input bbs-json-edit bbs-io-area" spellcheck="false"></textarea>
        <span v-if="stateEditErr" class="bbs-json-err">{{ stateEditErr }}</span>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="editStateOpen = false">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveState">Lưu</button>
        </footer>
      </div>
    </ModalMask>

    <!-- Xuất -->
    <ModalMask :open="exportOpen" @close="exportOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Xuất mẫu biến số">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Xuất mẫu biến số</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="exportOpen = false"><Icon name="close" /></button>
        </header>
        <p class="bbs-modal-hint">Cấu trúc ban đầu + giải thích sau khi gộp ba tầng (không chứa giá trị cụ thể). Sao chép gửi cho người khác là có thể chia sẻ.</p>
        <textarea class="bbs-input bbs-json-edit bbs-io-area" readonly :value="exportText"></textarea>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="downloadExport"><Icon name="download" />Tải tệp xuống</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="copyExport"><Icon name="check" />Sao chép</button>
        </footer>
      </div>
    </ModalMask>

    <!-- Nhập -->
    <ModalMask :open="importOpen" @close="importOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Nhập mẫu biến số">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Nhập mẫu biến số</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="importOpen = false"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Dán JSON mẫu</span>
          <textarea v-model="importText" class="bbs-input bbs-json-edit bbs-io-area" spellcheck="false" placeholder="Dán JSON mẫu biến số được chia sẻ vào đây, hoặc dùng phần chọn tệp bên dưới"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Hoặc nhập từ tệp</span>
          <input class="bbs-input" type="file" accept="application/json,.json" @change="onImportFile" />
        </label>
        <div class="bbs-modal-field">
          <span class="bbs-modal-label">Nhập vào tầng nào</span>
          <div class="bbs-typegrid">
            <button
              v-for="t in TIER_ORDER"
              :key="t"
              class="bbs-typebtn"
              :class="{ on: importTier === t }"
              type="button"
              :disabled="t === 'char' && !charAvailable"
              @click="importTier = t"
            >
              {{ TIER_META[t].label }}
            </button>
          </div>
          <span class="bbs-modal-hint">Gộp vào mẫu của tầng đó (các trường trùng tên ở tầng đỉnh sẽ bị ghi đè); phần giải thích sẽ được nối thêm.</span>
        </div>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="importOpen = false">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!importText.trim()" @click="applyImport">Nhập</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
/* Không đặt height:100% —— trang này là luồng tài liệu tự nhiên, cuộn nhờ .bbs-body.
   Ghim cứng chiều cao sẽ làm cột flex ép thẻ pre "Trạng thái hiện tại" (tự kèm overflow) xuống gần như không còn chiều cao, không nhìn thấy gì cả. */
.bbs-page {
  display: flex;
  flex-direction: column;
}
.bbs-var-tools {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

/* Dòng tiêu đề tiểu mục */
.bbs-var-blockhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.bbs-var-tmplhead {
  margin-top: 22px;
}
.bbs-var-sub {
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
  letter-spacing: 0.02em;
}
.bbs-mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  font-size: 12px;
  cursor: pointer;
}
.bbs-mini-btn:hover:not(:disabled) {
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
.bbs-mini-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Khung nhìn JSON trạng thái hiện tại */
.bbs-json-view {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  min-height: 160px;
  max-height: 60vh;
  overflow-y: auto;
}
.bbs-var-emptyline {
  margin: 0;
  padding: 14px;
  border: 1px dashed var(--bbs-line-strong);
  border-radius: var(--bbs-radius);
  color: var(--bbs-ink-muted);
  font-size: 12.5px;
  line-height: 1.6;
}
.bbs-var-tmpltip {
  margin-top: -2px;
  margin-bottom: 10px;
}

.bbs-var-tierpick {
  margin-bottom: 6px;
}
.bbs-typegrid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-typebtn {
  flex: 1 1 auto;
  padding: 7px 10px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--bbs-dur) var(--bbs-ease), border-color var(--bbs-dur) var(--bbs-ease), color var(--bbs-dur) var(--bbs-ease);
}
.bbs-typebtn:hover:not(:disabled) {
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
.bbs-typebtn.on {
  background: var(--bbs-accent);
  border-color: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-typebtn:disabled {
  opacity: 0.5;
  cursor: default;
}

.bbs-json-edit {
  resize: vertical;
  min-height: 120px;
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
}
/* Chuyển đổi chế độ Cấu trúc / Mã nguồn */
.bbs-jte-fieldhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.bbs-mode-toggle {
  display: inline-flex;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  overflow: hidden;
}
.bbs-mode-btn {
  padding: 4px 12px;
  border: 0;
  background: var(--bbs-surface);
  color: var(--bbs-ink-muted);
  font-size: 12px;
  cursor: pointer;
}
.bbs-mode-btn.on {
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-jte-wrap {
  padding: 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
}
.bbs-jte-empty {
  margin: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  line-height: 1.6;
}
.bbs-json-err {
  font-size: 11.5px;
  color: var(--bbs-danger);
}
.bbs-modal-textarea {
  resize: vertical;
  min-height: 56px;
  font-family: inherit;
}
.bbs-modal-hint {
  font-size: 11.5px;
  color: var(--bbs-ink-muted);
  line-height: 1.55;
}
.bbs-var-savefoot {
  margin-top: 12px;
}
.bbs-io-area {
  min-height: 200px;
}
</style>
