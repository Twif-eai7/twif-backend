const crypto = require('crypto')
const supabase = require('../supabaseClient')
const { ACTIVE_BUCKET, buildFileRef, resolveFileUrl } = require('../helper/storage')
const {
  STAGE_CARD_DEFS,
  EXCEPTION_CARDS,
  STAGE_OWNERS,
  getAlertChecklist,
  alertNeedsFileUpload,
  stageTitle,
  riskOrder,
  getAlertDependencies,
  finalInspectionOutcomeAlertIdx,
} = require('./pctStageDefs')

const dotenv = require('dotenv')
dotenv.config()
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'

function pctError(code, message, details = {}) {
  const err = new Error(message)
  err.code = code
  err.details = details
  err.status = code === 'PCT_LINE_NOT_FOUND' ? 404
    : code === 'PCT_FORBIDDEN' ? 403
      : code === 'PCT_CONFLICT' ? 409
        : 400
  return err
}

function syntheticPoNumber(workspaceId) {
  return `NPD-${String(workspaceId).slice(0, 8)}`
}

function formatExfDate(dateStr) {
  if (!dateStr) return null
  try {
    const d = new Date(dateStr)
    if (Number.isNaN(d.getTime())) return dateStr
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return dateStr
  }
}

function mapLineToPctRow(line) {
  const snap = line.plm_snapshot || {}
  const po = line.po_number || syntheticPoNumber(line.workspace_id)
  return {
    po,
    sku: line.sku_code,
    vendor: line.vendor_name || snap.supplier_name || '',
    exf: formatExfDate(line.exf_date || snap.target_ready_date) || '—',
    stage: stageTitle(line.current_stage_id),
    risk: line.risk || 'Low',
    claim: line.claim || '',
    owner: line.owner_display || 'Merchant',
    styles: 1,
    delayDays: line.delay_days ?? null,
    pctLineId: line.id,
    workspaceId: line.workspace_id,
    plmSnapshot: snap,
    lineStatus: line.line_status,
    currentStageId: line.current_stage_id,
  }
}

function representativeRowsByPO(rows) {
  const byPo = new Map()
  for (const row of rows) {
    const prev = byPo.get(row.po)
    if (!prev) { byPo.set(row.po, row); continue }
    const rp = riskOrder(row.risk)
    const pp = riskOrder(prev.risk)
    let worse = prev
    if (rp > pp) worse = row
    else if (rp === pp) {
      const dr = row.delayDays ?? -Infinity
      const dp = prev.delayDays ?? -Infinity
      if (dr > dp) worse = row
    }
    byPo.set(row.po, worse)
  }
  return [...byPo.values()]
}

function computeKpis(lines) {
  const active = lines.filter((l) => l.lineStatus === 'active' || !l.lineStatus)
  const poNums = new Set(active.map((l) => l.po))
  const onTime = active.filter((l) => (l.delayDays ?? 0) <= 0 && l.risk === 'Low').length
  const delayed = active.filter((l) => (l.delayDays ?? 0) > 0 || l.risk === 'High').length
  const early = active.filter((l) => (l.delayDays ?? 0) < 0).length
  const denom = onTime + early + delayed
  return {
    totalPOs: poNums.size,
    totalLineItems: active.length,
    totalVendors: new Set(active.map((l) => l.vendor)).size,
    onTime,
    delayed,
    early,
    otif: denom ? Math.round(((onTime + early) / denom) * 100) : 0,
  }
}

function encodeCursor(createdAt, id) {
  return Buffer.from(JSON.stringify({ ts: createdAt, id })).toString('base64url')
}

function decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

async function logActivity({ pctLineId, poNumber, skuCode, role = 'system', actorName, body, systemKind, attachment }) {
  const { error } = await supabase.from('pct_activity').insert({
    pct_line_id: pctLineId || null,
    po_number: poNumber || null,
    sku_code: skuCode || null,
    role,
    actor_name: actorName || null,
    body,
    system_kind: systemKind || null,
    attachment: attachment || null,
  })
  if (error) console.error('pct_activity insert failed:', error.message)
}

