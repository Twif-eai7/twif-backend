// Server-side port of the frontend's src/utils/exportInspectionReportPdf.js
// - Phase 2 of "move large-batch PDF generation server-side" (see the
// approved proposal). Same sections, same order, same data as the client
// file; pdf-lib + sharp instead of jsPDF + browser Canvas, since there's no
// browser here. Proven at real scale in Phase 1's spike (300 photos/8
// reports, 32s, zero crash) - this extends that proof into the complete
// document.
//
// Deliberately NOT pixel-perfect against the jsPDF version (different text
// engines render slightly differently) - functionally complete (every
// section present, every field correct, tables readable, photos correctly
// oriented at full original quality) is the bar for this pass, matching
// what was agreed before starting this port.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const sharp = require('sharp');
const AdmZip = require('adm-zip');
const supabase = require('../supabaseClient');
const { withSortedPhotos } = require('./photoSequence');

// sharp's default operation cache (~50MB + up to 20 files/100 items) exists
// to speed up REPEATING the same operation on the same input - a web server
// resizing the same thumbnail on demand, say. This never revisits the same
// photo twice (a batch is hundreds of distinct one-shot photos), so the
// cache only adds retained memory with zero benefit here - sharp's own docs
// recommend disabling it for exactly this shape of workload. Confirmed live:
// production was still getting OOM-killed on PO 34072's real 300-photo
// batch even at 2Gi/2cpu with sequential part-building already in place.
sharp.cache(false);

const BUCKET = 'inspection-reports';
const LOGO_URL = process.env.REPORT_LOGO_URL || null;

const DISCLAIMER = [
  'This report reflects our findings at the time and place of inspection only, and is limited to the sample quantity drawn from the presented lot in accordance with the stated sampling plan.',
  'It does not relieve the supplier of their contractual obligation with respect to product quality, safety, and conformity to the buyer\'s specifications.',
  'This report is issued for the sole use of the party to whom it is addressed and shall not be reproduced except in full without written approval.',
];

const PACKAGING_ROWS = [['master_packing', 'Master Packing'], ['inner_packing', 'Inner Packing'], ['unit_packing', 'Unit Packing'], ['shipping_mark', 'Shipping Mark']];
const MEASUREMENT_ROWS = [['master', 'Master'], ['inner', 'Inner'], ['unit', 'Unit Packing']];
const BARCODE_ROWS = [['master', 'Master'], ['inner', 'Inner'], ['unit', 'Unit Packing']];
const ONSITE_ROWS = [
  ['chemical_test', 'Chemical Test'], ['colour_fastness_to_rubbing', 'Colour Fastness To Rubbing'],
  ['continuity_test', 'Continuity Test'], ['dimensional_check', 'Dimensional Check'],
  ['distortion_test', 'Distortion Test'], ['drop_test', 'Drop Test'], ['fitting_test', 'Fitting Test'],
  ['functional_test', 'Functional Test'], ['hanging_test', 'Hanging Test'], ['hardness_test', 'Hardness Test'],
  ['harp_test', 'Harp Test'], ['high_voltage_test', 'High Voltage Test'], ['impact_test', 'Impact Test'],
  ['leakage_test', 'Leakage Test'], ['load_capacity_test', 'Load Capacity Test'],
  ['moisture_content_carton', 'Moisture Content Carton'], ['moisture_content_product', 'Moisture Content Product'],
  ['polarity_test', 'Polarity Test'], ['pull_test', 'Pull Test'], ['radiation_test', 'Radiation Test'],
  ['scratch_test', 'Scratch Test'], ['stability_test', 'Stability Test'], ['tape_test_on_product', 'Tape Test on Product'],
  ['tilt_test', 'Tilt Test'], ['torque_test', 'Torque Test'], ['wobbling_test', 'Wobbling Test'],
];
const SIGNERS = [
  ['Vendor Representative', 'vendor_rep_name', 'vendor_rep_signature'],
  ['Quality Process Auditor', 'quality_process_auditor_name', 'quality_process_auditor_signature'],
];
const RESULT_LABEL = {
  making_a_plan: 'Making a Plan', plan_ready: 'Plan Ready', plan_aborted: 'Plan Aborted',
  feedback_inprogress: 'Feedback in Progress', accepted: 'Accepted', partially_accepted: 'Partially Accepted',
  accepted_with_deviations: 'Accepted with deviations', rejected: 'Rejected', resubmit: 'Resubmit', on_hold: 'On Hold',
};
const ACCEPTED_RESULTS = ['accepted', 'partially_accepted', 'accepted_with_deviations'];
const DEFAULT_SPLIT_PHOTO_THRESHOLD = 110;

const mm = (v) => v * 2.83465; // mm -> pt, doc unit was 'mm' client-side; font sizes are already pt in both.
const gray = (v) => rgb(v / 255, v / 255, v / 255);
const col = (r, g, b) => rgb(r / 255, g / 255, b / 255);

