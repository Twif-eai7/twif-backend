// 'use strict';
// require('dotenv').config()

// const AdmZip          = require('adm-zip')
// const { createCanvas, loadImage } = require('canvas')
// const pdfjsLib        = require('pdfjs-dist/legacy/build/pdf')
// const { GoogleGenAI } = require('@google/genai')
// const supabase        = require('../supabaseClient')
// const pLimit          = require('p-limit')

// const ai                = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
// const NPD_BUCKET        = 'npd'
// const SLIDE_CONCURRENCY = parseInt(process.env.SLIDE_CONCURRENCY || '20')

// const UPLOAD_ID   = process.env.JOB_UPLOAD_ID
// const EXT         = process.env.JOB_EXT
// const CUSTOMER_ID = process.env.JOB_CUSTOMER_ID

// if (!UPLOAD_ID) {
//   console.error('❌ JOB_UPLOAD_ID not set — exiting')
//   process.exit(1)
// }

// // ═══════════════════════════════════════════════════════════
// // RETRY HELPER
// // ═══════════════════════════════════════════════════════════

// const withRetry = async (fn, retries = 2, delayMs = 1500) => {
//   for (let i = 0; i <= retries; i++) {
//     try {
//       return await fn()
//     } catch (err) {
//       if (i === retries) throw err
//       const wait = delayMs * (i + 1)
//       console.warn(`  ⚠️ Attempt ${i + 1} failed: ${err.message} — retry in ${wait}ms`)
//       await new Promise(r => setTimeout(r, wait))
//     }
//   }
// }

// // ═══════════════════════════════════════════════════════════
// // RESIZE
// // ═══════════════════════════════════════════════════════════

// const resizeForGemini = async (buffer, mimeType, maxDim = 1200) => {
//   try {
//     const img   = await loadImage(buffer)
//     const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
//     if (scale >= 1) return { buffer, mimeType }

//     const w      = Math.round(img.width  * scale)
//     const h      = Math.round(img.height * scale)
//     const canvas = createCanvas(w, h)
//     const ctx    = canvas.getContext('2d')
//     ctx.fillStyle = '#ffffff'
//     ctx.fillRect(0, 0, w, h)
//     ctx.drawImage(img, 0, 0, w, h)

//     return {
//       buffer:   canvas.toBuffer('image/jpeg', { quality: 0.92 }),
//       mimeType: 'image/jpeg',
//     }
//   } catch {
//     return { buffer, mimeType }
//   }
// }

// // ═══════════════════════════════════════════════════════════
// // BACKGROUND REMOVAL
// // ═══════════════════════════════════════════════════════════

// const removeBackground = async (buffer, mimeType, description = '') => {
//   const isMirror = /mirror|glass|transparent|crystal|acrylic/i.test(description)

//   const prompt = isMirror
//     ? `Mirror/glass product. Remove background outside the frame only.
// Keep frame and reflective surface completely intact. White background. Return image only.`
//     : `Remove the background from this product image completely.
// Keep ALL product details: thin legs, wires, handles, fabric texture, fine edges,
// semi-transparent parts, shadows cast BY the product (keep subtle drop shadow if present).
// Do NOT crop or cut off any part of the product — ensure the ENTIRE product is visible.
// Pure white (#FFFFFF) background. Product fully visible and centred.
// Return image only.`

//   const { buffer: resized, mimeType: resizedMime } = await resizeForGemini(buffer, mimeType, 1600)

//   for (let attempt = 1; attempt <= 3; attempt++) {
//     try {
//       const response = await withRetry(() => ai.models.generateContent({
//         model:    'gemini-2.5-flash-image',
//         contents: {
//           parts: [
//             { inlineData: { data: resized.toString('base64'), mimeType: resizedMime } },
//             { text: prompt },
//           ],
//         },
//         config: { responseModalities: ['IMAGE', 'TEXT'] },
//       }), 2, 2000)

//       for (const part of response.candidates[0].content.parts) {
//         if (part.inlineData) {
//           const result = Buffer.from(part.inlineData.data, 'base64')
//           if (result.length < 5000) {
//             console.warn(`  ⚠️ Gemini BG removal attempt ${attempt} — blank result, retrying...`)
//             break
//           }

//           try {
//             const outImg = await loadImage(result)
//             const inImg  = await loadImage(resized)
//             if (outImg.width < inImg.width * 0.5 || outImg.height < inImg.height * 0.5) {
//               console.warn(`  ⚠️ BG removal attempt ${attempt} — output too small, retrying...`)
//               break
//             }
//           } catch {}

//           console.log(`  ✓ Gemini removed BG (attempt ${attempt})`)
//           return { buffer: result, mimeType: part.inlineData.mimeType || 'image/png' }
//         }
//       }
//     } catch (err) {
//       console.warn(`  ⚠️ Gemini BG removal attempt ${attempt} failed: ${err.message}`)
//       if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt))
//     }
//   }

//   console.warn('  ⚠️ Gemini BG removal failed after 3 attempts — using original')
//   return { buffer, mimeType }
// }

// // ═══════════════════════════════════════════════════════════
// // PAD TO SQUARE
// // ═══════════════════════════════════════════════════════════

// const padToSquare = async (buffer, mimeType, paddingPercent = 8) => {
//   try {
//     const img  = await loadImage(buffer)
//     const size = Math.max(img.width, img.height)
//     const pad  = Math.round(size * (paddingPercent / 100))
//     const out  = size + pad * 2
//     const canvas = createCanvas(out, out)
//     const ctx    = canvas.getContext('2d')
//     ctx.fillStyle = '#ffffff'
//     ctx.fillRect(0, 0, out, out)
//     const x = Math.round((out - img.width)  / 2)
//     const y = Math.round((out - img.height) / 2)
//     ctx.drawImage(img, x, y)
//     return { buffer: canvas.toBuffer('image/png'), mimeType: 'image/png' }
//   } catch {
//     return { buffer, mimeType }
//   }
// }

// // ═══════════════════════════════════════════════════════════
// // LOGO FILTER (pixel dimensions)
// // ═══════════════════════════════════════════════════════════

// const filterLogoImages = async (images) => {
//   if (images.length <= 1) return images

//   const withDims = await Promise.all(images.map(async img => {
//     try {
//       const loaded = await loadImage(img.buffer)
//       return { ...img, width: loaded.width, height: loaded.height }
//     } catch {
//       return { ...img, width: 0, height: 0 }
//     }
//   }))

//   // Logos/watermarks are typically small — keep only images >= 200x200px
//   const filtered = withDims.filter(img => img.width >= 200 && img.height >= 200)
//   return filtered.length > 0 ? filtered : images  // fallback to all if everything filtered
// }

// // ═══════════════════════════════════════════════════════════
// // PPTX EXTRACTION
// // ═══════════════════════════════════════════════════════════

// const extractSlidesFromPptx = async (fileBuffer) => {   // ← add async
//   const zip      = new AdmZip(fileBuffer)
//   const entryMap = {}
//   for (const e of zip.getEntries()) entryMap[e.entryName.toLowerCase()] = e
//   const getEntry = name => entryMap[name.toLowerCase()]

//   const slideEntries = zip.getEntries()
//     .filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
//     .sort((a, b) => {
//       const n = s => parseInt(s.entryName.match(/(\d+)\.xml$/)[1])
//       return n(a) - n(b)
//     })

//   const slides = []

//   for (let idx = 0; idx < slideEntries.length; idx++) {
//     const slideEntry = slideEntries[idx]
//     const slideNum   = parseInt(slideEntry.entryName.match(/(\d+)\.xml$/)[1])
//     const xml        = slideEntry.getData().toString('utf8')
//     const lines      = (xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [])
//       .map(m => m.replace(/<[^>]+>/g, '').trim()).filter(Boolean)

//     const relEntry = getEntry(`ppt/slides/_rels/slide${slideNum}.xml.rels`)
//     const images   = []

//     if (relEntry) {
//       const relXml   = relEntry.getData().toString('utf8')
//       const relRegex = /Type="[^"]*\/image"[^>]*Target="([^"]+)"/gi
//       let m
//       while ((m = relRegex.exec(relXml)) !== null) {
//         const filename = m[1].replace(/^.*\//, '')
//         const ext      = filename.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg'
//         if (['emf','wmf','emz','wmz'].includes(ext)) continue
//         const mediaEntry = getEntry(`ppt/media/${filename}`)
//         if (!mediaEntry) continue
//         const mimeType = ext === 'png'  ? 'image/png'
//                        : ext === 'gif'  ? 'image/gif'
//                        : ext === 'webp' ? 'image/webp'
//                        : 'image/jpeg'
//         images.push({ buffer: mediaEntry.getData(), mimeType, name: filename })
//       }
//     }

//     if (images.length > 0) {
//       const filteredImages = await filterLogoImages(images)  // ← filter logos
//       slides.push({ slideIndex: idx, slideNum, lines, images: filteredImages, isPdf: false })
//     }
//   }

//   return slides
// }

// // ═══════════════════════════════════════════════════════════
// // PDF EXTRACTION
// // ═══════════════════════════════════════════════════════════

// const extractSlidesFromPdf = async (fileBuffer) => {
//   const pdf    = await pdfjsLib.getDocument({ data: new Uint8Array(fileBuffer) }).promise
//   const slides = []
//   console.log(`📄 PDF: ${pdf.numPages} pages`)

//   for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
//     const page     = await pdf.getPage(pageNum)
//     const viewport = page.getViewport({ scale: 2.5 })
//     const canvas   = createCanvas(viewport.width, viewport.height)
//     const ctx      = canvas.getContext('2d')
//     ctx.fillStyle  = '#ffffff'
//     ctx.fillRect(0, 0, viewport.width, viewport.height)
//     await page.render({ canvasContext: ctx, viewport }).promise

//     const textContent = await page.getTextContent()
//     const lines = textContent.items.map(i => i.str?.trim()).filter(Boolean)

//     let embeddedImages = []
//     try {
//       const ops      = await page.getOperatorList()
//       const imgNames = new Set()
//       for (let i = 0; i < ops.fnArray.length; i++) {
//         if (ops.fnArray[i] === 85) imgNames.add(ops.argsArray[i][0])
//       }
//       for (const imgName of imgNames) {
//         try {
//           const imgObj = await page.objs.get(imgName)
//           if (!imgObj?.data || imgObj.width < 100 || imgObj.height < 100) continue
//           const ic  = createCanvas(imgObj.width, imgObj.height)
//           const ict = ic.getContext('2d')
//           const id  = ict.createImageData(imgObj.width, imgObj.height)
//           const src = imgObj.data, dst = id.data, px = imgObj.width * imgObj.height
//           if      (src.length === px * 4) dst.set(src)
//           else if (src.length === px * 3) {
//             for (let p = 0; p < px; p++) {
//               dst[p*4]=src[p*3]; dst[p*4+1]=src[p*3+1]
//               dst[p*4+2]=src[p*3+2]; dst[p*4+3]=255
//             }
//           } else continue
//           ict.putImageData(id, 0, 0)
//           embeddedImages.push({
//             buffer: ic.toBuffer('image/png'), mimeType: 'image/png',
//             name: `p${pageNum}_${imgName}`, area: imgObj.width * imgObj.height
//           })
//         } catch {}
//       }
//       embeddedImages = embeddedImages.filter(i => i.area > 50000).sort((a,b) => b.area - a.area)
//     } catch {}

//     const pageRender = {
//       buffer: canvas.toBuffer('image/png'), mimeType: 'image/png',
//       name: `page_${pageNum}_full`
//     }
//     slides.push({
//       slideIndex: pageNum - 1, slideNum: pageNum, lines,
//       images: embeddedImages.length > 0 ? [pageRender, ...embeddedImages] : [pageRender],
//       isPdf: true
//     })
//   }
//   return slides
// }

// // ═══════════════════════════════════════════════════════════
// // STEP 1 — GEMINI: select best image
// // ═══════════════════════════════════════════════════════════

// const selectBestImage = async (images, lines = [], isPdf = false) => {
//   if (images.length === 1) {
//     try {
//       const { buffer, mimeType } = await resizeForGemini(images[0].buffer, images[0].mimeType, 800)
//       const response = await withRetry(() => ai.models.generateContent({
//         model:    'gemini-2.5-flash',
//         contents: {
//           parts: [
//             { inlineData: { data: buffer.toString('base64'), mimeType } },
//             {
//               text: `Analyse this product image carefully.

// Return ONLY JSON:
// {
//   "hasCleanBackground": false,
//   "hasHuman": false,
//   "isUsable": true
// }

// Rules:
// - hasCleanBackground = true ONLY if background is PURE WHITE (#FFFFFF or very close).
//   Set to FALSE for: beige, cream, grey, light blue, gradient, room/lifestyle setting,
//   any colour background, shadows on background, or patterned background.
//   When in doubt → false.
// - hasHuman = true if ANY person, hand, arm, foot, leg, or body part is visible IN THE IMAGE
//   OR REFLECTED IN ANY MIRROR, GLASS, OR REFLECTIVE SURFACE. Also set true for partial body
//   parts at image edges. When in doubt → true.
// - isUsable = false only if image is completely blank, solid colour with no product, or corrupted.`
//             },
//           ],
//         },
//       }))

//       const text   = response.candidates[0].content.parts.find(p => p.text)?.text || ''
//       const result = JSON.parse(text.replace(/```json|```/g, '').trim())

//       return {
//         bestIndex:      0,
//         needsBgRemoval: !result.hasCleanBackground,
//         hasHuman:       result.hasHuman  ?? false,
//         isUsable:       result.isUsable  ?? true,
//       }
//     } catch {
//       return { bestIndex: 0, needsBgRemoval: true, hasHuman: false, isUsable: true }
//     }
//   }

//   // Multiple images
//   const parts = []
//   for (let i = 0; i < images.length; i++) {
//     const { buffer, mimeType } = await resizeForGemini(images[i].buffer, images[i].mimeType, 700)
//     parts.push({ inlineData: { data: buffer.toString('base64'), mimeType } })
//     parts.push({ text: `[Image ${i + 1}${i === 0 && isPdf ? ' — full page' : ''}]:` })
//   }