async function buildPlmSnapshot(workspaceId, { memberId } = {}) {
  const { data: ws, error: wsErr } = await supabase
    .from('npd2_workspaces')
    .select(`
      id, status, buyer_ref, buyer_brief, buyer_org_id, supplier_org_id,
      reference_media, catalog_sku_id, merchant_member_id,
      npd2_catalog_skus (
        id, auto_code, image_url, description, material, finish,
        weight, length, width, height, dimensions, measurement,
        npd2_catalog_uploads ( supplier, season, category )
      ),
      npd2_sample_orders (
        id, confirmed_qty, confirmed_price, sample_status, target_ready_date
      )
    `)
    .eq('id', workspaceId)
    .maybeSingle()
  if (wsErr) throw wsErr
  if (!ws) return null

  const catalog = ws.npd2_catalog_skus || {}
  const uploads = catalog.npd2_catalog_uploads || {}
  const sampleOrders = Array.isArray(ws.npd2_sample_orders) ? ws.npd2_sample_orders : (ws.npd2_sample_orders ? [ws.npd2_sample_orders] : [])
  const so = sampleOrders.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0] || sampleOrders[0] || {}

  let brief = ws.buyer_brief || {}
  if (typeof brief === 'string') {
    try { brief = JSON.parse(brief) } catch { brief = {} }
  }

  const dims = catalog.dimensions
    || (catalog.length != null ? `${catalog.length} × ${catalog.width} × ${catalog.height} ${catalog.measurement || 'cm'}` : null)

  let supplierName = uploads.supplier || null
  if (ws.supplier_org_id) {
    const { data: org } = await supabase.from('organizations').select('display_name, name').eq('id', ws.supplier_org_id).maybeSingle()
    supplierName = org?.display_name || org?.name || supplierName
  }

  const refMedia = Array.isArray(ws.reference_media) ? ws.reference_media : (ws.reference_media ? [ws.reference_media] : [])

  return {
    workspace_id: ws.id,
    workspace_status: ws.status,
    catalog_sku_id: catalog.id || ws.catalog_sku_id,
    sample_order_id: so.id || null,
    auto_code: catalog.auto_code || '—',
    image_url: catalog.image_url || brief.image_url || null,
    description: catalog.description || brief.description || null,
    material: catalog.material || brief.material || null,
    finish: catalog.finish || brief.finish || null,
    color: brief.color || null,
    dimensions: dims,
    weight: catalog.weight ? `${catalog.weight} kg` : (brief.weight || null),
    buyer_ref: ws.buyer_ref || null,
    confirmed_qty: so.confirmed_qty ?? brief.unit_qty ?? null,
    confirmed_price: so.confirmed_price ?? brief.unit_price ?? null,
    currency: brief.currency || 'USD',
    supplier_name: supplierName,
    season: uploads.season || null,
    category: uploads.category || brief.category || null,
    reference_media: refMedia,
    buyer_brief: brief,
    target_ready_date: so.target_ready_date || null,
    approved_at: new Date().toISOString(),
    approved_by_member_id: memberId || null,
    plm_url: `/plm?workspace=${ws.id}`,
  }
}

async function seedStageProgress(pctLineId) {
  const rows = STAGE_CARD_DEFS.map((s, idx) => ({
    pct_line_id: pctLineId,
    stage_id: s.id,
    status: idx === 0 ? 'active' : 'pending',
    completed_at: null,
    completed_by: null,
  }))
  const { error } = await supabase.from('pct_stage_progress').insert(rows)
  if (error) throw error
}

async function seedStageChecks(pctLineId) {
  const rows = []
  for (const stage of STAGE_CARD_DEFS) {
    stage.checks.forEach((label, checkIndex) => {
      rows.push({
        pct_line_id: pctLineId,
        stage_id: stage.id,
        check_index: checkIndex,
        label,
        done: false,
      })
    })
  }
  const { error } = await supabase.from('pct_stage_checks').insert(rows)
  if (error) throw error
}

async function seedStageAlertChecks(pctLineId) {
  const rows = []
  for (const stage of STAGE_CARD_DEFS) {
    stage.alerts.forEach((alertText, alertIndex) => {
      getAlertChecklist(stage.id, alertText).forEach((label, checkIndex) => {
        rows.push({
          pct_line_id: pctLineId,
          stage_id: stage.id,
          alert_index: alertIndex,
          check_index: checkIndex,
          label,
          requires_file: alertNeedsFileUpload(alertText),
          done: false,
        })
      })
    })
  }
  const { error } = await supabase.from('pct_stage_alert_checks').insert(rows)
  if (error) throw error
}

