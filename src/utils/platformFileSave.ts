export interface PlatformSaveResult {
  saved: boolean;
  location?: string;
  method: 'android' | 'electron' | 'web';
}

interface NtkDesktopBridge {
  isElectron: boolean;
  platform: string;
  saveFile?: (payload: {
    filename: string;
    mimeType: string;
    dataBase64: string;
  }) => Promise<{ saved: boolean; path?: string; canceled?: boolean }>;
  openDownloadsFolder?: () => Promise<void>;
  setTheme?: (preference: 'system' | 'light' | 'dark', isDark: boolean) => void;
}

interface StudioWaveNativePlugin {
  saveFile?: (opts: {
    filename: string;
    mimeType: string;
    base64Data: string;
  }) => Promise<{ saved: boolean; location?: string }>;
  shareFile?: (opts: {
    filename: string;
    mimeType: string;
    base64Data: string;
    title?: string;
  }) => Promise<{ shared: boolean }>;
  setSystemBarTheme?: (opts: { isDark: boolean; backgroundColor: string }) => Promise<void>;
  setKeepScreenOn?: (opts: { enabled: boolean }) => Promise<void>;
  exitApp?: () => Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    StudioWaveNative?: StudioWaveNativePlugin;
  };
}

function getDesktopBridge(): NtkDesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { ntkDesktop?: NtkDesktopBridge }).ntkDesktop;
}

function getCapacitorGlobal(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function isElectronDesktop(): boolean {
  return Boolean(getDesktopBridge()?.isElectron);
}

export function isAndroidNative(): boolean {
  const cap = getCapacitorGlobal();
  if (!cap) return false;
  if (typeof cap.isNativePlatform === 'function') {
    return cap.isNativePlatform() && (typeof cap.getPlatform !== 'function' || cap.getPlatform() === 'android');
  }
  return Boolean(cap.Plugins?.StudioWaveNative);
}

export function isNativeApp(): boolean {
  return isElectronDesktop() || isAndroidNative();
}

export function sanitizeFilename(name: string, fallback = 'NTK-StudioWave-Audio.wav'): string {
  const trimmed = (name || '').trim();
  const base = trimmed || fallback;
  const cleaned = base
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '');
  return cleaned.slice(0, 140) || fallback;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    let chunkStr = '';
    for (let j = 0; j < slice.length; j++) {
      chunkStr += String.fromCharCode(slice[j]);
    }
    parts.push(chunkStr);
  }
  return btoa(parts.join(''));
}

function triggerWebAnchorDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

export async function saveBlobToDevice(
  blob: Blob,
  filename: string
): Promise<PlatformSaveResult> {
  const safeName = sanitizeFilename(filename);
  const mimeType = blob.type || 'application/octet-stream';

  const cap = getCapacitorGlobal();
  const nativePlugin = cap?.Plugins?.StudioWaveNative;
  if (isAndroidNative() && nativePlugin?.saveFile) {
    try {
      const base64Data = await blobToBase64(blob);
      const res = await nativePlugin.saveFile({
        filename: safeName,
        mimeType,
        base64Data,
      });
      if (res?.saved) {
        return {
          saved: true,
          location: res.location || `Downloads/NTK-StudioWave/${safeName}`,
          method: 'android',
        };
      }
    } catch {
      // Fall through to web download fallback if native bridge rejects
    }
  }

  const desktop = getDesktopBridge();
  if (desktop?.isElectron && desktop.saveFile) {
    try {
      const dataBase64 = await blobToBase64(blob);
      const res = await desktop.saveFile({
        filename: safeName,
        mimeType,
        dataBase64,
      });
      if (res?.saved) {
        return {
          saved: true,
          location: res.path || `Downloads/NTK-StudioWave/${safeName}`,
          method: 'electron',
        };
      }
      if (res?.canceled) {
        return { saved: false, method: 'electron' };
      }
    } catch {
      // Fall through to Electron will-download anchor fallback
    }
  }

  triggerWebAnchorDownload(blob, safeName);
  return { saved: true, method: desktop?.isElectron ? 'electron' : 'web' };
}

export async function shareBlobFromDevice(
  blob: Blob,
  filename: string,
  title = 'NTK StudioWave Audio'
): Promise<boolean> {
  const safeName = sanitizeFilename(filename);
  const mimeType = blob.type || 'application/octet-stream';

  const nativePlugin = getCapacitorGlobal()?.Plugins?.StudioWaveNative;
  if (isAndroidNative() && nativePlugin?.shareFile) {
    try {
      const base64Data = await blobToBase64(blob);
      const res = await nativePlugin.shareFile({
        filename: safeName,
        mimeType,
        base64Data,
        title,
      });
      if (res?.shared) return true;
    } catch {
      // Fall through to Web Share or file save
    }
  }

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      const file = new File([blob], safeName, { type: mimeType });
      const navWithCanShare = navigator as Navigator & {
        canShare?: (data: ShareData) => boolean;
      };
      if (!navWithCanShare.canShare || navWithCanShare.canShare({ files: [file] })) {
        await navigator.share({ title, files: [file] });
        return true;
      }
    } catch {
      // User cancelled or file sharing unsupported
    }
  }

  const fallback = await saveBlobToDevice(blob, safeName);
  return fallback.saved;
}

export function syncNativeSystemTheme(
  isDark: boolean,
  preference: 'system' | 'light' | 'dark'
): void {
  const desktop = getDesktopBridge();
  if (desktop?.setTheme) {
    try {
      desktop.setTheme(preference, isDark);
    } catch {
      // ignore
    }
  }

  const nativePlugin = getCapacitorGlobal()?.Plugins?.StudioWaveNative;
  if (isAndroidNative() && nativePlugin?.setSystemBarTheme) {
    nativePlugin
      .setSystemBarTheme({
        isDark,
        backgroundColor: isDark ? '#0B0E14' : '#F7F8FA',
      })
      .catch(() => undefined);
  }
}

export function setNativeKeepScreenOn(enabled: boolean): void {
  const nativePlugin = getCapacitorGlobal()?.Plugins?.StudioWaveNative;
  if (isAndroidNative() && nativePlugin?.setKeepScreenOn) {
    nativePlugin.setKeepScreenOn({ enabled }).catch(() => undefined);
  }
}

export function exitAndroidApp(): void {
  const nativePlugin = getCapacitorGlobal()?.Plugins?.StudioWaveNative;
  if (isAndroidNative() && nativePlugin?.exitApp) {
    nativePlugin.exitApp().catch(() => undefined);
  }
}

export function openDesktopDownloadsFolder(): void {
  const desktop = getDesktopBridge();
  if (desktop?.openDownloadsFolder) {
    desktop.openDownloadsFolder().catch(() => undefined);
  }
}
