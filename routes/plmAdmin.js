const express  = require('express')
const router   = express.Router()
const { requireAuth } = require('../middleware/auth')
const supabase = require('../supabaseClient')
const { resolveMember } = require('../helpers/members')
const { isPlmMasterKeyEligible, masterKeyRequested, withMasterKeyContext } = require('../helpers/plmMasterKey')
const { isPlmAdmin, getAdminOwnedOrgIds } = require('../helpers/plmAdminScope')
const { fetchInChunks } = require('../helpers/plmAdminDiscovery')
const { logAdminAction } = require('../helpers/plmAdminAudit')

// PLM Super Admin / Admin console — every route here is gated on one of these two tiers,
// resolved server-side and never trusted from the frontend. 'super_admin' (Master Key,
// tech-dept merchant) sees everything across every org; 'admin' is scoped to only the
// buyer/supplier orgs recorded as theirs in npd2_org_relationships.
//
// Tier is resolved from ELIGIBILITY alone (tech-dept merchant) so a Super Admin can always
// open the console — the activation toggle itself lives on a page inside it. The toggle
// (X-PLM-Master-Key header) is only enforced on the destructive ops below, via
// requireSuperAdmin.
async function resolvePlmAdminTier(req, res, next) {
  const member = await resolveMember(req, res)
  if (!member) return
  req.plmMemberId = member.id
  if (await isPlmMasterKeyEligible(member.id)) {
    req.plmAdminTier = 'super_admin'
    return next()
  }
  if (await isPlmAdmin(member.id)) {
    req.plmAdminTier = 'admin'
    req.plmAdminOrgIds = await getAdminOwnedOrgIds(member.id)
    if (!req.plmAdminOrgIds.length) {
      // Promoted but hasn't been assigned any relationship yet — nothing to scope to.
      return res.json({ data: [], total: 0 })
    }
    return next()
  }
  return res.status(403).json({ error: 'PLM Super Admin access required' })
}

router.use(requireAuth, withMasterKeyContext, resolvePlmAdminTier)

router.get('/me', (req, res) => {
  res.json({ tier: req.plmAdminTier, ownedOrgIds: req.plmAdminOrgIds || null })
})

// Member/org lookups for the console's pickers — deliberately separate from
// /org-customers/all and /org-customers/orgs/all, which gate on org admin/owner
// (middleware/auth.js requireSuperAdmin), a different concept from the PLM tiers here.
// A tech-dept 'member' or a promoted PLM Admin can be a valid tier here without being
// an org admin/owner, so pickers must go through our own tier check, not that one.
router.get('/members', async (req, res) => {
  const { organization_id, type, department } = req.query
  let query = supabase
    .from('organization_members')
    .select('id, full_name, email, role, department, organizations!inner(id, name, display_name, type)')
    .order('full_name', { ascending: true })
    .limit(500)
  if (organization_id) query = query.eq('organization_id', organization_id)
  if (type) query = query.eq('organizations.type', type)
  if (department) query = query.eq('department', department)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: data.length })
})

