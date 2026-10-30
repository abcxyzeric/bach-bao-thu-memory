<script setup lang="ts">
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { fetchModels, testChannel } from '@/api/client';
import { apiSettings, newChannel, resolveVectorModel, sanitizeTagName, type ApiChannel, type Verbosity } from '@/api/settings';
import { getContext } from '@/st/context';
import {
  JAILBREAK_PROMPT,
  RESUMMARY2_MACROS,
  RESUMMARY2_PROMPT,
  RESUMMARY_MACROS,
  RESUMMARY_PROMPT,
  SUMMARY_MACROS,
  SUMMARY_PROMPT,
  type PromptMacro,
} from '@/memory/prompts';
import { TIME_TAG_PROMPT } from '@/memory/timeTag';
import { clearVectorIndex, syncVectorIndex } from '@/memory/vector';
import { resetVectorStoreProbe, vectorBackendKind } from '@/memory/vector/store';
import { checkForUpdate, performUpdate, updateState } from '@/memory/update';
import { recallDebug } from '@/memory/vector/debug';
import { computeCarryoverPlan, createNewChatWithCarryover, type CarryoverPlan } from '@/memory/carryover';
import { computeMigrationPlan, runHoraeMigration, type MigrationPlan } from '@/memory/migrate';
import { ui, THEMES, ORB_SHAPES, type NavPosition } from '@/state/ui';
import { uploadOrbImage } from '@/st/upload';
import { toast } from '@/st/toast';
import { versionedAssetUrl } from '@/version';
import { computed, nextTick, onMounted, ref } from 'vue';

const navOptions: { value: NavPosition; label: string }[] = [
  { value: 'auto', label: 'Tự động' },
  { value: 'top', label: 'Phía trên' },
  { value: 'bottom', label: 'Phía dưới' },
];

/**
 * Các ứng viên cường độ suy luận: hợp tập các giá trị của các hãng, **không phải** danh sách chính thức của riêng hãng nào.
 * auto là tùy chọn tường minh (giá trị là chuỗi rỗng = không gửi tham số này), không phải "để trống".
 * Giá trị không kiểm tra hợp lệ, gửi nguyên mẫu cho điểm cuối (xem ApiChannel.reasoningEffort).
 */
const REASONING_EFFORT_OPTIONS = [
  { value: '', label: 'auto' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

const VERBOSITY_OPTIONS: { value: Verbosity; label: string }[] = [
  { value: 'detailed', label: 'Chi tiết' },
  { value: 'concise', label: 'Tinh gọn' },
];

/** Hộp thả xuống chỉ định tác vụ: chuỗi rỗng = Theo API chính, phần còn lại là id kênh phụ (kênh chưa đặt tên thì gán tên giữ chỗ, tránh tùy chọn trống) */
const channelOptions = computed(() => [
  { value: '', label: 'Theo API chính' },
  ...apiSettings.channels.map(c => ({ value: c.id, label: c.name || 'Kênh chưa đặt tên' })),
]);

/* —— Biểu tượng tùy chỉnh quả cầu nổi: chọn ảnh → nén và tải lên máy chủ ST → lưu chuỗi đường dẫn (đồng bộ đa thiết bị) —— */
const orbFileInput = ref<HTMLInputElement | null>(null);
const orbUploading = ref(false);
function pickOrbImage() {
  orbFileInput.value?.click();
}
async function onOrbFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // Đặt lại, cho phép chọn lại cùng một tệp
  if (!file) return;
  orbUploading.value = true;
  try {
    ui.orbImage = await uploadOrbImage(file);
    toast('Đã cập nhật biểu tượng quả cầu nổi', 'success');
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Tải lên thất bại', 'error');
  } finally {
    orbUploading.value = false;
  }
}
function resetOrbImage() {
  ui.orbImage = '';
}

/* —— Kênh: danh sách hiển thị chỉ đọc, chỉnh sửa / tạo mới đều tiến hành trong hộp thoại, tránh một danh sách dài trải phẳng gây chạm nhầm.
   Hai bộ kênh độc lập: 'api' = API phụ (Tóm tắt / Đại tóm tắt), 'vector' = Trí nhớ vector. Hộp thoại thao tác danh sách tương ứng theo scope. —— */
type ChannelScope = 'api' | 'vector';
// editingId: id của "kênh đã có" đang được chỉnh sửa; khi tạo mới là null. Chỉ dùng để định vị đích ghi lại khi nhấn "Hoàn tất".
const editingId = ref<string | null>(null);
const editingScope = ref<ChannelScope>('api');
// Mảng kênh tương ứng với scope hiện tại (thêm/xóa/tìm kiếm đều đi qua nó). Vector đã chuyển sang điểm cuối phẳng, chỉ còn API phụ dùng kênh.
function channelsOf(_scope: ChannelScope): ApiChannel[] {
  return apiSettings.channels;
}
// Chỉnh sửa dùng "bản sao nháp": v-model sửa toàn bộ trên bản nháp, chỉ khi nhấn "Hoàn tất" mới ghi lại vào apiSettings (tránh việc mỗi lần gõ một chữ lại kích hoạt lưu ổ đĩa).
// Công tắc hộp thoại cũng lấy nó làm chuẩn: bản nháp tồn tại = hộp thoại mở.
const editingChannel = ref<ApiChannel | null>(null);
// Sao chép sâu kênh (dữ liệu thuần, dùng JSON là đủ), cắt đứt tham chiếu với bản gốc apiSettings
function cloneChannel(ch: ApiChannel): ApiChannel {
  return JSON.parse(JSON.stringify(ch)) as ApiChannel;
}
// Khóa bảo mật mặc định ẩn; mỗi lần mở/đóng hộp thoại đều đặt lại, tránh việc khóa vô tình giữ ở dạng văn bản rõ
const showKey = ref(false);

// Tham số loại trừ: bên trong lưu string[], khi chỉnh sửa dùng văn bản một dòng ngăn cách bằng dấu phẩy để chứa, chuyển đổi hai chiều đọc/ghi.
const excludeParamsText = computed<string>({
  get: () => editingChannel.value?.excludeParams.join(', ') ?? '',
  set: v => {
    const ch = editingChannel.value;
    if (!ch) return;
    ch.excludeParams = v
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  },
});

function addChannel(scope: ChannelScope = 'api') {
  showKey.value = false;
  editingScope.value = scope;
  editingId.value = null; // null = tạo mới, khi hoàn tất sẽ push
  editingChannel.value = newChannel(); // Bản nháp, chưa đưa vào apiSettings
}
function openChannel(id: string, scope: ChannelScope = 'api') {
  const src = channelsOf(scope).find(c => c.id === id);
  if (!src) return;
  showKey.value = false;
  editingScope.value = scope;
  editingId.value = id;
  editingChannel.value = cloneChannel(src); // Chỉnh sửa bản sao nháp, không động vào bản gốc
}
/** Hủy (× / nhấn lớp phủ): vứt bỏ bản nháp, không ghi lại vào apiSettings (bất kể tạo mới hay chỉnh sửa, thay đổi đều hủy bỏ). */
function closeChannel() {
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
/** Hoàn tất: ghi bản nháp về lại apiSettings —— tạo mới thì push, chỉnh sửa thì ghi đè theo id. Lúc này mới kích hoạt lưu ổ đĩa. */
function confirmChannel() {
  const draft = editingChannel.value;
  if (draft) {
    draft.timeoutSec =
      Number.isFinite(draft.timeoutSec) && draft.timeoutSec > 0
        ? Math.floor(draft.timeoutSec)
        : 180;
    const list = channelsOf(editingScope.value);
    if (editingId.value) {
      const idx = list.findIndex(c => c.id === editingId.value);
      if (idx >= 0) list[idx] = draft;
      else list.push(draft); // Ngoại lệ như kênh gốc bị xóa trong lúc đang chỉnh sửa → dự phòng thành thêm mới
    } else {
      list.push(draft);
    }
  }
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
// Xác nhận lần hai trước khi xóa kênh: nhấn Xóa sẽ mở hộp thoại xác nhận trước, sau khi xác nhận mới thực sự xóa.
const confirmDeleteOpen = ref(false);
function askRemoveChannel() {
  confirmDeleteOpen.value = true;
}
function confirmRemoveChannel() {
  confirmDeleteOpen.value = false;
  // Xóa nhắm vào "kênh đã có" (editingId); bản nháp tạo mới chưa vào kho, tương đương với vứt bỏ trực tiếp bản nháp
  if (editingId.value) removeChannel(editingId.value);
  editingId.value = null;
  editingChannel.value = null;
}
function removeChannel(id: string) {
  const scope = editingScope.value;
  const list = channelsOf(scope);
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) list.splice(idx, 1);
  // Dọn dẹp chỉ định: API phụ xóa hai loại chỉ định tóm tắt (vector đã chuyển sang điểm cuối phẳng, không còn đi theo hệ thống kênh)
  if (scope === 'api') {
    if (apiSettings.assignments.summary === id) apiSettings.assignments.summary = '';
    if (apiSettings.assignments.resummary === id) apiSettings.assignments.resummary = '';
  }
}

const testing = ref<Record<string, string>>({});
async function doTest(ch: ApiChannel) {
  testing.value[ch.id] = 'Đang kiểm tra…';
  const r = await testChannel(ch);
  testing.value[ch.id] = r.message;
}

// Danh sách mô hình kéo về được của từng kênh + trạng thái kéo
const models = ref<Record<string, string[]>>({});
const loadingModels = ref<Record<string, boolean>>({});
async function pullModels(ch: ApiChannel) {
  loadingModels.value[ch.id] = true;
  testing.value[ch.id] = '';
  try {
    const list = await fetchModels(ch);
    models.value[ch.id] = list;
    if (list.length && !ch.model) ch.model = list[0];
    if (!list.length) testing.value[ch.id] = 'Không trả về mô hình nào';
  } catch (e) {
    testing.value[ch.id] = e instanceof Error ? e.message : String(e);
  } finally {
    loadingModels.value[ch.id] = false;
  }
}

/* —— Hộp thả xuống mô hình có thể tìm kiếm (combobox): ô nhập vừa là giá trị hiện tại vừa là từ lọc, khi focus sẽ bật danh sách đã lọc —— */
const modelMenuOpen = ref(false);
const modelQuery = ref(''); // Từ lọc do người dùng nhập sau khi focus; khi mất focus sẽ xóa trống
// Danh sách mô hình của kênh hiện tại đã kéo về được
const modelList = computed<string[]>(() => {
  const id = editingChannel.value?.id;
  return id ? models.value[id] ?? [] : [];
});
// Lọc: có query thì lọc theo chuỗi con (không phân biệt hoa thường); để trống thì hiển thị toàn bộ. Giới hạn hiệu năng 200 mục, tránh danh sách quá dài gây giật lag.
const filteredModels = computed<string[]>(() => {
  const q = modelQuery.value.trim().toLowerCase();
  const list = modelList.value;
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
});
function openModelMenu() {
  modelQuery.value = '';
  modelMenuOpen.value = true;
}
function pickModel(m: string) {
  if (editingChannel.value) editingChannel.value.model = m;
  modelMenuOpen.value = false;
  modelQuery.value = '';
}
// Trễ đóng khi mất focus, để mousedown/click của option có hiệu lực trước
function closeModelMenuSoon() {
  setTimeout(() => {
    modelMenuOpen.value = false;
    modelQuery.value = '';
  }, 150);
}

/* —— Lời nhắc tùy chỉnh: danh sách (Tóm tắt / Đại tóm tắt / Phá giới hạn / Thẻ thời gian), nhấn vào sẽ chỉnh sửa văn bản lớn trong hộp thoại —— */
type PromptKey = 'summary' | 'resummary' | 'resummary2' | 'jailbreak' | 'timeTag';
interface PromptMeta {
  key: PromptKey;
  label: string;
  hint: string;
  builtin: string;
  macros: PromptMacro[];
}
const PROMPT_METAS: PromptMeta[] = [
  {
    key: 'summary',
    label: 'Lời nhắc tóm tắt',
    hint: 'Tổng hợp đối thoại tầng đơn thành trí nhớ có cấu trúc (nội dung tóm tắt + thời gian / địa điểm / vật phẩm / kế hoạch).',
    builtin: SUMMARY_PROMPT,
    macros: SUMMARY_MACROS,
  },
  {
    key: 'resummary',
    label: 'Lời nhắc đại tóm tắt',
    hint: 'Nén nhiều bản tóm tắt tầng thành một bản đại tóm tắt L1 (đại tóm tắt thường, cố định 300-500 chữ).',
    builtin: RESUMMARY_PROMPT,
    macros: RESUMMARY_MACROS,
  },
  {
    key: 'resummary2',
    label: 'Lời nhắc đại tóm tắt cấp hai',
    hint: 'Nén nhiều bản đại tóm tắt thêm một tầng nữa (L1+ → tầng cao hơn). Khoảng số chữ động: Chi tiết bằng 40%–50% đầu vào, Tinh gọn bằng 30%–40%.',
    builtin: RESUMMARY2_PROMPT,
    macros: RESUMMARY2_MACROS,
  },
  {
    key: 'jailbreak',
    label: 'Lời nhắc phá giới hạn',
    hint: 'Đính kèm làm system ghim đầu trong yêu cầu tóm tắt / đại tóm tắt, giảm tỷ lệ từ chối trả lời của API phụ. Để trống sẽ dùng mặc định tích hợp sẵn.',
    builtin: JAILBREAK_PROMPT,
    macros: [],
  },
  {
    key: 'timeTag',
    label: 'Lời nhắc cố định (Thẻ thời gian)',
    hint: 'Tiêm vào đối thoại chính, yêu cầu AI xuất thẻ thời gian ở trước và sau mỗi chính văn, làm mốc thời gian cốt truyện (tóm tắt và cốt truyện mới căn chỉnh theo đó, không còn rối loạn). Cần bật công tắc "Thẻ thời gian chính văn" ở phần Cài đặt tóm tắt. Để trống dùng mặc định tích hợp sẵn.',
    builtin: TIME_TAG_PROMPT,
    macros: [],
  },
];

// Lời nhắc đang chỉnh sửa; draft là bản nháp, nhấn "Hoàn tất" mới ghi lại vào apiSettings (hủy thì vứt bỏ).
const editingPrompt = ref<PromptMeta | null>(null);
const promptDraft = ref('');
const promptArea = ref<HTMLTextAreaElement | null>(null);

// Tác vụ đó đã được tùy chỉnh hay chưa (khác rỗng tức là coi như đã ghi đè bản tích hợp sẵn)
function isCustom(key: PromptKey): boolean {
  return apiSettings.prompts[key].trim().length > 0;
}

function openPrompt(meta: PromptMeta) {
  editingPrompt.value = meta;
  // Đã tùy chỉnh → tải nội dung người dùng; chưa tùy chỉnh → điền sẵn mẫu tích hợp sẵn, tiện sửa trực tiếp trên đó
  promptDraft.value = apiSettings.prompts[meta.key].trim() || meta.builtin;
}
function closePrompt() {
  editingPrompt.value = null;
  promptDraft.value = '';
}
function savePrompt() {
  const meta = editingPrompt.value;
  if (!meta) return;
  // Bản nháp hoàn toàn giống hệt bản tích hợp sẵn → lưu chuỗi rỗng (lùi về bản tích hợp sẵn), tránh lưu dư thừa mẫu vào cài đặt, cũng tiện hiển thị "Mặc định"
  const v = promptDraft.value.trim();
  apiSettings.prompts[meta.key] = v === meta.builtin.trim() ? '' : promptDraft.value;
  closePrompt();
}
// "Khôi phục mặc định": đặt lại bản nháp về mẫu tích hợp sẵn (sau khi lưu sẽ lùi về bản tích hợp sẵn)
function resetPrompt() {
  if (editingPrompt.value) promptDraft.value = editingPrompt.value.builtin;
}

/* —— Trí nhớ vector: ba vai trò mô hình, embedding làm chuẩn, hai cái sau để trống sẽ tái sử dụng nó —— */
type VectorRole = 'embedding' | 'rerank' | 'queryRewrite';
interface VectorRoleMeta {
  key: VectorRole;
  label: string;
}
const VECTOR_ROLES: VectorRoleMeta[] = [
  { key: 'embedding', label: 'Embedding (Vector hóa, bắt buộc)' },
  { key: 'rerank', label: 'Rerank (Sắp xếp lại)' },
  { key: 'queryRewrite', label: 'Viết lại Query' },
];

/* —— Điểm cuối vector: mỗi vai trò điền trực tiếp Địa chỉ / Khóa bảo mật / Mô hình; mô hình có thể kéo lấy bằng một cú nhấn (combobox). —— */
const vecShowKey = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
// Ba thẻ điểm cuối tự thu gọn riêng, mặc định thu gọn toàn bộ, chỉ lộ tiêu đề, khi cần mới mở rộng.
const vecEpOpen = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
const vecModels = ref<Record<VectorRole, string[]>>({ embedding: [], rerank: [], queryRewrite: [] });
const vecLoadingModels = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
const vecModelMsg = ref<Record<VectorRole, string>>({ embedding: '', rerank: '', queryRewrite: '' });
// combobox: vai trò hiện đang mở rộng (null = đều thu gọn) + từ lọc
const vecModelMenuOpen = ref<VectorRole | null>(null);
const vecModelQuery = ref('');

async function pullVecModels(role: VectorRole) {
  // Phân giải địa chỉ/khóa sau khi lùi về dự phòng: khi rerank/query để trống sẽ tự động dùng của Embedding để kéo (mô hình vẫn ghi về vai trò này)
  const ep = resolveVectorModel(role);
  if (!ep.url.trim()) {
    vecModelMsg.value[role] = role === 'embedding' ? 'Vui lòng điền địa chỉ Embedding trước' : 'Vui lòng điền địa chỉ của vai trò này hoặc của Embedding trước';
    return;
  }
  vecLoadingModels.value[role] = true;
  vecModelMsg.value[role] = '';
  try {
    const list = await fetchModels({ url: ep.url, key: ep.key, timeoutSec: ep.timeoutSec });
    vecModels.value[role] = list;
    if (list.length && !apiSettings.vector[role].model) apiSettings.vector[role].model = list[0];
    if (!list.length) vecModelMsg.value[role] = 'Không trả về mô hình nào';
  } catch (e) {
    vecModelMsg.value[role] = e instanceof Error ? e.message : String(e);
  } finally {
    vecLoadingModels.value[role] = false;
  }
}
function filteredVecModels(role: VectorRole): string[] {
  const q = vecModelQuery.value.trim().toLowerCase();
  const list = vecModels.value[role] ?? [];
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
}
function openVecModelMenu(role: VectorRole) {
  vecModelQuery.value = '';
  vecModelMenuOpen.value = role;
}
function pickVecModel(role: VectorRole, m: string) {
  apiSettings.vector[role].model = m;
  vecModelMenuOpen.value = null;
  vecModelQuery.value = '';
}
function closeVecModelMenuSoon() {
  setTimeout(() => {
    vecModelMenuOpen.value = null;
    vecModelQuery.value = '';
  }, 150);
}

/* —— Loại backend vector: 'backend' Backend Bách Bảo Khố / 'local' Hạ cấp cục bộ; thăm dò một lần, hiển thị hiện đang dùng cái nào. —— */
const vecBackend = ref<'backend' | 'local' | 'unknown'>('unknown');
async function refreshVecBackend(): Promise<void> {
  try {
    vecBackend.value = await vectorBackendKind();
  } catch {
    vecBackend.value = 'unknown';
  }
}
onMounted(refreshVecBackend);

/* —— Kiểm tra cập nhật: phân khu phiên bản + hộp thoại xác nhận —— */
const updateConfirmOpen = ref(false);
// Khi vào trang Cài đặt thì kiểm tra lại ngầm một lần (force: bỏ qua "mỗi phiên chỉ kiểm tra một lần", để người dùng mỗi lần vào trang Cài đặt đều nhận được kết luận mới nhất)
onMounted(() => void checkForUpdate(true));
function openUpdateConfirm() {
  if (updateState.available) updateConfirmOpen.value = true;
}
async function confirmUpdate() {
  updateConfirmOpen.value = false;
  const toastr = (globalThis as Record<string, any>).toastr;
  try {
    await performUpdate();
    // Sau khi performUpdate thành công sẽ tự động làm mới trang; đi tới đây thường là đã kích hoạt đếm ngược làm mới
    toastr?.success?.('Cập nhật thành công, đang làm mới trang…', 'Bách Bảo Thư');
  } catch (e) {
    toastr?.error?.(`Cập nhật thất bại: ${e instanceof Error ? e.message : String(e)}`, 'Bách Bảo Thư');
  }
}

/* —— Bảo trì chỉ mục: dựng lại thủ công chỉ mục vector của cuộc trò chuyện hiện tại —— */
const vecIndexing = ref(false);
const vecIndexMsg = ref('');
async function doRebuildIndex() {
  if (vecIndexing.value) return;
  vecIndexing.value = true;
  vecIndexMsg.value = '';
  resetVectorStoreProbe(); // Đo lại backend, đảm bảo chỉ mục rơi vào store thực sự khả dụng hiện tại
  try {
    const result = await syncVectorIndex();
    const parts = [
      result.embedded > 0 ? `tạo lại ${result.embedded} vector` : '',
      result.payloadUpdated > 0 ? `cập nhật ${result.payloadUpdated} toàn văn/thời gian` : '',
    ].filter(Boolean);
    vecIndexMsg.value = parts.length ? `Đã ${parts.join(', ')}.` : 'Không có chỉ mục nào cần cập nhật (đã là mới nhất).';
  } catch (e) {
    vecIndexMsg.value = `Lập chỉ mục thất bại: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    vecIndexing.value = false;
    void refreshVecBackend();
  }
}

// Xóa sạch chỉ mục vector của cuộc trò chuyện hiện tại: thao tác mang tính phá hủy, nhấn lần một cần xác nhận lần hai trước, nhấn lần nữa mới thực sự xóa sạch.
const vecClearing = ref(false);
const vecClearConfirm = ref(false);
async function doClearIndex() {
  if (vecClearing.value) return;
  if (!vecClearConfirm.value) {
    vecClearConfirm.value = true;
    return;
  }
  vecClearConfirm.value = false;
  vecClearing.value = true;
  vecIndexMsg.value = '';
  try {
    const n = await clearVectorIndex();
    vecIndexMsg.value = `Đã xóa sạch chỉ mục vector của cuộc trò chuyện hiện tại (đã xóa ${n} mục). Có thể nhấn "Dựng lại" để lập chỉ mục lại từ đầu.`;
  } catch (e) {
    vecIndexMsg.value = `Xóa sạch thất bại: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    vecClearing.value = false;
    void refreshVecBackend();
  }
}

/* —— Tạo cuộc trò chuyện mới kèm dữ liệu —— */
const carrying = ref(false);
const carryMsg = ref('');
const carryConfirmOpen = ref(false);
// Kế hoạch mang theo: khi mở rộng bảng sẽ tính toán thời gian thực (thuần đọc chat, không lưu đệm, tránh bị hết hạn sau khi chuyển trò chuyện)
const carryPlan = computed<CarryoverPlan>(() => computeCarryoverPlan());
async function runCarryover() {
  carryConfirmOpen.value = false;
  carrying.value = true;
  carryMsg.value = '';
  try {
    const ok = await createNewChatWithCarryover();
    carryMsg.value = ok ? 'Đã tạo cuộc trò chuyện mới.' : 'Tạo chưa hoàn tất (xem chi tiết ở thông báo).';
  } catch (e) {
    carryMsg.value = `Tạo thất bại: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    carrying.value = false;
  }
}

/* —— Di chuyển dữ liệu từ Horae —— */
const migrating = ref(false);
const migrateMsg = ref('');
const migrateConfirmOpen = ref(false);
// Kế hoạch di chuyển: khi mở rộng bảng sẽ tính toán thời gian thực (thuần đọc horae_meta của chat hiện tại, không lưu đệm)
const migratePlan = computed<MigrationPlan>(() => computeMigrationPlan());
// Văn bản xác nhận thay đổi theo việc "có ghi đè hay không"
const migrateConfirmText = computed(() =>
  migratePlan.value.willOverwrite
    ? 'Cuộc trò chuyện hiện tại đã có dữ liệu Bách Bảo Thư, việc di chuyển sẽ ghi đè các tóm tắt hiện có và ghi dữ liệu vào từng tầng. Tiếp tục chứ?'
    : 'Sẽ di chuyển dữ liệu Horae cũ trong cuộc trò chuyện hiện tại thành trí nhớ Bách Bảo Thư. Tiếp tục chứ?',
);
async function runMigrate() {
  migrateConfirmOpen.value = false;
  migrating.value = true;
  migrateMsg.value = '';
  try {
    const ok = await runHoraeMigration();
    migrateMsg.value = ok ? 'Di chuyển hoàn tất.' : 'Di chuyển chưa hoàn tất (xem chi tiết ở thông báo).';
  } catch (e) {
    migrateMsg.value = `Di chuyển thất bại: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    migrating.value = false;
  }
}

/* —— Loại trừ nhân vật: trong cuộc trò chuyện của tên nhân vật được tích chọn (bao gồm cả thẻ trùng tên), mọi tính năng của hệ thống trí nhớ đều không có hiệu lực.
   Loại trừ theo "tên", nên các thẻ trùng tên sẽ được loại trừ cùng nhau theo lô. Khi danh sách rất dài dễ bị giật lag, do đó: ① Chỉ lấy / khử trùng lặp tên nhân vật khi hộp thoại mở;
   ② Kèm khung tìm kiếm để lọc; ③ Dùng v-show + khớp chuỗi con, khối lượng kết xuất hội tụ theo tìm kiếm. —— */
const excludeOpen = ref(false);
const excludeSearch = ref('');

// Khi hộp thoại mở sẽ tính ra một lần danh sách tên nhân vật sau khi khử trùng lặp (sắp xếp theo tên), sau khi đóng không giữ lại nữa, tránh giữ danh sách lớn thường trực.
const charNames = computed<string[]>(() => {
  if (!excludeOpen.value) return [];
  const chars = getContext()?.characters ?? [];
  const seen = new Set<string>();
  for (const c of chars) {
    const n = c?.name?.trim();
    if (n) seen.add(n);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'vi'));
});

// Lọc: tìm kiếm trống hiển thị toàn bộ; nếu không thì khớp chuỗi con không phân biệt hoa thường
const filteredCharNames = computed<string[]>(() => {
  const q = excludeSearch.value.trim().toLowerCase();
  if (!q) return charNames.value;
  return charNames.value.filter(n => n.toLowerCase().includes(q));
});

function openExclude() {
  excludeSearch.value = '';
  excludeOpen.value = true;
}
function closeExclude() {
  excludeOpen.value = false;
}
function isExcluded(name: string): boolean {
  return apiSettings.excludedChars.includes(name);
}
function toggleExcluded(name: string) {
  const list = apiSettings.excludedChars;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}

/* —— Loại trừ Sách Thế Giới: khi tóm tắt / đại tóm tắt sẽ không kèm theo các mục của những cuốn Sách Thế Giới nguyên cuốn này. Sao chép lại hộp thoại tìm kiếm + tích chọn của Loại trừ nhân vật;
   tên Sách Thế Giới lấy từ getWorldInfoNames() (toàn bộ các tệp Sách Thế Giới đã tải) của ST. —— */
const excludeWorldOpen = ref(false);
const excludeWorldSearch = ref('');

// getContext() của ST bản cũ (như 1.13.5) không có getWorldInfoNames, lùi về đọc văn bản tùy chọn từ hộp thả xuống
// Sách Thế Giới #world_editor_select trên trang chính (value="" là mục giữ chỗ, bỏ qua).
function readWorldNamesFromDom(): string[] {
  const opts = document.querySelectorAll<HTMLOptionElement>('#world_editor_select option');
  const out: string[] = [];
  for (const o of opts) {
    if (o.value !== '' && o.textContent) out.push(o.textContent);
  }
  return out;
}

// Khi hộp thoại mở sẽ lấy một lần tên Sách Thế Giới (khử trùng lặp, bỏ rỗng, sắp xếp theo tên); sau khi đóng không giữ lại.
const worldNames = computed<string[]>(() => {
  if (!excludeWorldOpen.value) return [];
  const getNames = getContext()?.getWorldInfoNames;
  const names = getNames ? getNames() : readWorldNamesFromDom();
  const seen = new Set<string>();
  for (const n of names) {
    const t = n?.trim();
    if (t) seen.add(t);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'vi'));
});

