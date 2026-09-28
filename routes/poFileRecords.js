const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')

const ALLOWED_BUCKETS = ['POFY26', 'POFY25', 'InvoicesFY26','POFY27']

// Storage folders go buyer → month → day (→ optional nested subfolder) → files, and Supabase
// Storage's list() only returns one level at a time, so getting a buyer's real PO count means
// walking every level and summing the leaf (id !== null) entries.
async function countFilesRecursive(bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).list(path, { limit: 1000 })
  if (error || !data) return 0

  // Supabase Storage has no real folders — an empty one is represented by a hidden
  // .emptyFolderPlaceholder object, which has a real id and would otherwise get counted
  // as a genuine PO file.
  const files   = data.filter(i => i.id !== null && i.name !== '.emptyFolderPlaceholder')
  const folders = data.filter(i => i.id === null)
  const nestedCounts = await Promise.all(
    folders.map(f => countFilesRecursive(bucket, `${path}/${f.name}`))
  )
  return files.length + nestedCounts.reduce((a, b) => a + b, 0)
}

router.get('/',async (req, res) => {
  const { bucket, memberId } = req.query

  if (!ALLOWED_BUCKETS.includes(bucket)) {
    return res.status(400).json({ error: 'Invalid bucket' })
  }

    // ── Step 1: Get all orgs the member has access to ──
  const { data: accessRows, error: accessError } = await supabase
    .from('member_organization_access')
    .select('organization_id')
    .eq('member_id', memberId)

  if (accessError || !accessRows?.length) {
    return res.status(403).json({ error: 'No organization access found' })
  }

  const orgIds = accessRows.map(r => r.organization_id)

  // ── Step 2: Get display names for all orgs ──
  const { data: orgs, error: orgsError } = await supabase
    .from('organizations')
    .select('id, display_name')
    .in('id', orgIds)
    .order('display_name', { ascending: true })

  if (orgsError || !orgs?.length) {
    return res.status(403).json({ error: 'Organizations not found' })
  }

  // ── Step 3: List files for each org folder ──
  const results = await Promise.all(
    orgs.map(async (org) => {
      const safeName = org.display_name
        .replace(/[^a-zA-Z0-9 _-]/g, '')
        .trim()

      const { data, error } = await supabase.storage
        .from(bucket)
        .list(safeName, { limit: 1000 })

      const fileCount = await countFilesRecursive(bucket, safeName)

      return {
        orgId: org.id,
        displayName: org.display_name,
        basePath: safeName,
        items: error ? [] : data,
        fileCount,
      }
    })
  )
  const filteredResults = results.filter(buyer => buyer.items && buyer.items.length > 0)
  res.json({ buyers: results })
})

// Level 2: click a month → get day folders
router.get('/month', async (req, res) => {
  const { bucket, path } = req.query
  // path = "HOUSE DOCTOR/March"

  if (!ALLOWED_BUCKETS.includes(bucket)) {
    return res.status(400).json({ error: 'Invalid bucket' })
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .list(path, { limit: 1000 })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ items: data })
})

// Level 3: click a day/subfolder → get files
router.get('/folder', async (req, res) => {
  const { bucket, path } = req.query
  // path = "HOUSE DOCTOR/March/15" or "HOUSE DOCTOR/March/15/PO-123"

  if (!ALLOWED_BUCKETS.includes(bucket)) {
    return res.status(400).json({ error: 'Invalid bucket' })
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .list(path, { limit: 1000 })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ items: data })
})

module.exports = router