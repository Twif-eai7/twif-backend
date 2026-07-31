// Ported from twif-frontend/src/components/pctBeta/constants.js — keep in sync.

const STAGE_CARD_DEFS = [
  { id: 'po', title: 'PO Receipt & Lock', owner: 'Merchant', sla: '0–1 day', status: 'active',
    checks: ['Buyer PO uploaded', 'Tech pack attached', 'Price lock created', 'Ex-factory date locked'],
    alerts: ['PO vs cost sheet mismatch', 'Missing tech pack', 'Currency mismatch'] },
  { id: 'tech', title: 'Tech Pack Validation', owner: 'Merchant + QA', sla: '1–3 days', status: 'pending',
    checks: ['Size tolerance', 'Weight tolerance', 'Material / finish', 'Color code / artwork', 'Approved reference sample'],
    alerts: ['Size spec missing', 'Weight missing', 'Artwork not approved', 'Spec changed after PO'] },
  { id: 'rm', title: 'Raw Material Indent', owner: 'Factory + Sourcing', sla: '3–7 days', status: 'pending',
    checks: ['BOM freeze', 'RM quantity', 'Lead time', 'RM costing', 'Alternative source'],
    alerts: ['RM delay', 'RM cost variance >3%', 'Material grade mismatch', 'Insufficient stock'] },
  { id: 'pack', title: 'Packaging Indent', owner: 'Merchant + Factory', sla: '3–7 days', status: 'pending',
    checks: ['Barcode approved', 'Shipping marks', 'Drop test protocol', 'Label legal text', 'Master carton spec'],
    alerts: ['Barcode mismatch', 'Label compliance missing', 'Carton gsm mismatch'] },
  { id: 'pp', title: 'PP Meeting & Sample Approval', owner: 'Merchant + QA + Factory', sla: '7–15 days', status: 'pending',
    checks: ['PP date', 'Inline date', 'Midline date', 'Final insp. date', 'Buyer comments closure'],
    alerts: ['PP sample pending', 'No approval', 'Critical comments open'] },
  { id: 'bulk', title: 'Bulk Production', owner: 'Factory', sla: '15–60 days', status: 'pending',
    checks: ['Line allocation', 'Daily output', 'WIP variance', 'Rework log'],
    alerts: ['Output lag', 'Capacity overload', 'Tech spec drift'] },
  { id: 'inline', title: 'Inline QC', owner: 'QA', sla: '20–35 days', status: 'pending',
    checks: ['Workmanship', 'Size & weight', 'Finish'],
    alerts: ['AQL risk', 'Size drift'] },
  { id: 'midline', title: 'Midline QC', owner: 'QA', sla: '35–50 days', status: 'pending',
    checks: ['Packing method', 'Corrective action'],
    alerts: ['Wrong finish', 'Wrong accessories'] },
  { id: 'final', title: 'Final QC & Documentation', owner: 'QA + Merchant + Logistics', sla: '60–75 days', status: 'pending',
    checks: ['Final inspection', 'Invoice check', 'Packing list', 'HS code', 'Value check'],
    alerts: ['Wrong price in invoice', 'Qty mismatch', 'Inspection outcome', 'Shipment without docs'] },
  { id: 'ship', title: 'Stuffing, Dispatch & Ex-India', owner: 'Logistics', sla: '75–90+ days', status: 'pending',
    checks: ['Container booking', 'Stuffing confirmation', 'BL readiness', 'ETD lock'],
    alerts: ['Missed vessel', 'Late cargo readiness', 'BL delay'] },
]