router.get('/organizations', async (req, res) => {
  const { type } = req.query
  // Paginated in pages of 1000 rather than a single .limit(500) — a flat cap silently
  // truncated the org list once the portal passed 500 orgs, which meant any workspace
  // whose buyer/supplier org sorted past the cutoff showed as "Unknown org" in Moderation
  // even though the org row existed fine. This walks .range() until a short page confirms
  // there's nothing left, so every org is always resolvable regardless of table size.
  const PAGE = 1000
  const all = []
  for (let from = 0; ; from += PAGE) {
    let query = supabase.from('organizations').select('*').order('display_name', { ascending: true }).range(from, from + PAGE - 1)
    if (type) query = query.eq('type', type)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    all.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  res.json({ data: all, total: all.length })
})

// Applies the Admin-tier org scope to a workspaces/skus-style query builder — no-op
// for super_admin (full access, already filtered out of this path if empty).
function scopeWorkspaceQuery(query, req) {
  if (req.plmAdminTier === 'admin') {
    return query.or(
      `buyer_org_id.in.(${req.plmAdminOrgIds.join(',')}),supplier_org_id.in.(${req.plmAdminOrgIds.join(',')})`
    )
  }
  return query
}

router.get('/workspaces', async (req, res) => {
  let query = supabase
    .from('npd2_workspaces')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)
  query = scopeWorkspaceQuery(query, req)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  // Merges in the SKU's auto_code so the Permissions/Moderation UI can search/select a
  // workspace by its SKU number — done as a second query + in-memory merge rather than
  // a PostgREST embed (`.select('*, npd2_catalog_skus(...)')`), since that relies on a
  // formal FK constraint from catalog_sku_id -> npd2_catalog_skus.id being registered in
  // the schema cache, which this table doesn't have (confirmed: the embed silently
  // returned null for every row instead of erroring).
  const skuIds = [...new Set(data.map(w => w.catalog_sku_id).filter(Boolean))]
  let skusById = {}
  if (skuIds.length) {
    const { data: skus } = await supabase
      .from('npd2_catalog_skus')
      .select('id, auto_code, description, delete_meta')
      .in('id', skuIds)
    skusById = Object.fromEntries((skus || []).map(s => [s.id, s]))
  }
  const enriched = data.map(w => ({ ...w, npd2_catalog_skus: skusById[w.catalog_sku_id] || null }))

  res.json({ data: enriched, total: enriched.length })
})

router.get('/skus', async (req, res) => {
  // SKU ownership is via its upload's created_by_member_id / buyer org, not the SKU row
  // itself — mirrors the join verifySkuAccess() already uses in routes/plm.js.
  let query = supabase
    .from('npd2_catalog_skus')
    .select('*, npd2_catalog_uploads!inner(created_by_member_id, for_buyer_org_id, supplier_org_id)')
    .order('created_at', { ascending: false })
    .limit(200)
  if (req.plmAdminTier === 'admin') {
    query = query.or(
      `for_buyer_org_id.in.(${req.plmAdminOrgIds.join(',')}),supplier_org_id.in.(${req.plmAdminOrgIds.join(',')})`,
      { foreignTable: 'npd2_catalog_uploads' }
    )
  }
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: data.length })
})

router.get('/uploads', async (req, res) => {
  let query = supabase
    .from('npd2_catalog_uploads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)
  if (req.plmAdminTier === 'admin') {
    query = query.or(
      `for_buyer_org_id.in.(${req.plmAdminOrgIds.join(',')}),supplier_org_id.in.(${req.plmAdminOrgIds.join(',')})`
    )
  }
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: data.length })
})

router.get('/invites', async (req, res) => {
  // npd2_invites has no org_id of its own — scope Admin-tier via the parent workspace's org.
  let query = supabase
    .from('npd2_invites')
    .select('*, npd2_workspaces!inner(buyer_org_id, supplier_org_id)')
    .order('id', { ascending: false })
    .limit(200)
  if (req.plmAdminTier === 'admin') {
    query = query.or(
      `buyer_org_id.in.(${req.plmAdminOrgIds.join(',')}),supplier_org_id.in.(${req.plmAdminOrgIds.join(',')})`,
      { foreignTable: 'npd2_workspaces' }
    )
  }
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: data.length })
})

// --- Org relationships: which merchant member handles which buyer/supplier org ---

router.get('/org-relationships', async (req, res) => {
  let query = supabase.from('npd2_org_relationships').select('*').order('created_at', { ascending: false })
  if (req.plmAdminTier === 'admin') query = query.eq('merchant_member_id', req.plmMemberId)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: data.length })
})

