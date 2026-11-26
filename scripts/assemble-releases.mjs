import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const releaseBuildDir = path.join(rootDir, 'release-build');
const outRoot = path.join(rootDir, 'DEPLOY_MANUAL', 'NTK-StudioWave-Releases');
const apkSource = path.join(
  rootDir,
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'release',
  'app-release.apk'
);

const folders = {
  winInstaller: path.join(outRoot, '01-Windows-Installer'),
  winPortable: path.join(outRoot, '02-Windows-Portable'),
  linux: path.join(outRoot, '03-Linux'),
  android: path.join(outRoot, '04-Android-APK'),
};

fs.rmSync(outRoot, { recursive: true, force: true });
for (const dir of Object.values(folders)) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyRequired(src, destDir, destName) {
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required release artifact: ${src}`);
  }
  const dest = path.join(destDir, destName || path.basename(src));
  fs.copyFileSync(src, dest);
  return dest;
}

function copyIfExists(src, destDir, destName) {
  if (!fs.existsSync(src)) return null;
  const dest = path.join(destDir, destName || path.basename(src));
  fs.copyFileSync(src, dest);
  return dest;
}

const winInstaller = copyRequired(
  path.join(releaseBuildDir, 'NTK-StudioWave-Setup-1.0.0.exe'),
  folders.winInstaller,
  'NTK-StudioWave-Setup-1.0.0.exe'
);

const winPortable = copyRequired(
  path.join(releaseBuildDir, 'NTK-StudioWave-Portable-1.0.0.exe'),
  folders.winPortable,
  'NTK-StudioWave-Portable-1.0.0.exe'
);

const linuxFiles = [];
for (const candidate of [
  'NTK-StudioWave-1.0.0-linux-x64.tar.gz',
  'NTK-StudioWave-1.0.0-amd64.deb',
  'NTK-StudioWave-1.0.0-x86_64.AppImage',
]) {
  const copied = copyIfExists(path.join(releaseBuildDir, candidate), folders.linux, candidate);
  if (copied) linuxFiles.push(path.basename(copied));
}
if (linuxFiles.length === 0) {
  throw new Error('No Linux release artifacts were found in release-build/.');
}

const androidApk = copyRequired(
  apkSource,
  folders.android,
  'NTK-StudioWave-v1.0.0-Android-8-to-16.apk'
);

fs.writeFileSync(
  path.join(outRoot, 'START-HERE-README.txt'),
  `NTK StudioWave v1.0.0 — Ready-to-Use Offline App Releases
=========================================================

Pick the folder that matches your device. Every file here includes everything
NTK StudioWave needs to run without an internet connection.

FOLDER GUIDE:
1. 01-Windows-Installer
   Install NTK StudioWave permanently on Windows 10 or Windows 11 with a Desktop
   and Start Menu shortcut.

2. 02-Windows-Portable
   Run NTK StudioWave directly from a USB drive or any folder on Windows.
   No installation needed.

3. 03-Linux
   Self-contained Linux x64 app (${linuxFiles.join(', ')}).

4. 04-Android-APK
   Installable Android app package for Android 8.0 through Android 16 phones
   and tablets.

WHERE YOUR SAVED AUDIO GOES:
- Windows & Linux: Downloads\\NTK-StudioWave (or ~/Downloads/NTK-StudioWave)
- Android:         Internal Storage > Downloads > NTK-StudioWave

100% OFFLINE:
Recording, live noise reduction, 7-band EQ, silence cutting, pitch/speed edits,
4-track stem mixing, and MP3/WAV/FLAC/ZIP export run locally on your device.
`,
  'utf8'
);

fs.writeFileSync(
  path.join(folders.winInstaller, 'HOW-TO-INSTALL-WINDOWS.txt'),
  `HOW TO INSTALL NTK STUDIOWAVE ON WINDOWS
========================================

1. Double-click NTK-StudioWave-Setup-1.0.0.exe.
2. If Windows SmartScreen asks to confirm, click "More info" then "Run anyway".
3. Follow the installer steps (no administrator password required).
4. Launch "NTK StudioWave" from your Desktop or Start Menu.

Note: You do not need an internet connection to install or use this app.
Saved recordings go to: Downloads\\NTK-StudioWave
`,
  'utf8'
);

fs.writeFileSync(
  path.join(folders.winPortable, 'HOW-TO-RUN-PORTABLE.txt'),
  `HOW TO RUN NTK STUDIOWAVE PORTABLE ON WINDOWS
=============================================

1. Copy NTK-StudioWave-Portable-1.0.0.exe to any folder or USB flash drive.
2. Double-click NTK-StudioWave-Portable-1.0.0.exe to launch immediately.
3. If Windows SmartScreen prompts, click "More info" then "Run anyway".

No installation or internet connection is required.
Saved recordings go to: Downloads\\NTK-StudioWave
`,
  'utf8'
);

fs.writeFileSync(
  path.join(folders.linux, 'HOW-TO-RUN-LINUX.txt'),
  `HOW TO RUN NTK STUDIOWAVE ON LINUX (64-bit x86_64)
==================================================

Included package(s): ${linuxFiles.join(', ')}

Option A — Debian / Ubuntu (.deb installer, if included):
  sudo apt install ./NTK-StudioWave-1.0.0-amd64.deb
  Then open "NTK StudioWave" from your application menu or run: ntk-studiowave

Option B — Portable Archive (.tar.gz):
  1. Extract NTK-StudioWave-1.0.0-linux-x64.tar.gz:
       tar -xzf NTK-StudioWave-1.0.0-linux-x64.tar.gz
  2. Open the extracted folder and run:
       ./Run-NTK-StudioWave.sh
  3. Optional: add an app menu icon by running:
       ./Install-Desktop-Shortcut.sh

Option C — AppImage (if included):
  chmod +x NTK-StudioWave-1.0.0-x86_64.AppImage
  ./NTK-StudioWave-1.0.0-x86_64.AppImage

No internet connection or extra dependencies are required.
Saved recordings go to: ~/Downloads/NTK-StudioWave
`,
  'utf8'
);

fs.writeFileSync(
  path.join(folders.android, 'HOW-TO-INSTALL-ANDROID.txt'),
  `HOW TO INSTALL NTK STUDIOWAVE ON ANDROID (Android 8.0 to Android 16)
====================================================================

1. Copy NTK-StudioWave-v1.0.0-Android-8-to-16.apk to your Android phone or tablet.
2. Open your phone's Files app and tap NTK-StudioWave-v1.0.0-Android-8-to-16.apk.
3. If Android asks permission to install from this source, tap Settings -> Allow
   from this source, then tap Install.
4. Open NTK StudioWave and allow Microphone access when prompted to record.

Compatibility: Android 8.0 (API 26) through Android 16 (API 36).
Offline ready: Works with airplane mode on and zero internet connection.
Saved recordings go to: Files -> Downloads -> NTK-StudioWave
`,
  'utf8'
);

console.log('Assembled novice-friendly release folders at:', outRoot);
console.log(' - Windows Installer:', path.basename(winInstaller));
console.log(' - Windows Portable: ', path.basename(winPortable));
console.log(' - Linux:            ', linuxFiles.join(', '));
console.log(' - Android APK:      ', path.basename(androidApk));
