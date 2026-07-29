// =============================================================
// NPD Catalog + Session routes
//
// Drop-in replacement for the existing /npd route file. Keeps
// every route you already had; adds the catalog-pool routes and
// rewrites POST /sessions to clone catalog SKUs into session SKUs.
//
// Expects (same as before):
//   - supabaseClient (Supabase admin client)
//   - upload (multer instance)
//   - AdmZip for .pptx unzip
//   - NPD_BUCKET = 'npd-prototype'
// =============================================================

const express  = require('express')
const path     = require('path')
const AdmZip   = require('adm-zip')
const router   = express.Router()
const supabase = require('../supabaseClient')
const upload   = require('../upload')

const NPD_BUCKET = 'npd'

// ─── helpers ──────────────────────────────────────────────────────────────────

const generateAutoCode = () => {
  const num = Math.floor(10000 + Math.random() * 90000)
  return `SKU-${num}`
}

// extract images from pptx — unchanged from your existing helper
const extractImagesFromPptx = (fileBuffer) => {
  const zip = new AdmZip(fileBuffer)
  const entries = zip.getEntries()

  return entries
    .filter(e =>
      e.entryName.startsWith('ppt/media/') &&
      /\.(jpg|jpeg|png|gif|webp)$/i.test(e.entryName)
    )
    .sort((a, b) => a.entryName.localeCompare(b.entryName))
    .map((e, i) => ({
      buffer:     e.getData(),
      slideIndex: i,
      name:       e.entryName,
      mimeType:   e.entryName.match(/\.png$/i) ? 'image/png' : 'image/jpeg',
    }))
}

// placeholder — wire up pdfjs-dist or pdf-img-convert when ready
const extractImagesFromPdf = async () => {
  throw new Error('PDF extraction not yet implemented — please upload .pptx for now')
}

const uploadImageToStorage = async (buffer, storagePath, mimeType = 'image/jpeg') => {
  const { error } = await supabase.storage
    .from(NPD_BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType, upsert: false })
  if (error) throw error
  const { data } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)
  return data.publicUrl
}

const insertSystemComment = async (skuId, authorId, role, type, body, metadata) => {
  const { error } = await supabase
    .from('npd_comments')
    .insert([{ sku_id: skuId, author_id: authorId, role, type, body, metadata }])
  if (error) throw error
}


// ═════════════════════════════════════════════════════════════════════════════
// CATALOG — pool browsing and uploads
// ═════════════════════════════════════════════════════════════════════════════

// GET /npd/catalog
// Returns pool SKUs, flattened with supplier/season/category from their upload.
// Query params: supplier, season, category, search, customerId, role
// Buyers and merchants both hit this — merchants can also see archived via ?includeArchived=1
router.get('/catalog', async (req, res) => {
  try {
    const { customerId, role, supplier, season, category, search, includeArchived } = req.query
    if (!customerId) return res.status(400).json({ error: 'customerId required' })

    let query = supabase
      .from('npd_catalog_skus')
      .select(`
        *,
        npd_catalog_uploads!inner (
          id, supplier, season, category, merchant_id
        )
      `)
      .order('created_at', { ascending: false })

    // only merchants see archived
    if (!includeArchived || role !== 'merchant') {
      query = query.eq('is_archived', false)
    }

    // filter on joined upload fields
    if (supplier) query = query.eq('npd_catalog_uploads.supplier', supplier)
    if (season)   query = query.eq('npd_catalog_uploads.season', season)
    if (category) query = query.eq('npd_catalog_uploads.category', category)

    const { data, error } = await query
    if (error) throw error

    // flatten + optional text search (client-side over fetched rows, simpler than Postgres ilike here)
    let skus = (data || []).map(row => ({
      id:          row.id,
      auto_code:   row.auto_code,
      image_url:   row.image_url,
      slide_index: row.slide_index,
      description: row.description,
      category:    row.category || row.npd_catalog_uploads.category,
      material:    row.material,
      dimensions:  row.dimensions,
      finish:      row.finish,
      weight:      row.weight,              // ← add this
      supplier:    row.npd_catalog_uploads.supplier,
      season:      row.npd_catalog_uploads.season,
      created_at:  row.created_at,
    }))

    if (search) {
      const q = search.toLowerCase()
      skus = skus.filter(s =>
        (s.description || '').toLowerCase().includes(q) ||
        (s.auto_code || '').toLowerCase().includes(q)
      )
    }

    // suppliers + seasons for filter chips
    const suppliers = [...new Set(skus.map(s => s.supplier).filter(Boolean))].sort()
    const seasons   = [...new Set(skus.map(s => s.season).filter(Boolean))].sort()

    return res.json({ skus, total: skus.length, suppliers, seasons })
  } catch (err) {
    console.error('❌ GET /npd/catalog:', err)
    return res.status(500).json({ error: err.message })
  }
})