//   parts.push({
//     text: `
// ${images.length} images from a product catalog ${isPdf ? 'PDF page' : 'slide'}.
// Context: "${lines.join(', ') || 'none'}"
// ${isPdf ? 'Image 1 is full page. Images 2+ are embedded photos — prefer those.' : ''}

// Pick the BEST product image. Prefer: product only, no humans, clean view, correct orientation.

// Return ONLY JSON:
// {
//   "bestIndex": 0,
//   "needsBgRemoval": true,
//   "hasHuman": false
// }

// hasHuman = true if ANY person, body part, OR REFLECTION OF A PERSON in mirrors/glass is visible.
// Include partial body parts at image edges. When in doubt → true.

// IMPORTANT for needsBgRemoval:
// - Set to TRUE for ANY non-pure-white background (beige, cream, grey, room setting, gradient, shadows)
// - Set to FALSE ONLY if background is literally pure white (#FFFFFF)
// - When in doubt → true`
//   })

//   try {
//     const response = await withRetry(() => ai.models.generateContent({
//       model:    'gemini-2.5-flash',
//       contents: { parts },
//     }))
//     const text   = response.candidates[0].content.parts.find(p => p.text)?.text || ''
//     const result = JSON.parse(text.replace(/```json|```/g, '').trim())
//     return {
//       bestIndex:      result.bestIndex      ?? (isPdf && images.length > 1 ? 1 : 0),
//       needsBgRemoval: result.needsBgRemoval ?? true,
//       hasHuman:       result.hasHuman       ?? false,
//       isUsable:       true,
//     }
//   } catch {
//     return { bestIndex: isPdf && images.length > 1 ? 1 : 0, needsBgRemoval: true, hasHuman: false, isUsable: true }
//   }
// }

// // ═══════════════════════════════════════════════════════════
// // STEP 2 — GEMINI: fix orientation
// // ═══════════════════════════════════════════════════════════

// const fixOrientation = async (buffer, mimeType) => {
//   try {
//     const { buffer: small, mimeType: sm } = await resizeForGemini(buffer, mimeType, 1000)
//     const response = await withRetry(() => ai.models.generateContent({
//       model:    'gemini-2.5-flash',
//       contents: {
//         parts: [
//           { inlineData: { data: small.toString('base64'), mimeType: sm } },
//           { text: `Look at this product image and determine if it needs rotation to appear upright.

// Return ONLY JSON:
// {"correct": true}
// OR
// {"correct": false, "rotation": 90}

// Rules:
// - "correct": true ONLY if the product is already perfectly upright with no rotation needed.
// - If the product is rotated in ANY way (sideways, upside down, tilted), return "correct": false
//   with the exact degrees needed to make it upright.
// - rotation must be one of: 90, 180, 270
// - NEVER reject or skip an image for any reason — always return the best rotation.
// - Do NOT add "flip" unless the image is a literal mirror-image (text reversed).
// - Side-view, angled, or 3/4 view images are acceptable — just make sure they are upright.` },
//         ],
//       },
//     }))

//     const text   = response.candidates[0].content.parts.find(p => p.text)?.text || ''
//     const result = JSON.parse(text.replace(/```json|```/g, '').trim())
//     if (result.correct) return { buffer, mimeType }

//     const img     = await loadImage(buffer)
//     const deg     = result.rotation || 0
//     const flip    = result.flip
//     const swapped = deg === 90 || deg === 270
//     const w       = swapped ? img.height : img.width
//     const h       = swapped ? img.width  : img.height
//     const canvas  = createCanvas(w, h)
//     const ctx     = canvas.getContext('2d')
//     ctx.fillStyle = '#ffffff'
//     ctx.fillRect(0, 0, w, h)
//     ctx.save()
//     ctx.translate(w / 2, h / 2)
//     if (deg)  ctx.rotate((deg * Math.PI) / 180)
//     if (flip === 'horizontal') ctx.scale(-1,  1)
//     if (flip === 'vertical')   ctx.scale( 1, -1)
//     ctx.drawImage(img, -img.width / 2, -img.height / 2)
//     ctx.restore()
//     return { buffer: canvas.toBuffer('image/png'), mimeType: 'image/png' }
//   } catch {
//     return { buffer, mimeType }
//   }
// }

// // ═══════════════════════════════════════════════════════════
// // STEP 3 — GEMINI: extract product fields
// // ═══════════════════════════════════════════════════════════

// const extractFieldsWithGemini = async (buffer, mimeType, lines = []) => {
//   const { buffer: hires, mimeType: hm } = await resizeForGemini(buffer, mimeType, 1600)
//   const slideText = lines.length
//     ? `\nText on slide:\n${lines.map(l => `• ${l}`).join('\n')}`
//     : '\n(No text on slide)'

//   try {
//     const response = await withRetry(() => ai.models.generateContent({
//       model:    'gemini-2.5-flash',
//       contents: {
//         parts: [
//           { inlineData: { data: hires.toString('base64'), mimeType: hm } },
//           { text: `Extract product data. Only return fields EXPLICITLY present. Never guess.${slideText}
// Return ONLY JSON:
// {
//   "description": "name or null",
//   "material": "exact or null",
//   "length": number or null,
//   "width": number or null,
//   "height": number or null,
//   "measurement": "cm" or "inch" or null,
//   "finish": "exact or null",
//   "weight": "kg number only or null"
// }

// Rules for dimensions:
// - Extract numeric values only (no units) into length, width, height
// - measurement must be exactly "cm" or "inch" — detect from the text (e.g. "cm", "cms", "centimeter", "\"", "in", "inch", "inches")
// - If only one or two dimensions are present, fill what you can and leave others null
// - If dimensions appear as WxDxH or LxWxH, map accordingly
// - Never guess — if not explicitly stated, return null` },
//         ],
//       },
//     }))
//     const text = response.candidates[0].content.parts.find(p => p.text)?.text || ''
//     return JSON.parse(text.replace(/```json|```/g, '').trim())
//   } catch {
//     return {}
//   }
// }

// // ═══════════════════════════════════════════════════════════
// // STEP 4 — GEMINI: remove humans
// // ═══════════════════════════════════════════════════════════

// const removeHumans = async (buffer, mimeType, description = '') => {
//   try {
//     const response = await withRetry(() => ai.models.generateContent({
//       model:    'gemini-2.5-flash-image',
//       contents: {
//         parts: [
//           { inlineData: { data: buffer.toString('base64'), mimeType } },
//           { text: `Product image${description ? ` — ${description}` : ''}.
// Remove ALL humans and body parts from the image including:
// - People standing in or near the product
// - Human reflections visible inside mirrors or glass surfaces
// - Partial body parts at image edges (arms, shoulders, hands)
// Replace removed areas with surrounding background or a neutral fill.
// Keep the product completely unchanged. Return cleaned image only.` },
//         ],
//       },
//       config: { responseModalities: ['IMAGE', 'TEXT'] },
//     }), 2, 2000)

//     for (const part of response.candidates[0].content.parts) {
//       if (part.inlineData) {
//         return {
//           buffer:   Buffer.from(part.inlineData.data, 'base64'),
//           mimeType: part.inlineData.mimeType || 'image/png',
//         }
//       }
//     }
//   } catch (err) {
//     console.warn('⚠️ Human removal failed:', err.message)
//   }
//   return { buffer, mimeType }
// }

// // ═══════════════════════════════════════════════════════════
// // SANITISE
// // ═══════════════════════════════════════════════════════════

// const sanitizeExtractedFields = (fields) => {
//   const trim = (val, max) => (!val || typeof val !== 'string') ? null : val.trim().slice(0, max) || null

//   const toPositiveFloat = (val) => {
//     if (val == null) return null
//     const num = parseFloat(String(val).replace(/[^0-9.]/g, ''))
//     return (!isNaN(num) && num > 0) ? num : null
//   }

//   const unit = (fields.measurement || '').toLowerCase().trim()
//   const normalizedUnit = unit === 'cm' || unit === 'in' ? unit : null

//   return {
//     description:      trim(fields.description, 500),
//     material:         trim(fields.material, 300),
//     length:           toPositiveFloat(fields.length),
//     width:            toPositiveFloat(fields.width),
//     height:           toPositiveFloat(fields.height),
//     measurement: normalizedUnit,
//     finish:           trim(fields.finish, 200),
//     weight:           toPositiveFloat(fields.weight),
//   }
// }

// // ═══════════════════════════════════════════════════════════
// // UPLOAD
// // ═══════════════════════════════════════════════════════════

// const uploadImageToStorage = async (buffer, storagePath, mimeType = 'image/png') => {
//   const { error } = await supabase.storage
//     .from(NPD_BUCKET)
//     .upload(storagePath, buffer, { contentType: mimeType, upsert: false })
//   if (error) throw error
//   const { data } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)
//   return data.publicUrl
// }

// const generateAutoCode = () => `SKU-${Math.floor(10000 + Math.random() * 90000)}`

// // ═══════════════════════════════════════════════════════════
// // PROCESS ONE SLIDE
// // ═══════════════════════════════════════════════════════════

// const processSlide = async (slide, uploadRow, basePath) => {
//   const { slideIndex, lines, images, isPdf = false } = slide
//   if (!images.length) return null

//   console.log(`\n  ┌─ Slide ${slideIndex + 1} │ ${images.length} image(s)`)

//   // ── STEP 1 + fields in parallel ────────────────────────────
//   const [selection, firstFields] = await Promise.all([
//     selectBestImage(images, lines, isPdf),
//     extractFieldsWithGemini(images[0].buffer, images[0].mimeType, lines).catch(() => ({})),
//   ])

//   const { bestIndex, needsBgRemoval, hasHuman, isUsable } = selection
//   if (!isUsable) {
//     console.log('  └─ Skipped — unusable')
//     return null
//   }

//   const best = images[bestIndex]
//   console.log(`  │  [1] Best: #${bestIndex + 1} │ needsBgRemoval: ${needsBgRemoval} │ hasHuman: ${hasHuman}`)

//   // ── STEP 2: fix orientation ─────────────────────────────────
//   const { buffer: oriented, mimeType: orientedMime } = await fixOrientation(best.buffer, best.mimeType)
//   console.log('  │  [2] Orientation fixed')

//   // ── STEP 3: extract fields from best image ──────────────────
//   let rawFields = firstFields
//   if (bestIndex !== 0) {
//     rawFields = await extractFieldsWithGemini(best.buffer, best.mimeType, lines).catch(() => firstFields)
//   }
//   const fields = sanitizeExtractedFields(rawFields)
//   const desc   = fields.description || ''
//   console.log(`  │  [3] Fields: "${desc || 'none'}"`)

//   // ── STEP 4: remove humans if detected ──────────────────────
//   let { buffer: cleaned, mimeType: cleanedMime } = { buffer: oriented, mimeType: orientedMime }
//   if (hasHuman) {
//     ;({ buffer: cleaned, mimeType: cleanedMime } = await removeHumans(oriented, orientedMime, desc))
//     console.log('  │  [4] Humans removed')
//   }

//   // ── STEP 5: remove background ───────────────────────────────
//   let finalBuffer = cleaned
//   let finalMime   = cleanedMime
//   if (needsBgRemoval) {
//     ;({ buffer: finalBuffer, mimeType: finalMime } = await removeBackground(cleaned, cleanedMime, desc))
//     console.log('  │  [5] BG removed')
//   } else {
//     console.log('  │  [5] BG already pure white — skipped')
//   }

//   // ── STEP 6: pad to square with breathing room ──────────────
//   ;({ buffer: finalBuffer, mimeType: finalMime } = await padToSquare(finalBuffer, finalMime, 8))
//   console.log('  │  [6] Padded to square')

//   // ── STEP 7: upload ──────────────────────────────────────────
//   const autoCode = generateAutoCode()
//   const storPath = `${basePath}/skus/${autoCode}.png`
//   const imageUrl = await uploadImageToStorage(finalBuffer, storPath, 'image/png')

//   // ── STEP 8: insert SKU ──────────────────────────────────────
//   const { data: sku, error } = await supabase
//     .from('npd2_catalog_skus')
//     .insert([{
//       catalog_upload_id: uploadRow.id,
//       auto_code:         autoCode,
//       image_url:         imageUrl,
//       slide_index:       slideIndex,
//       category:          fields.category || uploadRow.category || null,
//       description:       fields.description       || null,
//       material:          fields.material           || null,
//       length:            fields.length             ?? null,   // ← new
//       width:             fields.width              ?? null,   // ← new
//       height:            fields.height             ?? null,   // ← new
//       measurement:       fields.measurement        || null,   // ← new
//       finish:            fields.finish             || null,
//       weight:            fields.weight             ?? null,
//     }])
//     .select()
//     .single()

//   if (error) throw error
//   console.log(`  └─ ✅ ${autoCode} saved`)
//   return { ...sku, supplier: uploadRow.supplier, season: uploadRow.season }
// }

// // ═══════════════════════════════════════════════════════════
// // MAIN
// // ═══════════════════════════════════════════════════════════

// const run = async () => {
//   console.log(`\n🔧 Worker starting — upload: ${UPLOAD_ID}`)
//   console.log(`   Concurrency: ${SLIDE_CONCURRENCY}\n`)

//   try {
//     const { data: uploadRow, error: uploadErr } = await supabase
//       .from('npd2_catalog_uploads')
//       .select('*')
//       .eq('id', UPLOAD_ID)
//       .single()
//     if (uploadErr) throw uploadErr

//     if (uploadRow.status === 'done') {
//       console.log('⚠️ Upload already done — exiting to prevent duplicates')
//       process.exit(0)
//     }
//     if (uploadRow.status === 'processing') {
//       console.log('⚠️ Upload already processing — exiting to prevent duplicates')
//       process.exit(0)
//     }

//     console.log(`📁 ${uploadRow.source_filename} (${uploadRow.source_ext})`)

//     let supplierSlug = 'unknown_supplier'
//     let categorySlug = null

