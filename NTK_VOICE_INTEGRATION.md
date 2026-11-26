# NTK Reorder Suite — Integration, Free API Pool & Native Packaging Guide

The **NTK Reorder Suite** is cleanly integrated into **NTK StudioWave** as a modular, namespaced feature suite while preserving 100% of existing host app screens, IndexedDB storage, and `/api/ai/*` routes.

---

## 1. Added Routes & Storage Namespaces

| Layer | Namespace / Path | Purpose |
| :--- | :--- | :--- |
| Frontend Suite | `src/ntk-voice/*` | Novice Simple Mode, Native Mobile Dock, Live 7-Band EQ Console, Trimmer/Voice-Over, 4-Track Stem Mixer, Manager Console |
| IndexedDB | `ntk_reorder_suite_db` | Recordings, 3-second crash-recovery chunks, 7-day soft-delete trash |
| PWA Assets | `public/manifest.json`, `public/sw.js`, `public/pwa-*.png`, `public/apple-touch-icon.png` | Offline app-shell caching, 1-click Install App prompt, iOS Share guide |
| Express Proxy | `/api/ntk-voice/config` (`GET`, `PUT`) | Sanitized pool status, visibility matrix, custom AI buttons, workstation settings |
| Express Proxy | `/api/ntk-voice/keys` (`POST`, `PUT /:id`, `DELETE /:id`, `POST /reorder`, `POST /test`) | Server-side encrypted multi-key pool CRUD & live health tester |
| Express Proxy | `/api/ntk-voice/transcribe` (`POST`) | Multi-chunk STT with seamless mid-recording key/provider failover |
| Express Proxy | `/api/ntk-voice/intelligence` (`POST`) | Text AI summaries, action items, formal email, and translation |
| Express Proxy | `/api/ntk-voice/stems` (`POST`) | Proxies audio to a configured free Hugging Face HTDemucs Space |

**No-PIN Manager Console:** Click the discreet **Manage** icon inside the NTK Reorder Suite or open `#manage` directly in the URL.

---

## 2. Server-Side Multi-Provider Key Setup (Free Tiers)

Keys can be added either in the **Manager Console → API Key Pool** (encrypted server-side via AES-256-GCM in `data/ntk-voice-store.enc.json` and never sent back to browsers) or via `.env` environment variables (comma-separated for multiple keys per provider):

```env
GEMINI_API_KEY=your_gemini_key
GROQ_API_KEYS=gsk_key1,gsk_key2,gsk_key3
DEEPGRAM_API_KEYS=dg_key1
ASSEMBLYAI_API_KEYS=aai_key1
MISTRAL_API_KEYS=mistral_key1
CEREBRAS_API_KEYS=csk_key1
OPENROUTER_API_KEYS=sk-or-v1-key1
CLOUDFLARE_API_TOKEN=cf_token
CLOUDFLARE_ACCOUNT_ID=cf_account_id
HF_DEMUCS_SPACE_URL=https://your-htdemucs-space.hf.space
```

- **Round-Robin Load Balancing** spreads requests evenly across all healthy keys.
- **Priority Failover** uses keys in order (#1 → #2 → #3) and automatically rotates on `429`, `401/403`, `5xx`, or timeouts while tracking `Retry-After` cooldown windows.

---

## 3. Connecting a Free Hugging Face HTDemucs Space (4-Track Stems)

1. Duplicate any public **HTDemucs** Gradio Space on Hugging Face (free CPU tier works for voice/music clips).
2. Copy its public Space URL (for example `https://your-name-htdemucs.hf.space`).
3. Open **NTK Reorder Suite → ⚙ Manage → API Key Pool**, paste the URL into **4-Track AI Stem Separation Endpoint**, and click **Save Stem Endpoint**.
4. Inside **Show Advanced Tools → Open Recording → 4-Track Stems**, click **Separate 4 Stems** to adjust Vocals, Drums, Bass, and Other Instruments independently and export a custom WAV or MP3 mix.

---

## 4. Static Deployment on Cloudflare Pages + Workers Free + KV

If you later deploy the frontend statically to Cloudflare Pages:
1. Deploy `cloudflare-worker/ntk-voice-router.js` via Wrangler (`wrangler deploy`).
2. Bind a free KV namespace named `NTK_VOICE_KV` in `wrangler.toml`.
3. Add your free provider keys via `wrangler secret put GROQ_API_KEYS`, etc.
4. Route `/api/ntk-voice/*` from Cloudflare Pages to the Worker.

---

## 5. Native Mobile (Capacitor) & Desktop PC (Tauri) Packaging

### Android / iOS via Capacitor
```bash
npm run build
npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init "NTK StudioWave" "com.ntk.studiowave" --web-dir dist
npx cap add android
npx cap add ios
npx cap sync
npx cap open android   # or npx cap open ios
```
*Add `android.permission.RECORD_AUDIO` in `AndroidManifest.xml` and `NSMicrophoneUsageDescription` in `Info.plist`.*

### Lightweight Windows / macOS / Linux Desktop via Tauri
```bash
npm run build
npm install -D @tauri-apps/cli
npx tauri init --app-name "NTK StudioWave" --window-title "NTK StudioWave" --dist-dir ../dist
npx tauri build
```
*Tauri uses the system WebView2/WebKit runtime, keeping desktop RAM usage minimal for 1 GB RAM office PCs.*
