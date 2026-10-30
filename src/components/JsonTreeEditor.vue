<script setup lang="ts">
/**
 * Trình chỉnh sửa cấu trúc JSON trực quan (đệ quy). Không cần gõ tay: nhấn chọn kiểu, điền giá trị, thêm/xóa trường.
 * Chỉ chỉnh sửa "cấu trúc và giá trị ban đầu" —— dùng cho mẫu ban đầu của biến số, hỗ trợ 5 loại: Đối tượng / Mảng / Văn bản / Số / Đúng-Sai, đủ bao phủ các cấu trúc như bảng thế lực.
 * Được điều khiển: modelValue đi vào, update:modelValue đi ra (mỗi lần thay đổi emit một đối tượng/mảng mới, cấp cha nắm giữ toàn bộ).
 *
 * Thiết kế: "giá trị" của vô hướng (scalar) và "chọn kiểu" của nó nằm cùng một dòng (không tách thành thực thể con đệ quy độc lập nữa —— đó chính là nguyên nhân gốc khiến bản cũ hiển thị nhầm công tắc đúng/sai);
 * chỉ có đối tượng/mảng mới đệ quy xuống dưới thành khối con thụt lề.
 */
import Icon from '@/components/Icon.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import type { JsonValue } from '@/memory/types';
import { computed } from 'vue';

const props = defineProps<{ modelValue: JsonValue }>();
const emit = defineEmits<{ 'update:modelValue': [JsonValue] }>();

type JType = 'object' | 'array' | 'string' | 'number' | 'boolean';
const TYPE_OPTS: { value: JType; label: string }[] = [
  { value: 'string', label: 'Văn bản' },
  { value: 'number', label: 'Số' },
  { value: 'boolean', label: 'Đúng/Sai' },
  { value: 'object', label: 'Đối tượng' },
  { value: 'array', label: 'Mảng' },
];

function typeOf(v: JsonValue): JType {
  if (Array.isArray(v)) return 'array';
  if (v !== null && typeof v === 'object') return 'object';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'string';
}
function isContainerVal(v: JsonValue): boolean {
  const t = typeOf(v);
  return t === 'object' || t === 'array';
}
function blankOf(t: JType): JsonValue {
  return t === 'object' ? {} : t === 'array' ? [] : t === 'number' ? 0 : t === 'boolean' ? false : '';
}

const rootType = computed<JType>(() => typeOf(props.modelValue));
const asObject = computed(() => (props.modelValue && typeof props.modelValue === 'object' && !Array.isArray(props.modelValue) ? (props.modelValue as Record<string, JsonValue>) : {}));
const objKeys = computed(() => Object.keys(asObject.value));
const asArray = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []));

/* —— Đối tượng: thêm/xóa/sửa khóa / sửa giá trị con —— */
function setObjChild(key: string, v: JsonValue) {
  emit('update:modelValue', { ...asObject.value, [key]: v });
}
function changeObjType(key: string, t: JType) {
  setObjChild(key, blankOf(t));
}
function renameKey(oldKey: string, ev: Event) {
  const newKey = (ev.target as HTMLInputElement).value.trim();
  if (!newKey || newKey === oldKey) return;
  const o: Record<string, JsonValue> = {}; // Dựng lại giữ nguyên thứ tự, tránh đổi tên bị nhảy xuống cuối
  for (const k of objKeys.value) o[k === oldKey ? newKey : k] = asObject.value[k];
  emit('update:modelValue', o);
}
function addObjField() {
  const o = { ...asObject.value };
  let name = 'Trường mới';
  let i = 2;
  while (name in o) name = `Trường mới ${i++}`;
  o[name] = '';
  emit('update:modelValue', o);
}
function removeObjKey(key: string) {
  const o = { ...asObject.value };
  delete o[key];
  emit('update:modelValue', o);
}

/* —— Mảng: thêm/xóa/sửa mục —— */
function setArrItem(idx: number, v: JsonValue) {
  const a = asArray.value.slice();
  a[idx] = v;
  emit('update:modelValue', a);
}
function changeArrType(idx: number, t: JType) {
  setArrItem(idx, blankOf(t));
}
function addArrItem() { emit('update:modelValue', [...asArray.value, '']); }
function removeArrItem(idx: number) {
  const a = asArray.value.slice();
  a.splice(idx, 1);
  emit('update:modelValue', a);
}

/* —— Lấy giá trị vô hướng: sự kiện nhập → giá trị chuẩn hóa —— */
function strVal(ev: Event): JsonValue { return (ev.target as HTMLInputElement).value; }
function numVal(ev: Event): JsonValue {
  const n = Number((ev.target as HTMLInputElement).value);
  return Number.isFinite(n) ? n : 0;
}
</script>

