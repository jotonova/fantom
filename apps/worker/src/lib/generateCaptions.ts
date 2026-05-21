/**
 * generateCaptions.ts — 1B.7
 *
 * Builds structured caption segments from source transcript words and VO segments.
 *
 * Strategy:
 *   1. Shift source transcript words to video timeline.
 *   2. Distribute VO script words proportionally by char-length across each VO window.
 *   3. VO wins: suppress source words that fall inside a VO window.
 *   4. Group words into caption segments (≤7 words, ≤35 chars, ≤3 s, sentence boundaries).
 *   5. Return CaptionSegment[] for drawtext rendering (no libass dependency).
 */

import type { TranscriptWord } from './snapCuts.js'

// ── Public types ──────────────────────────────────────────────────────────────

export interface CaptionClip {
  /** Word timestamps from AssemblyAI, ms relative to the SOURCE ASSET origin. Null = no transcript. */
  transcriptWords: TranscriptWord[] | null
  /** Where in the source asset the clip was trimmed from (ms). Subtracted from word timestamps
   *  to convert source-relative times to clip-local times before adding clipStartMsInVideo. */
  clipTrimStartMs: number
  /** Where this clip begins in the assembled video (ms). */
  clipStartMsInVideo: number
  /** Planned playback duration of this segment (ms). Words starting at or after this offset
   *  belong to a later segment and must be excluded to prevent bleed-over. */
  clipDurationMs?: number
}

export interface CaptionVOSegment {
  /** Verbatim voiceover script text. */
  script: string
  /** When the VO starts in the video timeline (ms). */
  startOffsetMs: number
  /** Duration of the rendered VO audio (ms). */
  durationMs: number
}

export interface CaptionSegment {
  text: string
  startMs: number
  endMs: number
}

// ── Internal ──────────────────────────────────────────────────────────────────

interface Word {
  text: string
  start: number // ms, video timeline
  end: number   // ms, video timeline
}

// ── Caption break triggers ────────────────────────────────────────────────────

const SENTENCE_END = /[.?!;]$/
const COMMA_END = /,$/
const MIN_CAPTION_MS = 500
const MAX_WORDS = 7
const MAX_CHARS = 35
const MAX_DURATION_MS = 3000

function shouldBreak(group: Word[]): boolean {
  if (group.length === 0) return false
  const last = group[group.length - 1]!
  if (SENTENCE_END.test(last.text)) return true
  if (COMMA_END.test(last.text) && group.length >= 4) return true
  if (group.length >= MAX_WORDS) return true
  if (group.map((w) => w.text).join(' ').length >= MAX_CHARS) return true
  if (last.end - group[0]!.start >= MAX_DURATION_MS) return true
  return false
}

// ── VO word distribution ──────────────────────────────────────────────────────

function tokenize(script: string): string[] {
  return script.trim().split(/\s+/).filter(Boolean)
}

/** Proportional-length distribution of tokens across [startMs, endMs]. */
function distributeWords(tokens: string[], startMs: number, endMs: number): Word[] {
  if (tokens.length === 0) return []
  const totalChars = tokens.reduce((s, t) => s + t.length, 0) || 1
  const span = endMs - startMs
  const words: Word[] = []
  let cursor = startMs
  for (let i = 0; i < tokens.length; i++) {
    const wordSpan = Math.max(40, Math.round((tokens[i]!.length / totalChars) * span))
    const end = i === tokens.length - 1 ? endMs : cursor + wordSpan
    words.push({ text: tokens[i]!, start: cursor, end })
    cursor = end
  }
  return words
}

// ── ASS serialisation ─────────────────────────────────────────────────────────

