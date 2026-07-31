// Builds the signed NDA PDF attached to the vendor's approval email.
//
// Uses pdf-lib (pure JS, Node-native — no Chromium/puppeteer needed). The NDA
// wording here is duplicated (not imported) from the frontend's Agreement tab
// (twif-frontend/src/pages/Auth/OnboardingPage.jsx) — the two are separate
// repos/deploys, so a true shared import isn't practical. If the wording ever
// changes, update both places.
//
// Signature rendering: typed signatures use pdf-lib's built-in TimesRomanItalic
// (no external font file needed, always embeds cleanly). Swapping in a real
// script/cursive font later is a drop-in change — embed a .ttf file's bytes via
// `doc.embedFont(fontBytes)` instead of the StandardFonts.TimesRomanItalic call
// below, once such a font file is added to this repo.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')

const PAGE_SIZE = [595.28, 841.89] // A4, points
const MARGIN = 56
const INK = rgb(0.11, 0.11, 0.1)
const INK_SOFT = rgb(0.33, 0.33, 0.3)
const NAVY = rgb(0.12, 0.23, 0.37)

// ─────────────────────────────────────────────
// NDA + Schedule A content, as confirmed for the in-app Agreement tab
// ─────────────────────────────────────────────
const BODY_CONTENT = [
  { type: 'heading', text: '1. PURPOSE' },
  { type: 'para', text: 'The Vendor shall manufacture, develop, source, sample, inspect, package, or otherwise provide products and services for buyers introduced by Twif. During this relationship, the Vendor will have access to confidential commercial, technical and proprietary information belonging to Twif and/or its customers. The purpose of this Agreement is to protect Twif’s intellectual property, trade secrets, customer relationships and proprietary business information.' },

  { type: 'heading', text: '2. CONFIDENTIAL INFORMATION' },
  { type: 'para', text: 'Confidential Information shall include but not be limited to:' },
  { type: 'bullets', items: ['Buyer names and identities', 'Buyer contacts', 'Product developments', 'Designs', 'CAD drawings', 'Sketches', 'Technical drawings', 'Samples', 'Tooling', 'Moulds', 'Artwork', 'Packaging', 'Product specifications', 'Bill of Materials (BOM)', 'Cost sheets', 'Quotations', 'Purchase Orders', 'Vendor Scorecards', 'Quality reports', 'Test reports', 'Compliance documents', 'Product photographs', 'Merchandising documents', 'PLM Data', 'PCT Data', 'ERP Data', 'Buyer Portal information', 'Vendor Portal information', 'AI-generated outputs', 'Trade intelligence', 'Market research', 'Dashboards', 'Pricing models', 'Business methodologies', 'Customer strategies', 'Forecasts', 'Financial information'] },
  { type: 'para', text: 'Whether oral, written, electronic or visual.' },

  { type: 'heading', text: '3. CONFIDENTIALITY OBLIGATIONS' },
  { type: 'para', text: 'The Vendor agrees that it shall:' },
  { type: 'bullets', items: ['Keep all information strictly confidential.', 'Use information solely for executing Twif business.', 'Not disclose information to any third party.', 'Restrict access only to authorized personnel.', 'Ensure employees are equally bound by confidentiality obligations.'] },

  { type: 'heading', text: '4. NON-CIRCUMVENTION' },
  { type: 'para', text: 'The Vendor expressly agrees that during the business relationship and for five (5) years thereafter, it shall not directly or indirectly:' },
  { type: 'bullets', items: ['Contact any buyer introduced by Twif.', 'Solicit direct business from any Twif buyer.', 'Quote directly.', 'Supply directly.', 'Negotiate directly.', 'Accept RFQs.', 'Participate in tenders.', 'Create commercial relationships.', 'Divert business away from Twif introduced clients.'] },
  { type: 'para', text: 'This restriction applies irrespective of whether orders are currently active, sampling has commenced, or discussions are ongoing.' },

  { type: 'heading', text: '5. BUYER EXCLUSIVE DESIGNS' },
  { type: 'para', text: 'The Vendor agrees that all buyer developments remain confidential. Accordingly, the Vendor shall not:' },
  { type: 'bullets', items: ['Show buyer developments to any other customer.', 'Sell similar products to competitors.', 'Use photographs for marketing.', 'Display products in showrooms.', 'Display products at exhibitions.', 'Upload products on websites.', 'Upload products on social media.', 'Include products in catalogues.', 'Manufacture exclusive developments without written approval.'] },
  { type: 'para', text: 'This includes designs, samples, packaging, graphics, artwork, colours, finishes, and product concepts - whether production has commenced or not.' },

  { type: 'heading', text: '6. INTELLECTUAL PROPERTY' },
  { type: 'para', text: 'All Intellectual Property developed through Twif shall remain the exclusive property of the Buyer or Twif, including designs, technical drawings, CAD files, tooling, moulds, packaging, product concepts, product photography, AI models, software, workflows, and documentation. The Vendor shall acquire no ownership rights whatsoever.' },

  { type: 'heading', text: '7. SOFTWARE & DIGITAL ASSET PROTECTION' },
  { type: 'para', text: 'The Vendor acknowledges that Twif owns proprietary technology platforms including the Vendor Portal, AI Dashboards, Trade Intelligence Modules, and Workflow Engines. The Vendor shall not copy, reverse engineer, replicate, modify, decompile, reproduce, or commercially exploit any software, workflow, interface, database structure or technology belonging to Twif.' },

  { type: 'heading', text: '8. TRADE SECRET PROTECTION' },
  { type: 'para', text: 'The Vendor acknowledges that Twif possesses valuable trade secrets including supply chain methodologies, costing models, vendor and buyer intelligence, pricing logic, procurement models, business processes, and analytics. Such information shall remain confidential indefinitely unless publicly available through lawful means.' },

  { type: 'heading', text: '9. NON-SOLICITATION OF BUYER/CLIENTS' },
  { type: 'para', text: 'The Vendor shall not directly or indirectly recruit, solicit, induce, employ or engage a consultant, or appoint a representative/agent to approach Twif clients during the business relationship without Twif’s prior written consent.' },

  { type: 'heading', text: '10. DATA SECURITY' },
  { type: 'para', text: 'The Vendor shall implement appropriate physical, technical and organisational safeguards to prevent:' },
  { type: 'bullets', items: ['Data theft', 'Unauthorized access', 'Data leakage', 'Cyber breaches', 'Loss of confidential information'] },

  { type: 'heading', text: '11. RETURN OF MATERIALS' },
  { type: 'para', text: 'Upon request or termination, all documents, drawings, samples, prototypes, electronic files, digital records, and confidential materials shall immediately be returned or permanently destroyed.' },

  { type: 'heading', text: '12. BREACH' },
  { type: 'para', text: 'Any breach shall entitle Twif to:' },
  { type: 'bullets', items: ['Immediate termination.', 'Suspension of all orders.', 'Cancellation of outstanding business.', 'Recovery of direct losses and damages as permitted by law.', 'Injunctive relief.', 'Specific performance.', 'Recovery of legal expenses.'] },

  { type: 'heading', text: '13. DISPUTE RESOLUTION' },
  { type: 'para', text: 'The Parties shall first attempt to resolve disputes amicably. Failing resolution within thirty (30) days, disputes shall be referred to arbitration under the Arbitration and Conciliation Act, 1996. Seat of arbitration: Bangalore, India. Language: English. The arbitration award shall be final and binding.' },

  { type: 'heading', text: '14. GOVERNING LAW' },
  { type: 'para', text: 'This Agreement shall be governed by the laws of India. Courts at Bangalore, India shall have exclusive jurisdiction for interim and enforcement proceedings.' },

  { type: 'heading', text: '15. TERM' },
  { type: 'para', text: 'This Agreement shall remain effective during the business relationship. Obligations relating to Confidentiality, Intellectual Property, Trade Secrets, Buyer Protection, and Non-Circumvention shall survive for five (5) years following termination, or longer where required by law or contract.' },

  { type: 'heading', text: '16. ENTIRE AGREEMENT' },
  { type: 'para', text: 'This Agreement constitutes the complete understanding between the Parties and supersedes all prior oral or written communications relating to its subject matter. Any amendment shall only be valid if made in writing and signed by both Parties.' },

  { type: 'schedule-heading', text: 'SCHEDULE A' },
  { type: 'heading', text: 'Buyer Exclusivity & Product Development Protocol' },
  { type: 'para', text: 'This Schedule forms an integral part of the Master Non-Disclosure, Non-Circumvention & Non-Solicitation Agreement entered into between Twif Technologies Private Limited ("Twif") and the Vendor.' },

  { type: 'subheading', text: '1. Buyer Exclusivity' },
  { type: 'para', text: 'The Vendor acknowledges that all buyers introduced by Twif are proprietary business relationships of Twif. Accordingly, the Vendor shall not, directly or indirectly, contact, solicit, negotiate, quote, invoice, supply, or conduct business with any buyer introduced by Twif without Twif’s prior written approval; accept enquiries, RFQs, or purchase orders directly from such buyers; share buyer contact details with any third party; or encourage buyers to bypass Twif for any commercial transaction. This restriction shall remain valid during the business relationship and for five (5) years following its termination.' },

  { type: 'subheading', text: '2. Product Development Confidentiality' },
  { type: 'para', text: 'All product developments undertaken through Twif shall remain strictly confidential, including new product concepts, sketches, CAD drawings, technical drawings, product specifications, BOM, artwork, packaging designs, samples, prototypes, costing information, product photography, AI-generated concepts, and buyer comments/revisions. The Vendor shall use such information solely for executing Twif-approved work.' },

  { type: 'subheading', text: '3. Communication Protocol' },
  { type: 'para', text: 'The Vendor shall communicate only through the designated Twif representative unless expressly authorized otherwise in writing. No discussions relating to new developments, pricing, product specifications, design changes, technical comments, sampling status, or commercial negotiations shall be conducted directly with the buyer without prior written approval from Twif.' },

  { type: 'subheading', text: '4. Approval Process' },
  { type: 'para', text: 'No product shall be treated as approved until Twif communicates written confirmation. The Vendor shall not commence production, order raw materials or packaging, create tooling or moulds, book production capacity, or display/publicize products until final approval has been received through Twif.' },

  { type: 'subheading', text: '5. Product Display Restrictions' },
  { type: 'para', text: 'Without prior written approval from Twif, the Vendor shall not display buyer-exclusive products in factories or showrooms, exhibit at fairs/exhibitions, publish photographs in catalogues/websites/social media, circulate product images through WhatsApp/email/other channels, or use buyer developments for marketing purposes.' },

  { type: 'subheading', text: '6. Reproduction Restrictions' },
  { type: 'para', text: 'The Vendor shall not manufacture, reproduce, modify, or offer substantially similar products for any third party where the product has been developed exclusively for a Twif buyer, regardless of whether the order is placed, sampling is completed, or production has commenced.' },

  { type: 'subheading', text: '7. Tooling, Moulds & Development Assets' },
  { type: 'para', text: 'Unless otherwise agreed in writing, all tooling, moulds, jigs, fixtures, artwork, CAD files, technical documents, samples, and development assets created specifically for Twif buyers shall remain the exclusive property of the respective buyer and/or Twif, and shall not be reused for any other customer without prior written consent.' },

  { type: 'subheading', text: '8. Breach' },
  { type: 'para', text: 'Any breach of this Schedule shall constitute a material breach of the Agreement and may result in immediate termination of business, cancellation of current and future orders, removal from Twif’s approved vendor panel, recovery of damages and legal costs, and injunctive relief or other legal remedies.' },

  { type: 'para', text: 'Vendor Acknowledgement: the Vendor acknowledges that compliance with this Schedule is fundamental to protecting Twif’s buyer relationships, intellectual property, product developments, and commercial interests, and agrees to adhere strictly to these obligations throughout the business relationship.' },
]