async function seedExceptionChecks(poNumber) {
  const rows = []
  EXCEPTION_CARDS.forEach((card, cardIndex) => {
    card.points.forEach((_, pointIndex) => {
      rows.push({ po_number: poNumber, card_index: cardIndex, point_index: pointIndex, done: false })
    })
  })
  const { error } = await supabase.from('pct_exception_checks').insert(rows)
  if (error && error.code !== '23505') throw error
}

async function onApprovedToSample(workspaceId, { memberId } = {}) {
  const { data: existing } = await supabase
    .from('pct_lines')
    .select('id')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (existing) return { pctLineId: existing.id, created: false }

  const snapshot = await buildPlmSnapshot(workspaceId, { memberId })
  if (!snapshot) throw new Error(`Workspace ${workspaceId} not found`)

  const { data: ws } = await supabase
    .from('npd2_workspaces')
    .select('buyer_org_id, supplier_org_id')
    .eq('id', workspaceId)
    .maybeSingle()

  const poNumber = syntheticPoNumber(workspaceId)
  let line = null

  try {
    const { data: inserted, error } = await supabase
      .from('pct_lines')
      .insert({
        workspace_id: workspaceId,
        catalog_sku_id: snapshot.catalog_sku_id,
        sample_order_id: snapshot.sample_order_id,
        po_number: poNumber,
        sku_code: snapshot.auto_code,
        buyer_ref: snapshot.buyer_ref,
        vendor_name: snapshot.supplier_name,
        buyer_org_id: ws.buyer_org_id,
        supplier_org_id: ws.supplier_org_id,
        owner_member_id: memberId,
        current_stage_id: 'po',
        stage_status: 'active',
        line_status: 'active',
        risk: 'Low',
        claim: 'NPD handoff from PLM — awaiting PO lock',
        exf_date: snapshot.target_ready_date || null,
        plm_snapshot: snapshot,
        source: 'plm_approve_to_sample',
      })
      .select()
      .single()
    if (error) throw error
    line = inserted

    await Promise.all([
      seedStageProgress(line.id),
      seedStageChecks(line.id),
      seedStageAlertChecks(line.id),
      seedExceptionChecks(poNumber),
    ])

    await logActivity({
      pctLineId: line.id,
      poNumber,
      skuCode: snapshot.auto_code,
      role: 'system',
      body: `PLM approved — ${snapshot.auto_code} entered PCT at PO Receipt & Lock`,
      systemKind: 'plm_handoff',
    })

    console.log('pct_handoff_created', { pctLineId: line.id, workspaceId })
    return { pctLineId: line.id, created: true }
  } catch (err) {
    if (line?.id) {
      await supabase.from('pct_lines').delete().eq('id', line.id)
    }
    throw err
  }
}

async function refreshPlmSnapshot(workspaceId) {
  const snapshot = await buildPlmSnapshot(workspaceId)
  if (!snapshot) return null
  const { data, error } = await supabase
    .from('pct_lines')
    .update({
      plm_snapshot: snapshot,
      sku_code: snapshot.auto_code,
      buyer_ref: snapshot.buyer_ref,
      vendor_name: snapshot.supplier_name,
      exf_date: snapshot.target_ready_date || null,
    })
    .eq('workspace_id', workspaceId)
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}

async function onPlmSyncEvent(type, workspaceId, payload = {}) {
  const { data: line } = await supabase
    .from('pct_lines')
    .select('id, po_number, sku_code')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!line) return { skipped: true }

  switch (type) {
    case 'revision_requested':
      await supabase.from('pct_lines').update({
        line_status: 'paused',
        risk: 'High',
        claim: 'Brief revision requested in PLM',
      }).eq('id', line.id)
      await refreshPlmSnapshot(workspaceId)
      await logActivity({
        pctLineId: line.id,
        poNumber: line.po_number,
        skuCode: line.sku_code,
        systemKind: 'plm_revision',
        body: payload.note || 'Revision requested in PLM',
      })
      break

    case 'sample_rejected':
      await supabase.from('pct_lines').update({
        line_status: 'closed',
        claim: 'Sample rejected in PLM',
      }).eq('id', line.id)
      await logActivity({
        pctLineId: line.id,
        poNumber: line.po_number,
        skuCode: line.sku_code,
        systemKind: 'plm_sample_rejected',
        body: payload.note || 'Sample rejected',
      })
      break

    case 'workspace_on_hold':
      await supabase.from('pct_lines').update({
        line_status: 'paused',
        risk: 'High',
      }).eq('id', line.id)
      await logActivity({
        pctLineId: line.id,
        poNumber: line.po_number,
        skuCode: line.sku_code,
        systemKind: 'plm_on_hold',
        body: 'Workspace placed on hold in PLM',
      })
      break

    case 'sample_ready':
    case 'sample_accepted':
      await refreshPlmSnapshot(workspaceId)
      await logActivity({
        pctLineId: line.id,
        poNumber: line.po_number,
        skuCode: line.sku_code,
        systemKind: `plm_${type}`,
        body: type === 'sample_ready' ? 'Sample ready in PLM' : 'Buyer accepted sample',
      })
      break

    default:
      break
  }
  return { ok: true }
}

