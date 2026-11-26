import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import { NtkVoiceStore } from './server/ntkVoiceStore';
import { createNtkVoiceRouter } from './server/ntkVoiceExpress';

const currentDir =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const isProduction =
  process.env.NODE_ENV === 'production' || process.argv.includes('--production');

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) return null;
  return new GoogleGenAI({ apiKey: apiKey.trim() });
}

function splitTranscriptToSegments(
  text: string,
  durationSeconds: number
): Array<{ id: string; start: number; end: number; text: string }> {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return [];
  const rawChunks = clean
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks = rawChunks.length > 0 ? rawChunks : [clean];
  const totalDur = Math.max(1, Number.isFinite(durationSeconds) ? durationSeconds : chunks.length * 4);
  const totalChars = chunks.reduce((sum, c) => sum + c.length, 0) || 1;

  let cursor = 0;
  return chunks.map((chunk, i) => {
    const share = (chunk.length / totalChars) * totalDur;
    const start = Number(cursor.toFixed(2));
    const end = Number(Math.min(totalDur, cursor + Math.max(0.8, share)).toFixed(2));
    cursor = end;
    return {
      id: `ai-seg-${Date.now()}-${i}`,
      start,
      end: Math.max(start + 0.5, end),
      text: chunk,
    };
  });
}

function formatApiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (/API_KEY_INVALID|PERMISSION_DENIED|403|401/i.test(raw)) {
    return {
      status: 403,
      message:
        'The Cloud AI API key is missing or invalid. Please check your key in Settings > Secrets.',
    };
  }
  if (/RESOURCE_EXHAUSTED|429/i.test(raw)) {
    return {
      status: 429,
      message: 'Cloud AI API quota reached. Please wait a moment and try again.',
    };
  }
  if (/NOT_FOUND|404/i.test(raw)) {
    return {
      status: 404,
      message: 'The requested AI model endpoint was not found.',
    };
  }
  return {
    status: 500,
    message: raw || 'Cloud AI API request failed.',
  };
}

export interface StartServerOptions {
  port?: number;
  host?: string;
  production?: boolean;
  distDir?: string;
  dataDir?: string;
  autoFallbackPort?: boolean;
}