//     const toSlug = (str) =>
//   (str || '')
//     .normalize('NFD')
//     .replace(/[\u0300-\u036f]/g, '')   // strip accents: é→e, ü→u etc
//     .replace(/[^a-z0-9]+/gi, '_')      // replace anything non-alphanumeric with _
//     .replace(/^_+|_+$/g, '')           // trim leading/trailing underscores
//     .toLowerCase()

//     if (uploadRow.supplier_org_id) {
//       const { data: org } = await supabase
//         .from('organizations')
//         .select('display_name')
//         .eq('id', uploadRow.supplier_org_id)
//         .single()
//       if (org?.display_name)
//         supplierSlug = toSlug(org.display_name)
//     }

//     if (uploadRow.category_id) {
//       const { data: cat } = await supabase
//         .from('categories')
//         .select('name')
//         .eq('id', uploadRow.category_id)
//         .single()
//       if (cat?.name)
//         categorySlug = toSlug(cat.name)
//     }

    
//     const seasonSlug = toSlug(uploadRow.season || 'unknown')

//     const basePath = uploadRow.supplier_org_id
//       ? (categorySlug
//           ? `catalog/${supplierSlug}/${seasonSlug}/${categorySlug}`
//           : `catalog/${supplierSlug}/${seasonSlug}`)
//       : `catalog/${uploadRow.id}`

//     console.log(`📂 basePath: ${basePath}`)

//     const { data: fileData, error: fileErr } = await supabase.storage
//       .from(NPD_BUCKET)
//       .download(uploadRow.source_file_path)
//     if (fileErr) throw fileErr

//     const fileBuffer = Buffer.from(await fileData.arrayBuffer())
//     const ext        = (uploadRow.source_ext || EXT || '').toLowerCase()

//     console.log('\n📄 Extracting slides...')
//     const slides = ext === '.pptx'
//       ? await extractSlidesFromPptx(fileBuffer)
//       : await extractSlidesFromPdf(fileBuffer)

//     if (!slides.length) throw new Error('No slides with images found')
//     console.log(`✅ ${slides.length} slides found\n`)

//     const { error: statusErr } = await supabase
//       .from('npd2_catalog_uploads')
//       .update({ status: 'processing', total_slides: slides.length })
//       .eq('id', UPLOAD_ID)
//     if (statusErr) throw statusErr

//     const limit       = pLimit(SLIDE_CONCURRENCY)
//     let   done        = 0
//     let   lastUpdate  = 0
//     const skusCreated = []
//     const failed      = []

//     await Promise.all(
//       slides.map(slide =>
//         limit(async () => {
//           try {
//             const sku = await processSlide(slide, uploadRow, basePath)
//             done++
//             if (sku) skusCreated.push(sku)
//           } catch (err) {
//             done++
//             failed.push({ slide: slide.slideIndex + 1, error: err.message })
//             console.warn(`\n  ❌ Slide ${slide.slideIndex + 1} failed: ${err.message}`)
//           }

//           if (done - lastUpdate >= 3 || done === slides.length) {
//             lastUpdate = done
//             try {
//               await supabase
//                 .from('npd2_catalog_uploads')
//                 .update({ slides_processed: done, sku_count: skusCreated.length })
//                 .eq('id', UPLOAD_ID)
//             } catch {}
//           }

//           console.log(`\n  📊 ${done}/${slides.length} done`)
//         })
//       )
//     )

//     await supabase
//       .from('npd2_catalog_uploads')
//       .update({
//         status:    'done',
//         sku_count: skusCreated.length,
//         ...(failed.length ? { error_message: `${failed.length} slide(s) failed` } : {}),
//       })
//       .eq('id', UPLOAD_ID)

//     console.log(`\n✅ Done — ${skusCreated.length} SKUs created`)
//     if (failed.length) console.log(`⚠️  ${failed.length} failed:`, failed)

//     process.exit(0)

//   } catch (err) {
//     console.error('\n❌ Worker failed:', err.message)
//     try {
//       await supabase
//         .from('npd2_catalog_uploads')
//         .update({ status: 'error', error_message: err.message })
//         .eq('id', UPLOAD_ID)
//     } catch {}
//     process.exit(1)
//   }
// }

// run()

'use strict';
require('dotenv').config()

const AdmZip          = require('adm-zip')
const { createCanvas, loadImage } = require('canvas')
const pdfjsLib        = require('pdfjs-dist/legacy/build/pdf')
pdfjsLib.GlobalWorkerOptions.workerSrc = false 
const { GoogleGenAI } = require('@google/genai')
const supabase        = require('../supabaseClient')
const pLimit          = require('p-limit')

const ai                = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
const NPD_BUCKET        = 'npd'
const SLIDE_CONCURRENCY = parseInt(process.env.SLIDE_CONCURRENCY || '20')

const JOB_MODE    = process.env.JOB_MODE || 'catalog'
const UPLOAD_ID   = process.env.JOB_UPLOAD_ID
const EXT         = process.env.JOB_EXT
const CUSTOMER_ID = process.env.JOB_CUSTOMER_ID
const SKU_IDS     = (process.env.JOB_SKU_IDS || '').split(',').map(s => s.trim()).filter(Boolean)

if (JOB_MODE === 'catalog' && !UPLOAD_ID) {
  console.error('❌ JOB_UPLOAD_ID not set — exiting')
  process.exit(1)
}
if (JOB_MODE === 'image_processing' && !SKU_IDS.length) {
  console.error('❌ JOB_SKU_IDS not set — exiting')
  process.exit(1)
}

// ═══════════════════════════════════════════════════════════
// RETRY HELPER
// ═══════════════════════════════════════════════════════════

const withRetry = async (fn, retries = 2, delayMs = 1500) => {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === retries) throw err
      const wait = delayMs * (i + 1)
      console.warn(`  ⚠️  Attempt ${i + 1} failed: ${err.message} — retry in ${wait}ms`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
}

// ═══════════════════════════════════════════════════════════
// RESIZE
// ═══════════════════════════════════════════════════════════

const resizeForGemini = async (buffer, mimeType, maxDim = 1200) => {
  try {
    const img   = await loadImage(buffer)
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
    if (scale >= 1) return { buffer, mimeType }

    const w      = Math.round(img.width  * scale)
    const h      = Math.round(img.height * scale)
    const canvas = createCanvas(w, h)
    const ctx    = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)

    return {
      buffer:   canvas.toBuffer('image/jpeg', { quality: 0.92 }),
      mimeType: 'image/jpeg',
    }
  } catch {
    return { buffer, mimeType }
  }
}

// ═══════════════════════════════════════════════════════════
// BACKGROUND REMOVAL
// ═══════════════════════════════════════════════════════════

const removeBackground = async (buffer, mimeType, description = '') => {
  const isMirror = /mirror|glass|transparent|crystal|acrylic/i.test(description)

  const prompt = isMirror
    ? `Mirror/glass product. Remove background outside the frame only.
Keep frame and reflective surface completely intact. White background. Return image only.`
    : `Remove the background from this product image completely.
Keep ALL product details EXACTLY as shown — do not redraw, simplify, smooth over,
or reinterpret the product. This is a background removal task, not a re-illustration.
Preserve pixel-for-pixel: thin legs, wires, handles, fabric texture, fine edges,
semi-transparent parts, shadows cast BY the product (keep subtle drop shadow if present),
and especially any printed, engraved, embossed, or painted surface patterns
(e.g. leaves, branches, florals, text, logos) — keep their exact shape, position, and detail.
Do NOT crop or cut off any part of the product — ensure the ENTIRE product is visible.
Pure white (#FFFFFF) background. Product fully visible and centred.
Return image only.`

  const { buffer: resized, mimeType: resizedMime } = await resizeForGemini(buffer, mimeType, 2048)

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await withRetry(() => ai.models.generateContent({
        model:    'gemini-2.5-flash-image',
        contents: {
          parts: [
            { inlineData: { data: resized.toString('base64'), mimeType: resizedMime } },
            { text: prompt },
          ],
        },
        config: { responseModalities: ['IMAGE', 'TEXT'] },
      }), 2, 2000)

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const result = Buffer.from(part.inlineData.data, 'base64')
          if (result.length < 5000) {
            console.warn(`  ⚠️  Gemini BG removal attempt ${attempt} — blank result, retrying...`)
            break
          }

          try {
            const outImg = await loadImage(result)
            const inImg  = await loadImage(resized)
            if (outImg.width < inImg.width * 0.5 || outImg.height < inImg.height * 0.5) {
              console.warn(`  ⚠️  BG removal attempt ${attempt} — output too small, retrying...`)
              break
            }
          } catch {}

          console.log(`  ✓ Gemini removed BG (attempt ${attempt})`)
          return { buffer: result, mimeType: part.inlineData.mimeType || 'image/png' }
        }
      }
    } catch (err) {
      console.warn(`  ⚠️  Gemini BG removal attempt ${attempt} failed: ${err.message}`)
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }

  console.warn('  ⚠️  Gemini BG removal failed after 3 attempts — using original')
  return { buffer, mimeType }
}

// ═══════════════════════════════════════════════════════════
// IMAGE ENHANCEMENT (white-background images)
// ═══════════════════════════════════════════════════════════

const enhanceImage = async (buffer, mimeType, description = '') => {
  const { buffer: resized, mimeType: resizedMime } = await resizeForGemini(buffer, mimeType, 1600)

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await withRetry(() => ai.models.generateContent({
        model:    'gemini-2.5-flash-image',
        contents: {
          parts: [
            { inlineData: { data: resized.toString('base64'), mimeType: resizedMime } },
            { text: `Product image${description ? ` — ${description}` : ''}.
The background is already white. Enhance the product image quality:
- Improve brightness, contrast and sharpness of the product
- Clean up minor blemishes or noise
- Ensure crisp, clean edges around the product
- Keep the pure white (#FFFFFF) background intact — do NOT change it
- Keep the product shape, colour and proportions completely unchanged
Return the enhanced image only.` },
          ],
        },
        config: { responseModalities: ['IMAGE', 'TEXT'] },
      }), 2, 2000)

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const result = Buffer.from(part.inlineData.data, 'base64')
          if (result.length < 5000) {
            console.warn(`  ⚠️  Gemini enhance attempt ${attempt} — blank result, retrying...`)
            break
          }
          console.log(`  ✓ Gemini enhanced image (attempt ${attempt})`)
          return { buffer: result, mimeType: part.inlineData.mimeType || 'image/png' }
        }
      }
    } catch (err) {
      console.warn(`  ⚠️  Gemini enhance attempt ${attempt} failed: ${err.message}`)
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }

  console.warn('  ⚠️  Gemini enhance failed after 3 attempts — using original')
  return { buffer, mimeType }
}

// ═══════════════════════════════════════════════════════════
// PAD TO SQUARE
// ═══════════════════════════════════════════════════════════

const padToSquare = async (buffer, mimeType, paddingPercent = 8) => {
  try {
    const img  = await loadImage(buffer)
    const size = Math.max(img.width, img.height)
    const pad  = Math.round(size * (paddingPercent / 100))
    const out  = size + pad * 2
    const canvas = createCanvas(out, out)
    const ctx    = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out, out)
    const x = Math.round((out - img.width)  / 2)
    const y = Math.round((out - img.height) / 2)
    ctx.drawImage(img, x, y)
    return { buffer: canvas.toBuffer('image/png'), mimeType: 'image/png' }
  } catch {
    return { buffer, mimeType }
  }
}

// ═══════════════════════════════════════════════════════════
// LOGO FILTER (pixel dimensions)
// ═══════════════════════════════════════════════════════════

const filterLogoImages = async (images) => {
  if (images.length <= 1) return images

  const withDims = await Promise.all(images.map(async img => {
    try {
      const loaded = await loadImage(img.buffer)
      return { ...img, width: loaded.width, height: loaded.height }
    } catch {
      return { ...img, width: 0, height: 0 }
    }
  }))

  const filtered = withDims.filter(img => img.width >= 200 && img.height >= 200)
  return filtered.length > 0 ? filtered : images
}

// ═══════════════════════════════════════════════════════════
// PPTX TEXT EXTRACTION (improved — captures tables + shapes)
// ═══════════════════════════════════════════════════════════

const extractTextFromSlideXml = (xml) => {
  // Strip all XML tags and collapse runs within a paragraph
  // Captures text from shapes, tables, text boxes uniformly
  const paragraphs = []
  const paraRegex  = /<a:p[\s>][\s\S]*?<\/a:p>/g
  let   paraMatch

  while ((paraMatch = paraRegex.exec(xml)) !== null) {
    const paraXml = paraMatch[0]
    // Extract all text runs within this paragraph
    const runs    = (paraXml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [])
      .map(r => r.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean)
    if (runs.length) paragraphs.push(runs.join(''))
  }

  return paragraphs.filter(Boolean)
}

// ═══════════════════════════════════════════════════════════
// PPTX ANNOTATION EXTRACTION (callouts, arrows, dimension labels)
// ═══════════════════════════════════════════════════════════

const extractAnnotationsFromSlideXml = (xml) => {
  const annotations = []
  const spRegex = /<p:sp[\s>][\s\S]*?<\/p:sp>/g
  let spMatch
  while ((spMatch = spRegex.exec(xml)) !== null) {
    const spXml = spMatch[0]
    if (!/<a:t[^>]*>[^<]+<\/a:t>/.test(spXml)) continue
    const runs = (spXml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [])
      .map(r => r.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean)
    if (runs.length) annotations.push(runs.join(' '))
  }
  return annotations
}

// ═══════════════════════════════════════════════════════════
// PPTX EXTRACTION
// ═══════════════════════════════════════════════════════════

