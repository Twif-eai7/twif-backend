const backend = require('../service/pctStageDefs')

// Minimal mirror of frontend STAGE_CARDS for drift detection (IDs, checks, alerts)
const frontendStageCards = [
  { id: 'po', checks: ['Buyer PO uploaded', 'Tech pack attached', 'Price lock created', 'Ex-factory date locked'], alerts: ['PO vs cost sheet mismatch', 'Missing tech pack', 'Currency mismatch'] },
  { id: 'tech', checks: ['Size tolerance', 'Weight tolerance', 'Material / finish', 'Color code / artwork', 'Approved reference sample'], alerts: ['Size spec missing', 'Weight missing', 'Artwork not approved', 'Spec changed after PO'] },
  { id: 'rm', checks: ['BOM freeze', 'RM quantity', 'Lead time', 'RM costing', 'Alternative source'], alerts: ['RM delay', 'RM cost variance >3%', 'Material grade mismatch', 'Insufficient stock'] },
  { id: 'pack', checks: ['Barcode approved', 'Shipping marks', 'Drop test protocol', 'Label legal text', 'Master carton spec'], alerts: ['Barcode mismatch', 'Label compliance missing', 'Carton gsm mismatch'] },
  { id: 'pp', checks: ['PP date', 'Inline date', 'Midline date', 'Final insp. date', 'Buyer comments closure'], alerts: ['PP sample pending', 'No approval', 'Critical comments open'] },
  { id: 'bulk', checks: ['Line allocation', 'Daily output', 'WIP variance', 'Rework log'], alerts: ['Output lag', 'Capacity overload', 'Tech spec drift'] },
  { id: 'inline', checks: ['Workmanship', 'Size & weight', 'Finish'], alerts: ['AQL risk', 'Size drift'] },
  { id: 'midline', checks: ['Packing method', 'Corrective action'], alerts: ['Wrong finish', 'Wrong accessories'] },
  { id: 'final', checks: ['Final inspection', 'Invoice check', 'Packing list', 'HS code', 'Value check'], alerts: ['Wrong price in invoice', 'Qty mismatch', 'Inspection outcome', 'Shipment without docs'] },
  { id: 'ship', checks: ['Container booking', 'Stuffing confirmation', 'BL readiness', 'ETD lock'], alerts: ['Missed vessel', 'Late cargo readiness', 'BL delay'] },
]

function assertEqual(label, a, b) {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa !== sb) {
    console.error(`FAIL: ${label}`)
    console.error('  expected:', sb)
    console.error('  actual:  ', sa)
    process.exit(1)
  }
  console.log(`PASS: ${label}`)
}

assertEqual('stage IDs match',
  backend.STAGE_CARD_DEFS.map((s) => s.id),
  frontendStageCards.map((s) => s.id))

assertEqual('checks match',
  backend.STAGE_CARD_DEFS.map((s) => s.checks),
  frontendStageCards.map((s) => s.checks))

assertEqual('alerts match',
  backend.STAGE_CARD_DEFS.map((s) => s.alerts),
  frontendStageCards.map((s) => s.alerts))

console.log('All pctStageDefs drift tests passed.')
