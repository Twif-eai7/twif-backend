'use strict'

// Guardrail: fails the build if any route in a scanned route file is missing
// requireAuth, unless it's explicitly allow-listed below with a reason.
//
// This exists because several PLM routes were found unauthenticated in a
// 2026-07-06 security audit (customerId/role trusted straight from the request
// body). The fix pattern each time was: add requireAuth + derive identity from
// resolveMember(req, ...) instead of the client. This script stops a new route
// from silently reintroducing that same mistake.
//
// Run: node scripts/checkRouteAuth.js

const fs   = require('fs')
const path = require('path')

const SCANNED_FILES = [
  'routes/plm.js',
]

// Each entry is a route that intentionally has no requireAuth.
// Add to this list only with a real reason — "not fixed yet" is a valid
// reason, but it must be written down, not silently skipped.
const ALLOWLIST = [
  { method: 'GET',   filePath: 'routes/plm.js', route: '/ping',
    reason: 'Health/warm-up check hit by the frontend on mount — no user context needed.' },
  { method: 'POST',  filePath: 'routes/plm.js', route: '/workspace-invites/accept',
    reason: 'Intentionally public — authenticates via an unguessable invite token looked up in npd2_invites, not a session (the accepting user may not have one yet).' },

  // ── Known gaps, not yet fixed (tracked in memory: project-backend-auth-gaps) ──
  { method: 'GET',   filePath: 'routes/plm.js', route: '/catalog',
    reason: 'KNOWN GAP — trusts customerId query param with no auth check. Not yet fixed.' },
  { method: 'GET',   filePath: 'routes/plm.js', route: '/catalog/skus/:id',
    reason: 'KNOWN GAP — no auth check on a single SKU read. Not yet fixed.' },
  { method: 'GET',   filePath: 'routes/plm.js', route: '/catalog/upload-status/:id',
    reason: 'KNOWN GAP — no auth check on upload-status polling. Not yet fixed.' },
  { method: 'GET',   filePath: 'routes/plm.js', route: '/catalog/skus/:id/workspaces',
    reason: 'KNOWN GAP — no auth check. Not yet fixed.' },
  { method: 'GET',   filePath: 'routes/plm.js', route: '/workspaces/:id',
    reason: 'KNOWN GAP — no auth check. Not yet fixed.' },

  // ── Legacy routes, confirmed dead (superseded by /sku-workspaces/*) ──
  // Deliberately left unauthenticated rather than fixed or deleted — see
  // memory: project-backend-auth-gaps for the "why".
  { method: 'POST',  filePath: 'routes/plm.js', route: '/workspaces',
    reason: 'Legacy, zero frontend callers — superseded by /sku-workspaces.' },
  { method: 'POST',  filePath: 'routes/plm.js', route: '/workspaces/:id/invite',
    reason: 'Legacy, zero frontend callers — superseded by /sku-workspaces/:id/invite.' },
  { method: 'PATCH', filePath: 'routes/plm.js', route: '/workspaces/:id',
    reason: 'Legacy, zero frontend callers — superseded by /sku-workspaces/:id.' },
  { method: 'PATCH', filePath: 'routes/plm.js', route: '/workspaces/:id/supplier-access',
    reason: 'Legacy, zero frontend callers.' },
  { method: 'PATCH', filePath: 'routes/plm.js', route: '/sample-orders/:id',
    reason: 'Legacy, zero frontend callers — superseded by /sku-sample-orders/:id.' },
  { method: 'POST',  filePath: 'routes/plm.js', route: '/workspaces/:id/comments',
    reason: 'Legacy, zero frontend callers — superseded by /sku-workspaces/:id/comments.' },
]

const ROUTE_RE = /^\s*router\.(get|post|patch|put|delete)\(\s*['"`]([^'"`]+)['"`]\s*,\s*(.+)$/i

function isAllowed(filePath, method, route) {
  return ALLOWLIST.some(a =>
    a.filePath === filePath && a.method === method.toUpperCase() && a.route === route
  )
}

function scanFile(relFilePath) {
  const fullPath = path.join(__dirname, '..', relFilePath)
  const lines = fs.readFileSync(fullPath, 'utf8').split('\n').map(l => l.replace(/\r$/, ''))
  const violations = []

  lines.forEach((line, idx) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//')) return // skip commented-out route registrations

    const m = line.match(ROUTE_RE)
    if (!m) return

    const [, method, route, rest] = m
    const hasAuth = /\brequireAuth\b|\brequireSuperAdmin\b/.test(rest)
    if (hasAuth) return

    if (isAllowed(relFilePath, method, route)) return

    violations.push({ file: relFilePath, line: idx + 1, method: method.toUpperCase(), route })
  })

  return violations
}

function main() {
  const allViolations = SCANNED_FILES.flatMap(scanFile)

  if (allViolations.length === 0) {
    console.log(`✅ checkRouteAuth: all routes in ${SCANNED_FILES.join(', ')} have requireAuth or are explicitly allow-listed.`)
    process.exit(0)
  }

  console.error(`❌ checkRouteAuth: ${allViolations.length} route(s) missing requireAuth and not allow-listed:\n`)
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}  ${v.method} ${v.route}`)
  }
  console.error(`\nEither add requireAuth (+ derive identity via resolveMember, not the request body),`)
  console.error(`or add an explicit ALLOWLIST entry in scripts/checkRouteAuth.js with a real reason.`)
  process.exit(1)
}

main()