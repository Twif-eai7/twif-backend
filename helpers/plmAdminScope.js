const supabase = require('../supabaseClient')

// Admin tier (below Master Key/super admin) — a merchant member individually promoted
// via npd2_plm_admins. Their console access is scoped to only the buyer/supplier orgs
// they're recorded as handling in npd2_org_relationships (see getAdminOwnedOrgIds).
async function isPlmAdmin(memberId) {
  if (!memberId) return false
  const { data } = await supabase
    .from('npd2_plm_admins')
    .select('id')
    .eq('member_id', memberId)
    .maybeSingle()
  return !!data
}

// Distinct buyer/supplier org ids this Admin-tier member owns a relationship for —
// the scope boundary for every Admin-tier query in routes/plmAdmin.js.
async function getAdminOwnedOrgIds(memberId) {
  const { data } = await supabase
    .from('npd2_org_relationships')
    .select('buyer_org_id, supplier_org_id')
    .eq('merchant_member_id', memberId)
  const orgIds = new Set()
  for (const row of data || []) {
    if (row.buyer_org_id) orgIds.add(row.buyer_org_id)
    if (row.supplier_org_id) orgIds.add(row.supplier_org_id)
  }
  return [...orgIds]
}

module.exports = { isPlmAdmin, getAdminOwnedOrgIds }
