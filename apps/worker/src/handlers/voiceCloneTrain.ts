import type { Job as BullJob } from 'bullmq'
import type { QueuePayload } from '@fantom/jobs'
import { cloneVoice } from '@fantom/voice'
import { getPublicUrl } from '@fantom/storage'
import { logEvent } from '@fantom/observability'
import { getVoiceCloneRow, patchVoiceClone, getAssetRow } from '../lib/db.js'

/**
 * Handles the `voice_clone_train` BullMQ job.
 *
 * bullJob.data.jobId is the voice_clone row ID (not a jobs-table ID).
 * Flow: fetch source audio from R2 → submit to ElevenLabs → update record.
 */
export async function dispatchVoiceClone(bullJob: BullJob<QueuePayload>): Promise<void> {
  const { jobId: cloneId, tenantId } = bullJob.data

  const clone = await getVoiceCloneRow(cloneId, tenantId)
  if (!clone) throw new Error(`VoiceClone ${cloneId} not found in DB`)

  await patchVoiceClone(cloneId, tenantId, { status: 'processing' })

  logEvent({
    tenantId,
    kind: 'voice_clone.training_started',
    severity: 'info',
    subjectType: 'voice_clone',
    subjectId: cloneId,
    metadata: { name: clone.name },
  })

  console.log(`fantom-worker: voice clone ${cloneId} (${clone.name}) — training started`)

  try {
    if (!clone.sourceAssetId) {
      throw new Error('voice_clone has no sourceAssetId — cannot train without audio')
    }

    const sourceAsset = await getAssetRow(clone.sourceAssetId, tenantId)
    if (!sourceAsset) {
      throw new Error(`Source asset ${clone.sourceAssetId} not found for clone ${cloneId}`)
    }

    const publicUrl = getPublicUrl(sourceAsset.r2Key)
    const audioRes = await fetch(publicUrl)
    if (!audioRes.ok) {
      throw new Error(`Failed to fetch training audio from R2: ${audioRes.status}`)
    }
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer())

    const result = await cloneVoice({
      name: clone.name,
      ...(clone.description ? { description: clone.description } : {}),
      audioFileBuffer: audioBuffer,
      filename: sourceAsset.originalFilename,
    })

    await patchVoiceClone(cloneId, tenantId, {
      status: 'ready',
      providerVoiceId: result.providerVoiceId,
    })

    logEvent({
      tenantId,
      kind: 'voice_clone.ready',
      severity: 'info',
      subjectType: 'voice_clone',
      subjectId: cloneId,
      metadata: { providerVoiceId: result.providerVoiceId, name: clone.name },
    })

    console.log(
      `fantom-worker: voice clone ${cloneId} ready — ElevenLabs voice ${result.providerVoiceId}`,
    )
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    const errStack = err instanceof Error ? (err.stack ?? null) : null

    await patchVoiceClone(cloneId, tenantId, {
      status: 'failed',
      cloneFailedReason: errMessage,
    }).catch(console.error)

    logEvent({
      tenantId,
      kind: 'voice_clone.failed',
      severity: 'error',
      subjectType: 'voice_clone',
      subjectId: cloneId,
      errorMessage: errMessage,
      errorStack: errStack,
      metadata: { name: clone.name },
    })

    throw err
  }
}