// POST /npd/catalog/upload  (multipart)
// form: catalogFile, supplier, season, category (optional), customerId
// Creates an npd_catalog_upload row, extracts images, creates npd_catalog_sku
// rows. Does NOT create an npd_session.
router.post('/catalog/upload', upload.single('catalogFile'), async (req, res) => {
  const file = req.file
  const { supplier, season, category, customerId } = req.body

  try {
    if (!file)             return res.status(400).json({ error: 'catalogFile required' })
    if (!supplier?.trim()) return res.status(400).json({ error: 'supplier required' })
    if (!season?.trim())   return res.status(400).json({ error: 'season required' })
    if (!customerId)       return res.status(400).json({ error: 'customerId required' })

    const ext    = path.extname(file.originalname).toLowerCase()
    const isPptx = ext === '.pptx'
    const isPdf  = ext === '.pdf'
    if (!isPptx && !isPdf) {
      return res.status(400).json({ error: 'Only .pptx and .pdf files supported' })
    }

    // 1) create catalog_upload row first so we have an id for storage paths
    const { data: uploadRow, error: uploadError } = await supabase
      .from('npd_catalog_uploads')
      .insert([{
        supplier:        supplier.trim(),
        season:          season.trim(),
        category:        category?.trim() || null,
        merchant_id:     customerId.trim(),
        source_filename: file.originalname,
      }])
      .select()
      .single()
    if (uploadError) throw uploadError

    // 2) store original file
    const safeOriginal = file.originalname.replace(/\s+/g, '_')
    const originalPath = `catalog/${uploadRow.id}/source/${Date.now()}_${safeOriginal}`
    const { error: srcUploadError } = await supabase.storage
      .from(NPD_BUCKET)
      .upload(originalPath, file.buffer, { contentType: file.mimetype, upsert: false })
    if (srcUploadError) throw srcUploadError
    const { data: srcUrl } = supabase.storage.from(NPD_BUCKET).getPublicUrl(originalPath)

    await supabase
      .from('npd_catalog_uploads')
      .update({ source_file_url: srcUrl.publicUrl })
      .eq('id', uploadRow.id)

    // 3) extract images
    const images = isPptx
      ? extractImagesFromPptx(file.buffer)
      : await extractImagesFromPdf(file.buffer)

    if (!images.length) {
      // clean up the empty upload row
      await supabase.from('npd_catalog_uploads').delete().eq('id', uploadRow.id)
      return res.status(422).json({ error: 'No images could be extracted from this file' })
    }

    // 4) upload images + create catalog_sku rows
    const skusCreated = []
    for (const { buffer, slideIndex, mimeType } of images) {
      const autoCode  = generateAutoCode()
      const imgExt    = mimeType === 'image/png' ? 'png' : 'jpg'
      const storPath  = `catalog/${uploadRow.id}/skus/${autoCode}.${imgExt}`
      const imageUrl  = await uploadImageToStorage(buffer, storPath, mimeType)

      const { data: sku, error: skuError } = await supabase
        .from('npd_catalog_skus')
        .insert([{
          catalog_upload_id: uploadRow.id,
          auto_code:         autoCode,
          image_url:         imageUrl,
          slide_index:       slideIndex,
          category:          uploadRow.category,    // inherit, merchant can override
        }])
        .select()
        .single()
      if (skuError) throw skuError

      skusCreated.push({
        ...sku,
        supplier: uploadRow.supplier,
        season:   uploadRow.season,
      })
    }

    // 5) cache the count
    await supabase
      .from('npd_catalog_uploads')
      .update({ sku_count: skusCreated.length })
      .eq('id', uploadRow.id)

    console.log(`✅ Catalog upload ${uploadRow.id}: ${skusCreated.length} SKUs`)
    return res.json({
      success:     true,
      upload:      uploadRow,
      skusCreated: skusCreated.length,
      skus:        skusCreated,
    })
  } catch (err) {
    console.error('❌ POST /npd/catalog/upload:', err)
    return res.status(500).json({ error: err.message })
  }
})

router.get('/catalog/skus/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { data: sku, error } = await supabase
      .from('npd_catalog_skus')
      .select(`
        *,
        npd_catalog_uploads (
          supplier,
          season,
          category,
          source_file_url
        )
      `)
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    if (!sku) return res.status(404).json({ error: 'Catalog SKU not found' })

    const result = {
      id:                sku.id,
      auto_code:         sku.auto_code,
      image_url:         sku.image_url,
      slide_index:       sku.slide_index,
      description:       sku.description,
      category:          sku.category || sku.npd_catalog_uploads?.category,
      material:          sku.material,
      dimensions:        sku.dimensions,
      finish:            sku.finish,
      weight:            sku.weight,        // ← add this
      is_archived:       sku.is_archived,
      created_at:        sku.created_at,
      supplier:          sku.npd_catalog_uploads?.supplier,
      season:            sku.npd_catalog_uploads?.season,
      catalog_upload_id: sku.catalog_upload_id,
    }

    return res.json({ sku: result })
  } catch (err) {
    console.error('❌ GET /npd/catalog/skus/:id:', err)
    return res.status(500).json({ error: err.message })
  }
})

// PATCH /npd/catalog/skus/:id
// Merchant edits pool SKU attributes (name, dimensions, material, finish, category)
router.patch('/catalog/skus/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { customerId, role, ...fields } = req.body

    if (!customerId || !role) {
      return res.status(400).json({ error: 'customerId and role required' })
    }
    if (role !== 'merchant') {
      return res.status(403).json({ error: 'Only merchants can edit catalog SKUs' })
    }

    const allowed = ['description', 'dimensions', 'material', 'weight', 'finish', 'category']
    const updates = {}
    for (const field of allowed) {
      if (fields[field] !== undefined) {
        updates[field] = fields[field] === '' ? null : fields[field]
      }
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    const { data, error } = await supabase
      .from('npd_catalog_skus')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error

    return res.json({ success: true, sku: data })
  } catch (err) {
    console.error('❌ PATCH /npd/catalog/skus/:id:', err)
    return res.status(500).json({ error: err.message })
  }
})


// DELETE /npd/catalog/skus/:id (soft)
// Archives a pool SKU so buyers no longer see it. Existing cloned
// npd_skus in buyer sessions are untouched.
router.delete('/catalog/skus/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { customerId, role } = req.query

    if (role !== 'merchant') {
      return res.status(403).json({ error: 'Only merchants can archive catalog SKUs' })
    }

    const { error } = await supabase
      .from('npd_catalog_skus')
      .update({ is_archived: true })
      .eq('id', id)
    if (error) throw error

    return res.json({ success: true })
  } catch (err) {
    console.error('❌ DELETE /npd/catalog/skus/:id:', err)
    return res.status(500).json({ error: err.message })
  }
})