const filteredWorldNames = computed<string[]>(() => {
  const q = excludeWorldSearch.value.trim().toLowerCase();
  if (!q) return worldNames.value;
  return worldNames.value.filter(n => n.toLowerCase().includes(q));
});

function openExcludeWorld() {
  excludeWorldSearch.value = '';
  excludeWorldOpen.value = true;
}
function closeExcludeWorld() {
  excludeWorldOpen.value = false;
}
function isWorldExcluded(name: string): boolean {
  return apiSettings.excludedWorldNames.includes(name);
}
function toggleWorldExcluded(name: string) {
  const list = apiSettings.excludedWorldNames;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}

/* —— Loại trừ mục Sách Thế Giới: lọc theo tên mục (comment), sao chép lại ô nhập + chips của thẻ làm sạch.
   Quy tắc được coi là biểu thức chính quy (regex), tên thông thường tức là khớp bao gồm; biên dịch thất bại sẽ hạ cấp xuống khớp chuỗi con. —— */
const wiPatternDraft = ref('');
function addWiPattern() {
  const pat = wiPatternDraft.value.trim();
  if (!pat) {
    wiPatternDraft.value = '';
    return;
  }
  if (!apiSettings.excludedWorldInfoPatterns.includes(pat)) apiSettings.excludedWorldInfoPatterns.push(pat);
  wiPatternDraft.value = '';
}
function removeWiPattern(pat: string) {
  const idx = apiSettings.excludedWorldInfoPatterns.indexOf(pat);
  if (idx >= 0) apiSettings.excludedWorldInfoPatterns.splice(idx, 1);
}

/* —— Thẻ làm sạch tùy chỉnh: người dùng điền tên thẻ (như snow), khi làm sạch chính văn sẽ xóa nguyên khối <snow>…</snow> —— */
const stripTagDraft = ref('');
function addStripTag() {
  const tag = sanitizeTagName(stripTagDraft.value);
  if (!tag) {
    stripTagDraft.value = '';
    return;
  }
  if (!apiSettings.customStripTags.includes(tag)) apiSettings.customStripTags.push(tag);
  stripTagDraft.value = '';
}
function removeStripTag(tag: string) {
  const idx = apiSettings.customStripTags.indexOf(tag);
  if (idx >= 0) apiSettings.customStripTags.splice(idx, 1);
}

// Nhấn nhãn macro → chèn vào vị trí con trỏ của khung văn bản (không có focus thì nối thêm vào cuối)
function insertMacro(token: string) {
  const el = promptArea.value;
  if (!el) {
    promptDraft.value += token;
    return;
  }
  const start = el.selectionStart ?? promptDraft.value.length;
  const end = el.selectionEnd ?? start;
  promptDraft.value = promptDraft.value.slice(0, start) + token + promptDraft.value.slice(end);
  // Đợi sau khi v-model điền lại thì di chuyển con trỏ ra sau nội dung vừa chèn
  void nextTick(() => {
    el.focus();
    const pos = start + token.length;
    el.setSelectionRange(pos, pos);
  });
}

