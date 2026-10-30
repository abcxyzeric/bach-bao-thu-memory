<script setup lang="ts">
/**
 * Vỏ lớp phủ hộp thoại: thống nhất đảm nhận lớp .bbs-modal-mask của hộp thoại các trang + nhấn lớp phủ để đóng.
 *
 * Teleport tới modalHost (con trực tiếp của .bbs-root, nằm ngoài vùng chứa cuộn .bbs-body):
 * Sửa lỗi cố hữu trên iOS Safari —— "hậu duệ position:fixed bên trong tổ tiên có thể cuộn" sẽ định vị tương đối theo nội dung cuộn
 * thay vì khung nhìn, dẫn tới sau khi trang cài đặt cuộn thì hộp thoại bị lệch hẳn lên trên, vọt ra khỏi màn hình (hộp thoại kênh lộ ra đầu tiên).
 * Chủ thể vẫn nằm trong shadow root, kiểu dáng scoped và biến giao diện --bbs-* vẫn có hiệu lực như thường,
 * do đó đích to là phần tử trong shadow, chứ không phải Teleport to="body" sẽ thoát ra ngoài shadow.
 *
 * Nội dung được đưa vào qua <slot>, đánh dấu data-v của scoped được giữ lại theo, kiểu dáng lớp độc lập của hộp thoại các trang không bị Teleport ảnh hưởng.
 *
 * Ẩn hiện dùng prop open (thay vì phía gọi viết v-if trên <ModalMask>): vùng chứa Transition phải thường trực, do v-if bên trong
 * chuyển đổi hộp thoại thì hoạt ảnh rời đi mới phát được (nếu không component bị gỡ cùng v-if cha, leave không kịp kích hoạt).
 * slot là hàm lười (lazy), khi open=false sẽ không đi tới <slot/>, không tính giá trị, nên trong slot có tham chiếu tới đối tượng biến thành null
 * sau khi đóng (như editingChannel.name) cũng sẽ không báo lỗi —— không cần thêm chốt chặn ở từng điểm gọi.
 */
import { modalHost } from '@/state/ui';

defineProps<{
  /** Hộp thoại có hiển thị hay không */
  open?: boolean;
  /** Chồng lên trên các hộp thoại khác (z-index cao hơn), ví dụ mở thêm xác nhận xóa bên trong hộp thoại kênh */
  topLayer?: boolean;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <!-- Khi modalHost chưa sẵn sàng thì kết xuất tại chỗ để dự phòng, tuyệt đối không làm mất hộp thoại -->
  <Teleport :to="modalHost" :disabled="!modalHost">
    <Transition name="bbs-modal">
      <div
        v-if="open"
        class="bbs-modal-mask"
        :class="{ 'bbs-modal-mask-top': topLayer }"
        @mousedown.self="emit('close')"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Lớp chồng: đè lên trên hộp thoại thường (ngang cấp với -top của ConfirmDialog) */
.bbs-modal-mask-top {
  z-index: 10002;
}
</style>