// ─────────────────────────────────────────────
// Text layout helpers — pdf-lib has no built-in word wrap or pagination
// ─────────────────────────────────────────────
function wrapText(text, font, size, maxWidth) {
  const words = text.split(/\s+/)
  const lines = []
  let current = ''
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(trial, size) > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = trial
    }
  }
  if (current) lines.push(current)
  return lines
}

class Flow {
  constructor(doc, fonts) {
    this.doc = doc
    this.fonts = fonts
    this.pages = []
    this.newPage()
  }

  newPage() {
    this.page = this.doc.addPage(PAGE_SIZE)
    this.pages.push(this.page)
    this.y = PAGE_SIZE[1] - MARGIN
  }

  ensureSpace(height) {
    if (this.y - height < MARGIN + 20) this.newPage()
  }

  text(str, { font, size, color = INK, x = MARGIN, maxWidth = PAGE_SIZE[0] - MARGIN * 2, lineGap = 4 } = {}) {
    const lines = wrapText(str, font, size, maxWidth)
    for (const line of lines) {
      this.ensureSpace(size + lineGap)
      this.page.drawText(line, { x, y: this.y, size, font, color })
      this.y -= size + lineGap
    }
  }

  spacer(height) { this.y -= height }

  heading(str) {
    this.spacer(6)
    this.text(str, { font: this.fonts.bold, size: 12.5, color: INK })
    this.spacer(2)
  }