/* —— Chi tiết lần truy xuất trước (bảng gỡ lỗi): hiển thị thuần chỉ đọc recallDebug, reactive tự động làm mới —— */
function fmtRecallTime(at: number): string {
  if (!at) return '';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// Nhãn nguồn Q: khi backend trả về -1 (backend cũ chưa hỗ trợ) thì hiển thị ký tự giữ chỗ
function qLabel(queryIndex: number): string {
  return queryIndex >= 0 ? `Q${queryIndex + 1}` : '—';
}
const TIER_LABEL: Record<'full' | 'brief' | 'drop', string> = { full: 'Toàn văn', brief: 'Tóm tắt', drop: 'Loại bỏ' };
// Sắc thái trạng thái: quyết định phối màu chấm tròn bên trái biểu ngữ (thành công / cảnh báo / thất bại / đang thực hiện)
const recallStatusKind = computed<'ok' | 'warn' | 'fail' | 'pending'>(() => {
  const s = recallDebug.status;
  if (s.includes('Thất bại')) return 'fail';
  if (s.includes('Đang thực hiện')) return 'pending';
  if (s.includes('Chưa truy xuất') || s.includes('Chưa chèn')) return 'warn';
  return 'ok';
});
// Điểm số (0~1) → phần trăm chiều rộng thanh tiến độ; điểm âm (như chưa rõ) xử lý theo 0
function scorePct(score: number): number {
  return Math.max(0, Math.min(1, score)) * 100;
}

/* —— Lấy dữ liệu: tra cứu nhanh macro + xuất tài liệu giao diện công khai —— */
const DATA_MACROS = [
  {
    token: '{{bbsInjectedHistory}}',
    title: 'Lịch sử tiêm thông thường',
    desc: 'Đồng nhất với nội dung tiêm thông thường của Bách Bảo Thư, tự động bỏ qua các bản tóm tắt trong cửa sổ trượt vốn vẫn đang gửi toàn văn.',
  },
  {
    token: '{{bbsHistory}}',
    title: 'Toàn bộ lịch sử nén',
    desc: 'Trả về toàn bộ các bản tóm tắt và đại tóm tắt hợp lệ của cuộc trò chuyện hiện tại, bao gồm cả các tầng đã có tóm tắt trong cửa sổ trượt.',
  },
  {
    token: '{{bbsVars}}',
    title: 'Toàn bộ biến số',
    desc: 'Trả về JSON nhỏ gọn của cây biến số tùy chỉnh hiện tại.',
  },
  {
    token: '{{bbsVar::Đường_dẫn}}',
    title: 'Biến số đơn lẻ',
    desc: 'Đọc biến số theo đường dẫn, ví dụ {{bbsVar::Quan_hệ.Alice.Hảo_cảm}}. Cần bộ máy macro phiên bản mới.',
  },
] as const;

async function copyDataMacro(token: string) {
  try {
    await navigator.clipboard.writeText(token);
    toast(`Đã sao chép ${token}`, 'success');
  } catch {
    toast('Sao chép thất bại, vui lòng chọn văn bản macro thủ công', 'error');
  }
}

function exportPublicApiDocument() {
  const anchor = document.createElement('a');
  anchor.href = versionedAssetUrl('../PUBLIC_API.md', import.meta.url);
  anchor.download = 'ST-BaiBai-Book-PUBLIC_API.md';
  anchor.click();
  toast('Đã xuất tài liệu giao diện công khai', 'success');
}
</script>

<template>
  <section class="bbs-page">
    <!-- Đầu bên phải dòng tiêu đề hiển thị số phiên bản; khi có bản cập nhật bên cạnh sẽ xuất hiện nút "Cập nhật". -->
    <div class="bbs-page-head">
      <h2 class="bbs-title bbs-title-sub">Cài đặt</h2>
      <div class="bbs-ver-row">
        <button
          class="bbs-ver"
          type="button"
          :disabled="updateState.checking"
          :title="updateState.checking ? 'Đang kiểm tra cập nhật' : 'Nhấn để kiểm tra cập nhật'"
          @click="checkForUpdate(true)"
        >
          v{{ updateState.current || '—' }}
        </button>
        <button
          v-if="updateState.available"
          class="bbs-btn bbs-btn-primary bbs-btn-sm"
          type="button"
          :disabled="updateState.updating"
          :title="`Cập nhật lên v${updateState.latest}`"
          @click="openUpdateConfirm"
        >
          {{ updateState.updating ? 'Đang cập nhật…' : 'Cập nhật' }}
        </button>
      </div>
    </div>
    <hr class="bbs-rule" />

    <!-- Công tắc tổng: điều khiển chính của toàn bộ plugin, tắt đi sẽ dừng tiêm / tóm tắt / đại tóm tắt / ẩn (dữ liệu đã có vẫn được giữ lại).
         Được đưa riêng lên phía trên các vùng thu gọn, làm quyết định nổi bật nhất của trang này. -->
    <div class="bbs-master" :class="{ 'is-off': !apiSettings.enabled }">
      <span class="bbs-master-spine" aria-hidden="true"></span>
      <div class="bbs-master-text">
        <span class="bbs-master-title">Bách Bảo Thư · Bộ máy trí nhớ</span>
      </div>
      <button
        type="button"
        role="switch"
        class="bbs-toggle"
        :class="{ 'is-on': apiSettings.enabled }"
        :aria-checked="apiSettings.enabled"
        :title="apiSettings.enabled ? 'Nhấn để tắt' : 'Nhấn để bật'"
        @click="apiSettings.enabled = !apiSettings.enabled"
      >
        <span class="bbs-toggle-knob"></span>
      </button>
    </div>

    <div class="bbs-sections">
      <!-- Cài đặt cơ bản -->
      <Collapsible title="Cài đặt cơ bản" :open="false">
        <div class="bbs-field">
          <div class="bbs-field-head">
            <span class="bbs-field-label">Giao diện</span>
          </div>
          <div class="bbs-segmented bbs-segmented-wrap">
            <button
              v-for="t in THEMES"
              :key="t.value"
              type="button"
              class="bbs-seg"
              :class="{ 'is-on': ui.theme === t.value }"
              @click="ui.theme = t.value"
            >
              <Icon :name="t.icon" />
              {{ t.label }}
            </button>
          </div>
        </div>

        <div class="bbs-field">
          <div class="bbs-field-head">
            <span class="bbs-field-label">Vị trí thanh điều hướng</span>
          </div>
          <div class="bbs-segmented">
            <button
              v-for="n in navOptions"
              :key="n.value"
              type="button"
              class="bbs-seg"
              :class="{ 'is-on': ui.navPosition === n.value }"
              @click="ui.navPosition = n.value"
            >
              {{ n.label }}
            </button>
          </div>
        </div>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Nhấn điều hướng trang hiện tại để đóng cửa sổ trên di động</span>
          <input v-model="ui.navTapClose" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Trên di động nhấn thêm một lần vào nút điều hướng của trang đang mở sẽ đóng toàn bộ cửa sổ, đỡ phải với tay lên nút × ở góc trên bên phải. Nếu sợ chạm nhầm có thể tắt đi.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Hiển thị nút trên thanh đỉnh ST</span>
          <input v-model="ui.showTopBar" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Thêm một nút mở nhanh Bách Bảo Thư trên thanh điều hướng đỉnh của quán rượu (bên trái Quản lý thiết lập người dùng), khỏi phải nhấn vào cây đũa phép ở góc dưới bên trái mỗi lần. Lối vào ở cây đũa phép góc dưới bên trái vẫn được giữ nguyên.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Hiển thị nút phía trên khung trò chuyện</span>
          <input v-model="ui.showQuickReply" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Thêm một nút "Bách Bảo Thư" ở phía trên khung nhập liệu (cùng vị trí với Trả lời nhanh), đi theo làm đẹp giao diện của quán rượu.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Bật giao diện tầng</span>
          <input v-model="ui.showFloorPanel" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Thêm một giao diện ở bên dưới mỗi tầng AI: xem tóm tắt và biến động dữ liệu của tầng đó, đồng thời có thể đánh dấu "Ngoại truyện" chỉ với một cú nhấn. Tầng được đánh dấu là ngoại truyện sẽ bị hệ thống trí nhớ bỏ qua hoàn toàn (không tóm tắt, không đại tóm tắt, không tiêm), phù hợp cho tiểu kịch trường / phần ngoại truyện; bỏ ngoại truyện sẽ khôi phục lại.</p>

        <!-- Quả cầu nổi trên màn hình: nhiều mục cấu hình, thu vào nhóm nhỏ có thể thu gọn -->
        <Collapsible title="Quả cầu nổi trên màn hình" :open="false">
          <label class="bbs-switch-row">
            <span class="bbs-field-label">Hiển thị quả cầu nổi trên màn hình</span>
            <input v-model="ui.showOrb" type="checkbox" class="bbs-checkbox" />
          </label>
          <p class="bbs-field-hint">Gắn một quả cầu nổi có thể kéo thả ở mép màn hình, nhấn vào là mở Bách Bảo Thư. Kéo ra giữa có thể nổi thường trực, kéo lại gần mép trái/phải sẽ hít bám cạnh.</p>

          <!-- Hình dáng: chỉ cấu hình được khi bật -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">Hình dáng</span>
            </div>
            <div class="bbs-segmented">
              <button
                v-for="s in ORB_SHAPES"
                :key="s.value"
                type="button"
                class="bbs-seg"
                :class="{ 'is-on': ui.orbShape === s.value }"
                @click="ui.orbShape = s.value"
              >
                {{ s.label }}
              </button>
            </div>
          </div>

          <!-- Độ mờ khi đứng yên: chỉ cấu hình được khi bật -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">Độ mờ khi đứng yên</span>
              <span class="bbs-field-value">{{ ui.orbOpacity }}%</span>
            </div>
            <input v-model.number="ui.orbOpacity" type="range" min="20" max="100" step="1" class="bbs-range" />
            <p class="bbs-field-hint">Độ mờ khi quả cầu nổi đứng yên; khi di chuột qua / kéo thả sẽ nhất loạt hiển thị rõ toàn phần.</p>
          </div>

          <!-- Kích thước: chỉ cấu hình được khi bật -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">Kích thước</span>
              <span class="bbs-field-value">{{ ui.orbSize }}px</span>
            </div>
            <input v-model.number="ui.orbSize" type="range" min="32" max="80" step="1" class="bbs-range" />
          </div>

          <!-- Biểu tượng: chỉ cấu hình được khi bật -->
          <div v-if="ui.showOrb" class="bbs-orb-config">
            <div class="bbs-orb-preview" :class="[`shape-${ui.orbShape}`, { 'has-image': !!ui.orbImage }]">
              <img v-if="ui.orbImage" :src="ui.orbImage" alt="Xem trước biểu tượng quả cầu nổi" />
              <Icon v-else name="bookmark" />
            </div>
            <div class="bbs-orb-config-actions">
              <button type="button" class="bbs-btn bbs-btn-sm bbs-btn-primary" :disabled="orbUploading" @click="pickOrbImage">
                {{ orbUploading ? 'Đang tải lên…' : ui.orbImage ? 'Đổi biểu tượng' : 'Tải biểu tượng lên' }}
              </button>
              <button v-if="ui.orbImage" type="button" class="bbs-btn bbs-btn-sm" @click="resetOrbImage">Khôi phục mặc định</button>
            </div>
            <input ref="orbFileInput" type="file" accept="image/*" hidden @change="onOrbFileChange" />
          </div>
          <p v-if="ui.showOrb" class="bbs-field-hint">Hỗ trợ ảnh tĩnh và ảnh động GIF (GIF giữ nguyên hoạt ảnh, ≤2MB). Biểu tượng được tải lên máy chủ quán rượu, đồng bộ đa thiết bị; để trống sẽ dùng biểu tượng thẻ đánh dấu sách mặc định.</p>
        </Collapsible>
      </Collapsible>

      <!-- API phụ -->
      <Collapsible title="API phụ" :open="false">
        <!-- Chỉ định tác vụ -->
        <div class="bbs-field bbs-assign">
          <div class="bbs-assign-row">
            <span class="bbs-field-label">Tóm tắt sử dụng</span>
            <BbsSelect v-model="apiSettings.assignments.summary" :options="channelOptions" class="bbs-assign-select" aria-label="Kênh sử dụng cho tóm tắt" />
          </div>
          <div class="bbs-assign-row">
            <span class="bbs-field-label">Đại tóm tắt sử dụng</span>
            <BbsSelect v-model="apiSettings.assignments.resummary" :options="channelOptions" class="bbs-assign-select" aria-label="Kênh sử dụng cho đại tóm tắt" />
          </div>
        </div>
        <p class="bbs-field-hint">Khuyên dùng DeepSeek hoặc Doubao, không khuyên dùng Gemini vì lớp giáp kiểm duyệt quá dày</p>

        <hr class="bbs-rule" />

        <!-- Kênh: nút thêm ở đỉnh + danh sách chỉ đọc nhỏ gọn (nhấn vào dòng để mở hộp thoại chỉnh sửa), không trải phẳng một danh sách dài nữa -->
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">Kênh</span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addChannel('api')">
            <Icon name="plus" /> Thêm kênh
          </button>
        </div>

        <ul v-if="apiSettings.channels.length" class="bbs-channel-list">
          <li v-for="ch in apiSettings.channels" :key="ch.id" class="bbs-channel-item">
            <button class="bbs-channel-open" type="button" @click="openChannel(ch.id)">
              <span class="bbs-channel-item-name">{{ ch.name || 'Kênh chưa đặt tên' }}</span>
              <span class="bbs-channel-item-model">{{ ch.model || 'Chưa đặt mô hình' }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">Chưa có kênh nào. Nhấn "Thêm kênh" để cấu hình API dùng cho tóm tắt / đại tóm tắt.</p>
      </Collapsible>

      <!-- Cài đặt tóm tắt -->
      <Collapsible title="Cài đặt tóm tắt" :open="false">
        <label class="bbs-switch-row">
          <span class="bbs-field-label">Bật tóm tắt tự động</span>
          <input v-model="apiSettings.autoSummaryEnabled" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Sau khi bật sẽ tự động tóm tắt và ẩn các tầng cũ, đồng thời bật thẻ thời gian chính văn (mốc thời gian cốt truyện) và chặn tồn đọng (khi bị sót tóm tắt sẽ chặn gửi đi và nhắc tóm tắt bù).</p>
        <div class="bbs-num-row">
          <span class="bbs-field-label">Mức số chữ</span>
          <BbsSelect v-model="apiSettings.verbosity" :options="VERBOSITY_OPTIONS" class="bbs-select-narrow" aria-label="Mức số chữ" />
        </div>
        <p class="bbs-field-hint">Điều chỉnh nhanh số chữ mục tiêu của Tóm tắt / Đại tóm tắt / Đại tóm tắt cấp hai. Chi tiết = đầy đủ thông tin (Tóm tắt 150-300, Đại tóm tắt 300-500 chữ); Tinh gọn = tiết kiệm token (Tóm tắt 80-150, Đại tóm tắt 150-300 chữ). Chỉ ảnh hưởng tới lời nhắc tích hợp sẵn, mẫu tùy chỉnh không bị ảnh hưởng.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Số tin nhắn AI giữ lại gần nhất</span>
          <input v-model.number="apiSettings.keepRecent" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Giữ lại bao nhiêu tin nhắn AI để gửi toàn văn, phần vượt quá sẽ tự động ẩn đi và gửi bản tóm tắt.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Số tin nhắn AI mỗi lần đại tóm tắt</span>
          <input v-model.number="apiSettings.leafBatchThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Mỗi lần đại tóm tắt bao nhiêu bản tóm tắt, không tính tầng user, 0 là tắt đại tóm tắt tự động.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Số bản tóm tắt giữ lại khi đại tóm tắt</span>
          <input v-model.number="apiSettings.leafKeepRecent" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Khi đại tóm tắt sẽ giữ lại ngần này bản tóm tắt ở cuối không nén, để vùng ẩn luôn lưu lại một đoạn chi tiết, tránh đứt gãy thông tin sau khi đại tóm tắt. VD: mỗi lần đại tóm tắt 12, ở đây điền 3, thì phải tích đủ 15 bản mới đại tóm tắt, nén 12 bản cũ nhất, giữ lại 3 bản tóm tắt mới nhất. 0 là tích đủ thì nén hết (hành vi cũ), mặc định là 3.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Đại tóm tắt cấp hai</span>
          <input v-model.number="apiSettings.resummaryThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Đại tóm tắt L1 đạt bao nhiêu bản thì nén thành một bản L2, 0 là tắt. Mặc định là 7.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Đại tóm tắt cấp cao</span>
          <input v-model.number="apiSettings.higherResummaryThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Đại tóm tắt L2 trở lên đạt bao nhiêu bản thì nén thêm một tầng nữa. Nội dung cấp cao dài hơn, khuyên dùng ngưỡng nhỏ hơn; 0 là tắt, mặc định là 3.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Đính kèm kế hoạch đã hoàn thành gần đây</span>
          <input v-model.number="apiSettings.recentResolvedPlansCount" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Đính kèm "Kế hoạch / Nghi vấn đã hoàn thành" trong ảnh chụp nhanh trạng thái, nhắc AI đừng lấy những việc vừa mới kết thúc coi như chưa hoàn thành để thúc đẩy tiếp hoặc ghi nhận trùng lặp; đồng thời đính kèm cho cả phần tiêm vào mô hình chính và API phụ tóm tắt. Kế hoạch và nghi vấn mỗi loại lấy tối đa ngần này mục gần nhất (VD: điền 5 = tối đa 5 kế hoạch + 5 nghi vấn). 0 là không đính kèm, mặc định là 5.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Số lần thử lại khi thất bại</span>
          <input v-model.number="apiSettings.summaryMaxRetries" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Khi yêu cầu tóm tắt / đại tóm tắt thất bại (báo lỗi hoặc nội dung trả về không phân tích được) thì thử lại thêm tối đa mấy lần, 0 là không thử lại. Mặc định là 1.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Tóm tắt bù hàng loạt · Số chữ mỗi đợt</span>
          <input v-model.number="apiSettings.batchMaxChars" class="bbs-input bbs-num" type="number" min="500" step="500" />
        </label>
        <p class="bbs-field-hint">Khi tóm tắt bù hàng loạt, mỗi yêu cầu đóng gói tối đa bao nhiêu chữ chính văn (sau khi làm sạch) thì cắt thành một đợt. Càng lớn càng tiết kiệm token / càng nhanh, nhưng lớn quá sẽ làm phân tán sự chú ý của AI, giảm chất lượng. Mặc định là 30000.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Tóm tắt bù hàng loạt · Giới hạn số tầng mỗi đợt</span>
          <input v-model.number="apiSettings.batchMaxFloors" class="bbs-input bbs-num" type="number" min="1" />
        </label>
        <p class="bbs-field-hint">Khi số chữ chưa chạm trần nhưng số tầng đạt tới mức này cũng sẽ cắt đợt để dự phòng. Mặc định là 10.</p>
      </Collapsible>

      <!-- Cài đặt tiêm -->
      <Collapsible title="Cài đặt tiêm" :open="false">
        <p class="bbs-field-hint">Chọn những khối trạng thái nào được tiêm vào cuộc đối thoại chính (yêu cầu tạo chính văn). Các công tắc này <strong>chỉ ảnh hưởng tới nội dung mà mô hình chính nhìn thấy</strong>: API phụ tóm tắt luôn nhìn thấy trạng thái toàn lượng và ghi nhận như thường, tắt một mục nào đó sẽ không dẫn tới ghi nhận trùng lặp. Thời gian / Địa điểm, Kế hoạch / Nghi vấn và Biến số tùy chỉnh được giữ thường trực, không bật tắt tại đây.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Chỉ tiêm tóm tắt cốt truyện</span>
          <input v-model="apiSettings.summaryOnlyMode" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Tương thích với hệ thống biến số có sẵn của thẻ nhân vật. Sau khi bật vẫn sẽ phân tích, lưu trữ và hiển thị vật phẩm, nhân vật, khung cảnh, kế hoạch và biến số trong Bách Bảo Thư, nhưng không còn tiêm trạng thái hiện tại vào mô hình chính (công tắc các khối bên dưới cũng theo đó không còn hiệu lực), đồng thời không ghi chú thích biến động vật phẩm / biến số vào chính văn các tầng tiếp theo nữa. Chú thích trong các tầng đã có sẽ không tự động bị xóa; tính năng "Đi tới" ở trang Khung cảnh không bị ảnh hưởng.</p>

        <hr class="bbs-rule" />

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Cục diện trước mắt</span>
          <input v-model="apiSettings.injection.sceneFocus" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode" />
        </label>
        <p class="bbs-field-hint">Thẻ cục diện tương tác hiện tại: cục diện, người có mặt, tiêu điểm hiện tại, căng thẳng tương tác và sự việc sắp diễn ra, nối tiếp cảnh tượng trước mắt.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Hồ sơ đời sống</span>
          <input v-model="apiSettings.injection.lifeDetails" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode" />
        </label>
        <p class="bbs-field-hint">Điều khiển việc tiêm hồ sơ đời sống của nhân vật chính và nhân vật chính yếu. Việc ghi nhận luôn được bật (AI tích lũy hồ sơ như thường, có thể quản lý ở trang Nhân vật); sau khi tắt chỉ là không gửi cho mô hình chính nữa, bật lại sẽ khôi phục tiêm.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Thông tin nhân vật chính</span>
          <input v-model="apiSettings.injection.protagonist" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode" />
        </label>
        <p class="bbs-field-hint">Trạng thái hiện tại của nhân vật chính: giới tính, tuổi, thân phận, ngoại hình, trang phục, trạng thái. Tự bao hàm, không phụ thuộc thông tin khung cảnh.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Thông tin khung cảnh</span>
          <input v-model="apiSettings.injection.scenes" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode" />
        </label>
        <p class="bbs-field-hint">Địa điểm hiện tại và chuỗi tổ tiên (chi tiết) + các địa điểm đã biết khác (chỉ tên). <strong>Phán đoán có mặt / có thể tiếp cận của Danh sách NPC và Thông tin vật phẩm đều phụ thuộc vào cây khung cảnh, sau khi tắt mục này thì hai mục đó cũng sẽ không được tiêm theo.</strong></p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Danh sách NPC</span>
          <input v-model="apiSettings.injection.npcs" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.scenes" />
        </label>
        <p class="bbs-field-hint">Nhân vật có mặt gửi toàn lượng, cùng khu vực gửi rút gọn, không có mặt chỉ gửi tên và thân phận; phụ thuộc Thông tin khung cảnh.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Đánh giá hảo cảm nhân vật</span>
          <input v-model="apiSettings.injection.npcAffinity" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.npcs" />
        </label>
        <p class="bbs-field-hint">Đánh giá hảo cảm 5 mức trong Danh sách NPC (hảo cảm nội tâm / thái độ bên ngoài / ghi chú). Việc ghi nhận và hiển thị ở trang Nhân vật luôn được bật; sau khi tắt thì danh sách vẫn gửi như thường, chỉ là không đính kèm hảo cảm —— phù hợp với trường hợp thẻ nhân vật đã có sẵn hệ thống hảo cảm và không muốn chạy song song hai bộ.</p>

        <!-- Không bị vô hiệu hóa theo "Chỉ tiêm tóm tắt": công tắc này đồng thời quản lý cả việc ghi nhận -->
        <label class="bbs-switch-row">
          <span class="bbs-field-label">Hiểu biết của nhân vật về nhân vật chính</span>
          <input v-model="apiSettings.injection.knowledge" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Ghi lại những chuyện về nhân vật chính mà mỗi nhân vật biết (hoặc tưởng là vậy), gửi cho nhân vật chính yếu và nhân vật có mặt; những chuyện riêng tư chưa được ghi lại và trong cốt truyện cũng chưa từng tiết lộ (thân thế, trải nghiệm, bí mật, sở thích, tên tuổi) mặc định nhân vật đó không biết, ngăn nhân vật dựa vào thiết lập / Sách Thế Giới để toàn tri về nhân vật chính. Trên thẻ nhân vật có bản ghi sẽ hiển thị hai mục gần nhất, nhấn mở hoặc nhấn nút bóng đèn để xem và sửa đổi. Sau khi tắt sẽ không ghi nhận và cũng không gửi nữa, danh sách đã có vẫn được giữ lại. Mục này độc lập với "Danh sách NPC": khi chỉ tắt danh sách NPC, ở đây vẫn sẽ đưa ra tên của các nhân vật chính yếu / có mặt.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Thông tin vật phẩm</span>
          <input v-model="apiSettings.injection.items" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.scenes" />
        </label>
        <p class="bbs-field-hint">Vật phẩm mang theo / có thể tiếp cận gửi toàn lượng, cất giữ nơi khác chỉ gửi tên và số lượng; phụ thuộc Thông tin khung cảnh.</p>
      </Collapsible>

      <!-- Loại trừ nhân vật -->
      <Collapsible title="Loại trừ nhân vật" :open="false">
        <p class="bbs-field-hint">Trong cuộc trò chuyện của tên nhân vật được tích chọn (bao gồm cả thẻ trùng tên), mọi tính năng của Bách Bảo Thư đều không có hiệu lực —— không tóm tắt, không ẩn, không tiêm, không chặn. Phù hợp với các nhân vật mang tính công cụ, không cần trí nhớ.</p>
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">
            Đã loại trừ {{ apiSettings.excludedChars.length }} nhân vật
          </span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="openExclude">
            <Icon name="edit" /> Chỉnh sửa danh sách
          </button>
        </div>
        <ul v-if="apiSettings.excludedChars.length" class="bbs-exclude-chips">
          <li v-for="name in apiSettings.excludedChars" :key="name" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">{{ name }}</span>
            <button class="bbs-exclude-chip-x" type="button" title="Đưa ra khỏi danh sách" @click="toggleExcluded(name)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">Danh sách trống, tất cả các nhân vật đều bật hệ thống trí nhớ.</p>
      </Collapsible>

      <!-- Loại trừ nội dung Sách Thế Giới -->
      <Collapsible title="Loại trừ nội dung Sách Thế Giới" :open="false">
        <p class="bbs-field-hint">
          Khi tóm tắt / đại tóm tắt sẽ kích hoạt Sách Thế Giới làm tài liệu tham khảo. Tại đây có thể loại bỏ các mục vô dụng đối với trí nhớ cốt truyện —— như sách kiến thức bổ sung gắn toàn cục,
          giải thích quy tắc..., vừa tiết kiệm token vừa tránh gây nhiễu. Chỉ ảnh hưởng tới API phụ tóm tắt, không làm thay đổi Sách Thế Giới trong cuộc đối thoại chính của bạn.
        </p>

        <!-- Kết xuất mẫu Sách Thế Giới: phối hợp với các plugin như "Mẫu lời nhắc (ST-Prompt-Template)" -->
        <label class="bbs-switch-row">
          <span class="bbs-field-label">Kết xuất mẫu Sách Thế Giới</span>
          <input v-model="apiSettings.renderWorldInfoTemplates" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">
          Sau khi bật sẽ tương thích với các mục Sách Thế Giới dùng mẫu lời nhắc (ejs)
        </p>

        <hr class="bbs-rule" />

        <!-- Loại trừ nguyên cuốn: sao chép lại hộp thoại tìm kiếm + tích chọn của Loại trừ nhân vật -->
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">Loại trừ nguyên cuốn · Đã chọn {{ apiSettings.excludedWorldNames.length }} cuốn</span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="openExcludeWorld">
            <Icon name="edit" /> Chỉnh sửa danh sách
          </button>
        </div>
        <ul v-if="apiSettings.excludedWorldNames.length" class="bbs-exclude-chips">
          <li v-for="name in apiSettings.excludedWorldNames" :key="name" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">{{ name }}</span>
            <button class="bbs-exclude-chip-x" type="button" title="Đưa ra khỏi danh sách" @click="toggleWorldExcluded(name)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">Chưa loại trừ cuốn Sách Thế Giới nào, toàn bộ các mục kích hoạt đều sẽ được đưa vào tham khảo tóm tắt.</p>

        <hr class="bbs-rule" />

        <!-- Lọc theo tên mục: sao chép lại ô nhập + chips của thẻ làm sạch -->
        <div class="bbs-field-head">
          <span class="bbs-field-label">Lọc theo tên mục</span>
        </div>
        <p class="bbs-field-hint">
          Điền tên ghi chú của mục (comment) tức là khớp theo dạng <strong>bao gồm</strong> (không phân biệt hoa thường) —— VD: điền <code>Phụ lục</code> có thể trúng "Thiết lập phụ lục".
          Cũng hỗ trợ biểu thức chính quy (regex): <code>^Quy tắc</code> biểu thị bắt đầu bằng "Quy tắc". Có hiệu lực đối với các cuốn Sách Thế Giới chưa bị loại trừ nguyên cuốn ở trên.
          Mặc định cài sẵn một mục <code>\[mvu[\s\S]*?\]</code> để lọc các mục cơ chế của khung biến số MVU; nếu không cần có thể xóa trực tiếp.
        </p>
        <div class="bbs-striptag-bar">
          <input
            v-model="wiPatternDraft"
            class="bbs-input"
            type="text"
            placeholder="Tên mục hoặc regex, VD: Phụ lục hoặc ^Quy tắc"
            @keydown.enter.prevent="addWiPattern"
          />
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addWiPattern">
            <Icon name="plus" /> Thêm
          </button>
        </div>
        <ul v-if="apiSettings.excludedWorldInfoPatterns.length" class="bbs-exclude-chips">
          <li v-for="pat in apiSettings.excludedWorldInfoPatterns" :key="pat" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">{{ pat }}</span>
            <button class="bbs-exclude-chip-x" type="button" title="Gỡ bỏ" @click="removeWiPattern(pat)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">Chưa có quy tắc tên mục nào.</p>
      </Collapsible>

      <!-- Thẻ làm sạch tùy chỉnh -->
      <Collapsible title="Thẻ làm sạch tùy chỉnh" :open="false">
        <p class="bbs-field-hint">
          Nếu trong chính văn có lẫn các khối định dạng do plugin khác / Sách Thế Giới viết ra (như thanh trạng thái <code>&lt;snow&gt;…&lt;/snow&gt;</code>),
          có thể điền tên thẻ vào đây (chỉ điền <code>snow</code>, không kèm dấu ngoặc nhọn), khi tóm tắt, lập chỉ mục vector và truy xuất sẽ xóa bỏ nguyên khối cùng nội dung bên trong.
          Sau khi điều chỉnh sẽ có hiệu lực tức thì đối với **truy xuất** (kho vector lưu nguyên văn, khi truy xuất mới làm sạch), không cần dựng lại chỉ mục.
        </p>
        <div class="bbs-striptag-bar">
          <input
            v-model="stripTagDraft"
            class="bbs-input"
            type="text"
            placeholder="Tên thẻ, VD: snow"
            @keydown.enter.prevent="addStripTag"
          />
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addStripTag">
            <Icon name="plus" /> Thêm
          </button>
        </div>
        <ul v-if="apiSettings.customStripTags.length" class="bbs-exclude-chips">
          <li v-for="tag in apiSettings.customStripTags" :key="tag" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">&lt;{{ tag }}&gt;</span>
            <button class="bbs-exclude-chip-x" type="button" title="Gỡ bỏ" @click="removeStripTag(tag)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">Chưa có thẻ tùy chỉnh nào. Chỉ có bộ làm sạch tích hợp sẵn (chuỗi suy luận, chú thích, chú thích vật phẩm...) có hiệu lực.</p>
      </Collapsible>

      <!-- Lời nhắc tùy chỉnh -->
      <Collapsible title="Lời nhắc tùy chỉnh" :open="false">
        <ul class="bbs-prompt-list">
          <li v-for="m in PROMPT_METAS" :key="m.key" class="bbs-prompt-item">
            <button class="bbs-prompt-open" type="button" @click="openPrompt(m)">
              <span class="bbs-prompt-name">{{ m.label }}</span>
              <span class="bbs-prompt-state" :class="{ 'is-custom': isCustom(m.key) }">
                {{ isCustom(m.key) ? 'Đã tùy chỉnh' : 'Mặc định' }}
              </span>
              <Icon name="edit" class="bbs-prompt-edit" />
            </button>
          </li>
        </ul>
      </Collapsible>

      <!-- Trí nhớ vector -->
      <Collapsible title="Trí nhớ vector" :open="false">
        <label class="bbs-switch-row bbs-vec-enable">
          <span class="bbs-field-label">Bật trí nhớ vector</span>
          <input v-model="apiSettings.vector.enabled" type="checkbox" class="bbs-checkbox" />
        </label>

        <hr class="bbs-rule bbs-vec-enable-rule" />

        <!-- Ba điểm cuối: Embedding bắt buộc; địa chỉ Rerank/Query để trống = tái sử dụng toàn bộ Embedding.
             Bản thân thẻ có thể thu gọn (nhấn thanh tiêu đề), không có khung ngoài dư thừa; tiêu đề phụ hiển thị mô hình hiện tại, khi thu gọn vẫn biết đã cấu hình hay chưa. -->
        <div
          v-for="role in VECTOR_ROLES"
          :key="role.key"
          class="bbs-vec-ep"
          :class="{ 'is-disabled': !apiSettings.vector.enabled, 'is-collapsed': !vecEpOpen[role.key] }"
        >
          <button
            type="button"
            class="bbs-vec-head bbs-vec-toggle"
            :aria-expanded="vecEpOpen[role.key]"
            @click="vecEpOpen[role.key] = !vecEpOpen[role.key]"
          >
            <span class="bbs-field-label">{{ role.label }}</span>
            <Icon name="chevron" class="bbs-vec-chevron" />
          </button>

          <div class="bbs-vec-ep-outer">
            <div class="bbs-vec-ep-inner">
          <div class="bbs-vec-ep-body">
          <p v-if="role.key !== 'embedding'" class="bbs-field-hint">Địa chỉ / khóa bảo mật để trống sẽ tái sử dụng Embedding; mô hình vẫn cần điền riêng cho từng vai trò.</p>

          <label class="bbs-modal-field">
            <span class="bbs-modal-label">Địa chỉ API</span>
            <input
              v-model="apiSettings.vector[role.key].url"
              class="bbs-input"
              :placeholder="role.key === 'embedding' ? 'VD: https://api.openai.com/v1' : 'Để trống = tái sử dụng địa chỉ của Embedding'"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>

          <label class="bbs-modal-field">
            <span class="bbs-modal-label">Khóa bảo mật API</span>
            <div class="bbs-model-row">
              <input
                v-model="apiSettings.vector[role.key].key"
                class="bbs-input"
                :type="vecShowKey[role.key] ? 'text' : 'password'"
                :placeholder="role.key === 'embedding' ? 'Khóa bảo mật API' : 'Để trống = tái sử dụng khóa bảo mật của Embedding'"
                :disabled="!apiSettings.vector.enabled"
              />
              <button
                class="bbs-icon-mini"
                type="button"
                :title="vecShowKey[role.key] ? 'Ẩn khóa bảo mật' : 'Hiển thị khóa bảo mật'"
                @click="vecShowKey[role.key] = !vecShowKey[role.key]"
              >
                <Icon :name="vecShowKey[role.key] ? 'eye-off' : 'eye'" />
              </button>
            </div>
          </label>

          <!-- Mô hình: ba vai trò độc lập với nhau (mô hình embedding/rerank/query vốn dĩ khác nhau), đều phải chọn riêng, không bao giờ tái sử dụng.
               Kéo danh sách đi theo "địa chỉ/khóa của vai trò đó", để trống sẽ tự động dùng địa chỉ/khóa của Embedding để kéo. -->
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">Mô hình</span>
            <div class="bbs-model-row">
              <div class="bbs-combo">
                <input
                  v-model="apiSettings.vector[role.key].model"
                  class="bbs-input"
                  :placeholder="(vecModels[role.key]?.length) ? 'Tìm kiếm hoặc nhập tên mô hình…' : 'Tên mô hình, hoặc nhấn nút bên phải để kéo danh sách'"
                  :disabled="!apiSettings.vector.enabled"
                  @focus="openVecModelMenu(role.key)"
                  @input="vecModelQuery = apiSettings.vector[role.key].model; vecModelMenuOpen = role.key"
                  @blur="closeVecModelMenuSoon"
                />
                <span
                  v-if="vecModels[role.key]?.length"
                  class="bbs-combo-caret"
                  :class="{ 'is-open': vecModelMenuOpen === role.key }"
                  aria-hidden="true"
                />
                <ul v-if="vecModelMenuOpen === role.key && vecModels[role.key]?.length" class="bbs-combo-menu">
                  <li v-if="!filteredVecModels(role.key).length" class="bbs-combo-empty">Không có mô hình khớp</li>
                  <li
                    v-for="m in filteredVecModels(role.key)"
                    :key="m"
                    class="bbs-combo-item"
                    :class="{ 'is-active': m === apiSettings.vector[role.key].model }"
                    @mousedown.prevent="pickVecModel(role.key, m)"
                  >
                    {{ m }}
                  </li>
                </ul>
              </div>
              <button
                class="bbs-icon-mini"
                type="button"
                :title="vecLoadingModels[role.key] ? 'Đang kéo danh sách…' : 'Kéo danh sách mô hình'"
                :disabled="!apiSettings.vector.enabled || vecLoadingModels[role.key]"
                @click="pullVecModels(role.key)"
              >
                <Icon name="refresh" />
              </button>
            </div>
          </label>
          <p v-if="vecModelMsg[role.key]" class="bbs-field-hint">{{ vecModelMsg[role.key] }}</p>

          <!-- Hết thời gian chờ / thử lại (+ token đầu ra tối đa của Viết lại Query): mỗi vai trò độc lập (mặc định embedding 10s / rerank 20s / query 90s), không lùi về theo tái sử dụng địa chỉ.
               grid auto-fit: đủ không gian thì xếp một dòng, không đủ tự động xuống dòng. -->
          <div class="bbs-vec-io">
            <label class="bbs-vec-io-item">
              <span class="bbs-modal-label">Thời gian chờ (giây)</span>
              <input
                v-model.number="apiSettings.vector[role.key].timeoutSec"
                class="bbs-input bbs-num-sm"
                type="number"
                min="1"
                :disabled="!apiSettings.vector.enabled"
              />
            </label>
            <label class="bbs-vec-io-item">
              <span class="bbs-modal-label">Số lần thử lại khi thất bại</span>
              <input
                v-model.number="apiSettings.vector[role.key].retries"
                class="bbs-input bbs-num-sm"
                type="number"
                min="0"
                :disabled="!apiSettings.vector.enabled"
              />
            </label>
            <label v-if="role.key === 'queryRewrite'" class="bbs-vec-io-item">
              <span class="bbs-modal-label">Token đầu ra tối đa</span>
              <input
                v-model.number="apiSettings.vector.queryRewriteMaxTokens"
                class="bbs-input bbs-num-sm"
                type="number"
                min="256"
                :disabled="!apiSettings.vector.enabled"
              />
            </label>
          </div>

          </div>
            </div>
          </div>
        </div>

        <hr class="bbs-rule" />

        <!-- Tham số truy xuất: giải thích cơ chế + các nút vặn nâng cao thu gọn tổng thể, mặc định thu gọn để không làm ngập phần cấu hình điểm cuối phía trên. -->
        <Collapsible title="Tham số truy xuất" :open="false">
          <div class="bbs-vec-recall" :class="{ 'is-disabled': !apiSettings.vector.enabled }">
            <p class="bbs-field-hint">
              Tính độ tương đồng embedding cho toàn bộ chỉ mục vector trước, lấy một số mục có điểm cao nhất đưa vào rerank; sau khi rerank chấm điểm sẽ chia làm hai mức:
              mức điểm cao gửi toàn văn nguyên văn, mức thấp hơn một chút nhưng vẫn vượt ngưỡng embedding thì gửi bản tóm tắt; tổng cộng hai mức không vượt quá "Số lượng truy xuất cuối cùng".
            </p>

            <p class="bbs-field-hint">
              Trước khi tạo phản hồi sẽ dùng mô hình nhỏ ("Viết lại Query" ở trên) viết lại cốt truyện hiện tại thành nhiều câu truy vấn tìm kiếm (query), truy xuất đa luồng toàn diện hơn.
              <strong>Viết lại truy vấn là bước bắt buộc phải qua khi truy xuất, phải cấu hình đầy đủ mô hình "Viết lại Query"; nếu chưa cấu hình hoặc viết lại thất bại thì lượt này sẽ không truy xuất.</strong>
              Mỗi lượt thêm một yêu cầu mô hình nhỏ (tăng nhẹ độ trễ).
            </p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Độ sâu tiêm truy xuất</span>
            <input
              v-model.number="apiSettings.vector.recall.injectionDepth"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              step="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">Độ sâu tiêm nội dung truy xuất vào trong cuộc trò chuyện. 0 = D0, sát với nội dung nhập mới nhất của người dùng nhất; số càng lớn càng dịch về phía trước.</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Số ứng viên Rerank</span>
            <input
              v-model.number="apiSettings.vector.recall.rerankCandidates"
              class="bbs-input bbs-num"
              type="number"
              min="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">Lấy N mục đầu theo độ tương đồng embedding để đưa vào rerank sắp xếp tinh chỉnh (càng lớn càng chuẩn nhưng càng chậm).</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Ngưỡng Embedding</span>
            <input
              v-model.number="apiSettings.vector.recall.embeddingThreshold"
              class="bbs-input bbs-num"
              type="number"
              step="0.01"
              min="0"
              max="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">Ngưỡng đầu vào mức tóm tắt: nội dung có độ tương đồng embedding thấp hơn mức này thì ngay cả bản tóm tắt cũng không truy xuất (0~1).</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Ngưỡng Rerank</span>
            <input
              v-model.number="apiSettings.vector.recall.rerankThreshold"
              class="bbs-input bbs-num"
              type="number"
              step="0.01"
              min="0"
              max="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">Điểm rerank ≥ giá trị này sẽ gửi toàn văn nguyên văn, thấp hơn mức này nhưng vượt ngưỡng embedding sẽ lùi về gửi bản tóm tắt (0~1).</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Số lượng toàn văn truy xuất</span>
            <input
              v-model.number="apiSettings.vector.recall.fullTextCount"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">Mức toàn văn lấy tối đa mấy mục để gửi nguyên văn (phần còn lại dù vượt ngưỡng rerank cũng lùi về bản tóm tắt).</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Số lượng truy xuất cuối cùng</span>
            <input
              v-model.number="apiSettings.vector.recall.finalRecallCount"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">Giới hạn tổng số mục truy xuất (tổng cộng toàn văn + tóm tắt); toàn văn không đủ sẽ dùng tóm tắt bù vào, bù không đầy cũng không sao.</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Số tầng AI bắt đầu truy xuất</span>
            <input
              v-model.number="apiSettings.vector.recall.minAiFloors"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">
            Khi số tin nhắn AI của cuộc trò chuyện hiện tại ít hơn giá trị này sẽ không kích hoạt truy xuất (0 = không giới hạn). Cốt truyện giai đoạn đầu có ít ký ức cũ, bỏ qua giúp tiết kiệm hạn mức / độ trễ.
            Ngoài ra: khi mọi tin nhắn đều vẫn đang nằm trong cửa sổ trượt gửi toàn văn thì cũng sẽ tự động bỏ qua (không có tầng cũ ngoài cửa sổ để truy xuất); bản lưu cũ của "Tạo cuộc trò chuyện mới kèm dữ liệu" không chịu giới hạn này, luôn được truy xuất.
          </p>
          </div>
        </Collapsible>

        <hr class="bbs-rule" />

        <!-- Bảo trì chỉ mục: dựng bù / đối soát các tóm tắt lá của cuộc trò chuyện hiện tại vào kho vector -->
        <div class="bbs-vec-recall" :class="{ 'is-disabled': !apiSettings.vector.enabled }">
          <div class="bbs-vec-head">
            <span class="bbs-field-label">Bảo trì chỉ mục</span>
            <span
              v-if="vecBackend !== 'unknown'"
              class="bbs-vec-backend"
              :class="vecBackend === 'backend' ? 'is-backend' : 'is-local'"
            >
              {{ vecBackend === 'backend' ? 'Bách Bảo Khố' : 'Trình duyệt' }}
            </span>
          </div>
          <p class="bbs-field-hint">
            Trong trường hợp bình thường tóm tắt lá sẽ tự động lập chỉ mục theo quá trình tạo; nếu giữa chừng mới bật trí nhớ vector, có thể dựng bù thủ công các bản tóm tắt đã có của cuộc trò chuyện hiện tại vào kho vector.
            Xóa sạch chỉ xóa chỉ mục của riêng cuộc trò chuyện hiện tại, không động tới ảnh chụp nhanh bản lưu cũ được kế thừa từ "Tạo cuộc trò chuyện mới kèm dữ liệu".
          </p>
          <p v-if="vecBackend === 'local'" class="bbs-field-hint">
            Chế độ cục bộ: chỉ mục lưu trong trình duyệt, chỉ truy xuất trong cuộc trò chuyện hiện tại, không xuyên trò chuyện / không xuyên thiết bị. Sau khi cài đặt backend Bách Bảo Khố có thể khôi phục toàn bộ khả năng.
          </p>
          <div class="bbs-vec-index-actions">
            <button
              class="bbs-btn bbs-btn-sm"
              type="button"
              :disabled="!apiSettings.vector.enabled || vecIndexing || vecClearing"
              @click="doRebuildIndex"
            >
              {{ vecIndexing ? 'Đang lập chỉ mục…' : 'Dựng lại chỉ mục vector của trò chuyện hiện tại' }}
            </button>
            <button
              class="bbs-btn bbs-btn-sm bbs-btn-danger"
              type="button"
              :disabled="!apiSettings.vector.enabled || vecIndexing || vecClearing"
              @click="doClearIndex"
              @blur="vecClearConfirm = false"
            >
              <Icon name="trash" />
              {{ vecClearing ? 'Đang xóa sạch…' : vecClearConfirm ? 'Nhấn lần nữa xác nhận xóa sạch' : 'Xóa sạch chỉ mục trò chuyện hiện tại' }}
            </button>
          </div>
          <p v-if="vecIndexMsg" class="bbs-field-hint">{{ vecIndexMsg }}</p>
        </div>

        <hr class="bbs-rule" />

        <!-- Chi tiết lần truy xuất trước: trực quan hóa kết quả trung gian các giai đoạn của lần truy xuất trước, tiện tinh chỉnh tham số / gỡ lỗi (reactive tự động làm mới) -->
        <Collapsible title="Chi tiết lần truy xuất trước" :open="false">
          <p v-if="!recallDebug.at" class="bbs-field-hint">
            Chưa có bản ghi truy xuất. Sau khi cấu hình kênh vector và gửi một tin nhắn kích hoạt truy xuất, tại đây sẽ hiển thị kết quả các giai đoạn Viết lại / Tìm kiếm / Sắp xếp lại / Tiêm.
          </p>
          <div v-else class="bbs-dbg">
            <!-- Biểu ngữ trạng thái: chấm tròn bên trái phối màu theo sắc thái, bên phải là thời gian -->
            <div class="bbs-dbg-banner" :class="`is-${recallStatusKind}`">
              <span class="bbs-dbg-dot" aria-hidden="true"></span>
              <span class="bbs-dbg-status-text">{{ recallDebug.status }}</span>
              <span class="bbs-dbg-time">{{ fmtRecallTime(recallDebug.at) }}</span>
            </div>

            <!-- Bốn giai đoạn tự thu gọn riêng, mặc định thu gọn; tiêu đề kèm bộ đếm -->
            <Collapsible :title="`1 · Viết lại truy vấn · ${recallDebug.queries.length} Q`" :open="false">
              <p v-if="recallDebug.intent" class="bbs-dbg-intent">
                <span class="bbs-dbg-tag">INTENT</span><span class="bbs-dbg-intent-text">{{ recallDebug.intent }}</span>
              </p>
              <ul v-if="recallDebug.queries.length" class="bbs-dbg-qlist">
                <li v-for="(q, i) in recallDebug.queries" :key="i" class="bbs-dbg-qitem">
                  <span class="bbs-dbg-qno">Q{{ i + 1 }}</span><span class="bbs-dbg-qtext">{{ q }}</span>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">Không có</p>
            </Collapsible>

            <Collapsible :title="`2 · Tìm kiếm Embedding · ${recallDebug.embedding.length} mục`" :open="false">
              <ul v-if="recallDebug.embedding.length" class="bbs-dbg-cards">
                <li v-for="(h, i) in recallDebug.embedding" :key="i" class="bbs-dbg-card">
                  <div class="bbs-dbg-card-top">
                    <span class="bbs-dbg-src" :title="`Nguồn ${qLabel(h.queryIndex)}`">{{ qLabel(h.queryIndex) }}</span>
                    <span class="bbs-dbg-from" :class="{ 'is-bundle': h.source === 'Bản lưu cũ' }">{{ h.source }}</span>
                    <span v-if="h.storyTime" class="bbs-dbg-when">【{{ h.storyTime }}】</span>
                    <span class="bbs-dbg-num">{{ h.similarity.toFixed(3) }}</span>
                  </div>
                  <div class="bbs-dbg-bar"><i :style="{ width: scorePct(h.similarity) + '%' }"></i></div>
                  <p class="bbs-dbg-prev">{{ h.preview }}</p>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">Không có</p>
            </Collapsible>

            <Collapsible :title="`3 · Phân mức Rerank · ${recallDebug.rerank.length} mục`" :open="false">
              <ul v-if="recallDebug.rerank.length" class="bbs-dbg-cards">
                <li v-for="(h, i) in recallDebug.rerank" :key="i" class="bbs-dbg-card" :class="{ 'is-dropped': h.tier === 'drop' }">
                  <div class="bbs-dbg-card-top">
                    <span class="bbs-dbg-tier" :class="`is-${h.tier}`">{{ TIER_LABEL[h.tier] }}</span>
                    <span class="bbs-dbg-from" :class="{ 'is-bundle': h.source === 'Bản lưu cũ' }">{{ h.source }}</span>
                    <span v-if="h.storyTime" class="bbs-dbg-when">【{{ h.storyTime }}】</span>
                    <span class="bbs-dbg-num">{{ h.rerankScore.toFixed(3) }}</span>
                  </div>
                  <div class="bbs-dbg-bar" :class="`tier-${h.tier}`"><i :style="{ width: scorePct(h.rerankScore) + '%' }"></i></div>
                  <p class="bbs-dbg-prev">{{ h.preview }}</p>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">Không có (rerank chưa thực thi hoặc không có ứng viên)</p>
            </Collapsible>

            <Collapsible title="4 · Nội dung tiêm cuối cùng" :open="false">
              <pre v-if="recallDebug.injectedText" class="bbs-dbg-pre">{{ recallDebug.injectedText }}</pre>
              <p v-else class="bbs-dbg-empty">Lượt này chưa chèn.</p>
            </Collapsible>
          </div>
        </Collapsible>
      </Collapsible>

      <!-- Tạo cuộc trò chuyện mới kèm dữ liệu -->
      <Collapsible title="Tạo cuộc trò chuyện mới kèm dữ liệu" :open="false">
        <p class="bbs-field-hint">
          Đóng gói "Cửa sổ toàn văn gần nhất + Tóm tắt lịch sử gộp + Trạng thái hiện tại (thời gian/địa điểm, khung cảnh, vật phẩm, nhân vật, kế hoạch, biến số)" của cuộc trò chuyện hiện tại, tạo một cuộc trò chuyện mới mang sang.
          Cuộc trò chuyện mới phát lại khôi phục trạng thái từ một "lá hạt giống", cốt truyện cũ đi kèm dưới dạng tóm tắt; nếu có bật trí nhớ vector, cuộc trò chuyện cũ sẽ được chụp nhanh,
          cuộc trò chuyện mới có thể truy xuất vector nội dung của nó (tích lũy qua từng lần, phân nhánh cũng tự động kế thừa).
        </p>
        <div v-if="carryPlan" class="bbs-field-hint">
          Sẽ mang theo: {{ carryPlan.aiCount }} tin AI / {{ carryPlan.carryCount }} tin nhắn thực tế; tóm tắt cốt truyện cũ: {{ carryPlan.recapLen > 0 ? 'Có' : 'Không có' }}.
        </div>
        <button
          class="bbs-btn bbs-btn-sm bbs-btn-primary"
          type="button"
          :disabled="carrying || !carryPlan?.hasData"
          @click="carryConfirmOpen = true"
        >
          {{ carrying ? 'Đang tạo…' : 'Tạo cuộc trò chuyện mới kèm dữ liệu' }}
        </button>
        <p v-if="carryMsg" class="bbs-field-hint">{{ carryMsg }}</p>
      </Collapsible>

      <!-- Di chuyển dữ liệu từ Horae -->
      <Collapsible title="Di chuyển dữ liệu từ Horae" :open="false">
        <p class="bbs-field-hint">
          Di chuyển các bản tóm tắt, vật phẩm, kế hoạch của Horae bản cũ trong cuộc trò chuyện hiện tại sang đây. Mỗi cuộc trò chuyện cần di chuyển hãy nhấn một lần, không động chạm tới dữ liệu Horae gốc.
        </p>
        <div v-if="migratePlan" class="bbs-field-hint">
          <template v-if="migratePlan.hasData">
            Phát hiện: có thể tạo tóm tắt {{ migratePlan.leafFloors }} tầng / {{ migratePlan.summaryCount }} bản đại tóm tắt cũ /
            {{ migratePlan.itemCount }} vật phẩm / {{ migratePlan.planCount }} kế hoạch nghi vấn.
            <span v-if="migratePlan.willOverwrite">⚠️ Cuộc trò chuyện hiện tại đã có dữ liệu của plugin này, việc di chuyển sẽ ghi đè.</span>
          </template>
          <template v-else>Không phát hiện thấy dữ liệu Horae cũ trong cuộc trò chuyện hiện tại (vui lòng vào cuộc trò chuyện có chứa dữ liệu cũ trước).</template>
        </div>
        <button
          class="bbs-btn bbs-btn-sm bbs-btn-primary"
          type="button"
          :disabled="migrating || !migratePlan?.hasData"
          @click="migrateConfirmOpen = true"
        >
          {{ migrating ? 'Đang di chuyển…' : 'Di chuyển dữ liệu Horae của cuộc trò chuyện hiện tại' }}
        </button>
        <p v-if="migrateMsg" class="bbs-field-hint">{{ migrateMsg }}</p>
      </Collapsible>

      <!-- Lấy dữ liệu -->
      <Collapsible title="Lấy dữ liệu" :open="false">
        <p class="bbs-field-hint bbs-data-intro">
          Macro có thể dùng cho lời nhắc, giải thích biến số và các vị trí khác hỗ trợ macro ST. Giao diện đầy đủ, lệnh và cấu trúc trả về có thể xuất thành tài liệu dành cho tác giả plugin.
        </p>

        <div class="bbs-data-macros">
          <div v-for="macro in DATA_MACROS" :key="macro.token" class="bbs-data-macro">
            <div class="bbs-data-macro-main">
              <div class="bbs-data-macro-head">
                <span class="bbs-data-macro-title">{{ macro.title }}</span>
                <code class="bbs-data-token">{{ macro.token }}</code>
              </div>
              <p class="bbs-data-desc">{{ macro.desc }}</p>
            </div>
            <button
              class="bbs-icon-mini bbs-data-copy"
              type="button"
              :title="`Sao chép ${macro.token}`"
              :aria-label="`Sao chép ${macro.token}`"
              @click="copyDataMacro(macro.token)"
            >
              <Icon name="copy" />
            </button>
          </div>
        </div>

        <div class="bbs-data-export">
          <div class="bbs-data-export-text">
            <span class="bbs-field-label">Tài liệu giao diện công khai</span>
            <p class="bbs-data-desc">Tải xuống PUBLIC_API.md, bao gồm JavaScript API, lệnh gạch chéo (slash commands), macro, cấu trúc trả về và ví dụ sử dụng.</p>
          </div>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="exportPublicApiDocument">
            <Icon name="download" />
            Xuất tài liệu
          </button>
        </div>
      </Collapsible>
    </div>

    <!-- Hộp thoại xác nhận của Tạo cuộc trò chuyện mới kèm dữ liệu / Di chuyển từ Horae -->
    <ConfirmDialog
      v-model:open="carryConfirmOpen"
      title="Tạo cuộc trò chuyện mới kèm dữ liệu"
      confirm-text="Tạo và chuyển vào"
      @confirm="runCarryover"
    >
      Sẽ tạo một cuộc trò chuyện mới kèm dữ liệu dựa trên cuộc trò chuyện hiện tại và chuyển vào đó. Tiếp tục chứ?
    </ConfirmDialog>
    <ConfirmDialog
      v-model:open="migrateConfirmOpen"
      title="Di chuyển dữ liệu từ Horae"
      confirm-text="Bắt đầu di chuyển"
      @confirm="runMigrate"
    >
      {{ migrateConfirmText }}
    </ConfirmDialog>

    <!-- ===== Hộp thoại chỉnh sửa kênh ===== -->
    <ModalMask :open="!!editingChannel" @close="closeChannel">
      <div v-if="editingChannel" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa kênh">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa kênh</span>
          <button class="bbs-icon-mini" type="button" title="Đóng" @click="closeChannel"><Icon name="close" /></button>
        </header>

        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tên kênh</span>
          <input v-model="editingChannel.name" class="bbs-input" placeholder="Tên kênh" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Địa chỉ API</span>
          <input v-model="editingChannel.url" class="bbs-input" placeholder="VD: https://api.openai.com/v1" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Khóa bảo mật API</span>
          <div class="bbs-model-row">
            <input
              v-model="editingChannel.key"
              class="bbs-input"
              :type="showKey ? 'text' : 'password'"
              placeholder="Khóa bảo mật API"
            />
            <button
              class="bbs-icon-mini"
              type="button"
              :title="showKey ? 'Ẩn khóa bảo mật' : 'Hiển thị khóa bảo mật'"
              :aria-pressed="showKey"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Mô hình</span>
          <div class="bbs-model-row">
            <!-- Combobox có thể tìm kiếm: khi đã kéo được danh sách mô hình, focus sẽ bật menu lọc; khi chưa có danh sách thì là ô nhập thông thường -->
            <div class="bbs-combo">
              <input
                v-model="editingChannel.model"
                class="bbs-input"
                :placeholder="modelList.length ? 'Tìm kiếm hoặc nhập tên mô hình…' : 'Tên mô hình, VD: gpt-4o-mini'"
                @focus="openModelMenu"
                @input="modelQuery = editingChannel.model; modelMenuOpen = true"
                @blur="closeModelMenuSoon"
              />
              <!-- Tam giác thả xuống tự vẽ (thuần trang trí, pointer-events:none → nhấn xuyên qua vào ô nhập vẫn focus mở rộng như thường); chỉ hiển thị khi có mô hình tùy chọn -->
              <span v-if="modelList.length" class="bbs-combo-caret" :class="{ 'is-open': modelMenuOpen }" aria-hidden="true" />
              <ul v-if="modelMenuOpen && modelList.length" class="bbs-combo-menu">
                <li v-if="!filteredModels.length" class="bbs-combo-empty">Không có mô hình khớp</li>
                <li
                  v-for="m in filteredModels"
                  :key="m"
                  class="bbs-combo-item"
                  :class="{ 'is-active': m === editingChannel.model }"
                  @mousedown.prevent="pickModel(m)"
                >
                  {{ m }}
                </li>
              </ul>
            </div>
            <button
              class="bbs-icon-mini"
              type="button"
              :title="loadingModels[editingChannel.id] ? 'Đang kéo danh sách…' : 'Kéo danh sách mô hình'"
              :disabled="loadingModels[editingChannel.id]"
              @click="pullModels(editingChannel)"
            >
              <Icon name="refresh" />
            </button>
          </div>
        </label>
        <div class="bbs-channel-row">
          <label class="bbs-mini-field">
            <span>Nhiệt độ (Temperature)</span>
            <input v-model.number="editingChannel.temperature" class="bbs-input" type="number" step="0.1" min="0" max="2" />
          </label>
          <label class="bbs-mini-field">
            <span>Token tối đa</span>
            <input v-model.number="editingChannel.maxTokens" class="bbs-input" type="number" step="256" min="256" />
          </label>
          <label class="bbs-mini-field">
            <span>Chờ (giây)</span>
            <input v-model.number="editingChannel.timeoutSec" class="bbs-input" type="number" step="10" min="1" />
          </label>
          <!-- Cường độ suy luận: hộp thả xuống tự vẽ (đi theo giao diện; lớp bật lên của select gốc do hệ thống kết xuất, giao diện không quản lý được).
               auto là tùy chọn tường minh, giá trị là chuỗi rỗng = không gửi tham số này -->
          <div class="bbs-mini-field">
            <span>Cường độ suy luận</span>
            <BbsSelect
              v-model="editingChannel.reasoningEffort"
              :options="REASONING_EFFORT_OPTIONS"
              aria-label="Cường độ suy luận"
            />
          </div>
        </div>
        <span class="bbs-field-hint">Cường độ suy luận nếu không rõ thì chọn auto, dòng DeepSeek khuyên dùng max</span>
        <label class="bbs-switch-row">
          <span class="bbs-modal-label">Truyền phát luồng (Stream)</span>
          <input v-model="editingChannel.stream" type="checkbox" class="bbs-checkbox" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tham số loại trừ</span>
          <input
            v-model="excludeParamsText"
            class="bbs-input"
            type="text"
            placeholder="Ngăn cách bằng dấu phẩy, VD: temperature, max_tokens"
          />
          <span class="bbs-field-hint">Các tham số này sẽ bị xóa khỏi thân yêu cầu trước khi gửi đi, dùng để tránh lỗi ở các điểm cuối tương thích không chấp nhận tham số đó. Ngăn cách bằng dấu phẩy, để trống thì không loại trừ.</span>
        </label>
        <p v-if="testing[editingChannel.id]" class="bbs-channel-test">{{ testing[editingChannel.id] }}</p>

        <footer class="bbs-modal-foot">
          <!-- Nút Xóa dạt sang trái, tách khỏi thao tác chính bên phải, hành động phá hủy không nằm sát "Hoàn tất" để giảm chạm nhầm.
               Xóa: luôn hiển thị chữ; Kiểm tra: trên PC hiện "Kiểm tra kênh", trên di động chỉ hiện "Kiểm tra" (bản ngắn, tiết kiệm diện tích) -->
          <button class="bbs-btn bbs-btn-danger" type="button" @click="askRemoveChannel">
            <Icon name="trash" /> Xóa
          </button>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn" type="button" title="Kiểm tra kênh" @click="doTest(editingChannel)">
            <Icon name="plug" /> <span class="bbs-btn-label-full">Kiểm tra kênh</span><span class="bbs-btn-label-short">Kiểm tra</span>
          </button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="confirmChannel">Hoàn tất</button>
        </footer>

        <!-- Xác nhận lần hai khi xóa kênh: chồng lên trên hộp thoại kênh. Đặt bên trong khối v-if="editingChannel",
             khi kênh là null thì toàn bộ không kết xuất —— vừa hợp ngữ nghĩa, vừa giúp thu hẹp kiểu của editingChannel.name.
             Bản thân ConfirmDialog dùng teleport + top-layer, đặt ở đây không ảnh hưởng tới phân tầng kết xuất của nó. -->
        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="Xóa kênh"
          confirm-text="Xóa"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemoveChannel"
        >
          Xác nhận xóa kênh "{{ editingChannel.name || 'Kênh chưa đặt tên' }}"? Thao tác này không thể hoàn tác, các tác vụ đã chỉ định kênh này sẽ được xóa trống.
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== Hộp thoại chỉnh sửa lời nhắc ===== -->
    <ModalMask :open="!!editingPrompt" @close="closePrompt">
      <div v-if="editingPrompt" class="bbs-modal bbs-modal-wide" role="dialog" aria-modal="true" :aria-label="`Chỉnh sửa ${editingPrompt.label}`">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa {{ editingPrompt.label }}</span>
          <button class="bbs-icon-mini" type="button" title="Đóng" @click="closePrompt"><Icon name="close" /></button>
        </header>

        <p class="bbs-modal-label">{{ editingPrompt.hint }}</p>

        <!-- Các macro khả dụng: nhấn một cái để chèn vào vị trí con trỏ -->
        <div class="bbs-macro-bar">
          <span class="bbs-macro-tip">Nhấn để chèn macro:</span>
          <button
            v-for="mac in editingPrompt.macros"
            :key="mac.token"
            class="bbs-macro"
            type="button"
            :title="mac.desc"
            @click="insertMacro(mac.token)"
          >
            {{ mac.token }}
          </button>
        </div>

        <textarea
          ref="promptArea"
          v-model="promptDraft"
          class="bbs-input bbs-prompt-area"
          spellcheck="false"
          rows="16"
        ></textarea>

        <footer class="bbs-modal-foot">
          <button class="bbs-btn bbs-btn-danger" type="button" @click="resetPrompt">
            <Icon name="refresh" /> Khôi phục mặc định
          </button>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn" type="button" @click="closePrompt">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="savePrompt">Hoàn tất</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Hộp thoại loại trừ nhân vật: tìm kiếm + danh sách tích chọn ===== -->
    <ModalMask :open="excludeOpen" @close="closeExclude">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa danh sách loại trừ">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Loại trừ nhân vật</span>
          <button class="bbs-icon-mini" type="button" title="Đóng" @click="closeExclude"><Icon name="close" /></button>
        </header>

        <input
          v-model="excludeSearch"
          class="bbs-input"
          type="search"
          placeholder="Tìm kiếm tên nhân vật…"
          spellcheck="false"
        />

        <div class="bbs-exclude-list">
          <label v-for="name in filteredCharNames" :key="name" class="bbs-exclude-row">
            <input
              type="checkbox"
              class="bbs-checkbox"
              :checked="isExcluded(name)"
              @change="toggleExcluded(name)"
            />
            <span class="bbs-exclude-row-name">{{ name }}</span>
          </label>
          <p v-if="!charNames.length" class="bbs-field-hint">Chưa đọc được danh sách nhân vật. Vui lòng tải thẻ nhân vật trong ST trước.</p>
          <p v-else-if="!filteredCharNames.length" class="bbs-field-hint">Không có nhân vật nào khớp với "{{ excludeSearch }}".</p>
        </div>

        <footer class="bbs-modal-foot">
          <span class="bbs-exclude-count">Tổng cộng {{ charNames.length }} nhân vật · Đã loại trừ {{ apiSettings.excludedChars.length }}</span>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="closeExclude">Hoàn tất</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Hộp thoại loại trừ Sách Thế Giới: tìm kiếm + danh sách tích chọn (sao chép lại từ Loại trừ nhân vật) ===== -->
    <ModalMask :open="excludeWorldOpen" @close="closeExcludeWorld">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa danh sách loại trừ Sách Thế Giới">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Loại trừ nguyên cuốn Sách Thế Giới</span>
          <button class="bbs-icon-mini" type="button" title="Đóng" @click="closeExcludeWorld"><Icon name="close" /></button>
        </header>

        <input
          v-model="excludeWorldSearch"
          class="bbs-input"
          type="search"
          placeholder="Tìm kiếm tên Sách Thế Giới…"
          spellcheck="false"
        />

        <div class="bbs-exclude-list">
          <label v-for="name in filteredWorldNames" :key="name" class="bbs-exclude-row">
            <input
              type="checkbox"
              class="bbs-checkbox"
              :checked="isWorldExcluded(name)"
              @change="toggleWorldExcluded(name)"
            />
            <span class="bbs-exclude-row-name">{{ name }}</span>
          </label>
          <p v-if="!worldNames.length" class="bbs-field-hint">Chưa đọc được Sách Thế Giới. Vui lòng tải / gắn Sách Thế Giới trong ST trước.</p>
          <p v-else-if="!filteredWorldNames.length" class="bbs-field-hint">Không có cuốn Sách Thế Giới nào khớp với "{{ excludeWorldSearch }}".</p>
        </div>

        <footer class="bbs-modal-foot">
          <span class="bbs-exclude-count">Tổng cộng {{ worldNames.length }} cuốn · Đã loại trừ {{ apiSettings.excludedWorldNames.length }}</span>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="closeExcludeWorld">Hoàn tất</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Hộp thoại xác nhận cập nhật ===== -->
    <ConfirmDialog
      v-model:open="updateConfirmOpen"
      title="Phát hiện phiên bản mới"
      confirm-text="Cập nhật và làm mới"
      busy-text="Đang cập nhật…"
      :busy="updateState.updating"
      @confirm="confirmUpdate"
    >
      Phiên bản hiện tại v{{ updateState.current || '—' }}, phiên bản mới nhất v{{ updateState.latest }}.<br />
      Cập nhật ngay bây giờ chứ? Sau khi cập nhật hoàn tất sẽ tự động làm mới trang để có hiệu lực.
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbs-page {
  display: flex;
  flex-direction: column;
}
.bbs-sections {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* —— Dòng tiêu đề: tiêu đề bên trái + số phiên bản (và nút cập nhật) bên phải —— */
.bbs-page-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.bbs-ver-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* Nhãn phiên bản: nền màu nhấn đặc + chữ trắng (Pastel = nền hồng chữ trắng, mỗi giao diện tự thích ứng theo --bbs-accent) */
.bbs-ver {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  cursor: pointer;
  font-family: var(--bbs-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-ver:hover {
  opacity: 0.88;
}
.bbs-ver:disabled {
  cursor: default;
}
.bbs-ver:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
}

.bbs-field {
  margin-bottom: 18px;
}
.bbs-field:last-child {
  margin-bottom: 0;
}
.bbs-field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.bbs-field-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
}
/* Giá trị số ở góc trên bên phải trường (như phần trăm độ mờ) */
.bbs-field-value {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--bbs-accent);
}

/* Thanh trượt: dùng màu giao diện, thống nhất ngoại hình xuyên trình duyệt */
.bbs-range {
  width: 100%;
  height: 4px;
  margin: 6px 0 12px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}
.bbs-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  border: 2px solid var(--bbs-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
}
.bbs-range::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  border: 2px solid var(--bbs-surface);
}
.bbs-range:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 3px;
}
.bbs-field-hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  line-height: 1.6;
}