function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  return isNaN(dt) ? String(d) : dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function stripHtml(html) {
  return String(html || '')
    .replace(/<\/(p|div)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
function fmtQty(n) { return n != null && n !== '' ? Number(n).toLocaleString() : '-'; }
function safe(s) { return String(s ?? '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, ''); }
function shared(reports, pick) {
  const vals = [...new Set(reports.map(pick).filter((v) => v != null && v !== ''))];
  return vals.length === 1 ? vals[0] : '-';
}

async function fetchAsBuffer(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

// Server-side equivalent of the client's fetchPhotoBase64 - full original
// quality by default, EXIF rotation fixed via sharp().rotate() (proven in
// Phase 1's spike), never downscaled/recompressed beyond the near-lossless
// re-encode. preview: true - same reasoning as the client's own
// (now-retired) previewQuality trick: a look-then-close render doesn't need
// full resolution, so sharp resizes AND fixes rotation in the same decode
// pass, keeping a preview's response small and fast regardless of how many
// original-resolution photos the batch actually has.
//
// Deliberately NOT using Supabase Storage's own render/transform endpoint
// for this, despite it being faster (confirmed ~36s vs ~55s against a real
// 300-photo batch) - it's a billed Pro-plan feature (100 origin images
// included/month, then $5 per 1,000), and a single Preview transforms every
// photo in its batch once, so real usage could plausibly run $15-40+/month
// in recurring overage. Reverted after flagging that cost - not something
// to spend without the same sign-off budget decisions elsewhere in this
// feature went through.
async function fetchPhotoBuffer(path, { preview = false } = {}) {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  try {
    const original = Buffer.from(await data.arrayBuffer());
    let pipeline = sharp(original).rotate();
    if (preview) pipeline = pipeline.resize({ width: 900, withoutEnlargement: true });
    const oriented = await pipeline.jpeg({ quality: preview ? 78 : 92 }).toBuffer();
    const meta = await sharp(oriented).metadata();
    return { buffer: oriented, width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// The standard PDF fonts only encode WinAnsi. Any other character (a Unicode
// hyphen U+2010, a curly quote, an emoji, a non-Latin letter) makes pdf-lib
// throw "WinAnsi cannot encode ..." and the whole report fails. Everything that
// reaches drawText/widthOfTextAtSize goes through this first: common look-alikes
// map to their plain equivalent, anything still unencodable becomes '?'.
const PDF_CHAR_MAP = {
  '‐': '-', '‑': '-', '‒': '-', '―': '-', '−': '-',
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '…': '...', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '​': '', '‌': '', '‍': '', '﻿': '',
  '→': '->', '←': '<-', '✓': 'v', '✔': 'v', '×': 'x',
};
const encodableCache = new WeakMap();
function pdfSafeText(font, text) {
  const str = String(text ?? '');
  if (!str) return str;
  let cache = encodableCache.get(font);
  if (!cache) { cache = new Map(); encodableCache.set(font, cache); }
  let out = '';
  for (const ch of str) {
    let r = cache.get(ch);
    if (r === undefined) {
      r = PDF_CHAR_MAP[ch] ?? ch;
      let ok = true;
      try { font.encodeText(r); } catch { ok = false; }
      if (!ok) {
        // Strip accents (e.g. a decomposed letter) before giving up.
        const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
        try { font.encodeText(base); r = base; } catch { r = '?'; }
      }
      cache.set(ch, r);
    }
    out += r;
  }
  return out;
}

function wrapText(font, text, size, maxWidthMm) {
  const maxWidthPt = mm(maxWidthMm);
  const words = pdfSafeText(font, text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) <= maxWidthPt || !cur) cur = test;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function specForMeasurementRow(sku, key) {
  if (!sku) return {};
  if (key === 'master') return { l: sku.master_pack_length, b: sku.master_pack_breadth, h: sku.master_pack_height, wt: sku.master_pack_weight_kg, qty: sku.master_pack_qty };
  if (key === 'inner') return { l: sku.inner_pack_length, b: sku.inner_pack_breadth, h: sku.inner_pack_height, wt: sku.inner_pack_weight_kg, qty: sku.inner_pack_qty };
  return { l: sku.length, b: sku.breadth, h: sku.height, wt: sku.weight_kg, qty: null };
}
function specBarcodeForRow(sku, key) {
  if (!sku) return null;
  if (key === 'master') return sku.master_pack_barcode;
  if (key === 'inner') return sku.inner_pack_barcode;
  return sku.item_barcode;
}

// Same idempotent get-or-create the client's inspectionStorage.js uses -
// duplicated server-side (Node's crypto has createHash, no need for
// SubtleCrypto's browser-only API this was originally built around).
async function getOrCreateBatchReportNo(reportIds, poId, createdBy) {
  if (!reportIds?.length) return null;
  try {
    const crypto = require('crypto');
    const key = crypto.createHash('sha256').update([...reportIds].sort().join(',')).digest('hex');
    const { data: existing } = await supabase.from('inspection_report_batches').select('batch_no').eq('report_ids_key', key).maybeSingle();
    if (existing?.batch_no) return existing.batch_no;
    // createdBy only ever lands on the row that actually inserts it - a
    // concurrent duplicate that loses the race (ignoreDuplicates below)
    // never overwrites the winner's credit, same first-come idempotency
    // batch_no itself already has.
    const { data: inserted, error: insertError } = await supabase
      .from('inspection_report_batches')
      .upsert({ report_ids_key: key, report_ids: reportIds, po_id: poId ?? null, created_by: createdBy ?? null }, { onConflict: 'report_ids_key', ignoreDuplicates: true })
      .select('batch_no').maybeSingle();
    if (inserted?.batch_no) return inserted.batch_no;
    if (insertError) throw insertError;
    const { data: afterRace } = await supabase.from('inspection_report_batches').select('batch_no').eq('report_ids_key', key).maybeSingle();
    return afterRace?.batch_no ?? null;
  } catch { return null; }
}

// Wraps a pdf-lib PDFDocument with the same layout primitives the client
// file's own closures provide (sectionTitle/twoColBox/table/resultBadge/
// paragraphs/signOffBlock/photoPages) - same names/roles, same coordinate
// math (in mm, matching the client's own numbers exactly), converted to
// pdf-lib's bottom-left-origin points only at the actual draw call.
class Doc {
  constructor(pdf, fonts) {
    this.pdf = pdf;
    this.fonts = fonts; // { regular, bold, italic }
    this.W = 210; this.PH = 297; this.M = 12; this.CW = this.W - this.M * 2;
    this.PAD = 2.5; this.LBL_W = 33;
    this.page = null;
    this.y = 0;
  }
  addPage() {
    this.page = this.pdf.addPage([mm(this.W), mm(this.PH)]);
    this.y = 14;
    return this.page;
  }
  needsPage(h = 14) {
    if (this.y + h > this.PH - 14) this.addPage();
  }
  // xMm/yMm: yMm is the same "top of line" coordinate the client file used
  // for doc.text() calls - approximated to a baseline offset here since
  // pdf-lib measures from the bottom; not metric-identical to jsPDF, but
  // consistent and readable (see the file header's own note on this).
  text(str, xMm, yMm, { size = 8, bold = false, italic = false, color = gray(20), align = 'left', maxWidthMm = null } = {}) {
    const font = bold ? this.fonts.bold : italic ? this.fonts.italic : this.fonts.regular;
    const lines = Array.isArray(str) ? str : [str];
    lines.forEach((line, i) => {
      if (!line) return;
      line = pdfSafeText(font, line);
      let x = xMm;
      if (align === 'center' && maxWidthMm != null) {
        const wMm = font.widthOfTextAtSize(line, size) / 2.83465;
        x = xMm + (maxWidthMm - wMm) / 2;
      } else if (align === 'right' && maxWidthMm != null) {
        const wMm = font.widthOfTextAtSize(line, size) / 2.83465;
        x = xMm + maxWidthMm - wMm;
      }
      this.page.drawText(line, { x: mm(x), y: mm(this.PH) - mm(yMm + i * (size / 2.83465) * 1.15), size, font, color });
    });
  }
  sectionTitle(title, keepWith = 26) {
    this.needsPage(6.5 + keepWith);
    this.page.drawRectangle({ x: mm(this.M), y: mm(this.PH) - mm(this.y + 6.5), width: mm(this.CW), height: mm(6.5), color: gray(38) });
    this.text(String(title).toUpperCase(), this.M + this.PAD, this.y + 4.5, { size: 7.5, bold: true, color: rgb(1, 1, 1) });
    this.y += 6.5;
  }
  hLine(xMm, yMm, wMm, colorV = gray(232), widthPt = 0.4) {
    this.page.drawLine({ start: { x: mm(xMm), y: mm(this.PH) - mm(yMm) }, end: { x: mm(xMm + wMm), y: mm(this.PH) - mm(yMm) }, thickness: widthPt, color: colorV });
  }
  vLine(xMm, yMm, hMm, colorV = gray(170), widthPt = 0.6) {
    this.page.drawLine({ start: { x: mm(xMm), y: mm(this.PH) - mm(yMm) }, end: { x: mm(xMm), y: mm(this.PH) - mm(yMm + hMm) }, thickness: widthPt, color: colorV });
  }
  rect(xMm, yMm, wMm, hMm, { border = gray(170), borderWidth = 0.6, fill = null } = {}) {
    this.page.drawRectangle({ x: mm(xMm), y: mm(this.PH) - mm(yMm + hMm), width: mm(wMm), height: mm(hMm), borderColor: border, borderWidth, color: fill || undefined });
  }
  prepRows(rows, colW) {
    return rows.map(([label, value]) => {
      const lbl = wrapText(this.fonts.bold, String(label).toUpperCase(), 6.2, this.LBL_W - this.PAD);
      const raw = value == null || value === '' ? '-' : String(value);
      const val = wrapText(this.fonts.regular, raw, 8, colW - this.LBL_W - this.PAD * 2);
      return { lbl, val, h: Math.max(lbl.length * 3.1, val.length * 4.0) + 3.4 };
    });
  }
  drawRows(prepped, x, startY, colW) {
    let cy = startY;
    prepped.forEach(({ lbl, val, h }, i) => {
      this.text(lbl, x + this.PAD, cy + 3.4, { size: 6.2, bold: true, color: gray(125) });
      this.text(val, x + this.PAD + this.LBL_W, cy + 3.4, { size: 8, color: gray(20) });
      cy += h;
      if (i < prepped.length - 1) this.hLine(x + this.PAD, cy, colW - this.PAD * 2);
    });
  }
  twoColBox(leftRows, rightRows) {
    const colW = this.CW / 2;
    const L = this.prepRows(leftRows, colW);
    const R = this.prepRows(rightRows, colW);
    const boxH = Math.max(L.reduce((a, r) => a + r.h, 0), R.reduce((a, r) => a + r.h, 0)) + this.PAD * 2;
    this.needsPage(boxH + 4);
    this.rect(this.M, this.y, this.CW, boxH);
    this.vLine(this.M + colW, this.y, boxH);
    this.drawRows(L, this.M, this.y + this.PAD, colW);
    this.drawRows(R, this.M + colW, this.y + this.PAD, colW);
    this.y += boxH + 5;
  }
  resultBadge(result, xMm, yMm, partial = false) {
    if (!result) return;
    const accepted = ACCEPTED_RESULTS.includes(result);
    const [fill, textColor] = partial
      ? [col(255, 243, 205), col(146, 100, 6)]
      : accepted ? [col(214, 245, 224), col(21, 110, 55)]
      : result === 'rejected' ? [col(250, 220, 220), col(150, 40, 40)]
      : [gray(238), gray(70)];
    const label = partial ? 'PARTIALLY ACCEPTED' : (RESULT_LABEL[result] || result).toUpperCase();
    const wMm = this.fonts.bold.widthOfTextAtSize(label, 7.5) / 2.83465 + 8;
    this.rect(xMm, yMm, wMm, 6.5, { border: fill, fill });
    this.text(label, xMm + 4, yMm + 4.4, { size: 7.5, bold: true, color: textColor });
  }
  paragraphs(lines, size = 6.6) {
    lines.forEach((p) => {
      const wrapped = wrapText(this.fonts.regular, p, size, this.CW);
      this.needsPage(wrapped.length * 3.1 + 3);
      this.text(wrapped, this.M, this.y + 2.6, { size, color: gray(105) });
      this.y += wrapped.length * 3.1 + 2.4;
    });
  }
  async signOffBlock(report) {
    const colW = this.CW / SIGNERS.length;
    const boxH = 30;
    this.needsPage(boxH + 6);
    this.rect(this.M, this.y, this.CW, boxH);
    for (let i = 0; i < SIGNERS.length; i++) {
      const [role, nameKey, sigKey] = SIGNERS[i];
      const x = this.M + i * colW;
      if (i > 0) this.vLine(x, this.y, boxH);
      this.text(wrapText(this.fonts.bold, role.toUpperCase(), 6.2, colW - this.PAD * 2), x + this.PAD, this.y + 4, { size: 6.2, bold: true, color: gray(125) });

      const sig = report?.[sigKey];
      if (sig && String(sig).startsWith('data:')) {
        try {
          const b64 = String(sig).split(',')[1];
          const bytes = Buffer.from(b64, 'base64');
          const img = String(sig).includes('image/png') ? await this.pdf.embedPng(bytes) : await this.pdf.embedJpg(bytes);
          const w = Math.min(colW - this.PAD * 2, 42), h = 12;
          this.page.drawImage(img, { x: mm(x + this.PAD), y: mm(this.PH) - mm(this.y + 8 + h), width: mm(w), height: mm(h) });
        } catch { /* ruled line below */ }
      } else if (sig) {
        this.text(String(sig), x + this.PAD, this.y + 16, { size: 11, italic: true, color: gray(25) });
      }
      this.hLine(x + this.PAD, this.y + boxH - 8, colW - this.PAD * 2, gray(200), 0.5);
      this.text(wrapText(this.fonts.regular, report?.[nameKey] || '', 7.5, colW - this.PAD * 2)[0] || '', x + this.PAD, this.y + boxH - 3.5, { size: 7.5, color: gray(40) });
    }
    this.y += boxH + 5;
  }
  // opts: { head: [[str,...]] or [[{content,colSpan,rowSpan}...], [...]] for
  // the one 2-row-header table (Packaging Measurement) - handled as a
  // special case below, not a general colSpan/rowSpan engine; foot: [[...]];
  // columnWidths: [mm,...] (defaults to equal split); sizes/colors optional. }
  table({ head, body, foot, columnWidths, fontSize = 6.8, headFontSize = 6.6, cellPadding = 1.9 }) {
    const nCols = (Array.isArray(head[0]) ? head[head.length - 1].length : head.length);
    const widths = columnWidths || Array(nCols).fill(this.CW / nCols);
    const xAt = (i) => this.M + widths.slice(0, i).reduce((a, w) => a + w, 0);

    const drawRow = (cells, y, { bold = false, size = fontSize, fill = null, textColor = gray(30) } = {}) => {
      const font = bold ? this.fonts.bold : this.fonts.regular;
      const wrapped = cells.map((c, i) => wrapText(font, String(c ?? ''), size, widths[i] - cellPadding * 2));
      const rowH = Math.max(...wrapped.map((w) => w.length)) * (size / 2.83465) * 1.25 + cellPadding * 2;
      this.needsPage(rowH + 4);
      if (fill) this.rect(this.M, this.y, this.CW, rowH, { border: fill, fill });
      else this.rect(this.M, this.y, this.CW, rowH, { border: gray(190), borderWidth: 0.3 });
      wrapped.forEach((lines, i) => {
        this.vLine(xAt(i), this.y, rowH, gray(205), 0.25);
        this.text(lines, xAt(i) + cellPadding, this.y + cellPadding + (size / 2.83465), { size, bold, color: textColor });
      });
      this.y += rowH;
    };

    // Single-row head only here - Packaging Measurement's 2-row rowSpan/
    // colSpan header is drawn by drawMeasurementHead() instead, called by
    // its own section below rather than generalizing this table() for one
    // table's layout.
    const headRow = Array.isArray(head[0]) && typeof head[0][0] === 'object' ? null : head[0];
    if (headRow) drawRow(headRow, this.y, { bold: true, size: headFontSize, fill: gray(242), textColor: gray(55) });
    (body || []).forEach((row) => drawRow(row, this.y, { size: fontSize }));
    (foot || []).forEach((row) => drawRow(row, this.y, { bold: true, size: headFontSize, fill: gray(244), textColor: gray(25) }));
    this.y += 5;
  }
  // photoPreloaded: Map<storage_path, {buffer,width,height}> - Phase 1's
  // shared concurrency-limited prefetch pool, already resolved before this
  // is called (see buildInspectionReportPdf below), so this is pure
  // drawing, matching the client's own fastPhotos-preloaded path.
  async photoPages(photos, heading, photoPreloaded) {
    if (!photos?.length) return;
    this.addPage();
    this.sectionTitle(heading);
    const cols = 3, gap = 3;
    const cellW = (this.CW - gap * (cols - 1)) / cols;
    const imgH = cellW * 0.75;
    const capH = 5.5;
    const cellH = imgH + capH;
    for (let i = 0; i < photos.length; i += cols) {
      if (this.y + cellH > this.PH - 14) this.addPage();
      const rowPhotos = photos.slice(i, i + cols);
      for (let idx = 0; idx < rowPhotos.length; idx++) {
        const p = rowPhotos[idx];
        const entry = photoPreloaded.get(p.storage_path);
        const x = this.M + idx * (cellW + gap);
        this.rect(x, this.y, cellW, imgH, { border: gray(215), borderWidth: 0.3 });
        if (entry) {
          try {
            const boxW = cellW - 1.2, boxH = imgH - 1.2;
            const scale = Math.min(boxW / entry.width, boxH / entry.height);
            const drawW = entry.width * scale, drawH = entry.height * scale;
            const img = await this.pdf.embedJpg(entry.buffer);
            const dx = x + 0.6 + (boxW - drawW) / 2, dy = this.y + 0.6 + (boxH - drawH) / 2;
            this.page.drawImage(img, { x: mm(dx), y: mm(this.PH) - mm(dy + drawH), width: mm(drawW), height: mm(drawH) });
          } catch { /* bordered placeholder stays */ }
        }
        if (p.caption) {
          this.text(wrapText(this.fonts.regular, p.caption, 6.4, cellW - 1.2).slice(0, 2), x + 0.6, this.y + imgH + 3, { size: 6.4, color: gray(60) });
        }
      }
      this.y += cellH + gap;
    }
    this.y += 2;
  }
  drawMeasurementHead(y) {
    const widths = [this.CW * 0.14, ...Array(10).fill(this.CW * 0.086)];
    const xAt = (i) => this.M + widths.slice(0, i).reduce((a, w) => a + w, 0);
    const rowH = 8;
    this.rect(this.M, y, this.CW, rowH, { fill: gray(242) });
    this.text('Type', this.M + 1.5, y + 5.5, { size: 6.2, bold: true, color: gray(55) });
    this.text('Specification', xAt(1) + 1.5, y + 3, { size: 6.2, bold: true, color: gray(55) });
    this.text('Findings', xAt(6) + 1.5, y + 3, { size: 6.2, bold: true, color: gray(55) });
    ['L', 'B', 'H', 'Wt', 'Qty', 'L', 'B', 'H', 'Wt', 'Qty'].forEach((h, i) => {
      this.text(h, xAt(i + 1) + 1.5, y + 7, { size: 6.2, bold: true, color: gray(55) });
    });
    widths.slice(0, -1).reduce((accX, w, i) => { this.vLine(this.M + accX + w, y, rowH, gray(205), 0.25); return accX + w; }, 0);
    return rowH;
  }
}

// reports: inspection_reports rows, each with nested inspection_report_defects/
// inspection_report_photos already loaded (see loadReportsForPdf below).
// po: purchase_orders row + po_line_items. skuMasterById: { [sku_id]: sku row }.
async function buildInspectionReportPdf(po, reports, skuMasterById, { allocateBatchNo = true, partLabel = null, previewQuality = false, createdBy = null } = {}) {
  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };
  const doc = new Doc(pdf, fonts);
  const single = reports.length === 1;

  const lineItemFor = (r) => po.po_line_items?.find((x) => x.id === r.po_line_item_id);
  const skuFor = (r) => skuMasterById[lineItemFor(r)?.sku_id];

  // Every photo across every report, fetched through one shared
  // concurrency-limited pool (same reasoning as the client file, and
  // proven at 300-photo scale in Phase 1) instead of one report finishing
  // before the next starts.
  const allPhotos = reports.flatMap((r) => r.inspection_report_photos || []);
  const allAttachments = reports.flatMap((r) => r.attachments || []);
  const imageAttRe = /\.(jpe?g|png|gif|webp|bmp)$/i;
  const imageAttachments = allAttachments.filter((a) => imageAttRe.test(a.name || a.path || ''));
  const fileAttachments = allAttachments.filter((a) => !imageAttRe.test(a.name || a.path || ''));
  const allPhotoPaths = [...new Set([...allPhotos.map((p) => p.storage_path), ...imageAttachments.map((a) => a.path)])];
  const photoResults = await mapWithConcurrency(allPhotoPaths, 8, (path) => fetchPhotoBuffer(path, { preview: previewQuality }));
  const photoPreloaded = new Map(allPhotoPaths.map((path, i) => [path, photoResults[i]]).filter(([, v]) => v));

  const [logoBuffer, { data: skuCommentsData }, { data: siblingReportsData }] = await Promise.all([
    fetchAsBuffer(LOGO_URL),
    supabase.from('po_comments').select('id, line_item_id, comment, created_by, created_at')
      .eq('po_id', po.id).eq('comment_type', 'QA_INSPECTION')
      .in('line_item_id', reports.map((r) => r.po_line_item_id)).order('created_at', { ascending: true }),
    supabase.from('inspection_reports').select('po_line_item_id, inspection_type, round, status, accepted_quantity, available_quantity')
      .in('po_line_item_id', reports.map((r) => r.po_line_item_id)).eq('status', 'submitted'),
  ]);
  const skuCommentsByLineItem = {};
  for (const c of skuCommentsData || []) (skuCommentsByLineItem[c.line_item_id] ??= []).push(c);
  const siblingReports = siblingReportsData || [];

  function getStageRollup(lineItemId, inspectionType, uptoRound) {
    // Only rounds up to and including `uptoRound`: a report's own PDF must read
    // as it stood at that round (Round 1 of a 20-then-80 order is "20 of 100"
    // even after Round 2 finished the order), not as the SKU stands today.
    const rows = siblingReports.filter((r) => r.po_line_item_id === lineItemId && r.inspection_type === inspectionType && (r.round ?? 1) <= (uptoRound ?? Infinity));
    let cumulativeAccepted = 0, cumulativeAvailable = 0;
    for (const r of rows) { cumulativeAccepted += Number(r.accepted_quantity || 0); cumulativeAvailable += Number(r.available_quantity || 0); }
    return { cumulativeAccepted, cumulativeAvailable };
  }
  function isPartialResult(r) {
    if (!ACCEPTED_RESULTS.includes(r.inspection_result)) return { isPartial: false };
    const orderQty = lineItemFor(r)?.quantity_ordered;
    if (orderQty == null) return { isPartial: false };
    const rollup = getStageRollup(r.po_line_item_id, r.inspection_type, r.round ?? 1);
    const coveredQty = rollup.cumulativeAccepted > 0 ? rollup.cumulativeAccepted : (rollup.cumulativeAvailable > 0 ? rollup.cumulativeAvailable : null);
    return { isPartial: coveredQty != null && coveredQty < orderQty };
  }

  const batchReportNo = (single || !allocateBatchNo) ? null : await getOrCreateBatchReportNo(reports.map((r) => r.id), po?.id, createdBy);

  // ── Letterhead ──────────────────────────────────────────────────────────
  doc.addPage();
  const distinctTypes = [...new Set(reports.map((r) => r.inspection_type).filter(Boolean))];
  const reportTitle = distinctTypes.length === 1 ? `${distinctTypes[0]} Inspection Report`.toUpperCase() : 'INSPECTION REPORT';
  const HH = 20, LOGO = 32, REF = 46, TTL = doc.CW - LOGO - REF;
  doc.rect(doc.M, 10, doc.CW, HH);
  doc.vLine(doc.M + LOGO, 10, HH);
  doc.vLine(doc.M + LOGO + TTL, 10, HH);
  if (logoBuffer) {
    try {
      const img = await pdf.embedPng(logoBuffer).catch(() => pdf.embedJpg(logoBuffer));
      doc.page.drawImage(img, { x: mm(doc.M + 2), y: mm(doc.PH) - mm(10 + HH - 1.5), width: mm(LOGO - 4), height: mm(HH - 3) });
    } catch { doc.text('TWIF', doc.M + LOGO / 2 - 5, 10 + HH / 2 + 1, { size: 10, bold: true, color: gray(30) }); }
  } else {
    doc.text('TWIF', doc.M + LOGO / 2 - 5, 10 + HH / 2 + 1, { size: 10, bold: true, color: gray(30) });
  }
  doc.text(reportTitle, doc.M + LOGO, 10 + HH / 2 + 1.5, { size: 12, bold: true, color: gray(17), align: 'center', maxWidthMm: TTL });
  doc.text('REPORT NO', doc.M + LOGO + TTL + doc.PAD, 10 + HH / 2 - 1.5, { size: 6.2, bold: true, color: gray(125) });
  const reportNoText = single ? String(reports[0].report_no ?? '-') : (batchReportNo || `${reports.length} inspections`);
  doc.text(partLabel ? `${reportNoText}  (Part ${partLabel.index}/${partLabel.count})` : reportNoText, doc.M + LOGO + TTL + doc.PAD, 10 + HH / 2 + 3.5, { size: 8, color: gray(20) });
  doc.y = 10 + HH + 6;

  // ── General Information ────────────────────────────────────────────────
  const departments = [...new Set(reports.map((r) => skuFor(r)?.categories?.name).filter(Boolean))];
  const typeOf = (r) => {
    const t = r.inspection_type ? r.inspection_type[0].toUpperCase() + r.inspection_type.slice(1) : '-';
    return (r.round ?? 1) > 1 ? `${t} · Round ${r.round}` : t;
  };
  doc.sectionTitle('General Information');
  doc.twoColBox(
    [
      ['Customer', po.buyer_name], ['Customer PO No', po.po_number], ['Department', departments.join(', ') || '-'],
      ['Inspector/s Name', shared(reports, (r) => r.inspector_name)],
      ['Type of Inspection', [...new Set(reports.map(typeOf))].join(', ')],
      ['Inspection Date', shared(reports, (r) => (r.inspection_date ? fmtDate(r.inspection_date) : null))],
    ],
    [
      ['Vendor', po.supplier_name], ['Factory Name', po.supplier_name],
      ['Factory Address', [po.supplier_address, po.supplier_city, po.supplier_state, po.supplier_zip, po.supplier_country].filter(Boolean).join(', ')],
      ['Factory Phone', po.supplier_phone],
      ['Vendor Representative Name', reports.map((r) => (r.vendor_rep_name || '').trim()).find(Boolean) || reports.map((r) => (r.contact || '').trim()).find(Boolean) || '-'],
      ['Arrival / Start / Complete', [reports.map((r) => r.arrival_time).find(Boolean), reports.map((r) => r.start_time).find(Boolean), reports.map((r) => r.complete_time).find(Boolean)].filter(Boolean).join('  /  ') || '-'],
    ],
  );

  if (single && reports[0].inspection_result) {
    doc.needsPage(12);
    doc.text('INSPECTION RESULT', doc.M, doc.y + 4.4, { size: 6.2, bold: true, color: gray(125) });
    doc.resultBadge(reports[0].inspection_result, doc.M + 36, doc.y, isPartialResult(reports[0]).isPartial);
    doc.y += 11;
  }

  // ── Inspection Summary ─────────────────────────────────────────────────
  doc.sectionTitle('Inspection Summary');
  doc.table({
    head: [['Insp. No.', 'Ref#', 'Description', 'PO No', 'Ex-Factory', 'Order', 'Avail.', 'Inspd.', 'Accpt.', 'Cartons']],
    body: reports.map((r) => {
      const li = lineItemFor(r);
      // PO-level ex-factory date, not each line item's own target_date -
      // same exceptional_ex_factory_date-wins-when-set convention every
      // other ex-factory display in the app uses (see e.g.
      // PoInspectionComments.jsx's own exFactory()).
      return [r.report_no ?? '-', li?.buyer_sku_ref ?? '-', skuFor(r)?.description ?? '-', po.po_number ?? '-', fmtDate(po.exceptional_ex_factory_date ?? po.ex_factory_date),
        fmtQty(li?.quantity_ordered), fmtQty(r.available_quantity), fmtQty(r.inspected_qty), fmtQty(r.accepted_quantity), fmtQty(r.carton_available)];
    }),
    columnWidths: [doc.CW * 0.12, doc.CW * 0.09, doc.CW * 0.22, doc.CW * 0.09, doc.CW * 0.09, doc.CW * 0.09, doc.CW * 0.09, doc.CW * 0.07, doc.CW * 0.07, doc.CW * 0.07],
  });

  // ── Remarks / Attachments ──────────────────────────────────────────────
  const allRemarks = reports.flatMap((r) => (r.remarks || []).map((t) => (single ? t : `[${lineItemFor(r)?.buyer_sku_ref ?? '-'}] ${t}`)));
  if (allRemarks.length) {
    doc.sectionTitle('Remarks');
    allRemarks.forEach((t, i) => {
      const wrapped = wrapText(fonts.regular, `${i + 1}.  ${t}`, 7.6, doc.CW - doc.PAD * 2);
      doc.needsPage(wrapped.length * 3.8 + 3);
      doc.text(wrapped, doc.M + doc.PAD, doc.y + 3, { size: 7.6, color: gray(25) });
      doc.y += wrapped.length * 3.8 + 2;
    });
    doc.y += 3;
  }

  if (fileAttachments.length) {
    doc.sectionTitle('List of Attachments');
    fileAttachments.forEach((a) => {
      doc.needsPage(7);
      doc.text(`• ${a.name || 'Attachment'}`, doc.M + doc.PAD, doc.y + 3.4, { size: 7.6, color: col(30, 100, 200) });
      doc.y += 5.4;
    });
    doc.y += 3;
  }

  await doc.photoPages(imageAttachments.map((a) => ({ storage_path: a.path, caption: a.name })), 'Attachment Photos', photoPreloaded);

  if (single) {
    doc.sectionTitle('Sign-off');
    await doc.signOffBlock(reports[0]);
  }

  doc.sectionTitle('Disclaimer');
  doc.paragraphs(DISCLAIMER);

  // ── One page-block per inspected SKU ───────────────────────────────────
  for (const r of reports) {
    doc.addPage();
    const li = lineItemFor(r);
    const sku = skuFor(r);
    const plan = resolveSamplingPlan({ lotSize: li?.quantity_ordered, inspectionLevel: po.inspection_level });
    const planSizeStr = plan ? `${plan.codeLetter} (${plan.sampleSize})` : null;

    doc.sectionTitle(`Inspection Particulars - ${li?.buyer_sku_ref ?? '-'}`);
    doc.twoColBox(
      [['Customer Ref#', li?.buyer_sku_ref], ['Product Description', sku?.description], ['Product Color', sku?.sku_variant || li?.sku_variant]],
      [['Department', sku?.categories?.name], ['Base Material', [sku?.primary_base_material, sku?.secondary_base_material].filter(Boolean).join(', ')], ['Inspection Type', typeOf(r)]],
    );

    if (r.inspection_result) {
      doc.needsPage(12);
      doc.text('INSPECTION RESULT', doc.M, doc.y + 4.4, { size: 6.2, bold: true, color: gray(125) });
      doc.resultBadge(r.inspection_result, doc.M + 36, doc.y, isPartialResult(r).isPartial);
      doc.y += 11;
    }

    doc.sectionTitle('Quantity Break-up');
    doc.table({
      head: [['Order Qty', 'Available Qty', 'Inspected Qty', 'Accepted Qty', 'Carton Available']],
      body: [[fmtQty(li?.quantity_ordered), fmtQty(r.available_quantity), fmtQty(r.inspected_qty), fmtQty(r.accepted_quantity), fmtQty(r.carton_available)]],
    });

    doc.sectionTitle('Packaging - Appearance & Labeling');
    doc.table({
      head: [['Type', 'Sample Size', 'Result']],
      body: PACKAGING_ROWS.map(([key, label]) => {
        const v = r.packaging_appearance?.[key] || {};
        return [label, v.sample_size || planSizeStr || '-', v.result || 'pass'];
      }),
      columnWidths: [doc.CW * 0.4, doc.CW * 0.35, doc.CW * 0.25],
    });

    doc.sectionTitle('Packaging - Measurement, Weight & Quantity');
    const measHeadH = doc.drawMeasurementHead(doc.y);
    doc.y += measHeadH;
    doc.table({
      head: [['', '', '', '', '', '', '', '', '', '', '']], // header already drawn above; body only
      body: MEASUREMENT_ROWS.map(([key, label]) => {
        const spec = specForMeasurementRow(sku, key);
        const f = r.packaging_measurement_findings?.[key] || {};
        return [label, spec.l ?? '-', spec.b ?? '-', spec.h ?? '-', spec.wt ?? '-', spec.qty ?? '-', f.l ?? '-', f.b ?? '-', f.h ?? '-', f.wt ?? '-', f.result || 'pass'];
      }),
      columnWidths: [doc.CW * 0.14, ...Array(10).fill(doc.CW * 0.086)],
      fontSize: 6.2,
    });

    doc.sectionTitle('Barcodes');
    doc.table({
      head: [['Type', 'Specification', 'Result']],
      body: BARCODE_ROWS.map(([key, label]) => [label, specBarcodeForRow(sku, key) || '-', r.barcode_results?.[key]?.result || 'pass']),
      columnWidths: [doc.CW * 0.3, doc.CW * 0.45, doc.CW * 0.25],
    });

    doc.sectionTitle('On-site Tests');
    const performedRows = ONSITE_ROWS.filter(([key]) => r.onsite_tests?.[key]?.performed === 'yes');
    const onsiteRows = performedRows.length ? performedRows : ONSITE_ROWS.filter(([key]) => {
      const v = r.onsite_tests?.[key];
      return v && (v.inspection_level || v.sample_size || v.result);
    });
    doc.table({
      head: [['Test', 'Inspection Level', 'Sample Size', 'Result']],
      body: onsiteRows.map(([key, label]) => {
        const v = r.onsite_tests?.[key] || {};
        return [label, v.inspection_level || '-', v.sample_size || '-', v.result || '-'];
      }),
    });

    doc.sectionTitle('Workmanship - Visual Inspection');
    doc.twoColBox(
      [['Inspection Level', r.workmanship_inspection_level || po.inspection_level], ['Sample Size', r.workmanship_sample_size || planSizeStr]],
      [['AQL Critical', r.aql_critical], ['AQL Major / Minor', [r.aql_major, r.aql_minor].filter((v) => v != null).join('  /  ')]],
    );

    const defects = r.inspection_report_defects || [];
    const totals = defects.reduce((acc, d) => ({
      critical: acc.critical + Number(d.critical_count || 0), major: acc.major + Number(d.major_count || 0), minor: acc.minor + Number(d.minor_count || 0),
    }), { critical: 0, major: 0, minor: 0 });
    const foot = [['', 'Total defective units found', totals.critical, totals.major, totals.minor, '']];
    if (plan) foot.push(['', 'Acceptable limits (Ac)', plan.critical.ac, plan.major ? plan.major.ac : '-', plan.minor ? plan.minor.ac : '-', '']);
    doc.table({
      head: [['#', 'Defect', 'Critical', 'Major', 'Minor', 'Remarks']],
      body: defects.length ? defects.map((d, i) => [i + 1, d.defect_description || '-', d.critical_count || 0, d.major_count || 0, d.minor_count || 0, d.remarks || '-'])
        : [['-', 'No defects recorded', '', '', '', '']],
      foot,
      columnWidths: [doc.CW * 0.06, doc.CW * 0.3, doc.CW * 0.13, doc.CW * 0.13, doc.CW * 0.13, doc.CW * 0.25],
    });

    const workmanshipRemarksText = stripHtml(r.workmanship_remarks);
    if (workmanshipRemarksText) {
      const wrapped = wrapText(fonts.regular, workmanshipRemarksText, 7.6, doc.CW - doc.PAD * 2);
      const bh = wrapped.length * 3.9 + doc.PAD * 2;
      doc.needsPage(bh + 4);
      doc.rect(doc.M, doc.y, doc.CW, bh, { border: gray(200), borderWidth: 0.5 });
      doc.text(wrapped, doc.M + doc.PAD, doc.y + doc.PAD + 2.6, { size: 7.6, color: gray(30) });
      doc.y += bh + 5;
    }

    const skuComments = skuCommentsByLineItem[r.po_line_item_id] || [];
    if (skuComments.length) {
      doc.sectionTitle('Comments');
      skuComments.forEach((c, i) => {
        const when = c.created_at ? new Date(c.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        const wrapped = wrapText(fonts.regular, `${i + 1}.  ${c.comment}  (${c.created_by || 'Unknown'}${when ? `, ${when}` : ''})`, 7.6, doc.CW - doc.PAD * 2);
        doc.needsPage(wrapped.length * 3.8 + 3);
        doc.text(wrapped, doc.M + doc.PAD, doc.y + 3, { size: 7.6, color: gray(25) });
        doc.y += wrapped.length * 3.8 + 2;
      });
      doc.y += 3;
    }

    if (!single) {
      doc.sectionTitle('Sign-off');
      await doc.signOffBlock(r);
    }

    await doc.photoPages(r.inspection_report_photos, `Digitals - ${li?.buyer_sku_ref ?? ''}`, photoPreloaded);
  }

  // ── Footer on every page ───────────────────────────────────────────────
  const total = pdf.getPageCount();
  for (let i = 0; i < total; i++) {
    const p = pdf.getPage(i);
    p.drawLine({ start: { x: mm(doc.M), y: mm(doc.PH - 11) }, end: { x: mm(doc.W - doc.M), y: mm(doc.PH - 11) }, thickness: 0.3, color: gray(220) });
    p.drawText('Twif Technologies', { x: mm(doc.W / 2 - 15), y: mm(doc.PH - 7), size: 6.8, font: fonts.regular, color: gray(150) });
    p.drawText(pdfSafeText(fonts.regular, `${po.po_number || ''}`), { x: mm(doc.M), y: mm(doc.PH - 7), size: 6.8, font: fonts.regular, color: gray(150) });
    p.drawText(`${i + 1} / ${total}`, { x: mm(doc.W - doc.M - 12), y: mm(doc.PH - 7), size: 6.8, font: fonts.regular, color: gray(150) });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const partSuffix = partLabel ? `-part${partLabel.index}of${partLabel.count}` : '';
  const filename = single
    ? `inspection-report-${safe(po.po_number || 'po')}-${safe(lineItemFor(reports[0])?.buyer_sku_ref || 'sku')}-${safe(reports[0].report_no || stamp)}${partSuffix}.pdf`
    : `inspection-report-${safe(po.po_number || 'po')}-${reports.length}-skus-${stamp}${partSuffix}.pdf`;

  const bytes = await pdf.save();
  return { buffer: Buffer.from(bytes), filename };
}

// ANSI/ASQ Z1.4 (MIL-STD-105E) single-sampling-plan lookup, ported verbatim
// from the frontend's src/lib/samplingPlan.js's own resolveSamplingPlan
// - same lot-size brackets, sample sizes, and resolved Ac/Re pairs, so the
// "Acceptable limits (Ac)" defect-table footer row here matches the exact
// numbers the client version has always shown, not a guess.
const LOT_SIZE_BRACKETS = [
  { max: 8, row: { 'G-I': 'A', 'G-II': 'A', 'G-III': 'B', 'S-1': 'A', 'S-2': 'A', 'S-3': 'A', 'S-4': 'A' } },
  { max: 15, row: { 'G-I': 'A', 'G-II': 'B', 'G-III': 'C', 'S-1': 'A', 'S-2': 'A', 'S-3': 'A', 'S-4': 'A' } },
  { max: 25, row: { 'G-I': 'B', 'G-II': 'C', 'G-III': 'D', 'S-1': 'A', 'S-2': 'A', 'S-3': 'B', 'S-4': 'B' } },
  { max: 50, row: { 'G-I': 'C', 'G-II': 'D', 'G-III': 'E', 'S-1': 'A', 'S-2': 'B', 'S-3': 'B', 'S-4': 'C' } },
  { max: 90, row: { 'G-I': 'C', 'G-II': 'E', 'G-III': 'F', 'S-1': 'B', 'S-2': 'B', 'S-3': 'C', 'S-4': 'C' } },
  { max: 150, row: { 'G-I': 'D', 'G-II': 'F', 'G-III': 'G', 'S-1': 'B', 'S-2': 'B', 'S-3': 'C', 'S-4': 'D' } },
  { max: 280, row: { 'G-I': 'E', 'G-II': 'G', 'G-III': 'H', 'S-1': 'B', 'S-2': 'C', 'S-3': 'D', 'S-4': 'E' } },
  { max: 500, row: { 'G-I': 'F', 'G-II': 'H', 'G-III': 'J', 'S-1': 'B', 'S-2': 'C', 'S-3': 'D', 'S-4': 'E' } },
  { max: 1200, row: { 'G-I': 'G', 'G-II': 'J', 'G-III': 'K', 'S-1': 'C', 'S-2': 'C', 'S-3': 'E', 'S-4': 'F' } },
  { max: 3200, row: { 'G-I': 'H', 'G-II': 'K', 'G-III': 'L', 'S-1': 'C', 'S-2': 'D', 'S-3': 'E', 'S-4': 'G' } },
  { max: 10000, row: { 'G-I': 'J', 'G-II': 'L', 'G-III': 'M', 'S-1': 'C', 'S-2': 'D', 'S-3': 'F', 'S-4': 'G' } },
  { max: 35000, row: { 'G-I': 'K', 'G-II': 'M', 'G-III': 'N', 'S-1': 'C', 'S-2': 'D', 'S-3': 'F', 'S-4': 'H' } },
  { max: 150000, row: { 'G-I': 'L', 'G-II': 'N', 'G-III': 'P', 'S-1': 'D', 'S-2': 'E', 'S-3': 'G', 'S-4': 'J' } },
  { max: 500000, row: { 'G-I': 'M', 'G-II': 'P', 'G-III': 'Q', 'S-1': 'D', 'S-2': 'E', 'S-3': 'G', 'S-4': 'J' } },
  { max: Infinity, row: { 'G-I': 'N', 'G-II': 'Q', 'G-III': 'R', 'S-1': 'D', 'S-2': 'E', 'S-3': 'H', 'S-4': 'K' } },
];
const SAMPLE_SIZE_BY_LETTER = { A: 2, B: 3, C: 5, D: 8, E: 13, F: 20, G: 32, H: 50, J: 80, K: 125, L: 200, M: 315, N: 500, P: 800, Q: 1250, R: 2000 };
const AC_RE_MAJOR_2_5 = { A: [0, 1], B: [0, 1], C: [0, 1], D: [1, 2], E: [1, 2], F: [1, 2], G: [2, 3], H: [3, 4], J: [5, 6], K: [7, 8], L: [10, 11], M: [14, 15], N: [21, 22], P: [21, 22], Q: [21, 22], R: [21, 22] };
const AC_RE_MINOR_4_0 = { A: [0, 1], B: [0, 1], C: [0, 1], D: [1, 2], E: [1, 2], F: [2, 3], G: [3, 4], H: [5, 6], J: [7, 8], K: [10, 11], L: [14, 15], M: [21, 22], N: [21, 22], P: [21, 22], Q: [21, 22], R: [21, 22] };

function resolveSamplingPlan({ lotSize, inspectionLevel }) {
  const n = Number(lotSize);
  if (!n || n < 2 || !inspectionLevel) return null;
  const bracket = LOT_SIZE_BRACKETS.find((b) => n <= b.max);
  const codeLetter = bracket?.row?.[inspectionLevel];
  if (!codeLetter) return null;
  const sampleSize = SAMPLE_SIZE_BY_LETTER[codeLetter];
  const major = AC_RE_MAJOR_2_5[codeLetter];
  const minor = AC_RE_MINOR_4_0[codeLetter];
  return {
    codeLetter, sampleSize, critical: { ac: 0, re: 1 },
    major: major ? { ac: major[0], re: major[1] } : null,
    minor: minor ? { ac: minor[0], re: minor[1] } : null,
  };
}

// Splits a report selection into parts capped by total photo count - same
// reasoning/threshold as the client's own splitReportsIntoParts.
function splitReportsIntoParts(reports, maxPhotosPerPart = DEFAULT_SPLIT_PHOTO_THRESHOLD) {
  const parts = [];
  let current = [];
  let currentPhotos = 0;
  for (const r of reports) {
    const photoCount = (r.inspection_report_photos || []).length;
    if (current.length && currentPhotos + photoCount > maxPhotosPerPart) {
      parts.push(current);
      current = [];
      currentPhotos = 0;
    }
    current.push(r);
    currentPhotos += photoCount;
  }
  if (current.length) parts.push(current);
  return parts;
}

// Orchestrates the two real modes a caller ever wants:
// - 'preview': always ONE merged PDF (never split - there's no browser
//   memory ceiling here to split around), downscaled photos, no batch
//   number allocated. Optimized to be small and fast, not a real delivery.
// - 'final': full original quality, batch number allocated, split into
//   several part-PDFs zipped together (adm-zip) only if the photo count
//   actually warrants it - kept for download/email practicality, not
//   crash prevention (the server has no such ceiling either). Used
//   identically for Download, Send Mail's attachment, and Export All.
async function generateInspectionReportPdf(po, reports, skuMasterById, options = {}) {
  // Photos in the order they were taken (camera file number, upload time as
  // fallback) - one rule for every part, preview and final alike.
  reports = reports.map(withSortedPhotos);
  const { mode = 'final', maxPhotosPerPart = DEFAULT_SPLIT_PHOTO_THRESHOLD, createdBy = null } = options;
  const isPreview = mode === 'preview';
  const buildOptions = { allocateBatchNo: !isPreview, previewQuality: isPreview, createdBy };

  if (isPreview) {
    const { buffer, filename } = await buildInspectionReportPdf(po, reports, skuMasterById, buildOptions);
    return { buffer, filename, isZip: false, partCount: 1 };
  }

  const totalPhotos = reports.reduce((n, r) => n + (r.inspection_report_photos || []).length, 0);
  if (reports.length <= 1 || totalPhotos <= maxPhotosPerPart) {
    const { buffer, filename } = await buildInspectionReportPdf(po, reports, skuMasterById, buildOptions);
    return { buffer, filename, isZip: false, partCount: 1 };
  }

  // Parts are built ONE AT A TIME, not via Promise.all - each part preloads
  // every one of its own photos into memory at full original quality before
  // it starts laying out pages (see buildInspectionReportPdf's own
  // photoPreloaded), so running every part concurrently multiplied that
  // peak by the part count. Production hit this live as a Cloud Run 503 on
  // an 8-report/300-photo batch (3 parts) even after raising the service to
  // 2Gi/2cpu - 3 parts' worth of full-quality decoded photos in flight at
  // once was still enough to get OOM-killed. Sequential building keeps peak
  // memory to roughly one part's worth regardless of how many parts a batch
  // splits into, at the cost of wall-clock time the 3600s route timeout has
  // plenty of room for.
  const parts = splitReportsIntoParts(reports, maxPhotosPerPart);
  const built = [];
  for (let i = 0; i < parts.length; i++) {
    built.push(await buildInspectionReportPdf(po, parts[i], skuMasterById, { ...buildOptions, partLabel: { index: i + 1, count: parts.length } }));
  }
  const zip = new AdmZip();
  for (const { buffer, filename } of built) zip.addFile(filename, buffer);
  const stamp = new Date().toISOString().slice(0, 10);
  const zipName = `inspection-report-${safe(po.po_number || 'po')}-${reports.length}-skus-${stamp}.zip`;
  return { buffer: zip.toBuffer(), filename: zipName, isZip: true, partCount: parts.length };
}

module.exports = { buildInspectionReportPdf, generateInspectionReportPdf, splitReportsIntoParts, DEFAULT_SPLIT_PHOTO_THRESHOLD };
