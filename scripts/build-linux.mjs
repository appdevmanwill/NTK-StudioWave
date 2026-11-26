import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const releaseBuildDir = path.join(rootDir, 'release-build');
const cacheDir = path.join(releaseBuildDir, 'linux-cache');
const linuxZip = path.join(cacheDir, 'electron-v45.4.1-linux-x64.zip');
const winAppAsar = path.join(releaseBuildDir, 'win-unpacked', 'resources', 'app.asar');
const iconPng = path.join(rootDir, 'build', 'icon.png');

if (!fs.existsSync(linuxZip)) {
  throw new Error(`Missing Linux Electron zip: ${linuxZip}`);
}
if (!fs.existsSync(winAppAsar)) {
  throw new Error(`Missing built app.asar: ${winAppAsar}`);
}
if (!fs.existsSync(iconPng)) {
  throw new Error(`Missing build/icon.png: ${iconPng}`);
}

function toWslPath(winPath) {
  const abs = path.resolve(winPath).replace(/\\/g, '/');
  const drive = abs[0].toLowerCase();
  return `/mnt/${drive}${abs.slice(2)}`;
}

const wslZip = toWslPath(linuxZip);
const wslAsar = toWslPath(winAppAsar);
const wslIcon = toWslPath(iconPng);
const wslOutDir = toWslPath(releaseBuildDir);