<template>
  <!-- Đối tượng: danh sách dòng trường -->
  <div v-if="rootType === 'object'" class="bbs-jte">
    <div v-for="k in objKeys" :key="k" class="bbs-jte-field">
      <div class="bbs-jte-row">
        <input class="bbs-input bbs-jte-key" type="text" :value="k" placeholder="Tên trường" @change="renameKey(k, $event)" />
        <BbsSelect
          class="bbs-jte-type"
          :model-value="typeOf(asObject[k])"
          :options="TYPE_OPTS"
          aria-label="Kiểu trường"
          @update:model-value="t => changeObjType(k, t)"
        />
        <!-- Giá trị vô hướng chỉnh sửa tại chỗ; nếu là vùng chứa thì dòng này chỉ để lại kiểu, giá trị nằm ở khối thụt lề bên dưới -->
        <input v-if="typeOf(asObject[k]) === 'string'" class="bbs-input bbs-jte-val" type="text" :value="asObject[k] as string" placeholder="Giá trị" @input="setObjChild(k, strVal($event))" />
        <input v-else-if="typeOf(asObject[k]) === 'number'" class="bbs-input bbs-jte-val" type="number" :value="asObject[k] as number" @input="setObjChild(k, numVal($event))" />
        <button v-else-if="typeOf(asObject[k]) === 'boolean'" class="bbs-jte-bool" :class="{ on: asObject[k] === true }" type="button" @click="setObjChild(k, asObject[k] !== true)">{{ asObject[k] === true ? 'Có' : 'Không' }}</button>
        <span v-else class="bbs-jte-containertag">{{ typeOf(asObject[k]) === 'array' ? 'Mảng' : 'Đối tượng' }}</span>
        <button class="bbs-jte-del" type="button" title="Xóa trường" @click="removeObjKey(k)"><Icon name="close" /></button>
      </div>
      <div v-if="isContainerVal(asObject[k])" class="bbs-jte-nest">
        <JsonTreeEditor :model-value="asObject[k]" @update:model-value="v => setObjChild(k, v)" />
      </div>
    </div>
    <button class="bbs-jte-add" type="button" @click="addObjField"><Icon name="plus" />Thêm trường</button>
  </div>

  <!-- Mảng: danh sách mục -->
  <div v-else-if="rootType === 'array'" class="bbs-jte">
    <div v-for="(item, idx) in asArray" :key="idx" class="bbs-jte-field">
      <div class="bbs-jte-row">
        <span class="bbs-jte-idx">#{{ idx }}</span>
        <BbsSelect
          class="bbs-jte-type"
          :model-value="typeOf(item)"
          :options="TYPE_OPTS"
          aria-label="Kiểu mục"
          @update:model-value="t => changeArrType(idx, t)"
        />
        <input v-if="typeOf(item) === 'string'" class="bbs-input bbs-jte-val" type="text" :value="item as string" placeholder="Giá trị" @input="setArrItem(idx, strVal($event))" />
        <input v-else-if="typeOf(item) === 'number'" class="bbs-input bbs-jte-val" type="number" :value="item as number" @input="setArrItem(idx, numVal($event))" />
        <button v-else-if="typeOf(item) === 'boolean'" class="bbs-jte-bool" :class="{ on: item === true }" type="button" @click="setArrItem(idx, item !== true)">{{ item === true ? 'Có' : 'Không' }}</button>
        <span v-else class="bbs-jte-containertag">{{ typeOf(item) === 'array' ? 'Mảng' : 'Đối tượng' }}</span>
        <button class="bbs-jte-del" type="button" title="Xóa mục" @click="removeArrItem(idx)"><Icon name="close" /></button>
      </div>
      <div v-if="isContainerVal(item)" class="bbs-jte-nest">
        <JsonTreeEditor :model-value="item" @update:model-value="v => setArrItem(idx, v)" />
      </div>
    </div>
    <button class="bbs-jte-add" type="button" @click="addArrItem"><Icon name="plus" />Thêm một mục</button>
  </div>
</template>

<style scoped>
.bbs-jte {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-jte-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbs-jte-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.bbs-jte-key {
  flex: 0 1 34%;
  min-width: 0;
  font-weight: 500;
}
.bbs-jte-idx {
  flex: 0 0 auto;
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  color: var(--bbs-ink-muted);
  min-width: 30px;
}
/* Chọn kiểu: hộp thả xuống tự vẽ (BbsSelect), hẹp hơn một nấc để phối hợp với dòng nhỏ gọn.
   Tên lớp rơi vào gốc component .bbs-select-box, kèm cấp cha để đè qua width:100% có sẵn của nó (cùng độ đặc hiệu sẽ phụ thuộc thứ tự đóng gói, không đáng tin) */
.bbs-jte-row .bbs-jte-type {
  flex: 0 0 auto;
  width: 74px;
}
.bbs-jte-type :deep(.bbs-select-trigger) {
  padding: 6px 8px;
  font-size: 12px;
}
.bbs-jte-val {
  flex: 1 1 auto;
  min-width: 0;
}
.bbs-jte-bool {
  flex: 1 1 auto;
  align-self: stretch;
  padding: 7px 16px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.bbs-jte-bool.on {
  background: var(--bbs-accent-soft);
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
/* Mục vùng chứa (đối tượng/mảng): vị trí giá trị dòng này chỉ ghi kiểu, nội dung thực sự nằm ở khối thụt lề bên dưới */
.bbs-jte-containertag {
  flex: 1 1 auto;
  font-size: 11px;
  color: var(--bbs-ink-muted);
  font-style: italic;
}
.bbs-jte-del {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  font-size: 13px;
}
.bbs-jte-del:hover {
  background: var(--bbs-danger-soft);
  color: var(--bbs-danger);
}
/* Khối con lồng nhau: đường kẻ mảnh bên trái + thụt lề, biểu đạt phân cấp phụ thuộc */
.bbs-jte-nest {
  margin-left: 6px;
  padding-left: 12px;
  border-left: 1px solid var(--bbs-line);
}
.bbs-jte-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border: 1px dashed var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  cursor: pointer;
}
.bbs-jte-add:hover {
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
</style>
