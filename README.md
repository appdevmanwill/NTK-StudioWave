# NTK StudioWave

Record, clean, edit, and export studio-grade audio 100% locally on Windows, Linux, and Android. You do not need an internet connection or any API keys to use this app.

## Download NTK StudioWave v1.0.0 (No Internet Needed After Download)

Pick the file for your device:

| Device | What to Download | Direct Download |
| --- | --- | --- |
| **Windows 10 / 11 (Install on PC)** | Setup Installer (`.exe`) | [NTK-StudioWave-Setup-1.0.0.exe](https://github.com/appdevmanwill/NTK-StudioWave/releases/download/v1.0.0/NTK-StudioWave-Setup-1.0.0.exe) |
| **Windows 10 / 11 (USB / No Install)** | Portable App (`.exe`) | [NTK-StudioWave-Portable-1.0.0.exe](https://github.com/appdevmanwill/NTK-StudioWave/releases/download/v1.0.0/NTK-StudioWave-Portable-1.0.0.exe) |
| **Linux (Ubuntu / Debian)** | Debian Package (`.deb`) | [NTK-StudioWave-1.0.0-amd64.deb](https://github.com/appdevmanwill/NTK-StudioWave/releases/download/v1.0.0/NTK-StudioWave-1.0.0-amd64.deb) |
| **Linux (Any Distro, Portable)** | Portable Archive (`.tar.gz`) | [NTK-StudioWave-1.0.0-linux-x64.tar.gz](https://github.com/appdevmanwill/NTK-StudioWave/releases/download/v1.0.0/NTK-StudioWave-1.0.0-linux-x64.tar.gz) |
| **Android Phone / Tablet (Android 8.0 to 16)** | Android Installer (`.apk`) | [NTK-StudioWave-v1.0.0-Android-8-to-16.apk](https://github.com/appdevmanwill/NTK-StudioWave/releases/download/v1.0.0/NTK-StudioWave-v1.0.0-Android-8-to-16.apk) |

Or browse all downloads on the [Releases Page](https://github.com/appdevmanwill/NTK-StudioWave/releases/latest).

## How to Install & Run

### Windows Installer
1. Download `NTK-StudioWave-Setup-1.0.0.exe`.
2. Double-click the file (if Windows SmartScreen shows a prompt, click **More info** then **Run anyway**).
3. Launch **NTK StudioWave** from your Desktop or Start Menu.

### Windows Portable
1. Download `NTK-StudioWave-Portable-1.0.0.exe` to any folder or USB drive.
2. Double-click it to run with zero installation.

### Linux
- **Ubuntu / Debian:** Run `sudo apt install ./NTK-StudioWave-1.0.0-amd64.deb` then open **NTK StudioWave** from your app menu.
- **Portable `.tar.gz`:** Extract the archive and run `./Run-NTK-StudioWave.sh` (or `./Install-Desktop-Shortcut.sh` to add a menu icon).

### Android (Android 8.0 to Android 16)
1. Download `NTK-StudioWave-v1.0.0-Android-8-to-16.apk` on your phone.
2. Open the **Files** app and tap the `.apk` file.
3. Allow installing from your browser or Files app if prompted, tap **Install**, then allow **Microphone** access when recording.

## Where Your Saved Files Go
- **Windows & Linux:** `Downloads/NTK-StudioWave`
- **Android:** `Files > Downloads > NTK-StudioWave`

---

## Run or Build From Source (Developers)

Requirements: Node.js 20+, Java 21 + Android SDK (for APK builds).

```bash
npm install
npm run dev      # Start local dev server on http://localhost:3000
npm run lint     # TypeScript check
npm test         # Run offline DSP & suite tests
npm run build    # Build production client (dist/) and server (dist-server/)
```
