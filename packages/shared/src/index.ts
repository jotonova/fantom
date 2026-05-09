export * from './videoUploadLimits.js'
export * from './shorts-briefs.js'

export interface HealthResponse {
  status: 'ok'
  timestamp: string
  version: string
}

export interface DbHealthResponse extends HealthResponse {
  db: {
    connected: boolean
    latencyMs: number
  }
}
