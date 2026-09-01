const express  = require('express')
const path     = require('path')
const AdmZip   = require('adm-zip')
const router   = express.Router()
const { requireAuth} = require('../middleware/auth')
const supabase = require('../supabaseClient')
const { resolveMember } = require('../helpers/members')
const pctService = require('../service/pctService')
const pLimit          = require('p-limit')
const upload   = require('../upload')
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf')
const { createCanvas } = require('canvas')
const { GoogleGenAI } = require('@google/genai')
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
const { sendAlertEmail } = require('../service/emailService')
const dotenv = require('dotenv')
const { stat } = require('fs')
const { parseFileRef, buildFileRef, ACTIVE_BUCKET, resolveFileUrl } = require('../helper/storage')
const PDFDocument = require('pdfkit')
dotenv.config()
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'

// Returns 'buyer' | 'merchant' | null — whether memberId is allowed to act on this
// workspace's pipeline (approve / status changes). Covers the primary buyer, the
// merchant who owns it, AND any co-buyer (a second/third buyer who accepted an
// invite on this same workspace) — not just workspace.buyer_member_id.
async function resolveWorkspaceActorRole(workspaceId, memberId, workspace) {
  if (workspace?.buyer_member_id === memberId) return 'buyer'
  if (workspace?.merchant_member_id === memberId) return 'merchant'
  // A paired merchant (merchant_access_pairs: grantor uploaded, grantee gets full peer
  // access to their catalog/workspaces) counts as 'merchant' here too — otherwise every
  // merchant-only action (approve, hold/reject, resume, etc.) 403s for them even though
  // the frontend already shows them the same buttons as the workspace's own creator.
  if (workspace?.merchant_member_id) {
    const { data: pair } = await supabase
      .from('merchant_access_pairs')
      .select('grantor_member_id')
      .eq('grantor_member_id', workspace.merchant_member_id)
      .eq('grantee_member_id', memberId)
      .maybeSingle()
    if (pair) return 'merchant'
  }
  const { data: coBuyer } = await supabase
    .from('npd2_invites')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'buyer')
    .eq('member_id', memberId)
    .eq('status', 'accepted')
    .limit(1)
    .maybeSingle()
  return coBuyer ? 'buyer' : null
}

const NPD_BUCKET = 'npd'

const _autoCodeUsed = new Set()
const generateAutoCode = async () => {
  while (true) {
    const num  = Math.floor(1 + Math.random() * 99999)
    const code = `SKU-${String(num).padStart(5, '0')}`
    if (_autoCodeUsed.has(code)) continue
    _autoCodeUsed.add(code)  // reserve before any await to close the race window
    const { data } = await supabase
      .from('npd2_catalog_skus')
      .select('id')
      .eq('auto_code', code)
      .maybeSingle()
    if (!data) return code
    _autoCodeUsed.delete(code)  // already in DB, release and try again
  }
}
// Disable web worker — not available in Node.js
pdfjsLib.GlobalWorkerOptions.workerSrc = false

// ═══════════════════════════════════════════════
// PPTX EXTRACTION — proper slide ↔ image mapping
// ═══════════════════════════════════════════════

/**
 * Returns one entry per slide that has at least one embedded image.
 * Each entry contains:
 *   slideIndex  – 0-based position in the deck
 *   slideNum    – actual slide number (from filename)
 *   lines       – all text strings found on that slide
 *   images      – array of { buffer, mimeType, name } for images on that slide
 *
 * Images are discovered by reading each slide's .rels file, which maps
 * relationship IDs to the actual media files — no positional guessing.
 */
const extractSlidesFromPptx = (fileBuffer) => {
  const zip = new AdmZip(fileBuffer)

  // Build a fast lookup: normalised entryName → ZipEntry
  const entryMap = {}
  for (const e of zip.getEntries()) {
    entryMap[e.entryName.toLowerCase()] = e
  }

  const getEntry = (name) => entryMap[name.toLowerCase()]

  // Sort slides by their numeric suffix
  const slideEntries = zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => {
      const n = (s) => parseInt(s.entryName.match(/(\d+)\.xml$/)[1])
      return n(a) - n(b)
    })

  const slides = []

  for (let idx = 0; idx < slideEntries.length; idx++) {
    const slideEntry = slideEntries[idx]
    const slideNum   = parseInt(slideEntry.entryName.match(/(\d+)\.xml$/)[1])

    // ── Text extraction ──────────────────────────────────────────────────
    const xml     = slideEntry.getData().toString('utf8')
    const matches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || []
    const lines   = matches
      .map(m => m.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean)

    // ── Image discovery via .rels ────────────────────────────────────────
    // The rels file for ppt/slides/slide1.xml lives at
    // ppt/slides/_rels/slide1.xml.rels
    const relPath  = `ppt/slides/_rels/slide${slideNum}.xml.rels`
    const relEntry = getEntry(relPath)
    const images   = []

    if (relEntry) {
      const relXml = relEntry.getData().toString('utf8')

      // Match every Relationship whose Target looks like an image file
      const relRegex = /Type="[^"]*\/image"[^>]*Target="([^"]+)"/gi
      let m
      while ((m = relRegex.exec(relXml)) !== null) {
        // Target is relative, e.g. "../media/image3.png"
        const target    = m[1]
        const filename  = target.replace(/^.*\//, '')          // "image3.png"
        const mediaPath = `ppt/media/${filename}`
        const mediaEntry = getEntry(mediaPath)
        if (!mediaEntry) continue

        const ext      = filename.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg'
        const mimeType = ext === 'png' ? 'image/png'
                       : ext === 'gif' ? 'image/gif'
                       : ext === 'webp' ? 'image/webp'
                       : 'image/jpeg'

        images.push({
          buffer:   mediaEntry.getData(),
          mimeType,
          name:     mediaPath,
        })
      }
    }

    // Only include slides that actually have an image to process
    if (images.length > 0) {
      slides.push({ slideIndex: idx, slideNum, lines, images })
    }
  }

  return slides
}


// ═══════════════════════════════════════════════
// PDF EXTRACTION (unchanged logic, same shape)
// ═══════════════════════════════════════════════

const extractSlidesFromPdf = async (fileBuffer) => {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(fileBuffer) })
  const pdf = await loadingTask.promise
  const slides = []

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page     = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale: 2.0 })
    const canvas   = createCanvas(viewport.width, viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise

    // Extract any embedded text from the PDF page
    const textContent = await page.getTextContent()
    const lines = textContent.items
      .map(item => item.str?.trim())
      .filter(Boolean)

    slides.push({
      slideIndex: pageNum - 1,
      slideNum:   pageNum,
      lines,
      images: [{
        buffer:   canvas.toBuffer('image/png'),
        mimeType: 'image/png',
        name:     `pdf/page_${pageNum}.png`,
      }],
    })
  }

  return slides
}


// ═══════════════════════════════════════════════
// GEMINI — grounded extraction (image + text)
// ═══════════════════════════════════════════════

/**
 * Passes both the slide image AND all text found on that slide to Gemini.
 * The prompt explicitly forbids guessing — every returned field must be
 * traceable to either visible image text or the provided slide text.
 *
 * Returns a partial object; missing/uncertain fields are null.
 */
const extractFieldsWithGemini = async (imageBuffer, mimeType, slideTextLines = []) => {
  const slideText = slideTextLines.length
    ? `\n\nAll text found on this slide:\n${slideTextLines.map(l => `• ${l}`).join('\n')}`
    : '\n\n(No text was found on this slide.)'

  const prompt = `You are a product catalog data extractor. You will receive a product slide image and the raw text extracted from that same slide.

Your job is to return ONLY fields that are EXPLICITLY present — either clearly readable in the image OR found verbatim in the provided slide text. Do NOT infer, guess, or fill in anything not stated.${slideText}

Return ONLY a valid JSON object with these exact keys. Set a field to null if it is not explicitly present:
{
  "description": "product name or short description — use text found on slide/image, or null",
  "material":    "material/fabric/composition — must be stated explicitly, or null",
  "dimensions":  "size or dimensions as written — must be stated explicitly, or null",
  "finish":      "surface finish or treatment — must be stated explicitly, or null",
  "weight":      "a single numeric value in kg only (e.g. 0.8) — no units, no ranges — or null"
}

Rules:
- If a value is ambiguous or could be wrong, set it to null.
- Never invent or approximate a value.
- No explanation, no markdown, just the JSON object.`

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          { inlineData: { data: imageBuffer.toString('base64'), mimeType } },
          { text: prompt },
        ],
      },
    })

    const text  = response.candidates[0].content.parts.find(p => p.text)?.text || ''
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch (err) {
    console.warn('⚠️ Gemini field extraction failed:', err.message)
    return {}
  }
}


// ═══════════════════════════════════════════════
// GEMINI — background removal (unchanged)
// ═══════════════════════════════════════════════

const removeBackgroundWithGemini = async (imageBuffer, mimeType) => {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          { inlineData: { data: imageBuffer.toString('base64'), mimeType } },
          { text: 'Remove the background from this product image. Return the product on a clean white background. Keep all product details intact.' },
        ],
      },
      config: { responseModalities: ['IMAGE', 'TEXT'] },
    })
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        return {
          buffer:   Buffer.from(part.inlineData.data, 'base64'),
          mimeType: part.inlineData.mimeType || 'image/png',
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ Gemini background removal failed, using original:', err.message)
  }
  return { buffer: imageBuffer, mimeType }
}


// ═══════════════════════════════════════════════
// SANITISE — strict, no coercion
// ═══════════════════════════════════════════════

const sanitizeExtractedFields = (fields) => {
  const out = {}

  const trimOrNull = (val, maxLen) => {
    if (!val || typeof val !== 'string') return null
    const s = val.trim().slice(0, maxLen)
    return s || null
  }

  out.description = trimOrNull(fields.description, 500)
  out.material    = trimOrNull(fields.material,    300)
  out.dimensions  = trimOrNull(fields.dimensions,  200)
  out.finish      = trimOrNull(fields.finish,      200)

  // Weight: accept only a clean positive number
  if (fields.weight !== null && fields.weight !== undefined) {
    const num = parseFloat(String(fields.weight).replace(/[^0-9.]/g, ''))
    out.weight = (!isNaN(num) && num > 0) ? num : null
  } else {
    out.weight = null
  }

  return out
}


// ═══════════════════════════════════════════════
// STORAGE HELPERS
// ═══════════════════════════════════════════════

const uploadImageToStorage = async (buffer, storagePath, mimeType = 'image/jpeg') => {
  const { error } = await supabase.storage
    .from(NPD_BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType, upsert: false })
  if (error) throw error
  const { data } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)
  return data.publicUrl
}

const insertSystemComment = async (workspaceId, authorId, role, type, body, metadata) => {
  const { error } = await supabase
    .from('npd2_comments')
    .insert([{
      workspace_id:     workspaceId,
      author_id:        authorId,
      author_member_id: authorId,
      role,
      type,
      body,
      metadata,
    }])
  if (error) throw error
}

const insertSystemComment2 = async (workspaceId, authorId, role, type, body, metadata) => {
  const { error } = await supabase
    .from('npd2_comments')
    .insert([{
      workspace_id:     workspaceId,
      author_id:        authorId,
      author_member_id: authorId,
      role,
      type,
      body,
      metadata,
    }])
  if (error) throw error
}

// ═══════════════════════════════════════════════
// CATALOG
// ═══════════════════════════════════════════════

router.get('/catalog', async (req, res) => {
  try {
    const { customerId, role, supplier, season, category, search, includeArchived } = req.query
    if (!customerId) return res.status(400).json({ error: 'customerId required' })

    let query

    if ((role === 'buyer' || role === 'supplier') && customerId) {
      const field = role === 'buyer' ? 'buyer_id' : 'supplier_id'

      const { data: userWorkspaces } = await supabase
        .from('npd2_workspaces')
        .select('catalog_sku_id')
        .eq(field, customerId)

      const skuIds = (userWorkspaces || []).map(w => w.catalog_sku_id)
      if (!skuIds.length) return res.json({ skus: [], total: 0 })

      query = supabase
        .from('npd2_catalog_skus')
        .select(`*, npd2_catalog_uploads!inner ( id, supplier, season, category, merchant_id, sku_source )`)
        .in('id', skuIds)
        .order('created_at', { ascending: false })
    } else {
      query = supabase
        .from('npd2_catalog_skus')
        .select(`*, npd2_catalog_uploads!inner ( id, supplier, season, category, merchant_id, sku_source )`)
        .eq('npd2_catalog_uploads.merchant_id', customerId)
        .order('created_at', { ascending: false })
    }

    if (!includeArchived || role !== 'merchant') query = query.eq('is_archived', false)
    if (supplier) query = query.eq('npd2_catalog_uploads.supplier', supplier)
    if (season)   query = query.eq('npd2_catalog_uploads.season', season)
    if (category) query = query.eq('npd2_catalog_uploads.category', category)

    const { data, error } = await query
    if (error) throw error

    let skus = (data || []).map(row => ({
      id:                  row.id,
      auto_code:           row.auto_code,
      image_url:           row.image_url,
      model_3d_url:        row.model_3d_url,
      slide_index:         row.slide_index,
      description:         row.description,
      category:            row.category || row.npd2_catalog_uploads.category,
      material:            row.material,
      dimensions:          row.dimensions,
      finish:              row.finish,
      weight:              row.weight,
      supplier:            row.npd2_catalog_uploads.supplier,
      season:              row.npd2_catalog_uploads.season,
      created_at:          row.created_at,
      temp_sku_ref:        row.temp_sku_ref        || null,
      production_sku_id:   row.production_sku_id   || null,
      buyer_ref_status:    row.temp_sku_ref && !row.production_sku_id ? 'pending_buyer_ref' : null,
      // Only 'new' may ever open a workspace/chat — historical uploads (NULL) and explicit
      // 'existing' uploads are blocked. See sku_source note on the /catalog/upload routes.
      sku_source:          row.npd2_catalog_uploads.sku_source || null,
    }))

    if (search) {
      const q = search.toLowerCase()
      skus = skus.filter(s =>
        (s.description || '').toLowerCase().includes(q) ||
        (s.auto_code   || '').toLowerCase().includes(q)
      )
    }

    return res.json({ skus, total: skus.length })
  } catch (err) {
    console.error('❌ GET /npd/catalog:', err)
    return res.status(500).json({ error: err.message })
  }
})

const { GoogleAuth } = require('google-auth-library')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

// Production path: Application Default Credentials (Cloud Run metadata SA).
const triggerWorkerViaApi = async (envVars) => {
  const projectId = process.env.GCP_PROJECT_ID
  if (!projectId) {
    throw new Error('GCP_PROJECT_ID is not set — cannot trigger Cloud Run catalog worker')
  }

  const auth   = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  const client = await auth.getClient()
  const region = process.env.GCP_REGION || 'asia-south1'
  const url    = `https://${region}-run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/twif-catalog-worker:run`
  return client.request({
    url, method: 'POST',
    data: { overrides: { containerOverrides: [{ env: envVars }] } },
  })
}

