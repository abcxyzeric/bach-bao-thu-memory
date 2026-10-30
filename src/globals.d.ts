import type { STBaiBaiBookApi } from '@/public/types';

declare global {
  // ST đã gắn kết các phụ thuộc này ở toàn cục, ở đây chỉ khai báo kiểu tối thiểu mà plugin thực tế sử dụng đến.
  const $: any;
  const _: any;
  const toastr: any;
  const __BBS_VERSION__: string;
  var STBaiBaiBook: STBaiBaiBookApi | undefined;
}

export {};