const extractSlidesFromPptx = async (fileBuffer) => {
  const zip      = new AdmZip(fileBuffer)
  const entryMap = {}
  for (const e of zip.getEntries()) entryMap[e.entryName.toLowerCase()] = e
  const getEntry = name => entryMap[name.toLowerCase()]

  const slideEntries = zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => {
      const n = s => parseInt(s.entryName.match(/(\d+)\.xml$/)[1])
      return n(a) - n(b)
    })

  const slides = []

  for (let idx = 0; idx < slideEntries.length; idx++) {
    const slideEntry = slideEntries[idx]
    const slideNum   = parseInt(slideEntry.entryName.match(/(\d+)\.xml$/)[1])
    const xml        = slideEntry.getData().toString('utf8')

    // ── Improved text extraction ──────────────────────────
    const lines       = extractTextFromSlideXml(xml)
    const annotations = extractAnnotationsFromSlideXml(xml)
    const allLines    = [...new Set([...lines, ...annotations])]

    const relEntry = getEntry(`ppt/slides/_rels/slide${slideNum}.xml.rels`)
    const images   = []

    if (relEntry) {
      const relXml   = relEntry.getData().toString('utf8')
      const relRegex = /Type="[^"]*\/image"[^>]*Target="([^"]+)"/gi
      let m
      while ((m = relRegex.exec(relXml)) !== null) {
        const filename = m[1].replace(/^.*\//, '')
        const ext      = filename.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg'
        if (['emf','wmf','emz','wmz'].includes(ext)) continue
        const mediaEntry = getEntry(`ppt/media/${filename}`)
        if (!mediaEntry) continue
        const mimeType = ext === 'png'  ? 'image/png'
                       : ext === 'gif'  ? 'image/gif'
                       : ext === 'webp' ? 'image/webp'
                       : 'image/jpeg'
        images.push({ buffer: mediaEntry.getData(), mimeType, name: filename })
      }
    }

    if (images.length > 0) {
      const filteredImages = await filterLogoImages(images)
      slides.push({ slideIndex: idx, slideNum, lines: allLines, images: filteredImages, isPdf: false })
    }
  }

  return slides
}

// ═══════════════════════════════════════════════════════════
// PDF EXTRACTION
// ═══════════════════════════════════════════════════════════
// Module level (above extractSlidesFromPdf):
const renderWithTimeout = (renderTask, ms = 30000) => {

  let timer
  return Promise.race([
    renderTask.promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => { renderTask.cancel(); reject(new Error('Page render timed out')) }, ms)
    })
  ]).finally(() => clearTimeout(timer))
}

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height)
    return { canvas, context: canvas.getContext('2d') }
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width  = width
    canvasAndContext.canvas.height = height
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width  = 0
    canvasAndContext.canvas.height = 0
  }
}

// Rasterise a pdfjs image object (bitmap XObject or inline image) to a PNG buffer.
// Handles RGBA (4ch), RGB (3ch), and grayscale (1ch) pixel layouts.
const renderImageObject = (imgObj) => {
  if (!imgObj?.data) return null
  const { width: W, height: H, data: src } = imgObj
  const ic  = createCanvas(W, H)
  const ict = ic.getContext('2d')
  const id  = ict.createImageData(W, H)
  const dst = id.data
  const px  = W * H

  if (src.length === px * 4) {
    dst.set(src)
  } else if (src.length === px * 3) {
    for (let p = 0; p < px; p++) {
      dst[p*4]   = src[p*3]
      dst[p*4+1] = src[p*3+1]
      dst[p*4+2] = src[p*3+2]
      dst[p*4+3] = 255
    }
  } else if (src.length === px) {
    for (let p = 0; p < px; p++) {
      dst[p*4] = dst[p*4+1] = dst[p*4+2] = src[p]
      dst[p*4+3] = 255
    }
  } else {
    return null  // unrecognised channel layout
  }

  ict.putImageData(id, 0, 0)
  return ic.toBuffer('image/png')
}

// Pixel-density scan: finds non-white content blocks in the rendered page canvas
// and crops each one as a separate image. This isolates vector graphics that are
// drawn onto the page but not stored as embedded bitmap XObjects.
const smartCropPage = (canvas, pageNum) => {
  const W = canvas.width, H = canvas.height
  if (W < 300 || H < 300) return []

  const ctx  = canvas.getContext('2d')
  const data = ctx.getImageData(0, 0, W, H).data
  const WT   = 238  // "white enough" pixel threshold

  // Row density — fraction of non-white pixels (sampled every 3rd pixel)
  const rowDen = new Float32Array(H)
  for (let y = 0; y < H; y++) {
    let nw = 0, total = 0
    for (let x = 0; x < W; x += 3) {
      const i = (y * W + x) * 4
      if (data[i] < WT || data[i+1] < WT || data[i+2] < WT) nw++
      total++
    }
    rowDen[y] = nw / total
  }

  // Smooth ±4 rows
  const sRow = new Float32Array(H)
  for (let y = 0; y < H; y++) {
    let s = 0, c = 0
    for (let d = -4; d <= 4; d++) {
      const r = y + d
      if (r >= 0 && r < H) { s += rowDen[r]; c++ }
    }
    sRow[y] = s / c
  }

  // Horizontal content bands: runs of rows with > 3% non-white density
  const MIN_BAND_H = Math.max(40, Math.round(H * 0.07))
  const hBands = []
  let bs = -1
  for (let y = 0; y < H; y++) {
    if (sRow[y] > 0.03 && bs === -1) bs = y
    if (sRow[y] <= 0.03 && bs !== -1) {
      if (y - bs >= MIN_BAND_H) hBands.push([bs, y - 1])
      bs = -1
    }
  }
  if (bs !== -1 && H - bs >= MIN_BAND_H) hBands.push([bs, H - 1])

  const regions = []
  const PAD = Math.round(Math.min(W, H) * 0.012)

  for (const [y0, y1] of hBands) {
    const bandH = y1 - y0 + 1

    // Column density within this horizontal band
    const colDen = new Float32Array(W)
    for (let x = 0; x < W; x++) {
      let nw = 0, total = 0
      for (let y = y0; y <= y1; y += 3) {
        const i = (y * W + x) * 4
        if (data[i] < WT || data[i+1] < WT || data[i+2] < WT) nw++
        total++
      }
      colDen[x] = nw / total
    }

    // Smooth ±4 cols
    const sCol = new Float32Array(W)
    for (let x = 0; x < W; x++) {
      let s = 0, c = 0
      for (let d = -4; d <= 4; d++) {
        const cx = x + d
        if (cx >= 0 && cx < W) { s += colDen[cx]; c++ }
      }
      sCol[x] = s / c
    }

    // Vertical content bands within this horizontal band
    const MIN_BAND_W = Math.max(40, Math.round(W * 0.08))
    const vBands = []
    let vs = -1
    for (let x = 0; x < W; x++) {
      if (sCol[x] > 0.02 && vs === -1) vs = x
      if (sCol[x] <= 0.02 && vs !== -1) {
        if (x - vs >= MIN_BAND_W) vBands.push([vs, x - 1])
        vs = -1
      }
    }
    if (vs !== -1 && W - vs >= MIN_BAND_W) vBands.push([vs, W - 1])

    for (const [x0, x1] of vBands) {
      const rw = x1 - x0 + 1
      // Skip if this region covers the whole page (no isolation value)
      if (rw > W * 0.85 && bandH > H * 0.85) continue
      // Skip regions too small to be a product image
      if (rw < W * 0.08 || bandH < H * 0.07) continue

      const rx0 = Math.max(0, x0 - PAD)
      const ry0 = Math.max(0, y0 - PAD)
      const rx1 = Math.min(W, x1 + PAD + 1)
      const ry1 = Math.min(H, y1 + PAD + 1)

      const rc  = createCanvas(rx1 - rx0, ry1 - ry0)
      const rct = rc.getContext('2d')
      rct.fillStyle = '#ffffff'
      rct.fillRect(0, 0, rc.width, rc.height)
      rct.drawImage(canvas, rx0, ry0, rx1 - rx0, ry1 - ry0, 0, 0, rc.width, rc.height)

      regions.push({
        buffer:   rc.toBuffer('image/png'),
        mimeType: 'image/png',
        name:     `p${pageNum}_crop_${regions.length}`,
        area:     rw * bandH,
        type:     'vectorCrop',
      })
    }
  }

  return regions
}

const extractSlidesFromPdf = async (fileBuffer) => {
  const pdf    = await pdfjsLib.getDocument({
    data:          new Uint8Array(fileBuffer),
    canvasFactory: new NodeCanvasFactory(),
    isEvalSupported: false,
  }).promise
  const slides = []
  console.log(`📄 PDF: ${pdf.numPages} pages`)
  const getPageObj = (page, name) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000)
    page.objs.get(name, (obj) => { clearTimeout(timer); resolve(obj) })
  })

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page     = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale: 3.0 })  // higher scale = crisper vectors
    const canvas   = createCanvas(viewport.width, viewport.height)
    const ctx      = canvas.getContext('2d')
    ctx.fillStyle  = '#ffffff'
    ctx.fillRect(0, 0, viewport.width, viewport.height)

    try {
      await renderWithTimeout(page.render({ canvasContext: ctx, viewport }))
    } catch (renderErr) {
      console.log(`  ⚠️  Page ${pageNum} render failed: ${renderErr.message} — skipping`)
      continue
    }

    // Text extraction — group items by Y position to reconstruct lines
    const textContent = await page.getTextContent()
    const lineMap = {}
    for (const item of textContent.items) {
      if (!item.str?.trim()) continue
      const y = Math.round(item.transform[5] / 5) * 5
      if (!lineMap[y]) lineMap[y] = []
      lineMap[y].push(item.str.trim())
    }
    const lines = Object.keys(lineMap)
      .sort((a, b) => b - a)
      .map(y => lineMap[y].join(' '))
      .filter(Boolean)

    // Embedded image extraction: named XObjects (op 85) + inline images (op 92)
    let embeddedImages = []
    try {
      const ops         = await page.getOperatorList()
      const bitmapNames = new Set()
      const inlineImgs  = []

      for (let i = 0; i < ops.fnArray.length; i++) {
        if      (ops.fnArray[i] === 85) bitmapNames.add(ops.argsArray[i][0])
        else if (ops.fnArray[i] === 92) inlineImgs.push(ops.argsArray[i][0])
      }

      for (const imgName of bitmapNames) {
        try {
          const imgObj = await getPageObj(page, imgName)
          if (!imgObj?.data || imgObj.width < 80 || imgObj.height < 80) continue
          const buf = renderImageObject(imgObj)
          if (buf) embeddedImages.push({
            buffer: buf, mimeType: 'image/png', type: 'bitmap',
            name: `p${pageNum}_${imgName}`, area: imgObj.width * imgObj.height,
          })
        } catch {}
      }

      for (let j = 0; j < inlineImgs.length; j++) {
        const imgObj = inlineImgs[j]
        if (!imgObj?.data || imgObj.width < 80 || imgObj.height < 80) continue
        try {
          const buf = renderImageObject(imgObj)
          if (buf) embeddedImages.push({
            buffer: buf, mimeType: 'image/png', type: 'bitmap',
            name: `p${pageNum}_inline_${j}`, area: imgObj.width * imgObj.height,
          })
        } catch {}
      }

      embeddedImages = embeddedImages.filter(i => i.area > 20000).sort((a, b) => b.area - a.area)
      if (embeddedImages.length) console.log(`  📷 Page ${pageNum}: ${embeddedImages.length} embedded bitmap(s)`)
    } catch {}

    // Smart region crops — pixel-density scan isolates vector graphics from page layout
    let croppedRegions = []
    try {
      croppedRegions = smartCropPage(canvas, pageNum).filter(r => r.area > 40000)
      if (croppedRegions.length) console.log(`  ✂️  Page ${pageNum}: ${croppedRegions.length} cropped region(s) (vector→raster)`)
    } catch {}

    let pageRenderBuffer
    try {
      pageRenderBuffer = canvas.toBuffer('image/png')
      if (!pageRenderBuffer || pageRenderBuffer.length < 1000) {
        console.log(`  ⚠️  Page ${pageNum} produced empty buffer — skipping`)
        continue
      }
    } catch (bufErr) {
      console.log(`  ⚠️  Page ${pageNum} toBuffer failed: ${bufErr.message} — skipping`)
      continue
    }

    const pageRender = {
      buffer:   pageRenderBuffer,
      mimeType: 'image/png',
      name:     `page_${pageNum}_full`,
      type:     'fullPage',
    }

    // Candidate order: full page (always first) → embedded bitmaps → cropped vector regions
    const images = [pageRender, ...embeddedImages, ...croppedRegions]

    slides.push({
      slideIndex: pageNum - 1, slideNum: pageNum, lines,
      images, isPdf: true,
    })
  }
  return slides
}

// ═══════════════════════════════════════════════════════════
// STEP 1 — GEMINI: select best image
// ═══════════════════════════════════════════════════════════

