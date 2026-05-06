/**
 * Smoke test for assemblyaiCostCap infrastructure.
 *
 * Run: pnpm --filter @fantom/worker run smoke:cost-cap
 *
 * Verifies:
 *   1. getDailySpendUsd   — reads today's total (expect 0 on fresh DB)
 *   2. getMonthlySpendUsd — reads this month's total
 *   3. estimateTranscriptionCost(3600) — expect ≈ $0.37
 *   4. checkCanTranscribe(tenantId, 0.50) — expect allowed=true on fresh DB
 *
 * Exits 0 on success, 1 on any error.
 */
import 'dotenv/config'

import {
  getDailySpendUsd,
  getMonthlySpendUsd,
  estimateTranscriptionCost,
  checkCanTranscribe,
  DAILY_SOFT_CAP_USD,
  DAILY_HARD_CAP_USD,
  MONTHLY_HARD_CAP_USD,
  COST_PER_SECOND_USD,
} from '../src/lib/assemblyaiCostCap.js'

// Justin's tenant ID
const TENANT_ID = '8b97e0ad-523b-487f-9c68-b416e070fe04'

async function main() {
  console.log('── AssemblyAI cost cap smoke test ──────────────────────────────')
  console.log()

  // 1. Constants
  console.log('Constants:')
  console.log(`  DAILY_SOFT_CAP_USD    = $${DAILY_SOFT_CAP_USD}`)
  console.log(`  DAILY_HARD_CAP_USD    = $${DAILY_HARD_CAP_USD}`)
  console.log(`  MONTHLY_HARD_CAP_USD  = $${MONTHLY_HARD_CAP_USD}`)
  console.log(`  COST_PER_SECOND_USD   = $${COST_PER_SECOND_USD.toFixed(8)} ($${(COST_PER_SECOND_USD * 3600).toFixed(4)}/hr)`)
  console.log()

  // 2. estimateTranscriptionCost
  const cost1hr = estimateTranscriptionCost(3600)
  const cost1hrOk = Math.abs(cost1hr - 0.37) < 0.001
  console.log(`estimateTranscriptionCost(3600s):`)
  console.log(`  result = $${cost1hr.toFixed(6)}  (expect ≈ $0.370000)  ${cost1hrOk ? '✓' : '✗'}`)
  console.log()

  // 3. getDailySpendUsd
  const dailySpend = await getDailySpendUsd(TENANT_ID)
  console.log(`getDailySpendUsd(${TENANT_ID}):`)
  console.log(`  result = $${dailySpend.toFixed(4)}  ✓`)
  console.log()

  // 4. getMonthlySpendUsd
  const monthlySpend = await getMonthlySpendUsd(TENANT_ID)
  console.log(`getMonthlySpendUsd(${TENANT_ID}):`)
  console.log(`  result = $${monthlySpend.toFixed(4)}  ✓`)
  console.log()

  // 5. checkCanTranscribe
  const check = await checkCanTranscribe(TENANT_ID, 0.50)
  console.log(`checkCanTranscribe(tenantId, $0.50):`)
  console.log(`  allowed      = ${check.allowed}  (expect true on fresh DB)  ${check.allowed ? '✓' : '✗ UNEXPECTED'}`)
  console.log(`  dailySpend   = $${check.dailySpend.toFixed(4)}`)
  console.log(`  monthlySpend = $${check.monthlySpend.toFixed(4)}`)
  if (check.reason) console.log(`  reason       = ${check.reason}`)
  if (check.capHit) console.log(`  capHit       = ${check.capHit}`)
  console.log()

  // Validate
  if (!cost1hrOk) throw new Error('Cost estimate for 3600s is not ≈ $0.37')
  if (!check.allowed) throw new Error('checkCanTranscribe returned allowed=false on a fresh DB — unexpected')

  console.log('── All checks passed ✓ ─────────────────────────────────────────')
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('\n✗ Smoke test FAILED:', err)
  process.exit(1)
})