function fmtAss(ms: number): string {
  const cs = Math.round(ms / 10)
  const c = cs % 100
  const s = Math.floor(cs / 100) % 60
  const m = Math.floor(cs / 6000) % 60
  const h = Math.floor(cs / 360000)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '00')}`
}

/**
 * Serialise caption segments into an ASS subtitle file string.
 * fontName must match the family name of the font in the fontsdir you pass to
 * the `ass=` filter (e.g. "Noto Sans" for NotoSans-Regular.ttf).
 *
 * When lowerThird is provided (1B.8 brand overlays), a second "LowerThird" style
 * is added with a persistent dialogue line spanning the full video. This renders
 * the agent name inside the semi-transparent bar applied by the brand overlay pass.
 * MarginL=300 leaves room for the ~80 px logo + gap at x=150.
 * MarginV=230 aligns text vertically inside the 100 px bar (bar top at H-290).
 */
export function buildAssContent(
  segments: CaptionSegment[],
  fontName = 'Noto Sans',
  lowerThird?: { agentName: string; videoDurationMs: number },
): string {
  const styles: string[] = [
    // ABGR: white=&H00FFFFFF, black outline=&H00000000, semi-transparent back=&H80000000
    // Bold=0 (regular weight — use bundled NotoSans-Regular), Alignment=2 (bottom-centre),
    // Fontsize=110px (legible on phone at 1080×1920), Outline=6px, MarginV=120px from bottom
    `Style: Default,${fontName},110,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,6,0,2,10,10,120,1`,
  ]

  if (lowerThird) {
    // Alignment=1 (bottom-left), MarginL=300 (right of logo), MarginV=230 (vertically inside bar).
    // No background box — the semi-transparent dark bar is drawn by brandOverlays concatAndOverlay.
    styles.push(
      `Style: LowerThird,${fontName},40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,0,1,300,10,230,1`,
    )
  }

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')

  const dialogues: string[] = segments.map(
    (seg) => `Dialogue: 0,${fmtAss(seg.startMs)},${fmtAss(seg.endMs)},Default,,0,0,0,,${seg.text}`,
  )

  if (lowerThird) {
    // Single persistent event spanning the entire video (generous upper bound).
    const endTs = fmtAss(lowerThird.videoDurationMs + 5000)
    const safeName = lowerThird.agentName.replace(/[{}]/g, '')
    dialogues.push(`Dialogue: 0,0:0:00.00,${endTs},LowerThird,,0,0,0,,${safeName}`)
  }

  return [header, ...dialogues].join('\n')
}

// ── drawtext helpers ──────────────────────────────────────────────────────────

/**
 * Escape a string for use in an ffmpeg drawtext `text=` option value.
 * In ffmpeg filter syntax, within a single-quoted text value we must escape
 * backslash, single-quote, colon, comma, and percent.
 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
}

/**
 * Build a chained ffmpeg drawtext filtergraph string from caption segments.
 * Uses libfreetype only — no libass/fontconfig dependency.
 * fontPath should be an absolute path to a TTF/OTF file guaranteed present
 * on the target system (e.g. DejaVuSans-Bold on Ubuntu 22.04).
 */
export function buildDrawtextFilter(segments: CaptionSegment[], fontPath: string): string {
  if (segments.length === 0) return 'null'

  return segments
    .map((seg) => {
      const startS = (seg.startMs / 1000).toFixed(3)
      const endS = (seg.endMs / 1000).toFixed(3)
      const escaped = escapeDrawtext(seg.text)
      return (
        `drawtext=fontfile=${fontPath}` +
        `:text='${escaped}'` +
        `:fontsize=52` +
        `:fontcolor=white` +
        `:borderw=3` +
        `:bordercolor=black` +
        `:x=(w-text_w)/2` +
        `:y=h-text_h-80` +
        `:enable='between(t,${startS},${endS})'`
      )
    })
    .join(',')
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateCaptionsForRender(opts: {
  clips: CaptionClip[]
  voSegments: CaptionVOSegment[]
  videoDurationMs: number
  log: (msg: string) => void
}): Promise<CaptionSegment[]> {
  const { clips, voSegments, log } = opts

  // Step 1 — source words shifted to video timeline.
  // tw.start/end are ms relative to the SOURCE ASSET origin (AssemblyAI timestamps).
  // Correct formula: (source_ms - trim_start_ms) + assembled_clip_start_ms
  // Also drop words that lie entirely outside the trimmed window.
  const sourceWords: Word[] = []
  for (const clip of clips) {
    if (!clip.transcriptWords || clip.transcriptWords.length === 0) continue
    for (const tw of clip.transcriptWords) {
      const localStart = tw.start - clip.clipTrimStartMs
      const localEnd = tw.end - clip.clipTrimStartMs
      // Skip words that fall outside the clip's trimmed window
      if (localEnd <= 0) continue
      // Skip words that start at or after this segment's planned end — they belong to a later segment
      if (clip.clipDurationMs != null && localStart >= clip.clipDurationMs) continue
      sourceWords.push({
        text: tw.text,
        start: Math.max(0, localStart) + clip.clipStartMsInVideo,
        end: localEnd + clip.clipStartMsInVideo,
      })
    }
  }

  // Step 2 — VO words distributed across each VO window
  const voWords: Word[] = []
  for (const seg of voSegments) {
    const tokens = tokenize(seg.script)
    voWords.push(...distributeWords(tokens, seg.startOffsetMs, seg.startOffsetMs + seg.durationMs))
  }

  // Step 3 — VO wins: drop source words whose midpoint falls inside a VO window
  const voWindows = voSegments.map((s) => ({
    start: s.startOffsetMs,
    end: s.startOffsetMs + s.durationMs,
  }))
  const filteredSource = sourceWords.filter((w) => {
    const mid = (w.start + w.end) / 2
    return !voWindows.some((win) => mid >= win.start && mid <= win.end)
  })

  // Step 4 — merge and sort
  const allWords: Word[] = [...filteredSource, ...voWords].sort((a, b) => a.start - b.start)

  if (allWords.length === 0) {
    log('captions: no words found — returning empty segment list')
    return []
  }

  // Step 5 — group into caption segments
  const segments: CaptionSegment[] = []
  let group: Word[] = []

  function flush() {
    if (group.length === 0) return
    const text = group.map((w) => w.text).join(' ')
    const startMs = group[0]!.start
    const endMs = Math.max(group[group.length - 1]!.end, startMs + MIN_CAPTION_MS)
    segments.push({ text, startMs, endMs })
    group = []
  }

  for (const word of allWords) {
    if (shouldBreak(group)) flush()
    group.push(word)
  }
  flush()

  log(`captions: ${allWords.length} words → ${segments.length} segments`)

  return segments
}
