import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function collectDistFiles(rootDir: string, current = rootDir): string[] {
  const entries = fs.readdirSync(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectDistFiles(rootDir, full));
    } else if (entry.isFile()) {
      const rel = path.relative(rootDir, full).replace(/\\/g, '/');
      if (rel === 'sw.js' || rel.endsWith('.map')) continue;
      files.push('/' + rel);
    }
  }
  return files;
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      // Copies src/assets into dist/ so root-relative URLs still resolve in production builds.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) return;
          const distDir = path.resolve(currentDir, 'dist');
          const srcAssets = path.resolve(currentDir, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, { recursive: true, force: true });
          }
        },
      },
      // Injects every built JS, CSS, font (.woff2), icon, and manifest URL into dist/sw.js
      // so a brand-new device caches the entire app offline on day 1 with zero internet dependencies.
      {
        name: 'inject-offline-sw-precache',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) return;
          const distDir = path.resolve(currentDir, 'dist');
          const swFile = path.join(distDir, 'sw.js');
          if (!fs.existsSync(distDir) || !fs.existsSync(swFile)) return;

          const assetList = Array.from(new Set(['/', ...collectDistFiles(distDir)])).sort();
          const hash = crypto
            .createHash('sha256')
            .update(assetList.join('\n'))
            .digest('hex')
            .slice(0, 12);
          const cacheName = `ntk-studiowave-offline-${hash}`;

          let swSource = fs.readFileSync(swFile, 'utf8');
          swSource = swSource.replace(
            /\/\* __CACHE_NAME__ \*\/ [^;]+;/,
            `/* __CACHE_NAME__ */ ${JSON.stringify(cacheName)};`
          );
          swSource = swSource.replace(
            /\/\* __PRECACHE_MANIFEST__ \*\/ \[[\s\S]*?\];/,
            `/* __PRECACHE_MANIFEST__ */ ${JSON.stringify(assetList, null, 2)};`
          );
          fs.writeFileSync(swFile, swSource, 'utf8');
        },
      },
    ],
    build: {
      target: ['es2020', 'chrome80', 'safari14'],
    },
    resolve: {
      alias: {
        '@': path.resolve(currentDir, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
