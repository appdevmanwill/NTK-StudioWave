const {
  app,
  BrowserWindow,
  Menu,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
} = require('electron');
const fs = require('fs');
const path = require('path');

app.setName('NTK StudioWave');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let serverHandle = null;

function getDownloadsTargetDir() {
  const dir = path.join(app.getPath('downloads'), 'NTK-StudioWave');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeName(name) {
  const base = path.basename((name || 'NTK-StudioWave-Audio.wav').trim());
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '');
  return cleaned || 'NTK-StudioWave-Audio.wav';
}

function resolveUniqueFilePath(dir, filename) {
  const safe = sanitizeName(filename);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = path.join(dir, safe);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}_${counter}${ext}`);
    counter++;
  }
  return candidate;
}

function buildAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Saved Audio Folder',
          click: () => {
            const dir = getDownloadsTargetDir();
            shell.openPath(dir).catch(() => undefined);
          },
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit NTK StudioWave' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About NTK StudioWave',
          click: () => {
            dialog.showMessageBox(mainWindow || undefined, {
              type: 'info',
              title: 'NTK StudioWave',
              message: `NTK StudioWave v${app.getVersion()}`,
              detail:
                '100% Offline Studio Audio Recorder, Smart Editor, Voice Polisher, and Universal Exporter.\nAll processing runs locally on your computer with zero internet required.',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function configurePermissionsAndDownloads() {
  const ses = session.defaultSession;
  const allowedPermissions = new Set([
    'media',
    'audioCapture',
    'microphone',
    'display-capture',
    'clipboard-read',
    'clipboard-sanitized-write',
    'notifications',
  ]);

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (!allowedPermissions.has(permission)) return false;
    return (
      requestingOrigin.startsWith('http://127.0.0.1') ||
      requestingOrigin.startsWith('http://localhost') ||
      requestingOrigin === 'null' ||
      requestingOrigin === ''
    );
  });

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const origin = details?.requestingUrl || '';
    const isLocal =
      origin.startsWith('http://127.0.0.1') ||
      origin.startsWith('http://localhost') ||
      origin === '';
    callback(isLocal && allowedPermissions.has(permission));
  });

  if (typeof ses.setDisplayMediaRequestHandler === 'function') {
    ses.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        if (sources.length > 0) {
          callback({ video: sources[0], audio: 'loopback' });
        } else {
          callback({});
        }
      } catch {
        callback({});
      }
    });
  }

  ses.on('will-download', (_event, item) => {
    const dir = getDownloadsTargetDir();
    const targetPath = resolveUniqueFilePath(dir, item.getFilename());
    item.setSavePath(targetPath);
  });
}

function registerIpcHandlers() {
  ipcMain.handle('ntk:save-file', async (_event, payload) => {
    const dir = getDownloadsTargetDir();
    const targetPath = resolveUniqueFilePath(dir, payload?.filename);
    const buf = Buffer.from(payload?.dataBase64 || '', 'base64');
    fs.writeFileSync(targetPath, buf);
    return { saved: true, path: targetPath };
  });

  ipcMain.handle('ntk:open-downloads', async () => {
    const dir = getDownloadsTargetDir();
    await shell.openPath(dir);
  });

  ipcMain.on('ntk:set-theme', (_event, payload) => {
    const pref = payload?.preference;
    if (pref === 'system' || pref === 'light' || pref === 'dark') {
      nativeTheme.themeSource = pref;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(payload?.isDark ? '#0B0E14' : '#F7F8FA');
    }
  });
}

async function createMainWindow(startUrl) {
  const iconPath = path.join(
    __dirname,
    '..',
    'build',
    process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  );

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 380,
    minHeight: 600,
    title: 'NTK StudioWave',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0E14' : '#F7F8FA',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(startUrl);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  try {
    process.env.NTK_EMBEDDED_SERVER = '1';
    const userDataDir = path.join(app.getPath('userData'), 'ntk-data');
    fs.mkdirSync(userDataDir, { recursive: true });
    process.env.NTK_DATA_DIR = userDataDir;

    const serverModule = require(path.join(__dirname, '..', 'dist-server', 'server.cjs'));
    const startServer = serverModule.startStudioWaveServer || serverModule.default?.startStudioWaveServer;
    if (typeof startServer !== 'function') {
      throw new Error('Embedded server entrypoint startStudioWaveServer not found.');
    }

    serverHandle = await startServer({
      port: Number(process.env.NTK_PORT) || 43721,
      host: '127.0.0.1',
      production: true,
      distDir: path.join(__dirname, '..', 'dist'),
      dataDir: userDataDir,
      autoFallbackPort: true,
    });

    buildAppMenu();
    configurePermissionsAndDownloads();
    registerIpcHandlers();
    await createMainWindow(serverHandle.url);
  } catch (err) {
    dialog.showErrorBox(
      'NTK StudioWave Startup Error',
      err instanceof Error ? err.message : String(err)
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (serverHandle && typeof serverHandle.close === 'function') {
    try {
      await serverHandle.close();
    } catch {
      // ignore close errors
    }
    serverHandle = null;
  }
});
