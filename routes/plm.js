const express  = require('express')
const path     = require('path')
const AdmZip   = require('adm-zip')
const sanitizeHtml = require('sanitize-html')
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
const { isPlmMasterKey, withMasterKeyContext } = require('../helpers/plmMasterKey')
const { logAdminAction } = require('../helpers/plmAdminAudit')
dotenv.config()
const frontendUrl = process.env.FRONTEND_URL || 'https://plm.eai7.com'

// Warm-up / health check — PLM page hits this on mount so the first real
// workspace action does not pay Cloud Run cold start. Public on purpose.
router.get('/ping', (_req, res) => {
  res.json({ ok: true, service: 'plm' })
})

// Makes the per-request X-PLM-Master-Key activation flag available to the deep helpers
// (resolveWorkspaceActorRole / verifySkuAccess) that gate the override but never receive
// `req`. Without this header a tech-dept member is just a normal participant here.
router.use(withMasterKeyContext)

// Returns 'buyer' | 'merchant' | null — whether memberId is allowed to act on this
// workspace's pipeline (approve / status changes). Covers the primary buyer, the
// merchant who owns it, AND any co-buyer (a second/third buyer who accepted an
// invite on this same workspace) — not just workspace.buyer_member_id.
async function resolveWorkspaceActorRole(workspaceId, memberId, workspace) {
  // Tech-department members with Super Admin Mode toggled ON for this request (eligibility
  // + the X-PLM-Master-Key header — see isPlmMasterKey) act on any workspace without being
  // its actual buyer/supplier/merchant of record. Kept as an explicit distinct role
  // (rather than silently returning 'merchant') so callers can log/gate it deliberately.
  if (await isPlmMasterKey(memberId)) return 'super_admin'
  if (workspace?.buyer_member_id === memberId) return 'buyer'
  if (workspace?.supplier_member_id === memberId) return 'supplier'
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
  if (coBuyer) return 'buyer'

  const { data: coSupplier } = await supabase
    .from('npd2_invites')
    .select('id')
    .eq('workspace_id', workspaceId)
    .in('role', ['supplier', 'vendor'])
    .eq('member_id', memberId)
    .eq('status', 'accepted')
    .limit(1)
    .maybeSingle()
  if (coSupplier) return 'supplier'

  // QA-department invite — an internal merchant-org colleague (department 'qa') invited
  // into exactly this workspace's Group Chat, read-only elsewhere. Deliberately its own role
  // string (not folded into 'merchant' or 'supplier') so every downstream gate that only
  // allow-lists specific roles excludes them by default — see filterCommentsForRole and the
  // WorkspaceModal.jsx role variable for how 'qa' stays scoped to Group Chat + read-only.
  const { data: coQa } = await supabase
    .from('npd2_invites')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'qa')
    .eq('member_id', memberId)
    .eq('status', 'accepted')
    .limit(1)
    .maybeSingle()
  if (coQa) return 'qa'

  return null
}

// Checks the PLM Security console's npd2_workspace_permissions grant — separate from
// resolveWorkspaceActorRole() above (which only knows about real buyer/supplier/merchant/
// invite/pair relationships) since a permission grant is deliberately narrower: it should
// unlock exactly brief-editing and/or commenting, never the pipeline actions (approve,
// hold/reject, status changes) that a real role grants. Every route gating on this must
// call it explicitly rather than folding it into resolveWorkspaceActorRole, so a grant can
// never accidentally widen into something it wasn't meant to.
async function hasWorkspaceCapability(workspaceId, memberId, allowedCapabilities) {
  if (!memberId) return false
  const { data } = await supabase
    .from('npd2_workspace_permissions')
    .select('capability')
    .eq('workspace_id', workspaceId)
    .eq('member_id', memberId)
    .maybeSingle()
  return !!data && allowedCapabilities.includes(data.capability)
}

// Server-side sanitization for the rich-text chat composer (bold/italic/underline/lists/
// color/highlight/font). Client-side sanitization alone isn't sufficient — a request can
// bypass the browser entirely — so this is the real trust boundary before anything from the
// composer's contentEditable is stored and later rendered via dangerouslySetInnerHTML to
// every other participant in that chat. Narrow allowlist: structural tags only, and CSS
// properties/values matched against explicit patterns rather than a blanket "style" allow,
// so nothing like `expression()` or a `url()`-based value can sneak through.
// Inline <img src> is deliberately restricted to this project's own Supabase storage domain
// — an arbitrary external image URL is a real tracking-pixel/exfiltration vector (the src
// request leaks the viewer's IP/user-agent to whatever third party hosts it, on every render,
// with zero interaction needed), and sanitize-html's allowedSchemes only controls the URL
// *scheme* (https vs javascript: etc.), not which *host* it points to.
// Structural check, not built from process.env.SUPABASE_URL directly — the frontend had the
// identical bug (its own ALLOWED_URI_REGEXP was built from an env var read that could silently
// resolve to "", falling back to a pattern matching nothing and stripping every inline image
// with no error). This is the actual trust boundary that writes to the DB, so getting it wrong
// here is worse: the image is gone from `body` before it's ever saved, not just at render time.
const isOwnStorageUrl = (src) => new RegExp(`^https://[a-z0-9-]+\\.supabase\\.co/storage/v1/object/public/${NPD_BUCKET}/`).test(src || '')