  subheading(str) {
    this.spacer(4)
    this.text(str, { font: this.fonts.bold, size: 10.5, color: INK })
  }

  bullets(items) {
    for (const item of items) {
      const lines = wrapText(item, this.fonts.regular, 10, PAGE_SIZE[0] - MARGIN * 2 - 14)
      lines.forEach((line, i) => {
        this.ensureSpace(14)
        this.page.drawText(i === 0 ? '•' : '', { x: MARGIN, y: this.y, size: 10, font: this.fonts.regular, color: INK })
        this.page.drawText(line, { x: MARGIN + 12, y: this.y, size: 10, font: this.fonts.regular, color: INK })
        this.y -= 14
      })
    }
  }
}

function centerText(page, str, font, size, y, color = INK) {
  const width = font.widthOfTextAtSize(str, size)
  page.drawText(str, { x: (PAGE_SIZE[0] - width) / 2, y, size, font, color })
}

function parseDataUrl(dataUrl) {
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(dataUrl || '')
  if (!match) return null
  return { format: match[1] === 'png' ? 'png' : 'jpg', bytes: Buffer.from(match[2], 'base64') }
}

async function embedSignatureImage(doc, dataUrl) {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) return null
  return parsed.format === 'png' ? doc.embedPng(parsed.bytes) : doc.embedJpg(parsed.bytes)
}