router.post('/org-relationships', async (req, res) => {
  if (req.plmAdminTier !== 'super_admin')
    return res.status(403).json({ error: 'Only Super Admin can assign relationships' })
  const { merchant_member_id, buyer_org_id, supplier_org_id } = req.body
  if (!merchant_member_id || (!buyer_org_id && !supplier_org_id))
    return res.status(400).json({ error: 'merchant_member_id and one of buyer_org_id/supplier_org_id are required' })

  const { data, error } = await supabase
    .from('npd2_org_relationships')
    .insert({ merchant_member_id, buyer_org_id: buyer_org_id || null, supplier_org_id: supplier_org_id || null, created_by_member_id: req.plmMemberId })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })

  await logAdminAction({
    actorMemberId: req.plmMemberId, action: 'set_org_relationship',
    targetType: 'org_relationship', targetId: data.id, detail: { merchant_member_id, buyer_org_id, supplier_org_id },
  })
  res.json({ data })
})

router.delete('/org-relationships/:id', async (req, res) => {
  if (req.plmAdminTier !== 'super_admin')
    return res.status(403).json({ error: 'Only Super Admin can remove relationships' })
  const { error } = await supabase.from('npd2_org_relationships').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  await logAdminAction({
    actorMemberId: req.plmMemberId, action: 'revoke_org_relationship',
    targetType: 'org_relationship', targetId: req.params.id,
  })
  res.json({ ok: true })
})

// --- Admin tier: promote/demote (Super Admin only) ---

router.get('/admins', async (req, res) => {
  if (req.plmAdminTier !== 'super_admin')
    return res.status(403).json({ error: 'Only Super Admin can view the admin list' })
  const { data, error } = await supabase.from('npd2_plm_admins').select('*').order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: data.length })
})

router.post('/admins', async (req, res) => {
  if (req.plmAdminTier !== 'super_admin')
    return res.status(403).json({ error: 'Only Super Admin can promote members' })
  const { member_id } = req.body
  if (!member_id) return res.status(400).json({ error: 'member_id is required' })

  const { data, error } = await supabase
    .from('npd2_plm_admins')
    .insert({ member_id, granted_by_member_id: req.plmMemberId })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })

  await logAdminAction({ actorMemberId: req.plmMemberId, action: 'promote_admin', targetType: 'permission', targetId: data.id, detail: { member_id } })
  res.json({ data })
})

router.delete('/admins/:id', async (req, res) => {
  if (req.plmAdminTier !== 'super_admin')
    return res.status(403).json({ error: 'Only Super Admin can demote members' })
  const { error } = await supabase.from('npd2_plm_admins').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  await logAdminAction({ actorMemberId: req.plmMemberId, action: 'demote_admin', targetType: 'permission', targetId: req.params.id })
  res.json({ ok: true })
})

// --- Per-workspace view/comment/edit grants ---

router.get('/permissions', async (req, res) => {
  const workspaceId = req.query.workspace_id
  let query = supabase.from('npd2_workspace_permissions').select('*').order('created_at', { ascending: false })
  if (workspaceId) query = query.eq('workspace_id', workspaceId)
  if (req.plmAdminTier === 'admin') {
    const scoped = await fetchInChunks('npd2_workspaces', 'id, buyer_org_id, supplier_org_id',
      'buyer_org_id', req.plmAdminOrgIds)
    const scoped2 = await fetchInChunks('npd2_workspaces', 'id, buyer_org_id, supplier_org_id',
      'supplier_org_id', req.plmAdminOrgIds)
    const ids = [...new Set([...scoped, ...scoped2].map(w => w.id))]
    if (!ids.length) return res.json({ data: [], total: 0 })
    query = query.in('workspace_id', ids)
  }
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: data.length })
})