const EXCEPTION_CARDS = [
  { icon: 'file', title: 'Commercial Control', points: ['Wrong PO price vs approved cost sheet', 'Invoice value mismatch', 'Currency mismatch', 'Unapproved discount or rebate'] },
  { icon: 'scan', title: 'Spec Control', points: ['Size / dimension variance', 'Weight variance', 'Finish / coating mismatch', 'Wrong component / accessory usage'] },
  { icon: 'package', title: 'Packaging Control', points: ['Barcode mismatch', 'Label legal text missing', 'Wrong carton size / gsm', 'Drop test protocol not approved'] },
  { icon: 'truck', title: 'Dispatch Control', points: ['Shipment before final QC', 'Late stuffing', 'Missing BL docs', 'Missed vessel risk'] },
]

const MANDATORY_TO_ALERT_DEPENDENCIES = {
  po: { 0: [0, 2, 3], 1: [1], 2: [0, 2] },
}

const MANDATORY_TO_ALERT_ITEM_DEPENDENCIES = {
  po: {
    0: { 0: [2], 1: [3], 2: [0] },
    1: { 0: [1], 1: [0], 2: [0] },
    2: { 0: [], 1: [], 2: [] },
  },
  inline: {
    0: { 0: [1], 1: [0], 2: [2] },
    1: { 0: [1], 1: [2], 2: [2] },
  },
  midline: {
    0: { 0: [0], 1: [1], 2: [0] },
    1: { 0: [0], 1: [0], 2: [1] },
  },
  tech: {
    0: { 0: [0], 1: [2], 2: [4] },
    1: { 0: [1], 1: [1], 2: [0] },
    2: { 0: [3], 1: [3], 2: [2] },
    3: { 0: [4], 1: [0], 2: [2] },
  },
  rm: {
    0: { 0: [2], 1: [2], 2: [1] },
    1: { 0: [1], 1: [3], 2: [4] },
    2: { 0: [0], 1: [2], 2: [4] },
    3: { 0: [1], 1: [4], 2: [2] },
  },
  pack: {
    0: { 0: [0], 1: [1], 2: [4] },
    1: { 0: [3], 1: [3], 2: [1] },
    2: { 0: [4], 1: [2], 2: [3] },
  },
  pp: {
    0: { 0: [0], 1: [0], 2: [4] },
    1: { 0: [4], 1: [4], 2: [0] },
    2: { 0: [4], 1: [4], 2: [0] },
  },
  bulk: {
    0: { 0: [1], 1: [1], 2: [0] },
    1: { 0: [0], 1: [0], 2: [1] },
    2: { 0: [3], 1: [3], 2: [2] },
  },
  final: {
    0: { 0: [1], 1: [4], 2: [1] },
    1: { 0: [2], 1: [2], 2: [4] },
    2: { 0: [0, 1, 2], 1: [0, 4] },
    3: { 0: [2], 1: [0], 2: [3] },
  },
  ship: {
    0: { 0: [3], 1: [1], 2: [0] },
    1: { 0: [1], 1: [1], 2: [0] },
    2: { 0: [2], 1: [2], 2: [2] },
  },
}

const STAGE_OWNERS = {
  po: ['merchant'],
  tech: ['merchant', 'qa'],
  rm: ['supplier', 'merchant'],
  pack: ['merchant', 'supplier'],
  pp: ['merchant', 'qa', 'supplier'],
  bulk: ['supplier'],
  inline: ['qa'],
  midline: ['qa'],
  final: ['qa', 'merchant'],
  ship: ['merchant'],
}