// ═════════════════════════════════════════════════════════════════════════════
// SESSIONS
// ═════════════════════════════════════════════════════════════════════════════

// GET /npd/sessions — unchanged from your existing route
router.get('/sessions', async (req, res) => {
  try {
    const { customerId, role } = req.query
    if (!customerId) return res.status(400).json({ error: 'customerId required' })
    if (!role)       return res.status(400).json({ error: 'role required' })

    const query = supabase
      .from('npd_sessions')
      .select(`*, npd_skus ( id, status, stage )`)
      .order('created_at', { ascending: false })

    const { data, error } = role === 'merchant'
      ? await query.eq('merchant_id', customerId)
      : await query.eq('buyer_id', customerId)

    if (error) throw error
    return res.json({ sessions: data })
  } catch (err) {
    console.error('❌ GET /npd/sessions:', err)
    return res.status(500).json({ error: err.message })
  }
})

router.get('/catalog/skus/:id/sessions', async (req, res) => {
  const { id } = req.params
  const { merchantId } = req.query

  const { data, error } = await supabase
    .from('npd_skus')
    .select(`
      id, status, stage, auto_code,
      npd_sessions!inner (
        id, name, buyer_id, merchant_id, season, supplier, status,
        npd_invites ( email, role, accepted_at )
        )
    `)
    .eq('source_catalog_sku_id', id)
    .eq('npd_sessions.merchant_id', merchantId)

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ sessions: data || [] })
})


// POST /npd/sessions
// Creates a session AND clones selected catalog SKUs into npd_skus rows.
// Body: { name, supplier, season, category?, buyerId?, customerId, skuIds: [] }
//   skuIds — catalog SKU IDs the buyer picked from the pool.
//   If empty, session is created empty (merchant flow, legacy upload etc.)
router.post('/sessions', async (req, res) => {
  try {
    const { name, supplier, season, category, buyerId, customerId, skuIds } = req.body

    if (!name?.trim())     return res.status(400).json({ error: 'name required' })
    if (!supplier?.trim()) return res.status(400).json({ error: 'supplier required' })
    if (!season?.trim())   return res.status(400).json({ error: 'season required' })
    if (!customerId)       return res.status(400).json({ error: 'customerId required' })

    const pickedSkuIds = Array.isArray(skuIds) ? skuIds.filter(Boolean) : []

    // 1) create session. merchant_id defaults to customerId if buyer is the creator
    // (prototype: whoever creates is the merchant_id of record; refine later if needed).
    // If the buyer is creating from their selection, they are buyer_id and also the
    // authenticated creator — we still need a merchant_id. For the prototype we look
    // up the catalog upload's merchant_id and use that.
    let merchantId = customerId
    if (pickedSkuIds.length) {
      const { data: firstSku, error: lookupError } = await supabase
        .from('npd_catalog_skus')
        .select(`npd_catalog_uploads ( merchant_id )`)
        .eq('id', pickedSkuIds[0])
        .maybeSingle()
      if (lookupError) throw lookupError
      if (firstSku?.npd_catalog_uploads?.merchant_id) {
        merchantId = firstSku.npd_catalog_uploads.merchant_id
      }
    }

    const { data: session, error: sessionError } = await supabase
      .from('npd_sessions')
      .insert([{
        name:        name.trim(),
        supplier:    supplier.trim(),
        season:      season.trim(),
        category:    category?.trim() || null,
        merchant_id: merchantId,
        buyer_id:    (buyerId || customerId)?.trim() || null,
        status:      pickedSkuIds.length ? 'active' : 'draft',
      }])
      .select()
      .single()
    if (sessionError) throw sessionError

    // 2) clone each picked catalog SKU into an npd_skus row
    const cloned = []
    if (pickedSkuIds.length) {
      const { data: pool, error: poolError } = await supabase
        .from('npd_catalog_skus')
        .select('*')
        .in('id', pickedSkuIds)
      if (poolError) throw poolError

      for (const p of pool || []) {
        const { data: clone, error: cloneError } = await supabase
          .from('npd_skus')
          .insert([{
            session_id:            session.id,
            source_catalog_sku_id: p.id,
            auto_code:             p.auto_code,     // keep the code so buyer + merchant can refer to it
            image_url:             p.image_url,
            slide_index:           p.slide_index,
            description:           p.description,
            category:              p.category,
            material:              p.material,
            dimensions:            p.dimensions,
            finish:                p.finish,
            status:                'new',
            stage:                 'negotiation',
          }])
          .select()
          .single()
        if (cloneError) throw cloneError
        cloned.push(clone)
      }
    }

    console.log(`✅ Session ${session.id} created with ${cloned.length} cloned SKUs`)
    return res.json({ success: true, session, skus: cloned })
  } catch (err) {
    console.error('❌ POST /npd/sessions:', err)
    return res.status(500).json({ error: err.message })
  }
})


// PATCH /npd/sessions/:id — unchanged
router.patch('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, buyerId, status, category } = req.body

    const updates = {}
    if (name)     updates.name     = name.trim()
    if (buyerId)  updates.buyer_id = buyerId.trim()
    if (status)   updates.status   = status.trim()
    if (category) updates.category = category.trim()

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    const { data, error } = await supabase
      .from('npd_sessions')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return res.json({ success: true, session: data })
  } catch (err) {
    console.error('❌ PATCH /npd/sessions/:id:', err)
    return res.status(500).json({ error: err.message })
  }
})