/* Lấy dữ liệu: danh sách tra cứu nhanh macro + xuất tài liệu */
.bbs-data-intro {
  margin-bottom: 10px;
}
.bbs-data-macros {
  border-top: 1px solid var(--bbs-line);
}
.bbs-data-macro {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--bbs-line);
}
.bbs-data-macro-main {
  flex: 1 1 auto;
  min-width: 0;
}
.bbs-data-macro-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.bbs-data-macro-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
}
.bbs-data-token {
  max-width: 100%;
  color: var(--bbs-accent);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.bbs-data-desc {
  margin: 4px 0 0;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  line-height: 1.55;
}
.bbs-data-copy {
  flex: 0 0 auto;
}
.bbs-data-export {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 16px;
}
.bbs-data-export-text {
  flex: 1 1 auto;
  min-width: 0;
}

.bbs-segmented {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--bbs-surface-2);
  border-radius: var(--bbs-radius);
}
/* Tùy chọn giao diện có thể nhiều / nhãn khá dài: cho phép xuống dòng, dưới màn hình hẹp không bị tràn */
.bbs-segmented-wrap {
  display: flex;
  flex-wrap: wrap;
}
.bbs-seg {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 18px;
  background: transparent;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-sans);
  font-size: 13px;
  cursor: pointer;
  transition:
    background var(--bbs-dur) var(--bbs-ease),
    color var(--bbs-dur) var(--bbs-ease);
}
.bbs-seg:hover {
  color: var(--bbs-ink);
}
.bbs-seg.is-on {
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.08);
}