async function autoCompleteStage1Checks(pctLineId, snapshot, purchaseOrderId) {
  const checks = [
    { index: 0, done: !!purchaseOrderId },
    { index: 1, done: Array.isArray(snapshot.reference_media) && snapshot.reference_media.length > 0 },
    { index: 2, done: snapshot.confirmed_price != null },
    { index: 3, done: !!snapshot.target_ready_date },
  ]
  const now = new Date().toISOString()
  for (const c of checks) {
    if (!c.done) continue
    await supabase.from('pct_stage_checks')
      .update({ done: true, done_by: 'System', done_at: now })
      .eq('pct_line_id', pctLineId)
      .eq('stage_id', 'po')
      .eq('check_index', c.index)
  }
}

async function onSamplePOCreated({ purchaseOrderId, poNumber, workspaceIds, memberId, productionSkuByWorkspace = {}, buyerOrgId, supplierOrgId }) {
  let resolvedBuyerOrgId = buyerOrgId
  let resolvedSupplierOrgId = supplierOrgId

  if (!resolvedBuyerOrgId || !resolvedSupplierOrgId) {
    const { data: po } = await supabase
      .from('purchase_orders')
      .select('buyer_supplier_link_id, buyer_supplier_links(buyer_org_id, supplier_org_id)')
      .eq('id', purchaseOrderId)
      .maybeSingle()
    if (!po) throw new Error('purchase_orders row not found')
    const link = po.buyer_supplier_links || {}
    resolvedBuyerOrgId = resolvedBuyerOrgId || link.buyer_org_id
    resolvedSupplierOrgId = resolvedSupplierOrgId || link.supplier_org_id
  }

  if (!resolvedBuyerOrgId || !resolvedSupplierOrgId) {
    throw new Error('Could not resolve buyer/supplier org for PCT PO header')
  }

  let headerId = null
  const { data: existingHeader } = await supabase
    .from('pct_po_headers')
    .select('id')
    .eq('po_number', poNumber)
    .eq('buyer_org_id', resolvedBuyerOrgId)
    .eq('supplier_org_id', resolvedSupplierOrgId)
    .maybeSingle()

  if (existingHeader) {
    headerId = existingHeader.id
    await supabase.from('pct_po_headers').update({
      purchase_order_id: purchaseOrderId,
      merchant_member_id: memberId,
      status: 'locked',
    }).eq('id', headerId)
  } else {
    const { data: header, error: hErr } = await supabase
      .from('pct_po_headers')
      .insert({
        po_number: poNumber,
        purchase_order_id: purchaseOrderId,
        buyer_org_id: resolvedBuyerOrgId,
        supplier_org_id: resolvedSupplierOrgId,
        merchant_member_id: memberId,
        status: 'locked',
      })
      .select()
      .single()
    if (hErr) throw hErr
    headerId = header.id
  }

  for (const wsId of workspaceIds) {
    const syntheticKey = syntheticPoNumber(wsId)
    const productionSkuId = productionSkuByWorkspace[wsId] || null

    const { data: line } = await supabase
      .from('pct_lines')
      .select('id, plm_snapshot')
      .eq('workspace_id', wsId)
      .maybeSingle()

    if (!line) continue

    await supabase.from('pct_lines').update({
      po_number: poNumber,
      pct_po_header_id: headerId,
      purchase_order_id: purchaseOrderId,
      production_sku_id: productionSkuId,
      claim: 'Sample PO locked — stage 1 checks eligible for auto-complete',
    }).eq('id', line.id)

    await supabase.from('pct_exception_checks')
      .update({ po_number: poNumber })
      .eq('po_number', syntheticKey)

    await supabase.from('pct_tab_checks')
      .update({ po_number: poNumber })
      .eq('po_number', syntheticKey)

    const snap = line.plm_snapshot || {}
    await autoCompleteStage1Checks(line.id, snap, purchaseOrderId)

    await logActivity({
      pctLineId: line.id,
      poNumber,
      skuCode: snap.auto_code,
      systemKind: 'po_locked',
      body: `Sample PO ${poNumber} created — lines linked`,
    })
  }

  return { headerId, poNumber }
}

