import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const distDir = path.join(rootDir, 'dist');
const serverBundle = path.join(rootDir, 'dist-server', 'server.cjs');
const outDir = path.join(rootDir, 'DEPLOY_MANUAL', 'NTK-StudioWave-Offline');

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('Missing dist/index.html. Run `npm run build` first.');
  process.exit(1);
}
if (!fs.existsSync(serverBundle)) {
  console.error('Missing dist-server/server.cjs. Run `npm run build` first.');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

fs.cpSync(distDir, path.join(outDir, 'dist'), { recursive: true, force: true });
fs.copyFileSync(serverBundle, path.join(outDir, 'server.cjs'));

const envExample = path.join(rootDir, '.env.example');
if (fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, path.join(outDir, '.env.example'));
}

fs.writeFileSync(
  path.join(outDir, 'Start-NTK-StudioWave.bat'),
  `@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ was not found on PATH. Please install Node.js once, or host the "dist" folder on any local web server.
  pause
  exit /b 1
)
if "%PORT%"=="" set PORT=3000
echo Starting NTK StudioWave (100%% Offline / Zero-API-Key Mode) on http://localhost:%PORT%
start "" http://localhost:%PORT%
node server.cjs --production
pause
`,
  'utf8'
);

const shPath = path.join(outDir, 'start-ntk-studiowave.sh');
fs.writeFileSync(
  shPath,
  `#!/usr/bin/env sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$DIR"
PORT="\${PORT:-3000}"
export PORT
echo "Starting NTK StudioWave (100% Offline / Zero-API-Key Mode) on http://localhost:$PORT"
exec node server.cjs --production
`,
  'utf8'
);
try {
  fs.chmodSync(shPath, 0o755);
} catch {
  // Windows ignores chmod
}

fs.writeFileSync(
  path.join(outDir, 'README-OFFLINE.txt'),
  `NTK StudioWave — Self-Contained Offline Package
=================================================

This folder runs 100% offline with ZERO internet connection, ZERO node_modules,
and ZERO API keys required.

1. PC (Windows):
   Double-click Start-NTK-StudioWave.bat
   (Or run: node server.cjs --production)

2. macOS / Linux:
   ./start-ntk-studiowave.sh

3. Mobile Phones & Tablets (No Internet Needed):
   While Start-NTK-StudioWave is running on a PC, open the printed Local Wi-Fi URL
   (for example http://192.168.x.x:3000) in Chrome or Safari on your phone,
   then tap Install / Add to Home Screen. Once installed, it continues working
   completely offline even if disconnected from Wi-Fi.

4. Pure Static Hosting (No Node Required):
   Serve the "dist" folder from any local static web server or Electron/Tauri shell.
   All recording, 7-band Live EQ, noise reduction, pitch/speed edits, steady
   normalization, multi-track mixing, waveform trimming, 4-track rule-based stem
   splitting, flags, and WAV/MP3/FLAC/ZIP export run 100% locally in the browser.
`,
  'utf8'
);

console.log(`Built self-contained offline package at: ${outDir}`);
