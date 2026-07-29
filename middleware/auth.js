/**
 * middleware/auth.js
 *
 * Auth and role-check middleware for Express routes.
 *
 * requireAuth        — validates JWT, populates req.user. Use on any protected route.
 * requireSuperAdmin  — validates JWT + checks merchant org admin/owner role.
 * requireOrgAdmin    — helper (not middleware), returns bool. Use inside route handlers.
 */

const supabase = require('../supabaseClient')

// ─────────────────────────────────────────────
// requireAuth
// Validates Supabase JWT, populates req.user.
// Use on any route that needs an authenticated user.
// ─────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Missing authorization token' })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' })

  req.user = user
  next()
}

// ─────────────────────────────────────────────
// requireSuperAdmin
// Validates JWT + checks the user is owner or admin
// of a merchant-type org.
// ─────────────────────────────────────────────
async function requireSuperAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Missing authorization token' })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' })

  const { data: member } = await supabase
    .from('organization_members')
    .select('id, role, organizations!inner(type)')
    .eq('user_id', user.id)
    .in('role', ['admin', 'owner'])
    .eq('organizations.type', 'merchant')
    .maybeSingle()

  if (!member) return res.status(403).json({ error: 'Forbidden — merchant admin access required' })

  req.user = user
  req.adminMemberId = member.id
  next()
}

// ─────────────────────────────────────────────
// requireOrgAdmin
// Helper — not middleware. Call inside a route handler
// after requireAuth has already run.
// Returns true if the user is owner or admin of the given org.
//
// Usage:
//   const isOrgAdmin = await requireOrgAdmin(orgId, req.user.id)
//   if (!isOrgAdmin) return res.status(403).json({ error: 'Forbidden' })
// ─────────────────────────────────────────────
async function requireOrgAdmin(orgId, userId) {
  const { data } = await supabase
    .from('organization_members')
    .select('id, role')
    .eq('organization_id', orgId)
    .eq('user_id', userId)
    .in('role', ['owner', 'admin'])
    .maybeSingle()
  return !!data
}

module.exports = { requireAuth, requireSuperAdmin, requireOrgAdmin }