router.post('/permissions', async (req, res) => {
  const { workspace_id, member_id, capability } = req.body
  if (!workspace_id || !member_id || !['view', 'comment', 'edit'].includes(capability))
    return res.status(400).json({ error: 'workspace_id, member_id, and a valid capability are required' })

  if (req.plmAdminTier === 'admin') {
    const { data: ws } = await supabase.from('npd2_workspaces').select('buyer_org_id, supplier_org_id').eq('id', workspace_id).maybeSingle()
    const inScope = ws && (req.plmAdminOrgIds.includes(ws.buyer_org_id) || req.plmAdminOrgIds.includes(ws.supplier_org_id))
    if (!inScope) return res.status(403).json({ error: 'This workspace is outside your assigned orgs' })
  }

  const { data, error } = await supabase
    .from('npd2_workspace_permissions')
    .upsert({ workspace_id, member_id, capability, granted_by_member_id: req.plmMemberId }, { onConflict: 'workspace_id,member_id' })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })

  await logAdminAction({
    actorMemberId: req.plmMemberId, action: 'grant_permission',
    targetType: 'permission', targetId: data.id, detail: { workspace_id, member_id, capability },
  })
  res.json({ data })
})

router.delete('/permissions/:id', async (req, res) => {
  const { data: grant } = await supabase.from('npd2_workspace_permissions').select('workspace_id').eq('id', req.params.id).maybeSingle()
  if (!grant) return res.status(404).json({ error: 'Grant not found' })
  if (req.plmAdminTier === 'admin') {
    const { data: ws } = await supabase.from('npd2_workspaces').select('buyer_org_id, supplier_org_id').eq('id', grant.workspace_id).maybeSingle()
    const inScope = ws && (req.plmAdminOrgIds.includes(ws.buyer_org_id) || req.plmAdminOrgIds.includes(ws.supplier_org_id))
    if (!inScope) return res.status(403).json({ error: 'This workspace is outside your assigned orgs' })
  }
  const { error } = await supabase.from('npd2_workspace_permissions').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  await logAdminAction({ actorMemberId: req.plmMemberId, action: 'revoke_permission', targetType: 'permission', targetId: req.params.id })
  res.json({ ok: true })
})

// These ops (reassign a workspace, strip someone's access, change a primary role,
// restore a deleted SKU) are the "acting as god" operations — they require BOTH
// super_admin tier AND the activation toggle (X-PLM-Master-Key header). Opening the
// console and reading/granting is fine without the toggle; irreversible cross-org
// mutation is not.
function requireSuperAdmin(req, res, next) {
  if (req.plmAdminTier !== 'super_admin')
    return res.status(403).json({ error: 'Super Admin access required' })
  if (!masterKeyRequested())
    return res.status(403).json({ error: 'Turn on Super Admin Mode to perform this action' })
  next()
}

// Org/user creation lives on the existing /org-customers/create-organization and
// /org-customers/create-user routes (routes/onBoardCustomers.js), surfaced on the
// existing Organisations/Members admin pages — not PLM-specific, so it doesn't belong
// in this console. This router keeps only the read endpoints those pages' PLM-scoped
// pickers need (/members, /organizations above).

router.get('/audit-log', async (req, res) => {
  let query = supabase
    .from('npd2_admin_audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)
  if (req.plmAdminTier === 'admin') {
    // Admin-tier only sees entries whose target is a workspace/relationship/permission
    // scoped to their own orgs — resolved via a chunked lookup of workspace ids in scope.
    const scopedWorkspaces = await fetchInChunks(
      'npd2_workspaces', 'id', 'buyer_org_id', req.plmAdminOrgIds
    )
    const scopedWorkspaces2 = await fetchInChunks(
      'npd2_workspaces', 'id', 'supplier_org_id', req.plmAdminOrgIds
    )
    const ids = [...new Set([...scopedWorkspaces, ...scopedWorkspaces2].map(w => w.id))]
    if (!ids.length) return res.json({ data: [], total: 0 })
    query = query.in('target_id', ids)
  }
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: data.length })
})