const selectBestImage = async (images, lines = [], isPdf = false) => {
  if (images.length === 1) {
    try {
      const { buffer, mimeType } = await resizeForGemini(images[0].buffer, images[0].mimeType, 800)
      const response = await withRetry(() => ai.models.generateContent({
        model:    'gemini-2.5-flash',
        contents: {
          parts: [
            { inlineData: { data: buffer.toString('base64'), mimeType } },
            {
              text: `Analyse this product image carefully.

Return ONLY JSON:
{
  "hasCleanBackground": false,
  "hasHuman": false,
  "isUsable": true
}

Rules:
- hasCleanBackground = true ONLY if background is PURE WHITE (#FFFFFF or very close).
  Set to FALSE for: beige, cream, grey, light blue, gradient, room/lifestyle setting,
  any colour background, shadows on background, or patterned background.
  When in doubt → false.
- hasHuman = true if ANY person, hand, arm, foot, leg, or body part is visible IN THE IMAGE
  OR REFLECTED IN ANY MIRROR, GLASS, OR REFLECTIVE SURFACE. Also set true for partial body
  parts at image edges. When in doubt → true.
- isUsable = false only if image is completely blank, solid colour with no product, or corrupted.`
            },
          ],
        },
      }))

      const text   = response.candidates[0].content.parts.find(p => p.text)?.text || ''
      const result = JSON.parse(text.replace(/```json|```/g, '').trim())

      return {
        bestIndex:      0,
        needsBgRemoval: !result.hasCleanBackground,
        hasHuman:       result.hasHuman  ?? false,
        isUsable:       result.isUsable  ?? true,
      }
    } catch {
      return { bestIndex: 0, needsBgRemoval: true, hasHuman: false, isUsable: true }
    }
  }

  // Multiple images
  const parts = []
  for (let i = 0; i < images.length; i++) {
    const { buffer, mimeType } = await resizeForGemini(images[i].buffer, images[i].mimeType, 700)
    parts.push({ inlineData: { data: buffer.toString('base64'), mimeType } })
    let label = ''
    if (isPdf) {
      if      (images[i].type === 'fullPage')   label = 'full page render'
      else if (images[i].type === 'bitmap')     label = 'embedded bitmap photo'
      else if (images[i].type === 'vectorCrop') label = 'cropped region (vector→raster)'
    }
    parts.push({ text: `[Image ${i + 1}${label ? ` — ${label}` : ''}]:` })
  }

  parts.push({
    text: `
${images.length} images from a product catalog ${isPdf ? 'PDF page' : 'slide'}.
Context: "${lines.join(' | ') || 'none'}"
${isPdf ? `Image types explained:
- "full page render": the complete PDF page rendered to raster — includes text, borders, all layout
- "embedded bitmap photo": an actual raster photo extracted directly from the PDF data stream
- "cropped region (vector→raster)": a content block isolated from the page render — may contain vector product illustrations converted to raster pixels

Preference order: "embedded bitmap photo" > well-isolated "cropped region" showing only the product > "full page render"
Reject any image that is purely text/specs with no actual product visual.` : ''}

Pick the BEST product image. Prefer: product only, no humans, clean view, correct orientation.

Return ONLY JSON:
{
  "bestIndex": 0,
  "needsBgRemoval": true,
  "hasHuman": false
}

hasHuman = true if ANY person, body part, OR REFLECTION OF A PERSON in mirrors/glass is visible.
Include partial body parts at image edges. When in doubt → true.

needsBgRemoval:
- true for ANY non-pure-white background (beige, cream, grey, room setting, gradient, shadows on BG)
- false ONLY if background is literally pure white (#FFFFFF)
- When in doubt → true`
  })

  try {
    const response = await withRetry(() => ai.models.generateContent({
      model:    'gemini-2.5-flash',
      contents: { parts },
    }))
    const text   = response.candidates[0].content.parts.find(p => p.text)?.text || ''
    const result = JSON.parse(text.replace(/```json|```/g, '').trim())
    return {
      bestIndex:      result.bestIndex      ?? (isPdf && images.length > 1 ? 1 : 0),
      needsBgRemoval: result.needsBgRemoval ?? true,
      hasHuman:       result.hasHuman       ?? false,
      isUsable:       true,
    }
  } catch {
    return { bestIndex: isPdf && images.length > 1 ? 1 : 0, needsBgRemoval: true, hasHuman: false, isUsable: true }
  }
}

// ═══════════════════════════════════════════════════════════
// PDF ONLY: identify ALL product images on a page
// Used by processPdfSlide to create one SKU per image found
// ═══════════════════════════════════════════════════════════

const selectAllProductImages = async (images, lines = []) => {
  // images[0] is always the full page render — skip it as a standalone product candidate
  const candidates = images.slice(1)
  if (!candidates.length) {
    return [{ index: 0, needsBgRemoval: true, hasHuman: false }]
  }

  const parts = []
  for (let i = 0; i < candidates.length; i++) {
    const { buffer, mimeType } = await resizeForGemini(candidates[i].buffer, candidates[i].mimeType, 700)
    parts.push({ inlineData: { data: buffer.toString('base64'), mimeType } })
    const label = candidates[i].type === 'bitmap'     ? 'embedded bitmap photo'
                : candidates[i].type === 'vectorCrop' ? 'cropped region (vector→raster)'
                : ''
    parts.push({ text: `[Image ${i + 1}${label ? ` — ${label}` : ''}]:` })
  }

  parts.push({
    text: `${candidates.length} image candidates extracted from a product catalog PDF page.
Page text context: "${lines.join(' | ') || 'none'}"

Each candidate is either an embedded bitmap photo from the PDF data stream,
or a cropped region of the page (a vector/raster product illustration rendered to pixels).

TASK: Select ALL candidates that show a complete, recognisable product image or product illustration.

✅ ALWAYS INCLUDE:
- Product photos (any angle — top, side, front, 3/4 view) showing the COMPLETE product
- Product technical illustrations or spec drawings, even if dimension lines, arrows, or measurement annotations are overlaid — as long as the WHOLE product shape is visible
- Vector-style product renderings (even simplified line art or coloured shapes), as long as the full product is shown

❌ ALWAYS EXCLUDE:
- Pantone chips / RAL swatches / NCS chips — a solid colour rectangle with only a colour code beneath it (e.g. "PANTONE® 7421 C", "RAL 3000"). No product shape visible.
- Brand logos or company marks with no product shown
- Pure text blocks (specification tables, dimension lists) with no product visual
- Decorative page borders, rules, or dividers
- Completely blank or solid-white images
- PARTIAL crops — images showing only a fragment of a product (e.g. just the legs, just the base, just a corner) where the FULL product silhouette cannot be seen. isComplete must be false for these.
- If a cropped region and a bitmap clearly show the same product from the same angle, include ONLY the bitmap (higher quality), set isComplete=false for the duplicate crop.

Return ONLY a JSON array — one entry per product image found, empty [] if none:
[
  {
    "index": 0,
    "isComplete": true,
    "needsBgRemoval": true,
    "hasHuman": false
  }
]

index: 0-based position in the list above (Image 1 = index 0, Image 2 = index 1, ...).
isComplete: true ONLY if the image shows the full, recognisable product. false if partial, fragment, or duplicate of a better image already in the list.
needsBgRemoval: true if background is not pure white (#FFFFFF). When in doubt → true.
hasHuman: true if any person, body part, or human reflection is visible.`
  })

  try {
    const response = await withRetry(() => ai.models.generateContent({
      model:    'gemini-2.5-flash',
      contents: { parts },
    }))
    const text   = response.candidates[0].content.parts.find(p => p.text)?.text || ''
    const result = JSON.parse(text.replace(/```json|```/g, '').trim())

    const selected = result
      .filter(r => typeof r.index === 'number' && r.index >= 0 && r.index < candidates.length && r.isComplete !== false)
      .map(r => ({
        index:          r.index + 1,  // +1 maps back into images[] (images[0] is fullPage)
        needsBgRemoval: r.needsBgRemoval ?? true,
        hasHuman:       r.hasHuman      ?? false,
      }))

    return selected.length > 0 ? selected : [{ index: 1, needsBgRemoval: true, hasHuman: false }]
  } catch {
    return [{ index: 1, needsBgRemoval: true, hasHuman: false }]
  }
}

// ═══════════════════════════════════════════════════════════
// STEP 2 — GEMINI: fix orientation
// ═══════════════════════════════════════════════════════════

const fixOrientation = async (buffer, mimeType) => {
  try {
    const { buffer: small, mimeType: sm } = await resizeForGemini(buffer, mimeType, 1000)
    const response = await withRetry(() => ai.models.generateContent({
      model:    'gemini-2.5-flash',
      contents: {
        parts: [
          { inlineData: { data: small.toString('base64'), mimeType: sm } },
          { text: `Look at this product image and determine if it needs rotation to appear upright.

Return ONLY JSON:
{"correct": true}
OR
{"correct": false, "rotation": 90}

Rules:
- "correct": true ONLY if the product is already perfectly upright with no rotation needed.
- If the product is rotated in ANY way (sideways, upside down, tilted), return "correct": false
  with the exact degrees needed to make it upright.
- rotation must be one of: 90, 180, 270
- NEVER reject or skip an image for any reason — always return the best rotation.
- Do NOT add "flip" unless the image is a literal mirror-image (text reversed).
- Side-view, angled, or 3/4 view images are acceptable — just make sure they are upright.` },
        ],
      },
    }))

    const text   = response.candidates[0].content.parts.find(p => p.text)?.text || ''
    const result = JSON.parse(text.replace(/```json|```/g, '').trim())
    if (result.correct) return { buffer, mimeType }

    const img     = await loadImage(buffer)
    const deg     = result.rotation || 0
    const flip    = result.flip
    const swapped = deg === 90 || deg === 270
    const w       = swapped ? img.height : img.width
    const h       = swapped ? img.width  : img.height
    const canvas  = createCanvas(w, h)
    const ctx     = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.save()
    ctx.translate(w / 2, h / 2)
    if (deg)  ctx.rotate((deg * Math.PI) / 180)
    if (flip === 'horizontal') ctx.scale(-1,  1)
    if (flip === 'vertical')   ctx.scale( 1, -1)
    ctx.drawImage(img, -img.width / 2, -img.height / 2)
    ctx.restore()
    return { buffer: canvas.toBuffer('image/png'), mimeType: 'image/png' }
  } catch {
    return { buffer, mimeType }
  }
}

// ═══════════════════════════════════════════════════════════
// DIMENSION PARSER — post-process Gemini's raw string
// as a safety net when individual fields come back null
// ═══════════════════════════════════════════════════════════

const parseDimensionsFromRaw = (raw) => {
  if (!raw) return {}

  // ── Step 1: resolve ranges like "30-35"
  // Strategy: keep MAX of the range (will map to length/largest dim)
  // The MIN is discarded here — positional/label assignment handles ordering
  const s0 = raw.replace(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/g, (_, a, b) =>
    String(Math.max(parseFloat(a), parseFloat(b)))
  )

  // ── Step 2: normalise separators
  const s = s0
    .replace(/\s*[x×X]\s*/gi, 'x')
    .replace(/\s*[\/]\s*/g, 'x')
    .replace(/,/g, '.')

  // ── Step 3: detect unit
  let measurement = null
  if (/cm|centimeter|centimetre|cms/i.test(s))  measurement = 'cm'
  else if (/"|inch|inches|\bin\b/i.test(s))       measurement = 'in'

  // ── Step 4a: word-labelled — handles both directions, first match wins
  // "30 cm length × 12 cm width"  AND  "Length: 120 cm Width: 60 cm"
  const labelled = {}
  const setFirst = (slot, val) => { if (!(slot in labelled)) labelled[slot] = val }

  // direction 1: label → number  ("Length: 120")
  const ltnPat = /(length|width|height|depth|breadth|thickness|diameter)\s*:?\s*(\d+(?:\.\d+)?)/gi
  let lt
  while ((lt = ltnPat.exec(s)) !== null) {
    const key = lt[1].toLowerCase(), val = parseFloat(lt[2])
    if      (key === 'length')                     setFirst('L',   val)
    else if (key === 'width' || key === 'breadth') setFirst('W',   val)
    else if (key === 'height')                     setFirst('H',   val)
    else if (key === 'depth')                      setFirst('D',   val)
    else if (key === 'thickness')                  setFirst('T',   val)
    else if (key === 'diameter')                   setFirst('DIA', val)
  }

  // direction 2: number → label  ("30 cm length")
  const ntlPat = /(\d+(?:\.\d+)?)\s*(?:cm|mm|inch|in|")?\s*(length|width|height|depth|breadth|thickness|diameter)/gi
  let nl
  while ((nl = ntlPat.exec(s)) !== null) {
    const key = nl[2].toLowerCase(), val = parseFloat(nl[1])
    if      (key === 'length')                     setFirst('L',   val)
    else if (key === 'width' || key === 'breadth') setFirst('W',   val)
    else if (key === 'height')                     setFirst('H',   val)
    else if (key === 'depth')                      setFirst('D',   val)
    else if (key === 'thickness')                  setFirst('T',   val)
    else if (key === 'diameter')                   setFirst('DIA', val)
  }

  if (Object.keys(labelled).length >= 2) {
    return {
      length:      labelled['L'] ?? labelled['DIA'] ?? null,
      width:       labelled['W'] ?? labelled['D']   ?? labelled['T'] ?? null,
      height:      labelled['H'] ?? labelled['T']   ?? null,
      measurement,
    }
  }

  // ── Step 4b: short prefix-labelled — W:80 D:40 H:75 or L120 W60 H45 (first match wins)
  const prefixLabelled = {}
  const labelPat = /([WLDH])\s*:?\s*(\d+(?:\.\d+)?)/gi
  let lm
  while ((lm = labelPat.exec(s)) !== null) {
    const slot = lm[1].toUpperCase()
    if (!(slot in prefixLabelled)) prefixLabelled[slot] = parseFloat(lm[2])
  }

  if (Object.keys(prefixLabelled).length >= 2) {
    return {
      length:      prefixLabelled['L'] ?? prefixLabelled['D'] ?? null,
      width:       prefixLabelled['W'] ?? prefixLabelled['B'] ?? null,
      height:      prefixLabelled['H'] ?? null,
      measurement,
    }
  }

  // ── Step 4c: positional — take first 3 numbers in document order, then sort
  // Capped at 3 so joined multi-section strings (6+ numbers) don't bleed in.
  // Assumes item dims appear before packed/carton dims in the slide (true for current templates).
  // If that ever changes, prefer the 3-number group with smaller values instead.
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)/g)]
    .map(m => parseFloat(m[1]))
    .slice(0, 3)
    .sort((a, b) => b - a)  // biggest→length, middle→width, smallest→height
  if (!nums.length) return { measurement }

  return {
    length:  nums[0] ?? null,
    width:   nums[1] ?? null,
    height:  nums[2] ?? null,
    measurement,
  }
}

// ═══════════════════════════════════════════════════════════
// STEP 3 — GEMINI: extract product fields (improved)
// Runs on the ORIENTED best image + full slide text
// ═══════════════════════════════════════════════════════════