function formatIST(date) {
  return new Date(date).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'Asia/Kolkata',
  }) + ' IST'
}

// ─────────────────────────────────────────────
// Main entry point
//
// adminSignature (Twif's countersignature) is captured fresh per approval via the
// Sign step, not read live from a shared "current default" — so a PDF always
// reflects exactly what was signed at the time, even if the org's default
// signature is changed later. Shape: { full_name, designation, signature_type,
// signature_name, signature_image, signed_at }. Pass null before the Sign step
// has happened (e.g. a Verify-stage preview) — the Twif column then renders a
// "not yet configured" placeholder.
// ─────────────────────────────────────────────
async function buildSignedNdaPdf({ organization, ownerJobTitle, adminSignature, activityLog }) {
  const doc = await PDFDocument.create()
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    signature: await doc.embedFont(StandardFonts.TimesRomanItalic), // stand-in for a script font — see file header
  }

  const vendorName = organization.display_name || organization.name
  const docId = organization.id
  const effectiveDate = formatIST(organization.created_on || new Date()).split(',')[0].trim()

  // ── Cover page ──────────────────────────────
  const cover = doc.addPage(PAGE_SIZE)
  centerText(cover, 'MASTER NON-DISCLOSURE, NON-CIRCUMVENTION', fonts.serifBold, 17, 620)
  centerText(cover, '& NON-SOLICITATION AGREEMENT', fonts.serifBold, 17, 598)
  centerText(cover, '(Vendor Confidentiality & Business Protection Agreement)', fonts.serif, 11, 566, INK_SOFT)

  const subtitle = `${vendorName} <> Twif Technologies Private Limited`
  const subtitleWidth = fonts.bold.widthOfTextAtSize(subtitle, 13)
  const boxX = (PAGE_SIZE[0] - subtitleWidth) / 2 - 16
  cover.drawRectangle({ x: boxX, y: 505, width: subtitleWidth + 32, height: 26, color: rgb(0.91, 0.78, 0.45) })
  centerText(cover, subtitle, fonts.bold, 13, 513, rgb(0.36, 0.28, 0.07))

  centerText(cover, `Document ID: ${docId}`, fonts.regular, 9, 460, INK_SOFT)

  // ── Body pages (preamble + sections + Schedule A) ───────────────
  const flow = new Flow(doc, fonts)
  flow.text('This Agreement is entered into on ' + effectiveDate + ' ("Effective Date")', { font: fonts.serifBold, size: 11 })
  flow.spacer(6)
  flow.text('BETWEEN', { font: fonts.bold, size: 10.5 })
  flow.text('Twif Technologies Private Limited, having its offices in Bangalore, India, with global headquarters in Singapore (hereinafter referred to as "Twif", which expression shall include its successors, affiliates and permitted assigns);', { font: fonts.serif, size: 10.5 })
  flow.spacer(6)
  flow.text('AND', { font: fonts.bold, size: 10.5 })
  flow.text(`Vendor Name: ${vendorName}`, { font: fonts.serifBold, size: 10.5 })
  flow.text(`Address: ${organization.address || '-'}`, { font: fonts.serifBold, size: 10.5 })
  flow.text('(hereinafter referred to as the "Vendor"). Twif and the Vendor shall collectively be referred to as the "Parties".', { font: fonts.serif, size: 10.5 })
  flow.spacer(10)

  for (const block of BODY_CONTENT) {
    if (block.type === 'heading') flow.heading(block.text)
    else if (block.type === 'schedule-heading') {
      flow.spacer(10)
      flow.text(block.text, { font: fonts.bold, size: 10, color: INK })
    }
    else if (block.type === 'subheading') flow.subheading(block.text)
    else if (block.type === 'para') flow.text(block.text, { font: fonts.serif, size: 10.5 })
    else if (block.type === 'bullets') flow.bullets(block.items)
  }

  // ── Signature page ───────────────────────────
  flow.newPage()
  flow.heading('Acceptance & Signatures')
  flow.text('By signing below, both Parties confirm that they have read, understood, and agreed to the terms and conditions of this Agreement, including Schedule A.', { font: fonts.serif, size: 10 })
  flow.spacer(16)

  const colWidth = (PAGE_SIZE[0] - MARGIN * 2 - 20) / 2
  const leftX = MARGIN
  const rightX = MARGIN + colWidth + 20
  const sigTop = flow.y

  await drawSignatureColumn(doc, flow.page, fonts, {
    x: leftX, y: sigTop, width: colWidth,
    label: 'For Vendor, through its authorized signatory',
    signatureType: organization.nda_signature_type || 'typed',
    signatureName: organization.nda_signature_name,
    signatureImage: organization.nda_signature_image,
    ipAddress: organization.nda_ip_address,
    date: organization.nda_accepted_at ? formatIST(organization.nda_accepted_at) : '-',
    company: vendorName,
    signatoryName: organization.owner_name || '-',
    designation: ownerJobTitle || '-',
  })

  await drawSignatureColumn(doc, flow.page, fonts, {
    x: rightX, y: sigTop, width: colWidth,
    label: 'For Twif Technologies Private Limited, through its authorized signatory',
    signatureType: adminSignature?.signature_type || null,
    signatureName: adminSignature?.signature_name || null,
    signatureImage: adminSignature?.signature_image || null,
    ipAddress: null, // Twif's countersignature IP is logged in the activity log, not repeated here
    date: adminSignature?.signed_at ? formatIST(adminSignature.signed_at) : '-',
    company: 'Twif Technologies Private Limited',
    signatoryName: adminSignature?.full_name || 'Authorized Signatory',
    designation: adminSignature?.designation || '-',
  })

  // ── Activity summary page ───────────────────
  flow.newPage()
  flow.heading('Completed Document Summary')
  flow.text(`Document ID: ${docId}  ·  (GMT+05:30) India Standard Time`, { font: fonts.regular, size: 9, color: INK_SOFT })
  flow.spacer(14)
  flow.text('FILES', { font: fonts.bold, size: 9, color: INK_SOFT })
  flow.text(`${vendorName} - NDA.pdf  ·  ${flow.pages.length + 1} pages`, { font: fonts.regular, size: 10 })
  flow.spacer(14)
  flow.text('ACTIVITY', { font: fonts.bold, size: 9, color: INK_SOFT })
  flow.spacer(4)

  for (const entry of activityLog || []) {
    flow.ensureSpace(30)
    flow.text(`${entry.actor_name || 'Unknown'}  -  ${describeEvent(entry.event_type)}`, { font: fonts.bold, size: 10 })
    flow.text(`${formatIST(entry.created_at)}${entry.actor_email ? '  ·  ' + entry.actor_email : ''}${entry.ip_address ? '  ·  IP: ' + entry.ip_address : ''}`, { font: fonts.regular, size: 8.5, color: INK_SOFT })
    flow.spacer(6)
  }

  // ── Footer (Document ID + page number) on every page ──────
  const allPages = doc.getPages()
  allPages.forEach((page, i) => {
    page.drawLine({ start: { x: MARGIN, y: 40 }, end: { x: PAGE_SIZE[0] - MARGIN, y: 40 }, thickness: 0.5, color: rgb(0.85, 0.83, 0.78) })
    page.drawText('Twif Technologies Private Limited', { x: MARGIN, y: 28, size: 8, font: fonts.regular, color: INK_SOFT })
    centerText(page, `${i + 1} of ${allPages.length}`, fonts.regular, 8, 28, INK_SOFT)
    const idText = `Document ID: ${docId}`
    const idWidth = fonts.regular.widthOfTextAtSize(idText, 8)
    page.drawText(idText, { x: PAGE_SIZE[0] - MARGIN - idWidth, y: 28, size: 8, font: fonts.regular, color: INK_SOFT })
  })

  const bytes = await doc.save()
  return Buffer.from(bytes)
}

