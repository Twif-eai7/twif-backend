const INDIA_PIN_RE = /\b[1-9]\d{5}\b/
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/i
const US_ZIP_RE = /\b\d{5}(?:-\d{4})?\b/
const EU_ZIP_4_RE = /\b\d{4}\b/

function extractIndiaPincode(text) {
  const match = text?.match(INDIA_PIN_RE)
  return match ? match[0] : ''
}

function extractIntlPostal(text) {
  if (!text) return ''
  const uk = text.match(UK_POSTCODE_RE)
  if (uk) return uk[0].toUpperCase().replace(/\s+/g, ' ').trim()
  const us = text.match(US_ZIP_RE)
  if (us) return us[0]
  const india = extractIndiaPincode(text)
  if (india) return india
  const eu = text.match(EU_ZIP_4_RE)
  return eu ? eu[0] : ''
}

async function fetchOrgZipMap(names) {
  const supabase = require('../supabaseClient')
  const map = {}
  const unique = [...new Set((names || []).filter(Boolean))]
  if (!unique.length) return map

  const { data: byDisplay } = await supabase
    .from('organizations')
    .select('display_name, name, zip')
    .in('display_name', unique)

  for (const org of byDisplay || []) {
    if (!org.zip) continue
    if (org.display_name) map[org.display_name] = org.zip
    if (org.name) map[org.name] = org.zip
  }

  const missing = unique.filter(n => !map[n])
  if (!missing.length) return map

  const { data: byName } = await supabase
    .from('organizations')
    .select('display_name, name, zip')
    .in('name', missing)

  for (const org of byName || []) {
    if (!org.zip) continue
    if (org.display_name) map[org.display_name] = org.zip
    if (org.name) map[org.name] = org.zip
  }

  return map
}

async function enrichInternationalLogs(logs) {
  if (!logs?.length) return logs || []

  const orgZips = await fetchOrgZipMap([
    ...logs.filter(l => !l.zip_code_V && l.vendor_name).map(l => l.vendor_name),
    ...logs.filter(l => !l.zip_code_B && l.buyer_name).map(l => l.buyer_name),
  ])

  return logs.map(log => ({
    ...log,
    zip_code_V: log.zip_code_V || extractIndiaPincode(log.vendor_address) || orgZips[log.vendor_name] || '',
    zip_code_B: log.zip_code_B || extractIntlPostal(log.buyer_address) || orgZips[log.buyer_name] || '',
  }))
}

async function enrichDomesticLogs(logs) {
  if (!logs?.length) return logs || []

  const orgZips = await fetchOrgZipMap(
    logs.filter(l => !l.zip_code && l.vendor_name).map(l => l.vendor_name)
  )

  return logs.map(log => ({
    ...log,
    zip_code: log.zip_code || extractIndiaPincode(log.vendor_address) || orgZips[log.vendor_name] || '',
  }))
}

module.exports = { enrichInternationalLogs, enrichDomesticLogs }