// Local-dev fallback when ADC OAuth isn't set up: still runs the Cloud Run Job,
// but authenticates via the user's existing `gcloud auth login` session.
const triggerWorkerViaGcloudCli = async (envVars) => {
  const projectId = process.env.GCP_PROJECT_ID
  if (!projectId) {
    throw new Error('GCP_PROJECT_ID is not set — cannot trigger Cloud Run catalog worker')
  }
  const region = process.env.GCP_REGION || 'asia-south1'
  const updates = (envVars || [])
    .filter(v => v?.name && v.value != null)
    .map(v => `${v.name}=${v.value}`)
    .join(',')

  const args = [
    'run', 'jobs', 'execute', 'twif-catalog-worker',
    `--project=${projectId}`,
    `--region=${region}`,
    '--async',
  ]
  if (updates) args.push(`--update-env-vars=${updates}`)

  const { stdout, stderr } = await execFileAsync('gcloud', args, {
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  console.log('✅ Cloud Run job triggered via gcloud CLI', (stdout || stderr || '').trim())
  return { status: 200, data: { name: 'gcloud-cli-execute', stdout, stderr } }
}

const triggerWorker = async (envVars) => {
  try {
    return await triggerWorkerViaApi(envVars)
  } catch (err) {
    const msg = err?.message || String(err)
    const needsCliFallback =
      /Could not load the default credentials/i.test(msg) ||
      /Could not load the default credentials/i.test(err?.errors?.[0]?.message || '') ||
      /default credentials were not found/i.test(msg) ||
      /Unable to authenticate/i.test(msg)

    if (!needsCliFallback) throw err

    console.warn(`⚠️  ADC unavailable (${msg}) — triggering Cloud Run job via gcloud CLI`)
    return triggerWorkerViaGcloudCli(envVars)
  }
}

router.post('/catalog/upload', upload.single('catalogFile'), async (req, res) => {
  const file = req.file
  const { supplier, season, category, customerId, skuSource } = req.body

  try {
    if (!file)             return res.status(400).json({ error: 'catalogFile required' })
    if (!supplier?.trim()) return res.status(400).json({ error: 'supplier required' })
    if (!season?.trim())   return res.status(400).json({ error: 'season required' })
    if (!customerId)       return res.status(400).json({ error: 'customerId required' })

    const ext = require('path').extname(file.originalname).toLowerCase()
    if (ext !== '.pptx' && ext !== '.pdf')
      return res.status(400).json({ error: 'Only .pptx and .pdf supported' })

    // 1. Create upload record
    const { data: uploadRow, error: uploadError } = await supabase
      .from('npd2_catalog_uploads')
      .insert([{
        supplier:        supplier.trim(),
        season:          season.trim(),
        category:        category?.trim() || null,
        merchant_id:     customerId.trim(),
        source_filename: file.originalname,
        source_ext:      ext,
        status:          'queued',
        // Gates whether a workspace/chat can ever be opened on SKUs from this batch — only
        // 'new' is allowed to open one; anything else (including historical NULL rows from
        // before this column existed) stays blocked. See sku_source usage in openWorkspace gate.
        sku_source:      skuSource === 'new' ? 'new' : 'existing',
      }])
      .select().single()
    if (uploadError) throw uploadError

    // 2. Store the file in Supabase Storage so the worker can download it
    const safeOriginal  = file.originalname.replace(/\s+/g, '_')
    const sourcePath    = `catalog/${uploadRow.id}/source/${Date.now()}_${safeOriginal}`
    const { error: upErr } = await supabase.storage
      .from(NPD_BUCKET)
      .upload(sourcePath, file.buffer, { contentType: file.mimetype })
    if (upErr) throw upErr

    // Save the path so the worker knows where to download from
    await supabase
      .from('npd2_catalog_uploads')
      .update({ source_file_path: sourcePath, source_ext: ext,})
      .eq('id', uploadRow.id)

    // 3. Trigger Cloud Run Job
    await triggerWorker([
      { name: 'JOB_UPLOAD_ID',   value: uploadRow.id },
      { name: 'JOB_CUSTOMER_ID', value: customerId },
      { name: 'JOB_EXT',         value: ext },
    ])

    return res.json({
      success:  true,
      uploadId: uploadRow.id,
      message:  'Processing started',
    })

  } catch (err) {
    console.error('❌ POST /catalog/upload:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── IMAGE EDIT — patch SKU image (locked after workspace goes active) ──────
// router.patch('/catalog/skus/:id/image', requireAuth, upload.single('image'), async (req, res) => {
//   try {
//     const file = req.file
//     if (!file) return res.status(400).json({ error: 'image file required' })

//     // ── Fetch SKU to get upload id + auto_code ───────────────────────────
//     const { data: skuRow, error: skuErr } = await supabase
//       .from('npd2_catalog_skus')
//       .select('catalog_upload_id, auto_code')
//       .eq('id', req.params.id)
//       .single()
//     if (skuErr || !skuRow) return res.status(404).json({ error: 'SKU not found' })

//     // ── Lock check: any workspace where buyer OR supplier accepted ────────
//     const { data: workspaces } = await supabase
//       .from('npd2_workspaces')
//       .select('buyer_id, supplier_id, buyer_member_id, supplier_member_id, status')
//       .eq('catalog_sku_id', req.params.id)

//     const isLocked = (workspaces || []).some(w =>
//       w.buyer_id || w.supplier_id ||
//       w.buyer_member_id || w.supplier_member_id ||
//       ['active', 'approved', 'sample', 'production'].includes(w.status)
//     )
//     if (isLocked) {
//       return res.status(403).json({ error: 'Image cannot be edited after workspace becomes active' })
//     }

//     // ── Upload new image to storage ───────────────────────────────────────
//     const storPath = `catalog/${skuRow.catalog_upload_id}/skus/${skuRow.auto_code}_edited_${Date.now()}.jpg`
//     const { error: upErr } = await supabase.storage
//       .from(NPD_BUCKET)
//       .upload(storPath, file.buffer, { contentType: file.mimetype || 'image/jpeg', upsert: false })
//     if (upErr) throw upErr

//     const { data: urlData } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storPath)

//     // ── Patch image_url on the SKU ────────────────────────────────────────
//     const { data: updated, error: patchErr } = await supabase
//       .from('npd2_catalog_skus')
//       .update({ image_url: urlData.publicUrl })
//       .eq('id', req.params.id)
//       .select()
//       .single()
//     if (patchErr) throw patchErr

//     return res.json({ success: true, image_url: urlData.publicUrl, sku: updated })
//   } catch (err) {
//     console.error('❌ PATCH /catalog/skus/:id/image:', err)
//     return res.status(500).json({ error: err.message })
//   }
// })

router.patch('/catalog/skus/:id/image', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const file = req.file
    if (!file) return res.status(400).json({ error: 'image file required' })

    const { data: skuRow, error: skuErr } = await supabase
      .from('npd2_catalog_skus')
      .select('image_url, auto_code')
      .eq('id', req.params.id)
      .single()
    if (skuErr || !skuRow) return res.status(404).json({ error: 'SKU not found' })

    const { data: workspaces } = await supabase
      .from('npd2_workspaces')
      .select('buyer_member_id, supplier_member_id, status')
      .eq('catalog_sku_id', req.params.id)

    const isLocked = (workspaces || []).some(w =>
      w.buyer_member_id || w.supplier_member_id ||
      ['active', 'approved', 'sample', 'production'].includes(w.status)
    )
    if (isLocked) return res.status(403).json({ error: 'Image cannot be edited after workspace becomes active' })

    // Derive the directory from existing URL, then save to a new unique path so
    // the URL actually changes in the DB — overwriting in-place would keep the
    // same URL and CDN-cached old image would still show after refresh.
    const publicUrlPrefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/${NPD_BUCKET}/`
    const existingPath = skuRow.image_url.startsWith(publicUrlPrefix)
      ? skuRow.image_url.slice(publicUrlPrefix.length)
      : skuRow.image_url
    const dir = existingPath.includes('/') ? existingPath.substring(0, existingPath.lastIndexOf('/') + 1) : ''
    const storPath = `${dir}edited_${skuRow.auto_code}_${Date.now()}.png`

    const { error: upErr } = await supabase.storage
      .from(NPD_BUCKET)
      .upload(storPath, file.buffer, { contentType: 'image/png', upsert: false })
    if (upErr) throw upErr

    const { data: { publicUrl: image_url } } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storPath)

    const { data: sku, error: patchErr } = await supabase
      .from('npd2_catalog_skus')
      .update({ image_url })
      .eq('id', req.params.id)
      .select()
      .single()
    if (patchErr) throw patchErr

    return res.json({ success: true, image_url, sku })
  } catch (err) {
    console.error('❌ PATCH /catalog/skus/:id/image:', err)
    return res.status(500).json({ error: err.message })
  }
})


router.patch('/catalog/skus/:id/image-from-url', requireAuth, async (req, res) => {
  try {
    const { imageUrl } = req.body
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' })

    const { error: patchErr } = await supabase
      .from('npd2_catalog_skus')
      .update({ image_url: imageUrl })
      .eq('id', req.params.id)
    if (patchErr) throw patchErr

    return res.json({ image_url: imageUrl })
  } catch (err) {
    console.error('❌ PATCH /catalog/skus/:id/image-from-url:', err)
    return res.status(500).json({ error: err.message })
  }
})


// ── IMAGE EDIT — save an edited copy of a reference-media image ────────────
// mode='copy' always appends a new reference_media entry. mode='replace' only
// overwrites the matching entry in-place, and only when that url isn't pinned
// as the workspace's buyer-brief image or the linked SKU's product image — a
// pinned original always falls back to 'copy' so the pin never breaks.
router.patch('/sku-workspaces/:id/reference-media', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const file = req.file
    if (!file) return res.status(400).json({ error: 'image file required' })
    const { mode, replaceUrl } = req.body

    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const { data: ws, error: wsErr } = await supabase
      .from('npd2_workspaces')
      .select('reference_media, buyer_brief, catalog_sku_id, merchant_member_id, buyer_member_id, supplier_member_id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (wsErr) throw wsErr
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    const isMember = [ws.merchant_member_id, ws.buyer_member_id, ws.supplier_member_id].includes(memberId)
    if (!isMember) {
      const [{ data: inv }, actorRole] = await Promise.all([
        supabase.from('npd2_invites')
          .select('id')
          .eq('workspace_id', req.params.id)
          .eq('member_id', memberId)
          .eq('status', 'accepted')
          .maybeSingle(),
        // Covers a paired merchant (merchant_access_pairs) too — not just co-buyer invites.
        resolveWorkspaceActorRole(req.params.id, memberId, ws),
      ])
      if (!inv && !actorRole) return res.status(403).json({ error: 'Not a member of this workspace' })
    }

    let skuImageUrl = null
    if (ws.catalog_sku_id) {
      const { data: sku } = await supabase
        .from('npd2_catalog_skus')
        .select('image_url')
        .eq('id', ws.catalog_sku_id)
        .maybeSingle()
      skuImageUrl = sku?.image_url || null
    }
    const isPinned = !!replaceUrl && (replaceUrl === ws.buyer_brief?.image_url || replaceUrl === skuImageUrl)

    const storagePath = `workspaces/${req.params.id}/reference-media/edited_${Date.now()}.png`
    const { error: upErr } = await supabase.storage
      .from(NPD_BUCKET)
      .upload(storagePath, file.buffer, { contentType: 'image/png', upsert: false })
    if (upErr) throw upErr
    const { data: { publicUrl: newUrl } } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)

    const currentMedia = ws.reference_media || []
    const canReplace = mode === 'replace' && !isPinned && replaceUrl && currentMedia.some(m => m.url === replaceUrl)
    const updatedMedia = canReplace
      ? currentMedia.map(m => m.url === replaceUrl ? { ...m, url: newUrl, edited: true } : m)
      : [...currentMedia, { url: newUrl, edited: true }]

    const { error: updErr } = await supabase
      .from('npd2_workspaces')
      .update({ reference_media: updatedMedia })
      .eq('id', req.params.id)
    if (updErr) throw updErr

    return res.json({ success: true, image_url: newUrl, replaced: canReplace, reference_media: updatedMedia })
  } catch (err) {
    console.error('❌ PATCH /sku-workspaces/:id/reference-media:', err)
    return res.status(500).json({ error: err.message })
  }
})

router.post('/supplier-catalog/upload', requireAuth, upload.single('catalogFile'), async (req, res) => {
  const file = req.file
  const { supplierOrgId, season, buyerOrgId, skuSource } = req.body
  let uploadRow = null
  let uploadError

  try {
    if (!file)           return res.status(400).json({ error: 'catalogFile required' })
    if (!supplierOrgId)  return res.status(400).json({ error: 'supplierOrgId required' })
    if (!season?.trim()) return res.status(400).json({ error: 'season required' })

    const ext = path.extname(file.originalname).toLowerCase()
    if (ext !== '.pptx' && ext !== '.pdf')
      return res.status(400).json({ error: 'Only .pptx and .pdf supported' })

    const [member, { data: orgRow }, { data: buyerOrgRow }] = await Promise.all([
      resolveMember(req, res, 'id, organization_id'),
      supabase.from('organizations').select('display_name, name').eq('id', supplierOrgId).maybeSingle(),
      buyerOrgId
        ? supabase.from('organizations').select('display_name, name').eq('id', buyerOrgId).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    if (!member) return

    ;({ data: uploadRow, error: uploadError } = await supabase
      .from('npd2_catalog_uploads')
      .insert([{
        supplier_org_id:      supplierOrgId,
        season:               season.trim(),
        created_by_member_id: member.id,
        source_type:          ext === '.pptx' ? 'pptx' : 'pdf',
        source_filename:      file.originalname,
        source_ext:           ext,
        status:               'queued',
        for_buyer_org_id:     buyerOrgId || null,
        supplier:             orgRow?.display_name || orgRow?.name || null,
        buyer:                buyerOrgRow?.display_name || buyerOrgRow?.name || null,
        // See sku_source note in /catalog/upload — only 'new' opens a workspace/chat.
        sku_source:           skuSource === 'new' ? 'new' : 'existing',
      }])
      .select().single()
    )
    if (uploadError) throw uploadError

    // 2. Store file in Supabase Storage
    const safeOriginal = file.originalname
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')   // strip accents
      .replace(/[^a-z0-9._-]/gi, '_')    // replace anything non-safe
      .replace(/_+/g, '_')               // collapse multiple underscores
    const sourcePath = `catalog/${uploadRow.id}/source/${Date.now()}_${safeOriginal}`
    const { error: upErr } = await supabase.storage
      .from(NPD_BUCKET)
      .upload(sourcePath, file.buffer, { contentType: file.mimetype })
    if (upErr) throw upErr

    await supabase
      .from('npd2_catalog_uploads')
      .update({ source_file_path: sourcePath })
      .eq('id', uploadRow.id)

    // 3. Trigger Cloud Run Job
    const jobRes = await triggerWorker([
      { name: 'JOB_UPLOAD_ID',   value: uploadRow.id },
      { name: 'JOB_CUSTOMER_ID', value: member.id },
      { name: 'JOB_EXT',         value: ext },
    ])
    console.log(`✅ Cloud Run triggered for upload ${uploadRow.id}:`, jobRes.data?.name || jobRes.status)

    return res.json({
      success:  true,
      uploadId: uploadRow.id,
      message:  'Processing started',
    })

  } catch (err) {
    console.error('❌ POST /supplier-catalog/upload:', err)

    // Clean up orphaned upload row if it was created
    if (uploadRow?.id) {
      try {
        await supabase
          .from('npd2_catalog_uploads')
          .update({ status: 'error', error_message: err.message })
          .eq('id', uploadRow.id)
      } catch (_) { /* best-effort */ }
    }

    return res.status(500).json({ error: err.message })
  }
})

// ── Step 1: upload buyer spec PDFs (one per SKU) — triggers catalogWorker ─────
router.post('/buyer-spec/upload', requireAuth, upload.array('files'), async (req, res) => {
  const files = req.files
  const { buyerOrgId, supplierOrgId, season } = req.body

  try {
    if (!files?.length)  return res.status(400).json({ error: 'At least one file required' })
    if (!buyerOrgId)     return res.status(400).json({ error: 'buyerOrgId required' })
    if (!supplierOrgId)  return res.status(400).json({ error: 'supplierOrgId required' })
    if (!season?.trim()) return res.status(400).json({ error: 'season required' })

    for (const file of files) {
      if (path.extname(file.originalname).toLowerCase() !== '.pdf')
        return res.status(400).json({ error: `Only PDF files supported — ${file.originalname} is not a PDF` })
    }

    const member = await resolveMember(req, res, 'id, organization_id')
    if (!member) return

    const uploads = []

    const [{ data: supplierOrg }, { data: buyerOrg }] = await Promise.all([
      supabase.from('organizations').select('display_name').eq('id', supplierOrgId).single(),
      supabase.from('organizations').select('display_name, name').eq('id', buyerOrgId).single(),
    ])

    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase()

      const { data: uploadRow, error: uploadError } = await supabase
        .from('npd2_catalog_uploads')
        .insert([{
          supplier_org_id:      supplierOrgId,
          supplier:             supplierOrg?.display_name || null,
          for_buyer_org_id:     buyerOrgId,
          buyer:                buyerOrg?.display_name || buyerOrg?.name || null,
          season:               season.trim(),
          created_by_member_id: member.id,
          source_type:          'pdf',
          source_filename:      file.originalname,
          source_ext:           ext,
          status:               'queued',
          origin:               'buyer_spec',
          // Buyer-spec SKUs are always freshly created for this order, never linked to an
          // existing production SKU batch — see sku_source note in /catalog/upload.
          sku_source:           'new',
        }])
        .select()
        .single()
      if (uploadError) throw uploadError

      const safeOriginal = file.originalname
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9._-]/gi, '_')
        .replace(/_+/g, '_')
      const sourcePath = `catalog/${uploadRow.id}/source/${Date.now()}_${safeOriginal}`
      const { error: upErr } = await supabase.storage
        .from(NPD_BUCKET)
        .upload(sourcePath, file.buffer, { contentType: file.mimetype })
      if (upErr) throw upErr

      await supabase
        .from('npd2_catalog_uploads')
        .update({ source_file_path: sourcePath })
        .eq('id', uploadRow.id)

      await triggerWorker([
        { name: 'JOB_UPLOAD_ID',   value: uploadRow.id },
        { name: 'JOB_CUSTOMER_ID', value: member.id },
        { name: 'JOB_EXT',         value: ext },
        { name: 'JOB_MODE',        value: 'catalog' },
      ])

      uploads.push({ uploadId: uploadRow.id, filename: file.originalname })
    }

    return res.json({ success: true, uploads, message: 'Processing started' })

  } catch (err) {
    console.error('❌ POST /buyer-spec/upload:', err)
    return res.status(500).json({ error: err.message })
  }
})





router.get('/catalog/skus/:id', async (req, res) => {
  try {
    const { data: sku, error } = await supabase
      .from('npd2_catalog_skus')
      .select(`*, npd2_catalog_uploads ( supplier, season, category, source_file_url )`)
      .eq('id', req.params.id)
      .maybeSingle()
    if (error) throw error
    if (!sku) return res.status(404).json({ error: 'Catalog SKU not found' })
    return res.json({ sku: {
      ...sku,
      supplier:         sku.npd2_catalog_uploads?.supplier,
      season:           sku.npd2_catalog_uploads?.season,
      buyer_ref_status: sku.temp_sku_ref && !sku.production_sku_id ? 'pending_buyer_ref' : null,
    }})
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})


router.patch('/catalog/skus/reorder', requireAuth, async (req, res) => {
  try {
    const { ordered_ids } = req.body
    if (!Array.isArray(ordered_ids) || !ordered_ids.length)
      return res.status(400).json({ error: 'ordered_ids array required' })

    await Promise.all(
      ordered_ids.map((id, i) =>
        supabase.from('npd2_catalog_skus').update({ sort_position: i }).eq('id', id)
      )
    )

    return res.json({ success: true })
  } catch (err) {
    console.error('❌ PATCH /catalog/skus/reorder:', err)
    return res.status(500).json({ error: err.message })
  }
})


router.patch('/catalog/skus/:id', async (req, res) => {
  try {
    const { customerId, role, ...fields } = req.body
    if (!customerId || !role) return res.status(400).json({ error: 'customerId and role required' })
    if (role !== 'merchant')  return res.status(403).json({ error: 'Only merchants can edit catalog SKUs' })

    const allowed = ['description', 'dimensions', 'material', 'weight', 'finish', 'category']
    const updates = {}
    for (const field of allowed) {
      if (fields[field] !== undefined) updates[field] = fields[field] === '' ? null : fields[field]
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' })

    const { data, error } = await supabase
      .from('npd2_catalog_skus').update(updates).eq('id', req.params.id).select().single()
    if (error) throw error
    return res.json({ success: true, sku: data })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.patch('/supplier-catalog/skus/:id', requireAuth, async (req, res) => {
  try {
    const { ...fields } = req.body

    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    // Verify member has access to this SKU
    const { data: sku } = await supabase
      .from('npd2_catalog_skus')
      .select('catalog_upload_id')
      .eq('id', req.params.id)
      .single()

    const { data: upload } = await supabase
      .from('npd2_catalog_uploads')
      .select('created_by_member_id')
      .eq('id', sku?.catalog_upload_id)
      .single()

      

    let hasAccess = upload?.created_by_member_id === memberId
    if (!hasAccess && upload?.created_by_member_id) {
      const { data: pair } = await supabase
        .from('merchant_access_pairs')
        .select('grantor_member_id')
        .eq('grantor_member_id', upload.created_by_member_id)
        .eq('grantee_member_id', memberId)
        .maybeSingle()
      hasAccess = !!pair
    }
    if (!hasAccess) return res.status(403).json({ error: 'Forbidden' })

   const allowed = ['description', 'material', 'finish', 'category', 'length', 'width', 'height', 'measurement', 'weight','category_id','production_sku_id','temp_sku_ref']
    const updates = {}
     if (fields.category_id !== undefined) {
      if (!fields.category_id) {
        updates.category_id = null
        updates.category    = null
      } else {
        const { data: cat } = await supabase
          .from('categories').select('name').eq('id', fields.category_id).maybeSingle()
        updates.category_id = fields.category_id
        updates.category    = cat?.name || null
      }
    }
    for (const field of allowed) {
      if (fields[field] !== undefined) updates[field] = fields[field] === '' ? null : fields[field]
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' })

    if (updates.production_sku_id) {
      const { data: existing } = await supabase
        .from('npd2_catalog_skus')
        .select('id, auto_code')
        .eq('production_sku_id', updates.production_sku_id)
        .neq('id', req.params.id)
        .maybeSingle()
      if (existing) {
        return res.status(409).json({ error: `This production SKU is already linked to ${existing.auto_code}` })
      }
    }

    const { data, error } = await supabase
      .from('npd2_catalog_skus').update(updates).eq('id', req.params.id).select().single()
    if (error) throw error
    return res.json({
      success: true,
      sku: {
        ...data,
        buyer_ref_status: data.temp_sku_ref && !data.production_sku_id ? 'pending_buyer_ref' : null,
      },
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})



// router.delete('/catalog/skus/:id', async (req, res) => {
//   try {
//     const { role } = req.query
//     if (role !== 'merchant') return res.status(403).json({ error: 'Only merchants can archive catalog SKUs' })
//     const { error } = await supabase.from('npd2_catalog_skus').update({ is_archived: true }).eq('id', req.params.id)
//     if (error) throw error
//     return res.json({ success: true })
//   } catch (err) {
//     return res.status(500).json({ error: err.message })
//   }
// })

router.delete('/catalog/skus/:id', requireAuth, async (req, res) => {
  try {
    const { role } = req.query
    if (role !== 'merchant') return res.status(403).json({ error: 'Only merchants can delete catalog SKUs' })

    // Fetch the SKU first to get image_url
    const { data: sku, error: fetchErr } = await supabase
      .from('npd2_catalog_skus')
      .select('image_url')
      .eq('id', req.params.id)
      .single()
    if (fetchErr) throw fetchErr

    // Delete the row
    const { error } = await supabase
      .from('npd2_catalog_skus')
      .delete()
      .eq('id', req.params.id)
    if (error) throw error

    // Delete image from storage if exists
    if (sku?.image_url) {
      // Extract path after "/npd/" from the public URL
      // e.g. https://xxx.supabase.co/storage/v1/object/public/npd/catalog/supplier/ss25/skus/SKU-12345.png
      //                                                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
      const match = sku.image_url.match(/\/npd\/(.+)$/)
      if (match) {
        const storagePath = match[1]
        const { error: storErr } = await supabase.storage
          .from('npd')
          .remove([storagePath])
        if (storErr) console.warn('Storage delete warning:', storErr.message)
      }
    }

    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// PATCH /catalog/skus/:id/soft-delete
// Called when merchant clicks the tick/confirm button.
// Stamps delete_meta on the row instead of deleting it.
router.patch('/catalog/skus/:id/soft-delete', requireAuth, async (req, res) => {
  try {
    const { role } = req.query
    if (role !== 'merchant') {
      return res.status(403).json({ error: 'Only merchants can flag SKUs for deletion' })
    }

    const { data: member } = await supabase
      .from('organization_members')
      .select('id')
      .eq('user_id', req.user.id)
      .maybeSingle()

    const deleteMeta = {
      flagged_by: member?.id || null,   
      flagged_at: new Date().toISOString(),
      reason: req.body.reason || null,
    }

    const { data, error } = await supabase
      .from('npd2_catalog_skus')
      .update({ delete_meta: deleteMeta })
      .eq('id', req.params.id)
      .select('id, delete_meta')
      .single()

    if (error) throw error

    return res.json({ success: true, data })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.get('/catalog/upload-status/:id', async (req, res) => {
  try {
    const { data: upload, error } = await supabase
      .from('npd2_catalog_uploads')
      .select('id, status, total_slides, slides_processed, sku_count, error_message, spec_images')
      .eq('id', req.params.id)
      .single()
    if (error) throw error

    const { data: skus } = await supabase
      .from('npd2_catalog_skus')
      .select('id, auto_code, image_url, description, material, dimensions, finish, weight, category, temp_sku_ref, production_sku_id, npd2_catalog_uploads(supplier, season, sku_source)')
      .eq('catalog_upload_id', req.params.id)

    return res.json({
      upload,
      skus: (skus || []).map(s => ({
        ...s,
        supplier:          s.npd2_catalog_uploads?.supplier,
        season:            s.npd2_catalog_uploads?.season,
        // Only 'new' may ever open a workspace/chat — see sku_source note in /catalog/upload.
        // Must be forwarded here since CatalogUploadModal adds these SKUs straight to the
        // store via addSkus(), bypassing the normal fetchCatalog() join that derives it.
        sku_source:        s.npd2_catalog_uploads?.sku_source || null,
        buyer_ref_status:  s.temp_sku_ref && !s.production_sku_id ? 'pending_buyer_ref' : null,
        npd2_catalog_uploads: undefined
      }))
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════
// WORKSPACES
// ═══════════════════════════════════════════════

router.get('/catalog/skus/:id/workspaces', async (req, res) => {
  try {
    const { id } = req.params
    const { merchantId, userId, role } = req.query

    let query = supabase
      .from('npd2_workspaces')
      .select(`*, npd2_invites ( id, email, role, accepted_at )`)
      .eq('catalog_sku_id', id)

    if (merchantId) {
      query = query.eq('merchant_id', merchantId)
    } else if (userId && role === 'buyer') {
      query = query.eq('buyer_id', userId)
    } else if (userId && role === 'supplier') {
      query = query.eq('supplier_id', userId)
    } else {
      return res.status(400).json({ error: 'merchantId or userId+role required' })
    }

    const { data: workspaces, error } = await query
    if (error) throw error
    return res.json({ workspaces: workspaces || [] })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})


router.get('/workspaces/:id', async (req, res) => {
  const { customerId, role } = req.query

  try {
    const { data: workspace, error } = await supabase
      .from('npd2_workspaces')
      .select(`
        *,
        npd2_catalog_skus (
          id, auto_code, image_url, model_3d_url, description, category,
          material, dimensions, finish, weight,
          npd2_catalog_uploads ( supplier, season )
        ),
        npd2_comments ( * ),
        npd2_sample_orders ( * ),
        npd2_invites ( id, email, role, accepted_at )
      `)
      .eq('id', req.params.id)
      .order('created_at', { referencedTable: 'npd2_comments', ascending: true })
      .maybeSingle()

    if (error) throw error
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' })

    const catalogSku  = workspace.npd2_catalog_skus
    const allComments = workspace.npd2_comments || []

    let visibleComments
    if (role === 'supplier') {
      visibleComments = allComments.filter(c =>
        (c.channel || 'buyer') === 'supplier' ||
        (workspace.supplier_in_buyer_chat === true && (c.channel || 'buyer') === 'buyer')
      )
    } else {
      visibleComments = allComments
    }

    const result = {
      ...workspace,
      auto_code:   catalogSku?.auto_code,
      image_url:   catalogSku?.image_url,
      model_3d_url:catalogSku?.model_3d_url,
      description: catalogSku?.description,
      category:    catalogSku?.category,
      material:    catalogSku?.material,
      dimensions:  catalogSku?.dimensions,
      finish:      catalogSku?.finish,
      weight:      catalogSku?.weight,
      supplier:    catalogSku?.npd2_catalog_uploads?.supplier,
      season:      catalogSku?.npd2_catalog_uploads?.season,
      npd_comments:      visibleComments,
      npd_sample_orders: workspace.npd2_sample_orders ? [workspace.npd2_sample_orders] : [],
      stage: workspace.npd2_sample_orders ? 'sample' : 'negotiation',
    }

    return res.json({ workspace: result })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})


router.post('/sku-workspaces', requireAuth, async (req, res) => {
  try {
    const { catalogSkuId, merchantId, buyerEmail, supplierEmail, buyerOrgId, supplierOrgId } = req.body
    if (!catalogSkuId) return res.status(400).json({ error: 'catalogSkuId required' })
    if (!merchantId)   return res.status(400).json({ error: 'merchantId required' })
    if (!buyerEmail)   return res.status(400).json({ error: 'buyerEmail required' })

    const { data: workspace, error: wsError } = await supabase
      .from('npd2_workspaces')
      .insert([{
        catalog_sku_id: catalogSkuId,
        merchant_member_id:  merchantId,
        buyer_email:    buyerEmail,
        supplier_email: supplierEmail || null,
        supplier_org_id: supplierOrgId || null,
        buyer_org_id:    buyerOrgId || null,
        status:         'invited',
      }])
      .select()
      .single()
    if (wsError) throw wsError

    const buyerToken = require('crypto').randomUUID()
    const { error: invErr } = await supabase
      .from('npd2_invites')
      .insert([{ workspace_id: workspace.id, email: buyerEmail, role: 'buyer', token: buyerToken, status: 'pending' }])
    if (invErr) throw invErr

    let supplierLink = null
    if (supplierEmail) {
      const supplierToken = require('crypto').randomUUID()
      await supabase.from('npd2_invites').insert([{
        workspace_id: workspace.id, email: supplierEmail, role: 'supplier', token: supplierToken, status: 'pending' }])
      supplierLink = `${frontendUrl}/plm/accept?token=${supplierToken}`
    }

    const buyerLink = `${frontendUrl}/plm/accept?token=${buyerToken}`

    const { data: cs } = await supabase
      .from('npd2_catalog_skus')
      .select('auto_code, description, npd2_catalog_uploads ( supplier, season )')
      .eq('id', catalogSkuId)
      .maybeSingle()

    await sendAlertEmail(
      [{ email: buyerEmail }],
      'PLM invite',
      {
        sku_code:      cs?.auto_code   || '',
        description:   cs?.description || '',
        supplier:      cs?.npd2_catalog_uploads?.supplier || '',
        season:        cs?.npd2_catalog_uploads?.season   || '',
        role:          'buyer',
        invite_link:   buyerLink,
        merchant_name: 'Twif',
      },
      'PLM_INVITE'
    )

    if (supplierEmail && supplierLink) {
      await sendAlertEmail(
        [{ email: supplierEmail }],
        'PLM invite',
        {
          sku_code:      cs?.auto_code   || '',
          description:   cs?.description || '',
          supplier:      cs?.npd2_catalog_uploads?.supplier || '',
          season:        cs?.npd2_catalog_uploads?.season   || '',
          role:          'supplier',
          invite_link:   supplierLink,
          merchant_name: 'Twif',
        },
        'PLM_INVITE'
      )
    }

    return res.json({ success: true, workspace, buyerLink, supplierLink })
  } catch (err) {
    console.error('❌ POST /npd/workspaces:', err)
    return res.status(500).json({ error: err.message })
  }
})

router.post('/workspaces', async (req, res) => {
  try {
    const { catalogSkuId, merchantId, buyerEmail, supplierEmail } = req.body
    if (!catalogSkuId) return res.status(400).json({ error: 'catalogSkuId required' })
    if (!merchantId)   return res.status(400).json({ error: 'merchantId required' })
    if (!buyerEmail)   return res.status(400).json({ error: 'buyerEmail required' })

    const { data: workspace, error: wsError } = await supabase
      .from('npd2_workspaces')
      .insert([{
        catalog_sku_id: catalogSkuId,
        merchant_id:    merchantId,
        buyer_email:    buyerEmail,
        supplier_email: supplierEmail || null,
        status:         'invited',
      }])
      .select()
      .single()
    if (wsError) throw wsError

    const buyerToken = require('crypto').randomUUID()
    const { error: invErr } = await supabase
      .from('npd2_invites')
      .insert([{ workspace_id: workspace.id, email: buyerEmail, role: 'buyer', token: buyerToken }])
    if (invErr) throw invErr

    let supplierLink = null
    if (supplierEmail) {
      const supplierToken = require('crypto').randomUUID()
      await supabase.from('npd2_invites').insert([{
        workspace_id: workspace.id, email: supplierEmail, role: 'supplier', token: supplierToken,
      }])
      supplierLink = `${frontendUrl}/plm/accept?token=${supplierToken}`
    }

    const buyerLink = `${frontendUrl}/plm/accept?token=${buyerToken}`

    const { data: cs } = await supabase
      .from('npd2_catalog_skus')
      .select('auto_code, description, npd2_catalog_uploads ( supplier, season )')
      .eq('id', catalogSkuId)
      .maybeSingle()

    await sendAlertEmail(
      [{ email: buyerEmail }],
      'PLM invite',
      {
        sku_code:      cs?.auto_code   || '',
        description:   cs?.description || '',
        supplier:      cs?.npd2_catalog_uploads?.supplier || '',
        season:        cs?.npd2_catalog_uploads?.season   || '',
        role:          'buyer',
        invite_link:   buyerLink,
        merchant_name: 'Twif',
      },
      'PLM_INVITE'
    )

    if (supplierEmail && supplierLink) {
      await sendAlertEmail(
        [{ email: supplierEmail }],
        'PLM invite',
        {
          sku_code:      cs?.auto_code   || '',
          description:   cs?.description || '',
          supplier:      cs?.npd2_catalog_uploads?.supplier || '',
          season:        cs?.npd2_catalog_uploads?.season   || '',
          role:          'supplier',
          invite_link:   supplierLink,
          merchant_name: 'Twif',
        },
        'PLM_INVITE'
      )
    }

    return res.json({ success: true, workspace, buyerLink, supplierLink })
  } catch (err) {
    console.error('❌ POST /npd/workspaces:', err)
    return res.status(500).json({ error: err.message })
  }
})


router.post('/workspaces/:id/invite', async (req, res) => {
  try {
    const { id: workspaceId } = req.params
    const { email, role, customerId } = req.body
    if (!email || !role) return res.status(400).json({ error: 'email and role required' })

    const { data: existing } = await supabase
      .from('npd2_invites')
      .select('id, token, accepted_at')
      .eq('workspace_id', workspaceId)
      .eq('email', email)
      .maybeSingle()

    if (existing?.accepted_at)
      return res.status(409).json({ error: 'This person has already accepted an invite' })
    if (existing)
      return res.json({ success: true, token: existing.token, alreadySent: true })

    const token = require('crypto').randomUUID()
    const { error } = await supabase
      .from('npd2_invites')
      .insert([{ workspace_id: workspaceId, email, role, token }])
    if (error) throw error

    const field = role === 'buyer' ? 'buyer_email' : 'supplier_email'
    await supabase.from('npd2_workspaces').update({ [field]: email }).eq('id', workspaceId)

    const link = `${frontendUrl}/plm/accept?token=${token}`

    const { data: ws } = await supabase
      .from('npd2_workspaces')
      .select('*, npd2_catalog_skus ( auto_code, description, npd2_catalog_uploads ( supplier, season ) )')
      .eq('id', workspaceId)
      .maybeSingle()

    const cs = ws?.npd2_catalog_skus
    await sendAlertEmail(
      [{ email }],
      'PLM invite',
      {
        sku_code:      cs?.auto_code    || '',
        description:   cs?.description  || '',
        supplier:      cs?.npd2_catalog_uploads?.supplier || '',
        season:        cs?.npd2_catalog_uploads?.season   || '',
        role,
        invite_link:   link,
        merchant_name: 'Twif',
      },
      'PLM_INVITE'
    )

    return res.json({ success: true, token, link })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/sku-workspaces/:id/invite', requireAuth, async (req, res) => {
  try {
    const { id: workspaceId } = req.params
    const { email, emails, role, orgId } = req.body

    // Support single email (backwards compat) or array of emails
    const emailList = (emails?.length ? emails : email ? [email] : []).map(e => e.trim().toLowerCase())
    if (!emailList.length || !role) return res.status(400).json({ error: 'email(s) and role required' })

    const { data: ws } = await supabase
      .from('npd2_workspaces')
      .select('*, npd2_catalog_skus ( auto_code, description, npd2_catalog_uploads ( supplier, season ) )')
      .eq('id', workspaceId)
      .maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    const cs = ws?.npd2_catalog_skus
    const results = []

    // Pre-check: count slots used by OTHER emails (not the ones in this request)
    // Resending to an already-invited email replaces that row (net-zero), so exclude them from the count
    const { count: existingCount } = await supabase
      .from('npd2_invites')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('role', role)
      .neq('status', 'revoked')
      .not('email', 'in', `(${emailList.map(e => `"${e}"`).join(',')})`)

    const slotsAvailable = 4 - (existingCount || 0)
    if (slotsAvailable <= 0)
      return res.status(400).json({ error: `Maximum 4 ${role} invites allowed per workspace` })

    const allowedEmails = emailList.slice(0, slotsAvailable)
    const skippedEmails = emailList.slice(slotsAvailable)

    for (const addr of allowedEmails) {
      const { data: existing } = await supabase
        .from('npd2_invites')
        .select('id, token, accepted_at, status')
        .eq('workspace_id', workspaceId)
        .ilike('email', addr)
        .maybeSingle()

      if (existing?.accepted_at || existing?.status === 'accepted') {
        results.push({ email: addr, status: 'already_accepted' })
        continue
      }

      // Delete any existing invite (pending, expired, revoked) so the new row gets a fresh token + expires_at
      if (existing) await supabase.from('npd2_invites').delete().eq('id', existing.id)

      // Resolve to the invitee's own org member row (if one exists) — never the sender's.
      // member_id should identify the buyer/supplier being invited, not the merchant sending the invite.
      let resolvedMemberId = null
      if (orgId) {
        const { data: matchedMember } = await supabase
          .from('organization_members').select('id')
          .eq('organization_id', orgId).ilike('email', addr).maybeSingle()
        resolvedMemberId = matchedMember?.id || null
      }

      const token = require('crypto').randomUUID()
      const { error: invErr } = await supabase
        .from('npd2_invites')
        .insert([{ workspace_id: workspaceId, email: addr, role, token, status: 'pending', member_id: resolvedMemberId }])
      if (invErr) throw invErr

      // Update workspace org/email fields only if the primary slot isn't already taken
      // and the workspace hasn't moved past 'invited' — never touch an active workspace
      const forwardStatuses = ['active', 'on_hold', 'approved', 'sample', 'production', 'reviewing']
      const primaryField = role === 'buyer' ? 'buyer_member_id' : 'supplier_member_id'
      const primaryFilled = !!ws[primaryField] || forwardStatuses.includes(ws.status) || results.some(r => r.status === 'sent')
      if (!primaryFilled) {
        const updateData = role === 'buyer'
          ? { buyer_org_id: orgId, buyer_email: addr }
          : { supplier_org_id: orgId, supplier_email: addr }
        await supabase.from('npd2_workspaces').update(updateData).eq('id', workspaceId)
      }

      // A workspace still pre-invite (e.g. a blank stub with status null) should reflect that
      // it now has a live invite out. Workspaces already past invited (active/approved/etc)
      // are protected by forwardStatuses and never get regressed back to 'invited'.
      if (!forwardStatuses.includes(ws.status) && ws.status !== 'invited')
        await supabase.from('npd2_workspaces').update({ status: 'invited' }).eq('id', workspaceId)

      const link = `${frontendUrl}/plm/accept?token=${token}`
      await sendAlertEmail(
        [{ email: addr }],
        'PLM invite',
        {
          sku_code:      cs?.auto_code    || '',
          description:   cs?.description  || '',
          supplier:      cs?.npd2_catalog_uploads?.supplier || '',
          season:        cs?.npd2_catalog_uploads?.season   || '',
          role,
          invite_link:   link,
          merchant_name: 'Twif',
        },
        'PLM_INVITE'
      )

      results.push({ email: addr, status: 'sent', token, link })
    }

    // Mark any emails that were cut off due to the 4-invite limit
    for (const addr of skippedEmails) {
      results.push({ email: addr, status: 'limit_exceeded' })
    }

    // Backwards compat: if single email, return flat token/link
    if (emailList.length === 1) {
      const r = results[0]
      return res.json({ success: true, token: r.token, link: r.link, status: r.status })
    }

    return res.json({ success: true, results })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})


// Invite one person (buyer or supplier) to many existing workspaces at once — sends ONE email
router.post('/sku-workspaces/bulk-invite', requireAuth, async (req, res) => {
  try {
    const { workspaceIds, email: rawEmail, role, orgId, skipEmail } = req.body
    if (!workspaceIds?.length || !rawEmail || !role)
      return res.status(400).json({ error: 'workspaceIds, email, and role required' })
    const email = rawEmail.trim().toLowerCase()

    const { data: workspaces } = await supabase
      .from('npd2_workspaces')
      .select('*, npd2_catalog_skus ( auto_code, description, npd2_catalog_uploads ( supplier, season ) )')
      .in('id', workspaceIds)
    if (!workspaces?.length) return res.status(404).json({ error: 'No workspaces found' })

    // Resolve to the invitee's own org member row (if one exists) — never the sender's.
    // member_id should identify the buyer/supplier being invited, not the merchant sending the invite.
    let resolvedMemberId = null
    if (orgId) {
      const { data: matchedMember } = await supabase
        .from('organization_members').select('id')
        .eq('organization_id', orgId).ilike('email', email).maybeSingle()
      resolvedMemberId = matchedMember?.id || null
    }

    const sharedToken = require('crypto').randomUUID()
    const results = []
    const forwardStatuses = ['active', 'on_hold', 'approved', 'sample', 'production', 'reviewing']

    for (const ws of workspaces) {
      const { data: existing } = await supabase
        .from('npd2_invites')
        .select('id, token, accepted_at, status')
        .eq('workspace_id', ws.id)
        .ilike('email', email)
        .eq('role', role)
        .maybeSingle()

      if (existing?.accepted_at || existing?.status === 'accepted') {
        results.push({ workspaceId: ws.id, status: 'already_accepted' })
        continue
      }

      // Enforce max 4 invites per role per workspace (count other emails, not the current one)
      if (!existing) {
        const { count: otherCount } = await supabase
          .from('npd2_invites')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', ws.id)
          .eq('role', role)
          .neq('status', 'revoked')
        if ((otherCount || 0) >= 4) {
          results.push({ workspaceId: ws.id, status: 'max_invites_reached' })
          continue
        }
      }

      // Delete any existing invite (pending, expired, revoked) so the new row gets a fresh token + expires_at
      if (existing) await supabase.from('npd2_invites').delete().eq('id', existing.id)

      const { error: invErr } = await supabase
        .from('npd2_invites')
        .insert([{ workspace_id: ws.id, email, role, token: sharedToken, status: 'pending', member_id: resolvedMemberId }])
      if (invErr) throw invErr

      const primaryField = role === 'buyer' ? 'buyer_member_id' : 'supplier_member_id'
      const primaryFilled = !!ws[primaryField] || forwardStatuses.includes(ws.status)
      if (!primaryFilled) {
        const updateData = role === 'buyer'
          ? { buyer_org_id: orgId, buyer_email: email }
          : { supplier_org_id: orgId, supplier_email: email }
        await supabase.from('npd2_workspaces').update(updateData).eq('id', ws.id)
      }

      // A workspace still pre-invite (e.g. a blank stub with status null) should reflect that
      // it now has a live invite out. Workspaces already past invited (active/approved/etc)
      // are protected by forwardStatuses and never get regressed back to 'invited'.
      if (!forwardStatuses.includes(ws.status) && ws.status !== 'invited')
        await supabase.from('npd2_workspaces').update({ status: 'invited' }).eq('id', ws.id)

      results.push({ workspaceId: ws.id, status: 'sent' })
    }

    const newlyInvited = results.filter(r => r.status === 'sent')
    if (!newlyInvited.length)
      return res.json({ success: true, results, link: null })

    const invitedWs  = workspaces.filter(ws => newlyInvited.some(r => r.workspaceId === ws.id))
    const skuCodes   = invitedWs.map(ws => ws.npd2_catalog_skus?.auto_code).filter(Boolean).join(', ')
    const suppliers  = [...new Set(invitedWs.map(ws => ws.npd2_catalog_skus?.npd2_catalog_uploads?.supplier).filter(Boolean))].join(', ')
    const seasons    = [...new Set(invitedWs.map(ws => ws.npd2_catalog_skus?.npd2_catalog_uploads?.season).filter(Boolean))].join(', ')
    const link       = `${frontendUrl}/plm/accept?token=${sharedToken}`

    if (!skipEmail) await sendAlertEmail(
      [{ email }],
      `PLM invite — ${newlyInvited.length} workspace${newlyInvited.length === 1 ? '' : 's'}`,
      {
        sku_code:      skuCodes,
        description:   `${newlyInvited.length} new workspace${newlyInvited.length === 1 ? '' : 's'} have been shared with you`,
        supplier:      suppliers,
        season:        seasons,
        role,
        invite_link:   link,
        merchant_name: 'Twif',
      },
      'PLM_INVITE'
    )

    return res.json({ success: true, results, link })
  } catch (err) {
    console.error('❌ POST /sku-workspaces/bulk-invite:', err)
    return res.status(500).json({ error: err.message })
  }
})


router.patch('/sku-workspaces/:id/invites/:inviteId/revoke', requireAuth, async (req, res) => {
  try {
    const { id: workspaceId, inviteId } = req.params

    const { data: invite, error: fetchErr } = await supabase
      .from('npd2_invites')
      .select('id, status, role, workspace_id')
      .eq('id', inviteId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    if (fetchErr) throw fetchErr
    if (!invite) return res.status(404).json({ error: 'Invite not found' })
    if (invite.status === 'accepted') return res.status(409).json({ error: 'Cannot revoke an accepted invite' })
    if (invite.status === 'revoked') return res.status(409).json({ error: 'Invite already revoked' })

    const { error } = await supabase
      .from('npd2_invites')
      .update({ status: 'revoked' })
      .eq('id', inviteId)
    if (error) throw error

    return res.json({ success: true, inviteId, role: invite.role })
  } catch (err) {
    console.error('❌ PATCH /sku-workspaces/:id/invites/:inviteId/revoke:', err)
    return res.status(500).json({ error: err.message })
  }
})


// DEAD CODE — PLMAccessPage calls /workspace-invites/accept instead. Kept for reference only.
// router.post('/invites/accept', async (req, res) => {
//   try {
//     const { token, customerId } = req.body
//     if (!token || !customerId) return res.status(400).json({ error: 'token and customerId required' })
//     const { data: invites, error: invErr } = await supabase
//       .from('npd2_invites').select('*, npd2_workspaces(*)').eq('token', token)
//     if (invErr || !invites?.length) return res.status(404).json({ error: 'Invalid invite link' })
//     const first = invites[0]
//     if (first.expires_at && new Date(first.expires_at) < new Date())
//       return res.status(410).json({ error: 'This invite has expired' })
//     if (invites.every(i => i.accepted_at))
//       return res.status(409).json({ error: 'Invite already accepted', workspaceId: first.workspace_id })
//     // NOTE: used wrong column names buyer_id/supplier_id (correct: buyer_member_id/supplier_member_id)
//     const idField = first.role === 'buyer' ? 'buyer_id' : 'supplier_id'
//     for (const invite of invites) {
//       if (!invite.accepted_at)
//         await supabase.from('npd2_workspaces').update({ [idField]: customerId, status: 'active' }).eq('id', invite.workspace_id)
//     }
//     await supabase.from('npd2_invites').update({ accepted_at: new Date() }).eq('token', token)
//     return res.json({ success: true, role: first.role, workspaceId: first.workspace_id })
//   } catch (err) {
//     return res.status(500).json({ error: err.message })
//   }
// })

router.post('/sku-workspaces/bulk', requireAuth, async (req, res) => {
  try {
    const { catalogSkuIds, merchantId, buyerEmail, supplierEmail, buyerOrgId, supplierOrgId, skipInvites } = req.body
    if (!catalogSkuIds?.length) return res.status(400).json({ error: 'catalogSkuIds required' })
    if (!merchantId)            return res.status(400).json({ error: 'merchantId required' })
    if (!buyerEmail)            return res.status(400).json({ error: 'buyerEmail required' })

    const buyerToken    = skipInvites ? null : require('crypto').randomUUID()
    const supplierToken = skipInvites || !supplierEmail ? null : require('crypto').randomUUID()

    const workspaces = []
    for (const catalogSkuId of catalogSkuIds) {
      const { data: workspace, error: wsError } = await supabase
        .from('npd2_workspaces')
        .insert([{
          catalog_sku_id:     catalogSkuId,
          merchant_member_id: merchantId,
          buyer_email:        buyerEmail,
          supplier_email:     supplierEmail  || null,
          supplier_org_id:    supplierOrgId  || null,
          buyer_org_id:       buyerOrgId     || null,
          status:             'invited',
        }])
        .select()
        .single()
      if (wsError) throw wsError

      if (!skipInvites) {
        await supabase.from('npd2_invites').insert([{
          workspace_id: workspace.id, email: buyerEmail, role: 'buyer',
          token: buyerToken, status: 'pending',
        }])
        if (supplierEmail) {
          await supabase.from('npd2_invites').insert([{
            workspace_id: workspace.id, email: supplierEmail, role: 'supplier',
            token: supplierToken, status: 'pending',
          }])
        }
      }

      workspaces.push(workspace)
    }

    if (!skipInvites) {
      // Fetch SKU details for email summary
      const { data: skus } = await supabase
        .from('npd2_catalog_skus')
        .select('auto_code, description, npd2_catalog_uploads ( supplier, season )')
        .in('id', catalogSkuIds)

      const skuCodes   = skus?.map(s => s.auto_code).join(', ') || ''
      const suppliers  = [...new Set(skus?.map(s => s.npd2_catalog_uploads?.supplier).filter(Boolean) || [])].join(', ')
      const seasons    = [...new Set(skus?.map(s => s.npd2_catalog_uploads?.season).filter(Boolean) || [])].join(', ')
      const buyerLink  = `${frontendUrl}/plm/accept?token=${buyerToken}`

      await sendAlertEmail(
        [{ email: buyerEmail }],
        `PLM invite — ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`,
        {
          sku_code:      skuCodes,
          description:   `${workspaces.length} new workspace${workspaces.length === 1 ? '' : 's'} have been created for you`,
          supplier:      suppliers,
          season:        seasons,
          role:          'buyer',
          invite_link:   buyerLink,
          merchant_name: 'Twif',
        },
        'PLM_INVITE'
      )

      if (supplierEmail && supplierToken) {
        const supplierLink = `${frontendUrl}/plm/accept?token=${supplierToken}`
        await sendAlertEmail(
          [{ email: supplierEmail }],
          `PLM invite — ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`,
          {
            sku_code:      skuCodes,
            description:   `${workspaces.length} new workspace${workspaces.length === 1 ? '' : 's'} have been created for you`,
            supplier:      suppliers,
            season:        seasons,
            role:          'supplier',
            invite_link:   supplierLink,
            merchant_name: 'Twif',
          },
          'PLM_INVITE'
        )
      }
    }

    return res.json({ success: true, workspaces, buyerLink: skipInvites ? null : `${frontendUrl}/plm/accept?token=${buyerToken}` })
  } catch (err) {
    console.error('❌ POST /sku-workspaces/bulk:', err)
    return res.status(500).json({ error: err.message })
  }
})


router.post('/workspace-invites/accept', async (req, res) => {
  try {
    const { token, memberId } = req.body
    if (!token || !memberId) return res.status(400).json({ error: 'token and memberId required' })

    const { data: invites, error: invErr } = await supabase
      .from('npd2_invites')
      .select('*, npd2_workspaces(*)')
      .eq('token', token)

    if (invErr || !invites?.length) return res.status(404).json({ error: 'Invalid invite link' })

    // Filter out revoked rows — revoking one workspace from a bulk invite shouldn't block the rest
    const activeInvites = invites.filter(i => i.status !== 'revoked')
    if (!activeInvites.length)
      return res.status(403).json({ error: 'This invite has been revoked' })

    const first = activeInvites[0]

    if (first.status === 'accepted' || first.accepted_at) {
      // Only redirect to workspace if the same member who accepted is re-clicking their own link
      const acceptedBySelf = first.member_id === memberId
      return res.status(409).json({
        error: 'Invite already accepted',
        ...(acceptedBySelf
          ? (activeInvites.length === 1
              ? { workspaceId: first.workspace_id }
              : { workspaceIds: activeInvites.map(i => i.workspace_id) })
          : {}),
      })
    }

    if (first.status === 'expired' || (first.expires_at && new Date(first.expires_at) < new Date())) {
      if (first.status !== 'expired')
        await supabase.from('npd2_invites').update({ status: 'expired' }).eq('token', token)
      return res.status(410).json({ error: 'This invite has expired' })
    }

    // Verify the accepting member's email matches the invite recipient
    if (first.email) {
      const { data: member } = await supabase
        .from('organization_members')
        .select('email')
        .eq('id', memberId)
        .maybeSingle()
      if (!member || member.email?.toLowerCase() !== first.email.toLowerCase())
        return res.status(403).json({ error: 'This invite was sent to a different email address.' })
    }

    const memberField = first.role === 'buyer' ? 'buyer_member_id' : 'supplier_member_id'
    for (const invite of activeInvites) {
      // Only set the primary slot if it isn't already taken by someone else (multi-invite support)
      const { data: ws } = await supabase
        .from('npd2_workspaces')
        .select(memberField)
        .eq('id', invite.workspace_id)
        .maybeSingle()
      const isFirstBuyer = !ws?.[memberField]
      const workspaceUpdate = {}
      if (isFirstBuyer) workspaceUpdate[memberField] = memberId
      // Only the first buyer to accept moves the workspace to 'active' — a co-buyer joining
      // later must never touch status, no matter what stage the workspace has since reached
      if (invite.role === 'buyer' && isFirstBuyer) workspaceUpdate.status = 'active'
      if (Object.keys(workspaceUpdate).length)
        await supabase.from('npd2_workspaces').update(workspaceUpdate).eq('id', invite.workspace_id)
    }

    const activeIds = activeInvites.map(i => i.id)
    await supabase
      .from('npd2_invites')
      .update({ status: 'accepted', accepted_at: new Date(), member_id: memberId })
      .in('id', activeIds)

    return res.json({
      success: true,
      role: first.role,
      ...(activeInvites.length === 1
        ? { workspaceId: first.workspace_id }
        : { workspaceIds: activeInvites.map(i => i.workspace_id) }),
    })
  } catch (err) {
    console.error('❌ POST /workspace-invites/accept:', err)
    return res.status(500).json({ error: err.message })
  }
})


// NOTE: must be registered before 'PATCH /workspaces/:id' below — Express matches routes in
// registration order, and 'bulk-status' would otherwise be captured as the :id param.
router.patch('/workspaces/bulk-status', requireAuth, async (req, res) => {
  try {
    const { workspace_ids, status, note } = req.body
    if (!Array.isArray(workspace_ids) || !workspace_ids.length)
      return res.status(400).json({ error: 'workspace_ids required' })

    const allowed = ['active', 'inactive', 'on_hold', 'rejected', 'approved', 'sample', 'production', 'reviewing']
    if (!allowed.includes(status))
      return res.status(400).json({ error: 'Invalid status' })

    const member = await resolveMember(req, res)
    if (!member) return

    const { data: workspaces, error: wsErr } = await supabase
      .from('npd2_workspaces')
      .select('id, status, pre_hold_status, buyer_member_id, merchant_member_id')
      .in('id', workspace_ids)
    if (wsErr) throw wsErr
    if (!workspaces || workspaces.length !== workspace_ids.length)
      return res.status(404).json({ error: 'One or more workspaces not found' })

    // Only the merchant or a buyer/co-buyer on EACH workspace may change its status
    const roleByWs = {}
    for (const ws of workspaces) {
      const role = await resolveWorkspaceActorRole(ws.id, member.id, ws)
      if (!role) return res.status(403).json({ error: 'Only the buyer(s) or merchant on a workspace can change its status' })
      roleByWs[ws.id] = role
    }
    const wsById = Object.fromEntries(workspaces.map(w => [w.id, w]))
    const resolvedStatuses = {}

    await Promise.all(workspace_ids.map(async (id) => {
      const current = wsById[id]
      const wasPaused = ['on_hold', 'rejected'].includes(current.status)

      // Resuming ('active' requested on a paused workspace) restores whatever stage it was
      // actually in before being paused — approved/sample/production — instead of always
      // dropping it back to 'active', which used to hide the Sample tab (and everything in
      // it) even though the underlying sample order was still there, untouched, in the DB.
      let nextStatus = status
      let nextPreHoldStatus = current.pre_hold_status
      if (status === 'active' && wasPaused) {
        nextStatus = current.pre_hold_status || 'active'
        nextPreHoldStatus = null
      } else if (['on_hold', 'rejected'].includes(status) && !wasPaused) {
        // First time entering a paused state — capture the real stage so it can be restored.
        nextPreHoldStatus = current.status
      } else if (!['on_hold', 'rejected'].includes(status)) {
        // Any other explicit status change makes the stashed value stale — clear it.
        nextPreHoldStatus = null
      }

      const { error } = await supabase.from('npd2_workspaces')
        .update({ status: nextStatus, pre_hold_status: nextPreHoldStatus })
        .eq('id', id)
      if (error) throw error
      resolvedStatuses[id] = nextStatus
      await insertSystemComment2(id, member.id, roleByWs[id], 'milestone', null,
        { event: `status_changed_to_${nextStatus}`, note: note || '' })
      if (nextStatus === 'on_hold') {
        try {
          await pctService.onPlmSyncEvent('workspace_on_hold', id)
        } catch (pctErr) {
          console.error('PCT sync failed (on_hold):', pctErr)
        }
      }
    }))

    // Resuming a paused workspace can resolve to a different status than what was requested
    // (e.g. 'active' requested, 'approved' restored) — callers need the real per-workspace
    // result to keep local state in sync instead of assuming everything became `status`.
    return res.json({ success: true, statuses: resolvedStatuses })
  } catch (err) {
    console.error('❌ PATCH /workspaces/bulk-status:', err)
    return res.status(500).json({ error: err.message })
  }
})



router.patch('/workspaces/:id', async (req, res) => {
  try {
    const { customerId, role, ...fields } = req.body
    if (!customerId || !role) return res.status(400).json({ error: 'customerId and role required' })

    const allowed = [
      'target_price', 'target_qty', 'buyer_ref', 'buyer_brief',
      'supplier_in_buyer_chat', 'vendor_stock_number',
    ]

    const updates = {}
    const changes = []

    const { data: current, error: fetchErr } = await supabase
      .from('npd2_workspaces').select(allowed.join(', ')).eq('id', req.params.id).maybeSingle()
    if (fetchErr) throw fetchErr
    if (!current) return res.status(404).json({ error: 'Workspace not found' })

    for (const field of allowed) {
      if (fields[field] !== undefined && JSON.stringify(fields[field]) !== JSON.stringify(current[field])) {
        updates[field] = fields[field]
        if (field !== 'buyer_brief' && field !== 'supplier_in_buyer_chat') {
          changes.push({ field, from: current[field], to: fields[field] })
        }
      }
    }

    const briefKeyMap = {
      brief_description:   'description',
      brief_material:      'material',
      brief_weight:        'weight',
      brief_dimensions:    'dimensions',
      brief_finish:        'finish',
      brief_color:         'color',
      brief_quality_notes: 'quality_notes',
    }
    for (const [flatKey, logKey] of Object.entries(briefKeyMap)) {
      if (fields[flatKey] !== undefined) {
        const oldVal = current.buyer_brief?.[logKey] ?? ''
        const newVal = fields[flatKey] ?? ''
        if (String(oldVal) !== String(newVal)) {
          changes.push({ field: logKey, from: oldVal, to: newVal })
        }
        delete updates[flatKey]
      }
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No changes detected' })

    const { data: updated, error: updateErr } = await supabase
      .from('npd2_workspaces').update(updates).eq('id', req.params.id).select().single()
    if (updateErr) throw updateErr

    for (const change of changes) {
      await insertSystemComment(req.params.id, customerId, role, 'field_change', null,
        { field: change.field, from: String(change.from ?? ''), to: String(change.to) })
    }

    return res.json({ success: true, workspace: updated })
  } catch (err) {
    console.error('❌ PATCH /workspaces/:id:', err)
    return res.status(500).json({ error: err.message })
  }
})


router.patch('/sku-workspaces/:id', requireAuth, async (req, res) => {
  try {
    const { ...fields } = req.body
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    // Derive role from workspace
    const allowed = [
      'target_price', 'target_qty', 'buyer_ref', 'buyer_brief',
      'supplier_in_buyer_chat', 'vendor_stock_number',
    ]

    const { data: current, error: fetchErr } = await supabase
      .from('npd2_workspaces')
      .select(`merchant_member_id, buyer_member_id, supplier_member_id, ${allowed.join(', ')}`)
      .eq('id', req.params.id)
      .maybeSingle()
    if (fetchErr) throw fetchErr
    if (!current) return res.status(404).json({ error: 'Workspace not found' })

    let role = 'merchant'
    if (current.buyer_member_id    === memberId) role = 'buyer'
    else if (current.supplier_member_id === memberId) role = 'supplier'

    const updates = {}
    const changes = []

    for (const field of allowed) {
      if (field === 'buyer_brief') {
        // The client now sends only the sub-fields IT actually edited (a partial patch),
        // not the whole brief — merge that patch into the freshly-fetched current brief
        // instead of replacing it wholesale. This is what stops a second concurrent editor
        // (e.g. a paired merchant, or a co-buyer — up to 4 can be on a workspace at once)
        // from silently reverting fields elsewhere in the brief that they never touched.
        const patch = fields.buyer_brief
        if (!patch || !Object.keys(patch).length) continue
        const oldBrief = current.buyer_brief || {}
        updates.buyer_brief = { ...oldBrief, ...patch }
        // Only log activity for human-readable brief fields — image_url (pinning), buyer_ref,
        // and amount_usd are bookkeeping values that would otherwise show a raw storage URL
        // in the feed ("set image_url to https://...") instead of anything meaningful.
        const LOGGABLE_BRIEF_FIELDS = ['description', 'color', 'material', 'finish', 'weight', 'dimensions', 'unit_price', 'unit_qty', 'currency', 'quality_notes']
        for (const f of Object.keys(patch)) {
          if (!LOGGABLE_BRIEF_FIELDS.includes(f)) continue
          const oldVal = String(oldBrief[f] ?? '')
          const newVal = String(patch[f] ?? '')
          if (oldVal !== newVal) changes.push({ field: f, from: oldBrief[f] ?? '', to: patch[f] ?? '' })
        }
        continue
      }
      if (fields[field] !== undefined && JSON.stringify(fields[field]) !== JSON.stringify(current[field])) {
        updates[field] = fields[field]
        if (field !== 'supplier_in_buyer_chat') changes.push({ field, from: current[field], to: fields[field] })
      }
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No changes detected' })

    const { data: updated, error: updateErr } = await supabase
      .from('npd2_workspaces').update(updates).eq('id', req.params.id).select().single()
    if (updateErr) throw updateErr

    for (const change of changes) {
      await insertSystemComment2(req.params.id, memberId, role, 'field_change', null,
        { field: change.field, from: String(change.from ?? ''), to: String(change.to) })
    }

    return res.json({ success: true, workspace: updated })
  } catch (err) {
    console.error('❌ PATCH /workspaces/:id:', err)
    return res.status(500).json({ error: err.message })
  }
})

router.patch('/workspaces/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body
    const allowed = ['active', 'on_hold', 'rejected', 'approved', 'production', 'sample']
    if (!allowed.includes(status)) return res.status(400).json({ error: `Invalid status` })

    const member = await resolveMember(req, res)
    if (!member) return

    const { data: workspace, error: fetchErr } = await supabase
      .from('npd2_workspaces')
      .select('id, buyer_member_id, merchant_member_id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (fetchErr) throw fetchErr
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' })

    // Only the buyer(s) — including co-buyers — or the merchant can move the pipeline
    // stage; supplier never can
    const role = await resolveWorkspaceActorRole(req.params.id, member.id, workspace)
    if (!role) return res.status(403).json({ error: 'Only the buyer or merchant can change workspace status' })

    const { data: updated, error } = await supabase
      .from('npd2_workspaces').update({ status }).eq('id', req.params.id).select().single()
    if (error) throw error

    await insertSystemComment(req.params.id, member.id, role, 'milestone', null,
      { event: `status_changed_to_${status}`, stage: 'negotiation' })

    return res.json({ success: true, workspace: updated })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})


router.post('/workspaces/:id/approve', requireAuth, async (req, res) => {
  try {
    const { buyerRef } = req.body
    if (!buyerRef?.trim()) return res.status(400).json({ error: 'buyerRef required' })

    const member = await resolveMember(req, res)
    if (!member) return

    const { data: ws, error: wsErr } = await supabase
      .from('npd2_workspaces')
      .select('id, status, target_price, target_qty, buyer_member_id, merchant_member_id')
      .eq('id', req.params.id).maybeSingle()
    if (wsErr) throw wsErr
    if (!ws)                          return res.status(404).json({ error: 'Workspace not found' })

    const actorRole = await resolveWorkspaceActorRole(req.params.id, member.id, ws)
    if (!actorRole) return res.status(403).json({ error: 'Only the buyer(s) or merchant on this workspace can approve it' })

    if (ws.status === 'approved')     return res.status(409).json({ error: 'Already approved' })
    if (!ws.target_price || !ws.target_qty) return res.status(400).json({ error: 'Set target price and qty first' })

    const { data: existing } = await supabase
      .from('npd2_sample_orders').select('id').eq('workspace_id', req.params.id).maybeSingle()
    if (existing) return res.status(409).json({ error: 'Sample order already exists' })

    const { data: updated, error: updateErr } = await supabase
      .from('npd2_workspaces').update({ status: 'sample', buyer_ref: buyerRef.trim() }).eq('id', req.params.id).select().single()
    if (updateErr) throw updateErr

    const { data: sampleOrder, error: sampleErr } = await supabase
      .from('npd2_sample_orders')
      .insert([{
        workspace_id:    req.params.id,
        buyer_ref:       buyerRef.trim(),
        confirmed_price: ws.target_price,
        confirmed_qty:   ws.target_qty,
        sample_status:   'in_process',
      }])
      .select().single()
    if (sampleErr) throw sampleErr

    await insertSystemComment(req.params.id, member.id, actorRole, 'milestone', null,
      { event: 'moved_to_sample', stage: 'sample', buyer_ref: buyerRef.trim() })

    return res.json({ success: true, workspace: updated, sampleOrder })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})


router.post('/sku-workspaces/:id/approve', requireAuth, async (req, res) => {
  try {
    const { confirmedPrice, confirmedQty, confirmedCurrency, confirmedAmountUsd } = req.body
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const { data: ws, error: wsErr } = await supabase
      .from('npd2_workspaces')
      .select('id, status, buyer_ref, buyer_brief, buyer_member_id, merchant_member_id, reference_media')
      .eq('id', req.params.id)
      .maybeSingle()
    if (wsErr) throw wsErr
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    const actorRole = await resolveWorkspaceActorRole(req.params.id, memberId, ws)
    if (!actorRole) return res.status(403).json({ error: 'Only the buyer(s) or merchant on this workspace can approve it' })

    if (['approved', 'sample', 'production'].includes(ws.status))
  return res.status(409).json({ error: 'Already approved' })

    const brief = ws.buyer_brief || {}
    const price = confirmedPrice ?? brief.unit_price
    const qty   = confirmedQty   ?? brief.unit_qty

    if (!price || !qty) return res.status(400).json({ error: 'Confirmed price and qty required' })
    if (!ws.buyer_ref)  return res.status(400).json({ error: 'Buyer reference required' })

    const { data: existing } = await supabase
      .from('npd2_sample_orders')
      .select('id')
      .eq('workspace_id', req.params.id)
      .not('sample_status', 'in', '("dropped","reopened")')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (existing) return res.status(409).json({ error: 'Sample order already exists' })

    // npd2_sample_orders has a UNIQUE constraint on workspace_id — only one row can ever
    // exist per workspace, regardless of its sample_status. The check above intentionally
    // ignores 'dropped'/'reopened' rows so a revision cycle can re-approve, but an unconditional
    // INSERT here still collided with that leftover row and threw a duplicate-key error. Find
    // any existing row (dropped/reopened) and update it in place instead of inserting a new one.
    const { data: existingAny } = await supabase
      .from('npd2_sample_orders')
      .select('id, findings')
      .eq('workspace_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Archive the previous round's sample images into Reference Media before wiping findings
    // below — the numeric findings (weights/dims) don't need preserving since every change to
    // them already produced a field_change comment in Activity, but images have no such
    // history anywhere else, so losing the findings JSON would make them vanish for good.
    const priorSampleImages = existingAny?.findings?.sample_images || []
    let referenceMediaUpdate = null
    if (priorSampleImages.length) {
      const currentMedia = ws.reference_media || []
      const existingUrls = new Set(currentMedia.map(m => m.url))
      const toArchive = priorSampleImages.filter(url => url && !existingUrls.has(url))
      if (toArchive.length) {
        referenceMediaUpdate = [...currentMedia, ...toArchive.map(url => ({ url, rejected: true }))]
      }
    }

    const { data: updated, error: updateErr } = await supabase
      .from('npd2_workspaces')
      .update({ status: 'approved', ...(referenceMediaUpdate && { reference_media: referenceMediaUpdate }) })
      .eq('id', req.params.id)
      .select()
      .single()
    if (updateErr) throw updateErr

    // Freeze both the currency the price is denominated in AND its USD equivalent at this
    // exact moment — buyer_brief.currency is live/editable and can change afterward, so
    // anything reading confirmed_price later must not have to guess what currency it was in.
    const currency  = confirmedCurrency || brief.currency || 'USD'
    const amountUsd = confirmedAmountUsd != null ? Number(confirmedAmountUsd) : null

    // Fresh sample round — clear out any leftover data from a prior dropped/reopened round
    // when reusing that row (see existingAny above). Sample images were already archived into
    // Reference Media above, so nothing is actually lost by nulling findings here.
    const samplePayload = {
      buyer_ref:       ws.buyer_ref,
      confirmed_price: price,
      confirmed_qty:   qty,
      currency,
      amount_usd:      amountUsd,
      sample_status:   'in_process',
      target_ready_date: null, actual_ready_date: null, dispatch_date: null,
      ship_mode: null, tracking_ref: null, etd: null, eta: null,
      additional_notes: null, findings: null,
    }

    const { data: sampleOrder, error: sampleErr } = existingAny
      ? await supabase
          .from('npd2_sample_orders')
          .update(samplePayload)
          .eq('id', existingAny.id)
          .select()
          .single()
      : await supabase
          .from('npd2_sample_orders')
          .insert([{ workspace_id: req.params.id, ...samplePayload }])
          .select()
          .single()
    if (sampleErr) throw sampleErr

    try {
      await pctService.onApprovedToSample(req.params.id, { memberId })
    } catch (pctErr) {
      console.error('PCT handoff failed (non-blocking):', pctErr)
      await supabase.from('pct_handoff_failures').insert({
        workspace_id: req.params.id,
        event_type: 'approve_to_sample',
        error_message: pctErr.message,
        payload: { memberId },
      })
    }

    await insertSystemComment2(req.params.id, memberId, actorRole, 'milestone', null,
      { event: 'approved_to_sample', stage: 'approved', buyer_ref: ws.buyer_ref })

    return res.json({ success: true, workspace: updated, sampleOrder })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})



// ═══════════════════════════════════════════════
// COMMENTS
// ═══════════════════════════════════════════════

router.post('/workspaces/:id/comments', upload.array('attachments', 10), async (req, res) => {
  const uploadedPaths = []
  try {
    const { body, customerId, role, channel } = req.body
    if (!body?.trim() && !(req.files || []).length) return res.status(400).json({ error: 'body or attachments required' })
    if (!customerId) return res.status(400).json({ error: 'customerId required' })
    if (!role)       return res.status(400).json({ error: 'role required' })

    const attachmentUrls = []
    for (const file of req.files || []) {
      const safeName    = file.originalname.replace(/\s+/g, '_')
      const storagePath = `workspaces/${req.params.id}/attachments/${Date.now()}_${safeName}`
      const { error: upErr } = await supabase.storage
        .from(NPD_BUCKET).upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false })
      if (upErr) throw upErr
      uploadedPaths.push(storagePath)
      const { data: urlData } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)
      attachmentUrls.push(urlData.publicUrl)
    }

    let replyTo = null
    if (req.body.reply_to) {
      try { replyTo = JSON.parse(req.body.reply_to) } catch {}
    }

    const { data: comment, error } = await supabase
      .from('npd2_comments')
      .insert([{
        workspace_id: req.params.id,
        author_id:    customerId,
        role:         role.trim(),
        type:         'comment',
        channel:      channel || 'buyer',
        body:         (body || '').trim() || null,
        attachments:  attachmentUrls,
        reply_to:     replyTo,
      }])
      .select().single()
    if (error) throw error

    return res.json({ success: true, comment })
  } catch (err) {
    if (uploadedPaths.length) await supabase.storage.from(NPD_BUCKET).remove(uploadedPaths)
    return res.status(500).json({ error: err.message })
  }
})



router.post('/sku-workspaces/:id/comments', requireAuth, upload.array('files', 10), async (req, res) => {
  const uploadedPaths = []
  try {
    const { body, channel } = req.body
    if (!body?.trim() && !(req.files || []).length)
      return res.status(400).json({ error: 'body or attachments required' })
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    // Derive role from workspace
    const { data: ws, error: wsErr } = await supabase
      .from('npd2_workspaces')
      .select('merchant_member_id, buyer_member_id, supplier_member_id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (wsErr) throw wsErr
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    let role = 'merchant'
    if (ws.buyer_member_id === memberId) role = 'buyer'
    else if (ws.supplier_member_id === memberId) role = 'supplier'
    else {
      // Multi-invite: check accepted invites for this member
      const { data: inv } = await supabase
        .from('npd2_invites')
        .select('role')
        .eq('workspace_id', req.params.id)
        .eq('member_id', memberId)
        .eq('status', 'accepted')
        .maybeSingle()
      if (inv) role = inv.role
    }

    const attachments = []
    for (const file of req.files || []) {
      const safeName    = file.originalname.replace(/\s+/g, '_')
      const storagePath = `workspaces/${req.params.id}/attachments/${Date.now()}_${safeName}`
      const { error: upErr } = await supabase.storage
        .from(NPD_BUCKET).upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false })
      if (upErr) throw upErr
      uploadedPaths.push(storagePath)
      const { data: urlData } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)
      attachments.push({ url: urlData.publicUrl, name: file.originalname, type: file.mimetype })
    }

    let replyTo = null
    if (req.body.reply_to) {
  try {
    replyTo = typeof req.body.reply_to === 'string'
      ? JSON.parse(req.body.reply_to)
      : req.body.reply_to
  } catch {}
}

    const { data: comment, error } = await supabase
      .from('npd2_comments')
      .insert([{
        workspace_id:     req.params.id,
        author_member_id: memberId,
        role,
        type:             'comment',
        channel:          channel || 'buyer',
        body:             (body || '').trim() || null,
        attachments,
        reply_to:         replyTo,
      }])
      .select().single()
    if (error) throw error

    return res.json({ success: true, comment })
  } catch (err) {
    if (uploadedPaths.length) await supabase.storage.from(NPD_BUCKET).remove(uploadedPaths)
    return res.status(500).json({ error: err.message })
  }
})


// ═══════════════════════════════════════════════
// SAMPLE ORDERS
// ═══════════════════════════════════════════════

router.patch('/sample-orders/:id', async (req, res) => {
  try {
    const { customerId, role, ...fields } = req.body
    if (!customerId || !role) return res.status(400).json({ error: 'customerId and role required' })

    const allowed = ['sample_status','target_ready_date','actual_ready_date','dispatch_date','ship_mode','tracking_ref','etd','eta','additional_notes']
    const updates = {}
    for (const field of allowed) {
      if (fields[field] !== undefined) updates[field] = fields[field]
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' })

    const { data: order, error } = await supabase
      .from('npd2_sample_orders').update(updates).eq('id', req.params.id).select('*, workspace_id').single()
    if (error) throw error

    if (updates.sample_status && order.workspace_id) {
      await insertSystemComment(order.workspace_id, customerId, role, 'milestone', null,
        { event: `sample_${updates.sample_status}`, stage: 'sample' })
    }

    return res.json({ success: true, sampleOrder: order })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})


router.patch('/sku-sample-orders/:id', requireAuth, async (req, res) => {
  try {
    const { ...fields } = req.body
    const role = (req.body.role || 'merchant').toLowerCase()
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const allowed = ['sample_status','target_ready_date','actual_ready_date',
                     'dispatch_date','ship_mode','tracking_ref','etd','eta','additional_notes','findings']
    const updates = {}
    for (const field of allowed) {
      if (fields[field] !== undefined) updates[field] = fields[field]
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' })

    // Fetch existing order for "from" values
    const { data: existing } = await supabase
      .from('npd2_sample_orders').select('*').eq('id', req.params.id).single()

    // The client sends only the findings sub-fields it actually edited (a partial patch) —
    // merge into the freshly-fetched current findings instead of replacing wholesale, so a
    // concurrent editor (e.g. a paired merchant) can't silently wipe out fields this request
    // never touched. Skipped when resuming from dropped below, which intentionally clears it.
    if (fields.findings && Object.keys(fields.findings).length) {
      updates.findings = { ...(existing?.findings || {}), ...fields.findings }
    }

    // Resuming a dropped round back to "In Process" starts a fresh round of findings —
    // snapshot the previous round's findings into npd2_workspace_versions (the same table
    // reject/revision already write to) before clearing them, so the "View Previous
    // Findings" dropdown still has something to show once the fields are blank again.
    const resumingFromDropped = updates.sample_status === 'in_process' && existing?.sample_status === 'dropped'
    if (resumingFromDropped && existing?.workspace_id) {
      const { data: last } = await supabase
        .from('npd2_workspace_versions').select('version')
        .eq('workspace_id', existing.workspace_id)
        .order('version', { ascending: false }).limit(1).maybeSingle()
      const version = (last?.version || 0) + 1
      const { error: versionErr } = await supabase.from('npd2_workspace_versions').insert({
        workspace_id: existing.workspace_id, version, type: 'sample',
        brief_json: null,
        // Confirmed price/qty/currency/buyer_ref aren't in their own columns on this table,
        // so they ride along inside findings_json (already a JSONB blob) under underscore-
        // prefixed keys — kept distinct from real finding fields so BriefRow et al never
        // pick them up when rendering a past round's findings.
        findings_json: {
          ...(existing.findings || {}),
          _confirmed_price: existing.confirmed_price ?? null,
          _confirmed_qty: existing.confirmed_qty ?? null,
          _currency: existing.currency ?? null,
          _buyer_ref: existing.buyer_ref ?? null,
        },
        note: null, created_by: memberId,
      })
      if (versionErr) throw versionErr

      // Archive this round's sample images into Reference Media, tagged rejected — otherwise
      // they'd vanish from the Media panel entirely once findings clears below (the Media
      // panel reads live findings.sample_images, not the version snapshot).
      const priorSampleImages = existing.findings?.sample_images || []
      if (priorSampleImages.length) {
        const { data: wsRow } = await supabase
          .from('npd2_workspaces').select('reference_media').eq('id', existing.workspace_id).maybeSingle()
        const currentMedia = wsRow?.reference_media || []
        const existingUrls = new Set(currentMedia.map(m => m.url))
        const toArchive = priorSampleImages.filter(url => url && !existingUrls.has(url))
        if (toArchive.length) {
          await supabase.from('npd2_workspaces')
            .update({ reference_media: [...currentMedia, ...toArchive.map(url => ({ url, rejected: true }))] })
            .eq('id', existing.workspace_id)
        }
      }

      updates.findings = null
    }

    const { data: order, error } = await supabase
      .from('npd2_sample_orders').update(updates).eq('id', req.params.id)
      .select('*, workspace_id').single()
    if (error) throw error

    // Log milestone for status change
    if (updates.sample_status && order.workspace_id) {
      await insertSystemComment2(order.workspace_id, memberId, role, 'milestone', null,
        { event: `sample_${updates.sample_status}`, stage: 'sample' })
      if (updates.sample_status === 'ready') {
        try {
          await pctService.onPlmSyncEvent('sample_ready', order.workspace_id)
        } catch (pctErr) {
          console.error('PCT sync failed (sample_ready):', pctErr)
        }
      }
    }

    // Log a specific change per findings sub-field (mirrors the buyer_brief field_change
    // pattern above) instead of one generic "Sample Findings Updated" milestone that never
    // said what actually changed. sample_images/approved_image are URLs, not human-readable
    // values, so they get their own friendly milestone events instead of "set X to <url>".
    if (fields.findings && Object.keys(fields.findings).length && order.workspace_id && !resumingFromDropped) {
      const oldF = existing?.findings || {}
      const newF = updates.findings || {}

      // Single-value measurements: one field_change line each.
      const SINGLE_FIELDS = ['actual_weight', 'inner_qty', 'master_qty', 'master_pack_weight_kg', 'cbm']
      for (const f of SINGLE_FIELDS) {
        if (!(f in fields.findings)) continue
        const oldVal = oldF[f] ?? ''
        const newVal = newF[f] ?? ''
        if (String(oldVal) !== String(newVal)) {
          await insertSystemComment2(order.workspace_id, memberId, role, 'field_change', null,
            { field: f, from: oldVal, to: newVal })
        }
      }

      // L×W×H triplets: the UI edits/shows these as one row each, so collapse each
      // triplet into a single "set Actual L×W×H to 1 × 1 × 1" line instead of three
      // separate ones — matches the 8 rows on screen (5 singles + 3 dimension rows)
      // instead of spamming 13 lines for one save.
      const DIM_GROUPS = [
        { field: 'actual_dims', prefix: 'actual' },
        { field: 'inner_dims',  prefix: 'inner' },
        { field: 'master_dims', prefix: 'master' },
      ]
      for (const { field, prefix } of DIM_GROUPS) {
        const subKeys = [`${prefix}_l`, `${prefix}_w`, `${prefix}_h`]
        if (!subKeys.some(k => k in fields.findings)) continue
        const oldVals = subKeys.map(k => oldF[k])
        const newVals = subKeys.map(k => newF[k])
        const changed = oldVals.some((v, i) => String(v ?? '') !== String(newVals[i] ?? ''))
        if (!changed) continue
        const fmt = vals => vals.some(v => v != null && v !== '') ? vals.map(v => v ?? '—').join(' × ') : ''
        await insertSystemComment2(order.workspace_id, memberId, role, 'field_change', null,
          { field, from: fmt(oldVals), to: fmt(newVals) })
      }

      if ('sample_images' in fields.findings) {
        const oldImgs = oldF.sample_images || []
        const newImgs = newF.sample_images || []
        const changed = newImgs.length !== oldImgs.length || newImgs.some((u, i) => u !== oldImgs[i])
        if (changed) {
          await insertSystemComment2(order.workspace_id, memberId, role, 'milestone', null,
            { event: 'sample_images_updated', stage: 'sample', count: newImgs.length })
        }
      }

      if ('approved_image' in fields.findings && (oldF.approved_image || null) !== (newF.approved_image || null)) {
        await insertSystemComment2(order.workspace_id, memberId, role, 'milestone', null,
          { event: newF.approved_image ? 'production_image_set' : 'production_image_unset', stage: 'sample' })
      }
    }


    // Log field_change for other field updates
    const logFields = ['target_ready_date','actual_ready_date','additional_notes',
                       'dispatch_date','ship_mode','tracking_ref','etd','eta']
    for (const field of logFields) {
      if (updates[field] !== undefined && order.workspace_id) {
        await insertSystemComment2(order.workspace_id, memberId, role, 'field_change', null,
          { field, from: existing?.[field] ?? null, to: updates[field] })
      }
    }

    return res.json({ success: true, sampleOrder: order })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Previous rounds of sample findings — snapshotted into npd2_workspace_versions whenever a
// round ends (reject-sample, request-revision, or resuming a dropped round back to
// in_process). Powers the "View Previous Findings" dropdown in the Sample tab.
router.get('/sku-workspaces/:id/sample-versions', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req, res)
    if (!member) return

    const { data: ws } = await supabase
      .from('npd2_workspaces').select('id, buyer_member_id, merchant_member_id')
      .eq('id', req.params.id).maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    const actorRole = await resolveWorkspaceActorRole(req.params.id, member.id, ws)
    if (!actorRole && ws.merchant_member_id !== member.id)
      return res.status(403).json({ error: 'Not a member of this workspace' })

    const { data, error } = await supabase
      .from('npd2_workspace_versions')
      .select('version, findings_json, note, created_at')
      .eq('workspace_id', req.params.id)
      .eq('type', 'sample')
      .order('version', { ascending: false })
    if (error) throw error

    return res.json({ versions: data || [] })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})


router.patch('/workspaces/:id/supplier-access', async (req, res) => {
  const { id } = req.params
  const { allow, customerId, role } = req.body

  if (role !== 'merchant') {
    return res.status(403).json({ error: 'Only merchants can change supplier access' })
  }

  try {
    const { data, error } = await supabase
      .from('npd2_workspaces')
      .update({ supplier_in_buyer_chat: allow })
      .eq('id', id)
      .eq('merchant_id', customerId)
      .select()
      .single()

    if (error) throw error
    res.json({ workspace: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/sku-sample-orders/:id/images', requireAuth, upload.array('images', 10), async (req, res) => {
  const { workspaceId } = req.body
  const files = req.files || []
  if (!files.length) return res.status(400).json({ error: 'No images provided' })

  const uploaded = []
  for (const file of files) {
    const ext      = path.extname(file.originalname).toLowerCase() || '.jpg'
    const filename = `${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`
    const filePath = `samples/${workspaceId}/${filename}`

    const { error } = await supabase.storage
      .from(NPD_BUCKET)
      .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: false })
    if (error) throw error

    const { data: urlData } = supabase.storage.from(NPD_BUCKET).getPublicUrl(filePath)
    uploaded.push(urlData.publicUrl)
  }

  // Merge into findings.sample_images
  const { data: order } = await supabase
    .from('npd2_sample_orders').select('findings').eq('id', req.params.id).single()
  const existing = order?.findings?.sample_images || []
  const findings = { ...(order?.findings || {}), sample_images: [...existing, ...uploaded] }

  await supabase.from('npd2_sample_orders').update({ findings }).eq('id', req.params.id)

  return res.json({ success: true, urls: uploaded })
})

router.post('/sku-workspaces/:id/revision', requireAuth, async (req, res) => {
  try {
    const { note } = req.body
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const { data: ws } = await supabase
      .from('npd2_workspaces').select('id, status, buyer_brief, buyer_member_id')
      .eq('id', req.params.id).maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    // Only the buyer can request a revision — this matches the frontend, which only
    // ever shows this action to role === 'buyer'; merchant/supplier never trigger it
    if (ws.buyer_member_id !== memberId)
      return res.status(403).json({ error: 'Only the buyer can request a revision' })

    const { data: so } = await supabase
      .from('npd2_sample_orders').select('id, findings, confirmed_price, confirmed_qty, currency, buyer_ref')
      .eq('workspace_id', req.params.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()

    // Frontend hides Accept/Reject/Reopen until sample photos exist — enforce it here too
    // so it can't be bypassed by calling this endpoint directly.
    if (!so?.findings?.sample_images?.length)
      return res.status(400).json({ error: 'Cannot reopen the brief — no sample photos have been shared for this round yet' })

    const { data: last } = await supabase
      .from('npd2_workspace_versions').select('version')
      .eq('workspace_id', req.params.id)
      .order('version', { ascending: false }).limit(1).maybeSingle()

    const version = (last?.version || 0) + 1

    const { error: versionErr } = await supabase.from('npd2_workspace_versions').insert({
      workspace_id: req.params.id, version, type: 'sample',
      brief_json: ws.buyer_brief,
      // See resume-from-dropped (PATCH /sku-sample-orders/:id) for why price/qty/currency/
      // buyer_ref ride along inside findings_json under underscore-prefixed keys instead of
      // their own columns.
      findings_json: {
        ...(so?.findings || {}),
        _confirmed_price: so?.confirmed_price ?? null,
        _confirmed_qty: so?.confirmed_qty ?? null,
        _currency: so?.currency ?? null,
        _buyer_ref: so?.buyer_ref ?? null,
      },
      note: note || null, created_by: memberId,
    })
    if (versionErr) throw versionErr

    // Reopening the brief closes out this sample round — distinct from an explicit
    // reject, so the badge doesn't lie about what happened — otherwise the old sample
    // order blocks re-approval later with "Sample order already exists"
    if (so?.id) {
      const { error: soErr } = await supabase.from('npd2_sample_orders')
        .update({ sample_status: 'reopened' }).eq('id', so.id)
      if (soErr) throw soErr
    }

    const { data: updated, error: updateErr } = await supabase
      .from('npd2_workspaces').update({ status: 'active' })
      .eq('id', req.params.id).select().single()
    if (updateErr) throw updateErr

    await insertSystemComment(req.params.id, memberId, 'buyer', 'milestone', null,
      { event: 'revision_requested', note: note || '', version })

    try {
      await pctService.onPlmSyncEvent('revision_requested', req.params.id, { note })
    } catch (pctErr) {
      console.error('PCT sync failed (revision):', pctErr)
    }

    return res.json({ success: true, workspace: updated, version })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/sku-workspaces/:id/accept-sample', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const { data: ws } = await supabase
      .from('npd2_workspaces').select('id, buyer_brief, buyer_member_id')
      .eq('id', req.params.id).maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    // Only the buyer can accept a sample — matches the frontend, which only ever
    // shows this action to role === 'buyer'
    if (ws.buyer_member_id !== memberId)
      return res.status(403).json({ error: 'Only the buyer can accept a sample' })

    const { data: so } = await supabase
      .from('npd2_sample_orders').select('findings')
      .eq('workspace_id', req.params.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()

    // Frontend hides Accept/Reject/Reopen until sample photos exist — enforce it here too
    // so it can't be bypassed by calling this endpoint directly.
    if (!so?.findings?.sample_images?.length)
      return res.status(400).json({ error: 'Cannot accept — no sample photos have been shared for this round yet' })

    const { data: last } = await supabase
      .from('npd2_workspace_versions').select('version')
      .eq('workspace_id', req.params.id)
      .order('version', { ascending: false }).limit(1).maybeSingle()

    const version = (last?.version || 0) + 1

    const { error: versionErr } = await supabase.from('npd2_workspace_versions').insert({
      workspace_id: req.params.id, version, type: 'brief',
      brief_json: ws.buyer_brief, findings_json: so?.findings || null,
      note: 'Sample accepted', created_by: memberId,
    })
    if (versionErr) throw versionErr

    const { data: updated, error: updateErr } = await supabase
      .from('npd2_workspaces').update({ status: 'sample' })
      .eq('id', req.params.id).select().single()
    if (updateErr) throw updateErr

    await insertSystemComment(req.params.id, memberId, 'buyer', 'milestone', null,
      { event: 'sample_accepted', stage: 'production' })

    try {
      await pctService.onPlmSyncEvent('sample_accepted', req.params.id)
    } catch (pctErr) {
      console.error('PCT sync failed (sample_accepted):', pctErr)
    }

    return res.json({ success: true, workspace: updated })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/sku-workspaces/:id/reject-sample', requireAuth, async (req, res) => {
  try {
    const { note } = req.body
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const { data: ws } = await supabase
      .from('npd2_workspaces').select('id, buyer_brief, buyer_member_id')
      .eq('id', req.params.id).maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    // Only the buyer can reject a sample — matches the frontend, which only ever
    // shows this action to role === 'buyer'
    if (ws.buyer_member_id !== memberId)
      return res.status(403).json({ error: 'Only the buyer can reject a sample' })

    const { data: so } = await supabase
      .from('npd2_sample_orders').select('id, findings, confirmed_price, confirmed_qty, currency, buyer_ref')
      .eq('workspace_id', req.params.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()

    // Frontend hides Accept/Reject/Reopen until sample photos exist — enforce it here too
    // so it can't be bypassed by calling this endpoint directly.
    if (!so?.findings?.sample_images?.length)
      return res.status(400).json({ error: 'Cannot reject — no sample photos have been shared for this round yet' })

    const { data: last } = await supabase
      .from('npd2_workspace_versions').select('version')
      .eq('workspace_id', req.params.id)
      .order('version', { ascending: false }).limit(1).maybeSingle()

    const version = (last?.version || 0) + 1

    const { error: versionErr } = await supabase.from('npd2_workspace_versions').insert({
      workspace_id: req.params.id, version, type: 'sample',
      brief_json: ws.buyer_brief,
      // See resume-from-dropped (PATCH /sku-sample-orders/:id) for why price/qty/currency/
      // buyer_ref ride along inside findings_json under underscore-prefixed keys instead of
      // their own columns.
      findings_json: {
        ...(so?.findings || {}),
        _confirmed_price: so?.confirmed_price ?? null,
        _confirmed_qty: so?.confirmed_qty ?? null,
        _currency: so?.currency ?? null,
        _buyer_ref: so?.buyer_ref ?? null,
      },
      note: note || null, created_by: memberId,
    })
    if (versionErr) throw versionErr

    if (so?.id) {
      const { error: soErr } = await supabase.from('npd2_sample_orders')
        .update({ sample_status: 'dropped' }).eq('id', so.id)
      if (soErr) throw soErr
    }

    await insertSystemComment(req.params.id, memberId, 'buyer', 'milestone', null,
      { event: 'sample_rejected', note: note || '', version })

    try {
      await pctService.onPlmSyncEvent('sample_rejected', req.params.id, { note })
    } catch (pctErr) {
      console.error('PCT sync failed (sample_rejected):', pctErr)
    }

    return res.json({ success: true, version })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Merchant-only: hold or drop the current sample order (frontend only ever shows this
// action to role === 'merchant' in WorkspaceModal's sample tab).
router.patch('/sku-workspaces/:id/sample-hold', requireAuth, async (req, res) => {
  try {
    const { status, note } = req.body
    if (!['on_hold', 'dropped'].includes(status))
      return res.status(400).json({ error: 'status must be on_hold or dropped' })

    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const { data: ws } = await supabase
      .from('npd2_workspaces').select('id, merchant_member_id')
      .eq('id', req.params.id).maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    const actorRole = await resolveWorkspaceActorRole(req.params.id, memberId, ws)
    if (actorRole !== 'merchant')
      return res.status(403).json({ error: 'Only the merchant can hold or drop a sample' })

    const { data: so } = await supabase
      .from('npd2_sample_orders').select('id')
      .eq('workspace_id', req.params.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!so) return res.status(404).json({ error: 'No sample order found' })

    const { error: soErr } = await supabase.from('npd2_sample_orders')
      .update({ sample_status: status }).eq('id', so.id)
    if (soErr) throw soErr

    const eventKey = status === 'on_hold' ? 'sample_on_hold' : 'sample_dropped'
    await insertSystemComment(req.params.id, memberId, 'merchant', 'milestone', null,
      { event: eventKey, note: note || '' })

    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

const toRows = (...parts) =>
  parts
    .filter(Boolean)
    .flatMap(p => String(p).split(/\n|\\n/).map(s => s.trim()))
    .filter(Boolean)


// ─────────────────────────────────────────────────────────────
// PDF: Sample PO
// ─────────────────────────────────────────────────────────────
function generateSamplePOPDF({ poNumber, poDate, currency, buyerOrg, supplierOrg, lines, totalQty, totalAmt }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 } })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end',  () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const L  = doc.page.margins.left
    const R  = doc.page.width - doc.page.margins.right
    const CW = R - L

    let y = doc.page.margins.top

    // ── Title ─────────────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#000').text('Sample Purchase Order', L, y)
    y += 32
    doc.strokeColor('#000').lineWidth(1.5).moveTo(L, y).lineTo(R, y).stroke()
    y += 14

    // ── 3-column block ────────────────────────────────────────────────────────
    const C1X = L,      C1W = 160
    const C2X = L + 175, C2W = 160
    const C3X = L + 355, C3W = R - (L + 355)
    const sectionTop = y

    const drawInfoCol = (title, rows, cx, cw, startY) => {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#888').text(title, cx, startY, { width: cw })
  let cy = startY + 12
  doc.strokeColor('#bbb').lineWidth(0.4).moveTo(cx, cy).lineTo(cx + cw, cy).stroke()
  cy += 8
  for (const row of rows) {
    if (!row?.trim()) continue
    const lineH = doc.heightOfString(row, { width: cw - 6 })
    doc.font('Helvetica').fontSize(9).fillColor('#000')
      .text(row, cx + 4, cy, { width: cw - 6 })
    cy += lineH + 3   // 3 px gap between rows
  }
  return cy
}

    const drawMetaCol = (title, pairs, cx, cw, startY) => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#888').text(title, cx, startY, { width: cw })
      let cy = startY + 12
      doc.strokeColor('#bbb').lineWidth(0.4).moveTo(cx, cy).lineTo(cx + cw, cy).stroke()
      cy += 8
      for (const [label, val] of pairs) {
        doc.font('Helvetica').fontSize(8).fillColor('#888').text(label, cx, cy, { width: 60, lineBreak: false })
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000').text(String(val), cx + 62, cy, { width: cw - 62, lineBreak: false })
        cy += 14
      }
      return cy
    }

   const suppRows = toRows(
  supplierOrg?.display_name || supplierOrg?.name,
  supplierOrg?.address,
  [supplierOrg?.city, supplierOrg?.country].filter(Boolean).join(', '),
  supplierOrg?.email,
  supplierOrg?.phone_no,
)
    const buyerRows = toRows(
  buyerOrg?.display_name || buyerOrg?.name,
  buyerOrg?.address,
  [buyerOrg?.city, buyerOrg?.country].filter(Boolean).join(', '),
  buyerOrg?.email,
)
 
    const endY1 = drawInfoCol('SUPPLIER',     suppRows,  C1X, C1W, sectionTop)
    const endY2 = drawInfoCol('DELIVER TO',   buyerRows, C2X, C2W, sectionTop)
    const endY3 = drawMetaCol('ORDER DETAILS', [
      ['Order No',  poNumber],
      ['Date',      poDate],
      ['Currency',  currency],
      ['Type',      'Sample PO'],
    ], C3X, C3W, sectionTop)

    y = Math.max(endY1, endY2, endY3) + 16
    doc.strokeColor('#bbb').lineWidth(0.5).moveTo(L, y).lineTo(R, y).stroke()
    y += 16

    // ── Table ─────────────────────────────────────────────────────────────────
    const cols = [
      { label: 'Buyer Ref',          width: 75,                  align: 'left'   },
      { label: 'Description',        width: 165,                 align: 'left'   },
      { label: 'Colour',             width: 75,                  align: 'left'   },
      { label: 'Qty',                width: 40,                  align: 'center' },
      { label: `Unit (${currency})`, width: 80,                  align: 'right'  },
      { label: `Total (${currency})`,width: CW-75-165-75-40-80,  align: 'right'  },
    ]
    const rowH       = 26
    const tableTop   = y
    const MIN_TABLE_H = 220  // always at least this tall regardless of row count

    // Header
    doc.rect(L, y, CW, 24).fillColor('#000').fill()
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff')
    let hx = L
    for (const col of cols) {
      if      (col.align === 'center') doc.text(col.label, hx, y + 8, { width: col.width, align: 'center' })
      else if (col.align === 'right')  doc.text(col.label, hx, y + 8, { width: col.width - 6, align: 'right' })
      else                             doc.text(col.label, hx + 6, y + 8, { width: col.width - 6 })
      hx += col.width
    }
    y += 24

    // Data rows
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (i % 2 === 1) doc.rect(L, y, CW, rowH).fillColor('#f7f7f7').fill()
      const cells = [
        { val: l.buyerRef,                     align: 'left'   },
        { val: l.description, sub: l.material, align: 'left'   },
        { val: l.color,                        align: 'left'   },
        { val: String(l.qty),                  align: 'center' },
        { val: parseFloat(l.price).toFixed(2), align: 'right'  },
        { val: parseFloat(l.total).toFixed(2), align: 'right', bold: true },
      ]
      let rx = L
      for (let ci = 0; ci < cols.length; ci++) {
        const col = cols[ci]; const cell = cells[ci]
        doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000')
        if      (cell.align === 'center') doc.text(cell.val, rx, y + 8, { width: col.width, align: 'center', lineBreak: false })
        else if (cell.align === 'right')  doc.text(cell.val, rx, y + 8, { width: col.width - 6, align: 'right', lineBreak: false })
        else {
          doc.text(cell.val, rx + 6, y + (cell.sub ? 5 : 8), { width: col.width - 12, lineBreak: false })
          if (cell.sub) doc.font('Helvetica').fontSize(7).fillColor('#888').text(cell.sub, rx + 6, y + 16, { width: col.width - 12, lineBreak: false })
        }
        rx += col.width
      }
      doc.strokeColor('#e0e0e0').lineWidth(0.3).moveTo(L, y + rowH).lineTo(R, y + rowH).stroke()
      y += rowH
    }

    // Blank rows to fill minimum table height
    const drawnTableH = y - tableTop - 24
    if (drawnTableH < MIN_TABLE_H) {
      const remaining = MIN_TABLE_H - drawnTableH
      const blankCount = Math.ceil(remaining / rowH)
      for (let i = 0; i < blankCount; i++) {
        doc.strokeColor('#e0e0e0').lineWidth(0.3).moveTo(L, y + rowH).lineTo(R, y + rowH).stroke()
        y += rowH
      }
    }

    // Bottom border of table
    doc.strokeColor('#000').lineWidth(1).moveTo(L, y).lineTo(R, y).stroke()
    y += 16

    // ── Bottom section: Acknowledgement (left) + Totals (right) ──────────────
    const bottomY  = y
    const ACK_W    = CW * 0.52
    const TOT_X    = L + ACK_W + 20
    const TOT_W    = R - TOT_X

    // Acknowledgement — left
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000').text('Acknowledgement', L, bottomY)
    doc.font('Helvetica').fontSize(8).fillColor('#444')
      .text(
        'Please confirm acknowledgement of this order. Acknowledgement confirms acceptance of all terms and conditions associated with this sample purchase order.',
        L, bottomY + 14, { width: ACK_W - 10 }
      )

    // Signature
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000')
      .text('FOR TWIF TECH LLP', L, bottomY + 70, { width: ACK_W - 10 })
    doc.strokeColor('#000').lineWidth(0.5).moveTo(L, bottomY + 100).lineTo(L + 160, bottomY + 100).stroke()
    doc.font('Helvetica').fontSize(8).fillColor('#666').text('AUTHORISED SIGNATORY', L, bottomY + 106, { width: 160 })

    // Totals — right
    let ty = bottomY
    for (const [label, val, bold] of [
      ['Net Total:',  `${currency} ${totalAmt}`, false],
      ['Delivery:',   `${currency} 0.00`,        false],
      ['Sub Total:',  `${currency} ${totalAmt}`, false],
    ]) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000')
        .text(label, TOT_X, ty)
        .text(val, TOT_X, ty, { width: TOT_W, align: 'right' })
      ty += 14
    }
    ty += 2
    doc.strokeColor('#000').lineWidth(0.5).moveTo(TOT_X, ty).lineTo(R, ty).stroke()
    ty += 6
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
      .text('Total:', TOT_X, ty)
      .text(`${currency} ${totalAmt}`, TOT_X, ty, { width: TOT_W, align: 'right' })

    doc.end()
  })
}



// ═════════════════════════════════════════════════════════════
// POST /purchase-orders/sample
// ═════════════════════════════════════════════════════════════
router.post('/purchase-orders/sample', async (req, res) => {
  let filePath = null

  try {
    const { workspaceIds, poNumber, memberId } = req.body
    if (!workspaceIds?.length || !poNumber?.trim() || !memberId)
      return res.status(400).json({ error: 'workspaceIds, poNumber, memberId required' })

    const trimmedPoNumber = poNumber.trim()
    const safePoNumber    = trimmedPoNumber.replace(/\//g, '-')

    const parseBrief = (raw) => {
      if (!raw) return {}
      if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return {} } }
      return raw
    }

    // 1. Fetch workspaces + latest sample orders
    const [{ data: workspaces, error: wsErr }, { data: allOrders }] = await Promise.all([
      supabase.from('npd2_workspaces')
        .select('id, buyer_ref, buyer_brief, buyer_org_id, supplier_org_id')
        .in('id', workspaceIds),
      supabase.from('npd2_sample_orders')
        .select('*').in('workspace_id', workspaceIds)
        .order('created_at', { ascending: false }),
    ])
    if (wsErr) throw wsErr

    const soMap = {}
    for (const so of (allOrders || []))
      if (!soMap[so.workspace_id]) soMap[so.workspace_id] = so

    // 2. Fetch buyer + supplier orgs
    const buyerOrgId    = workspaces[0]?.buyer_org_id
    const supplierOrgId = workspaces[0]?.supplier_org_id
    const orgIds        = [buyerOrgId, supplierOrgId].filter(Boolean)
    let orgMap = {}
    if (orgIds.length) {
      const { data: orgs } = await supabase
        .from('organizations')
        .select('id, name, display_name, email, phone_no, address, city, country')
        .in('id', orgIds)
      for (const o of (orgs || [])) orgMap[o.id] = o
    }
    const buyerOrg    = orgMap[buyerOrgId]    || null
    const supplierOrg = orgMap[supplierOrgId] || null
    // Prefer the currency frozen on the sample order at approval time over the live
    // buyer_brief — the brief's currency can be edited after approval, but confirmed_price
    // (and this PO's amount/currency, stamped onto purchase_orders + skus below) must stay
    // paired with whatever currency was actually true when the sample was approved.
    const currency    = soMap[workspaces[0]?.id]?.currency || parseBrief(workspaces[0]?.buyer_brief)?.currency || 'USD'

    // 3. Resolve buyer–supplier link
    let buyerSupplierLinkId = null
    if (buyerOrgId && supplierOrgId) {
      const { data: link } = await supabase
        .from('buyer_supplier_links')
        .select('id')
        .eq('buyer_org_id', buyerOrgId)
        .eq('supplier_org_id', supplierOrgId)
        .eq('relationship_status', 'active')
        .maybeSingle()
      buyerSupplierLinkId = link?.id || null
    }

    // 4. Build lines + totals
    const lines = workspaces.map(ws => {
      const brief = parseBrief(ws.buyer_brief)
      const so    = soMap[ws.id] || {}
      const qty   = so.confirmed_qty   || Number(brief.unit_qty)  || 0
      const price = so.confirmed_price || Number(brief.unit_price) || 0
      return {
        workspaceId: ws.id,
        buyerRef:    ws.buyer_ref      || '—',
        description: brief.description || '—',
        color:       brief.color       || '—',
        material:    brief.material    || '—',
        qty, price,
        total:    (qty * price).toFixed(2),
        findings: so.findings || {},
      }
    })
    const totalQty = lines.reduce((a, l) => a + l.qty, 0)
    const totalAmt = lines.reduce((a, l) => a + parseFloat(l.total), 0).toFixed(2)

    // 5. Duplicate PO check
    if (buyerSupplierLinkId) {
      const { data: existing } = await supabase
        .from('purchase_orders')
        .select('id')
        .eq('buyer_supplier_link_id', buyerSupplierLinkId)
        .eq('po_number', trimmedPoNumber)
        .is('deleted_at', null)
        .maybeSingle()
      if (existing)
        return res.status(409).json({ error: `PO number "${trimmedPoNumber}" already exists` })
    }

    // 6. Build storage path
    const dateObj     = new Date()
    const months      = ['January','February','March','April','May','June','July','August','September','October','November','December']
    const monthFolder = months[dateObj.getMonth()]
    const dayFolder   = String(dateObj.getDate()).padStart(2, '0')
    const year        = dateObj.getFullYear()
    const poDate      = `${String(dateObj.getDate()).padStart(2,'0')} ${monthFolder.slice(0,3)} ${year}`

    const safeBuyer = (buyerOrg?.display_name || 'UnknownBuyer')
      .replace(/[^a-zA-Z0-9 _-]/g, '').trim()

    filePath = `${safeBuyer}/${monthFolder}/${dayFolder}/${safePoNumber}/sample-po_${Date.now()}.pdf`

    // 7. Generate + upload PDF
    const pdfBuffer = await generateSamplePOPDF({ poNumber: trimmedPoNumber, poDate, currency, buyerOrg, supplierOrg, lines, totalQty, totalAmt })

    const { error: uploadErr } = await supabase.storage
      .from(ACTIVE_BUCKET)
      .upload(filePath, pdfBuffer, { contentType: 'application/pdf', upsert: false })
    if (uploadErr) throw uploadErr

    // 8. Insert PO header
    const dbDate = `${monthFolder}-${dayFolder}-${year}`
    const { data: po, error: poErr } = await supabase.from('purchase_orders').insert({
      buyer_supplier_link_id: buyerSupplierLinkId,
      po_number:              trimmedPoNumber,
      po_received_date:       dbDate,
      created_by:             memberId,
      po_file_url:            buildFileRef(filePath),
      quantity_ordered:       totalQty,
      amount:                 parseFloat(totalAmt),
      amount_usd:             req.body.amount_usd ?? parseFloat(totalAmt),
      currency,
      type:                   'sample',
      is_test:                true,
    }).select().single()
    if (poErr) throw poErr

    // 9. Insert skus + line items per workspace
    const productionSkuByWorkspace = {}
    for (const line of lines) {
      const ws       = workspaces.find(w => w.id === line.workspaceId)
      const brief    = parseBrief(ws.buyer_brief)
      const findings = line.findings

     const { data: sku, error: skuErr } = await supabase.from('skus').insert({
  description:         brief.description      || null,
  buyer_sku_ref:       ws.buyer_ref            || null,
  sku_variant:         brief.color             || null,
  base_price:          line.price              || null,
  currency,
  weight_kg:           findings.actual_weight  || null,
  length:              findings.actual_l       || null,
  breadth:             findings.actual_w       || null,
  height:              findings.actual_h       || null,
  item_cbm:            findings.cbm            || null,
  inner_pack_length:   findings.inner_l        || null,
  inner_pack_breadth:  findings.inner_w        || null,
  inner_pack_height:   findings.inner_h        || null,
  master_pack_length:  findings.master_l       || null,
  master_pack_breadth: findings.master_w       || null,
  master_pack_height:  findings.master_h       || null,
  master_pack_weight_kg: findings.master_pack_weight_kg || null,
  master_pack_cbm:     findings.cbm            || null,
  buyer_org_id:        ws.buyer_org_id         || null,
  source_workspace_id: ws.id,
  sample_status:       'Open',
}).select().single()

      if (skuErr) throw skuErr
      productionSkuByWorkspace[line.workspaceId] = sku.id

      const { error: liErr } = await supabase.from('po_line_items').insert({
        po_id:            po.id,
        sku_id:           sku.id,
        buyer_sku_ref:    ws.buyer_ref                    || null,
        sku_variant:      brief.color                     || null,
        quantity_ordered: line.qty,
        unit_price:       String(line.price),
        order_value_usd:  line.total,
        order_date:       new Date().toISOString().split('T')[0],
        target_date:      soMap[ws.id]?.target_ready_date || null,
      })
      if (liErr) throw liErr
    }

    try {
      await pctService.onSamplePOCreated({
        purchaseOrderId: po.id,
        poNumber: trimmedPoNumber,
        workspaceIds,
        memberId,
        productionSkuByWorkspace,
        buyerOrgId: buyerOrgId,
        supplierOrgId: supplierOrgId,
      })
    } catch (pctErr) {
      console.error('PCT PO lock failed:', pctErr)
      await supabase.from('pct_handoff_failures').insert({
        event_type: 'sample_po_created',
        error_message: pctErr.message,
        payload: { poNumber: trimmedPoNumber, workspaceIds },
      })
    }

    const fileUrl = await resolveFileUrl(supabase, buildFileRef(filePath))
    return res.json({ success: true, po, fileUrl })

  } catch (err) {
    console.error('❌ POST /purchase-orders/sample:', err)
    if (filePath) {
      await supabase.storage.from(ACTIVE_BUCKET).remove([filePath]).catch(() => {})
    }
    return res.status(500).json({ error: err.message })
  }
})

// POST /plm/supplier-catalog/skus
router.post('/supplier-catalog/skus', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { season, categoryId, description, material, finish,
            weight, l, w, h, measurement, tempSkuRef, mode,
            supplierOrgId, supplier: supplierName, buyerOrgId } = req.body

    if (!req.file) return res.status(400).json({ error: 'image required' })

    const [member, { data: cat }, { data: buyerOrgRow }] = await Promise.all([
      resolveMember(req, res),
      categoryId
        ? supabase.from('categories').select('name').eq('id', categoryId).maybeSingle()
        : Promise.resolve({ data: null }),
      buyerOrgId
        ? supabase.from('organizations').select('display_name, name').eq('id', buyerOrgId).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    if (!member) return

    const orgSlug      = (supplierName || 'manual').replace(/\s+/g, '_').toLowerCase()
    const seasonSlug   = (season || 'unknown').replace(/\s+/g, '_').toLowerCase()
    const categorySlug = cat?.name ? cat.name.replace(/\s+/g, '_').toLowerCase() : null
    const basePath     = categorySlug
      ? `catalog/${orgSlug}/${seasonSlug}/${categorySlug}`
      : `catalog/${orgSlug}/${seasonSlug}`

    const { data: uploadRow, error: uploadErr } = await supabase
      .from('npd2_catalog_uploads')
      .insert({
        created_by_member_id: member?.id     || null,
        supplier_org_id:      supplierOrgId  || null,
        supplier:             supplierName   || null,
        for_buyer_org_id:     buyerOrgId     || null,
        buyer:                buyerOrgRow?.display_name || buyerOrgRow?.name || null,
        source_type:          'manual',
        status:               'manual',
        season:               season         || null,
        category_id:          categoryId     || null,
        category:             cat?.name      || null,
        sku_count:            1,
        // See sku_source note in /catalog/upload — only 'new' opens a workspace/chat.
        sku_source:           mode === 'new' ? 'new' : 'existing',
      })
      .select('id')
      .single()
    if (uploadErr) throw uploadErr

    // Retry on auto_code collision — generateAutoCode already checks the DB before
    // returning, but a true concurrent race (two requests, same instant) can still
    // slip through, so fall back to a fresh code + re-upload like catalogWorker.js does.
    let sku, image_url
    for (let attempt = 0; attempt < 5; attempt++) {
      const autoCode    = await generateAutoCode()
      const storagePath = `${basePath}/skus/${autoCode}.png`

      const { error: upErr } = await supabase.storage
        .from(NPD_BUCKET)
        .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype })
      if (upErr) throw upErr
      image_url = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath).data.publicUrl

      const { data, error: skuErr } = await supabase
        .from('npd2_catalog_skus')
        .insert({
          catalog_upload_id: uploadRow.id,
          auto_code:         autoCode,
          category_id:       categoryId || null,
          image_url,
          description:       description || null,
          material:          material    || null,
          finish:            finish      || null,
          weight:            weight      ? parseFloat(weight) : null,
          length:            l           ? parseFloat(l)      : null,
          width:             w           ? parseFloat(w)      : null,
          height:            h           ? parseFloat(h)      : null,
          measurement:       measurement || 'cm',
          temp_sku_ref:      tempSkuRef  || null,
          is_archived:       false,
          image_processing:  true,
        })
        .select()
        .single()

      if (!skuErr) { sku = data; break }
      if (!skuErr.message.includes('auto_code')) throw skuErr
      console.warn(`⚠️ auto_code collision on ${autoCode} (attempt ${attempt + 1}) — retrying`)
      await supabase.storage.from(NPD_BUCKET).remove([storagePath]).catch(() => {})
    }
    if (!sku) throw new Error('Failed to insert SKU after 5 auto_code collision retries')

    // Fire image processing worker (best-effort — SKU is already created)
    triggerWorker([
      { name: 'JOB_MODE',    value: 'image_processing' },
      { name: 'JOB_SKU_IDS', value: sku.id },
    ]).catch(async (err) => {
      console.warn('⚠️ Image worker trigger failed, clearing flag:', err.message)
      try { await supabase.from('npd2_catalog_skus').update({ image_processing: false }).eq('id', sku.id) } catch {}
    })

    res.json({
      sku: {
        ...sku,
        buyer_ref_status: sku.temp_sku_ref && !sku.production_sku_id ? 'pending_buyer_ref' : null,
      },
    })
  } catch (err) {
    console.error('❌ POST /supplier-catalog/skus:', err)
    res.status(500).json({ error: err.message })
  }
})


// POST /plm/supplier-catalog/skus/bulk
router.post('/supplier-catalog/skus/bulk', requireAuth, upload.array('images'), async (req, res) => {
  try {
    const { season, supplierOrgId, supplier: supplierName, attributes: attributesRaw, mode, buyerOrgId } = req.body
    const attributes = JSON.parse(attributesRaw || '[]')

    if (!req.files?.length) return res.status(400).json({ error: 'At least one image required' })

    const { data: member } = await supabase
      .from('organization_members')
      .select('id, organization_id, organizations(display_name, name)')
      .eq('user_id', req.user.id).maybeSingle()

    const orgName    = member?.organizations?.display_name || member?.organizations?.name || 'manual'
    const orgSlug    = orgName.replace(/\s+/g, '_').toLowerCase()
    const seasonSlug = (season || 'unknown').replace(/\s+/g, '_').toLowerCase()

    const { data: buyerOrgRow } = buyerOrgId
      ? await supabase.from('organizations').select('display_name, name').eq('id', buyerOrgId).maybeSingle()
      : { data: null }

    const { data: uploadRow, error: uploadErr } = await supabase
      .from('npd2_catalog_uploads')
      .insert({
        created_by_member_id: member?.id    || null,
        supplier_org_id:      supplierOrgId || null,
        supplier:             supplierName  || null,
        for_buyer_org_id:     buyerOrgId    || null,
        buyer:                buyerOrgRow?.display_name || buyerOrgRow?.name || null,
        source_type:          'manual',
        status:               'manual',
        season:               season        || null,
        sku_count:            req.files.length,
        // See sku_source note in /catalog/upload — only 'new' opens a workspace/chat.
        sku_source:           mode === 'new' ? 'new' : 'existing',
      })
      .select('id')
      .single()
    if (uploadErr) throw uploadErr

    const skus = await Promise.all(req.files.map(async (file, i) => {
      const a = attributes[i] || {}

      const { data: cat } = a.categoryId
        ? await supabase.from('categories').select('name').eq('id', a.categoryId).maybeSingle()
        : { data: null }

      const categorySlug = cat?.name ? cat.name.replace(/\s+/g, '_').toLowerCase() : null
      const basePath     = categorySlug
        ? `catalog/${orgSlug}/${seasonSlug}/${categorySlug}`
        : `catalog/${orgSlug}/${seasonSlug}`

      // Retry on auto_code collision — generateAutoCode already checks the DB before
      // returning, but a true concurrent race (two requests, same instant) can still
      // slip through, so fall back to a fresh code + re-upload like catalogWorker.js does.
      for (let attempt = 0; attempt < 5; attempt++) {
        const autoCode    = await generateAutoCode()
        const storagePath = `${basePath}/skus/${autoCode}.png`

        const { error: upErr } = await supabase.storage
          .from(NPD_BUCKET)
          .upload(storagePath, file.buffer, { contentType: file.mimetype })
        if (upErr) throw upErr

        const { data: { publicUrl: image_url } } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)

        const { data: sku, error: skuErr } = await supabase
          .from('npd2_catalog_skus')
          .insert({
            catalog_upload_id: uploadRow.id,
            auto_code:         autoCode,
            image_url,
            category_id:       a.categoryId       || null,
            category:          cat?.name          || null,
            production_sku_id: a.productionSkuId  || null,
            description:       a.description      || null,
            material:          a.material         || null,
            finish:            a.finish           || null,
            weight:            a.weight           ? parseFloat(a.weight) : null,
            length:            a.l                ? parseFloat(a.l)      : null,
            width:             a.w                ? parseFloat(a.w)      : null,
            height:            a.h                ? parseFloat(a.h)      : null,
            measurement:       a.measurement      || 'cm',
            temp_sku_ref:      a.tempSkuRef       || null,
            is_archived:       false,
            image_processing:  mode !== 'existing',
          })
          .select()
          .single()

        if (!skuErr) return sku
        if (!skuErr.message.includes('auto_code')) throw skuErr
        console.warn(`⚠️ auto_code collision on ${autoCode} (attempt ${attempt + 1}) — retrying`)
        await supabase.storage.from(NPD_BUCKET).remove([storagePath]).catch(() => {})
      }
      throw new Error('Failed to insert SKU after 5 auto_code collision retries')
    }))

    // Fire image processing worker only for new SKUs
    if (mode !== 'existing') {
      const skuIds = skus.map(s => s.id).join(',')
      triggerWorker([
        { name: 'JOB_MODE',    value: 'image_processing' },
        { name: 'JOB_SKU_IDS', value: skuIds },
      ]).catch(async (err) => {
        console.warn('⚠️ Bulk image worker trigger failed, clearing flags:', err.message)
        try { await supabase.from('npd2_catalog_skus').update({ image_processing: false }).in('id', skus.map(s => s.id)) } catch {}
      })
    }

    res.json({
      skus: skus.map(s => ({
        ...s,
        buyer_ref_status: s.temp_sku_ref && !s.production_sku_id ? 'pending_buyer_ref' : null,
      })),
    })
  } catch (err) {
    console.error('❌ POST /supplier-catalog/skus/bulk:', err)
    res.status(500).json({ error: err.message })
  }
})



// ═══════════════════════════════════════════════
// VIDEO CALLS (Vedeeo call-invites)
// ═══════════════════════════════════════════════
const vedeeo = require('../service/vedeeoService')

const VIDEO_WS_SELECT = `
  id, video_room_name, video_room_url,
  merchant_member_id, buyer_member_id, supplier_member_id,
  auto_code, description,
  npd2_catalog_skus ( auto_code, description )
`

function workspaceChatRole(ws, memberId) {
  if (ws?.buyer_member_id === memberId) return 'buyer'
  if (ws?.supplier_member_id === memberId) return 'supplier'
  return 'merchant'
}

function otherMemberIds(ws, memberId) {
  return [ws?.merchant_member_id, ws?.buyer_member_id, ws?.supplier_member_id]
    .filter(id => id && id !== memberId)
}

function pickCallee(ws, callerId, targetMemberId) {
  const others = otherMemberIds(ws, callerId)
  if (targetMemberId && others.includes(targetMemberId)) return targetMemberId
  if (others.length === 1) return others[0]
  if (ws.buyer_member_id && ws.buyer_member_id !== callerId) return ws.buyer_member_id
  if (ws.supplier_member_id && ws.supplier_member_id !== callerId) return ws.supplier_member_id
  if (ws.merchant_member_id && ws.merchant_member_id !== callerId) return ws.merchant_member_id
  return null
}

function callTitle(ws) {
  const sku = ws?.npd2_catalog_skus || {}
  return vedeeo.clip(ws?.description || sku.description || ws?.auto_code || sku.auto_code || 'Video call', 120)
}

async function loadVideoWorkspace(id) {
  const { data, error } = await supabase
    .from('npd2_workspaces')
    .select(VIDEO_WS_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

async function memberNamesById(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))]
  if (!unique.length) return {}
  const { data } = await supabase
    .from('organization_members')
    .select('id, full_name, email')
    .in('id', unique)
  const map = {}
  for (const m of data || []) map[m.id] = m.full_name || m.email || 'Participant'
  return map
}

async function persistVideoInvite(workspaceId, invite) {
  await supabase
    .from('npd2_workspaces')
    .update({
      video_room_name: invite?.inviteId || null,
      video_room_url:  invite?.hostJoinUrl || invite?.embedJoinUrl || null,
    })
    .eq('id', workspaceId)
}

async function clearVideoInvite(workspaceId) {
  await supabase
    .from('npd2_workspaces')
    .update({ video_room_name: null, video_room_url: null })
    .eq('id', workspaceId)
}

async function insertVideoCallComment(workspaceId, memberId, role, metadata) {
  const { data, error } = await supabase.from('npd2_comments').insert([{
    workspace_id:     workspaceId,
    author_member_id: memberId,
    role,
    type:             'milestone',
    body:             null,
    metadata,
  }]).select().single()
  if (error) throw error
  return data
}

function callResponse(invite, { role, created = false, comment = null, userName } = {}) {
  const displayName = role === 'host'
    ? (invite?.callerName || userName)
    : (invite?.calleeName || userName)
  return {
    success: true,
    created,
    comment,
    inviteId:      invite?.inviteId,
    roomId:        invite?.roomId,
    status:        invite?.status,
    role,
    joinUrl:       vedeeo.joinUrlForRole(invite, role, displayName),
    hostJoinUrl:   invite?.hostJoinUrl || null,
    guestJoinUrl:  invite?.guestJoinUrl || null,
    embedJoinUrl:  invite?.embedJoinUrl || null,
    notification:  invite?.notification || null,
    calleeUserId:  invite?.calleeUserId || null,
    callerUserId:  invite?.callerUserId || null,
    invite,
  }
}

function videoError(res, err, label) {
  console.error(`❌ ${label}:`, err)
  const status = err.status && Number.isInteger(err.status) ? err.status : 500
  return res.status(status >= 400 && status < 600 ? status : 500).json({ error: err.message })
}

/**
 * POST /plm/sku-workspaces/:id/video-call
 * Caller: create a Vedeeo ringing invite and return hostJoinUrl (embed).
 * Callee / rejoin: accept or return the existing invite's join URL.
 *
 * Body: { memberId, userName, targetMemberId?, calleeName? }
 */
router.post('/sku-workspaces/:id/video-call', async (req, res) => {
  try {
    const { id } = req.params
    const { memberId, userName, targetMemberId, calleeName } = req.body
    if (!memberId) return res.status(400).json({ error: 'memberId required' })
    if (!vedeeo.isConfigured()) {
      return res.status(500).json({ error: 'Video calls not configured — VIDEOMEET_BASE_URL or VIDEOMEET_API_KEY missing' })
    }

    const workspace = await loadVideoWorkspace(id)
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' })
    const role = workspaceChatRole(workspace, memberId)

    const existing = await vedeeo.findOpenInvite(id, memberId, workspace.video_room_name)
    if (existing) {
      if (existing.calleeUserId === memberId && vedeeo.isRinging(existing)) {
        const accepted = await vedeeo.acceptInvite(existing.inviteId, memberId)
        await persistVideoInvite(id, accepted)
        const comment = await insertVideoCallComment(id, memberId, role, {
          event: 'video_call_accepted',
          inviteId: accepted.inviteId,
          roomId: accepted.roomId,
        })
        return res.json(callResponse(accepted, { role: 'guest', comment, userName }))
      }
      const callRole = existing.callerUserId === memberId ? 'host' : 'guest'
      return res.json(callResponse(existing, { role: callRole, userName }))
    }

    const calleeUserId = pickCallee(workspace, memberId, targetMemberId)
    if (!calleeUserId) {
      return res.status(400).json({ error: 'No other workspace member to call. Invite a buyer or supplier first.' })
    }

    const names = await memberNamesById([memberId, calleeUserId])
    const invite = await vedeeo.createInvite({
      conversationId: id,
      callerUserId:   memberId,
      callerName:     userName || names[memberId] || role,
      calleeUserId,
      calleeName:     calleeName || names[calleeUserId] || undefined,
      title:          callTitle(workspace),
    })

    await persistVideoInvite(id, invite)
    const comment = await insertVideoCallComment(id, memberId, role, {
      event:         'video_call_started',
      started_by:    userName || names[memberId] || role,
      inviteId:      invite.inviteId,
      roomId:        invite.roomId,
      calleeUserId,
      calleeName:    invite.calleeName || names[calleeUserId] || null,
    })

    return res.json(callResponse(invite, { role: 'host', created: true, comment, userName }))
  } catch (err) {
    return videoError(res, err, 'POST /plm/sku-workspaces/:id/video-call')
  }
})

/**
 * GET /plm/sku-workspaces/:id/video-call/pending?memberId=
 * RINGING invites for this member in this workspace (missed-call recovery).
 */
router.get('/sku-workspaces/:id/video-call/pending', async (req, res) => {
  try {
    const { id } = req.params
    const memberId = req.query.memberId
    if (!memberId) return res.status(400).json({ error: 'memberId required' })
    if (!vedeeo.isConfigured()) return res.json({ invites: [] })

    const pending = await vedeeo.listPending(memberId)
    const invites = pending.filter(i => i.conversationId === id && vedeeo.isRinging(i))
    return res.json({
      invites: invites.map(invite => callResponse(invite, { role: 'guest' })),
    })
  } catch (err) {
    return videoError(res, err, 'GET /plm/sku-workspaces/:id/video-call/pending')
  }
})

/**
 * POST /plm/sku-workspaces/:id/video-call/accept
 * Body: { memberId, inviteId? }
 */
router.post('/sku-workspaces/:id/video-call/accept', async (req, res) => {
  try {
    const { id } = req.params
    const { memberId, userName, inviteId } = req.body
    if (!memberId) return res.status(400).json({ error: 'memberId required' })

    const workspace = await loadVideoWorkspace(id)
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' })
    const resolvedId = inviteId || workspace.video_room_name
    if (!resolvedId) return res.status(400).json({ error: 'No ringing invite to accept' })

    const accepted = await vedeeo.acceptInvite(resolvedId, memberId)
    await persistVideoInvite(id, accepted)
    const role = workspaceChatRole(workspace, memberId)
    const comment = await insertVideoCallComment(id, memberId, role, {
      event: 'video_call_accepted',
      inviteId: accepted.inviteId,
      roomId: accepted.roomId,
    })
    return res.json(callResponse(accepted, { role: 'guest', comment, userName }))
  } catch (err) {
    return videoError(res, err, 'POST /plm/sku-workspaces/:id/video-call/accept')
  }
})

/**
 * POST /plm/sku-workspaces/:id/video-call/decline
 * Body: { memberId, inviteId? }
 */
router.post('/sku-workspaces/:id/video-call/decline', async (req, res) => {
  try {
    const { id } = req.params
    const { memberId, inviteId } = req.body
    if (!memberId) return res.status(400).json({ error: 'memberId required' })

    const workspace = await loadVideoWorkspace(id)
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' })
    const resolvedId = inviteId || workspace.video_room_name
    if (!resolvedId) return res.status(400).json({ error: 'No ringing invite to decline' })

    await vedeeo.declineInvite(resolvedId, memberId)
    if (!inviteId || inviteId === workspace.video_room_name) await clearVideoInvite(id)

    const role = workspaceChatRole(workspace, memberId)
    const comment = await insertVideoCallComment(id, memberId, role, {
      event: 'video_call_declined',
      inviteId: resolvedId,
    })
    return res.json({ success: true, comment })
  } catch (err) {
    return videoError(res, err, 'POST /plm/sku-workspaces/:id/video-call/decline')
  }
})

/**
 * POST /plm/sku-workspaces/:id/video-call/cancel
 * Body: { memberId, inviteId? }
 */
router.post('/sku-workspaces/:id/video-call/cancel', async (req, res) => {
  try {
    const { id } = req.params
    const { memberId, inviteId } = req.body
    if (!memberId) return res.status(400).json({ error: 'memberId required' })

    const workspace = await loadVideoWorkspace(id)
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' })
    const resolvedId = inviteId || workspace.video_room_name
    if (!resolvedId) return res.status(400).json({ error: 'No ringing invite to cancel' })

    await vedeeo.cancelInvite(resolvedId, memberId)
    if (!inviteId || inviteId === workspace.video_room_name) await clearVideoInvite(id)

    const role = workspaceChatRole(workspace, memberId)
    const comment = await insertVideoCallComment(id, memberId, role, {
      event: 'video_call_cancelled',
      inviteId: resolvedId,
    })
    return res.json({ success: true, comment })
  } catch (err) {
    return videoError(res, err, 'POST /plm/sku-workspaces/:id/video-call/cancel')
  }
})

/**
 * POST /plm/sku-workspaces/:id/video-call/invite
 * Notifies workspace participants in-app and optionally by email.
 *
 * Body:    { memberId, userName, targetMemberIds?, emails? }
 * Returns: { success, invited, emailed, comment }
 */
router.post('/sku-workspaces/:id/video-call/invite', async (req, res) => {
  try {
    const { id } = req.params
    const { memberId, userName, targetMemberIds, emails } = req.body
    if (!memberId) return res.status(400).json({ error: 'memberId required' })
    if (!vedeeo.isConfigured()) {
      return res.status(500).json({ error: 'Video calls not configured — VIDEOMEET_BASE_URL or VIDEOMEET_API_KEY missing' })
    }

    const workspace = await loadVideoWorkspace(id)
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' })
    if (!workspace.video_room_name) return res.status(400).json({ error: 'No active video call to invite to' })

    const role = workspaceChatRole(workspace, memberId)
    const allMembers = [
      workspace.merchant_member_id,
      workspace.buyer_member_id,
      workspace.supplier_member_id,
    ].filter(Boolean)

    const targets = Array.isArray(targetMemberIds) && targetMemberIds.length
      ? targetMemberIds.filter(mid => mid !== memberId && allMembers.includes(mid))
      : allMembers.filter(mid => mid !== memberId)

    const emailList = [...new Set(
      (Array.isArray(emails) ? emails : [])
        .map(e => String(e).trim().toLowerCase())
        .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    )]

    if (!targets.length && !emailList.length) {
      return res.status(400).json({ error: 'No participants or email addresses to invite' })
    }

    const sku = workspace.npd2_catalog_skus || {}
    const productName = workspace.description || sku.description || workspace.auto_code || sku.auto_code || 'Workspace'
    const workspaceLabel = workspace.auto_code || sku.auto_code || id.slice(0, 8)
    const joinLink = `${frontendUrl}/plm?workspace=${id}`

    let emailed = []
    if (emailList.length) {
      const result = await sendAlertEmail(
        emailList.map(email => ({ email })),
        `${userName || role} invited you to join a video call`,
        {
          invited_by: userName || role,
          workspace_label: workspaceLabel,
          product_name: productName,
          join_link: joinLink,
        },
        'VIDEO_CALL_INVITE'
      )
      if (result.successfulRecipients?.length) emailed = result.successfulRecipients
    }

    const commentRow = await insertVideoCallComment(id, memberId, role, {
      event:              'video_call_invited',
      invited_by:         userName || role,
      invited_member_ids: targets,
      invited_emails:     emailed.length ? emailed : emailList,
      inviteId:           workspace.video_room_name,
    })

    return res.json({ success: true, invited: targets, emailed, comment: commentRow })
  } catch (err) {
    return videoError(res, err, 'POST /plm/sku-workspaces/:id/video-call/invite')
  }
})

/**
 * POST /plm/sku-workspaces/:id/video-call/end
 * Caller hang-up: cancel a still-ringing Vedeeo invite, clear workspace columns,
 * and log a "video_call_ended" system comment.
 *
 * Body: { memberId, inviteId? }
 */
router.post('/sku-workspaces/:id/video-call/end', async (req, res) => {
  try {
    const { id } = req.params
    const { memberId, inviteId } = req.body

    const workspace = await loadVideoWorkspace(id)
    const resolvedId = inviteId || workspace?.video_room_name

    if (resolvedId && vedeeo.isConfigured()) {
      try {
        await vedeeo.cancelInvite(resolvedId, memberId)
      } catch {
        // already accepted / expired / not the caller — still clear local state
      }
    }

    if (workspace?.video_room_name) {
      await clearVideoInvite(id)
      const role = workspaceChatRole(workspace, memberId)
      await insertVideoCallComment(id, memberId, role, {
        event: 'video_call_ended',
        inviteId: resolvedId || null,
      })
    }

    return res.json({ success: true })
  } catch (err) {
    return videoError(res, err, 'POST /plm/sku-workspaces/:id/video-call/end')
  }
})


module.exports = router