/* Chỉ định tác vụ */
.bbs-assign {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbs-assign-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
/* Hộp thả xuống chỉ định: chiếm nửa vùng bên phải (tên kênh có thể dài, cho đủ chiều rộng rồi mới cắt ngắn), cỡ chữ nhỏ hơn một nấc đồng nhất với các dòng cài đặt khác.
   Kèm bộ chọn cấp cha là để đè qua width:100% có sẵn ở nút gốc BbsSelect —— khi hai bên cùng độ đặc hiệu sẽ phụ thuộc thứ tự bảng kiểu dáng, điều đó tùy thuộc thứ tự đóng gói, không đáng tin */
.bbs-assign-row .bbs-assign-select {
  flex: 0 1 60%;
  min-width: 0;
}
.bbs-assign-select :deep(.bbs-select-trigger) {
  font-size: 12px;
}
/* —— Combobox mô hình có thể tìm kiếm —— */
.bbs-combo {
  position: relative;
  flex: 1;
  min-width: 0;
}
.bbs-combo .bbs-input {
  width: 100%;
  padding-right: 26px; /* Nhường chỗ cho tam giác tự vẽ bên phải, chữ không đè lên mũi tên */
}
/* Tam giác thả xuống tự vẽ: SVG cùng kiểu với <select> gốc, bám sát bên phải căn giữa; khi mở rộng thì lật ngược. Phần tử trang trí không chặn thao tác nhấn */
.bbs-combo-caret {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9.5 12 15.5 18 9.5'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 14px;
  transition: transform 0.15s ease;
}
.bbs-combo-caret.is-open {
  transform: translateY(-50%) rotate(180deg);
}
/* Menu lọc: định vị tuyệt đối bám ngay dưới ô nhập, giới hạn chiều cao có cuộn, danh sách dài không làm vỡ hộp thoại */
.bbs-combo-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 6;
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  box-shadow: var(--bbs-shadow);
}
.bbs-combo-item {
  padding: 7px 9px;
  border-radius: var(--bbs-radius-sm);
  font-size: 12.5px;
  color: var(--bbs-ink);
  cursor: pointer;
  word-break: break-all;
}
.bbs-combo-item:hover {
  background: var(--bbs-surface-2);
}
.bbs-combo-item.is-active {
  color: var(--bbs-accent);
  font-weight: 600;
}
.bbs-combo-empty {
  padding: 7px 9px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* Nút nhỏ hơn một cỡ: dùng cho các thao tác thứ cấp như "Thêm kênh" */
.bbs-btn-sm {
  padding: 6px 11px;
  font-size: 12px;
}

/* Cấu hình biểu tượng quả cầu nổi: khối vuông xem trước + các nút thao tác */
.bbs-orb-config {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.bbs-orb-preview {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  font-size: 22px;
  overflow: hidden;
}
.bbs-orb-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* Khung xem trước thay đổi theo hình dáng đã chọn, giúp người dùng nhìn thấy trực quan hiệu ứng */
.bbs-orb-preview.shape-bookmark {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
  border-color: transparent;
}
.bbs-orb-preview.shape-circle {
  border-radius: 999px;
}
.bbs-orb-preview.shape-square {
  border-radius: 12px;
}
.bbs-orb-config-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* Chữ nút kiểm tra: mặc định (PC) hiện bản đầy đủ, ẩn bản ngắn; màn hình hẹp hoán đổi trong media query */
.bbs-btn-label-short {
  display: none;
}

/* Kênh: thanh thao tác đỉnh (nhãn + nút thêm) */
.bbs-channel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* Kênh: danh sách chỉ đọc nhỏ gọn, mỗi kênh một dòng, nhấn vào dòng để vào hộp thoại chỉnh sửa */
.bbs-channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-channel-item {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
/* Thân dòng: nguyên khối nhấn được, trái là tên phải là mô hình */
.bbs-channel-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
.bbs-channel-open:hover {
  border-color: var(--bbs-accent);
  background: var(--bbs-surface);
}
/* Tên kênh: hiển thị đầy đủ, cho phép xuống dòng, chiếm không gian còn lại */
.bbs-channel-item-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
/* Tên mô hình: thông tin thứ cấp, quá dài thì cắt ngắn, không lấn chiếm tên kênh */
.bbs-channel-item-model {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Đáy hộp thoại: spacer đẩy nút Xóa về ngoài cùng bên trái, ngăn cách với các thao tác bên phải */
.bbs-modal-foot-spacer {
  flex: 1 1 auto;
}
/* Nút thao tác nguy hiểm: viền trầm lắng, hover mới hiện đỏ, tránh chạm nhầm */
.bbs-btn-danger {
  color: var(--bbs-danger);
  border-color: var(--bbs-line-strong);
}
.bbs-btn-danger:hover {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}

.bbs-model-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bbs-model-row .bbs-input {
  flex: 1;
}
.bbs-icon-mini:disabled {
  opacity: 0.5;
  cursor: default;
}
.bbs-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbs-icon-mini:hover {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
}
.bbs-channel-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.bbs-mini-field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}
.bbs-channel-test {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
  word-break: break-all;
}

/* Điều khiển cài đặt tóm tắt */
.bbs-switch-row,
.bbs-num-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}
/* "Bật trí nhớ vector" là dòng công tắc riêng lẻ trong vùng thu gọn, không cộng thêm padding trên nữa, bám sát nhịp điệu tiêu đề */
.bbs-vec-enable {
  padding-top: 0;
}
/* Đường phân cách ngay sau dòng công tắc thu bớt lề trên: dòng công tắc đã có sẵn 8px padding dưới là đủ, tránh làm cả khối trông trống trải */
.bbs-vec-enable-rule {
  margin-top: 0;
}
.bbs-checkbox {
  /* Trong dòng flex văn bản dài sẽ ép bẹp hộp kiểm có chiều rộng/cao cố định → cấm thu hẹp, giữ hình vuông tiêu chuẩn */
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  accent-color: var(--bbs-accent);
  cursor: pointer;
}
.bbs-num {
  max-width: 110px;
  text-align: right;
}
/* Thời gian chờ / thử lại của điểm cuối vector: hai ô nhập ngắn xếp cạnh nhau, label ở trên, khung hẹp ở dưới, chừa khoảng cách thoáng với dòng mô hình phía trên */
.bbs-vec-io {
  display: grid;
  /* Chiều rộng cột khớp sát nội dung (thay vì 1fr chia đều căng đầy), ba khung xếp gọn về bên trái; auto-fit đảm bảo tự động xuống dòng khi không đủ không gian.
     Dùng 1fr sẽ kéo mỗi item đầy cả dòng, label bên trong item cũng bị stretch kéo rộng theo, nhìn khoảng cách rất lớn. */
  grid-template-columns: repeat(auto-fit, minmax(72px, max-content));
  gap: 14px;
  margin-top: 12px;
}
.bbs-vec-io-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbs-num-sm {
  width: 72px;
  text-align: left;
}
/* Công tắc phá giới hạn theo sát ngay sau cột thời gian chờ/token: chừa thêm một chút khoảng cách trên, tách khỏi cột trước (chỉ trúng tại đây, không động tới switch-row chung) */
.bbs-vec-io + .bbs-switch-row {
  margin-top: 6px;
}
/* Hộp thả xuống tùy chọn ngắn (như Mức số chữ): chiều rộng hẹp vừa khít chữ, căn chỉnh với khung số bên phải, không căng đầy nửa dòng nữa.
   Tương tự như trên, kèm cấp cha để đè qua width:100% ở gốc component */
.bbs-num-row .bbs-select-narrow {
  width: auto;
  min-width: 65px;
  max-width: 150px;
}
.bbs-select-narrow :deep(.bbs-select-trigger) {
  font-size: 12px;
}

/* —— Thẻ điều khiển chính công tắc tổng —— */
/* Mép trái có một sống sách màu vàng, hưởng ứng thương hiệu "Thư" (Sách); khi tắt cả thẻ nhạt màu, sống sách chuyển sang xám, nhìn thoáng qua là nhận biết được trạng thái */
.bbs-master {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  padding: 16px 18px 16px 16px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  box-shadow: var(--bbs-shadow);
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-master-spine {
  flex: 0 0 auto;
  align-self: stretch;
  width: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  transition: background var(--bbs-dur) var(--bbs-ease);
}
.bbs-master.is-off .bbs-master-spine {
  background: var(--bbs-line-strong);
}
.bbs-master.is-off .bbs-master-text {
  opacity: 0.7;
}
.bbs-master-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.bbs-master-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--bbs-ink);
}

/* —— Công tắc trượt chung (dùng cho công tắc tổng, về sau nơi khác cũng có thể tái sử dụng) —— */
.bbs-toggle {
  flex: 0 0 auto;
  position: relative;
  width: 46px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-line-strong);
  cursor: pointer;
  transition: background var(--bbs-dur) var(--bbs-ease);
}
.bbs-toggle.is-on {
  background: var(--bbs-accent);
}
.bbs-toggle:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
}
.bbs-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bbs-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-toggle.is-on .bbs-toggle-knob {
  transform: translateX(20px);
}