function getAlertChecklist(stageId, alertText) {
  const t = (alertText || '').toLowerCase().trim()
  if (stageId === 'po' && t === 'po vs cost sheet mismatch') return ['Price check', 'Ship date', 'Quantity']
  if (stageId === 'po' && t === 'missing tech pack') return ['Tech pack attached', 'Product specs received', 'Label specs received']
  if (stageId === 'po' && t === 'currency mismatch') return ['PO currency verified', 'Price/value recalculated', 'Cost sheet aligned']
  if (stageId === 'tech' && t === 'size spec missing') return ['Product specs due checked', 'Product specs received', 'Spec sheet approved']
  if (stageId === 'tech' && t === 'weight missing') return ['Order quantity verified', 'Weight tolerance updated', 'Testing sample plan created']
  if (stageId === 'tech' && t === 'artwork not approved') return ['Label specs received', 'Artwork submitted', 'Wash care approval captured']
  if (stageId === 'tech' && t === 'spec changed after po') return ['Buyer change logged', 'PPM impact assessed', 'Latest spec version locked']
  if (stageId === 'rm' && t === 'rm delay') return ['Inhouse due checked', 'Inhouse actual updated', 'Raw material shortage if any']
  if (stageId === 'rm' && t === 'rm cost variance >3%') return ['PO price revalidated', 'Value impact approved', 'Merchant sign-off done']
  if (stageId === 'rm' && t === 'material grade mismatch') return ['Material spec checked', 'Testing sample submitted', 'Alternate source approved']
  if (stageId === 'rm' && t === 'insufficient stock') return ['Balance quantity checked', 'PO line priority set', 'Raw material for balance arrange']
  if (stageId === 'pack' && t === 'barcode mismatch') return ['Barcode artwork matched', 'Carting issued status checked', 'Pack copy approved']
  if (stageId === 'pack' && t === 'label compliance missing') return ['Label specs received', 'Wash care approved', 'Legal text verified']
  if (stageId === 'pack' && t === 'carton gsm mismatch') return ['Carton specs matched', 'Drop test requirement checked', 'Vendor corrective action logged']
  if (stageId === 'pp' && t === 'pp sample pending') return ['PPM due checked', 'PPM conducted date updated', 'PP comments shared']
  if (stageId === 'pp' && t === 'approval pending') return ['Buyer approval requested', 'Escalation comment logged', 'Revised sample ETA captured']
  if (stageId === 'pp' && t === 'critical comments open') return ['Critical points listed', 'Owner assigned', 'Closure date committed']
  if (stageId === 'bulk' && t === 'output lag') return ['Production output vs plan checked', 'Pending quantity reviewed', 'Recovery capacity planned']
  if (stageId === 'bulk' && t === 'capacity overload') return ['Line allocation revised', 'Outsource/support options checked', 'Merchant notified']
  if (stageId === 'bulk' && t === 'tech spec drift') return ['Inline findings reviewed', 'Latest approved spec recirculated', 'Deviation closure logged']
  if (stageId === 'inline' && t === 'aql risk') return ['Inline actual updated', 'Defect trend reviewed', 'Corrective actions assigned']
  if (stageId === 'inline' && t === 'size drift') return ['Size tolerance rechecked', 'Midline plan advanced', 'Pattern correction confirmed']
  if (stageId === 'midline' && t === 'wrong finish') return ['Finish spec verified', 'Rework plan approved', 'QA recheck scheduled']
  if (stageId === 'midline' && t === 'wrong accessories') return ['Accessory inhouse date checked', 'Wrong lot isolated', 'Replacement ETA committed']
  if (stageId === 'final' && t === 'wrong price in invoice') return ['Invoice vs PO price matched', 'Value in USD validated', 'Approval note attached']
  if (stageId === 'final' && t === 'qty mismatch') return ['Final quantity counted', 'Shipped quantity updated', 'Balance quantity actioned']
  if (stageId === 'final' && /inspection outcome/i.test(t)) return ['Pass — signed report, docs aligned, release authorised', 'Fail — defects logged & re-inspection booked']
  if (stageId === 'final' && t === 'shipment without docs') return ['Packing list uploaded', 'Buyer approval captured', 'Carting issued confirmed']
  if (stageId === 'ship' && t === 'missed vessel') return ['ETD lock checked', 'Cargo readiness reconfirmed', 'Rebooking plan approved']
  if (stageId === 'ship' && t === 'late cargo readiness') return ['Stuffing confirmation pending list cleared', 'Dispatch ETA updated', 'AWD impact shared']
  if (stageId === 'ship' && t === 'bl delay') return ['BL readiness checked', 'Shipping docs complete', 'Buyer update sent']
  if (t.includes('missing tech pack')) return ['Tech pack attached', 'Product specs received', 'Label specs received']
  if (t.includes('mismatch')) return ['Mismatch reviewed', 'Root cause noted', 'Corrective action closed']
  return ['Issue resolved']
}

