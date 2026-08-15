import { defineConfig } from 'vitest/config';

// Library-mode build producing a single, unhashed ES module bundle at
// dist/simpler-camera-card.js. `lit` is bundled in (no externals) so the
// card works as a drop-in HACS/`/local/` file with no separate dependency
// resolution on the HA frontend.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'simpler-camera-card.js',
    },
    rollupOptions: {
      // No externals: lit is bundled into the single output file.
      output: {
        // Keep the bundle to exactly one JS file (plus sourcemap) — no
        // chunking, no separate CSS asset.
        codeSplitting: false,
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
    emptyOutDir: true,
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
  },
});