/* —— Trí nhớ vector: mỗi vai trò mô hình một nhóm thẻ (hai cột kênh + tên mô hình) —— */
/* Thẻ điểm cuối vector (Embedding/Rerank/Query mỗi loại một khối, điền phẳng địa chỉ/khóa/mô hình) */
.bbs-vec-ep {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-disabled {
  opacity: 0.5;
}
/* Toàn bộ nhóm Tham số truy xuất / Bảo trì chỉ mục chuyển sang xám khi tắt trí nhớ vector */
.bbs-vec-recall.is-disabled {
  opacity: 0.5;
}
.bbs-vec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
/* Đầu thu gọn của thẻ điểm cuối: toàn bộ thanh tiêu đề có thể nhấn; khi thu gọn bỏ khoảng cách dưới, thẻ chỉ còn lại một dòng tiêu đề. */
.bbs-vec-toggle {
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--bbs-ink);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.bbs-vec-toggle:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 4px;
  border-radius: var(--bbs-radius-sm);
}
/* Đầu thu gọn không tự kèm khoảng cách dưới, chuyển sang do padding-top của body cung cấp thống nhất,
   như vậy khoảng cách từ tiêu đề ba khối tới dòng nội dung đầu tiên đồng nhất (không bị ảnh hưởng bởi việc có hay không có dòng gợi ý), khi thu gọn sẽ cùng grid về 0. */