const extractFieldsWithGemini = async (buffer, mimeType, lines = []) => {
  const { buffer: hires, mimeType: hm } = await resizeForGemini(buffer, mimeType, 1600)

  // Pass the full text as a rich, readable block
  const slideText = lines.length
    ? `\nAll text found on this slide/page (includes shape labels, callout annotations, dimension callouts, arrows pointing at product parts, table cells, and all text boxes):\n${lines.map(l => `  • ${l}`).join('\n')}`
    : '\n(No text extracted from slide)'

  const prompt = `You are a product data extractor for a furniture/homewares catalog.
Analyse the image AND the text below carefully.
${slideText}

Return ONLY valid JSON with no markdown, no explanation:
{
  "description":    "product name as it appears, or null",
  "material":       "exact material(s) stated, or null",
  "dimensions_raw": "the COMPLETE dimension string exactly as it appears (e.g. '120 x 60 x 45 cm',Labels to recognise: L, W, H, D, B, T, Depth, Breadth, Thickness, Diameter, DIA, 
   Length, Width, Height, Size, dim, overall, ext, int, inner, outer, 'W80 D40 H75 cm', '32\\"x18\\"x12\\"'), or null",
  "length":         <number or null>,
  "width":          <number or null>,
  "height":         <number or null>,
  "measurement":    "cm" or "in" or null,
  "finish":         "exact finish/colour stated, or null",
  "weight":         <number in kg or null>
}

DIMENSION RULES — read carefully:
1. Scan both the image AND the slide text for any dimension pattern.
   Common patterns: 120x60x45cm | W:80 D:40 H:75 | 80/40/75 cm | L120 W60 H45 | 32"×18"×12" | SIZE (INCHES): 24X24X18 | SIZE (CM): 30X20X10
Also check for: callout bubbles, leader lines with text, arrows with labels,
   dimension annotations drawn on the product image, table rows with spec data,
   text boxes anywhere on the slide even outside the main content area.
1b. If a dimension is given as a RANGE (e.g. "30-35 cm"), use the MAXIMUM value
   (e.g. 35). Never leave a range as-is in the numeric fields.
2. Always populate dimensions_raw with the exact string you found before parsing it.
   If a value is a RANGE (e.g. "30-35"), use the MAXIMUM as the number (e.g. 35).
3. Strip units from numbers — put unit in "measurement" only.
4. Unit normalisation:
   - "cm", "cms", "centimeter", "centimetre" → "cm"
   - '"', "in", "inch", "inches" → "in"
5. Dimension order mapping:
   - LxWxH or LxDxH  → length=L, width=W/D, height=H
   - WxDxH            → length=W, width=D, height=H
   - If labelled (W:, D:, H:, L:) use the labels directly
   - If unlabelled with 3 values: assign largest→length, middle→width, smallest→height
   - If only 1 or 2 values: fill what you can, null the rest
6. weight: number in kg only. Convert grams → kg. Null if absent.
7. NEVER invent or guess values. Only extract what is explicitly visible in the image or text.
8. If the same field appears in both image and text and they differ, prefer the text value.`

  try {
    const response = await withRetry(() => ai.models.generateContent({
      model:    'gemini-2.5-flash',
      contents: {
        parts: [
          { inlineData: { data: hires.toString('base64'), mimeType: hm } },
          { text: prompt },
        ],
      },
    }))
    const text   = response.candidates[0].content.parts.find(p => p.text)?.text || ''
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())

    // Priority 1: multi-line individual dimension labels give the most complete data.
    // Run unconditionally — overrides Gemini when it only returned a 2D string like "16.5 x 11cm".
    // e.g. ["Item Length: 12.5", "Item Width: 12.5", "Item height: 19.5"] → joined string
    if (lines.length) {
      const dimLines = lines.filter(l =>
        /(?:length|width|height|depth|diameter)\s*:?\s*\d+/i.test(l)
      )
      if (dimLines.length >= 3 || (!parsed.dimensions_raw && dimLines.length >= 2)) {
        parsed.dimensions_raw = dimLines.join(' ')
      }
    }

    // Priority 2: if still no dimensions_raw, scan for a single line with unit/x-pattern
    if (!parsed.dimensions_raw && lines.length) {
      const hasDimSig = (l) =>
        (/size\s*\((?:inches|cm|mm)\)/i.test(l)) ||
        (/\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*(?:cm|mm|in|inch|")/i.test(l)) ||
        (/\d+(?:\.\d+)?\s*[x×X]\s*\d+(?:\.\d+)?/i.test(l)) ||
        (/[LWDH]\s*:?\s*\d+/i.test(l))

      for (let i = 0; i < lines.length; i++) {
        if (!hasDimSig(lines[i])) continue
        if (/\d/.test(lines[i])) {
          parsed.dimensions_raw = lines[i]
        } else if (lines[i + 1] && /\d/.test(lines[i + 1])) {
          // Label-only line (e.g. "SIZE (INCHES):") followed by numbers
          parsed.dimensions_raw = lines[i] + ' ' + lines[i + 1]
        }
        if (parsed.dimensions_raw) break
      }
    }

    return parsed
  } catch {
    return {}
  }
}

// ═══════════════════════════════════════════════════════════
// STEP 4 — GEMINI: remove humans
// ═══════════════════════════════════════════════════════════

const removeHumans = async (buffer, mimeType, description = '') => {
  try {
    const response = await withRetry(() => ai.models.generateContent({
      model:    'gemini-2.5-flash-image',
      contents: {
        parts: [
          { inlineData: { data: buffer.toString('base64'), mimeType } },
          { text: `Product image${description ? ` — ${description}` : ''}.
Remove ALL humans and body parts from the image including:
- People standing in or near the product
- Human reflections visible inside mirrors or glass surfaces
- Partial body parts at image edges (arms, shoulders, hands)
Replace removed areas with surrounding background or a neutral fill.
Keep the product completely unchanged. Return cleaned image only.` },
        ],
      },
      config: { responseModalities: ['IMAGE', 'TEXT'] },
    }), 2, 2000)

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        return {
          buffer:   Buffer.from(part.inlineData.data, 'base64'),
          mimeType: part.inlineData.mimeType || 'image/png',
        }
      }
    }
  } catch (err) {
    console.warn('⚠️  Human removal failed:', err.message)
  }
  return { buffer, mimeType }
}

// ═══════════════════════════════════════════════════════════
// SANITISE + FALLBACK DIMENSION PARSE
// ═══════════════════════════════════════════════════════════

const sanitizeExtractedFields = (fields) => {
  const trim = (val, max) =>
    (!val || typeof val !== 'string') ? null : val.trim().slice(0, max) || null

  const toPositiveFloat = (val) => {
    if (val == null) return null
    const str = String(val).trim()
    // Handle range strings like "30-35" or "2–3" → take the max
    const rangeMatch = str.match(/^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/)
    if (rangeMatch) {
      const n = Math.max(parseFloat(rangeMatch[1]), parseFloat(rangeMatch[2]))
      return (!isNaN(n) && n > 0) ? n : null
    }
    const num = parseFloat(str.replace(/[^0-9.]/g, ''))
    return (!isNaN(num) && num > 0) ? num : null
  }

  // Robust unit normalisation
  const rawUnit = (fields.measurement || '').toLowerCase().trim()
  const measurement =
    ['cm', 'cms', 'centimeter', 'centimetre'].includes(rawUnit) ? 'cm' :
    ['in', 'inch', 'inches'].includes(rawUnit)                  ? 'in' : null

  // Primary: use Gemini's parsed values
  let length = toPositiveFloat(fields.length)
  let width  = toPositiveFloat(fields.width)
  let height = toPositiveFloat(fields.height)
  let unit   = measurement

  // Fallback: fill any null dimension from dimensions_raw using our own regex parser.
  // Runs if ANY field is missing (not just allNull), and for range values that Gemini
  // may have left as strings. Only overwrites null values or range cases.
  const hasRange = /\d+\s*[-–]\s*\d+/.test(fields.dimensions_raw || '')
  const anyNull  = length == null || width == null || height == null

  if (fields.dimensions_raw && (anyNull || hasRange)) {
    const parsed = parseDimensionsFromRaw(fields.dimensions_raw)
    if (parsed.length != null && (length == null || hasRange)) length = toPositiveFloat(parsed.length)
    if (parsed.width  != null && (width  == null || hasRange)) width  = toPositiveFloat(parsed.width)
    if (parsed.height != null && (height == null || hasRange)) height = toPositiveFloat(parsed.height)
    if (!unit && parsed.measurement) unit = parsed.measurement
  }

  // Slides often list dimensions without a unit (e.g. "Item Length: 12.5").
  // Default to cm so the UI can display the values.
  if (!unit && (length != null || width != null || height != null)) unit = 'cm'

  return {
    description: trim(fields.description, 500),
    material:    trim(fields.material,    300),
    length,
    width,
    height,
    measurement: unit,
    finish:      trim(fields.finish,      200),
    weight:      toPositiveFloat(fields.weight),
  }
}

// ═══════════════════════════════════════════════════════════
// UPLOAD
// ═══════════════════════════════════════════════════════════

const uploadImageToStorage = async (buffer, storagePath, mimeType = 'image/png') => {
  const { error } = await supabase.storage
    .from(NPD_BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType, upsert: false })
  if (error) throw error
  const { data } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)
  return data.publicUrl
}

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

// ═══════════════════════════════════════════════════════════
// PROCESS ONE SLIDE
// ═══════════════════════════════════════════════════════════

const processSlide = async (slide, uploadRow, basePath) => {
  const { slideIndex, lines, images, isPdf = false } = slide
  if (!images.length) return null

  console.log(`\n  ┌─ Slide ${slideIndex + 1} │ ${images.length} image(s) │ ${lines.length} text line(s)`)
  if (lines.length) console.log(`  │  Text: ${lines.slice(0, 5).join(' | ')}${lines.length > 5 ? ' …' : ''}`)

  // ── STEP 1: select best image ───────────────────────────
  const selection = await selectBestImage(images, lines, isPdf)
  const { bestIndex, needsBgRemoval, hasHuman, isUsable } = selection

  if (!isUsable) {
    console.log('  └─ Skipped — unusable')
    return null
  }

  const best = images[bestIndex]
  console.log(`  │  [1] Best: #${bestIndex + 1} │ needsBgRemoval: ${needsBgRemoval} │ hasHuman: ${hasHuman}`)

  // ── STEP 3: extract fields ──────────────────────────────
  let rawFields = await extractFieldsWithGemini(best.buffer, best.mimeType, lines).catch(() => ({}))
  let fields    = sanitizeExtractedFields(rawFields)

  // For PDF pages: if the best image (a cropped region or embedded bitmap) yielded
  // no spec data, retry with the full page render — the full page shows all spec text
  // alongside the product, giving Gemini more context to extract from.
  if (isPdf && bestIndex !== 0) {
    const noDetails = !fields.description && !fields.material && !fields.finish &&
                      fields.length == null && fields.width == null && fields.height == null
    if (noDetails) {
      console.log('  │  [3] No details from best image — retrying with full page render...')
      const fullPageRaw = await extractFieldsWithGemini(images[0].buffer, images[0].mimeType, lines).catch(() => ({}))
      const fullPageFields = sanitizeExtractedFields(fullPageRaw)
      const fallbackHasDetails = fullPageFields.description || fullPageFields.material ||
                                 fullPageFields.finish || fullPageFields.length != null
      if (fallbackHasDetails) {
        rawFields = fullPageRaw
        fields    = fullPageFields
        console.log('  │  [3] Fallback extraction succeeded from full page render')
      } else {
        // Check if this is a reference-only page (no specs, just photos for reference)
        const isRefPage = /\bref\b.*\bsample\b|\bfor\s+(?:design|reference|colour)\b|\bas\s+sample\b/i
          .test(lines.join(' '))
        if (isRefPage) {
          console.log('  └─ Skipped — reference-only page (no spec data extractable)')
          return null
        }
      }
    }
  }

  // Extract buyer SKU reference from slide text
  // Checks "Temporary Code" and "Buyer SKU Ref" label patterns
  let buyerSkuRef = null
  for (let i = 0; i < lines.length; i++) {
    const tmpCode = lines[i].match(/^temporary\s*code[:\s]+(.+)/i)
    if (tmpCode) { buyerSkuRef = tmpCode[1].trim() || null; break }
    if (/^temporary\s*code\s*:?\s*$/i.test(lines[i]) && lines[i + 1]) {
      buyerSkuRef = lines[i + 1].trim() || null; break
    }
    const buyerRefMatch = lines[i].match(/buyer\s*sku\s*ref\s*(.+)/i)
    if (buyerRefMatch) {
      const val = buyerRefMatch[1].split(/[,|]/)[0]
        .replace(/^[\s\-:=\t]+/, '')
        .trim()
      if (val) { buyerSkuRef = val; break }
    }
  }

  // Auto-link to production SKU — skip if value is "PENDING" or unresolved
  let matchedProductionSkuId = null
  if (buyerSkuRef && !/^pending$/i.test(buyerSkuRef)) {
    const skuQuery = supabase
      .from('skus')
      .select('id')
      .eq('buyer_sku_ref', buyerSkuRef)
    if (uploadRow.for_buyer_org_id) skuQuery.eq('buyer_org_id', uploadRow.for_buyer_org_id)
    const { data: matchedSku } = await skuQuery.maybeSingle()
    if (matchedSku) matchedProductionSkuId = matchedSku.id
    console.log(`  │  [tmp] buyerSkuRef="${buyerSkuRef}" for_buyer_org_id="${uploadRow.for_buyer_org_id || 'none'}" → matched=${matchedSku?.id || 'null'}`)
  }

  console.log(
    `  │  [3] desc="${fields.description || 'none'}"` +
    ` | dims=${fields.length ?? '-'}×${fields.width ?? '-'}×${fields.height ?? '-'} ${fields.measurement || '(no unit)'}` +
    ` | mat="${fields.material || 'none'}"` +
    ` | finish="${fields.finish || 'none'}"` +
    ` | weight=${fields.weight ?? '-'}kg`
  )
  console.log(
    `  │  [3] gemini_raw_dims="${rawFields.dimensions_raw || 'null'}"` +
    ` gemini_L=${rawFields.length ?? 'null'} gemini_W=${rawFields.width ?? 'null'} gemini_H=${rawFields.height ?? 'null'} gemini_unit="${rawFields.measurement || 'null'}`+`"`
  )

  // ── STEP 4: remove humans if detected ──────────────────
  let { buffer: cleaned, mimeType: cleanedMime } = { buffer: best.buffer, mimeType: best.mimeType }
  if (hasHuman) {
    ;({ buffer: cleaned, mimeType: cleanedMime } = await removeHumans(best.buffer, best.mimeType, fields.description || ''))
    console.log('  │  [4] Humans removed')
  }

  // ── STEP 5: remove background ───────────────────────────
  const isTransparentProduct = /glass|transparent|crystal|acrylic|clear glass/i.test(fields.description || '')
  let finalBuffer = cleaned
  let finalMime   = cleanedMime
  if (needsBgRemoval && !isTransparentProduct) {
    ;({ buffer: finalBuffer, mimeType: finalMime } = await removeBackground(cleaned, cleanedMime, fields.description || ''))
    console.log('  │  [5] BG removed')
  } else if (isTransparentProduct) {
    console.log('  │  [5] BG removal skipped — transparent/glass product')
  } else {
    ;({ buffer: finalBuffer, mimeType: finalMime } = await enhanceImage(cleaned, cleanedMime, fields.description || ''))
    console.log('  │  [5] BG already white — enhanced')
  }

  // ── STEP 6: pad to square ───────────────────────────────
  ;({ buffer: finalBuffer, mimeType: finalMime } = await padToSquare(finalBuffer, finalMime, 8))
  console.log('  │  [6] Padded to square')

  // ── STEP 7 + 8: upload & insert with collision retry ───
  let sku
  for (let attempt = 0; attempt < 5; attempt++) {
    const autoCode = await generateAutoCode()
    const storPath = `${basePath}/skus/${autoCode}.png`
    const imageUrl = await uploadImageToStorage(finalBuffer, storPath, 'image/png')

    const { data, error } = await supabase
      .from('npd2_catalog_skus')
      .insert([{
        catalog_upload_id: uploadRow.id,
        auto_code:         autoCode,
        image_url:         imageUrl,
        slide_index:       slideIndex,
        category:          fields.category || uploadRow.category || null,
        description:       fields.description  || null,
        material:          fields.material      || null,
        length:            fields.length        ?? null,
        width:             fields.width         ?? null,
        height:            fields.height        ?? null,
        dimensions:        (fields.length != null || fields.width != null || fields.height != null)
          ? [fields.length, fields.width, fields.height].filter(v => v != null).join(' x ') + (fields.measurement ? ` ${fields.measurement}` : '')
          : null,
        measurement:       fields.measurement   || null,
        finish:            fields.finish        || null,
        weight:            fields.weight        ?? null,
        temp_sku_ref:      buyerSkuRef          || null,
        production_sku_id: matchedProductionSkuId,
      }])
      .select()
      .single()

    if (!error) { sku = data; console.log(`  └─ ✅ ${autoCode} saved`); break }
    if (!error.message.includes('auto_code')) throw error
    console.warn(`  ⚠️  auto_code collision on ${autoCode} (attempt ${attempt + 1}) — retrying`)
  }
  if (!sku) throw new Error('Failed to insert SKU after 5 auto_code collision retries')
  return { ...sku, supplier: uploadRow.supplier, season: uploadRow.season }
}

