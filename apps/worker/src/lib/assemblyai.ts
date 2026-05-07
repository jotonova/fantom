import { AssemblyAI } from 'assemblyai'

// ── Env ───────────────────────────────────────────────────────────────────────

const apiKey = process.env['ASSEMBLYAI_API_KEY']
if (!apiKey) {
  throw new Error('ASSEMBLYAI_API_KEY is not set — transcription cannot start')
}

const client = new AssemblyAI({ apiKey })

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TranscriptionResult {
  transcriptId: string
  text: string
  words: Array<{
    text: string
    start: number // ms
    end: number   // ms
    confidence: number
  }>
  audioDurationSeconds: number
}

// ── transcribeFile ────────────────────────────────────────────────────────────

/**
 * Submits a video URL to AssemblyAI and polls until the transcript is ready.
 *
 * @param publicUrl  Publicly reachable URL of the source video (R2 presigned or public)
 * @param log        Logger forwarded from the job runner
 */
export async function transcribeFile(
  publicUrl: string,
  log: (msg: string) => void,
): Promise<TranscriptionResult> {
  log(`submitting to AssemblyAI`)

  const transcript = await client.transcripts.transcribe({
    audio_url: publicUrl,
    speech_models: ['universal-2'], // required by AAI v3 API — must be non-empty
    punctuate: true,
    format_text: true,
    speaker_labels: false,
  })

  if (transcript.status === 'error') {
    throw new Error(
      `AssemblyAI transcription failed: status=error error=${transcript.error ?? 'unknown'}`,
    )
  }

  log(`transcript complete — ${transcript.words?.length ?? 0} words`)

  const words = (transcript.words ?? []).map((w) => ({
    text: w.text,
    start: w.start,
    end: w.end,
    confidence: w.confidence,
  }))

  return {
    transcriptId: transcript.id,
    text: transcript.text ?? '',
    words,
    audioDurationSeconds: (transcript.audio_duration ?? 0),
  }
}