function describeEvent(type) {
  return {
    created: 'created the application',
    vendor_signed: 'signed the agreement',
    verified: 'reviewed and verified the agreement',
    jng_countersigned: 'countersigned the agreement',
    sent: 'sent the signed document',
  }[type] || type
}

async function drawSignatureColumn(doc, page, fonts, opts) {
  const { x, y, width, label, signatureType, signatureName, signatureImage, ipAddress, date, company, signatoryName, designation } = opts

  page.drawText(label, { x, y, size: 9, font: fonts.bold, color: INK_SOFT, maxWidth: width })
  let cursorY = y - 24

  if (signatureType === 'drawn' || signatureType === 'uploaded') {
    const embedded = await embedSignatureImage(doc, signatureImage)
    if (embedded) {
      const scale = Math.min(width / embedded.width, 40 / embedded.height, 1)
      page.drawImage(embedded, { x, y: cursorY - embedded.height * scale, width: embedded.width * scale, height: embedded.height * scale })
      cursorY -= embedded.height * scale + 6
    }
  } else if (signatureName) {
    page.drawText(signatureName, { x, y: cursorY - 20, size: 22, font: fonts.signature, color: NAVY })
    cursorY -= 30
    if (ipAddress) {
      page.drawText(`IP Address: ${ipAddress}`, { x, y: cursorY, size: 8, font: fonts.regular, color: INK_SOFT })
      cursorY -= 16
    }
  } else {
    page.drawText('Authorized Signatory - not yet configured', { x, y: cursorY - 14, size: 9, font: fonts.regular, color: rgb(0.6, 0.58, 0.52) })
    cursorY -= 24
  }

  const rows = [['Date', date], ['Company', company], ['Signatory Name', signatoryName], ['Designation', designation]]
  cursorY -= 6
  for (const [k, v] of rows) {
    page.drawText(k, { x, y: cursorY, size: 8.5, font: fonts.regular, color: INK_SOFT })
    page.drawText(String(v), { x: x + 110, y: cursorY, size: 8.5, font: fonts.bold, color: INK, maxWidth: width - 110 })
    cursorY -= 15
  }
}

module.exports = { buildSignedNdaPdf }