// ═══════════════════════════════════════════════════════════
// PDF: process one page → one SKU per product image found
// ═══════════════════════════════════════════════════════════

const processPdfSlide = async (slide, uploadRow, basePath) => {
  const { slideIndex, lines, images } = slide

  console.log(`\n  ┌─ PDF Page ${slideIndex + 1} │ ${images.length} candidate(s) │ ${lines.length} text line(s)`)
  if (lines.length) console.log(`  │  Text: ${lines.slice(0, 5).join(' | ')}${lines.length > 5 ? ' …' : ''}`)

  // ── Extract spec fields once from full page render (has all text in context) ──
  const rawFields = await extractFieldsWithGemini(images[0].buffer, images[0].mimeType, lines).catch(() => ({}))
  const fields    = sanitizeExtractedFields(rawFields)
  console.log(
    `  │  [spec] desc="${fields.description || 'none'}"` +
    ` | dims=${fields.length ?? '-'}×${fields.width ?? '-'}×${fields.height ?? '-'} ${fields.measurement || '(no unit)'}` +
    ` | mat="${fields.material || 'none'}" | finish="${fields.finish || 'none'}"`
  )

  // ── Buyer SKU ref (shared across all images on this page) ──
  let buyerSkuRef = null
  for (let i = 0; i < lines.length; i++) {
    const same = lines[i].match(/^temporary\s*code[:\s]+(.+)/i)
    if (same) { buyerSkuRef = same[1].trim() || null; break }
    if (/^temporary\s*code\s*:?\s*$/i.test(lines[i]) && lines[i + 1]) {
      buyerSkuRef = lines[i + 1].trim() || null; break
    }
  }
  let matchedProductionSkuId = null
  if (buyerSkuRef) {
    const skuQuery = supabase.from('skus').select('id').eq('buyer_sku_ref', buyerSkuRef)
    if (uploadRow.for_buyer_org_id) skuQuery.eq('buyer_org_id', uploadRow.for_buyer_org_id)
    const { data: matchedSku } = await skuQuery.maybeSingle()
    if (matchedSku) matchedProductionSkuId = matchedSku.id
  }

  // ── Process ALL extracted images (skip index 0 = full-page render) ──
  // images[1..] = embedded bitmaps then vector crops — process every one, no filtering
  const candidates = images.slice(1)
  console.log(`  │  Processing all ${candidates.length} extracted image(s) (bitmaps + crops)`)

  const skus = []
  for (let pi = 0; pi < candidates.length; pi++) {
    const img = candidates[pi]
    console.log(`\n  │  ── Image ${pi + 1}/${candidates.length} (type: ${img.type || 'image'}) ──`)

    try {
      // BG removal always applied — every image needs clean white background
      let { buffer: finalBuffer, mimeType: finalMime } = await removeBackground(img.buffer, img.mimeType, fields.description || '')
      console.log('  │     [5] BG removed')

      // Pad to square
      ;({ buffer: finalBuffer, mimeType: finalMime } = await padToSquare(finalBuffer, finalMime, 8))
      console.log('  │     [6] Padded to square')

      // Upload & insert with collision retry
      let sku
      for (let attempt = 0; attempt < 5; attempt++) {
        const autoCode = await generateAutoCode()
        const storPath = `${basePath}/skus/${autoCode}.png`
        const imageUrl = await uploadImageToStorage(finalBuffer, storPath, 'image/png')

        const { data, error } = await supabase
          .from('npd2_catalog_skus')
          .insert([{
            catalog_upload_id: uploadRow.id,
            auto_code:         autoCode,
            image_url:         imageUrl,
            slide_index:       slideIndex,
            category:          uploadRow.category || null,
            description:       fields.description  || null,
            material:          fields.material      || null,
            length:            fields.length        ?? null,
            width:             fields.width         ?? null,
            height:            fields.height        ?? null,
            dimensions:        (fields.length != null || fields.width != null || fields.height != null)
              ? [fields.length, fields.width, fields.height].filter(v => v != null).join(' x ') + (fields.measurement ? ` ${fields.measurement}` : '')
              : null,
            measurement:       fields.measurement   || null,
            finish:            fields.finish        || null,
            weight:            fields.weight        ?? null,
            temp_sku_ref:      buyerSkuRef          || null,
            production_sku_id: matchedProductionSkuId,
          }])
          .select()
          .single()

        if (!error) { sku = data; console.log(`  │     ✅ ${autoCode} saved`); break }
        if (!error.message.includes('auto_code')) throw error
        console.warn(`  │     ⚠️  auto_code collision on ${autoCode} (attempt ${attempt + 1}) — retrying`)
      }
      if (!sku) throw new Error('Failed to insert SKU after 5 auto_code collision retries')
      skus.push({ ...sku, supplier: uploadRow.supplier, season: uploadRow.season })
    } catch (imgErr) {
      console.warn(`  │     ❌ Image ${pi + 1}/${candidates.length} failed: ${imgErr.message} — continuing`)
    }
  }

  console.log(`  └─ Page ${slideIndex + 1} done — ${skus.length}/${candidates.length} SKU(s) created`)
  return skus
}

// ═══════════════════════════════════════════════════════════
// BUYER-SPEC PDF: extract structured spec sheet fields
// Looks at all slide text + the spec-table page image (page 2
// if available, else page 1) to pull NAME, SUPPLIER, COLOUR etc.
// ═══════════════════════════════════════════════════════════

const extractSpecSheetData = async (slides) => {
  const allLines = slides.flatMap(s => s.lines || [])
  const allText  = allLines.length
    ? `All text found on the spec sheet (all pages combined):\n${allLines.map(l => `  • ${l}`).join('\n')}`
    : '(No text extracted from spec sheet)'

  // The structured spec table is usually on page 2; fall back to page 1
  const specSlide = slides.length > 1 ? slides[1] : slides[0]
  const { buffer: hires, mimeType: hm } = await resizeForGemini(
    specSlide.images[0].buffer, specSlide.images[0].mimeType, 1600
  )

  const prompt = `You are extracting structured product data from a buyer spec sheet.
Look carefully at BOTH the image AND all the text below.
${allText}

Return ONLY valid JSON — no markdown, no explanation:
{
  "name":          "product name as written, or null",
  "supplier":      "supplier / vendor name, or null",
  "main_category": "main category, or null",
  "sub_category":  "sub-category, or null",
  "description":   "product type / description label, or null",
  "unit":          "unit of sale (e.g. Pcs, Set), or null",
  "qty_of_items":  "quantity of items per unit, or null",
  "colour":        "colour name, or null",
  "web_colour":    "web colour name, or null",
  "material":      "material(s), or null",
  "logo":          "logo requirement, or null",
  "size":          "full size/dimension string exactly as stated, or null",
  "packaging":     "packaging information, or null",
  "date_created":  "date created or revised, or null",
  "notes":         "any callout annotations or special instructions visible on the spec, or null"
}

Extract ONLY values explicitly stated — do not guess or invent. Return null for any field not found.`

  try {
    const response = await withRetry(() => ai.models.generateContent({
      model:    'gemini-2.5-flash',
      contents: { parts: [
        { inlineData: { data: hires.toString('base64'), mimeType: hm } },
        { text: prompt },
      ]},
    }))
    const text = response.candidates[0].content.parts.find(p => p.text)?.text || ''
    return JSON.parse(text.replace(/```json|```/g, '').trim())
  } catch {
    return {}
  }
}

// ═══════════════════════════════════════════════════════════
// BUYER-SPEC PDF: process every image, create ONE SKU
// All processed images saved to spec_images so user can pick
// the main one and keep the rest as reference media
// ═══════════════════════════════════════════════════════════