function alertNeedsFileUpload(alertText) {
  const t = (alertText || '').toLowerCase()
  return t.includes('missing tech pack') || t.includes('missing') || t.includes('mismatch')
}

function stageTitle(stageId) {
  const s = STAGE_CARD_DEFS.find((x) => x.id === stageId)
  return s ? s.title : stageId
}

function riskOrder(risk) {
  if (risk === 'High') return 3
  if (risk === 'Medium') return 2
  return 1
}

function getAlertDependencies(stageId, alertIdx, mandatoryChecks) {
  const explicit = MANDATORY_TO_ALERT_DEPENDENCIES[stageId]?.[alertIdx]
  if (explicit?.length) return explicit
  const stage = STAGE_CARD_DEFS.find((s) => s.id === stageId)
  if (!stage?.alerts?.[alertIdx]) return []
  const alertText = (stage.alerts[alertIdx] || '').toLowerCase()
  const checks = stage.checks || []
  const byKeyword = []
  checks.forEach((checkLabel, idx) => {
    const check = (checkLabel || '').toLowerCase()
    if (
      (alertText.includes('tech pack') && check.includes('tech pack')) ||
      (alertText.includes('spec') && (check.includes('spec') || check.includes('size') || check.includes('material') || check.includes('finish'))) ||
      (alertText.includes('weight') && (check.includes('weight') || check.includes('material'))) ||
      (alertText.includes('artwork') && (check.includes('artwork') || check.includes('color'))) ||
      (alertText.includes('currency') && (check.includes('price') || check.includes('value'))) ||
      (alertText.includes('price') && (check.includes('price') || check.includes('value') || check.includes('cost'))) ||
      (alertText.includes('cost') && (check.includes('price') || check.includes('cost'))) ||
      (alertText.includes('rm') && (check.includes('rm') || check.includes('bom') || check.includes('lead time') || check.includes('source'))) ||
      (alertText.includes('delay') && (check.includes('date') || check.includes('lead time') || check.includes('inline') || check.includes('final'))) ||
      (alertText.includes('barcode') && (check.includes('barcode') || check.includes('label'))) ||
      (alertText.includes('label') && check.includes('label')) ||
      (alertText.includes('carton') && check.includes('carton')) ||
      (alertText.includes('approval') && check.includes('approval')) ||
      (alertText.includes('inspection') && (check.includes('inspection') || check.includes('final'))) ||
      (alertText.includes('qty') && (check.includes('qty') || check.includes('quantity'))) ||
      (alertText.includes('shipment') && (check.includes('invoice') || check.includes('packing') || check.includes('etd'))) ||
      (alertText.includes('vessel') && check.includes('etd')) ||
      (alertText.includes('bl') && check.includes('bl'))
    ) byKeyword.push(idx)
  })
  return [...new Set(byKeyword)]
}

function finalInspectionOutcomeAlertIdx() {
  const fin = STAGE_CARD_DEFS.find((s) => s.id === 'final')
  if (!fin?.alerts) return -1
  return fin.alerts.findIndex((a) => /inspection outcome/i.test(String(a)))
}

module.exports = {
  STAGE_CARD_DEFS,
  EXCEPTION_CARDS,
  MANDATORY_TO_ALERT_DEPENDENCIES,
  MANDATORY_TO_ALERT_ITEM_DEPENDENCIES,
  STAGE_OWNERS,
  getAlertChecklist,
  alertNeedsFileUpload,
  stageTitle,
  riskOrder,
  getAlertDependencies,
  finalInspectionOutcomeAlertIdx,
}
