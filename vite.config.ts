import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Trình duyệt tải từ /scripts/extensions/third-party/ST-BaiBai-Book/dist/index.js,
// khi muốn import module của ST chủ thì cần tính ra đường dẫn tương đối từ dist/ quay về gốc public/ của ST.
// `@sillytavern/scripts/xxx` -> `../../../../../scripts/xxx.js`, đồng thời đánh dấu là external,
// như vậy code của bản thân ST sẽ không bị đóng gói vào gói của chúng ta, lúc chạy trình duyệt sẽ đi thẳng theo đường dẫn tương đối.
const relative_sillytavern_path = path.relative(
  path.join(__dirname, 'dist'),
  __dirname.substring(0, __dirname.lastIndexOf('public') + 'public'.length),
);

// Các thư viện bên thứ ba mà ST đã gắn ở toàn cục, ánh xạ sang biến toàn cục để tránh đóng gói trùng lặp.
const globals: Record<string, string> = {
  jquery: '$',
  lodash: '_',
  toastr: 'toastr',
};

const package_json = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as {
  version?: string;
};
const package_version = String(package_json.version ?? '');

export default defineConfig(({ mode }) => ({
  define: {
    __BBS_VERSION__: JSON.stringify(package_version),
  },

  plugins: [
    vue(),
    {
      name: 'sillytavern-resolver',
      enforce: 'pre',
      resolveId(id) {
        if (id.startsWith('@sillytavern/')) {
          return {
            id:
              path
                .join(relative_sillytavern_path, id.replace('@sillytavern/', ''))
                .replaceAll('\\', '/') + '.js',
            external: true,
          };
        }
        if (id in globals) {
          return { id, external: true };
        }
      },
    },
  ],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  test: {
    // Chỉ chạy kiểm thử của dự án này: trong .pnpm-store ở thư mục gốc (kho ảo cục bộ, gitignore) có lưu
    // mã nguồn của các dự án workspace khác, glob mặc định sẽ quét vào gây ra lỗi thất bại không liên quan.
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', '.pnpm-store/**'],
  },

  build: {
    rollupOptions: {
      input: 'src/index.ts',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].[hash].chunk.js',
        assetFileNames: '[name].[ext]',
        globals,
      },
      external: id => id in globals,
    },
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: mode === 'production' ? true : 'inline',
    minify: mode === 'production',
    target: 'esnext',
  },
}));