// POST /npd/sessions/:id/add-skus
// Adds more catalog SKUs to an existing session (buyer expanding their selection
// after initial creation). Body: { skuIds: [], customerId }
router.post('/sessions/:id/add-skus', async (req, res) => {
  try {
    const { id: sessionId } = req.params
    const { skuIds, customerId } = req.body

    if (!customerId)                 return res.status(400).json({ error: 'customerId required' })
    if (!Array.isArray(skuIds) || !skuIds.length) {
      return res.status(400).json({ error: 'skuIds array required' })
    }

    // check session exists and belongs to buyer
    const { data: session, error: sessionError } = await supabase
      .from('npd_sessions')
      .select('id, buyer_id')
      .eq('id', sessionId)
      .maybeSingle()
    if (sessionError) throw sessionError
    if (!session) return res.status(404).json({ error: 'Session not found' })
    if (session.buyer_id && session.buyer_id !== customerId) {
      return res.status(403).json({ error: 'Not your session' })
    }

    // pull catalog SKUs
    const { data: pool, error: poolError } = await supabase
      .from('npd_catalog_skus')
      .select('*')
      .in('id', skuIds)
    if (poolError) throw poolError

    // skip catalog SKUs already cloned into this session
    const { data: existing } = await supabase
      .from('npd_skus')
      .select('source_catalog_sku_id')
      .eq('session_id', sessionId)
      .in('source_catalog_sku_id', skuIds)
    const existingSet = new Set((existing || []).map(r => r.source_catalog_sku_id))

    const cloned = []
    for (const p of pool || []) {
      if (existingSet.has(p.id)) continue
      const { data: clone, error: cloneError } = await supabase
        .from('npd_skus')
        .insert([{
          session_id:            sessionId,
          source_catalog_sku_id: p.id,
          auto_code:             p.auto_code,
          image_url:             p.image_url,
          slide_index:           p.slide_index,
          description:           p.description,
          category:              p.category,
          material:              p.material,
          dimensions:            p.dimensions,
          finish:                p.finish,
          status:                'new',
          stage:                 'negotiation',
        }])
        .select()
        .single()
      if (cloneError) throw cloneError
      cloned.push(clone)
    }

    return res.json({ success: true, skusAdded: cloned.length, skus: cloned, skipped: skuIds.length - cloned.length })
  } catch (err) {
    console.error('❌ POST /npd/sessions/:id/add-skus:', err)
    return res.status(500).json({ error: err.message })
  }
})


// ═════════════════════════════════════════════════════════════════════════════
// SESSION SKUS (existing — session-scoped, unchanged)
// ═════════════════════════════════════════════════════════════════════════════

// GET /npd/sessions/:id/skus
router.get('/sessions/:id/skus', async (req, res) => {
  try {
    const { id: sessionId } = req.params
    const { data, error } = await supabase
      .from('npd_skus')
      .select(`*, npd_comments ( id )`)
      .eq('session_id', sessionId)
      .order('slide_index', { ascending: true })
    if (error) throw error
    return res.json({ skus: data })
  } catch (err) {
    console.error('❌ GET /npd/sessions/:id/skus:', err)
    return res.status(500).json({ error: err.message })
  }
})


// GET /npd/skus/:id
router.get('/skus/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { data: sku, error } = await supabase
      .from('npd_skus')
      .select(`
        *,
        npd_sessions ( name, supplier, season, category ),
        npd_comments ( * ),
        npd_sample_orders ( * )
      `)
      .eq('id', id)
      .order('created_at', { referencedTable: 'npd_comments', ascending: true })
      .maybeSingle()
    if (error) throw error
    if (!sku) return res.status(404).json({ error: 'SKU not found' })
    return res.json({ sku })
  } catch (err) {
    console.error('❌ GET /npd/skus/:id:', err)
    return res.status(500).json({ error: err.message })
  }
})

// PATCH /plm/workspaces/:id  — update workspace fields including buyer_brief
router.patch('/workspaces/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { customerId, role, ...fields } = req.body
    if (!customerId) return res.status(400).json({ error: 'customerId required' })

    const allowed = [
      'buyer_ref', 'vendor_stock_number', 'target_price', 'target_qty',
      'buyer_brief', 'workspace_status', 'priority', 'supplier_in_buyer_chat',
      'brief_description', 'brief_material', 'brief_weight', 'brief_dimensions',
      'brief_finish', 'brief_color', 'brief_quality_notes'
    ]
    const updates = {}
    for (const field of allowed) {
      if (fields[field] !== undefined) updates[field] = fields[field]
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    // Log field changes as system comments
    const trackFields = ['buyer_ref', 'vendor_stock_number', 'target_price', 'target_qty']
    const { data: current } = await supabase
      .from('npd_skus').select(trackFields.join(',')).eq('id', id).maybeSingle()

    const { data: updated, error } = await supabase
      .from('npd_skus').update(updates).eq('id', id).select().single()
    if (error) throw error

    if (current && role) {
      for (const field of trackFields) {
        if (updates[field] !== undefined && String(updates[field] ?? '') !== String(current[field] ?? '')) {
          await insertSystemComment(id, customerId, role, 'field_change', null, {
            field, from: String(current[field] ?? ''), to: String(updates[field])
          })
        }
      }
    }

    return res.json({ success: true, workspace: updated })
  } catch (err) {
    console.error('❌ PATCH /plm/workspaces/:id:', err)
    return res.status(500).json({ error: err.message })
  }
})