async function fetchLinesForOrg(orgId, { stage, risk, po, buyerOrgId, limit = 50, cursor } = {}) {
  let q = supabase
    .from('pct_lines')
    .select('*')
    .or(`buyer_org_id.eq.${orgId},supplier_org_id.eq.${orgId}`)
    .neq('line_status', 'archived')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (buyerOrgId) q = q.eq('buyer_org_id', buyerOrgId)
  if (stage) q = q.eq('current_stage_id', stage)
  if (risk) q = q.eq('risk', risk)
  if (po) q = q.eq('po_number', po)

  if (cursor) {
    const decoded = decodeCursor(cursor)
    if (decoded?.ts && decoded?.id) {
      q = q.or(`created_at.lt.${decoded.ts},and(created_at.eq.${decoded.ts},id.lt.${decoded.id})`)
    }
  }

  const { data, error } = await q
  if (error) throw error
  return data || []
}

async function getLineById(id, orgId) {
  const { data, error } = await supabase
    .from('pct_lines')
    .select('*')
    .eq('id', id)
    .or(`buyer_org_id.eq.${orgId},supplier_org_id.eq.${orgId}`)
    .maybeSingle()
  if (error) throw error
  if (!data) throw pctError('PCT_LINE_NOT_FOUND', 'Line not found')
  return data
}

async function loadWorkflowState(pctLineId) {
  const [{ data: line }, { data: progress }, { data: checks }, { data: alertChecks }, { data: inspections }] = await Promise.all([
    supabase.from('pct_lines').select('*').eq('id', pctLineId).single(),
    supabase.from('pct_stage_progress').select('*').eq('pct_line_id', pctLineId),
    supabase.from('pct_stage_checks').select('*').eq('pct_line_id', pctLineId).order('check_index'),
    supabase.from('pct_stage_alert_checks').select('*').eq('pct_line_id', pctLineId).order('alert_index').order('check_index'),
    supabase.from('pct_inline_inspections').select('*').eq('pct_line_id', pctLineId).order('created_at'),
  ])

  const stageProgress = {}
  for (const p of progress || []) {
    stageProgress[p.stage_id] = {
      status: p.status,
      timestamp: p.completed_at || (p.status === 'active' ? 'Current stage' : 'Not moved yet'),
    }
  }

  const stageChecks = {}
  for (const c of checks || []) {
    if (!stageChecks[c.stage_id]) stageChecks[c.stage_id] = []
    stageChecks[c.stage_id][c.check_index] = {
      done: c.done,
      by: c.done_by || '',
      ts: c.done_at ? new Date(c.done_at).toLocaleString('en-GB') : '',
      doneAt: c.done_at,
    }
  }

  const stageAlertChecks = {}
  for (const a of alertChecks || []) {
    if (!stageAlertChecks[a.stage_id]) stageAlertChecks[a.stage_id] = []
    if (!stageAlertChecks[a.stage_id][a.alert_index]) stageAlertChecks[a.stage_id][a.alert_index] = []
    stageAlertChecks[a.stage_id][a.alert_index][a.check_index] = {
      label: a.label,
      requiresFile: a.requires_file,
      done: a.done,
      by: a.done_by || '',
      ts: a.done_at ? new Date(a.done_at).toLocaleString('en-GB') : '',
      fileName: a.file_name || '',
      fileUrl: a.file_url || '',
      doneAt: a.done_at,
    }
  }

  return {
    line,
    stageProgress,
    stageChecks,
    stageAlertChecks,
    inlineInspectionUploads: (inspections || []).map((i) => ({ name: i.file_name, url: i.file_url })),
  }
}

function getPctRolesForMember(member) {
  const orgType = member.organizations?.type || member.org_type
  if (orgType === 'merchant') return ['merchant', 'qa']
  if (orgType === 'supplier') return ['supplier']
  if (orgType === 'buyer') return ['buyer']
  return [orgType].filter(Boolean)
}