// --- Global moderation: reassign anything, any org (Super Admin only) ---
// Deliberately no delete endpoints for workspaces/uploads/invites — these would be
// permanent hard deletes with no undo (unlike npd2_catalog_skus, which has an existing
// delete_meta soft-delete flow this console leaves untouched). View + reassign only.

router.patch('/workspaces/:id/reassign', requireSuperAdmin, async (req, res) => {
  const { buyer_member_id, supplier_member_id, merchant_member_id } = req.body
  const patch = {}
  if (buyer_member_id !== undefined) patch.buyer_member_id = buyer_member_id
  if (supplier_member_id !== undefined) patch.supplier_member_id = supplier_member_id
  if (merchant_member_id !== undefined) patch.merchant_member_id = merchant_member_id
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to reassign' })

  const { data, error } = await supabase.from('npd2_workspaces').update(patch).eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })

  await logAdminAction({
    actorMemberId: req.plmMemberId, action: 'reassign_workspace',
    targetType: 'workspace', targetId: req.params.id, detail: patch,
  })
  res.json({ data })
})

// Removes one person's access from exactly this one workspace — not their org membership,
// not any other workspace they're on. Covers both a primary buyer/supplier and a co-buyer/
// co-supplier (accepted invite, no primary slot): clears the primary slot if they held it,
// revokes their invite row for this workspace regardless of its accepted/pending status
// (the regular PATCH .../invites/:id/revoke route deliberately refuses to touch an accepted
// invite — this admin-only route is the intentional override for that), and drops them from
// group_chat_member_ids so they also lose the Group Chat tab here. After this they simply
// stop seeing this SKU's workspace card; everything else about them is untouched.
router.delete('/workspaces/:id/access/:memberId', requireSuperAdmin, async (req, res) => {
  const { id: workspaceId, memberId } = req.params

  const { data: ws, error: wsErr } = await supabase
    .from('npd2_workspaces')
    .select('buyer_member_id, supplier_member_id, group_chat_member_ids')
    .eq('id', workspaceId)
    .maybeSingle()
  if (wsErr) return res.status(500).json({ error: wsErr.message })
  if (!ws) return res.status(404).json({ error: 'Workspace not found' })

  const patch = {}
  if (ws.buyer_member_id === memberId) patch.buyer_member_id = null
  if (ws.supplier_member_id === memberId) patch.supplier_member_id = null
  if ((ws.group_chat_member_ids || []).includes(memberId))
    patch.group_chat_member_ids = ws.group_chat_member_ids.filter(id => id !== memberId)

  if (Object.keys(patch).length) {
    const { error } = await supabase.from('npd2_workspaces').update(patch).eq('id', workspaceId)
    if (error) return res.status(500).json({ error: error.message })
  }

  const { error: invErr } = await supabase
    .from('npd2_invites')
    .update({ status: 'revoked' })
    .eq('workspace_id', workspaceId)
    .eq('member_id', memberId)
    .neq('status', 'revoked')
  if (invErr) return res.status(500).json({ error: invErr.message })

  await logAdminAction({
    actorMemberId: req.plmMemberId, action: 'remove_workspace_access',
    targetType: 'workspace', targetId: workspaceId, detail: { member_id: memberId },
  })
  res.json({ success: true })
})