export interface StartedStudioWaveServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startStudioWaveServer(
  options: StartServerOptions = {}
): Promise<StartedStudioWaveServer> {
  if (options.dataDir) {
    process.env.NTK_DATA_DIR = options.dataDir;
  }
  const prod = options.production ?? isProduction;
  const host = options.host ?? '0.0.0.0';
  const basePort = options.port ?? PORT;

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Permissions-Policy',
      'microphone=(self), display-capture=(self), camera=()'
    );
    next();
  });
  app.use(express.json({ limit: '30mb' }));

  // Lightweight local/production readiness probe (requires zero API keys)
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      app: 'NTK StudioWave',
      mode: 'rule-based-local-first',
      optionalAiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()),
      uptimeSec: Math.round(process.uptime()),
    });
  });

  // NTK Reorder Suite multi-provider auto-rotation & failover routes
  const voiceStore = new NtkVoiceStore(true, options.dataDir);
  app.use('/api/ntk-voice', createNtkVoiceRouter(voiceStore));

  // Health & AI API availability check (never exposes keys)
  app.get('/api/ai/status', (_req, res) => {
    const configured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
    res.json({
      configured,
      models: {
        transcribe: 'gemini-2.5-flash',
        analyze: 'gemini-2.5-flash',
      },
      capabilities: ['transcribe', 'summary', 'action_items', 'clean_script', 'chapters'],
    });
  });

  // Cloud AI Audio Transcription via gemini-2.5-flash (optional)
  app.post('/api/ai/transcribe', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'Cloud AI API is not configured on this server yet. Add GEMINI_API_KEY in Settings > Secrets to enable Cloud AI transcription.',
      });
      return;
    }

    const { audioBase64, mimeType, language, durationSeconds } = req.body ?? {};
    if (typeof audioBase64 !== 'string' || audioBase64.length < 32) {
      res.status(400).json({ error: 'Valid base64 audio payload is required.' });
      return;
    }

    const safeMime =
      typeof mimeType === 'string' && /^audio\/(wav|mp3|mpeg|webm|ogg|mp4|m4a|flac)$/i.test(mimeType)
        ? mimeType
        : 'audio/wav';
    const langHint =
      typeof language === 'string' && language.trim() && language !== 'auto'
        ? ` Primary language: ${language.trim()}.`
        : '';

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: safeMime,
                data: audioBase64,
              },
            },
            {
              text: `Transcribe this audio clearly with punctuation and natural sentences. Do not invent speech if only silence or tone is present.${langHint}`,
            },
          ],
        },
      });

      const transcriptText = (response.text ?? '').trim();
      const segments = splitTranscriptToSegments(transcriptText, Number(durationSeconds) || 15);
      res.json({
        text: transcriptText,
        segments,
        model: 'gemini-2.5-flash',
      });
    } catch (err) {
      const parsed = formatApiError(err);
      res.status(parsed.status).json({ error: parsed.message });
    }
  });

  // Cloud AI Smart Notes / Summary / Action Items / Clean Script / Chapters via gemini-2.5-flash (optional)
  app.post('/api/ai/analyze', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'Cloud AI API is not configured on this server yet. Add GEMINI_API_KEY in Settings > Secrets to enable AI notes.',
      });
      return;
    }

    const { transcript, mode, durationSeconds } = req.body ?? {};
    if (typeof transcript !== 'string' || transcript.trim().length < 4) {
      res.status(400).json({ error: 'Please transcribe or enter transcript text first.' });
      return;
    }

    const validMode =
      mode === 'summary' ||
      mode === 'action_items' ||
      mode === 'clean_script' ||
      mode === 'chapters'
        ? mode
        : 'summary';

    const prompts: Record<string, string> = {
      summary:
        'Write a clear, concise office summary of this audio transcript in 3-5 plain bullet points so any coworker can catch up in 20 seconds.',
      action_items:
        'Extract concrete action items, decisions, and next steps from this audio transcript. If none are explicitly stated, list the key takeaways as clear tasks.',
      clean_script:
        'Rewrite this transcript into a polished, publication-ready script by removing filler words ("um", "uh", "like"), false starts, and repetitions while preserving the speaker\'s exact meaning.',
      chapters: `Create 3 to 6 short chapter titles with approximate start times across this ${Math.round(
        Number(durationSeconds) || 60
      )}-second recording based on the transcript.`,
    };

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `${prompts[validMode]}\n\nTranscript:\n${transcript.slice(0, 30000)}`,
        config: {
          systemInstruction:
            'You are a concise, practical office audio assistant. Return clean structured JSON with a short headline and clear plain-language items.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              headline: { type: Type.STRING },
              items: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              cleanedText: { type: Type.STRING },
            },
          },
        },
      });

      const rawJson = (response.text ?? '{}').trim();
      const parsed = JSON.parse(rawJson) as {
        headline?: string;
        items?: string[];
        cleanedText?: string;
      };
      res.json({
        mode: validMode,
        headline: parsed.headline || 'AI Notes',
        items: Array.isArray(parsed.items) ? parsed.items : [],
        cleanedText: typeof parsed.cleanedText === 'string' ? parsed.cleanedText : '',
        model: 'gemini-2.5-flash',
      });
    } catch (err) {
      const parsed = formatApiError(err);
      res.status(parsed.status).json({ error: parsed.message });
    }
  });

  if (!prod) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distCandidates = [
      ...(options.distDir ? [path.resolve(options.distDir)] : []),
      path.resolve(currentDir, 'dist'),
      path.resolve(currentDir, '../dist'),
      path.resolve(process.cwd(), 'dist'),
    ];
    const distDir =
      distCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ||
      distCandidates[0];
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.use(
    (
      err: { status?: number; type?: string; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const status =
        err?.type === 'entity.too.large'
          ? 413
          : err?.type === 'entity.parse.failed'
          ? 400
          : typeof err?.status === 'number' && err.status >= 400 && err.status < 600
          ? err.status
          : 500;
      const message =
        status === 413
          ? 'Request payload exceeds the 30MB server limit.'
          : status === 400
          ? 'Invalid JSON request payload.'
          : err?.message || 'Unexpected server error.';
      res.status(status).json({ error: message });
    }
  );

  const listenOnPort = (portToTry: number): Promise<http.Server> =>
    new Promise((resolve, reject) => {
      const srv = app.listen(portToTry, host, () => resolve(srv));
      srv.on('error', (err) => reject(err));
    });

  const maxAttempts = options.autoFallbackPort ? 20 : 1;
  let server: http.Server | null = null;
  let boundPort = basePort;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidatePort = basePort + attempt;
    try {
      server = await listenOnPort(candidatePort);
      boundPort = candidatePort;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EADDRINUSE' && attempt < maxAttempts - 1) {
        continue;
      }
      throw err;
    }
  }

  if (!server) {
    throw new Error('Could not bind NTK StudioWave server to any local port.');
  }

  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  const url = `http://${displayHost}:${boundPort}`;

  if (process.env.NTK_EMBEDDED_SERVER !== '1') {
    console.log(`NTK StudioWave server running locally: ${url}`);
    const nets = os.networkInterfaces();
    for (const entries of Object.values(nets)) {
      if (!entries) continue;
      for (const info of entries) {
        if (info.family === 'IPv4' && !info.internal) {
          console.log(`Offline Wi-Fi / LAN access (phones/PCs): http://${info.address}:${boundPort}`);
        }
      }
    }
  }

  return {
    port: boundPort,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server!.close(() => resolve());
      }),
  };
}

if (process.env.NTK_EMBEDDED_SERVER !== '1') {
  startStudioWaveServer().catch((err) => {
    console.error('Failed to start NTK StudioWave server:', err);
    process.exit(1);
  });
}
