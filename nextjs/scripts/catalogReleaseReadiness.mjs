import { assessManifestFreshness } from './catalogFreshness.mjs'
import { assertCatalogCompleteness } from './catalogRefresh.mjs'

export function migrationVersionsFromPaths(paths) {
  return [...new Set((Array.isArray(paths) ? paths : [])
    .map(filePath => String(filePath).match(/(?:^|\/)(\d{14})_[^/]+\.sql$/)?.[1])
    .filter(Boolean))]
    .sort()
}

function validPastTimestamp(value, now) {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  return Number.isFinite(timestamp) && Number.isFinite(nowMs) && timestamp <= nowMs
}

function assessFreshness(manifest, now, maxAgeMs) {
  const freshness = assessManifestFreshness(manifest, now, maxAgeMs)
  if (freshness.status !== 'fresh') {
    return {
      ...freshness,
      status: 'blocked',
      blocker: `catalog_manifest_${freshness.status}`,
    }
  }

  try {
    assertCatalogCompleteness({ rowCount: manifest.row_count, skippedCount: manifest.skipped_count })
  } catch (error) {
    return {
      ...freshness,
      status: 'blocked',
      blocker: 'catalog_manifest_incomplete',
      reason: error.message,
    }
  }

  return { ...freshness, status: 'ready', blocker: null }
}

function assessAtomicPublication(evidence, now) {
  if (!evidence || evidence.verified !== true) {
    return { status: 'blocked', blocker: 'atomic_publication_evidence_missing' }
  }
  if (evidence.last_known_good_verified !== true) {
    return { status: 'blocked', blocker: 'atomic_last_known_good_evidence_missing' }
  }
  if (!validPastTimestamp(evidence.verified_at, now) || typeof evidence.command !== 'string' || evidence.command.trim() === '') {
    return { status: 'blocked', blocker: 'atomic_publication_evidence_invalid' }
  }
  return {
    status: 'ready',
    blocker: null,
    verified_at: evidence.verified_at,
    command: evidence.command,
  }
}

function assessHostedSchema(localMigrationPaths, hostedVersions) {
  const localVersions = migrationVersionsFromPaths(localMigrationPaths)
  if (!Array.isArray(hostedVersions)) {
    return {
      status: 'blocked',
      blocker: 'hosted_schema_evidence_missing',
      local_versions: localVersions,
      hosted_versions: null,
      missing_on_hosted: localVersions,
      unexpected_on_hosted: [],
    }
  }

  const normalizedHosted = [...new Set(hostedVersions.map(String))].sort()
  const missingOnHosted = localVersions.filter(version => !normalizedHosted.includes(version))
  const unexpectedOnHosted = normalizedHosted.filter(version => !localVersions.includes(version))
  const ready = missingOnHosted.length === 0 && unexpectedOnHosted.length === 0
  return {
    status: ready ? 'ready' : 'blocked',
    blocker: ready ? null : 'hosted_schema_mismatch',
    local_versions: localVersions,
    hosted_versions: normalizedHosted,
    missing_on_hosted: missingOnHosted,
    unexpected_on_hosted: unexpectedOnHosted,
  }
}

function assessOperatorAlert(preflightService, alertService, evidence, now) {
  const onFailureMatch = String(preflightService || '').match(/^OnFailure=(\S+)$/m)
  const alertUnit = onFailureMatch?.[1] || null
  const alertExecConfigured = /^ExecStart=\S.+$/m.test(String(alertService || ''))
  const wiringReady = alertUnit === 'dbb-catalog-preflight-alert.service' && alertExecConfigured

  if (!wiringReady) {
    return {
      status: 'blocked',
      blocker: 'operator_alert_wiring_missing',
      wiring_ready: false,
      alert_unit: alertUnit,
    }
  }

  if (!evidence || evidence.delivery_verified !== true) {
    return {
      status: 'blocked',
      blocker: 'operator_alert_delivery_evidence_missing',
      wiring_ready: true,
      alert_unit: alertUnit,
    }
  }

  if (!validPastTimestamp(evidence.verified_at, now) || typeof evidence.channel !== 'string' || evidence.channel.trim() === '') {
    return {
      status: 'blocked',
      blocker: 'operator_alert_delivery_evidence_invalid',
      wiring_ready: true,
      alert_unit: alertUnit,
    }
  }

  return {
    status: 'ready',
    blocker: null,
    wiring_ready: true,
    alert_unit: alertUnit,
    verified_at: evidence.verified_at,
    channel: evidence.channel,
  }
}

export function assessCatalogReleaseReadiness({
  manifest,
  now = new Date(),
  maxAgeMs = 48 * 60 * 60 * 1000,
  localMigrationPaths = [],
  evidence,
  preflightService = '',
  alertService = '',
}) {
  const gates = {
    freshness: assessFreshness(manifest, now, maxAgeMs),
    atomic_publication: assessAtomicPublication(evidence?.atomic_publication, now),
    hosted_schema: assessHostedSchema(localMigrationPaths, evidence?.hosted_migration_versions),
    operator_alert: assessOperatorAlert(preflightService, alertService, evidence?.operator_alert, now),
  }
  const blockers = Object.values(gates).map(gate => gate.blocker).filter(Boolean)
  return {
    status: blockers.length === 0 ? 'ready' : 'blocked',
    blockers,
    gates,
  }
}
