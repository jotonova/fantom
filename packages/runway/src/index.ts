// Runway Gen-3 Turbo client for Fantom
// Generates 5-second portrait motion clips from still images (image-to-video).
//
// Pricing: 50 credits per 5s clip = $0.50 per clip (1 credit = $0.01 USD)
// Budget cap: $100/month per tenant — enforced by caller before calling generateMotionClip()

const RUNWAY_BASE_URL = 'https://api.dev.runwayml.com/v1'
const RUNWAY_VERSION = '2024-11-06'

/** Credits charged by Runway for a 5-second Gen-3 Turbo clip */
export const CREDITS_PER_5S_CLIP = 50
export const USD_PER_CREDIT = 0.01
export const DEFAULT_MONTHLY_CAP_USD = 100

// ── Errors ─────────────────────────────────────────────────────────────────────

export class BudgetExceededError extends Error {
  readonly spentUsd: number
  readonly capUsd: number

  constructor(spentUsd: number, capUsd: number) {
    super(
      `Runway monthly budget exceeded: spent $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} cap`,
    )
    this.name = 'BudgetExceededError'
    this.spentUsd = spentUsd
    this.capUsd = capUsd
  }
}

export class RunwayApiError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'RunwayApiError'
    this.statusCode = statusCode
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GenerateMotionClipInput {
  /**
   * Source image as a public URL or base64 data URL (data:image/jpeg;base64,...).
   * Runway accepts both forms.
   */
  promptImage: string
  /** Optional text describing the desired motion/direction. */
  promptText?: string
  /** Clip duration — only 5 or 10 supported by Runway Gen-3 Turbo. Defaults to 5. */
  durationSeconds?: 5 | 10
}

export interface MotionClip {
  taskId: string
  outputUrl: string
  creditsUsed: number
  costUsd: number
}

export interface RunwayTaskStatus {
  id: string
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  output?: string[]
  failure?: string
  failureCode?: string
  progress?: number
}

export interface WaitForCompletionOptions {
  /** Max wait in ms before throwing. Defaults to 5 minutes. */
  timeoutMs?: number
  /** Called on each poll cycle with the current task status. */
  onPoll?: (status: RunwayTaskStatus) => void
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env['RUNWAY_API_KEY']
  if (!key) throw new Error('RUNWAY_API_KEY environment variable is not set')
  return key
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    'Content-Type': 'application/json',
    'X-Runway-Version': RUNWAY_VERSION,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── API functions ──────────────────────────────────────────────────────────────

/**
 * Submits an image-to-video task to Runway Gen-3 Turbo.
 * Returns the task ID — use waitForCompletion() to get the output URL.
 */
export async function generateMotionClip(input: GenerateMotionClipInput): Promise<string> {
  const duration = input.durationSeconds ?? 5
  const body: Record<string, unknown> = {
    model: 'gen3a_turbo',
    promptImage: input.promptImage,
    duration,
    ratio: '768:1280', // 9:16 portrait for Shorts
  }
  if (input.promptText) body['promptText'] = input.promptText

  const res = await fetch(`${RUNWAY_BASE_URL}/image-to-video`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new RunwayApiError(`Runway image-to-video failed (${res.status}): ${text}`, res.status)
  }

  const json = (await res.json()) as { id?: string }
  if (typeof json.id !== 'string') {
    throw new RunwayApiError('Runway response missing task id', 200)
  }

  return json.id
}

/**
 * Polls a Runway task once and returns its current status.
 */
export async function pollTask(taskId: string): Promise<RunwayTaskStatus> {
  const res = await fetch(`${RUNWAY_BASE_URL}/tasks/${encodeURIComponent(taskId)}`, {
    headers: headers(),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new RunwayApiError(`Runway pollTask failed (${res.status}): ${text}`, res.status)
  }

  return (await res.json()) as RunwayTaskStatus
}

/**
 * Polls until the task reaches SUCCEEDED or FAILED, with exponential backoff.
 * Backoff starts at 5s, caps at 30s. Throws on failure or timeout.
 */
export async function waitForCompletion(
  taskId: string,
  opts: WaitForCompletionOptions = {},
): Promise<MotionClip> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000 // 5 minutes
  const deadline = Date.now() + timeoutMs
  let delayMs = 5_000

  while (Date.now() < deadline) {
    const status = await pollTask(taskId)
    opts.onPoll?.(status)

    if (status.status === 'SUCCEEDED') {
      const outputUrl = status.output?.[0]
      if (!outputUrl) {
        throw new RunwayApiError('Runway task SUCCEEDED but output array is empty', 200)
      }
      return {
        taskId,
        outputUrl,
        creditsUsed: CREDITS_PER_5S_CLIP,
        costUsd: CREDITS_PER_5S_CLIP * USD_PER_CREDIT,
      }
    }

    if (status.status === 'FAILED') {
      throw new RunwayApiError(
        `Runway task ${taskId} failed: ${status.failure ?? 'unknown'} [${status.failureCode ?? ''}]`,
        200,
      )
    }

    await sleep(delayMs)
    delayMs = Math.min(delayMs * 1.5, 30_000)
  }

  throw new RunwayApiError(`Runway task ${taskId} timed out after ${timeoutMs}ms`, 408)
}

// ── Cost helpers ───────────────────────────────────────────────────────────────

/** Returns credit count and USD cost for a given clip duration. */
export function clipCost(durationSeconds: 5 | 10 = 5): { credits: number; costUsd: number } {
  const credits = durationSeconds === 10 ? CREDITS_PER_5S_CLIP * 2 : CREDITS_PER_5S_CLIP
  return { credits, costUsd: +(credits * USD_PER_CREDIT).toFixed(4) }
}
