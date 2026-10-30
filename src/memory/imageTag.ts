const BAI_BAI_IMAGE_TAG = /(?:\r\n|\n|\r)?<bbi_image\b[^>]*>[\s\S]*?<\/bbi_image>/gi;

/** Xóa thẻ tạo ảnh Bách Bảo Hội; thẻ đứng riêng một dòng thì xóa luôn dấu xuống dòng phía trước, khôi phục dấu xuống dòng chính văn trước khi chèn. */
export function stripBaiBaiImageTags(mes: string): string {
  return String(mes ?? '').replace(BAI_BAI_IMAGE_TAG, '');
}
