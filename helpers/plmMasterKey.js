const { AsyncLocalStorage } = require('async_hooks')
const supabase = require('../supabaseClient')

// The Master Key override is TWO conditions, both required:
//   1. eligibility  — the member is a tech-department merchant (isPlmMasterKeyEligible)
//   2. activation   — the caller explicitly asked to act with it on THIS request, by
//                     sending `X-PLM-Master-Key: 1` (the frontend only sends this while
//                     its session-scoped "Super Admin Mode" toggle is on)
// Eligibility alone is not enough: without the header a tech member is treated as a
// normal merchant/participant everywhere. This makes the client toggle a real
// server-side lock rather than a UI-only guard.

// Per-request flag, carried through async helpers that never receive `req` directly
// (resolveWorkspaceActorRole / verifySkuAccess are called from ~30 route handlers).
const masterKeyRequestContext = new AsyncLocalStorage()

// Mount on any router whose routes may honour the override. Reads the header once and
// runs the rest of the request inside a context the deep helpers can read.
function withMasterKeyContext(req, _res, next) {
  const requested = req.get('X-PLM-Master-Key') === '1'
  masterKeyRequestContext.run({ requested }, () => next())
}

// True only if this request carried the activation header. Safe to call outside a
// context (returns false) — e.g. a route on a router that didn't mount the middleware.
function masterKeyRequested() {
  return masterKeyRequestContext.getStore()?.requested === true
}

// Condition 1 only — is this member the kind of user who COULD use Master Key.
// Used to decide whether to even show them the PLM Security console.
async function isPlmMasterKeyEligible(memberId) {
  if (!memberId) return false
  const { data } = await supabase
    .from('organization_members')
    .select('department, organizations!inner(type)')
    .eq('id', memberId)
    .maybeSingle()
  return !!data
    && data.organizations?.type === 'merchant'
    && data.department === 'tech'
}

// Conditions 1 AND 2 — is the override actually in effect for this request. This is
// what every workspace/SKU override check and every destructive console op must gate on.
async function isPlmMasterKey(memberId) {
  if (!masterKeyRequested()) return false
  return isPlmMasterKeyEligible(memberId)
}

module.exports = {
  isPlmMasterKey,
  isPlmMasterKeyEligible,
  withMasterKeyContext,
  masterKeyRequested,
}