.bbs-vec-toggle.bbs-vec-head {
  margin-bottom: 0;
}
.bbs-vec-ep-body {
  padding-top: 12px;
}
.bbs-vec-chevron {
  font-size: 18px;
  color: var(--bbs-ink-muted);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-collapsed .bbs-vec-chevron {
  transform: rotate(-90deg);
}
/* Hoạt ảnh mở rộng: sao chép nguyên grid 0fr<->1fr của Collapsible, nội dung tự thích ứng chiều cao, không cần đo đạc. */
.bbs-vec-ep-outer {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-collapsed .bbs-vec-ep-outer {
  grid-template-rows: 0fr;
}
/* Trạng thái mở rộng thả lỏng overflow, nếu không sẽ cắt mất menu thả xuống định vị tuyệt đối của combobox mô hình bên trong (sau khi kéo mô hình xong "nhấn không mở ra được");
   trong suốt thời gian hoạt ảnh thu gọn vẫn cần hidden để hé mở mượt mà —— dùng chuyển tiếp rời rạc trễ tới khi hoạt ảnh kết thúc (0.28s) mới chuyển sang visible, khi thu gọn thì lập tức quay về hidden.
   Trình duyệt cũ không hỗ trợ allow-discrete sẽ hạ cấp xuống chuyển đổi ngay lập tức: khoảnh khắc mở rộng nội dung hơi tràn nhẹ (khuyết điểm nhỏ), nhưng hộp thả xuống dùng được, không còn bị nhấn không mở ra. */
.bbs-vec-ep-inner {
  min-height: 0;
  overflow: visible;
  transition: overflow 0s var(--bbs-dur);
  transition-behavior: allow-discrete;
}
.bbs-vec-ep.is-collapsed .bbs-vec-ep-inner {
  overflow: hidden;
  transition-delay: 0s;
}
/* Nhãn loại backend vector: cùng kiểu với nhãn "Đại tóm tắt" của danh sách tóm tắt (lấp đầy đặc ruột, chữ trắng), backend = màu nhấn, hạ cấp cục bộ = màu cảnh báo */
.bbs-vec-backend {
  box-sizing: border-box;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 600;
  border-radius: var(--bbs-radius-sm);
  white-space: nowrap;
}
.bbs-vec-backend.is-backend {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
  border: 1px solid var(--bbs-accent);
}
.bbs-vec-backend.is-local {
  color: var(--bbs-accent-ink);
  background: var(--bbs-warning);
  border: 1px solid var(--bbs-warning);
}

/* —— Chi tiết lần truy xuất trước (bảng gỡ lỗi): biểu ngữ trạng thái + phân vùng bước + thẻ thanh điểm số —— */
.bbs-dbg {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Biểu ngữ trạng thái: chấm màu bên trái + văn bản + thời gian */
.bbs-dbg-banner {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  border-left: 3px solid var(--bbs-line-strong);
}
.bbs-dbg-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bbs-ink-muted);
}
.bbs-dbg-banner.is-ok {
  border-left-color: var(--bbs-accent);
}
.bbs-dbg-banner.is-ok .bbs-dbg-dot {
  background: var(--bbs-accent);
}
.bbs-dbg-banner.is-warn {
  border-left-color: var(--bbs-warning);
}
.bbs-dbg-banner.is-warn .bbs-dbg-dot {
  background: var(--bbs-warning);
}
.bbs-dbg-banner.is-fail {
  border-left-color: var(--bbs-danger);
}
.bbs-dbg-banner.is-fail .bbs-dbg-dot {
  background: var(--bbs-danger);
}
.bbs-dbg-banner.is-pending .bbs-dbg-dot {
  background: var(--bbs-ink-soft);
}
.bbs-dbg-status-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-dbg-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}