function assertCanAdvanceStage(member, stageId) {
  const roles = getPctRolesForMember(member)
  const allowed = STAGE_OWNERS[stageId] || []
  if (!allowed.some((r) => roles.includes(r))) {
    throw pctError('PCT_FORBIDDEN', `Role cannot advance stage ${stageId}`)
  }
}

async function completeStage(pctLineId, stageId, ts, memberId) {
  await supabase.from('pct_stage_progress')
    .update({ status: 'completed', completed_at: ts, completed_by: memberId })
    .eq('pct_line_id', pctLineId)
    .eq('stage_id', stageId)
}

async function activateStage(pctLineId, stageId, ts) {
  await supabase.from('pct_stage_progress')
    .update({ status: 'active', completed_at: null, completed_by: null })
    .eq('pct_line_id', pctLineId)
    .eq('stage_id', stageId)
}

async function advanceStage(pctLineId, stageId, { memberId, memberName } = {}) {
  const idx = STAGE_CARD_DEFS.findIndex((s) => s.id === stageId)
  if (idx < 0) throw pctError('PCT_STAGE_BLOCKED', 'Unknown stage')

  const ws = await loadWorkflowState(pctLineId)

  if (ws.line.line_status !== 'active') {
    throw pctError('PCT_STAGE_BLOCKED', 'Line is paused or closed')
  }
  if (ws.line.current_stage_id !== stageId) {
    throw pctError('PCT_STAGE_BLOCKED', 'stageId does not match active stage')
  }

  if (idx > 0) {
    const prevId = STAGE_CARD_DEFS[idx - 1].id
    if (ws.stageProgress[prevId]?.status !== 'completed') {
      throw pctError('PCT_STAGE_BLOCKED', 'Complete prior stage first')
    }
  }
  if (ws.stageProgress[stageId]?.status === 'completed') {
    throw pctError('PCT_STAGE_BLOCKED', 'Stage already completed')
  }

  const mandatory = ws.stageChecks[stageId] || []
  if (!mandatory.length || !mandatory.every((c) => c?.done)) {
    throw pctError('PCT_STAGE_BLOCKED', 'Mandatory checks pending')
  }

  const alertRows = ws.stageAlertChecks[stageId] || []
  const finalInspIdx = finalInspectionOutcomeAlertIdx()

  const allAlertsOk = alertRows.every((checks, alertIdx) => {
    if (!checks?.length) return true
    const depIdxs = getAlertDependencies(stageId, alertIdx, mandatory)
    const depsMet = depIdxs.length === 0 || depIdxs.every((i) => mandatory[i]?.done)
    if (!depsMet) return true
    const mode = (stageId === 'final' && alertIdx === finalInspIdx) ? 'any' : 'all'
    return mode === 'any' ? checks.some((c) => c?.done) : checks.every((c) => c?.done)
  })
  if (!allAlertsOk) {
    throw pctError('PCT_STAGE_BLOCKED', 'Resolve hard-stop alerts first')
  }

  const ts = new Date().toISOString()

  if (idx === STAGE_CARD_DEFS.length - 1) {
    await completeStage(pctLineId, stageId, ts, memberId)
    await supabase.from('pct_lines').update({
      line_status: 'closed',
      stage_status: 'completed',
    }).eq('id', pctLineId)
    await logActivity({
      pctLineId,
      poNumber: ws.line.po_number,
      skuCode: ws.line.sku_code,
      actorName: memberName,
      systemKind: 'stage_complete',
      body: 'Workflow complete',
    })
    console.log('pct_advance_success', { pctLineId, stageId, final: true })
    return { completed: true, final: true }
  }

  const nextId = STAGE_CARD_DEFS[idx + 1].id
  await completeStage(pctLineId, stageId, ts, memberId)
  await activateStage(pctLineId, nextId, ts)
  await supabase.from('pct_lines').update({
    current_stage_id: nextId,
    stage_status: 'active',
  }).eq('id', pctLineId)

  await logActivity({
    pctLineId,
    poNumber: ws.line.po_number,
    skuCode: ws.line.sku_code,
    actorName: memberName,
    systemKind: 'stage_complete',
    body: `${stageTitle(stageId)} → ${stageTitle(nextId)}`,
  })

  console.log('pct_advance_success', { pctLineId, stageId, nextStageId: nextId })
  return { completed: true, nextStageId: nextId }
}

