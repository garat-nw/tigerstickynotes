import { defineConfig } from 'vite';
// Tauri expects a fixed dev port; TAURI_DEV_HOST is set when running on a real iOS/Android device.
const host = process.env.TAURI_DEV_HOST;
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: host || false, hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined },
  build: { target: 'safari15', outDir: 'dist' },
});