.bbs-dbg-empty {
  margin: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* Bảo trì chỉ mục: nút dựng lại / xóa sạch xếp cạnh nhau, trên màn hình hẹp tự động xuống dòng */
.bbs-vec-index-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}

/* Viết lại: tô sáng INTENT + danh sách Q */
.bbs-dbg-intent {
  display: flex;
  gap: 7px;
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-accent-soft);
  font-size: 12px;
  line-height: 1.6;
}
.bbs-dbg-intent-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-dbg-tag {
  flex: 0 0 auto;
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  font-family: var(--bbs-font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.3px;
}
.bbs-dbg-qlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbs-dbg-qitem {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--bbs-ink);
}
.bbs-dbg-qno {
  flex: 0 0 auto;
  min-width: 22px;
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--bbs-accent);
}
.bbs-dbg-qtext {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}

/* Danh sách thẻ kết quả trúng: cuộn trong chiều cao cố định, danh sách dài không làm vùng thu gọn bị kéo quá dài. */
.bbs-dbg-cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.bbs-dbg-card {
  padding: 8px 10px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
}
.bbs-dbg-card.is-dropped {
  opacity: 0.55;
}
.bbs-dbg-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
/* Huy hiệu nguồn Q */
.bbs-dbg-src {
  flex: 0 0 auto;
  min-width: 38px; /* Rộng bằng nhãn số tầng, Q một chữ số cũng không đến nỗi quá hẹp */
  text-align: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 700;
}
/* Đánh dấu nguồn: số tầng cuộc trò chuyện này (trung tính) / Bản lưu cũ (màu nhắc nhở có viền) */
.bbs-dbg-from {
  flex: 0 0 auto;
  min-width: 38px; /* Số tầng một chữ số (#5) cũng không đến nỗi quá hẹp, rộng ngang bằng về mặt thị giác với nhãn Q */
  text-align: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
}
.bbs-dbg-from.is-bundle {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
  border-color: transparent;
}
.bbs-dbg-when {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--bbs-ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbs-dbg-num {
  flex: 0 0 auto;
  margin-left: auto;
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--bbs-ink);
  font-variant-numeric: tabular-nums;
}
/* Thanh điểm số: rãnh mảnh + lấp đầy; mặc định màu nhấn, các mức rerank chia màu riêng */
.bbs-dbg-bar {
  height: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-line);
  overflow: hidden;
}
.bbs-dbg-bar > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--bbs-accent);
  transition: width var(--bbs-dur) var(--bbs-ease);
}
.bbs-dbg-bar.tier-brief > i {
  background: var(--bbs-ink-soft);
}
.bbs-dbg-bar.tier-drop > i {
  background: var(--bbs-ink-muted);
}
.bbs-dbg-prev {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--bbs-ink-muted);
  word-break: break-word;
}
/* Huy hiệu phân mức: Toàn văn (nền đặc màu nhấn) / Tóm tắt (trung tính) / Loại bỏ (viền nhạt màu) */
.bbs-dbg-tier {
  flex: 0 0 auto;
  min-width: 32px;
  text-align: center;
  padding: 1px 8px;
  border-radius: var(--bbs-radius-pill);
  font-size: 11px;
  font-weight: 700;
}
.bbs-dbg-tier.is-full {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
}
.bbs-dbg-tier.is-brief {
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
}
.bbs-dbg-tier.is-drop {
  color: var(--bbs-ink-muted);
  background: transparent;
  border: 1px solid var(--bbs-line);
}
/* Khung văn bản tiêm: phông đơn cách, giới hạn chiều cao có cuộn */
.bbs-dbg-pre {
  margin: 0;
  padding: 10px 12px;
  max-height: 320px;
  overflow: auto;
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--bbs-ink);
}

/* —— Danh sách lời nhắc tùy chỉnh —— */
.bbs-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* Cả dòng có thể nhấn để vào hộp thoại chỉnh sửa; bố cục tiếp tục dùng cảm giác nhìn của danh sách kênh (viền, hover hiện màu nhấn) */
.bbs-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
.bbs-prompt-open:hover {
  border-color: var(--bbs-accent);
  background: var(--bbs-surface);
}
.bbs-prompt-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
/* Viên nang trạng thái: mặc định muted, đã tùy chỉnh chuyển sang màu vàng nhấn */
.bbs-prompt-state {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
  color: var(--bbs-ink-muted);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line);
}
.bbs-prompt-state.is-custom {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border-color: transparent;
}
.bbs-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbs-ink-muted);
}
.bbs-prompt-open:hover .bbs-prompt-edit {
  color: var(--bbs-accent);
}

/* —— Hộp thoại lời nhắc: rộng hơn + khung văn bản lớn —— */
.bbs-modal-wide {
  max-width: 680px;
}
/* Thanh nhãn macro: có thể xuống dòng theo chiều ngang, nhấn mỗi macro sẽ chèn vào */
.bbs-macro-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.bbs-macro-tip {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  margin-right: 2px;
}
.bbs-macro {
  padding: 3px 9px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--bbs-dur) var(--bbs-ease), border-color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-macro:hover {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-prompt-area {
  resize: vertical;
  min-height: 240px;
  line-height: 1.6;
  font-family: var(--bbs-font-mono);
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* —— Thẻ làm sạch tùy chỉnh: ô nhập + nút thêm trên một dòng —— */
.bbs-striptag-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.bbs-striptag-bar .bbs-input {
  flex: 1;
  min-width: 0;
}
.bbs-striptag-bar .bbs-btn {
  flex: none;
}

/* —— Loại trừ nhân vật: các tên đã loại trừ trải phẳng dạng viên nang, nhấn × để đưa ra ngoài —— */
.bbs-exclude-chips {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.bbs-exclude-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 11px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-size: 12px;
  font-weight: 600;
}
.bbs-exclude-chip-name {
  word-break: break-word;
}
.bbs-exclude-chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.7;
}
.bbs-exclude-chip-x:hover {
  opacity: 1;
  background: oklch(0 0 0 / 0.08);
}

/* Danh sách tích chọn nhân vật trong hộp thoại: cuộn trong chiều cao cố định, danh sách dài không làm vỡ hộp thoại */
.bbs-exclude-list {
  max-height: 46vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0;
  padding-right: 2px;
}
.bbs-exclude-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: var(--bbs-radius-sm);
  cursor: pointer;
}
.bbs-exclude-row:hover {
  background: var(--bbs-surface-2);
}
.bbs-exclude-row-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-exclude-count {
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* ============ Di động: nội dung bên trong vùng thu gọn tổng thể thu nhỏ một cỡ, thống nhất nhịp điệu với tiêu đề màn hình hẹp ============ */
@media (max-width: 640px) {
  /* Bốn tham số kênh liên tiếp: trên màn hình hẹp một dòng bốn ô mỗi ô chỉ còn vài chục px, chuyển thành 2×2 */
  .bbs-channel-row {
    grid-template-columns: repeat(2, 1fr);
  }
  .bbs-field-label,
  .bbs-channel-item-name {
    font-size: 13px;
  }
  .bbs-prompt-name {
    font-size: 12px;
  }
  .bbs-field-hint,
  .bbs-channel-item-model {
    font-size: 11px;
  }
  .bbs-seg {
    font-size: 12px;
  }
  /* Đáy hộp thoại kênh: nút kiểm tra trên màn hình hẹp chỉ hiện bản ngắn "Kiểm tra", trên PC hiện đầy đủ "Kiểm tra kênh" */
  .bbs-btn-label-full {
    display: none;
  }
  .bbs-btn-label-short {
    display: inline;
  }
  .bbs-data-export {
    align-items: stretch;
    flex-direction: column;
  }
  .bbs-data-export .bbs-btn {
    justify-content: center;
    width: 100%;
  }
}
</style>