// Swaps who's flagged primary buyer/supplier with an existing co-buyer/co-supplier — e.g.
// the current primary is leaving the company and someone else already on the workspace
// should become the point of contact. Deliberately narrow: only the buyer_member_id/
// supplier_member_id pointer moves. Nothing else about the workspace changes — buyer_brief,
// comments, sample orders, reference_media are all untouched — and the outgoing primary is
// NOT removed, only demoted to co-buyer/co-supplier by making sure they hold an accepted
// invite row, so their access and workspace history stay exactly as available as before.
router.patch('/workspaces/:id/primary/:role', requireSuperAdmin, async (req, res) => {
  const { id: workspaceId, role } = req.params
  const { member_id: newPrimaryId } = req.body
  if (!['buyer', 'supplier'].includes(role)) return res.status(400).json({ error: 'role must be buyer or supplier' })
  if (!newPrimaryId) return res.status(400).json({ error: 'member_id is required' })

  const primaryField = role === 'buyer' ? 'buyer_member_id' : 'supplier_member_id'
  const orgField = role === 'buyer' ? 'buyer_org_id' : 'supplier_org_id'

  const { data: ws, error: wsErr } = await supabase
    .from('npd2_workspaces')
    .select(`${primaryField}, ${orgField}`)
    .eq('id', workspaceId)
    .maybeSingle()
  if (wsErr) return res.status(500).json({ error: wsErr.message })
  if (!ws) return res.status(404).json({ error: 'Workspace not found' })

  const oldPrimaryId = ws[primaryField]
  if (oldPrimaryId === newPrimaryId) return res.status(400).json({ error: 'Already the primary' })

  // Sanity check: the new primary must actually belong to this workspace's buyer/supplier
  // org — same guard the real invite flow enforces, so this can't hand primary status to
  // someone with no relationship to this workspace's org at all.
  if (ws[orgField]) {
    const { data: newMember } = await supabase
      .from('organization_members').select('organization_id').eq('id', newPrimaryId).maybeSingle()
    if (!newMember || newMember.organization_id !== ws[orgField])
      return res.status(400).json({ error: `That person isn't a member of this workspace's ${role} org` })
  }

  // Ensures a member holds an accepted invite for this role — this is what keeps the
  // outgoing primary a valid co-buyer/co-supplier afterward (RLS's plm_can_see_workspace
  // and the app's own access checks both recognize an accepted invite, not just the
  // primary column), and what backs the incoming primary's row if they never had one.
  async function ensureAcceptedInvite(memberId) {
    if (!memberId) return
    const { data: existing } = await supabase
      .from('npd2_invites')
      .select('id, status')
      .eq('workspace_id', workspaceId).eq('member_id', memberId).eq('role', role)
      .maybeSingle()
    if (existing) {
      if (existing.status !== 'accepted')
        await supabase.from('npd2_invites').update({ status: 'accepted', accepted_at: new Date() }).eq('id', existing.id)
      return
    }
    const { data: memberRow } = await supabase.from('organization_members').select('email').eq('id', memberId).maybeSingle()
    await supabase.from('npd2_invites').insert({
      workspace_id: workspaceId, member_id: memberId, role, email: memberRow?.email || null,
      token: require('crypto').randomUUID(), status: 'accepted', accepted_at: new Date(),
    })
  }
  await ensureAcceptedInvite(newPrimaryId)
  await ensureAcceptedInvite(oldPrimaryId)

  const { error } = await supabase.from('npd2_workspaces').update({ [primaryField]: newPrimaryId }).eq('id', workspaceId)
  if (error) return res.status(500).json({ error: error.message })

  await logAdminAction({
    actorMemberId: req.plmMemberId, action: `swap_primary_${role}`,
    targetType: 'workspace', targetId: workspaceId, detail: { from: oldPrimaryId, to: newPrimaryId },
  })
  res.json({ success: true })
})

// Undoes a catalog SKU soft-delete (clears delete_meta) — the counterpart to the existing
// PATCH /catalog/skus/:id/soft-delete in routes/plm.js. Super Admin only, since a regular
// merchant member has no path to this at all today (soft-delete itself has no undo in the
// normal catalog UI).
router.patch('/skus/:id/restore', requireSuperAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('npd2_catalog_skus')
    .update({ delete_meta: null })
    .eq('id', req.params.id)
    .select('id, auto_code, delete_meta')
    .single()
  if (error) return res.status(500).json({ error: error.message })

  await logAdminAction({
    actorMemberId: req.plmMemberId, action: 'restore_sku',
    targetType: 'sku', targetId: req.params.id, detail: null,
  })
  res.json({ data })
})

module.exports = router