const bashScript = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'WORK="/tmp/ntk-studiowave-linux-build"',
  'rm -rf "$WORK"',
  'mkdir -p "$WORK/app" "$WORK/deb/DEBIAN" "$WORK/deb/opt/ntk-studiowave" "$WORK/deb/usr/bin" "$WORK/deb/usr/share/applications" "$WORK/deb/usr/share/icons/hicolor/512x512/apps"',
  '',
  'python3 - <<\'PY\'',
  'import os, zipfile',
  `zpath = ${JSON.stringify(wslZip)}`,
  'out = "/tmp/ntk-studiowave-linux-build/app"',
  'with zipfile.ZipFile(zpath, "r") as zf:',
  '    for info in zf.infolist():',
  '        target = os.path.join(out, info.filename)',
  '        if info.is_dir():',
  '            os.makedirs(target, exist_ok=True)',
  '            continue',
  '        os.makedirs(os.path.dirname(target), exist_ok=True)',
  '        is_symlink = ((info.external_attr >> 16) & 0o170000) == 0o120000',
  '        if is_symlink:',
  '            link_target = zf.read(info).decode("utf-8")',
  '            if os.path.lexists(target):',
  '                os.unlink(target)',
  '            os.symlink(link_target, target)',
  '        else:',
  '            with zf.open(info) as src, open(target, "wb") as dst:',
  '                dst.write(src.read())',
  '            perm = (info.external_attr >> 16) & 0o777',
  '            if perm:',
  '                os.chmod(target, perm)',
  'PY',
  '',
  'mv "$WORK/app/electron" "$WORK/app/NTK-StudioWave"',
  'rm -f "$WORK/app/resources/default_app.asar"',
  `cp ${JSON.stringify(wslAsar)} "$WORK/app/resources/app.asar"`,
  `cp ${JSON.stringify(wslIcon)} "$WORK/app/NTK-StudioWave.png"`,
  '',
  'cat > "$WORK/app/Run-NTK-StudioWave.sh" <<\'SH\'',
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
  'exec "$DIR/NTK-StudioWave" --no-sandbox "$@"',
  'SH',
  '',
  'cat > "$WORK/app/Install-Desktop-Shortcut.sh" <<\'SH\'',
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
  'APP_DIR="$HOME/.local/share/applications"',
  'ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"',
  'mkdir -p "$APP_DIR" "$ICON_DIR"',
  'cp "$DIR/NTK-StudioWave.png" "$ICON_DIR/ntk-studiowave.png"',
  'cat > "$APP_DIR/ntk-studiowave.desktop" <<EOF',
  '[Desktop Entry]',
  'Name=NTK StudioWave',
  'Comment=100% Offline Studio Audio Recorder, Smart Editor & Exporter',
  'Exec="$DIR/Run-NTK-StudioWave.sh" %U',
  'Icon=ntk-studiowave',
  'Terminal=false',
  'Type=Application',
  'Categories=AudioVideo;Audio;Recorder;',
  'EOF',
  'chmod +x "$APP_DIR/ntk-studiowave.desktop"',
  'echo "Desktop shortcut installed! Find NTK StudioWave in your app menu."',
  'SH',
  '',
  'chmod 0755 "$WORK/app/NTK-StudioWave" "$WORK/app/chrome_crashpad_handler" "$WORK/app/Run-NTK-StudioWave.sh" "$WORK/app/Install-Desktop-Shortcut.sh"',
  'if [ -f "$WORK/app/chrome-sandbox" ]; then',
  '  chmod 4755 "$WORK/app/chrome-sandbox" || chmod 0755 "$WORK/app/chrome-sandbox"',
  'fi',
  '',
  'mkdir -p "$WORK/tarstage/NTK-StudioWave-Linux"',
  'cp -a "$WORK/app/." "$WORK/tarstage/NTK-StudioWave-Linux/"',
  `tar -C "$WORK/tarstage" -czf ${JSON.stringify(wslOutDir)}/NTK-StudioWave-1.0.0-linux-x64.tar.gz NTK-StudioWave-Linux`,
  '',
  'cp -a "$WORK/app/." "$WORK/deb/opt/ntk-studiowave/"',
  `cp ${JSON.stringify(wslIcon)} "$WORK/deb/usr/share/icons/hicolor/512x512/apps/ntk-studiowave.png"`,
  'cat > "$WORK/deb/usr/bin/ntk-studiowave" <<\'BIN\'',
  '#!/usr/bin/env sh',
  'exec /opt/ntk-studiowave/NTK-StudioWave --no-sandbox "$@"',
  'BIN',
  'chmod 0755 "$WORK/deb/usr/bin/ntk-studiowave"',
  '',
  'cat > "$WORK/deb/usr/share/applications/ntk-studiowave.desktop" <<\'DESK\'',
  '[Desktop Entry]',
  'Name=NTK StudioWave',
  'Comment=100% Offline Studio Audio Recorder, Smart Editor & Exporter',
  'Exec=/usr/bin/ntk-studiowave %U',
  'Icon=ntk-studiowave',
  'Terminal=false',
  'Type=Application',
  'Categories=AudioVideo;Audio;Recorder;',
  'DESK',
  '',
  'INSTALLED_KB=$(du -sk "$WORK/deb/opt/ntk-studiowave" | awk \'{print $1}\')',
  'cat > "$WORK/deb/DEBIAN/control" <<CTRL',
  'Package: ntk-studiowave',
  'Version: 1.0.0',
  'Section: sound',
  'Priority: optional',
  'Architecture: amd64',
  'Installed-Size: $INSTALLED_KB',
  'Maintainer: NTK Group <support@ntk.local>',
  'Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libasound2 | libasound2t64, libgbm1, libxss1',
  'Description: Offline Studio Audio Recorder, Smart Editor & Exporter',
  ' 100% offline studio-grade audio recorder, smart noise cleaner, editor,',
  ' and universal exporter with zero internet dependencies.',
  'CTRL',
  '',
  `fakeroot dpkg-deb --build "$WORK/deb" ${JSON.stringify(wslOutDir)}/NTK-StudioWave-1.0.0-amd64.deb`,
  'rm -rf "$WORK"',
  'echo "LINUX PACKAGES BUILT SUCCESSFULLY"',
].join('\n') + '\n';

const shWinPath = path.join(cacheDir, 'build-linux.sh');
fs.writeFileSync(shWinPath, bashScript, 'utf8');

console.log('Building Linux .tar.gz and .deb via WSL Ubuntu...');
execFileSync('wsl', ['-d', 'Ubuntu', '--', 'bash', toWslPath(shWinPath)], {
  stdio: 'inherit',
});