const sanitizeRichComment = (html) => sanitizeHtml(html, {
  allowedTags: ['b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'br', 'span', 'p', 'div', 'img'],
  allowedAttributes: { span: ['style'], p: ['style'], div: ['style'], li: ['style'], ul: ['style'], img: ['src', 'style'] },
  allowedStyles: {
    '*': {
      color:            [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\)$/],
      'background-color': [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\)$/],
      'font-size':      [/^\d{1,3}(px|pt)$/],
      'font-family':    [/^[a-zA-Z0-9\s,'"-]{1,80}$/],
      'font-weight':    [/^(bold|normal|\d{3})$/],
      'font-style':     [/^italic$/],
      'text-decoration': [/^(underline|line-through)$/],
      'max-width':      [/^(100%|\d{1,4}px)$/],
      // list-style-type on <ul> switches the bullet shape (disc/circle/square); li's own
      // font-size is deliberately separate from the wrapped text's font-size inside it, since
      // the marker follows the LI's own size, not any nested span's — this is what lets bullet
      // size be controlled independently of the visible text size (see setBulletSize).
      // "➤ " is CSS's own custom-string marker syntax (CSS Lists Level 3) for the arrow option —
      // an exact match rather than a general quoted-string pattern, since this UI only ever
      // emits this one literal value, not arbitrary user-typed marker text.
      'list-style-type': [/^(disc|circle|square|decimal|"➤ ")$/],
      // Browser's native resize:both handle (see the inline <img> style below) writes real
      // width/height back onto the element once dragged — without these allowed, a manually
      // resized image would silently snap back to its default size the moment it's sent,
      // since the sanitizer would strip the very style that recorded the resize.
      width:            [/^\d{1,4}px$/],
      height:           [/^\d{1,4}px$/, /^auto$/],
      resize:           [/^(both|horizontal|vertical|none)$/],
      overflow:         [/^(hidden|auto)$/],
    },
  },
  // Must allow 'https' here, not []: sanitize-html strips a URL attribute's scheme BEFORE
  // exclusiveFilter ever runs, so an empty allowedSchemes list drops every <img src> unconditionally
  // regardless of what exclusiveFilter would have decided — this was the actual reason every inline
  // image was vanishing, not the domain-matching logic below (which was correct all along).
  // exclusiveFilter is what actually restricts images to this project's own storage domain.
  allowedSchemes: ['https'],
  exclusiveFilter: (frame) => frame.tag === 'img' && !isOwnStorageUrl(frame.attribs.src || ''),
})

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

// Same reserve-before-await + DB-collision-check pattern as generateAutoCode above, for
// skus.vendor_sku_ref when the source catalog SKU never had a vendor's own ref on file —
// checked against the skus table itself (not npd2_catalog_skus) since that's the column
// being filled.
const _vendorSkuRefUsed = new Set()
const generateVendorSkuRef = async () => {
  while (true) {
    const num  = Math.floor(1 + Math.random() * 99999)
    const code = `SKU-${String(num).padStart(5, '0')}`
    if (_vendorSkuRefUsed.has(code)) continue
    _vendorSkuRefUsed.add(code)
    const { data } = await supabase
      .from('skus')
      .select('id')
      .eq('vendor_sku_ref', code)
      .maybeSingle()
    if (!data) return code
    _vendorSkuRefUsed.delete(code)
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

// Builds the `notes` + `spec_images` columns for npd2_catalog_skus from a Create-SKU
// payload. `notesHtml` is the rich-text note body; images embedded in it (`specImages`,
// a URL list) are mirrored into spec_images tagged origin 'kaptr' so they surface in the
// workspace Media panel — including before any workspace exists.
function buildSkuNoteFields(src, memberId) {
  const notesHtml = typeof src?.notesHtml === 'string' ? src.notesHtml : ''
  let images = src?.specImages
  if (typeof images === 'string') { try { images = JSON.parse(images) } catch { images = [] } }
  images = Array.isArray(images) ? images.filter(u => typeof u === 'string' && u) : []
  const now = new Date().toISOString()
  return {
    notes: notesHtml ? { html: notesHtml, images } : null,
    spec_images: images.map(url => ({ url, remark: null, origin: 'kaptr', created_at: now, member_id: memberId || null })),
  }
}

// Every milestone/field-change comment already carries `role: 'super_admin'` when the
// author used Master Key (resolveWorkspaceActorRole checks master-key eligibility before
// anything else) — and that role string matches none of the frontend's Activity-tab filters
// (buyer/merchant/supplier only), so it's already invisible in the workspace UI to everyone,
// including the merchant. This is the one place both helpers funnel through, so it's also
// the one place to add the audit trail those actions were otherwise missing entirely —
// nothing logged Master Key usage anywhere before this.
const logIfSuperAdmin = async (workspaceId, authorId, role, type, metadata) => {
  if (role !== 'super_admin') return
  await logAdminAction({
    actorMemberId: authorId, action: `master_key_${type}`,
    targetType: 'workspace', targetId: workspaceId, detail: metadata,
  })
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
  await logIfSuperAdmin(workspaceId, authorId, role, type, metadata)
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
  await logIfSuperAdmin(workspaceId, authorId, role, type, metadata)
}

// True only if `email` belongs to a member of `orgId`. Used to catch, at invite-send time,
// the case where a merchant types/picks an email that doesn't actually belong to the buyer/
// supplier org the SKU was uploaded for (see /workspace-invites/accept for the matching
// accept-time guard — this is the send-time half of the same check).
const emailBelongsToOrg = async (email, orgId) => {
  if (!email || !orgId) return true
  // ilike is case-insensitive EXACT match here, not a pattern search — escape % and _ so an
  // email containing those characters can't be (ab)used as a wildcard against other members.
  const escaped = email.replace(/[%_]/g, c => `\\${c}`)
  const { data } = await supabase
    .from('organization_members')
    .select('id')
    .eq('organization_id', orgId)
    .ilike('email', escaped)
    .maybeSingle()
  return !!data
}

// QA-invite counterpart to emailBelongsToOrg above — a QA invitee isn't in a separate buyer/
// supplier org, they're in the merchant's OWN org, so this additionally requires
// department = 'qa' rather than just any membership in that org.
const emailBelongsToQaDept = async (email, merchantOrgId) => {
  if (!email || !merchantOrgId) return false
  const escaped = email.replace(/[%_]/g, c => `\\${c}`)
  const { data } = await supabase
    .from('organization_members')
    .select('id')
    .eq('organization_id', merchantOrgId)
    .eq('department', 'qa')
    .ilike('email', escaped)
    .maybeSingle()
  return !!data
}

// ═══════════════════════════════════════════════
// CATALOG
// ═══════════════════════════════════════════════

// GET /catalog removed — unauthenticated and had zero frontend callers. The app loads the
// catalog via direct RLS-scoped supabase.from('npd2_catalog_skus') reads
// (fetchCatalog/refreshCatalog in plmStore.js). Left unauthenticated it was a cross-org
// catalog dump: ?customerId=<orgId>&role=merchant returned any merchant's whole catalog.

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

// POST /catalog/upload removed — the old PPTX/PDF catalog-import endpoint, superseded by
// POST /supplier-catalog/upload (which has requireAuth, derives identity via resolveMember,
// and takes supplierOrgId/buyerOrgId instead of a trusted customerId). This one had no
// requireAuth and wrote customerId straight into merchant_id, so anyone could create a
// catalog upload attributed to any merchant and trigger a worker run. Zero callers.

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

router.patch('/catalog/skus/:id/image', requireAuth, upload.single('image'), withMasterKeyContext, async (req, res) => {
  try {
    const file = req.file
    if (!file) return res.status(400).json({ error: 'image file required' })

    const member = await resolveMember(req, res)
    if (!member) return

    const { data: skuRow, error: skuErr } = await supabase
      .from('npd2_catalog_skus')
      .select('image_url, auto_code')
      .eq('id', req.params.id)
      .single()
    if (skuErr || !skuRow) return res.status(404).json({ error: 'SKU not found' })

    const { data: workspaces } = await supabase
      .from('npd2_workspaces')
      .select('id, merchant_member_id, buyer_member_id, supplier_member_id, status')
      .eq('catalog_sku_id', req.params.id)

    // Editable through the whole brief/negotiation stage (status 'active', buyer/vendor
    // assigned or not) — only locks once the workspace is actually approved to proceed to
    // sample, matching the buyer brief's own lock point (see LOGGABLE_BRIEF_FIELDS/briefLocked
    // in the frontend). Previously locked as soon as ANY buyer/vendor was assigned OR status
    // hit 'active' — which is essentially immediately, since a workspace is 'active' from
    // creation — so this option was blocked in practice the moment it might actually get used.
    const isLocked = (workspaces || []).some(w =>
      ['approved', 'sample', 'sample_shipped', 'production'].includes(w.status)
    )
    if (isLocked) return res.status(403).json({ error: 'Image cannot be edited after the workspace is approved' })

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

    await logSkuMutation(member.id, req.params.id, {
      action: 'edit_sku_image', autoCode: skuRow.auto_code,
      extraDetail: { from: skuRow.image_url || null, to: image_url, master_key: await isPlmMasterKey(member.id) },
    })

    // Editing from the SKU card only ever wrote to the SKU mutation audit log (Super Admin
    // console) — never into a linked workspace's own Activity tab, so a buyer/vendor already
    // on that workspace would never see it happen. Same 'product_image_set' milestone the
    // in-workspace "Set as Product Info image" button already logs, so it reads identically
    // either way. Every workspace found here is guaranteed unlocked (isLocked would have
    // 403'd above otherwise), so it's safe to log into all of them.
    for (const w of (workspaces || [])) {
      const actorRole = (await resolveWorkspaceActorRole(w.id, member.id, w)) || 'merchant'
      await insertSystemComment2(w.id, member.id, actorRole, 'milestone', null,
        { event: 'product_image_set', stage: 'product', from: skuRow.image_url || null, to: image_url })
    }

    return res.json({ success: true, image_url, sku })
  } catch (err) {
    console.error('❌ PATCH /catalog/skus/:id/image:', err)
    return res.status(500).json({ error: err.message })
  }
})


router.patch('/catalog/skus/:id/image-from-url', requireAuth, async (req, res) => {
  try {
    const { imageUrl, workspaceId, memberId, role } = req.body
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' })

    const actor = await resolveMember(req, res)
    if (!actor) return

    const { data: skuBefore } = await supabase
      .from('npd2_catalog_skus')
      .select('image_url, auto_code')
      .eq('id', req.params.id)
      .maybeSingle()
    if (!skuBefore) return res.status(404).json({ error: 'SKU not found' })

    const { error: patchErr } = await supabase
      .from('npd2_catalog_skus')
      .update({ image_url: imageUrl })
      .eq('id', req.params.id)
    if (patchErr) throw patchErr

    await logSkuMutation(actor.id, req.params.id, {
      action: 'edit_sku_image', autoCode: skuBefore?.auto_code,
      extraDetail: { from: skuBefore?.image_url || null, to: imageUrl, master_key: await isPlmMasterKey(actor.id), via: 'from_url' },
    })

    // Product image has no "unset" — it's always replaced with a new URL, never cleared —
    // so unlike buyer_brief_image_set/unset above, there's just the one milestone event.
    if (workspaceId && memberId) {
      await insertSystemComment2(workspaceId, memberId, role || 'merchant', 'milestone', null,
        { event: 'product_image_set', stage: 'product', from: skuBefore?.image_url || null, to: imageUrl })
    }

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
router.patch('/sku-workspaces/:id/reference-media', requireAuth, upload.single('image'), withMasterKeyContext, async (req, res) => {
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

    let role = 'merchant'
    if (ws.buyer_member_id === memberId) role = 'buyer'
    else if (ws.supplier_member_id === memberId) role = 'supplier'

    const isMember = [ws.merchant_member_id, ws.buyer_member_id, ws.supplier_member_id].includes(memberId)
    if (!isMember) {
      const [{ data: inv }, actorRole] = await Promise.all([
        supabase.from('npd2_invites')
          .select('id, role')
          .eq('workspace_id', req.params.id)
          .eq('member_id', memberId)
          .eq('status', 'accepted')
          .maybeSingle(),
        // Covers a paired merchant (merchant_access_pairs) too — not just co-buyer invites.
        resolveWorkspaceActorRole(req.params.id, memberId, ws),
      ])
      if (!inv && !actorRole) return res.status(403).json({ error: 'Not a member of this workspace' })
      role = inv?.role || actorRole || 'buyer'
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

    await insertSystemComment2(req.params.id, memberId, role, 'milestone', null,
      {
        event: canReplace ? 'reference_media_replaced' : 'reference_media_edited',
        stage: 'brief',
        from: canReplace ? replaceUrl : null,
        to:   newUrl,
      })

    return res.json({ success: true, image_url: newUrl, replaced: canReplace, reference_media: updatedMedia })
  } catch (err) {
    console.error('❌ PATCH /sku-workspaces/:id/reference-media:', err)
    return res.status(500).json({ error: err.message })
  }
})

router.post('/supplier-catalog/upload', requireAuth, upload.single('catalogFile'), withMasterKeyContext, async (req, res) => {
  const file = req.file
  const { supplierOrgId: clientSupplierOrgId, season, buyerOrgId, skuSource } = req.body
  let uploadRow = null
  let uploadError

  // multer already buffers the whole file before this handler even starts, so a client abort
  // can't stop THAT — but if it happens in the gap between then and actually triggering the
  // (expensive, hard-to-undo) Cloud Run worker, this catches it and skips ever starting the
  // job at all, instead of only being able to kill it after the fact via the cancel endpoint.
  // res.writableEnded distinguishes "closed because we already responded" from "closed because
  // the client gave up" — without that check this would misfire on every normal request too.
  let clientGone = false
  res.on('close', () => { if (!res.writableEnded) clientGone = true })

  try {
    if (!file)           return res.status(400).json({ error: 'catalogFile required' })
    if (!buyerOrgId)     return res.status(400).json({ error: 'buyerOrgId required' })
    if (!season?.trim()) return res.status(400).json({ error: 'season required' })

    const ext = path.extname(file.originalname).toLowerCase()
    if (ext !== '.pptx' && ext !== '.pdf')
      return res.status(400).json({ error: 'Only .pptx and .pdf supported' })

    const member = await resolveMember(req, res, 'id, organization_id, organizations(type)')
    if (!member) return

    // A vendor/supplier member's own org is the ONLY org they can ever upload a catalog
    // under — the frontend only ever sends their own org id for them, but a tampered
    // request could claim to be a different vendor, so it's never trusted from the client
    // for a supplier caller. A merchant legitimately picks any vendor via the UI's
    // cascading dropdown, so their submitted value is still honoured as before.
    const isSupplierCaller = member.organizations?.type === 'supplier'
    const supplierOrgId = isSupplierCaller ? member.organization_id : clientSupplierOrgId
    if (!supplierOrgId) return res.status(400).json({ error: 'supplierOrgId required' })
    // A buyer caller's own org is the only buyerOrgId they can legitimately claim; a
    // merchant's submitted value is still honoured (they pick any buyer via the UI).
    const isBuyerCallerHere = member.organizations?.type === 'buyer'
    const resolvedBuyerOrgId = isBuyerCallerHere ? member.organization_id : buyerOrgId

    const [{ data: orgRow }, { data: buyerOrgRow }] = await Promise.all([
      supabase.from('organizations').select('display_name, name').eq('id', supplierOrgId).maybeSingle(),
      supabase.from('organizations').select('display_name, name').eq('id', resolvedBuyerOrgId).maybeSingle(),
    ])

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
        for_buyer_org_id:     resolvedBuyerOrgId || null,
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

    // Cancelled (client aborted the request) before the worker ever started — the file's
    // already uploaded to Storage, but nothing SKU-related exists yet, so there's nothing to
    // clean up: just mark it and stop, instead of triggering a job for a client that's gone
    // and creating SKUs the cancel endpoint would otherwise have to hunt down and delete.
    if (clientGone) {
      await supabase.from('npd2_catalog_uploads').update({ status: 'cancelled' }).eq('id', uploadRow.id)
      return
    }

    // 3. Trigger Cloud Run Job
    const jobRes = await triggerWorker([
      { name: 'JOB_UPLOAD_ID',   value: uploadRow.id },
      { name: 'JOB_CUSTOMER_ID', value: member.id },
      { name: 'JOB_EXT',         value: ext },
    ])
    console.log(`✅ Cloud Run triggered for upload ${uploadRow.id}:`, jobRes.data?.name || jobRes.status)
    // Full response logged (not just the guessed .name field) so a mismatch between the
    // actual Cloud Run Jobs :run response shape and what's being read below is actually
    // diagnosable instead of just silently saving nothing, as happened previously.
    console.log(`   jobRes.data:`, JSON.stringify(jobRes.data))

    // Saved so a later cancel request (POST /catalog/upload/:id/cancel) knows which running
    // execution to actually kill — :run only ever logged this, never persisted it before.
    // NOTE: :run returns a long-running Operation, not the Execution directly — its top-level
    // .name is the OPERATION's name (projects/*/locations/*/operations/*), not the execution's
    // (.../jobs/*/executions/*) that :cancel actually needs. Falls back through the couple of
    // shapes Cloud Run Jobs is known to nest the execution under; logged above either way so a
    // shape this doesn't anticipate is still visible instead of silently saving nothing.
    const executionName =
      jobRes.data?.metadata?.name ||      // Operation.metadata (Execution) — the expected case
      jobRes.data?.response?.name ||      // Operation.response, once done:true
      jobRes.data?.name || null
    if (executionName) {
      await supabase
        .from('npd2_catalog_uploads')
        .update({ worker_execution_name: executionName })
        .eq('id', uploadRow.id)
        .catch(() => {}) // best-effort — a missing execution name just means Cancel can't kill the job, still handled there
    } else {
      console.error(`⚠️ Could not determine worker execution name for upload ${uploadRow.id} — Cancel won't be able to kill this job's run. jobRes.data:`, JSON.stringify(jobRes.data))
    }

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
router.post('/buyer-spec/upload', requireAuth, upload.array('files'), withMasterKeyContext, async (req, res) => {
  const files = req.files
  const { buyerOrgId, supplierOrgId: clientSupplierOrgId, season } = req.body

  try {
    if (!files?.length)  return res.status(400).json({ error: 'At least one file required' })
    if (!buyerOrgId)     return res.status(400).json({ error: 'buyerOrgId required' })
    if (!season?.trim()) return res.status(400).json({ error: 'season required' })

    for (const file of files) {
      if (path.extname(file.originalname).toLowerCase() !== '.pdf')
        return res.status(400).json({ error: `Only PDF files supported — ${file.originalname} is not a PDF` })
    }

    const member = await resolveMember(req, res, 'id, organization_id, organizations(type)')
    if (!member) return

    // A vendor/supplier caller can only ever upload under their own org — never trust the
    // client-submitted supplierOrgId for them, same fix as the catalog upload routes.
    const isSupplierCaller = member.organizations?.type === 'supplier'
    const supplierOrgId = isSupplierCaller ? member.organization_id : clientSupplierOrgId
    if (!supplierOrgId) return res.status(400).json({ error: 'supplierOrgId required' })
    const isBuyerCallerHere = member.organizations?.type === 'buyer'
    const resolvedBuyerOrgId = isBuyerCallerHere ? member.organization_id : buyerOrgId

    const uploads = []

    const [{ data: supplierOrg }, { data: buyerOrg }] = await Promise.all([
      supabase.from('organizations').select('display_name').eq('id', supplierOrgId).single(),
      supabase.from('organizations').select('display_name, name').eq('id', resolvedBuyerOrgId).single(),
    ])

    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase()

      const { data: uploadRow, error: uploadError } = await supabase
        .from('npd2_catalog_uploads')
        .insert([{
          supplier_org_id:      supplierOrgId,
          supplier:             supplierOrg?.display_name || null,
          for_buyer_org_id:     resolvedBuyerOrgId,
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





// GET /catalog/skus/:id removed — unauthenticated, zero frontend callers. It leaked a single
// SKU plus its upload's source_file_url (link to the original catalog PPTX/PDF) to anyone
// holding the SKU UUID, with no scoping at all.


// Verifies `memberId` has edit/delete access to every SKU id in `skuIds` — either they
// created the catalog upload those SKUs belong to, or that upload's creator has granted them
// a standing merchant_access_pairs share (mirrors the check already used by
// PATCH /supplier-catalog/skus/:id). Several routes below previously had no equivalent check
// at all — any authenticated member (merchant, and by extension an admin viewing another
// merchant's catalog read-only in the UI) could edit/delete/reorder ANY SKU by id.
async function verifySkuAccess(memberId, skuIds) {
  if (!skuIds.length) return { ok: true }
  if (await isPlmMasterKey(memberId)) return { ok: true }
  const { data: rows, error } = await supabase
    .from('npd2_catalog_skus')
    .select('id, npd2_catalog_uploads!inner(created_by_member_id)')
    .in('id', skuIds)
  if (error) return { ok: false, status: 500, error: error.message }
  if (!rows || rows.length !== skuIds.length) return { ok: false, status: 404, error: 'One or more SKUs not found' }

  const ownerIds = new Set(rows.map(r => r.npd2_catalog_uploads?.created_by_member_id).filter(Boolean))
  ownerIds.delete(memberId) // SKUs the member already owns directly need no pair check
  if (ownerIds.size) {
    const { data: pairs } = await supabase
      .from('merchant_access_pairs')
      .select('grantor_member_id')
      .eq('grantee_member_id', memberId)
      .in('grantor_member_id', [...ownerIds])
    const granted = new Set((pairs || []).map(p => p.grantor_member_id))
    for (const ownerId of ownerIds) {
      if (!granted.has(ownerId)) return { ok: false, status: 403, error: 'Forbidden' }
    }
  }
  return { ok: true }
}

// Audit-log-only trail for SKU mutations (attribute edit, image swap, delete). Writes one
// npd2_admin_audit_log row and nothing else — deliberately NOT a workspace Activity comment,
// since SKU-card fields are catalog metadata, not workspace pipeline state. Surfaced in the
// PLM Super Admin console's Moderation → Audit Log tab.
async function logSkuMutation(memberId, skuId, { action, changes = null, autoCode = null, extraDetail = null }) {
  await logAdminAction({
    actorMemberId: memberId, action, targetType: 'sku', targetId: skuId,
    detail: { auto_code: autoCode, changes, ...(extraDetail || {}) },
  })
}
function diffSkuFields(before, updates) {
  const changes = {}
  for (const [k, to] of Object.entries(updates)) {
    const from = before?.[k] ?? null
    if (String(from ?? '') !== String(to ?? '')) changes[k] = { from, to }
  }
  return changes
}

router.patch('/catalog/skus/reorder', requireAuth, async (req, res) => {
  try {
    const { ordered_ids } = req.body
    if (!Array.isArray(ordered_ids) || !ordered_ids.length)
      return res.status(400).json({ error: 'ordered_ids array required' })

    const member = await resolveMember(req, res)
    if (!member) return
    const access = await verifySkuAccess(member.id, ordered_ids)
    if (!access.ok) return res.status(access.status).json({ error: access.error })

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


// Previously had no requireAuth at all, and gated only on a client-supplied `role` field in
// the request body (trivially spoofable) with no check that the caller actually owns this
// SKU — any caller claiming role: 'merchant' could edit any SKU by id.
router.patch('/catalog/skus/:id', requireAuth, async (req, res) => {
  try {
    const { customerId, role, ...fields } = req.body // eslint-disable-line no-unused-vars -- kept for backward-compat with any caller still sending these; no longer trusted for authorization
    const member = await resolveMember(req, res)
    if (!member) return
    const access = await verifySkuAccess(member.id, [req.params.id])
    if (!access.ok) return res.status(access.status).json({ error: access.error })

    const allowed = ['description', 'dimensions', 'material', 'weight', 'finish', 'category']
    const updates = {}
    for (const field of allowed) {
      if (fields[field] !== undefined) updates[field] = fields[field] === '' ? null : fields[field]
    }
    // Notes (rich-text) + spec_images (jsonb) — kept out of the string-diff loop above.
    // `notesHtml` is the note body; `specImages` is the URL list embedded in it, mirrored
    // into spec_images tagged origin 'kaptr'.
    if (fields.notesHtml !== undefined || fields.specImages !== undefined) {
      Object.assign(updates, buildSkuNoteFields(fields, member.id))
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' })

    const { data: before } = await supabase
      .from('npd2_catalog_skus').select('auto_code, notes, ' + allowed.join(', ')).eq('id', req.params.id).single()

    const { data, error } = await supabase
      .from('npd2_catalog_skus').update(updates).eq('id', req.params.id).select().single()
    if (error) throw error

    // Field-level diff for the audit log covers the plain attributes only — notes/spec_images
    // are jsonb and don't string-compare meaningfully.
    const diffable = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)))
    const changes = diffSkuFields(before, diffable)
    if (fields.notesHtml !== undefined) {
      const stripTags = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const fromTxt = stripTags(before?.notes?.html)
      const toTxt   = stripTags(fields.notesHtml)
      if (fromTxt !== toTxt) changes.notes = { from: fromTxt || null, to: toTxt || null }
    }
    if (Object.keys(changes).length) {
      await logSkuMutation(member.id, req.params.id, {
        action: 'edit_sku', changes, autoCode: before?.auto_code,
        extraDetail: { master_key: await isPlmMasterKey(member.id) },
      })
    }
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

   const allowed = ['description', 'material', 'finish', 'category', 'length', 'width', 'height', 'measurement', 'weight','category_id','production_sku_id','temp_sku_ref','original_price','original_currency']
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
    // Notes (rich-text) + spec_images (jsonb, origin 'kaptr') — same handling as
    // PATCH /catalog/skus/:id.
    if (fields.notesHtml !== undefined || fields.specImages !== undefined) {
      Object.assign(updates, buildSkuNoteFields(fields, memberId))
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

    const { data: before } = await supabase
      .from('npd2_catalog_skus')
      .select('auto_code, ' + Object.keys(updates).join(', '))
      .eq('id', req.params.id).single()

    const { data, error } = await supabase
      .from('npd2_catalog_skus').update(updates).eq('id', req.params.id).select().single()
    if (error) throw error

    // jsonb columns (notes/spec_images) don't string-compare — diff the plain fields, then
    // add a readable notes from→to separately.
    const diffableKeys = Object.keys(updates).filter(k => k !== 'notes' && k !== 'spec_images')
    const changes = diffSkuFields(before, Object.fromEntries(diffableKeys.map(k => [k, updates[k]])))
    if (fields.notesHtml !== undefined) {
      const stripTags = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const fromTxt = stripTags(before?.notes?.html)
      const toTxt   = stripTags(fields.notesHtml)
      if (fromTxt !== toTxt) changes.notes = { from: fromTxt || null, to: toTxt || null }
    }
    if (Object.keys(changes).length) {
      await logSkuMutation(memberId, req.params.id, {
        action: 'edit_sku', changes, autoCode: before?.auto_code,
        extraDetail: { master_key: await isPlmMasterKey(memberId), via: 'supplier_catalog' },
      })
    }
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

// Previously gated only on a client-supplied `role` query param (trivially spoofable) with no
// check that the caller owns this SKU — any authenticated user could delete any SKU by id.
// Changed 2026-08-25 from a permanent hard delete to the same delete_meta soft-delete used by
// PATCH /catalog/skus/:id/soft-delete — the row and its image are kept, just flagged and
// filtered out of every catalog query, so a mistaken delete stays recoverable. Route path/
// method unchanged so no frontend call sites needed updating.
//
// Exception (?fromUpload=1): the trash button in BulkEditModal's post-upload "fill in
// details" step. Those SKUs are brand-new rows straight from a PPT/PDF upload — still
// being described, never attached to a workspace, never active/invited. There deleting
// really means "this one shouldn't have been created", so we remove the row (which frees
// its auto_code for reuse) and first write the Storage paths to npd2_admin_audit_log so
// the now-orphaned image / 3d files can be found and swept manually later.
router.delete('/catalog/skus/:id', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req, res)
    if (!member) return
    const access = await verifySkuAccess(member.id, [req.params.id])
    if (!access.ok) return res.status(access.status).json({ error: access.error })

    const skuId = req.params.id
    const fromUpload = req.query.fromUpload === '1' || req.query.fromUpload === 'true'
                       || req.body?.fromUpload === true

    if (fromUpload) {
      const { data: sku, error: fetchErr } = await supabase
        .from('npd2_catalog_skus')
        .select('id, auto_code, image_url, model_3d_url, catalog_upload_id')
        .eq('id', skuId)
        .single()
      if (fetchErr) throw fetchErr

      const { data: wsRows, error: wsErr } = await supabase
        .from('npd2_workspaces')
        .select('id')
        .eq('catalog_sku_id', skuId)
        .limit(1)
      if (wsErr) throw wsErr

      // Only a real upload row with no workspace attached gets hard-deleted;
      // anything else falls through to the recoverable soft-delete below.
      if (sku?.catalog_upload_id && (!wsRows || wsRows.length === 0)) {
        await logAdminAction({
          actorMemberId: member.id,
          action: 'hard_delete_sku',
          targetType: 'sku',
          targetId: skuId,
          detail: {
            auto_code:         sku.auto_code,
            image_url:         sku.image_url,
            model_3d_url:      sku.model_3d_url,
            catalog_upload_id: sku.catalog_upload_id,
            via:               'bulk_edit_upload',
          },
        })

        const { error: delErr } = await supabase
          .from('npd2_catalog_skus')
          .delete()
          .eq('id', skuId)
        if (delErr) throw delErr

        return res.json({ success: true, hard: true, data: { id: skuId, auto_code: sku.auto_code } })
      }
    }

    const deleteMeta = {
      flagged_by: member.id,
      flagged_at: new Date().toISOString(),
      reason: req.body?.reason || null,
    }

    const { data, error } = await supabase
      .from('npd2_catalog_skus')
      .update({ delete_meta: deleteMeta })
      .eq('id', req.params.id)
      .select('id, auto_code, delete_meta')
      .single()
    if (error) throw error

    await logSkuMutation(member.id, req.params.id, {
      action: 'delete_sku', autoCode: data?.auto_code,
      extraDetail: { soft: true, reason: deleteMeta.reason, master_key: await isPlmMasterKey(member.id) },
    })

    return res.json({ success: true, data })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// PATCH /catalog/skus/:id/soft-delete
// Called when merchant clicks the tick/confirm button.
// Stamps delete_meta on the row instead of deleting it.
// Previously resolved the real authenticated member (good) but never checked that member
// actually has access to THIS SKU before flagging it for deletion — any authenticated
// merchant could soft-delete any SKU by id.
router.patch('/catalog/skus/:id/soft-delete', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req, res)
    if (!member) return
    const access = await verifySkuAccess(member.id, [req.params.id])
    if (!access.ok) return res.status(access.status).json({ error: access.error })

    const deleteMeta = {
      flagged_by: member.id,
      flagged_at: new Date().toISOString(),
      reason: req.body.reason || null,
    }

    const { data, error } = await supabase
      .from('npd2_catalog_skus')
      .update({ delete_meta: deleteMeta })
      .eq('id', req.params.id)
      .select('id, auto_code, delete_meta')
      .single()

    if (error) throw error

    await logSkuMutation(member.id, req.params.id, {
      action: 'delete_sku', autoCode: data?.auto_code,
      extraDetail: { soft: true, reason: deleteMeta.reason, master_key: await isPlmMasterKey(member.id), via: 'soft_delete' },
    })

    return res.json({ success: true, data })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.get('/catalog/upload-status/:id', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req, res, 'id, organization_id')
    if (!member) return

    const { data: upload, error } = await supabase
      .from('npd2_catalog_uploads')
      .select('id, status, total_slides, slides_processed, sku_count, error_message, spec_images, created_by_member_id, merchant_id, for_buyer_org_id, supplier_org_id')
      .eq('id', req.params.id)
      .single()
    if (error) throw error

    // Only parties to this upload may poll it: its creator, or the merchant/buyer/supplier
    // org it belongs to. (Master Key bypasses, same as elsewhere in this file.)
    const isParty =
      upload.created_by_member_id === member.id ||
      (upload.merchant_id && upload.merchant_id === member.organization_id) ||
      (upload.for_buyer_org_id && upload.for_buyer_org_id === member.organization_id) ||
      (upload.supplier_org_id && upload.supplier_org_id === member.organization_id)
    if (!isParty && !(await isPlmMasterKey(member.id)))
      return res.status(403).json({ error: 'Forbidden' })

    const { created_by_member_id, merchant_id, for_buyer_org_id, supplier_org_id, ...uploadPublic } = upload

    const { data: skus } = await supabase
      .from('npd2_catalog_skus')
      .select('id, auto_code, image_url, description, material, dimensions, finish, weight, category, temp_sku_ref, production_sku_id, npd2_catalog_uploads(supplier, season, sku_source)')
      .eq('catalog_upload_id', req.params.id)

    return res.json({
      upload: uploadPublic,
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

// Cancels a still-running catalog upload. There's no graceful "please stop" the worker can be
// told to honor — its own source lives in the separate jng-catalog-worker Cloud Run Job image,
// outside this repo — so this kills the running execution outright via the Cloud Run Admin API,
// then sweeps up whatever SKUs it had already created before the kill landed. Only ever removes
// rows from THIS upload with no workspace attached yet — same safety check as, and the exact
// same hard-delete pattern as, DELETE /catalog/skus/:id?fromUpload=1 (storage paths logged to
// the audit trail, never deleted from Storage itself). Matches what "cancel" should mean here:
// nothing from this run survives, not a partial result left behind.
router.post('/catalog/upload/:id/cancel', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req, res, 'id, organization_id')
    if (!member) return

    const { data: upload, error } = await supabase
      .from('npd2_catalog_uploads')
      .select('id, status, created_by_member_id, merchant_id, for_buyer_org_id, supplier_org_id, worker_execution_name')
      .eq('id', req.params.id)
      .maybeSingle()
    if (error) throw error
    if (!upload) return res.status(404).json({ error: 'Upload not found' })

    // Same "who may touch this upload" check as GET /catalog/upload-status/:id.
    const isParty =
      upload.created_by_member_id === member.id ||
      (upload.merchant_id && upload.merchant_id === member.organization_id) ||
      (upload.for_buyer_org_id && upload.for_buyer_org_id === member.organization_id) ||
      (upload.supplier_org_id && upload.supplier_org_id === member.organization_id)
    if (!isParty && !(await isPlmMasterKey(member.id)))
      return res.status(403).json({ error: 'Forbidden' })

    // Already finished one way or another — nothing left to kill, and any SKUs are a completed
    // result the polling loop already reported as done, not a mid-flight one to discard.
    if (['cancelled', 'error', 'done'].includes(upload.status))
      return res.json({ success: true, alreadyTerminal: true })

    if (upload.worker_execution_name) {
      try {
        const auth   = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
        const client = await auth.getClient()
        const region = 'asia-south2'
        await client.request({
          url: `https://${region}-run.googleapis.com/v2/${upload.worker_execution_name}:cancel`,
          method: 'POST',
        })
      } catch (cancelErr) {
        // The execution may have already finished on its own (a race with the poll loop) or
        // the saved name may be stale — either way, still fall through to mark cancelled and
        // clean up rather than leaving the upload permanently stuck if only the kill call fails.
        console.error('⚠️ Cloud Run execution cancel failed (continuing to mark cancelled):', cancelErr.message)
      }
    }

    await supabase
      .from('npd2_catalog_uploads')
      .update({ status: 'cancelled' })
      .eq('id', req.params.id)

    const { data: partialSkus } = await supabase
      .from('npd2_catalog_skus')
      .select('id, auto_code, image_url, model_3d_url')
      .eq('catalog_upload_id', req.params.id)

    if (partialSkus?.length) {
      const ids = partialSkus.map(s => s.id)
      const { data: wsRows } = await supabase
        .from('npd2_workspaces')
        .select('catalog_sku_id')
        .in('catalog_sku_id', ids)
      const attachedIds = new Set((wsRows || []).map(w => w.catalog_sku_id))
      const deletable = partialSkus.filter(s => !attachedIds.has(s.id))

      if (deletable.length) {
        await Promise.all(deletable.map(s => logAdminAction({
          actorMemberId: member.id,
          action: 'hard_delete_sku',
          targetType: 'sku',
          targetId: s.id,
          detail: {
            auto_code: s.auto_code, image_url: s.image_url, model_3d_url: s.model_3d_url,
            catalog_upload_id: req.params.id, via: 'upload_cancelled',
          },
        })))
        await supabase.from('npd2_catalog_skus').delete().in('id', deletable.map(s => s.id))
      }
    }

    return res.json({ success: true })
  } catch (err) {
    console.error('❌ POST /catalog/upload/:id/cancel:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════
// WORKSPACES
// ═══════════════════════════════════════════════

// GET /catalog/skus/:id/workspaces removed — unauthenticated, zero frontend callers
// (workspace data loads via direct supabase.from('npd2_workspaces') reads). It scoped only
// on a client-supplied merchantId/userId, so it leaked workspace state plus npd2_invites
// email addresses for any merchant org id.


// GET /plm/my-permission-grants — any authenticated member, no PLM tier required.
// Lets someone who's been granted view/comment/edit on a workspace (via the PLM Security
// console's Permissions tab) actually FIND it — a grant on its own doesn't put the
// workspace anywhere in their normal catalog/dashboard, so without this the only way in
// is someone manually handing them a direct link.
router.get('/my-permission-grants', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req, res)
    if (!member) return

    const { data: grants, error } = await supabase
      .from('npd2_workspace_permissions')
      .select('id, workspace_id, capability, created_at, granted_by_member_id')
      .eq('member_id', member.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    if (!grants.length) return res.json({ grants: [] })

    const workspaceIds = [...new Set(grants.map(g => g.workspace_id))]
    const { data: workspaces } = await supabase
      .from('npd2_workspaces')
      .select('id, status, catalog_sku_id, npd2_catalog_skus(auto_code, image_url, description)')
      .in('id', workspaceIds)
    const wsById = Object.fromEntries((workspaces || []).map(w => [w.id, w]))

    const granterIds = [...new Set(grants.map(g => g.granted_by_member_id).filter(Boolean))]
    const { data: granters } = granterIds.length
      ? await supabase.from('organization_members').select('id, full_name, email').in('id', granterIds)
      : { data: [] }
    const granterById = Object.fromEntries((granters || []).map(m => [m.id, m]))

    const enriched = grants.map(g => ({
      ...g,
      workspace: wsById[g.workspace_id] || null,
      granted_by_name: granterById[g.granted_by_member_id]?.full_name || granterById[g.granted_by_member_id]?.email || null,
    }))
    return res.json({ grants: enriched })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// GET /workspaces/:id removed — legacy (same family as the other untouched legacy
// /workspaces* routes), unauthenticated, zero frontend callers. The app uses
// /sku-workspaces/* plus direct supabase reads. Left open it returned an entire workspace —
// every comment across all channels, sample orders with confirmed prices, invitee emails —
// to anyone with the workspace UUID; the supplier comment filter trusted req.query.role.


router.post('/sku-workspaces', requireAuth, async (req, res) => {
  try {
    const { catalogSkuId, buyerEmail: buyerEmailRaw, supplierEmail: supplierEmailRaw } = req.body
    if (!catalogSkuId) return res.status(400).json({ error: 'catalogSkuId required' })
    if (!buyerEmailRaw) return res.status(400).json({ error: 'buyerEmail required' })
    const buyerEmail    = buyerEmailRaw.trim().toLowerCase()
    const supplierEmail = supplierEmailRaw ? supplierEmailRaw.trim().toLowerCase() : null

    // Previously trusted merchantId straight from the request body, with no check that the
    // caller actually has rights to catalogSkuId at all — any authenticated user could create
    // a workspace against any existing SKU, attributed to any merchant_member_id they chose.
    // merchantId is now always the caller's own resolved id, and verifySkuAccess (owner, peer
    // via merchant_access_pairs, or PLM master key) gates the SKU itself.
    const member = await resolveMember(req, res)
    if (!member) return
    const merchantId = member.id
    const access = await verifySkuAccess(merchantId, [catalogSkuId])
    if (!access.ok) return res.status(access.status).json({ error: access.error })

    // Seed reference_media with the catalog product photo so it shows up in the workspace's
    // Media Panel (and can be pinned as the buyer-brief / production image) from the start,
    // instead of only being visible on the read-only Product Info tab. Also resolve the SKU's
    // own buyer/supplier org here — never trust buyerOrgId/supplierOrgId from the request body
    // for the org-membership check below, since a client can pass any org it has a foothold in;
    // only the org actually recorded against this SKU's catalog upload is meaningful.
    const { data: catalogSku } = await supabase
      .from('npd2_catalog_skus')
      .select('image_url, notes, npd2_catalog_uploads ( supplier_org_id, for_buyer_org_id )')
      .eq('id', catalogSkuId)
      .maybeSingle()

    const realBuyerOrgId    = catalogSku?.npd2_catalog_uploads?.for_buyer_org_id || null
    const realSupplierOrgId = catalogSku?.npd2_catalog_uploads?.supplier_org_id  || null

    if (!(await emailBelongsToOrg(buyerEmail, realBuyerOrgId)))
      return res.status(400).json({ error: `${buyerEmail} is not a member of the buyer organization this SKU belongs to.` })
    if (supplierEmail && !(await emailBelongsToOrg(supplierEmail, realSupplierOrgId)))
      return res.status(400).json({ error: `${supplierEmail} is not a member of the supplier organization this SKU belongs to.` })

    const { data: workspace, error: wsError } = await supabase
      .from('npd2_workspaces')
      .insert([{
        catalog_sku_id: catalogSkuId,
        merchant_member_id:  merchantId,
        buyer_email:    buyerEmail,
        supplier_email: supplierEmail,
        supplier_org_id: realSupplierOrgId,
        buyer_org_id:    realBuyerOrgId,
        status:         'invited',
        reference_media: catalogSku?.image_url ? [{ url: catalogSku.image_url }] : [],
        // Seed the brief's Notes from whatever was written on the SKU at creation (kaptr
        // reference note). Stored as rich HTML under `notes` — the buyer brief renders it
        // like a chat note. `quality_notes` (the pre-rename key) is left untouched.
        buyer_brief: catalogSku?.notes?.html ? { notes: catalogSku.notes.html } : {},
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
    const { email, emails, role } = req.body

    // Support single email (backwards compat) or array of emails
    const emailList = (emails?.length ? emails : email ? [email] : []).map(e => e.trim().toLowerCase())
    if (!emailList.length || !role) return res.status(400).json({ error: 'email(s) and role required' })

    const member = await resolveMember(req, res)
    if (!member) return

    const { data: ws } = await supabase
      .from('npd2_workspaces')
      .select('*, npd2_catalog_skus ( auto_code, description, npd2_catalog_uploads ( supplier, season, supplier_org_id, for_buyer_org_id ) )')
      .eq('id', workspaceId)
      .maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    // Previously had no ownership check at all — any authenticated user could invite
    // buyer/supplier contacts into any workspace. Invites are merchant-only in the UI
    // (WorkspaceModal.jsx's InviteRow only renders for role === 'merchant'), so enforce that
    // here too — resolveWorkspaceActorRole already covers a paired peer merchant and the
    // PLM master key, not just the workspace's own creator.
    // One deliberate, narrow exception: a QA member may invite OTHER QA members (not
    // buyer/supplier) — everything else about QA stays read-only/no-management.
    const actorRole = await resolveWorkspaceActorRole(workspaceId, member.id, ws)
    const isMerchantInviter = actorRole === 'merchant' || actorRole === 'super_admin'
    const isQaInvitingQa    = actorRole === 'qa' && role === 'qa'
    if (!isMerchantInviter && !isQaInvitingQa)
      return res.status(403).json({ error: 'Only the merchant can invite people to this workspace' })

    const cs = ws?.npd2_catalog_skus
    const results = []

    // QA is neither buyer nor supplier — the invitee is in the MERCHANT's own org (department
    // 'qa'), never a separate buyer/supplier org. Resolved once up front, only when needed.
    let merchantOrgId = null
    if (role === 'qa' && ws.merchant_member_id) {
      const { data: merchantMember } = await supabase
        .from('organization_members').select('organization_id').eq('id', ws.merchant_member_id).maybeSingle()
      merchantOrgId = merchantMember?.organization_id || null
    }

    // Real org is always derived server-side, never trusted from the request body — a
    // workspace already has its own org recorded once a first invite has gone out; before
    // that, fall back to the SKU's own catalog upload.
    const realOrgId = role === 'buyer'
      ? (ws.buyer_org_id    || cs?.npd2_catalog_uploads?.for_buyer_org_id || null)
      : role === 'qa'
      ? merchantOrgId
      : (ws.supplier_org_id || cs?.npd2_catalog_uploads?.supplier_org_id  || null)

    // No cap on the number of buyer/vendor/qa invites per role per workspace.
    for (const addr of emailList) {
      const orgOk = role === 'qa' ? await emailBelongsToQaDept(addr, realOrgId) : await emailBelongsToOrg(addr, realOrgId)
      if (!orgOk) {
        results.push({ email: addr, status: 'org_mismatch' })
        continue
      }

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
      if (realOrgId) {
        const { data: matchedMember } = await supabase
          .from('organization_members').select('id')
          .eq('organization_id', realOrgId).ilike('email', addr).maybeSingle()
        resolvedMemberId = matchedMember?.id || null
      }

      const token = require('crypto').randomUUID()
      const { error: invErr } = await supabase
        .from('npd2_invites')
        .insert([{ workspace_id: workspaceId, email: addr, role, token, status: 'pending', member_id: resolvedMemberId }])
      if (invErr) throw invErr

      const forwardStatuses = ['active', 'on_hold', 'approved', 'sample', 'production', 'reviewing']

      // QA has no "primary slot" concept at all (it's not buyer_member_id/supplier_member_id
      // and never should be — see resolveWorkspaceActorRole), and doesn't participate in the
      // buyer/vendor activation pipeline, so it skips both the primary-field write below AND
      // the 'invited' status transition — a QA invite alone should never flip a blank
      // workspace's status the way a first buyer/vendor invite does.
      if (role !== 'qa') {
        // Update workspace org/email fields only if the primary slot isn't already taken
        // and the workspace hasn't moved past 'invited' — never touch an active workspace
        const primaryField = role === 'buyer' ? 'buyer_member_id' : 'supplier_member_id'
        const primaryFilled = !!ws[primaryField] || forwardStatuses.includes(ws.status) || results.some(r => r.status === 'sent')
        if (!primaryFilled) {
          const updateData = role === 'buyer'
            ? { buyer_org_id: realOrgId, buyer_email: addr }
            : { supplier_org_id: realOrgId, supplier_email: addr }
          await supabase.from('npd2_workspaces').update(updateData).eq('id', workspaceId)
        }

        // A workspace still pre-invite (e.g. a blank stub with status null) should reflect that
        // it now has a live invite out. Workspaces already past invited (active/approved/etc)
        // are protected by forwardStatuses and never get regressed back to 'invited'.
        if (!forwardStatuses.includes(ws.status) && ws.status !== 'invited')
          await supabase.from('npd2_workspaces').update({ status: 'invited' }).eq('id', workspaceId)
      }

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


// Read-only "I forgot to copy the link" recovery — returns the EXISTING token/link for a
// still-pending invite without touching the npd2_invites row at all. Deliberately never
// mutates (unlike POST /sku-workspaces/:id/invite, which always deletes+recreates with a
// fresh token): a bulk invite shares one token across every workspace in that batch, and
// regenerating from a single workspace would silently split it out of the batch onto its own
// token, leaving the others on the old link. A pure read avoids that entirely — the same
// token, wherever it's revealed from, is still the same link that joins every workspace it
// was ever attached to. Also surfaces every OTHER workspace sharing that token, so the
// merchant can see (and choose to undo, via revoke) the full blast radius of the link before
// handing it out again.
router.get('/sku-workspaces/:id/invites/:inviteId/link', requireAuth, async (req, res) => {
  try {
    const { id: workspaceId, inviteId } = req.params
    const member = await resolveMember(req, res)
    if (!member) return

    const { data: ws } = await supabase.from('npd2_workspaces').select('*').eq('id', workspaceId).maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    const { data: invite } = await supabase
      .from('npd2_invites')
      .select('id, token, email, role, status, expires_at, accepted_at, workspace_id')
      .eq('id', inviteId).eq('workspace_id', workspaceId).maybeSingle()
    if (!invite) return res.status(404).json({ error: 'Invite not found' })

    // Same narrow QA-can-manage-QA exception as the invite/revoke routes.
    const actorRole = await resolveWorkspaceActorRole(workspaceId, member.id, ws)
    const isMerchantViewer = actorRole === 'merchant' || actorRole === 'super_admin'
    const isQaViewingQa    = actorRole === 'qa' && invite.role === 'qa'
    if (!isMerchantViewer && !isQaViewingQa)
      return res.status(403).json({ error: 'Only the merchant can view invite links' })

    if (invite.status === 'accepted' || invite.accepted_at)
      return res.status(409).json({ error: 'This invite has already been accepted' })

    const isExpired = invite.status === 'expired' || (invite.expires_at && new Date(invite.expires_at) < new Date())
    if (isExpired)
      return res.status(410).json({ error: 'This invite has expired — use Resend to generate a fresh link' })

    // Every other workspace sharing this exact token (bulk invites share one token across
    // many workspace rows) — filtered to workspaces this same merchant actually owns/co-owns,
    // so a token collision (practically impossible with UUIDs, but cheap to guard) could never
    // leak another merchant's workspace details through this response.
    const { data: linkedInvites } = await supabase
      .from('npd2_invites')
      .select('workspace_id, npd2_workspaces(id, merchant_member_id, catalog_sku_id, npd2_catalog_skus(auto_code, description))')
      .eq('token', invite.token)
      .neq('status', 'revoked')

    const ownWorkspaceRole = new Map() // workspace_id -> verified actor role, memoized across rows
    const workspaces = []
    for (const row of (linkedInvites || [])) {
      const lw = row.npd2_workspaces
      if (!lw) continue
      let role = ownWorkspaceRole.get(lw.id)
      if (role === undefined) {
        role = await resolveWorkspaceActorRole(lw.id, member.id, lw)
        ownWorkspaceRole.set(lw.id, role)
      }
      if (role !== 'merchant') continue
      workspaces.push({
        id: lw.id,
        skuCode: lw.npd2_catalog_skus?.auto_code || null,
        description: lw.npd2_catalog_skus?.description || null,
      })
    }

    return res.json({
      link: `${frontendUrl}/plm/accept?token=${invite.token}`,
      expiresAt: invite.expires_at,
      workspaces,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})


// Invite one person (buyer or supplier) to many existing workspaces at once — sends ONE email
router.post('/sku-workspaces/bulk-invite', requireAuth, async (req, res) => {
  try {
    const { workspaceIds, email: rawEmail, role, skipEmail } = req.body
    if (!workspaceIds?.length || !rawEmail || !role)
      return res.status(400).json({ error: 'workspaceIds, email, and role required' })
    const email = rawEmail.trim().toLowerCase()

    const member = await resolveMember(req, res)
    if (!member) return

    const { data: workspaces } = await supabase
      .from('npd2_workspaces')
      .select('*, npd2_catalog_skus ( auto_code, description, npd2_catalog_uploads ( supplier, season, supplier_org_id, for_buyer_org_id ) )')
      .in('id', workspaceIds)
    if (!workspaces?.length) return res.status(404).json({ error: 'No workspaces found' })

    const sharedToken = require('crypto').randomUUID()
    const results = []
    const forwardStatuses = ['active', 'on_hold', 'approved', 'sample', 'production', 'reviewing']

    for (const ws of workspaces) {
      // Same merchant-only ownership check as the single-workspace invite route — previously
      // missing here entirely, so any authenticated user could bulk-invite into workspaces
      // they had no relationship to. Checked per-workspace (not once up front) since a batch
      // can span workspaces the caller only has access to some of.
      const actorRole = await resolveWorkspaceActorRole(ws.id, member.id, ws)
      if (actorRole !== 'merchant' && actorRole !== 'super_admin') {
        results.push({ workspaceId: ws.id, status: 'forbidden' })
        continue
      }

      // Never trust a client-supplied orgId — each workspace in this batch can belong to a
      // different SKU/buyer, so the real org is derived per-workspace, same as the single-invite
      // route: the workspace's own org column if already set, else the SKU's catalog upload.
      const cs = ws?.npd2_catalog_skus
      let qaOrgId = null
      if (role === 'qa' && ws.merchant_member_id) {
        const { data: merchantMember } = await supabase
          .from('organization_members').select('organization_id').eq('id', ws.merchant_member_id).maybeSingle()
        qaOrgId = merchantMember?.organization_id || null
      }
      const realOrgId = role === 'buyer'
        ? (ws.buyer_org_id    || cs?.npd2_catalog_uploads?.for_buyer_org_id || null)
        : role === 'qa'
        ? qaOrgId
        : (ws.supplier_org_id || cs?.npd2_catalog_uploads?.supplier_org_id  || null)

      const orgOk = role === 'qa' ? await emailBelongsToQaDept(email, realOrgId) : await emailBelongsToOrg(email, realOrgId)
      if (!orgOk) {
        results.push({ workspaceId: ws.id, status: 'org_mismatch' })
        continue
      }

      // Resolve to the invitee's own org member row (if one exists) — never the sender's.
      // member_id should identify the buyer/supplier being invited, not the merchant sending the invite.
      let resolvedMemberId = null
      if (realOrgId) {
        const { data: matchedMember } = await supabase
          .from('organization_members').select('id')
          .eq('organization_id', realOrgId).ilike('email', email).maybeSingle()
        resolvedMemberId = matchedMember?.id || null
      }

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

      // No cap on the number of buyer/vendor invites per role per workspace.

      // Delete any existing invite (pending, expired, revoked) so the new row gets a fresh token + expires_at
      if (existing) await supabase.from('npd2_invites').delete().eq('id', existing.id)

      const { error: invErr } = await supabase
        .from('npd2_invites')
        .insert([{ workspace_id: ws.id, email, role, token: sharedToken, status: 'pending', member_id: resolvedMemberId }])
      if (invErr) throw invErr

      // QA has no primary-slot concept (see the single-invite route for the full reasoning) —
      // skip both the primary-field write and the 'invited' status transition entirely.
      if (role !== 'qa') {
        const primaryField = role === 'buyer' ? 'buyer_member_id' : 'supplier_member_id'
        const primaryFilled = !!ws[primaryField] || forwardStatuses.includes(ws.status)
        if (!primaryFilled) {
          const updateData = role === 'buyer'
            ? { buyer_org_id: realOrgId, buyer_email: email }
            : { supplier_org_id: realOrgId, supplier_email: email }
          await supabase.from('npd2_workspaces').update(updateData).eq('id', ws.id)
        }

        // A workspace still pre-invite (e.g. a blank stub with status null) should reflect that
        // it now has a live invite out. Workspaces already past invited (active/approved/etc)
        // are protected by forwardStatuses and never get regressed back to 'invited'.
        if (!forwardStatuses.includes(ws.status) && ws.status !== 'invited')
          await supabase.from('npd2_workspaces').update({ status: 'invited' }).eq('id', ws.id)
      }

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

    const member = await resolveMember(req, res)
    if (!member) return

    const { data: ws } = await supabase
      .from('npd2_workspaces')
      .select('merchant_member_id, buyer_member_id, supplier_member_id')
      .eq('id', workspaceId)
      .maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    const { data: invite, error: fetchErr } = await supabase
      .from('npd2_invites')
      .select('id, status, role, workspace_id')
      .eq('id', inviteId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    if (fetchErr) throw fetchErr
    if (!invite) return res.status(404).json({ error: 'Invite not found' })

    // Same gap as POST .../invite above — no ownership check at all previously. Revoking
    // is the same merchant-only action as sending the invite in the first place — with the
    // same narrow QA-can-manage-QA exception as the invite route (invite.role check, not just
    // actorRole, so a QA member can't revoke a buyer/vendor invite by hitting this route).
    const actorRole = await resolveWorkspaceActorRole(workspaceId, member.id, ws)
    const isMerchantRevoker = actorRole === 'merchant' || actorRole === 'super_admin'
    const isQaRevokingQa    = actorRole === 'qa' && invite.role === 'qa'
    if (!isMerchantRevoker && !isQaRevokingQa)
      return res.status(403).json({ error: 'Only the merchant can revoke invites on this workspace' })

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
    const { catalogSkuIds, buyerEmail: buyerEmailRaw, supplierEmail: supplierEmailRaw, skipInvites } = req.body
    if (!catalogSkuIds?.length) return res.status(400).json({ error: 'catalogSkuIds required' })
    if (!buyerEmailRaw)         return res.status(400).json({ error: 'buyerEmail required' })
    const buyerEmail    = buyerEmailRaw.trim().toLowerCase()
    const supplierEmail = supplierEmailRaw ? supplierEmailRaw.trim().toLowerCase() : null

    // Same fix as the single-workspace POST /sku-workspaces above — merchantId is now always
    // the caller's own resolved id, and verifySkuAccess gates every SKU in the batch (owner,
    // peer via merchant_access_pairs, or PLM master key), instead of trusting merchantId and
    // an unrestricted catalogSkuIds list straight from the request body.
    const member = await resolveMember(req, res)
    if (!member) return
    const merchantId = member.id
    const access = await verifySkuAccess(merchantId, catalogSkuIds)
    if (!access.ok) return res.status(access.status).json({ error: access.error })

    // Seed reference_media with each catalog product photo so it shows up in the workspace's
    // Media Panel (and can be pinned as the buyer-brief / production image) from the start,
    // instead of only being visible on the read-only Product Info tab. Also resolve each SKU's
    // own buyer/supplier org here — never trust buyerOrgId/supplierOrgId from the request body,
    // since a client can pass any org it has a foothold in; only the org actually recorded
    // against each SKU's catalog upload is meaningful, and a bulk batch can span multiple uploads.
    const { data: catalogSkus } = await supabase
      .from('npd2_catalog_skus')
      .select('id, image_url, npd2_catalog_uploads ( supplier_org_id, for_buyer_org_id )')
      .in('id', catalogSkuIds)
    const imageUrlBySkuId = Object.fromEntries((catalogSkus || []).map(cs => [cs.id, cs.image_url]))
    const orgsBySkuId = Object.fromEntries((catalogSkus || []).map(cs => [cs.id, {
      buyerOrgId:    cs.npd2_catalog_uploads?.for_buyer_org_id || null,
      supplierOrgId: cs.npd2_catalog_uploads?.supplier_org_id  || null,
    }]))

    if (!skipInvites) {
      const distinctBuyerOrgIds    = [...new Set(Object.values(orgsBySkuId).map(o => o.buyerOrgId))]
      const distinctSupplierOrgIds = [...new Set(Object.values(orgsBySkuId).map(o => o.supplierOrgId))]
      for (const orgId of distinctBuyerOrgIds) {
        if (!(await emailBelongsToOrg(buyerEmail, orgId)))
          return res.status(400).json({ error: `${buyerEmail} is not a member of the buyer organization these SKUs belong to.` })
      }
      if (supplierEmail) {
        for (const orgId of distinctSupplierOrgIds) {
          if (!(await emailBelongsToOrg(supplierEmail, orgId)))
            return res.status(400).json({ error: `${supplierEmail} is not a member of the supplier organization these SKUs belong to.` })
        }
      }
    }

    const buyerToken    = skipInvites ? null : require('crypto').randomUUID()
    const supplierToken = skipInvites || !supplierEmail ? null : require('crypto').randomUUID()

    const workspaces = []
    for (const catalogSkuId of catalogSkuIds) {
      const imageUrl = imageUrlBySkuId[catalogSkuId]
      const { buyerOrgId: skuBuyerOrgId, supplierOrgId: skuSupplierOrgId } = orgsBySkuId[catalogSkuId] || {}
      const { data: workspace, error: wsError } = await supabase
        .from('npd2_workspaces')
        .insert([{
          catalog_sku_id:     catalogSkuId,
          merchant_member_id: merchantId,
          buyer_email:        buyerEmail,
          supplier_email:     supplierEmail,
          supplier_org_id:    skuSupplierOrgId || null,
          buyer_org_id:       skuBuyerOrgId    || null,
          status:             'invited',
          reference_media:    imageUrl ? [{ url: imageUrl }] : [],
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


router.post('/workspace-invites/accept', requireAuth, async (req, res) => {
  try {
    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    // memberId must come from the authenticated session, never the request body — otherwise
    // anyone with a valid session could attach an arbitrary member to a workspace by simply
    // passing a different memberId whose email happens to match the invite. Select email +
    // organization_id here too, since the org/email verification below needs them anyway.
    const member = await resolveMember(req, res, 'id, email, organization_id, department')
    if (!member) return
    const memberId = member.id

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

    // Verify the accepting member's email matches the invite recipient, and their organization
    // matches the org the workspace's SKU actually belongs to — without this, a workspace
    // invite could be accepted by any org whose member happens to hold a matching email,
    // silently attaching the wrong buyer/supplier org to the workspace. (member itself is
    // already resolved+authenticated above via resolveMember.)
    if (first.email && member.email?.toLowerCase() !== first.email.toLowerCase())
      return res.status(403).json({ error: 'This invite was sent to a different email address.' })

    if (first.role === 'qa') {
      // QA isn't in a separate buyer/supplier org — they're in the MERCHANT's own org, and
      // must actually be department 'qa' there (not just any merchant staffer). Mirrors the
      // send-time check in POST .../invite (emailBelongsToQaDept), just re-verified here at
      // accept time against whoever is ACTUALLY logging in, same as the buyer/supplier org
      // check below does for them.
      const { data: merchantMember } = await supabase
        .from('organization_members').select('organization_id')
        .eq('id', first.npd2_workspaces?.merchant_member_id).maybeSingle()
      const merchantOrgId = merchantMember?.organization_id || null
      if (!merchantOrgId || member.organization_id !== merchantOrgId || member.department !== 'qa')
        return res.status(403).json({ error: 'This invite is only valid for a QA-department member of the merchant organization.' })
    } else {
      const expectedOrgId = first.role === 'buyer'
        ? first.npd2_workspaces?.buyer_org_id
        : first.npd2_workspaces?.supplier_org_id

      if (expectedOrgId && member.organization_id !== expectedOrgId)
        return res.status(403).json({ error: 'You are not a member of the organization this invite belongs to.' })
    }

    if (first.role === 'qa') {
      // No primary-slot concept for QA (never buyer_member_id/supplier_member_id, never a
      // workspace status change) — accepting only adds them to Group Chat, which is the
      // entire reason a QA invite exists. Buyer/supplier group-chat membership is a separate,
      // manual merchant action (PATCH .../group-chat-members); QA skips that step since chat
      // access is the whole point of the invite, not an add-on to some other role.
      for (const invite of activeInvites) {
        const { data: ws } = await supabase
          .from('npd2_workspaces').select('group_chat_member_ids').eq('id', invite.workspace_id).maybeSingle()
        const current = ws?.group_chat_member_ids || []
        if (!current.includes(memberId))
          await supabase.from('npd2_workspaces').update({ group_chat_member_ids: [...current, memberId] }).eq('id', invite.workspace_id)
      }
    } else {
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
    }

    const activeIds = activeInvites.map(i => i.id)
    await supabase
      .from('npd2_invites')
      .update({ status: 'accepted', accepted_at: new Date(), member_id: memberId })
      .in('id', activeIds)

    if (first.role === 'qa') {
      // Permanent PLM sidebar access going forward — without this, the accept-flow redirect
      // works once but the member has no way back into /plm on their own next session (qa
      // dept's default allowed_modules excludes 'npd', see config/modules.js on the frontend).
      // Their catalog view stays safely scoped to only their invited SKUs regardless (see
      // fetchCatalog's new 'qa' branch), so granting the module here is safe.
      const { data: memberRow } = await supabase
        .from('organization_members').select('allowed_modules').eq('id', memberId).maybeSingle()
      const allowedModules = memberRow?.allowed_modules
      if (allowedModules && !('npd' in allowedModules)) {
        await supabase.from('organization_members')
          .update({ allowed_modules: { ...allowedModules, npd: null } }).eq('id', memberId)
      }

      // Group-Chat-scoped "joined" milestone, mirroring the account-free guest invite's own
      // join milestone shape (role/channel/event) — NOT the generic buyer/vendor
      // insertSystemComment path above, which (a) has no channel param, defaulting to
      // whichever channel the DB column defaults to, and (b) filterCommentsForRole's
      // hidesOtherSideJoin only knows buyer/vendor, so a role:'merchant' milestone here would
      // get miscategorized as vendor-side and leak into Vendor Activity. channel:'group' keeps
      // it out of Buyer/Vendor Activity entirely (both branches guard on `channel !== 'group'`
      // before their role checks) and correctly feeds the existing group_chat_joined/left
      // windowing other viewers rely on to know when this member's access began.
      for (const wsId of [...new Set(activeInvites.map(i => i.workspace_id))]) {
        try {
          await supabase.from('npd2_comments').insert([{
            workspace_id: wsId, author_member_id: memberId, role: 'qa',
            type: 'milestone', channel: 'group', body: 'joined Group Chat',
            metadata: { event: 'group_chat_joined' },
          }])
        } catch (e) {
          console.error('invite-accept qa milestone insert failed for', wsId, e.message)
        }
      }
    } else {
      // Milestone in each workspace's activity so the merchant (and any party already in)
      // sees that the buyer/vendor has joined. Authored by the accepter (author_member_id =
      // memberId, so the "by <name>" resolves), but role 'merchant' so it renders as a system
      // line visible to every participant. Best-effort — never fail the accept over it.
      const joinLabel = first.role === 'buyer' ? 'Buyer joined the workspace' : 'Vendor joined the workspace'
      for (const wsId of [...new Set(activeInvites.map(i => i.workspace_id))]) {
        try {
          await insertSystemComment(wsId, memberId, 'merchant', 'milestone', joinLabel,
            { event: 'invite_accepted', accepted_role: first.role })
        } catch (e) {
          console.error('invite-accept milestone insert failed for', wsId, e.message)
        }
      }
    }

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
      'target_price', 'target_qty', 'buyer_ref', 'buyer_brief', 'vendor_stock_number',
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
        if (field !== 'buyer_brief') {
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
      'target_price', 'target_qty', 'buyer_ref', 'buyer_brief', 'vendor_stock_number',
    ]

    const { data: current, error: fetchErr } = await supabase
      .from('npd2_workspaces')
      .select(`merchant_member_id, buyer_member_id, supplier_member_id, reference_media, ${allowed.join(', ')}`)
      .eq('id', req.params.id)
      .maybeSingle()
    if (fetchErr) throw fetchErr
    if (!current) return res.status(404).json({ error: 'Workspace not found' })

    // Previously derived a role label purely for activity-log attribution without ever
    // checking whether the caller actually belongs to this workspace — any authenticated
    // member of any org could edit any workspace's buyer_brief/target_price/etc. and have it
    // misattributed as "merchant" in the log. resolveWorkspaceActorRole returns null instead
    // of silently falling back when the member isn't a real participant.
    let role = await resolveWorkspaceActorRole(req.params.id, memberId, current)
    if (!role) {
      // Not a real participant — fall back to an explicit 'edit' grant from the PLM
      // Security console (npd2_workspace_permissions), if any.
      if (await hasWorkspaceCapability(req.params.id, memberId, ['edit'])) {
        role = 'granted'
      } else {
        return res.status(403).json({ error: 'You are not a participant on this workspace' })
      }
    }

    const updates = {}
    const changes = []
    let imageChanged = null // { type: 'set'|'unset', from, to } | null — buyer_brief.image_url pin, logged as a milestone below instead of a raw-URL field_change
    let briefNotesChange = null // { from, to } | null — the rich-text Notes field; logged as a field_change (stripped preview) + an audit-log row (raw HTML never goes in a field_change comment)
    let newNoteImages = null // string[] | null — every <img> src currently in the Notes field whenever it's saved (not just ones added THIS save — a note edited before this feature existed would otherwise never backfill its older images), minus whichever are already in reference_media below
    const extractImgSrcs = html => Array.from(String(html || '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)).map(m => m[1])

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
        if ('image_url' in patch && (oldBrief.image_url || null) !== (patch.image_url || null)) {
          imageChanged = {
            type: patch.image_url ? 'set' : 'unset',
            from: oldBrief.image_url || null,
            to:   patch.image_url || null,
          }
        }
        // Rich-text Notes — 'notes' (post-rename) or 'quality_notes' (legacy client). Compared
        // outside LOGGABLE_BRIEF_FIELDS so its HTML never lands in a field_change comment.
        const noteKey = 'notes' in patch ? 'notes' : ('quality_notes' in patch ? 'quality_notes' : null)
        if (noteKey && String(oldBrief[noteKey] ?? '') !== String(patch[noteKey] ?? '')) {
          briefNotesChange = { from: oldBrief[noteKey] ?? '', to: patch[noteKey] ?? '' }
          // ALL images currently in the note, not just ones added this save — reference_media
          // dedupes by URL below, so images already mirrored are a no-op, but this also sweeps
          // in any older image that was embedded in the note before this backfill existed and
          // would otherwise sit there forever never counting as "newly added".
          const allImgs = extractImgSrcs(patch[noteKey])
          if (allImgs.length) newNoteImages = allImgs
        }
        continue
      }
      if (fields[field] !== undefined && JSON.stringify(fields[field]) !== JSON.stringify(current[field])) {
        updates[field] = fields[field]
        changes.push({ field, from: current[field], to: fields[field] })
      }
    }
    // Images dropped into the Notes editor only ever lived inline in buyer_brief.notes HTML —
    // they never made it into reference_media, so they never showed up in the Media panel.
    // Mirror whichever of the note's images aren't in reference_media yet (flagged fromNotes so
    // the Media panel can group + attribute them correctly) — already-mirrored ones (from an
    // earlier save) are filtered out here, so this only actually grows the array once per image.
    let mirroredNoteImages = null // just the ones genuinely new to reference_media — used below for the "Images Added" milestone, so it doesn't re-announce ones already mirrored
    if (newNoteImages?.length) {
      const existingMedia = current.reference_media || []
      const existingUrls  = new Set(existingMedia.map(m => m.url))
      const toAdd = newNoteImages.filter(u => !existingUrls.has(u)).map(url => ({ url, fromNotes: true }))
      if (toAdd.length) {
        updates.reference_media = [...existingMedia, ...toAdd]
        mirroredNoteImages = toAdd.map(m => m.url)
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
    if (imageChanged) {
      await insertSystemComment2(req.params.id, memberId, role, 'milestone', null,
        {
          event: imageChanged.type === 'set' ? 'buyer_brief_image_set' : 'buyer_brief_image_unset',
          stage: 'brief',
          from: imageChanged.from,
          to:   imageChanged.to,
        })
    }
    if (briefNotesChange) {
      const stripTags = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const notesFromText = stripTags(briefNotesChange.from)
      const notesToText   = stripTags(briefNotesChange.to)
      // Activity feed: field_change like every other brief field, but with a stripped,
      // truncated PLAIN-TEXT preview standing in for the field value — never the raw HTML —
      // so members can actually see what the note now says instead of a bare "notes updated".
      const truncate = t => t.length > 140 ? t.slice(0, 140) + '…' : t
      await insertSystemComment2(req.params.id, memberId, role, 'field_change', null,
        { field: 'notes', from: truncate(notesFromText), to: truncate(notesToText) })
      // Moderation → Audit Log: the actual from → to, untruncated.
      await logAdminAction({
        actorMemberId: memberId, action: 'edit_brief_notes',
        targetType: 'workspace', targetId: req.params.id,
        detail: {
          from: notesFromText || null,
          to:   notesToText   || null,
          actor_role: role,
        },
      })
    }
    if (mirroredNoteImages?.length) {
      // Lets the Media panel's findMediaMilestone() attribute these entries to the right
      // actor/timestamp (same lookup it already uses for edited/rejected reference_media),
      // instead of falling back to the SKU's creation date like an untouched spec page would.
      await insertSystemComment2(req.params.id, memberId, role, 'milestone', null,
        { event: 'note_images_added', stage: 'brief', urls: mirroredNoteImages })
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
    let archivedRejectedUrls = null // fed into the approved_to_sample milestone below so the frontend can look up when these specific images were rejected
    if (priorSampleImages.length) {
      const currentMedia = ws.reference_media || []
      const existingUrls = new Set(currentMedia.map(m => m.url))
      const toArchive = priorSampleImages.filter(url => url && !existingUrls.has(url))
      if (toArchive.length) {
        referenceMediaUpdate = [...currentMedia, ...toArchive.map(url => ({ url, rejected: true }))]
        archivedRejectedUrls = toArchive
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
      target_ready_date: null, actual_ready_date: null, sample_delivered_date: null,
      ship_mode: null, tracking_ref: null, etd: null, eta: null,
      container_no: null, vessel_no: null, courier_company: null,
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
      {
        event: 'approved_to_sample', stage: 'approved', buyer_ref: ws.buyer_ref,
        ...(archivedRejectedUrls && { rejectedUrls: archivedRejectedUrls }),
      })

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



// Shared by POST .../comments and GET .../comments — mirrors the frontend's own role
// derivation (WorkspaceModal/plmStore) so server-side filtering matches what the UI expects.
async function resolveCommentRole(workspaceId, memberId, ws) {
  if (ws.buyer_member_id === memberId) return 'buyer'
  if (ws.supplier_member_id === memberId) return 'supplier'
  // Multi-invite: check accepted invites for this member
  const { data: inv } = await supabase
    .from('npd2_invites')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('member_id', memberId)
    .eq('status', 'accepted')
    .maybeSingle()
  return inv ? inv.role : 'merchant'
}

// Filters a full comment list down to what `role` is allowed to see — mirrors the frontend's
// buyerComments/vendorComments/groupComments split (WorkspaceModal.jsx) exactly, so switching
// the fetch from a direct client-side Supabase query to this endpoint doesn't change what
// anyone currently sees, it only stops leaking channels they aren't part of over the wire.
// groupJoinedAt: optional precomputed cutoff for callers that can't scan the full comment list
// up front (comments-bulk, which calls this once per single comment). Leave undefined to derive
// it here from `comments` — only correct when `comments` is the full per-workspace list, as in
// the main GET /sku-workspaces/:id/comments route.
function filterCommentsForRole(comments, role, ws, memberId, groupJoinedAt) {
  if (role === 'merchant') return comments

  const isSystem = c => c.type === 'milestone' || c.type === 'field_change' || c.type === 'spec_summary'
  const inGroup = (ws.group_chat_member_ids || []).includes(memberId)

  // Group Chat is windowed by presence: a member sees messages sent while they were actually
  // in the group. If they're in now, the last window runs to "now". After being removed they
  // KEEP read-only access to that history (the tab still shows it; the composer stays locked).
  // Windows are built from this member's own joined/left milestones, in order.
  let groupComments = []
  if (groupJoinedAt !== undefined) {
    // comments-bulk path — a single precomputed cutoff, no full list here to build windows.
    groupComments = inGroup
      ? comments.filter(c => c.channel === 'group' && (!groupJoinedAt || c.created_at >= groupJoinedAt))
      : []
  } else {
    const myMs = comments
      .filter(c => c.channel === 'group' && c.type === 'milestone' && c.author_member_id === memberId
        && (c.metadata?.event === 'group_chat_joined' || c.metadata?.event === 'group_chat_left'))
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    const windows = []
    let openFrom = null
    for (const m of myMs) {
      if (m.metadata.event === 'group_chat_joined') { if (openFrom === null) openFrom = m.created_at }
      else if (openFrom !== null) { windows.push([openFrom, m.created_at]); openFrom = null }
    }
    if (openFrom !== null) windows.push([openFrom, null])
    // In the group but no join milestone at all (added before this logging existed) → full history.
    if (!windows.length && inGroup) windows.push([null, null])
    if (windows.length) {
      groupComments = comments.filter(c => c.channel === 'group' &&
        windows.some(([from, to]) => (from === null || c.created_at >= from) && (to === null || c.created_at <= to)))
    }
  }

  // QA never sees Buyer/Vendor Activity at all — Group Chat only, read-only elsewhere (the
  // read-only detail panels aren't comments, they're separate workspace fields the frontend
  // already renders without edit rights for this role). groupComments above is already
  // correctly windowed by group_chat_member_ids regardless of role, so this is a one-line
  // early return rather than falling into the vendor-shaped default below (which would
  // needlessly filter for c.role === 'supplier' content this viewer will never actually see).
  if (role === 'qa') return groupComments

  // The "Buyer/Vendor joined the workspace" milestone (event: invite_accepted, carrying
  // accepted_role) is only the viewer's own side's business — a buyer shouldn't see "Vendor
  // joined" and vice-versa.
  const hidesOtherSideJoin = (c, viewerSide) => {
    if (c.metadata?.event !== 'invite_accepted' || !c.metadata?.accepted_role) return false
    const joinSide = c.metadata.accepted_role === 'buyer' ? 'buyer' : 'vendor'
    return joinSide !== viewerSide
  }

  // channel !== 'group' guard: without it, a buyer's/supplier's own Group Chat comments (and
  // the "joined Group Chat" milestone, which carries the joiner's own role) matched the bare
  // `c.role === 'buyer'`/`c.role === 'supplier'` clauses below regardless of channel, so they
  // leaked into Buyer/Vendor Activity too — group-channel comments belong to groupComments only.
  if (role === 'buyer') {
    const buyerComments = comments.filter(c =>
      !hidesOtherSideJoin(c, 'buyer') &&
      c.channel !== 'group' &&
      (c.type === 'spec_summary' || c.role === 'buyer' || (c.role === 'merchant' && (c.channel === 'buyer' || isSystem(c))))
    )
    return [...buyerComments, ...groupComments]
  }

  // supplier (or any other/co-invite role — treat the same as supplier's narrower view)
  const vendorComments = comments.filter(c =>
    !hidesOtherSideJoin(c, 'vendor') &&
    c.channel !== 'group' &&
    (c.role === 'supplier' || (c.role === 'merchant' && (c.channel === 'vendor' || c.channel === 'supplier')))
  )
  return [...vendorComments, ...groupComments]
}

router.get('/sku-workspaces/:id/comments', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const { data: ws, error: wsErr } = await supabase
      .from('npd2_workspaces')
      .select('merchant_member_id, buyer_member_id, supplier_member_id, group_chat_member_ids')
      .eq('id', req.params.id)
      .maybeSingle()
    if (wsErr) throw wsErr
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    const role = await resolveCommentRole(req.params.id, memberId, ws)

    const [{ data: comments, error }, { data: lastSeen }] = await Promise.all([
      supabase
        .from('npd2_comments')
        .select('*')
        .eq('workspace_id', req.params.id)
        .order('created_at', { ascending: true }),
      // Read-only here, deliberately — the caller's own "mark as seen" write happens as a
      // separate, later call (see PATCH .../mark-seen below), so the flags computed against
      // this pre-write value always reflect what the viewer hadn't seen yet at open time,
      // never a value this same request just clobbered.
      supabase
        .from('workspace_last_seen')
        .select('seen_at')
        .eq('member_id', memberId)
        .eq('workspace_id', req.params.id)
        .maybeSingle(),
    ])
    if (error) throw error

    const seenAt = lastSeen?.seen_at || null
    const filtered = filterCommentsForRole(comments || [], role, ws, memberId)
    // is_unread is only ever meaningful with a real prior seen_at — a member who has never
    // opened this workspace before has nothing to be "caught up from", so nothing is flagged
    // (matches the pre-existing frontend semantics this replaces, rather than flagging an
    // entire history as unread on a first-ever visit). Deliberately covers every comment type
    // (comment/milestone/field_change) — any workspace change since the viewer last looked
    // counts as something to catch up on, not just an actual chat message.
    const withUnread = seenAt
      ? filtered.map(c => ({ ...c, is_unread: c.author_member_id !== memberId && c.created_at > seenAt }))
      : filtered.map(c => ({ ...c, is_unread: false }))

    return res.json({ comments: withUnread })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Explicit "mark as seen" — called by the frontend once it's done deciding what to do with the
// is_unread flags from the GET above (jump to first unread, show badges, etc.), never bundled
// into that same request. Keeping them as two separate calls is what lets the GET's flags stay
// accurate: if marking-seen happened inside the GET itself, every comment fetch would
// immediately erase the very cutoff it just used to compute is_unread.
router.patch('/sku-workspaces/:id/mark-seen', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req, res)
    if (!member) return

    const { error } = await supabase
      .from('workspace_last_seen')
      .upsert({ member_id: member.id, workspace_id: req.params.id, seen_at: new Date().toISOString() }, { onConflict: 'member_id,workspace_id' })
    if (error) throw error

    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Bulk, cross-workspace equivalent of the single-workspace GET above — feeds the Activity Log
// drawer and the floating Dock's unread badge, both of which used to query npd2_comments
// directly (unfiltered by channel), so a vendor-channel message could show up as the "latest
// activity" / trigger a notification on the buyer side even though it's hidden once you open
// the actual workspace. Same per-workspace role + group-membership filter as the single route.
router.post('/sku-workspaces/comments-bulk', requireAuth, async (req, res) => {
  try {
    const { workspaceIds } = req.body
    if (!Array.isArray(workspaceIds) || !workspaceIds.length) return res.json({ comments: [] })

    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size))
    const chunks = chunkArray(workspaceIds, 150)

    const [wsChunks, invChunks, cmChunks] = await Promise.all([
      Promise.all(chunks.map(c => supabase.from('npd2_workspaces')
        .select('id, merchant_member_id, buyer_member_id, supplier_member_id, group_chat_member_ids').in('id', c))),
      Promise.all(chunks.map(c => supabase.from('npd2_invites')
        .select('workspace_id, role').eq('member_id', memberId).eq('status', 'accepted').in('workspace_id', c))),
      Promise.all(chunks.map(c => supabase.from('npd2_comments')
        .select('id, workspace_id, type, body, metadata, reply_to, author_member_id, created_at, channel, role, attachments').in('workspace_id', c))),
    ])

    const wsMap = Object.fromEntries(wsChunks.flatMap(r => r.data || []).map(w => [w.id, w]))
    const inviteRoleMap = Object.fromEntries(invChunks.flatMap(r => r.data || []).map(i => [i.workspace_id, i.role]))
    const allComments = cmChunks.flatMap(r => r.data || [])

    const roleFor = (wsId) => {
      const ws = wsMap[wsId]
      if (!ws) return 'merchant'
      if (ws.buyer_member_id === memberId) return 'buyer'
      if (ws.supplier_member_id === memberId) return 'supplier'
      return inviteRoleMap[wsId] || 'merchant'
    }

    // filterCommentsForRole is called once per single comment below ([c], not the full list),
    // so it can't derive the caller's group-join cutoff itself — precompute it per workspace.
    const groupJoinedAtCache = {}
    const groupJoinedAtFor = (wsId) => {
      if (wsId in groupJoinedAtCache) return groupJoinedAtCache[wsId]
      const milestones = allComments.filter(c =>
        c.workspace_id === wsId && c.channel === 'group' && c.type === 'milestone' &&
        c.author_member_id === memberId && c.metadata?.event === 'group_chat_joined'
      )
      const joinedAt = milestones.length
        ? milestones.reduce((max, c) => c.created_at > max ? c.created_at : max, milestones[0].created_at)
        : null
      groupJoinedAtCache[wsId] = joinedAt
      return joinedAt
    }

    const filtered = allComments.filter(c => {
      const ws = wsMap[c.workspace_id]
      if (!ws) return false
      return filterCommentsForRole([c], roleFor(c.workspace_id), ws, memberId, groupJoinedAtFor(c.workspace_id)).length > 0
    })

    return res.json({ comments: filtered })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/sku-workspaces/:id/comments', requireAuth, upload.array('files', 10), withMasterKeyContext, async (req, res) => {
  const uploadedPaths = []
  try {
    const { body, channel, format } = req.body
    if (!body?.trim() && !(req.files || []).length)
      return res.status(400).json({ error: 'body or attachments required' })
    // The rich-text composer sends format:'html' — sanitized here (the real trust boundary,
    // see sanitizeRichComment above) rather than trusting the client's own sanitization.
    // A plain-text message never gets HTML-escaped/interpreted — it renders as literal text
    // exactly as today, so this only changes behavior for messages actually sent as rich text.
    const isRichText = format === 'html'
    const sanitizedBody = isRichText ? sanitizeRichComment(body || '') : (body || '')
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    // Derive role from workspace
    const { data: ws, error: wsErr } = await supabase
      .from('npd2_workspaces')
      .select('merchant_member_id, buyer_member_id, supplier_member_id, group_chat_member_ids')
      .eq('id', req.params.id)
      .maybeSingle()
    if (wsErr) throw wsErr
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    // resolveCommentRole falls back to 'merchant' for anyone it doesn't recognize, which is
    // fine for labeling an already-authorized comment but was previously being trusted as the
    // authorization check itself — any authenticated member of any org could post into any
    // workspace's buyer/vendor channel and have it misattributed as the merchant. Authorize
    // against resolveWorkspaceActorRole first (returns null, never a false 'merchant'), then
    // use resolveCommentRole only for the display label.
    let actorRole = await resolveWorkspaceActorRole(req.params.id, memberId, ws)
    if (!actorRole) {
      // Not a real participant — fall back to an explicit 'comment' or 'edit' grant from
      // the PLM Security console (npd2_workspace_permissions), if any.
      if (await hasWorkspaceCapability(req.params.id, memberId, ['comment', 'edit'])) {
        actorRole = 'granted'
      } else {
        return res.status(403).json({ error: 'You are not a participant on this workspace' })
      }
    }
    // resolveCommentRole falls back to 'merchant' for anyone it doesn't recognize — including
    // a permission-grant-only commenter, who is by definition none of buyer/supplier/merchant.
    // Good enough for display/channel purposes for now; the comment is still correctly
    // attributed to the real poster via author_member_id below regardless of this label.
    // Master Key is the one case this fallback must NOT apply to: resolveCommentRole has no
    // awareness of it, so without this override a chat message sent under Master Key would
    // get labeled 'merchant' and render in the Activity feed indistinguishable from a real
    // merchant message. Every other write path (field_change/milestone via insertSystemComment)
    // already stores 'super_admin' correctly and is invisible in that same UI — this keeps
    // chat consistent with that.
    const role = actorRole === 'super_admin' ? 'super_admin' : await resolveCommentRole(req.params.id, memberId, ws)

    // Group channel is opt-in per member — merchant always has access, everyone else must be
    // in the list the merchant set via PATCH /sku-workspaces/:id/group-chat-members. Master
    // Key (role === 'super_admin') bypasses this too, same as every other participant gate
    // in this route — otherwise a super admin who isn't an actual invited group member gets
    // a 403 here despite the override being active.
    if (channel === 'group' && role !== 'merchant' && role !== 'super_admin' && !(ws.group_chat_member_ids || []).includes(memberId))
      return res.status(403).json({ error: 'You are not part of this group chat' })

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
        body:             sanitizedBody.trim() || null,
        attachments,
        reply_to:         replyTo,
        metadata:         isRichText ? { format: 'html' } : null,
      }])
      .select().single()
    if (error) throw error

    if (role === 'super_admin') {
      await logAdminAction({
        actorMemberId: memberId, action: 'master_key_post_comment',
        targetType: 'workspace', targetId: req.params.id,
        detail: { channel: channel || 'buyer', comment_id: comment.id },
      })
    } else if (actorRole === 'granted') {
      // Not a real buyer/supplier/merchant — commenting only via a PLM Security console
      // grant (npd2_workspace_permissions). The comment still renders in Activity (labeled
      // 'merchant' by resolveCommentRole's fallback), so record who actually posted it.
      await logAdminAction({
        actorMemberId: memberId, action: 'granted_post_comment',
        targetType: 'workspace', targetId: req.params.id,
        detail: { channel: channel || 'buyer', comment_id: comment.id },
      })
    }

    return res.json({ success: true, comment })
  } catch (err) {
    if (uploadedPaths.length) await supabase.storage.from(NPD_BUCKET).remove(uploadedPaths)
    return res.status(500).json({ error: err.message })
  }
})

// PATCH a previously-sent chat message. Only the original author can edit, and only a plain
// text/rich-text 'comment' (never a milestone/field_change). The full version trail lives in
// metadata.edits — an array of { body, at } for every superseded version, oldest first — while
// the `body` column always holds the current text (so every other reader, the Dock preview,
// unread counts and search keep working unchanged). metadata.edited_at is a convenience marker.
// `removedAttachmentUrls` (optional) lets the author drop an attached image/file from the
// message: the entry is never deleted from the array or from Storage — it's flagged
// `{ removed: true, removedAt }` in place, so it stays visible (struck-through) in the thread's
// history for audit purposes, while WorkspaceModal's Reference Media panel filters it out going
// forward.
// Attachment entries can be a plain URL string, a JSON-stringified '{"url":...}' string, or a
// real { url, name, type } object — see the frontend's normalizeAttachment (src/utils/plmAttachments.js)
// for why all three exist. These mirror it so url/removed lookups here don't silently miss a
// non-object entry the way a naive `a.url`/`a.removed` would.
function attachmentRawObj(a) {
  if (typeof a !== 'string') return a || {}
  try { return JSON.parse(a) || {} } catch { return {} }
}
function attachmentUrl(a) {
  return typeof a === 'string' ? (attachmentRawObj(a).url || a) : (a?.url || '')
}
function attachmentIsRemoved(a) {
  return !!attachmentRawObj(a).removed
}

router.patch('/sku-workspaces/:id/comments/:commentId', requireAuth, async (req, res) => {
  try {
    const { removedAttachmentUrls } = req.body
    // Not required unconditionally — an attachment-only message (no caption) has an empty
    // body by design, and a pure attachment-removal edit on one must still be allowed through.
    // What IS required (checked below, once removals are applied) is that the message ends up
    // with text or at least one live attachment, same rule POST /comments enforces on create.
    const bodyInput = typeof req.body.body === 'string' ? req.body.body : ''

    const member = await resolveMember(req, res)
    if (!member) return

    const { data: comment, error: cErr } = await supabase
      .from('npd2_comments')
      .select('id, workspace_id, author_member_id, body, metadata, attachments, created_at, type')
      .eq('id', req.params.commentId)
      .maybeSingle()
    if (cErr) throw cErr
    if (!comment || comment.workspace_id !== req.params.id)
      return res.status(404).json({ error: 'Comment not found' })
    if (comment.type !== 'comment')
      return res.status(400).json({ error: 'Only chat messages can be edited' })
    if (comment.author_member_id !== member.id)
      return res.status(403).json({ error: 'You can only edit your own messages' })

    const prevMeta  = (comment.metadata && typeof comment.metadata === 'object') ? comment.metadata : {}
    const isRich    = prevMeta.format === 'html'
    const newBody   = isRich ? sanitizeRichComment(bodyInput) : bodyInput

    const now              = new Date().toISOString()
    const removeSet        = new Set(Array.isArray(removedAttachmentUrls) ? removedAttachmentUrls : [])
    const prevAttachments  = Array.isArray(comment.attachments) ? comment.attachments : []
    const newAttachments   = removeSet.size
      ? prevAttachments.map(a => (removeSet.has(attachmentUrl(a)) && !attachmentIsRemoved(a)) ? { ...attachmentRawObj(a), url: attachmentUrl(a), removed: true, removedAt: now } : a)
      : prevAttachments

    if (!newBody.trim() && !newAttachments.some(a => !attachmentIsRemoved(a)))
      return res.status(400).json({ error: 'Message needs text or an attachment' })

    const bodyChanged        = newBody.trim() !== (comment.body || '').trim()
    const attachmentsChanged = JSON.stringify(newAttachments) !== JSON.stringify(prevAttachments)
    if (!bodyChanged && !attachmentsChanged)
      return res.json({ success: true, comment })   // no-op

    const prevEdits = Array.isArray(prevMeta.edits) ? prevMeta.edits : []
    // The version being replaced right now becomes the newest entry in the trail; its
    // timestamp is when it was created (last edit, or the original created_at). Only recorded
    // when the text itself changed — a pure attachment removal doesn't need a text snapshot.
    const newEdits  = bodyChanged
      ? [...prevEdits, { body: comment.body || '', at: prevMeta.edited_at || comment.created_at }]
      : prevEdits
    const newMeta   = { ...prevMeta, edits: newEdits, edited_at: now }

    const { data: updated, error: uErr } = await supabase
      .from('npd2_comments')
      .update({ body: newBody, metadata: newMeta, attachments: newAttachments })
      .eq('id', comment.id)
      .select()
      .single()
    if (uErr) throw uErr

    return res.json({ success: true, comment: updated })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Uploads a single image for the rich-text ("Notes") composer's inline <img> insertion —
// uploaded immediately when the user attaches/captures it (not deferred to Send, unlike
// regular chat attachments above) so it can render as a real hosted image inline while
// still composing. The companion DELETE route below cleans it up if the note gets discarded
// before sending, so nothing orphans in storage.
router.post('/sku-workspaces/:id/inline-image', requireAuth, upload.single('file'), withMasterKeyContext, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' })
    const member = await resolveMember(req, res)
    if (!member) return
    const { data: ws } = await supabase
      .from('npd2_workspaces')
      .select('merchant_member_id, buyer_member_id, supplier_member_id, group_chat_member_ids')
      .eq('id', req.params.id)
      .maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })
    let actorRole = await resolveWorkspaceActorRole(req.params.id, member.id, ws)
    if (!actorRole && !(await hasWorkspaceCapability(req.params.id, member.id, ['comment', 'edit'])))
      return res.status(403).json({ error: 'You are not a participant on this workspace' })

    const safeName    = req.file.originalname.replace(/\s+/g, '_')
    const storagePath = `workspaces/${req.params.id}/attachments/${Date.now()}_${safeName}`
    const { error: upErr } = await supabase.storage
      .from(NPD_BUCKET).upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false })
    if (upErr) throw upErr
    const { data: urlData } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)
    return res.json({ url: urlData.publicUrl, path: storagePath })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Workspace-less inline-image upload — for the Notes editor in the Create-SKU flow, where no
// workspace exists yet. Any authenticated member may upload; the image lands under a catalog
// notes prefix and its URL is embedded in the note (and, on create, mirrored into the SKU's
// spec_images). Same 6MB/one-file limits as the workspace inline-image route.
router.post('/catalog/note-image', requireAuth, upload.single('file'), withMasterKeyContext, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' })
    const member = await resolveMember(req, res)
    if (!member) return
    if (!req.file.mimetype?.startsWith('image/')) return res.status(400).json({ error: 'image files only' })

    const safeName    = (req.file.originalname || 'photo').replace(/\s+/g, '_')
    const storagePath = `catalog/notes/${member.id}/${Date.now()}_${safeName}`
    const { error: upErr } = await supabase.storage
      .from(NPD_BUCKET).upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false })
    if (upErr) throw upErr
    const { data: urlData } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)
    return res.json({ url: urlData.publicUrl, path: storagePath })
  } catch (err) {
    console.error('❌ POST /catalog/note-image:', err)
    return res.status(500).json({ error: err.message })
  }
})

// Deletes an inline image uploaded above but never actually sent (note closed/discarded
// before hitting Send). `path` must live under this workspace's own attachments prefix —
// checked so a caller can't pass an arbitrary storage path from elsewhere.
router.delete('/sku-workspaces/:id/inline-image', requireAuth, async (req, res) => {
  try {
    const { path: storagePath } = req.body
    if (!storagePath || !storagePath.startsWith(`workspaces/${req.params.id}/attachments/`))
      return res.status(400).json({ error: 'Invalid path for this workspace' })
    const member = await resolveMember(req, res)
    if (!member) return
    const { data: ws } = await supabase
      .from('npd2_workspaces')
      .select('merchant_member_id, buyer_member_id, supplier_member_id, group_chat_member_ids')
      .eq('id', req.params.id)
      .maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })
    let actorRole = await resolveWorkspaceActorRole(req.params.id, member.id, ws)
    if (!actorRole && !(await hasWorkspaceCapability(req.params.id, member.id, ['comment', 'edit'])))
      return res.status(403).json({ error: 'You are not a participant on this workspace' })

    await supabase.storage.from(NPD_BUCKET).remove([storagePath])
    return res.json({ ok: true })
  } catch (err) {
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

    const allowed = ['sample_status','target_ready_date','actual_ready_date','sample_delivered_date','ship_mode','tracking_ref','etd','eta','additional_notes']
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
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const allowed = ['sample_status','target_ready_date','actual_ready_date',
                     'sample_delivered_date','ship_mode','tracking_ref','etd','eta','additional_notes','findings',
                     'container_no','vessel_no','courier_company','qa_comments']
    const updates = {}
    for (const field of allowed) {
      if (fields[field] !== undefined) updates[field] = fields[field]
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' })

    // Fetch existing order for "from" values
    const { data: existing } = await supabase
      .from('npd2_sample_orders').select('*').eq('id', req.params.id).single()
    if (!existing) return res.status(404).json({ error: 'Sample order not found' })

    // Previously had no ownership check at all, and trusted `role` straight from the request
    // body for the activity-log attribution (spoofable, same shape as the two bugs fixed
    // earlier this session). Derive both from the actual workspace membership instead.
    const { data: ws } = await supabase
      .from('npd2_workspaces')
      .select('merchant_member_id, buyer_member_id, supplier_member_id')
      .eq('id', existing.workspace_id)
      .maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })
    const role = await resolveWorkspaceActorRole(existing.workspace_id, memberId, ws)
    if (!role) return res.status(403).json({ error: 'Not a participant on this workspace' })

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
    let archivedRejectedUrls = null // fed into the sample_in_process milestone below so the frontend can look up when these specific images were rejected
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
          archivedRejectedUrls = toArchive
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
        {
          event: `sample_${updates.sample_status}`, stage: 'sample',
          ...(archivedRejectedUrls && { rejectedUrls: archivedRejectedUrls }),
        })
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

      // Single-value measurements: one field_change line each. Findings are always stored in
      // cm/kg regardless of the CM/IN or KG/LB display toggle (WorkspaceModal.jsx converts on
      // input), so the activity log — read later with no toggle context at all — needs the
      // unit spelled out explicitly rather than relying on that guarantee being obvious.
      const SINGLE_FIELDS = ['actual_weight', 'inner_qty', 'inner_weight', 'master_qty', 'master_pack_weight_kg', 'cbm']
      const SINGLE_FIELD_UNITS = { actual_weight: ' kg', inner_weight: ' kg', master_pack_weight_kg: ' kg' }
      for (const f of SINGLE_FIELDS) {
        if (!(f in fields.findings)) continue
        const oldVal = oldF[f] ?? ''
        const newVal = newF[f] ?? ''
        if (String(oldVal) !== String(newVal)) {
          const unit = SINGLE_FIELD_UNITS[f] || ''
          const fmtVal = (v) => (v !== '' && v != null) ? `${v}${unit}` : v
          await insertSystemComment2(order.workspace_id, memberId, role, 'field_change', null,
            { field: f, from: fmtVal(oldVal), to: fmtVal(newVal) })
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
        const fmt = vals => vals.some(v => v != null && v !== '') ? `${vals.map(v => v ?? '—').join(' × ')} cm` : ''
        await insertSystemComment2(order.workspace_id, memberId, role, 'field_change', null,
          { field, from: fmt(oldVals), to: fmt(newVals) })
      }

      // Master carton details — now an array (a product can ship across several cartons of
      // different sizes) instead of the flat master_qty/l/w/h fields DIM_GROUPS/SINGLE_FIELDS
      // above still watch for backward compatibility. Formatted into a readable summary here
      // (rather than the raw array) since mapComment's field_change renderer just interpolates
      // whatever "from"/"to" string it's given straight into the activity line.
      if ('master_cartons' in fields.findings) {
        const fmtCartons = (cartons) => (cartons || []).length
          ? cartons.map((c, i) => `Carton ${i + 1}: Qty ${c?.qty || '—'}, ${c?.l || '—'}×${c?.w || '—'}×${c?.h || '—'} cm${c?.weight ? `, ${c.weight}kg` : ''}`).join('; ')
          : ''
        const from = fmtCartons(oldF.master_cartons)
        const to   = fmtCartons(newF.master_cartons)
        if (from !== to) {
          await insertSystemComment2(order.workspace_id, memberId, role, 'field_change', null,
            { field: 'master_cartons', from, to })
        }
      }

      if ('sample_images' in fields.findings) {
        const oldImgs = oldF.sample_images || []
        const newImgs = newF.sample_images || []
        const changed = newImgs.length !== oldImgs.length || newImgs.some((u, i) => u !== oldImgs[i])
        if (changed) {
          // Record which specific image(s) were added/removed — without this the frontend's
          // milestone thumbnail renderer had nothing to show and the activity line was just
          // bare text ("Sample Images Updated"), giving no clue which image it referred to.
          const added   = newImgs.filter(u => !oldImgs.includes(u))
          const removed = oldImgs.filter(u => !newImgs.includes(u))
          await insertSystemComment2(order.workspace_id, memberId, role, 'milestone', null,
            { event: 'sample_images_updated', stage: 'sample', count: newImgs.length, added, removed })
        }
      }

      if ('approved_image' in fields.findings && (oldF.approved_image || null) !== (newF.approved_image || null)) {
        await insertSystemComment2(order.workspace_id, memberId, role, 'milestone', null,
          {
            event: newF.approved_image ? 'production_image_set' : 'production_image_unset',
            stage: 'sample',
            from: oldF.approved_image || null,
            to:   newF.approved_image || null,
          })
      }
    }


    // Log field_change for other field updates
    const logFields = ['target_ready_date','actual_ready_date','additional_notes',
                       'sample_delivered_date','ship_mode','tracking_ref','etd','eta','container_no','vessel_no','courier_company','qa_comments']
    for (const field of logFields) {
      if (updates[field] !== undefined && order.workspace_id) {
        await insertSystemComment2(order.workspace_id, memberId, role, 'field_change', null,
          { field, from: existing?.[field] ?? null, to: updates[field] })
      }
    }

    // Milestone once every field for the chosen shipping mode has actually been filled in —
    // a clear "this is actually ready to ship" signal for both sides in the activity feed,
    // not just a trail of individual field_change lines. Only fires the moment it FIRST
    // becomes complete (checked against `existing`), not on every subsequent edit.
    const SHIP_MODE_FIELDS = {
      air:       ['courier_company', 'tracking_ref', 'etd', 'eta'],
      container: ['container_no', 'vessel_no', 'etd', 'eta'],
    }
    const shipFields = SHIP_MODE_FIELDS[order.ship_mode]
    let workspaceStatus = null
    if (shipFields && order.workspace_id) {
      const isCompleteNow     = shipFields.every(f => !!order[f])
      const wasCompleteBefore = existing?.ship_mode === order.ship_mode && shipFields.every(f => !!existing?.[f])
      if (isCompleteNow && !wasCompleteBefore) {
        await insertSystemComment2(order.workspace_id, memberId, role, 'milestone', null,
          { event: 'shipping_details_complete', note: order.ship_mode === 'air' ? 'Air' : 'Ship' })

        // Move the workspace out of 'sample' into 'sample_shipped' the moment shipping
        // details are first complete — only from 'sample' so this never clobbers a
        // workspace that's paused (on_hold/rejected) or already moved on to production.
        const { data: wsRow } = await supabase
          .from('npd2_workspaces').select('status').eq('id', order.workspace_id).maybeSingle()
        if (wsRow?.status === 'sample') {
          const { error: wsErr } = await supabase
            .from('npd2_workspaces').update({ status: 'sample_shipped' }).eq('id', order.workspace_id)
          if (wsErr) throw wsErr
          workspaceStatus = 'sample_shipped'
        }
      }
    }

    return res.json({ success: true, sampleOrder: order, workspaceStatus })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Vendor's own stock ref — merchant/supplier only, same as the UI's click-to-edit gate
// (WorkspaceModal.jsx), but enforced server-side. This used to be a direct client->Supabase
// write straight to npd2_catalog_skus with only the frontend's onClick check standing between
// a buyer and overwriting it — moved through the backend so the role check can't be bypassed
// via the browser console/API, same reasoning as the org-spoofing fix earlier this session.
router.patch('/catalog-skus/:id/vendor-ref', requireAuth, async (req, res) => {
  try {
    const { workspaceId, vendorSkuRef } = req.body
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })
    const member = await resolveMember(req, res)
    if (!member) return

    const { data: ws } = await supabase
      .from('npd2_workspaces')
      .select('merchant_member_id, buyer_member_id, supplier_member_id, catalog_sku_id')
      .eq('id', workspaceId)
      .maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })
    // The workspace must actually be the one for this SKU — otherwise a caller who is a
    // legitimate participant on SOME workspace could pass an unrelated skuId in the URL.
    if (ws.catalog_sku_id !== req.params.id) return res.status(403).json({ error: 'Workspace does not match this SKU' })

    const role = await resolveWorkspaceActorRole(workspaceId, member.id, ws)
    if (role !== 'merchant' && role !== 'supplier' && role !== 'super_admin')
      return res.status(403).json({ error: 'Only the merchant or vendor can edit the vendor SKU ref' })

    const { data: existing } = await supabase
      .from('npd2_catalog_skus').select('vendor_sku_ref').eq('id', req.params.id).maybeSingle()
    const value = vendorSkuRef || null

    const { error } = await supabase
      .from('npd2_catalog_skus')
      .update({ vendor_sku_ref: value })
      .eq('id', req.params.id)
    if (error) throw error

    if ((existing?.vendor_sku_ref || '') !== (value || '')) {
      await insertSystemComment2(workspaceId, member.id, role, 'field_change', null,
        { field: 'vendor_sku_ref', from: existing?.vendor_sku_ref || '', to: value || '' })
    }

    return res.json({ ok: true, vendor_sku_ref: value })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Auto-generates a vendor stock ref (org prefix + random 5-digit + 2-digit year) and saves
// it, same auth as the PATCH above. Deliberately server-side rather than the frontend
// computing a candidate and PATCHing it — only a single server process can reserve a
// candidate in memory before its DB check completes, closing the race window where two
// concurrent "Auto" clicks (different SKUs) could both see the same unused ref and both
// save it. Mirrors generateAutoCode's reserve-before-await pattern above.
const _vendorPrefixUsed = new Set()
router.post('/catalog-skus/:id/vendor-ref/generate', requireAuth, async (req, res) => {
  try {
    const { workspaceId } = req.body
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })
    const member = await resolveMember(req, res)
    if (!member) return

    const { data: ws } = await supabase
      .from('npd2_workspaces')
      .select('merchant_member_id, buyer_member_id, supplier_member_id, catalog_sku_id, supplier_org_id')
      .eq('id', workspaceId)
      .maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })
    if (ws.catalog_sku_id !== req.params.id) return res.status(403).json({ error: 'Workspace does not match this SKU' })

    const role = await resolveWorkspaceActorRole(workspaceId, member.id, ws)
    if (role !== 'merchant' && role !== 'supplier' && role !== 'super_admin')
      return res.status(403).json({ error: 'Only the merchant or vendor can generate the vendor SKU ref' })

    const orgId = ws.supplier_org_id
    if (!orgId) return res.status(400).json({ error: 'This workspace has no vendor organisation set yet' })

    const { data: org } = await supabase
      .from('organizations').select('prefix, display_name, name').eq('id', orgId).maybeSingle()

    let prefix = org?.prefix?.trim().toUpperCase() || null
    if (!prefix) {
      // No configured prefix — derive one from the org's own name, checked (with an in-memory
      // reservation, same reasoning as the ref generation below) against every OTHER org's
      // prefix so similarly-named vendors don't end up sharing one. Capped at 3 letters.
      const name    = org?.display_name || org?.name || ''
      const letters = name.replace(/[^a-zA-Z]/g, '').toUpperCase()
      const words   = name.split(/\s+/).filter(Boolean)
      const candidates = [...new Set([
        letters.slice(0, 2),
        words.length >= 2 ? (words[0][0] + words[1][0]).toUpperCase() : null,
        letters.slice(0, 3),
        words.length >= 3 ? (words[0][0] + words[1][0] + words[2][0]).toUpperCase() : null,
        letters.length >= 3 ? letters[0] + letters.slice(-2) : null,
      ].filter(c => c && c.length <= 3))]

      for (const cand of candidates) {
        if (_vendorPrefixUsed.has(cand)) continue
        _vendorPrefixUsed.add(cand)
        const { data } = await supabase.from('organizations').select('id').eq('prefix', cand).neq('id', orgId).maybeSingle()
        if (!data) { prefix = cand; break }
        _vendorPrefixUsed.delete(cand)
      }
      while (!prefix) {
        const rand = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')
        if (_vendorPrefixUsed.has(rand)) continue
        _vendorPrefixUsed.add(rand)
        const { data } = await supabase.from('organizations').select('id').eq('prefix', rand).maybeSingle()
        if (!data) prefix = rand
        else _vendorPrefixUsed.delete(rand)
      }
    }

    const year = String(new Date().getFullYear()).slice(-2)
    let ref
    while (true) {
      const num = String(Math.floor(1 + Math.random() * 99999)).padStart(5, '0')
      const candidate = `${prefix}${num}${year}`
      if (_vendorSkuRefUsed.has(candidate)) continue
      _vendorSkuRefUsed.add(candidate)
      const [{ data: existingCatalog }, { data: existingSku }] = await Promise.all([
        supabase.from('npd2_catalog_skus').select('id').eq('vendor_sku_ref', candidate).maybeSingle(),
        supabase.from('skus').select('id').eq('vendor_sku_ref', candidate).maybeSingle(),
      ])
      if (!existingCatalog && !existingSku) { ref = candidate; break }
      _vendorSkuRefUsed.delete(candidate)
    }

    const { data: existingRow } = await supabase
      .from('npd2_catalog_skus').select('vendor_sku_ref').eq('id', req.params.id).maybeSingle()

    const { error } = await supabase
      .from('npd2_catalog_skus')
      .update({ vendor_sku_ref: ref })
      .eq('id', req.params.id)
    if (error) throw error

    await insertSystemComment2(workspaceId, member.id, role, 'field_change', null,
      { field: 'vendor_sku_ref', from: existingRow?.vendor_sku_ref || '', to: ref })

    return res.json({ ok: true, vendor_sku_ref: ref })
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


// Merchant picks exactly which invited buyer(s)/supplier(s) can see and post in the
// workspace's shared "Group Chat" tab (channel = 'group') — not a blanket on/off, since a
// workspace can have multiple accepted buyer/supplier contacts via multi-invite.
router.patch('/sku-workspaces/:id/group-chat-members', requireAuth, async (req, res) => {
  const { id } = req.params
  const { memberIds } = req.body
  if (!Array.isArray(memberIds)) return res.status(400).json({ error: 'memberIds must be an array' })

  try {
    const member = await resolveMember(req, res)
    if (!member) return

    const { data: ws, error: wsErr } = await supabase
      .from('npd2_workspaces')
      .select('merchant_member_id, buyer_member_id, supplier_member_id, group_chat_member_ids')
      .eq('id', id)
      .maybeSingle()
    if (wsErr) throw wsErr
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })
    // Any current participant of this workspace can manage Group Chat membership — the
    // merchant, a paired peer merchant (merchant_access_pairs), the buyer/supplier of
    // record, an accepted co-buyer/co-supplier, or a Master Key super-admin.
    // resolveWorkspaceActorRole returns non-null for all of them, null for an outsider.
    const actorRole = await resolveWorkspaceActorRole(id, member.id, ws)
    if (!actorRole)
      return res.status(403).json({ error: 'You are not a participant on this workspace' })

    // Restrict to people actually on this workspace — the primary buyer/supplier plus any
    // accepted co-buyer/co-supplier invites — so the array can't be seeded with unrelated ids.
    const { data: invites, error: invErr } = await supabase
      .from('npd2_invites')
      .select('member_id, role')
      .eq('workspace_id', id)
      .eq('status', 'accepted')
    if (invErr) throw invErr

    const roleForMember = (mid) => {
      if (mid === ws.buyer_member_id) return 'buyer'
      if (mid === ws.supplier_member_id) return 'supplier'
      return (invites || []).find(i => i.member_id === mid)?.role || null
    }

    const eligible = new Set([
      ws.buyer_member_id, ws.supplier_member_id,
      ...(invites || []).map(i => i.member_id),
    ].filter(Boolean))
    const cleanIds = [...new Set(memberIds)].filter(mid => eligible.has(mid))
    const previouslyIn = new Set(ws.group_chat_member_ids || [])
    const newlyAdded = cleanIds.filter(mid => !previouslyIn.has(mid))
    const removed    = [...previouslyIn].filter(mid => !cleanIds.includes(mid))

    const { data: updated, error } = await supabase
      .from('npd2_workspaces')
      .update({ group_chat_member_ids: cleanIds })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error

    // Post a "joined Group Chat" milestone for whoever was newly added, scoped to the group
    // channel only (never leaks into Buyer/Vendor Activity — those filter system comments in
    // by type alone, but group-channel ones are only ever pulled in via the channel === 'group'
    // check, so this stays exactly where it happened).
    //
    // Guarded against a duplicate: `previouslyIn` above is read-then-write with no locking, so
    // two PATCH requests firing close together (e.g. a slow first request making a user think
    // their click didn't register, prompting a second one) can both read the same "not yet
    // added" state and each independently decide this member is newly added. Skip the insert if
    // a "joined" milestone for this exact member already landed in the last few seconds.
    const recentCutoff = new Date(Date.now() - 15_000).toISOString()
    // Returned to the caller (and broadcast by them over the group realtime channel) so the
    // "joined Group Chat" line shows up live for everyone watching Group Chat right now —
    // inserting the row alone doesn't push anything to connected clients on its own, since
    // nothing here is subscribed to raw Postgres change events for npd2_comments inserts.
    // Name of whoever ran this request — for the "X added to Group Chat by Y" line. Only
    // needed when someone other than the caller is being added (self-joins say "joined").
    let adderName = null
    if (newlyAdded.some(mid => mid !== member.id)) {
      const { data: adder } = await supabase
        .from('organization_members').select('full_name').eq('id', member.id).maybeSingle()
      adderName = adder?.full_name || null
    }

    const newMilestones = []
    for (const mid of newlyAdded) {
      const memberRole = roleForMember(mid)
      if (!memberRole) continue
      const { data: recentJoin } = await supabase
        .from('npd2_comments')
        .select('id')
        .eq('workspace_id', id)
        .eq('channel', 'group')
        .eq('type', 'milestone')
        .eq('author_member_id', mid)
        .gte('created_at', recentCutoff)
        .contains('metadata', { event: 'group_chat_joined' })
        .limit(1)
      if (recentJoin?.length) continue
      const selfJoin = mid === member.id
      const { data: milestone, error: mErr } = await supabase.from('npd2_comments').insert([{
        workspace_id: id, author_member_id: mid, role: memberRole,
        type: 'milestone', channel: 'group',
        body: selfJoin ? 'joined Group Chat' : 'was added to Group Chat',
        metadata: selfJoin
          ? { event: 'group_chat_joined' }
          : { event: 'group_chat_joined', added_by: member.id, added_by_name: adderName },
      }]).select().single()
      if (!mErr && milestone) newMilestones.push(milestone)
    }

    // Mirror of the above for anyone taken out of the group — a "left Group Chat" line so the
    // rest of the group sees who's no longer in it. Same 15s de-dup guard against a double PATCH.
    for (const mid of removed) {
      const memberRole = roleForMember(mid)
      if (!memberRole) continue
      const { data: recentLeave } = await supabase
        .from('npd2_comments')
        .select('id')
        .eq('workspace_id', id)
        .eq('channel', 'group')
        .eq('type', 'milestone')
        .eq('author_member_id', mid)
        .gte('created_at', recentCutoff)
        .contains('metadata', { event: 'group_chat_left' })
        .limit(1)
      if (recentLeave?.length) continue
      const { data: milestone, error: mErr } = await supabase.from('npd2_comments').insert([{
        workspace_id: id, author_member_id: mid, role: memberRole,
        type: 'milestone', channel: 'group', body: 'left Group Chat',
        metadata: { event: 'group_chat_left' },
      }]).select().single()
      if (!mErr && milestone) newMilestones.push(milestone)
    }

    res.json({ workspace: updated, milestones: newMilestones })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/sku-sample-orders/:id/images', requireAuth, upload.array('images', 10), withMasterKeyContext, async (req, res) => {
  try {
    const { workspaceId } = req.body
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })
    const files = req.files || []
    if (!files.length) return res.status(400).json({ error: 'No images provided' })

    // Previously had no resolveMember call at all — memberId came straight from the request
    // body, trusted both for authorization (there wasn't any) and for the milestone's
    // attribution. This endpoint is merchant-only from the UI, so enforce that server-side too.
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const { data: ws } = await supabase
      .from('npd2_workspaces')
      .select('merchant_member_id, buyer_member_id, supplier_member_id')
      .eq('id', workspaceId)
      .maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })
    const actorRole = await resolveWorkspaceActorRole(workspaceId, memberId, ws)
    if (actorRole !== 'merchant' && actorRole !== 'super_admin')
      return res.status(403).json({ error: 'Only the merchant can upload sample images' })

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
    const { data: order, error: fetchErr } = await supabase
      .from('npd2_sample_orders').select('findings').eq('id', req.params.id).single()
    if (fetchErr) throw fetchErr
    const existing = order?.findings?.sample_images || []
    const findings = { ...(order?.findings || {}), sample_images: [...existing, ...uploaded] }

    const { error: updateErr } = await supabase
      .from('npd2_sample_orders').update({ findings }).eq('id', req.params.id)
    if (updateErr) throw updateErr

    // Only merchants can reach this endpoint from the UI — no buyer/supplier variant to derive role for.
    if (memberId) {
      await insertSystemComment2(workspaceId, memberId, 'merchant', 'milestone', null,
        { event: 'sample_images_updated', stage: 'sample', count: uploaded.length, urls: uploaded })
    }

    return res.json({ success: true, urls: uploaded })
  } catch (err) {
    console.error('❌ POST /plm/sku-sample-orders/:id/images:', err)
    return res.status(500).json({ error: err.message })
  }
})

router.post('/sku-workspaces/:id/revision', requireAuth, async (req, res) => {
  try {
    const { note } = req.body
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const { data: ws } = await supabase
      .from('npd2_workspaces').select('id, status, buyer_brief, buyer_member_id, supplier_member_id, merchant_member_id')
      .eq('id', req.params.id).maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    // Only the buyer (or a Master Key super admin acting on their behalf) can request
    // a revision — this matches the frontend, which only ever shows this action to
    // role === 'buyer'; merchant/supplier never trigger it
    const actorRole = await resolveWorkspaceActorRole(req.params.id, memberId, ws)
    if (actorRole !== 'buyer' && actorRole !== 'super_admin')
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
      .from('npd2_workspaces').select('id, buyer_brief, buyer_member_id, supplier_member_id, merchant_member_id')
      .eq('id', req.params.id).maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    // Only the buyer (or a Master Key super admin acting on their behalf) can accept
    // a sample — matches the frontend, which only ever shows this action to role === 'buyer'
    const actorRole = await resolveWorkspaceActorRole(req.params.id, memberId, ws)
    if (actorRole !== 'buyer' && actorRole !== 'super_admin')
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
      .from('npd2_workspaces').select('id, buyer_brief, buyer_member_id, supplier_member_id, merchant_member_id')
      .eq('id', req.params.id).maybeSingle()
    if (!ws) return res.status(404).json({ error: 'Workspace not found' })

    // Only the buyer (or a Master Key super admin acting on their behalf) can reject
    // a sample — matches the frontend, which only ever shows this action to role === 'buyer'
    const actorRole = await resolveWorkspaceActorRole(req.params.id, memberId, ws)
    if (actorRole !== 'buyer' && actorRole !== 'super_admin')
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
    if (actorRole !== 'merchant' && actorRole !== 'super_admin')
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
// Previously had no requireAuth at all — memberId came straight from the request body,
// trusted both for authorization (there wasn't any) and for the created_by/created_by_
// member_id audit trail stamped on the PO and every SKU it creates. Anyone able to reach
// this endpoint could create Sample POs and production SKUs claiming to be any member.
// Now resolves the real member from the session and requires them to actually be the
// merchant (or super_admin) on every workspace in the batch, same as every other
// merchant-only PLM action in this file.
router.post('/purchase-orders/sample', requireAuth, async (req, res) => {
  let filePath = null

  try {
    const { workspaceIds, poNumber } = req.body
    if (!workspaceIds?.length || !poNumber?.trim())
      return res.status(400).json({ error: 'workspaceIds, poNumber required' })
    const member = await resolveMember(req, res)
    if (!member) return
    const memberId = member.id

    const trimmedPoNumber = poNumber.trim()
    const safePoNumber    = trimmedPoNumber.replace(/\//g, '-')

    const parseBrief = (raw) => {
      if (!raw) return {}
      if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return {} } }
      return raw
    }

    // Master carton details can now be an array (findings.master_cartons: [{qty,l,w,h,weight}])
    // — a product shipped across several cartons of different sizes. The skus table's
    // master_pack_* columns are single flat values, so this collapses that array down:
    // dimensions come from the first carton (there's no meaningful way to sum L×W×H across
    // differently-sized boxes, and master_pack_cbm below already carries the correct combined
    // total via findings.cbm), weight sums across every carton since total shipped weight is
    // what actually matters downstream. Falls back to the pre-existing flat fields for any
    // sample order saved before this feature existed.
    const collapseMasterCartons = (findings) => {
      const cartons = Array.isArray(findings?.master_cartons) && findings.master_cartons.length
        ? findings.master_cartons
        : (findings?.master_l || findings?.master_w || findings?.master_h || findings?.master_qty || findings?.master_pack_weight_kg)
          ? [{ qty: findings.master_qty, l: findings.master_l, w: findings.master_w, h: findings.master_h, weight: findings.master_pack_weight_kg }]
          : []
      const first = cartons[0] || {}
      // Each carton's own qty is how many separate identical physical boxes of those dims/
      // weight actually exist (confirmed against real data — CBM already multiplies by qty
      // on this same basis), so total weight has to multiply too: 2 boxes at 9kg each is
      // 18kg, not 9kg. Previously summed each entry's weight once regardless of its qty,
      // undercounting total shipped weight for any carton entry with qty > 1.
      const totalWeight = cartons.reduce((sum, c) => sum + (parseFloat(c?.weight) || 0) * (parseFloat(c?.qty) || 1), 0)
      return { l: first.l ?? null, w: first.w ?? null, h: first.h ?? null, weight: totalWeight || null, qty: first.qty ?? null }
    }

    // 1. Fetch workspaces + latest sample orders
    const [{ data: workspaces, error: wsErr }, { data: allOrders }] = await Promise.all([
      supabase.from('npd2_workspaces')
        .select('id, buyer_ref, buyer_brief, buyer_org_id, supplier_org_id, catalog_sku_id, vendor_stock_number, merchant_member_id, buyer_member_id, supplier_member_id')
        .in('id', workspaceIds),
      supabase.from('npd2_sample_orders')
        .select('*').in('workspace_id', workspaceIds)
        .order('created_at', { ascending: false }),
    ])
    if (wsErr) throw wsErr
    if (!workspaces?.length || workspaces.length !== workspaceIds.length)
      return res.status(404).json({ error: 'One or more workspaces not found' })

    // Sample PO creation is merchant-only — verify the caller actually is the merchant (or
    // super_admin) on EVERY workspace in the batch, not just some of them.
    for (const w of workspaces) {
      const actorRole = await resolveWorkspaceActorRole(w.id, memberId, w)
      if (actorRole !== 'merchant' && actorRole !== 'super_admin')
        return res.status(403).json({ error: 'Only the merchant can create a Sample PO' })
    }

    const soMap = {}
    for (const so of (allOrders || []))
      if (!soMap[so.workspace_id]) soMap[so.workspace_id] = so

    // Category + vendor's own SKU ref live on the source catalog SKU, not the workspace/
    // brief/findings — fetched once for every workspace's catalog_sku_id and looked up by id
    // below when building each skus insert.
    const catalogSkuIds = [...new Set(workspaces.map(w => w.catalog_sku_id).filter(Boolean))]
    let catalogSkuMap = {}
    if (catalogSkuIds.length) {
      const { data: catalogSkus } = await supabase
        .from('npd2_catalog_skus')
        .select('id, category_id, vendor_sku_ref')
        .in('id', catalogSkuIds)
      for (const c of (catalogSkus || [])) catalogSkuMap[c.id] = c
    }

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
      const ws         = workspaces.find(w => w.id === line.workspaceId)
      const brief      = parseBrief(ws.buyer_brief)
      const findings   = line.findings
      const master     = collapseMasterCartons(findings)
      const catalogSku = catalogSkuMap[ws.catalog_sku_id] || {}
      // Inner pack's own volume — one inner box's L×W×H, not multiplied by inner_qty (that's
      // a count of what's inside it, not a repetition of the box itself). Same reasoning as
      // master_pack_cbm/item_cbm never multiplying by their own qty fields.
      const innerL = parseFloat(findings.inner_l), innerW = parseFloat(findings.inner_w), innerH = parseFloat(findings.inner_h)
      const innerPackCbm = (innerL && innerW && innerH) ? ((innerL * innerW * innerH) / 1_000_000).toFixed(4) : null
      const vendorSkuRef = catalogSku.vendor_sku_ref || await generateVendorSkuRef()
      // Full multi-carton breakdown — only populated when there's actually more than one
      // carton (master_pack_length/breadth/height above already cover the single-carton
      // case with real numeric columns; this jsonb column exists purely for the case those
      // 3 flat columns structurally can't represent). Keys spelled out to match this table's
      // own naming (breadth, not w) rather than the app's internal findings shape.
      const allCartons = Array.isArray(findings?.master_cartons) ? findings.master_cartons : []
      const masterPackCartons = allCartons.length > 1
        ? allCartons.map(c => ({ qty: c?.qty ?? null, length: c?.l ?? null, breadth: c?.w ?? null, height: c?.h ?? null, weight: c?.weight ?? null }))
        : null

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
  item_measure_unit:   'cm',
  item_weight_unit:    'kgs',
  inner_pack_length:   findings.inner_l        || null,
  inner_pack_breadth:  findings.inner_w        || null,
  inner_pack_height:   findings.inner_h        || null,
  inner_pack_qty:      findings.inner_qty      || null,
  inner_pack_weight_kg: findings.inner_weight   || null,
  inner_pack_weight_unit: 'kgs',
  inner_pack_cbm:      innerPackCbm,
  inner_pack_measure_unit: 'cm',
  master_pack_length:  master.l                || null,
  master_pack_breadth: master.w                || null,
  master_pack_height:  master.h                || null,
  master_pack_qty:     master.qty              || null,
  master_pack_weight_kg: master.weight         || null,
  master_pack_weight_unit: 'kgs',
  master_pack_cbm:     findings.cbm            || null,
  master_pack_measure_unit: 'cm',
  master_pack_cartons: masterPackCartons,
  primary_base_material: brief.material        || null,
  image_url:            findings.approved_image || brief.image_url || null,
  category_id:          catalogSku.category_id || null,
  vendor_sku_ref:       vendorSkuRef,
  created_by_member_id: memberId,
  buyer_org_id:        ws.buyer_org_id         || null,
  source_workspace_id: ws.id,
  sample_status:       'Open',
}).select().single()

      if (skuErr) throw skuErr
      productionSkuByWorkspace[line.workspaceId] = sku.id

      // Only when there was no real vendor ref to carry over — a genuinely-sourced ref
      // shouldn't spam the activity feed, but an auto-generated stand-in is worth surfacing
      // since it's not something the vendor actually provided.
      if (!catalogSku.vendor_sku_ref) {
        await insertSystemComment2(ws.id, memberId, 'merchant', 'field_change', null,
          { field: 'vendor_sku_ref', from: '', to: vendorSkuRef })
      }

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
router.post('/supplier-catalog/skus', requireAuth, upload.single('image'), withMasterKeyContext, async (req, res) => {
  try {
    const { season, categoryId, description, material, finish,
            weight, l, w, h, measurement, tempSkuRef, mode,
            originalPrice, originalCurrency, notesHtml, specImages,
            supplierOrgId: clientSupplierOrgId, supplier: clientSupplierName, buyerOrgId } = req.body

    if (!req.file) return res.status(400).json({ error: 'image required' })

    const [member, { data: cat }] = await Promise.all([
      resolveMember(req, res, 'id, organization_id, organizations(display_name, name, type)'),
      categoryId
        ? supabase.from('categories').select('name').eq('id', categoryId).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    if (!member) return

    // A vendor/supplier caller can only ever upload under their own org — never trust the
    // client-submitted supplierOrgId/supplier for them, same fix as /supplier-catalog/upload
    // and /supplier-catalog/skus/bulk.
    const isSupplierCaller = member.organizations?.type === 'supplier'
    const supplierOrgId = isSupplierCaller ? member.organization_id : clientSupplierOrgId
    const supplierName  = isSupplierCaller ? (member.organizations?.display_name || member.organizations?.name) : clientSupplierName
    // Resolved after member so a buyer caller's own org is used, not whatever they submitted.
    const isBuyerCallerHere = member.organizations?.type === 'buyer'
    const resolvedBuyerOrgId = isBuyerCallerHere ? member.organization_id : buyerOrgId
    const { data: buyerOrgRow } = resolvedBuyerOrgId
      ? await supabase.from('organizations').select('display_name, name').eq('id', resolvedBuyerOrgId).maybeSingle()
      : { data: null }

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
        for_buyer_org_id:     resolvedBuyerOrgId || null,
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
          original_price:    originalPrice ? parseFloat(originalPrice) : null,
          original_currency: originalCurrency || null,
          is_archived:       false,
          image_processing:  true,
          ...buildSkuNoteFields({ notesHtml, specImages }, member?.id),
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
router.post('/supplier-catalog/skus/bulk', requireAuth, upload.array('images'), withMasterKeyContext, async (req, res) => {
  try {
    const { season, supplierOrgId: clientSupplierOrgId, supplier: clientSupplierName, attributes: attributesRaw, mode, buyerOrgId } = req.body
    const attributes = JSON.parse(attributesRaw || '[]')

    if (!req.files?.length) return res.status(400).json({ error: 'At least one image required' })
    if (!buyerOrgId)        return res.status(400).json({ error: 'buyerOrgId required' })
    if (!season?.trim())    return res.status(400).json({ error: 'season required' })

    const { data: member } = await supabase
      .from('organization_members')
      .select('id, organization_id, organizations(display_name, name, type)')
      .eq('user_id', req.user.id).maybeSingle()

    const orgName    = member?.organizations?.display_name || member?.organizations?.name || 'manual'
    const orgSlug    = orgName.replace(/\s+/g, '_').toLowerCase()
    const seasonSlug = (season || 'unknown').replace(/\s+/g, '_').toLowerCase()

    // A vendor/supplier caller can only ever upload under their own org — never trust the
    // client-submitted supplierOrgId/supplier for them (see /supplier-catalog/upload's
    // identical fix for why). A merchant's submitted vendor choice is still honoured.
    const isSupplierCaller = member?.organizations?.type === 'supplier'
    const supplierOrgId = isSupplierCaller ? member.organization_id : clientSupplierOrgId
    const supplierName  = isSupplierCaller ? orgName : clientSupplierName
    if (!supplierOrgId) return res.status(400).json({ error: 'supplierOrgId required' })
    const isBuyerCallerHere = member?.organizations?.type === 'buyer'
    const resolvedBuyerOrgId = isBuyerCallerHere ? member.organization_id : buyerOrgId

    const { data: buyerOrgRow } = resolvedBuyerOrgId
      ? await supabase.from('organizations').select('display_name, name').eq('id', resolvedBuyerOrgId).maybeSingle()
      : { data: null }

    const { data: uploadRow, error: uploadErr } = await supabase
      .from('npd2_catalog_uploads')
      .insert({
        created_by_member_id: member?.id    || null,
        supplier_org_id:      supplierOrgId || null,
        supplier:             supplierName  || null,
        for_buyer_org_id:     resolvedBuyerOrgId || null,
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
            original_price:    a.originalPrice ? parseFloat(a.originalPrice) : null,
            original_currency: a.originalCurrency || null,
            is_archived:       false,
            image_processing:  mode !== 'existing',
            ...buildSkuNoteFields(a, member?.id),
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
  return vedeeo.clip(sku.description || sku.auto_code || 'Video call', 120)
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
        if (accepted?.roomId && !(await vedeeo.roomIsLive(accepted.roomId))) {
          return res.status(410).json({ error: 'This video call has ended. Start a new call.' })
        }
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

    await vedeeo.cancelOpenInvites(id, memberId)

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
    if (accepted?.roomId && !(await vedeeo.roomIsLive(accepted.roomId))) {
      await vedeeo.deleteRoom(accepted.roomId)
      await clearVideoInvite(id)
      return res.status(410).json({ error: 'This video call has ended. Start a new call.' })
    }
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
    const productName = sku.description || sku.auto_code || 'Workspace'
    const workspaceLabel = sku.auto_code || id.slice(0, 8)
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
        const invite = await vedeeo.getInvite(resolvedId)
        if (invite?.roomId) await vedeeo.deleteRoom(invite.roomId)
      } catch {
        // invite already gone
      }
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