import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { fetchWithTimeoutGuarded, normalizeBaseUrl, readErrorResponse } from "../shared.js";

export const DEFAULT_ZAI_AUDIO_BASE_URL = "https://api.z.ai/api/paas/v4";
export const DEFAULT_ZAI_AUDIO_MODEL = "glm-asr-2512";

// Z.AI only supports WAV and MP3 formats
const SUPPORTED_FORMATS = new Set([
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp3",
  "audio/mpeg",
]);
const OGG_FORMATS = new Set(["audio/ogg", "audio/opus", "audio/x-opus+ogg"]);

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_ZAI_AUDIO_MODEL;
}

/**
 * Detects if the audio needs conversion based on MIME type or file extension.
 * Z.AI only accepts WAV and MP3 formats.
 */
function needsConversion(mime?: string, fileName?: string): boolean {
  const normalizedMime = mime?.toLowerCase();
  if (normalizedMime && SUPPORTED_FORMATS.has(normalizedMime)) {
    return false;
  }
  if (normalizedMime && OGG_FORMATS.has(normalizedMime)) {
    return true;
  }
  // Check file extension as fallback
  const ext = fileName?.toLowerCase().split(".").pop();
  if (ext === "wav" || ext === "mp3") {
    return false;
  }
  if (ext === "ogg" || ext === "opus" || ext === "oga") {
    return true;
  }
  // Unknown format - assume it might need conversion
  return true;
}

/**
 * Converts audio to WAV format using ffmpeg.
 * Uses 16kHz sample rate and mono channel as recommended for speech recognition.
 */
export async function convertAudioToWav(
  inputBuffer: Buffer,
  inputFileName: string,
): Promise<{ buffer: Buffer; fileName: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zai-audio-"));
  const inputPath = path.join(tmpDir, inputFileName);
  const outputFileName = inputFileName.replace(/\.[^.]+$/, ".wav");
  const outputPath = path.join(tmpDir, outputFileName);

  try {
    // Write input buffer to temp file
    await fs.writeFile(inputPath, inputBuffer);

    // Convert using ffmpeg with speech-optimized settings
    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-i",
        inputPath,
        "-ar",
        "16000", // 16kHz sample rate (optimal for speech recognition)
        "-ac",
        "1", // Mono channel
        "-f",
        "wav", // Output format
        "-y", // Overwrite output file
        outputPath,
      ]);

      let stderr = "";
      ffmpeg.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        ffmpeg.kill("SIGKILL");
        reject(new Error("Audio conversion timed out after 30 seconds"));
      }, 30000);

      ffmpeg.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        }
      });

      ffmpeg.on("error", (err) => {
        clearTimeout(timeout);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("ffmpeg not found. Please install ffmpeg to use audio conversion."));
        } else {
          reject(err);
        }
      });
    });

    // Read converted file
    const outputBuffer = await fs.readFile(outputPath);
    return { buffer: outputBuffer, fileName: outputFileName };
  } finally {
    // Cleanup temp files
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      // Ignore cleanup errors
    });
  }
}

type ZaiTranscriptResponse = {
  id?: string;
  created?: number;
  model?: string;
  text?: string;
  code?: number;
  message?: string;
};

export async function transcribeZaiAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_ZAI_AUDIO_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const url = `${baseUrl}/audio/transcriptions`;
  const model = resolveModel(params.model);

  // Check if conversion is needed (Z.AI only supports WAV and MP3)
  let audioBuffer = params.buffer;
  let fileName = params.fileName?.trim() || path.basename(params.fileName) || "audio.ogg";
  let mimeType = params.mime;

  if (needsConversion(mimeType, fileName)) {
    try {
      const converted = await convertAudioToWav(audioBuffer, fileName);
      audioBuffer = converted.buffer;
      fileName = converted.fileName;
      mimeType = "audio/wav";
    } catch (err) {
      // Re-throw with context about Z.AI format support
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Z.AI requires WAV or MP3 format. Conversion failed: ${message}`, {
        cause: err,
      });
    }
  }

  // Build multipart form data
  const form = new FormData();
  const bytes = new Uint8Array(audioBuffer);
  const blob = new Blob([bytes], {
    type: mimeType ?? "audio/wav",
  });
  form.append("file", blob, fileName);
  form.append("model", model);

  if (params.language?.trim()) {
    // Z.AI doesn't have a language parameter, but we can use it in the prompt
    form.append("prompt", `Language: ${params.language.trim()}`);
  } else if (params.prompt?.trim()) {
    form.append("prompt", params.prompt.trim());
  }

  const headers = new Headers(params.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${params.apiKey}`);
  }

  const { response: res, release } = await fetchWithTimeoutGuarded(
    url,
    {
      method: "POST",
      headers,
      body: form,
    },
    params.timeoutMs,
    fetchFn,
    allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
  );

  try {
    if (!res.ok) {
      const detail = await readErrorResponse(res);
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Audio transcription failed (HTTP ${res.status})${suffix}`);
    }

    const payload = (await res.json()) as ZaiTranscriptResponse;

    // Handle Z.AI error response format
    if (payload.code && payload.code !== 200) {
      throw new Error(
        `Z.AI transcription error (${payload.code}): ${payload.message ?? "Unknown error"}`,
      );
    }

    const text = payload.text?.trim();
    if (!text) {
      throw new Error("Audio transcription response missing text");
    }

    return { text, model: payload.model ?? model };
  } finally {
    await release();
  }
}
