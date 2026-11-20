import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Вся программа собирается в один файл dist/index.html (код и стили внутри).
// Так его можно открыть двойным щелчком с флешки, без сервера и интернета:
// браузер не загружает отдельные JS-модули со страницы, открытой как file://.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { environment: 'node' },
} as any);