async function updateStageCheck(pctLineId, { stageId, checkIndex, done, memberName, expectedDoneAt }) {
  let q = supabase.from('pct_stage_checks')
    .update({
      done: !!done,
      done_by: done ? memberName : null,
      done_at: done ? new Date().toISOString() : null,
    })
    .eq('pct_line_id', pctLineId)
    .eq('stage_id', stageId)
    .eq('check_index', checkIndex)

  if (expectedDoneAt) {
    q = q.eq('done_at', expectedDoneAt)
  }

  const { data, error } = await q.select().maybeSingle()
  if (error) throw error
  if (!data && expectedDoneAt) throw pctError('PCT_CONFLICT', 'Stale update — reload and retry')
  return data
}

async function updateAlertCheck(pctLineId, { stageId, alertIndex, checkIndex, done, memberName, fileUrl, fileName, expectedDoneAt }) {
  const updates = {
    done: !!done,
    done_by: done ? memberName : null,
    done_at: done ? new Date().toISOString() : null,
  }
  if (fileUrl !== undefined) updates.file_url = fileUrl
  if (fileName !== undefined) updates.file_name = fileName

  let q = supabase.from('pct_stage_alert_checks')
    .update(updates)
    .eq('pct_line_id', pctLineId)
    .eq('stage_id', stageId)
    .eq('alert_index', alertIndex)
    .eq('check_index', checkIndex)

  if (expectedDoneAt) q = q.eq('done_at', expectedDoneAt)

  const { data, error } = await q.select().maybeSingle()
  if (error) throw error
  if (!data && expectedDoneAt) throw pctError('PCT_CONFLICT', 'Stale update — reload and retry')
  return data
}

async function getActivityForLine(pctLineId) {
  const { data, error } = await supabase
    .from('pct_activity')
    .select('*')
    .eq('pct_line_id', pctLineId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data || []).map((a) => ({
    role: a.role === 'system' ? 'system' : a.role,
    actorRole: a.role,
    actorName: a.actor_name,
    text: a.body,
    ts: new Date(a.created_at).toLocaleString('en-GB'),
    po: a.po_number,
    sku: a.sku_code,
    systemKind: a.system_kind,
    attachment: a.attachment,
  }))
}

async function getExceptionChecks(poNumber, orgId) {
  const { data: lines } = await supabase
    .from('pct_lines')
    .select('id')
    .eq('po_number', poNumber)
    .or(`buyer_org_id.eq.${orgId},supplier_org_id.eq.${orgId}`)
    .limit(1)
  if (!lines?.length) throw pctError('PCT_LINE_NOT_FOUND', 'PO not found')

  const { data, error } = await supabase
    .from('pct_exception_checks')
    .select('*')
    .eq('po_number', poNumber)
    .order('card_index')
    .order('point_index')
  if (error) throw error

  const grid = EXCEPTION_CARDS.map((c) => c.points.map(() => ({ done: false, by: '', ts: '' })))
  for (const row of data || []) {
    if (grid[row.card_index]?.[row.point_index]) {
      grid[row.card_index][row.point_index] = {
        done: row.done,
        by: row.done_by || '',
        ts: row.done_at ? new Date(row.done_at).toLocaleString('en-GB') : '',
      }
    }
  }
  return grid
}

async function updateExceptionCheck(poNumber, orgId, { cardIndex, pointIndex, done, memberName }) {
  await getExceptionChecks(poNumber, orgId)
  const { error } = await supabase.from('pct_exception_checks').upsert({
    po_number: poNumber,
    card_index: cardIndex,
    point_index: pointIndex,
    done: !!done,
    done_by: done ? memberName : null,
    done_at: done ? new Date().toISOString() : null,
  }, { onConflict: 'po_number,card_index,point_index' })
  if (error) throw error
}

async function getTabChecks(tabKey, poNumber, orgId, labels) {
  const { data: lines } = await supabase
    .from('pct_lines')
    .select('id')
    .eq('po_number', poNumber)
    .or(`buyer_org_id.eq.${orgId},supplier_org_id.eq.${orgId}`)
    .limit(1)
  if (!lines?.length) return labels.map(() => ({ done: false, by: '', ts: '' }))

  const { data, error } = await supabase
    .from('pct_tab_checks')
    .select('*')
    .eq('tab_key', tabKey)
    .eq('po_number', poNumber)
    .order('check_index')
  if (error) throw error

  const rows = labels.map((label, i) => ({ done: false, by: '', ts: '', label }))
  for (const row of data || []) {
    if (rows[row.check_index]) {
      rows[row.check_index] = {
        done: row.done,
        by: row.done_by || '',
        ts: row.done_at ? new Date(row.done_at).toLocaleString('en-GB') : '',
        label: row.label || labels[row.check_index],
      }
    }
  }
  return rows
}

