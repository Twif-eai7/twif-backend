const supabase = require('../supabaseClient')

function chunkArray(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// PostgREST caps URL length, so any .in(column, [...ids]) whose list size scales with
// the whole dataset (not one user's own data) needs chunking — same gotcha hit building
// the tech-dept Activity Log (see src/hooks/plmWorkspaceDiscovery.js on the frontend).
async function fetchInChunks(table, select, column, ids, extra = q => q) {
  if (!ids.length) return []
  const chunks = chunkArray(ids, 150)
  const results = await Promise.all(
    chunks.map(chunk => extra(supabase.from(table).select(select).in(column, chunk)))
  )
  const rows = []
  for (const { data, error } of results) {
    if (error) console.error(`[plm-admin-discovery] chunked query on ${table} failed:`, error.message)
    rows.push(...(data || []))
  }
  return rows
}

module.exports = { chunkArray, fetchInChunks }