// GET /plm/workspaces/:id
router.get('/workspaces/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { customerId, role } = req.query

    const { data: workspace, error } = await supabase
      .from('npd_skus')
      .select(`
        *,
        npd_sessions ( *, npd_invites ( * ) ),
        npd_comments ( * ),
        npd_sample_orders ( * )
      `)
      .eq('id', id)
      .order('created_at', { referencedTable: 'npd_comments', ascending: true })
      .maybeSingle()

    if (error) throw error
    if (!workspace) return res.status(404).json({ error: 'Invite Buyer to Start PD' })

    const session = workspace.npd_sessions || {}
    const result = {
      ...workspace,
      supplier:          session.supplier,
      season:            session.season,
      workspace_status:  workspace.workspace_status || 'to_do',
      priority:          workspace.priority || 'normal',
      npd2_invites:      session.npd_invites || [],
      npd_comments:      workspace.npd_comments || [],
      npd_sample_orders: workspace.npd_sample_orders || [],
    }

    return res.json({ workspace: result })
  } catch (err) {
    console.error('❌ GET /plm/workspaces/:id:', err)
    return res.status(500).json({ error: err.message })
  }
})

// GET /plm/catalog/skus/:id/workspaces
router.get('/catalog/skus/:id/workspaces', async (req, res) => {
  try {
    const { id } = req.params
    const { merchantId, userId, role } = req.query

    let query = supabase
      .from('npd_skus')
      .select(`*, npd_sessions!inner ( *, npd_invites ( * ) )`)
      .eq('source_catalog_sku_id', id)

    if (merchantId) query = query.eq('npd_sessions.merchant_id', merchantId)
    if (userId && role === 'buyer') query = query.eq('npd_sessions.buyer_id', userId)

    const { data, error } = await query
    if (error) throw error

    const workspaces = (data || []).map(row => ({
      ...row,
      supplier:     row.npd_sessions?.supplier,
      season:       row.npd_sessions?.season,
      buyer_id:     row.npd_sessions?.buyer_id,
      npd2_invites: row.npd_sessions?.npd_invites || [],
    }))

    return res.json({ workspaces })
  } catch (err) {
    console.error('❌ GET /plm/catalog/skus/:id/workspaces:', err)
    return res.status(500).json({ error: err.message })
  }
})

// POST /plm/workspaces  — create workspace from catalogSkuId
router.post('/workspaces', async (req, res) => {
  try {
    const { catalogSkuId, merchantId, buyerEmail, supplierEmail } = req.body
    if (!catalogSkuId || !merchantId) return res.status(400).json({ error: 'catalogSkuId and merchantId required' })
    if (!buyerEmail) return res.status(400).json({ error: 'buyerEmail required' })

    const { data: catalogSku, error: skuErr } = await supabase
      .from('npd_catalog_skus')
      .select('*, npd_catalog_uploads(supplier, season, merchant_id)')
      .eq('id', catalogSkuId).maybeSingle()
    if (skuErr || !catalogSku) return res.status(404).json({ error: 'Catalog SKU not found' })

    const sup = catalogSku.npd_catalog_uploads?.supplier
    const sea = catalogSku.npd_catalog_uploads?.season

    const { data: session, error: sessErr } = await supabase
      .from('npd_sessions')
      .insert([{ name: `${sea} — ${sup}`, supplier: sup, season: sea, merchant_id: merchantId, status: 'active' }])
      .select().single()
    if (sessErr) throw sessErr

    const { data: sku, error: skuInsErr } = await supabase
      .from('npd_skus')
      .insert([{
        session_id: session.id, source_catalog_sku_id: catalogSku.id,
        auto_code: catalogSku.auto_code, image_url: catalogSku.image_url,
        description: catalogSku.description, category: catalogSku.category,
        material: catalogSku.material, dimensions: catalogSku.dimensions,
        finish: catalogSku.finish, status: 'new', stage: 'negotiation'
      }])
      .select().single()
    if (skuInsErr) throw skuInsErr

    const token = require('crypto').randomUUID()
    await supabase.from('npd_invites').insert([{ sku_id: sku.id, email: buyerEmail, role: 'buyer', token }])

    const buyerLink = `https://YOUR-STORE.myshopify.com/pages/npd-access?token=${token}`
    const workspace = { ...sku, supplier: sup, season: sea, npd2_invites: [{ email: buyerEmail, role: 'buyer', accepted_at: null }] }

    return res.json({ success: true, workspace, buyerLink })
  } catch (err) {
    console.error('❌ POST /plm/workspaces:', err)
    return res.status(500).json({ error: err.message })
  }
})

// POST /plm/workspaces/:id/invite
router.post('/workspaces/:id/invite', async (req, res) => {
  try {
    const { id } = req.params
    const { email, role, customerId } = req.body
    if (!email || !role || !customerId) return res.status(400).json({ error: 'email, role, customerId required' })

    const token = require('crypto').randomUUID()
    await supabase.from('npd_invites').insert([{ sku_id: id, email, role, token }])

    const link = `https://YOUR-STORE.myshopify.com/pages/npd-access?token=${token}`
    return res.json({ success: true, token, link })
  } catch (err) {
    console.error('❌ POST /plm/workspaces/:id/invite:', err)
    return res.status(500).json({ error: err.message })
  }
})