async function updateTabCheck(tabKey, poNumber, orgId, { checkIndex, done, memberName, label }) {
  const { data: lines } = await supabase
    .from('pct_lines')
    .select('id')
    .eq('po_number', poNumber)
    .or(`buyer_org_id.eq.${orgId},supplier_org_id.eq.${orgId}`)
    .limit(1)
  if (!lines?.length) throw pctError('PCT_LINE_NOT_FOUND', 'PO not found')

  const { error } = await supabase.from('pct_tab_checks').upsert({
    tab_key: tabKey,
    po_number: poNumber,
    check_index: checkIndex,
    label: label || null,
    done: !!done,
    done_by: done ? memberName : null,
    done_at: done ? new Date().toISOString() : null,
  }, { onConflict: 'tab_key,po_number,check_index' })
  if (error) throw error
}

async function uploadAttachment(pctLineId, orgId, { stageId, alertIndex, checkIndex, file, memberId }) {
  const line = await getLineById(pctLineId, orgId)
  const safeName = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')
  const storagePath = `pct/${pctLineId}/${stageId || 'general'}/${crypto.randomUUID()}_${safeName}`

  const { error: upErr } = await supabase.storage
    .from(ACTIVE_BUCKET)
    .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false })
  if (upErr) throw upErr

  const fileRef = buildFileRef(storagePath)
  const publicUrl = await resolveFileUrl(supabase, fileRef)

  const { data: att, error: attErr } = await supabase.from('pct_attachments').insert({
    pct_line_id: pctLineId,
    stage_id: stageId || null,
    alert_index: alertIndex != null ? alertIndex : null,
    check_index: checkIndex != null ? checkIndex : null,
    file_name: file.originalname,
    storage_path: storagePath,
    public_url: publicUrl,
    uploaded_by: memberId,
  }).select().single()
  if (attErr) throw attErr

  if (stageId === 'inline') {
    await supabase.from('pct_inline_inspections').insert({
      pct_line_id: pctLineId,
      attachment_id: att.id,
      file_name: file.originalname,
      file_url: publicUrl,
    })
  }

  if (stageId && alertIndex != null && checkIndex != null) {
    await supabase.from('pct_stage_alert_checks')
      .update({ file_name: file.originalname, file_url: publicUrl })
      .eq('pct_line_id', pctLineId)
      .eq('stage_id', stageId)
      .eq('alert_index', alertIndex)
      .eq('check_index', checkIndex)
  }

  return { attachment: att, publicUrl }
}

async function backfillFromApprovedWorkspaces() {
  const { data: workspaces } = await supabase
    .from('npd2_workspaces')
    .select('id')
    .in('status', ['approved', 'sample'])
    .order('created_at', { ascending: true })

  let created = 0
  let skipped = 0
  let failed = 0

  for (const ws of workspaces || []) {
    try {
      const result = await onApprovedToSample(ws.id, { memberId: null })
      if (result.created) created++
      else skipped++
    } catch (err) {
      failed++
      console.error(`Backfill failed for ${ws.id}:`, err.message)
      await supabase.from('pct_handoff_failures').insert({
        workspace_id: ws.id,
        event_type: 'backfill',
        error_message: err.message,
        payload: {},
      })
    }
  }
  return { created, skipped, failed }
}

module.exports = {
  pctError,
  syntheticPoNumber,
  mapLineToPctRow,
  representativeRowsByPO,
  computeKpis,
  encodeCursor,
  logActivity,
  buildPlmSnapshot,
  onApprovedToSample,
  onSamplePOCreated,
  onPlmSyncEvent,
  refreshPlmSnapshot,
  fetchLinesForOrg,
  getLineById,
  loadWorkflowState,
  assertCanAdvanceStage,
  advanceStage,
  updateStageCheck,
  updateAlertCheck,
  getActivityForLine,
  getExceptionChecks,
  updateExceptionCheck,
  getTabChecks,
  updateTabCheck,
  uploadAttachment,
  backfillFromApprovedWorkspaces,
  getPctRolesForMember,
  EXCEPTION_CARDS,
}
