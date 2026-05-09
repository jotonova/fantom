/**
 * snapCuts — speech-aware trim snapping for 1B.5.1
 *
 * Adjusts trim boundaries to land on silence or sentence boundaries
 * rather than mid-word, using AssemblyAI word timestamps.
 *
 * Times are in milliseconds throughout.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TranscriptWord {
  text: string
  start: number // ms
  end: number   // ms
  confidence: number
}

export interface SnapResult {
  startMs: number
  endMs: number
  startReason: 'silence' | 'sentence' | 'original'
  endReason: 'silence' | 'sentence' | 'original'
  startDeltaMs: number
  endDeltaMs: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SILENCE_GAP_MIN_MS = 200
const SENTENCE_ENDINGS = /[.?!]$/

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns candidate "start" snap points — positions in the clip where audio
 * begins cleanly after a silence gap of ≥ SILENCE_GAP_MIN_MS.
 *
 * A start snap point is word[i].start where gap from word[i-1].end ≥ 200ms.
 * Also includes 0 (the very beginning of the clip) as a silence boundary.
 */
function silenceStartCandidates(words: TranscriptWord[]): number[] {
  if (words.length === 0) return [0]
  const candidates: number[] = [0]
  for (let i = 1; i < words.length; i++) {
    const gap = words[i]!.start - words[i - 1]!.end
    if (gap >= SILENCE_GAP_MIN_MS) {
      candidates.push(words[i]!.start)
    }
  }
  return candidates
}

/**
 * Returns candidate "end" snap points — positions where audio ends cleanly
 * before a silence gap of ≥ SILENCE_GAP_MIN_MS, or after a sentence boundary.
 *
 * An end snap point is word[i].end where:
 *   - gap to word[i+1].start ≥ 200ms, OR
 *   - word[i].text ends with sentence-ending punctuation
 */
function silenceEndCandidates(words: TranscriptWord[], clipDurationMs: number): number[] {
  if (words.length === 0) return [clipDurationMs]
  const candidates: number[] = []
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1]!.start - words[i]!.end
    if (gap >= SILENCE_GAP_MIN_MS || SENTENCE_ENDINGS.test(words[i]!.text)) {
      candidates.push(words[i]!.end)
    }
  }
  // Last word is always a valid end point
  candidates.push(words[words.length - 1]!.end)
  return candidates
}

/**
 * Returns candidate sentence-boundary start points (word.start where the
 * previous word ended a sentence, or the first word).
 */
function sentenceStartCandidates(words: TranscriptWord[]): number[] {
  if (words.length === 0) return [0]
  const candidates: number[] = [words[0]!.start]
  for (let i = 1; i < words.length; i++) {
    if (SENTENCE_ENDINGS.test(words[i - 1]!.text)) {
      candidates.push(words[i]!.start)
    }
  }
  return candidates
}

/**
 * Returns candidate sentence-boundary end points (word.end for words ending
 * a sentence).
 */
function sentenceEndCandidates(words: TranscriptWord[]): number[] {
  const candidates: number[] = []
  for (const w of words) {
    if (SENTENCE_ENDINGS.test(w.text)) {
      candidates.push(w.end)
    }
  }
  return candidates
}

/** Nearest value to `target` from `candidates`, or null if candidates is empty. */
function nearest(target: number, candidates: number[]): number | null {
  if (candidates.length === 0) return null
  return candidates.reduce((best, c) =>
    Math.abs(c - target) < Math.abs(best - target) ? c : best,
  )
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Snaps trim boundaries to silence gaps or sentence boundaries.
 *
 * @param words           Word timestamps from AssemblyAI (empty array = skip snapping)
 * @param desiredStartMs  Desired start offset into the source clip (ms)
 * @param desiredEndMs    Desired end offset into the source clip (ms)
 * @param toleranceMs     Max distance a snap point may deviate from the desired time
 * @param clipDurationMs  Total clip duration (used as fallback end candidate)
 *
 * Safety guarantees:
 *   - Snapped slice is never shorter than 50% of the desired slice
 *   - Snapped start is never ≥ snapped end
 *   - If either guarantee would be violated, reverts to original values
 */
export function snapTrimToSilence(
  words: TranscriptWord[],
  desiredStartMs: number,
  desiredEndMs: number,
  toleranceMs: number,
  clipDurationMs: number,
): SnapResult {
  const original: SnapResult = {
    startMs: desiredStartMs,
    endMs: desiredEndMs,
    startReason: 'original',
    endReason: 'original',
    startDeltaMs: 0,
    endDeltaMs: 0,
  }

  // No words → no snapping possible
  if (words.length === 0) return original

  const desiredSliceMs = desiredEndMs - desiredStartMs

  // ── Snap start ───────────────────────────────────────────────────────────────

  let snappedStart = desiredStartMs
  let startReason: SnapResult['startReason'] = 'original'

  // 1. Prefer silence gap candidate within tolerance
  const silStarts = silenceStartCandidates(words).filter(
    (c) => Math.abs(c - desiredStartMs) <= toleranceMs,
  )
  const bestSilStart = nearest(desiredStartMs, silStarts)
  if (bestSilStart !== null) {
    snappedStart = bestSilStart
    startReason = 'silence'
  } else {
    // 2. Fall back to sentence boundary within tolerance
    const sentStarts = sentenceStartCandidates(words).filter(
      (c) => Math.abs(c - desiredStartMs) <= toleranceMs,
    )
    const bestSentStart = nearest(desiredStartMs, sentStarts)
    if (bestSentStart !== null) {
      snappedStart = bestSentStart
      startReason = 'sentence'
    }
  }

  // ── Snap end ─────────────────────────────────────────────────────────────────

  let snappedEnd = desiredEndMs
  let endReason: SnapResult['endReason'] = 'original'

  // 1. Prefer silence/sentence end candidate within tolerance
  const silEnds = silenceEndCandidates(words, clipDurationMs).filter(
    (c) => Math.abs(c - desiredEndMs) <= toleranceMs,
  )
  const bestSilEnd = nearest(desiredEndMs, silEnds)
  if (bestSilEnd !== null) {
    snappedEnd = bestSilEnd
    endReason = 'silence'
  } else {
    // 2. Fall back to sentence boundary within tolerance
    const sentEnds = sentenceEndCandidates(words).filter(
      (c) => Math.abs(c - desiredEndMs) <= toleranceMs,
    )
    const bestSentEnd = nearest(desiredEndMs, sentEnds)
    if (bestSentEnd !== null) {
      snappedEnd = bestSentEnd
      endReason = 'sentence'
    }
  }

  // ── Safety checks ─────────────────────────────────────────────────────────────

  const snappedSliceMs = snappedEnd - snappedStart

  // Revert if snapped slice is < 50% of desired, or if start ≥ end
  if (snappedStart >= snappedEnd || snappedSliceMs < desiredSliceMs * 0.5) {
    return original
  }

  return {
    startMs: snappedStart,
    endMs: snappedEnd,
    startReason,
    endReason,
    startDeltaMs: snappedStart - desiredStartMs,
    endDeltaMs: snappedEnd - desiredEndMs,
  }
}

/** Tolerance in ms for each pacing mode. */
export function snapToleranceMs(pacing: 'fast' | 'medium' | 'slow' | null): number {
  switch (pacing) {
    case 'fast':   return 1500
    case 'medium': return 2500
    case 'slow':   return 3500
    default:       return 1500 // fast default
  }
}