// DELETE /plm/workspaces/:id/invite
router.delete('/workspaces/:id/invite', async (req, res) => {
  try {
    const { id } = req.params
    const { email } = req.query
    await supabase.from('npd_invites').delete().eq('sku_id', id).eq('email', email)
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// PATCH /plm/workspaces/:id/status
router.patch('/workspaces/:id/status', async (req, res) => {
  try {
    const { id } = req.params
    const { status, customerId, role } = req.body
    const { data, error } = await supabase.from('npd_skus').update({ status }).eq('id', id).select().single()
    if (error) throw error
    await insertSystemComment(id, customerId, role, 'milestone', null, { event: `status_changed_to_${status}` })
    return res.json({ success: true, workspace: data })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// POST /plm/workspaces/:id/approve
router.post('/workspaces/:id/approve', async (req, res) => {
  try {
    const { id } = req.params
    const { buyerRef, customerId } = req.body
    const { data: sku } = await supabase.from('npd_skus').select('target_price,target_qty').eq('id', id).single()
    if (!sku.target_price || !sku.target_qty) return res.status(400).json({ error: 'Set price and qty first' })
    const { data: updated } = await supabase.from('npd_skus').update({ status: 'approved', stage: 'sample', buyer_ref: buyerRef }).eq('id', id).select().single()
    const { data: order } = await supabase.from('npd_sample_orders').insert([{ sku_id: id, buyer_ref: buyerRef, confirmed_price: sku.target_price, confirmed_qty: sku.target_qty, sample_status: 'in_process' }]).select().single()
    await insertSystemComment(id, customerId, 'buyer', 'milestone', null, { event: 'moved_to_sample', buyer_ref: buyerRef })
    return res.json({ success: true, workspace: updated, sampleOrder: order })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// GET /plm/workspaces/:id/comments → POST /plm/workspaces/:id/comments
router.post('/workspaces/:id/comments', upload.array('attachments', 10), async (req, res) => {
  const uploadedPaths = []
  try {
    const { id } = req.params
    const { body, customerId, role, channel } = req.body
    const replyTo = req.body.reply_to ? JSON.parse(req.body.reply_to) : null

    const attachmentUrls = []
    for (const file of req.files || []) {
      const safeName = file.originalname.replace(/\s+/g, '_')
      const storagePath = `skus/${id}/attachments/${Date.now()}_${safeName}`
      const { error: upErr } = await supabase.storage.from(NPD_BUCKET).upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false })
      if (upErr) throw upErr
      uploadedPaths.push(storagePath)
      const { data: urlData } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)
      attachmentUrls.push(urlData.publicUrl)
    }

    const { data: comment, error } = await supabase.from('npd_comments')
      .insert([{ sku_id: id, author_id: customerId, role, type: 'comment', body: (body || '').trim() || null, attachments: attachmentUrls, channel: channel || 'buyer', reply_to: replyTo }])
      .select().single()
    if (error) throw error

    return res.json({ success: true, comment })
  } catch (err) {
    if (uploadedPaths.length) await supabase.storage.from(NPD_BUCKET).remove(uploadedPaths)
    return res.status(500).json({ error: err.message })
  }
})

// PATCH /plm/workspaces/:id/supplier-access
router.patch('/workspaces/:id/supplier-access', async (req, res) => {
  try {
    const { id } = req.params
    const { allow } = req.body
    const { error } = await supabase.from('npd_skus').update({ supplier_in_buyer_chat: allow }).eq('id', id)
    if (error) throw error
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})


// PATCH /npd/skus/:id — update live fields + log field_change comments
router.patch('/skus/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { customerId, role, ...fields } = req.body

    if (!customerId || !role) {
      return res.status(400).json({ error: 'customerId and role required' })
    }

    const allowed = ['description', 'dimensions', 'material', 'finish', 'target_price', 'target_qty', 'brief_type', 'category']    
    const updates = {}
    const changes = []

    const { data: current, error: fetchError } = await supabase
      .from('npd_skus')
      .select(allowed.join(', '))
      .eq('id', id)
      .maybeSingle()
    if (fetchError) throw fetchError
    if (!current) return res.status(404).json({ error: 'SKU not found' })

    for (const field of allowed) {
      if (fields[field] !== undefined && fields[field] !== current[field]) {
        updates[field] = fields[field]
        changes.push({ field, from: current[field], to: fields[field] })
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No changes detected' })
    }

    const { data: updated, error: updateError } = await supabase
      .from('npd_skus')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (updateError) throw updateError

    for (const change of changes) {
      await insertSystemComment(
        id, customerId, role,
        'field_change',
        null,
        { field: change.field, from: String(change.from ?? ''), to: String(change.to) }
      )
    }

    return res.json({ success: true, sku: updated })
  } catch (err) {
    console.error('❌ PATCH /npd/skus/:id:', err)
    return res.status(500).json({ error: err.message })
  }
})


// PATCH /npd/skus/:id/status
router.patch('/skus/:id/status', async (req, res) => {
  try {
    const { id } = req.params
    const { status, customerId, role } = req.body

    const allowed = ['new', 'reviewing', 'on_hold', 'rejected', 'approved']
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` })
    }
    if (!customerId || !role) {
      return res.status(400).json({ error: 'customerId and role required' })
    }

    const { data: sku, error: updateError } = await supabase
      .from('npd_skus')
      .update({ status })
      .eq('id', id)
      .select()
      .single()
    if (updateError) throw updateError

    await insertSystemComment(
      id, customerId, role,
      'milestone',
      null,
      { event: `status_changed_to_${status}`, stage: 'negotiation' }
    )

    return res.json({ success: true, sku })
  } catch (err) {
    console.error('❌ PATCH /npd/skus/:id/status:', err)
    return res.status(500).json({ error: err.message })
  }
})


// POST /npd/skus/:id/approve
router.post('/skus/:id/approve', async (req, res) => {
  try {
    const { id } = req.params
    const { buyerRef, customerId } = req.body

    if (!buyerRef?.trim()) return res.status(400).json({ error: 'buyerRef is required to approve' })
    if (!customerId)       return res.status(400).json({ error: 'customerId required' })

    const { data: sku, error: skuError } = await supabase
      .from('npd_skus')
      .select('id, status, target_price, target_qty')
      .eq('id', id)
      .maybeSingle()
    if (skuError) throw skuError
    if (!sku) return res.status(404).json({ error: 'SKU not found' })
    if (sku.status === 'approved') return res.status(409).json({ error: 'SKU already approved' })
    if (!sku.target_price || !sku.target_qty) {
      return res.status(400).json({ error: 'target_price and target_qty must be set before approving' })
    }

    const { data: existing } = await supabase
      .from('npd_sample_orders')
      .select('id')
      .eq('sku_id', id)
      .maybeSingle()
    if (existing) return res.status(409).json({ error: 'Sample order already exists for this SKU' })

    const { data: updatedSku, error: updateError } = await supabase
      .from('npd_skus')
      .update({ status: 'approved', stage: 'sample', buyer_ref: buyerRef.trim() })
      .eq('id', id)
      .select()
      .single()
    if (updateError) throw updateError

    const { data: sampleOrder, error: sampleError } = await supabase
      .from('npd_sample_orders')
      .insert([{
        sku_id:          id,
        buyer_ref:       buyerRef.trim(),
        confirmed_price: sku.target_price,
        confirmed_qty:   sku.target_qty,
        sample_status:   'in_process',
      }])
      .select()
      .single()
    if (sampleError) throw sampleError

    await insertSystemComment(
      id, customerId, 'buyer',
      'milestone',
      null,
      { event: 'moved_to_sample', stage: 'sample', buyer_ref: buyerRef.trim() }
    )

    return res.json({ success: true, sku: updatedSku, sampleOrder })
  } catch (err) {
    console.error('❌ POST /npd/skus/:id/approve:', err)
    return res.status(500).json({ error: err.message })
  }
})


// ═════════════════════════════════════════════════════════════════════════════
// COMMENTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /npd/skus/:id/comments
router.get('/skus/:id/comments', async (req, res) => {
  try {
    const { id } = req.params
    const { data, error } = await supabase
      .from('npd_comments')
      .select('*')
      .eq('sku_id', id)
      .order('created_at', { ascending: true })
    if (error) throw error
    return res.json({ comments: data })
  } catch (err) {
    console.error('❌ GET /npd/skus/:id/comments:', err)
    return res.status(500).json({ error: err.message })
  }
})


// POST /npd/skus/:id/comments  (supports multipart attachments)
router.post('/skus/:id/comments', upload.array('attachments', 10), async (req, res) => {
  const uploadedPaths = []
  try {
    const { id: skuId } = req.params
    const { body, customerId, role } = req.body

    if (!body?.trim() && !(req.files || []).length) {
      return res.status(400).json({ error: 'body or attachments required' })
    }
    if (!customerId) return res.status(400).json({ error: 'customerId required' })
    if (!role)       return res.status(400).json({ error: 'role required' })

    const attachmentUrls = []
    for (const file of req.files || []) {
      const safeName    = file.originalname.replace(/\s+/g, '_')
      const storagePath = `skus/${skuId}/attachments/${Date.now()}_${safeName}`
      const { error: upErr } = await supabase.storage
        .from(NPD_BUCKET)
        .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false })
      if (upErr) throw upErr
      uploadedPaths.push(storagePath)
      const { data: urlData } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)
      attachmentUrls.push(urlData.publicUrl)
    }

    const { data: comment, error } = await supabase
      .from('npd_comments')
      .insert([{
        sku_id:      skuId,
        author_id:   customerId,
        role:        role.trim(),
        type:        'comment',
        body:        (body || '').trim() || null,
        attachments: attachmentUrls,
      }])
      .select()
      .single()
    if (error) throw error

    return res.json({ success: true, comment })
  } catch (err) {
    console.error('❌ POST /npd/skus/:id/comments:', err)
    if (uploadedPaths.length) {
      await supabase.storage.from(NPD_BUCKET).remove(uploadedPaths)
    }
    return res.status(500).json({ error: err.message })
  }
})


// ═════════════════════════════════════════════════════════════════════════════
// SAMPLE ORDERS — unchanged
// ═════════════════════════════════════════════════════════════════════════════

router.get('/sample-orders', async (req, res) => {
  try {
    const { season, sampleStatus, customerId } = req.query
    if (!customerId) return res.status(400).json({ error: 'customerId required' })

    let query = supabase
      .from('npd_sample_orders')
      .select(`
        *,
        npd_skus (
          id, auto_code, buyer_ref, image_url, name, material, dimensions, finish,
          npd_sessions ( name, supplier, season, buyer_id, merchant_id )
        )
      `)
      .order('created_at', { ascending: false })

    if (sampleStatus) query = query.eq('sample_status', sampleStatus)

    const { data, error } = await query
    if (error) throw error

    const filtered = season
      ? data.filter(o => o.npd_skus?.npd_sessions?.season === season)
      : data

    return res.json({ sampleOrders: filtered })
  } catch (err) {
    console.error('❌ GET /npd/sample-orders:', err)
    return res.status(500).json({ error: err.message })
  }
})


router.patch('/sample-orders/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { customerId, role, ...fields } = req.body

    if (!customerId || !role) {
      return res.status(400).json({ error: 'customerId and role required' })
    }

    const allowed = [
      'go_ahead_date', 'sample_status', 'target_ready_date',
      'actual_ready_date', 'dispatch_date', 'ship_mode',
      'tracking_ref', 'etd', 'eta'
    ]
    const updates = {}
    for (const field of allowed) {
      if (fields[field] !== undefined) updates[field] = fields[field]
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    const { data: order, error } = await supabase
      .from('npd_sample_orders')
      .update(updates)
      .eq('id', id)
      .select('*, npd_skus(id)')
      .single()
    if (error) throw error

    if (updates.sample_status && order.npd_skus?.id) {
      await insertSystemComment(
        order.npd_skus.id, customerId, role,
        'milestone',
        null,
        { event: `sample_${updates.sample_status}`, stage: 'sample' }
      )
    }

    return res.json({ success: true, sampleOrder: order })
  } catch (err) {
    console.error('❌ PATCH /npd/sample-orders/:id:', err)
    return res.status(500).json({ error: err.message })
  }
})

// GET /npd/catalog/skus/:id/session
// Returns the session SKU if one already exists for this catalog SKU
router.get('/catalog/skus/:id/session', async (req, res) => {
  const { id } = req.params
  const { merchantId } = req.query

  const { data, error } = await supabase
    .from('npd_skus')
    .select(`
      *,
      npd_sessions!inner ( * ),
      npd_comments ( * ),
      npd_sample_orders ( * )
    `)
    .eq('source_catalog_sku_id', id)
    .eq('npd_sessions.merchant_id', merchantId)
    .order('created_at', { referencedTable: 'npd_comments', ascending: true })
    .maybeSingle()

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ sessionSku: data || null })
})


router.post('/catalog/skus/:id/invite', async (req, res) => {
  const { id } = req.params
  const { email, role, customerId } = req.body
  if (!email || !role || !customerId)
    return res.status(400).json({ error: 'email, role, customerId required' })

  // check invite doesn't already exist for this sku + email
  const { data: existing } = await supabase
    .from('npd_invites')
    .select('id, token, accepted_at')
    .eq('sku_id', id)
    .eq('email', email)
    .maybeSingle()

  if (existing && existing.accepted_at)
    return res.status(409).json({ error: 'This person has already accepted an invite for this SKU' })

  if (existing)
    return res.json({ success: true, token: existing.token, alreadySent: true })

  const token = require('crypto').randomUUID()

  const { error } = await supabase
    .from('npd_invites')
    .insert([{ sku_id: id, email, role, token }])
  if (error) throw error

  // update the sku with the invited email
  const field = role === 'buyer' ? 'buyer_email' : 'supplier_email'
  await supabase
    .from('npd_catalog_skus')
    .update({ [field]: email })
    .eq('id', id)

  const link = `https://YOUR-STORE.myshopify.com/pages/npd-access?token=${token}`

  // TODO: plug in your email provider here (Klaviyo, Postmark etc.)
  // for now the link comes back in the response so you can test manually

  return res.json({ success: true, token, link })
})

router.post('/invite/accept', async (req, res) => {
  const { token, customerId } = req.body
  if (!token || !customerId)
    return res.status(400).json({ error: 'token and customerId required' })

  // validate token
  const { data: invite, error: inviteError } = await supabase
    .from('npd_invites')
    .select('*')
    .eq('token', token)
    .maybeSingle()

  if (inviteError || !invite)
    return res.status(404).json({ error: 'Invalid invite link' })
  if (invite.expires_at && new Date(invite.expires_at) < new Date())
    return res.status(410).json({ error: 'This invite has expired' })
  if (invite.accepted_at)
    return res.status(409).json({ error: 'Invite already accepted', sessionId: invite.session_id })

  const { data: catalogSkuFull } = await supabase
  .from('npd_catalog_skus')
  .select('*, npd_catalog_uploads(supplier, season, merchant_id)')
  .eq('id', invite.sku_id)
  .maybeSingle()
const catalogSku = {
  ...catalogSkuFull,
  supplier: catalogSkuFull?.npd_catalog_uploads?.supplier,
  season:   catalogSkuFull?.npd_catalog_uploads?.season,
  merchant_id: catalogSkuFull?.npd_catalog_uploads?.merchant_id
}

  // create session silently
  const { data: session, error: sessionError } = await supabase
    .from('npd_sessions')
    .insert([{
      name:        `${catalogSku.season} — ${catalogSku.supplier}`,
      supplier:    catalogSku.supplier,
      season:      catalogSku.season,
      merchant_id: catalogSku.merchant_id,
      buyer_id:    invite.role === 'buyer' ? customerId : null,
      status:      'active'
    }])
    .select()
    .single()
  if (sessionError) throw sessionError

  // clone catalog SKU into session SKU
  const { data: sessionSku, error: skuError } = await supabase
    .from('npd_skus')
    .insert([{
      session_id:            session.id,
      source_catalog_sku_id: catalogSku.id,
      auto_code:             catalogSku.auto_code,
      image_url:             catalogSku.image_url,
      slide_index:           catalogSku.slide_index,
      description:           catalogSku.description,
      category:              catalogSku.category,
      material:              catalogSku.material,
      dimensions:            catalogSku.dimensions,
      finish:                catalogSku.finish,
      status:                'new',
      stage:                 'negotiation'
    }])
    .select()
    .single()
  if (skuError) throw skuError

  // mark invite accepted + store session id
  await supabase
    .from('npd_invites')
    .update({
      accepted_at: new Date(),
      session_id:  session.id
    })
    .eq('token', token)

  // write customer id onto catalog sku
  const field = invite.role === 'buyer' ? 'buyer_id' : 'supplier_id'
  await supabase
    .from('npd_catalog_skus')
    .update({ [field]: customerId })
    .eq('id', catalogSku.id)

  return res.json({
    success:    true,
    role:       invite.role,
    sessionId:  session.id,
    sessionSku: sessionSku
  })
})

router.patch('/catalog/skus/:id/invite-accept', async (req, res) => {
  const { id } = req.params
  const { token, customerId } = req.body
  const { data: invite } = await supabase
    .from('npd_invites').select('role').eq('token', token).maybeSingle()
  if (!invite) return res.status(404).json({ error: 'Invite not found' })

  const field = invite.role === 'buyer' ? 'buyer_id' : 'supplier_id'
  await supabase.from('npd_catalog_skus').update({ [field]: customerId }).eq('id', id)
  return res.json({ success: true, role: invite.role })
})

module.exports = router