const processBuyerSpecPdf = async (slides, uploadRow, basePath) => {
  console.log(`\n  ┌─ Buyer-Spec PDF — ${slides.length} page(s)`)

  // Extract spec fields once from the first slide's full-page render
  const firstSlide = slides[0]
  const rawFields  = await extractFieldsWithGemini(
    firstSlide.images[0].buffer, firstSlide.images[0].mimeType, firstSlide.lines
  ).catch(() => ({}))
  const fields = sanitizeExtractedFields(rawFields)
  console.log(
    `  │  [spec] desc="${fields.description || 'none'}"` +
    ` | mat="${fields.material || 'none'}" | finish="${fields.finish || 'none'}"`
  )

  // Buyer SKU ref from first slide text
  let buyerSkuRef = null
  const lines0 = firstSlide.lines
  for (let i = 0; i < lines0.length; i++) {
    const same = lines0[i].match(/^temporary\s*code[:\s]+(.+)/i)
    if (same) { buyerSkuRef = same[1].trim() || null; break }
    if (/^temporary\s*code\s*:?\s*$/i.test(lines0[i]) && lines0[i + 1]) {
      buyerSkuRef = lines0[i + 1].trim() || null; break
    }
  }
  let matchedProductionSkuId = null
  if (buyerSkuRef) {
    const skuQuery = supabase.from('skus').select('id').eq('buyer_sku_ref', buyerSkuRef)
    if (uploadRow.for_buyer_org_id) skuQuery.eq('buyer_org_id', uploadRow.for_buyer_org_id)
    const { data: matchedSku } = await skuQuery.maybeSingle()
    if (matchedSku) matchedProductionSkuId = matchedSku.id
  }

  // Flatten all candidates from all slides, preserving page/image order
  const allCandidates = []
  for (const slide of slides) {
    const candidates = slide.images.slice(1).length > 0
      ? slide.images.slice(1)
      : [slide.images[0]]
    candidates.forEach((img, pi) =>
      allCandidates.push({ img, slideIndex: slide.slideIndex, pi })
    )
  }
  console.log(`  │  ${allCandidates.length} total image(s) across ${slides.length} page(s) — processing in parallel (concurrency: 8)`)

  // Generate autoCode before image uploads so filenames are traceable by SKU code
  const autoCode = await generateAutoCode()

  // Upload full-page PNG renders (3× scale, lossless) — one per PDF page
  // Stored first in reference_media so users see the full spec layout before product crops
  const pgLimit   = pLimit(4)
  const pageRenders = (await Promise.all(
    slides.map((slide, idx) =>
      pgLimit(async () => {
        try {
          const { buffer } = slide.images[0]
          const storPath   = `${basePath}/pages/${autoCode}_page${idx + 1}.png`
          const url        = await uploadImageToStorage(buffer, storPath, 'image/png')
          console.log(`  │     ✅ page render ${idx + 1}/${slides.length} uploaded`)
          return { url, pageIndex: idx, source: 'spec_page', type: 'fullPage' }
        } catch (err) {
          console.warn(`  │     ❌ page render ${idx + 1} failed: ${err.message}`)
          return null
        }
      })
    )
  )).filter(Boolean)
  console.log(`  │  ${pageRenders.length}/${slides.length} page render(s) ready`)

  // Process all images in parallel — 8 concurrent BG removals + uploads
  const isTransparentSpec = /glass|transparent|crystal|acrylic|clear glass/i.test(fields.description || '')
  const imgLimit = pLimit(parseInt(process.env.IMAGE_CONCURRENCY || '8'))
  const results  = await Promise.all(
    allCandidates.map(({ img, slideIndex, pi }, idx) =>
      imgLimit(async () => {
        try {
          let { buffer: finalBuffer, mimeType: finalMime } = isTransparentSpec
            ? { buffer: img.buffer, mimeType: img.mimeType }
            : await removeBackground(img.buffer, img.mimeType, fields.description || '')
          ;({ buffer: finalBuffer, mimeType: finalMime } = await padToSquare(finalBuffer, finalMime, 8))
          const storPath = `${basePath}/refs/${autoCode}_${idx + 1}.png`
          const imageUrl = await uploadImageToStorage(finalBuffer, storPath, 'image/png')
          console.log(`  │     ✅ ${autoCode}_${idx + 1}.png uploaded`)
          return { url: imageUrl, pageIndex: slideIndex, source: 'spec', type: img.type || 'image' }
        } catch (imgErr) {
          console.warn(`  │     ❌ Page ${slideIndex + 1} img ${pi + 1} failed: ${imgErr.message}`)
          return null
        }
      })
    )
  )

  // Promise.all preserves original order so processedImages[0] is always page 1 img 1
  const processedImages = results.filter(Boolean)

  if (!processedImages.length) throw new Error('No images could be processed from buyer-spec PDF')

  // Save ALL processed image URLs to spec_images — frontend uses these so user can pick main/reference
  await supabase
    .from('npd2_catalog_uploads')
    .update({ spec_images: processedImages })
    .eq('id', uploadRow.id)

  // Create ONE SKU — image_url = first processed image (user overrides via confirm route)
  // autoCode was pre-generated above (before image uploads) so filenames match the SKU code
  const { data: sku, error: skuErr } = await supabase
    .from('npd2_catalog_skus')
    .insert([{
      catalog_upload_id: uploadRow.id,
      auto_code:         autoCode,
      image_url:         processedImages[0].url,
        slide_index:       0,
        category:          uploadRow.category || null,
        description:       fields.description  || null,
        material:          fields.material      || null,
        length:            fields.length        ?? null,
        width:             fields.width         ?? null,
        height:            fields.height        ?? null,
        dimensions:        (fields.length != null || fields.width != null || fields.height != null)
          ? [fields.length, fields.width, fields.height].filter(v => v != null).join(' x ') + (fields.measurement ? ` ${fields.measurement}` : '')
          : null,
        measurement:       fields.measurement   || null,
        finish:            fields.finish        || null,
        weight:            fields.weight        ?? null,
        temp_sku_ref:      buyerSkuRef          || null,
        production_sku_id: matchedProductionSkuId,
      }])
      .select()
      .single()
  if (skuErr) throw skuErr
  console.log(`  │  ✅ SKU ${autoCode} created`)

  // Create workspace immediately — no confirm step needed from frontend
  const { data: ws, error: wsErr } = await supabase
    .from('npd2_workspaces')
    .insert({
      catalog_sku_id:     sku.id,
      buyer_org_id:       uploadRow.for_buyer_org_id,
      supplier_org_id:    uploadRow.supplier_org_id,
      merchant_member_id: uploadRow.created_by_member_id,
      origin:             'buyer_spec',
      status:             'inactive',
      reference_media:    [...pageRenders, ...processedImages],
    })
    .select('id')
    .single()
  if (wsErr) throw wsErr
  console.log(`  │  ✅ Workspace created (inactive)`)

  console.log(`  └─ Done — 1 SKU, ${pageRenders.length} page render(s) + ${processedImages.length} product image(s) in reference media`)
  return { ...sku, supplier: uploadRow.supplier, season: uploadRow.season }
}

// ═══════════════════════════════════════════════════════════
// IMAGE PROCESSING MODE — background-remove a single SKU image
// ═══════════════════════════════════════════════════════════

const extractStoragePath = (publicUrl) => {
  const marker = `/storage/v1/object/public/${NPD_BUCKET}/`
  const idx    = publicUrl.indexOf(marker)
  if (idx === -1) throw new Error(`Cannot parse storage path from URL: ${publicUrl}`)
  return publicUrl.slice(idx + marker.length).split('?')[0]
}

const processSkuImage = async (skuId) => {
  console.log(`\n  ┌─ SKU ${skuId}`)

  const { data: sku, error: skuErr } = await supabase
    .from('npd2_catalog_skus')
    .select('id, image_url, description, auto_code')
    .eq('id', skuId)
    .single()
  if (skuErr) throw skuErr
  if (!sku.image_url) throw new Error('SKU has no image_url')

  const storagePath = extractStoragePath(sku.image_url)
  const { data: fileData, error: fileErr } = await supabase.storage.from(NPD_BUCKET).download(storagePath)
  if (fileErr) throw fileErr

  const buffer   = Buffer.from(await fileData.arrayBuffer())
  const extPart  = storagePath.split('.').pop()?.toLowerCase() || 'jpg'
  const mimeType = extPart === 'png' ? 'image/png' : extPart === 'webp' ? 'image/webp' : 'image/jpeg'

  // Analyse image
  const { needsBgRemoval, hasHuman } = await selectBestImage([{ buffer, mimeType }], [], false)
  console.log(`  │  needsBgRemoval: ${needsBgRemoval} │ hasHuman: ${hasHuman}`)

  // Remove humans if needed
  let { buffer: cleaned, mimeType: cleanedMime } = { buffer, mimeType }
  if (hasHuman) {
    ;({ buffer: cleaned, mimeType: cleanedMime } = await removeHumans(buffer, mimeType, sku.description || ''))
    console.log('  │  [4] Humans removed')
  }

  // Remove background
  let finalBuffer = cleaned
  let finalMime   = cleanedMime
  if (needsBgRemoval) {
    ;({ buffer: finalBuffer, mimeType: finalMime } = await removeBackground(cleaned, cleanedMime, sku.description || ''))
    console.log('  │  [5] BG removed')
  } else {
    ;({ buffer: finalBuffer, mimeType: finalMime } = await enhanceImage(cleaned, cleanedMime, sku.description || ''))
    console.log('  │  [5] BG already white — enhanced')
  }

  // Pad to square
  ;({ buffer: finalBuffer, mimeType: finalMime } = await padToSquare(finalBuffer, finalMime, 8))
  console.log('  │  [6] Padded to square')

  // Overwrite original path
  const { error: upErr } = await supabase.storage
    .from(NPD_BUCKET)
    .upload(storagePath, finalBuffer, { contentType: 'image/png', upsert: true })
  if (upErr) throw upErr

  // Append cache-buster so browsers don't serve the old image
  const { data: { publicUrl } } = supabase.storage.from(NPD_BUCKET).getPublicUrl(storagePath)
  const freshUrl = `${publicUrl}?t=${Date.now()}`

  const { error: updateErr } = await supabase
    .from('npd2_catalog_skus')
    .update({ image_url: freshUrl, image_processing: false })
    .eq('id', skuId)
  if (updateErr) throw updateErr

  console.log(`  └─ ✅ ${sku.auto_code || skuId} done`)
}

const runImageProcessing = async () => {
  console.log(`\n🖼️  Image processing mode — ${SKU_IDS.length} SKU(s): ${SKU_IDS.join(', ')}`)

  const IMAGE_CONCURRENCY = parseInt(process.env.IMAGE_CONCURRENCY || '5')
  console.log(`   Concurrency: ${IMAGE_CONCURRENCY}\n`)
  const limit  = pLimit(IMAGE_CONCURRENCY)
  const failed = []

  await Promise.all(
    SKU_IDS.map(skuId =>
      limit(async () => {
        try {
          await processSkuImage(skuId)
        } catch (err) {
          failed.push({ skuId, error: err.message })
          console.warn(`  ❌ SKU ${skuId} failed: ${err.message}`)
          await supabase.from('npd2_catalog_skus')
            .update({ image_processing: false })
            .eq('id', skuId)
            .catch(() => {})
        }
      })
    )
  )

  console.log(`\n✅ Done — ${SKU_IDS.length - failed.length}/${SKU_IDS.length} succeeded`)
  if (failed.length) console.log('⚠️  Failed:', failed)
  process.exit(failed.length > 0 ? 1 : 0)
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

const run = async () => {
  console.log(`\n🔧 Worker starting — upload: ${UPLOAD_ID}`)
  console.log(`   Concurrency: ${SLIDE_CONCURRENCY}\n`)

  try {
    const { data: uploadRow, error: uploadErr } = await supabase
      .from('npd2_catalog_uploads')
      .select('*')
      .eq('id', UPLOAD_ID)
      .single()
    if (uploadErr) throw uploadErr

    if (uploadRow.status === 'done') {
      console.log('⚠️  Upload already done — exiting to prevent duplicates')
      process.exit(0)
    }
    if (uploadRow.status === 'processing') {
      console.log('⚠️  Upload already processing — exiting to prevent duplicates')
      process.exit(0)
    }

    console.log(`📁 ${uploadRow.source_filename} (${uploadRow.source_ext})`)

    const toSlug = (str) =>
      (str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase()

    let supplierSlug = 'unknown_supplier'
    let categorySlug = null

    if (uploadRow.supplier_org_id) {
      const { data: org } = await supabase
        .from('organizations')
        .select('display_name')
        .eq('id', uploadRow.supplier_org_id)
        .single()
      if (org?.display_name) supplierSlug = toSlug(org.display_name)
    }

    if (uploadRow.category_id) {
      const { data: cat } = await supabase
        .from('categories')
        .select('name')
        .eq('id', uploadRow.category_id)
        .single()
      if (cat?.name) categorySlug = toSlug(cat.name)
    }

    const seasonSlug = toSlug(uploadRow.season || 'unknown')
    const basePath   = uploadRow.supplier_org_id
      ? (categorySlug
          ? `catalog/${supplierSlug}/${seasonSlug}/${categorySlug}`
          : `catalog/${supplierSlug}/${seasonSlug}`)
      : `catalog/${uploadRow.id}`

    console.log(`📂 basePath: ${basePath}`)

    const { data: fileData, error: fileErr } = await supabase.storage
      .from(NPD_BUCKET)
      .download(uploadRow.source_file_path)
    if (fileErr) throw fileErr

    let fileBuffer = Buffer.from(await fileData.arrayBuffer())
    const ext        = (uploadRow.source_ext || EXT || '').toLowerCase()

    console.log('\n📄 Extracting slides...')
    const isPdfJob = ext === '.pdf'
    const slides   = isPdfJob
      ? await extractSlidesFromPdf(fileBuffer)
      : await extractSlidesFromPptx(fileBuffer)

    // Then lower concurrency for PDF:
    const effectiveConcurrency = isPdfJob
      ? Math.min(SLIDE_CONCURRENCY, 10)
      : SLIDE_CONCURRENCY
    const limit = pLimit(effectiveConcurrency)

    if (!slides.length) throw new Error('No slides with images found')
    console.log(`✅ ${slides.length} slides found\n`)

    const { error: statusErr } = await supabase
      .from('npd2_catalog_uploads')
      .update({ status: 'processing', total_slides: slides.length })
      .eq('id', UPLOAD_ID)
    if (statusErr) throw statusErr

    const isBuyerSpec = uploadRow.origin === 'buyer_spec'
    let   done        = 0
    let   lastUpdate  = 0
    const skusCreated = []
    const failed      = []

    if (isBuyerSpec && isPdfJob) {
      // Buyer-spec PDF: process every image from every page, create ONE SKU
      // All processed images go to spec_images so user can pick main + reference
      try {
        const sku = await processBuyerSpecPdf(slides, uploadRow, basePath)
        skusCreated.push(sku)
        done = slides.length
      } catch (err) {
        failed.push({ slide: 'all', error: err.message })
        console.warn(`\n  ❌ Buyer-spec PDF processing failed: ${err.message}`)
      }
    } else {
      await Promise.all(
        slides.map(slide =>
          limit(async () => {
            try {
              let newSkus
              if (slide.isPdf) {
                // PDF: one SKU per detected product image on the page
                newSkus = await processPdfSlide(slide, uploadRow, basePath)
              } else {
                // PPTX: one SKU per slide (best image selected)
                const sku = await processSlide(slide, uploadRow, basePath)
                newSkus = sku ? [sku] : []
              }
              done++
              skusCreated.push(...newSkus)
            } catch (err) {
              done++
              failed.push({ slide: slide.slideIndex + 1, error: err.message })
              console.warn(`\n  ❌ Slide ${slide.slideIndex + 1} failed: ${err.message}`)
            }

            if (done - lastUpdate >= 3 || done === slides.length) {
              lastUpdate = done
              try {
                await supabase
                  .from('npd2_catalog_uploads')
                  .update({ slides_processed: done, sku_count: skusCreated.length })
                  .eq('id', UPLOAD_ID)
              } catch {}
            }

            console.log(`\n  📊 ${done}/${slides.length} done (${skusCreated.length} SKUs so far)`)
          })
        )
      )
    }

    const { error: doneErr } = await supabase
      .from('npd2_catalog_uploads')
      .update({
        status:    'done',
        sku_count: skusCreated.length,
        ...(failed.length ? { error_message: `${failed.length} slide(s) failed` } : {}),
      })
      .eq('id', UPLOAD_ID)
    if (doneErr) throw new Error(`Failed to mark upload done: ${doneErr.message}`)

    console.log(`\n✅ Done — ${skusCreated.length} SKUs created`)
    if (failed.length) console.log(`⚠️  ${failed.length} failed:`, failed)

    process.exit(0)

  } catch (err) {
    console.log('\n❌ Worker failed:', err.message, err.stack)
    try {
      await supabase
        .from('npd2_catalog_uploads')
        .update({ status: 'error', error_message: err.message })
        .eq('id', UPLOAD_ID)
    } catch (dbErr) {
      console.log('❌ DB status update also failed:', dbErr.message)
    }
    process.exit(1)
  }
}

if (JOB_MODE === 'image_processing') {
  runImageProcessing()
} else {
  run()
}