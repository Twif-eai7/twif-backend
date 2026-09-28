const { Redis } = require('@upstash/redis')
const express = require("express");
const multer = require('multer');
const xlsx = require('xlsx');
const AdmZip = require('adm-zip');
const { randomUUID } = require('crypto');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf');
const { createCanvas } = require('canvas');
const { GoogleGenAI } = require('@google/genai');
const router = express.Router()
const supabase = require('../supabaseClient')
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
const REDIS_TTL = 60 * 60 * 24

router.get('/', async (req, res) => {
  const { buyerOrgId } = req.query
  if (!buyerOrgId) return res.status(400).json({ error: 'buyerOrgId required' })

  const key = `skus:buyer:${buyerOrgId}`

  try {
    const cached = await redis.get(key)
    if (cached) return res.json({ skus: cached, source: 'cache' })
  } catch {
    // Redis unavailable — fall through to Supabase
  }

  const PAGE_SIZE = 1000
  let from = 0
  let allSkus = []

  while (true) {
    const { data, error } = await supabase
      .from('skus')
      .select('id, buyer_sku_ref, sku_variant, description, base_price, currency')
      .eq('buyer_org_id', buyerOrgId)
      .order('buyer_sku_ref')
      .range(from, from + PAGE_SIZE - 1)

    if (error) return res.status(500).json({ error: error.message })

    allSkus = allSkus.concat(data ?? [])
    if ((data ?? []).length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  try { redis.set(key, allSkus, { ex: REDIS_TTL }) } catch { /* fire-and-forget */ }

  return res.json({ skus: allSkus })
})


// Called by the frontend right after creating/editing a SKU (which writes
// straight to Supabase via RPC, never through this router) — without an
// explicit bust here, GET /'s cache above would keep serving the pre-write
// list for up to REDIS_TTL regardless of how many tabs/sessions reload.
router.delete('/cache', async (req, res) => {
  const { buyerOrgId } = req.query
  if (!buyerOrgId) return res.status(400).json({ error: 'buyerOrgId required' })
  try { await redis.del(`skus:buyer:${buyerOrgId}`) } catch { /* best-effort */ }
  return res.json({ ok: true })
})


router.post('/sync', async (req, res) => {
  const PAGE_SIZE = 1000
  let from = 0
  let allSkus = []

  while (true) {
    const { data, error } = await supabase
      .from('skus')
      .select('id, buyer_sku_ref, sku_variant, description, base_price, currency, buyer_org_id')
      .order('buyer_sku_ref')
      .range(from, from + PAGE_SIZE - 1)

    if (error) return res.status(500).json({ error: error.message })

    allSkus = allSkus.concat(data ?? [])
    if ((data ?? []).length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  const byOrg = {}
  for (const sku of allSkus) {
    if (!sku.buyer_org_id) continue
    if (!byOrg[sku.buyer_org_id]) byOrg[sku.buyer_org_id] = []
    byOrg[sku.buyer_org_id].push(sku)
  }

  const orgIds = Object.keys(byOrg)
  await Promise.all(
    orgIds.map(orgId =>
      redis.set(`skus:buyer:${orgId}`, byOrg[orgId], { ex: REDIS_TTL })
    )
  )

  return res.json({ synced: orgIds.length, total: allSkus.length })
})


const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx/.xls files are accepted'), ok);
  },
});

// ---- Parsing logic (unchanged from validated version — do not fork this) ----

const FIELD_GROUPS = {
  item_size:   ['item size', 'product size'],
  inner_pack:  ['inner carton size', 'inner dimensions', 'ip', 'inner'],
  master_pack: ['master carton size', 'outer dimensions', 'box measurements', 'mp', 'master', 'outer'],
  price_fob:   ['price fob', 'price'],
  container_20: ['20ft'],
  container_40: ['40ft'],
};

const FIELD_RULES = [
  { canonical: 'buyer_sku_ref', group: null, leaf: ['buyer item #', 'buyer / vendor item #', 'customer ref no', 'item no.', 'buyer item no.'] },
  { canonical: 'vendor_sku_ref', group: null, leaf: ['vendor code', 'factory item no'] },
  { canonical: 'description', group: null, leaf: ['item description', 'description of goods', 'description'] },
  { canonical: 'colour', group: null, leaf: ['colour', 'color', 'finish/color'] },
  { canonical: 'colour', group: FIELD_GROUPS.item_size.concat(['material &']), leaf: ['finish'] },
  { canonical: 'primary_base_material', group: null, leaf: ['material / finish', 'material &', 'composition', 'material'] },
  { canonical: 'base_price', group: null, leaf: ['price', 'rate'] },
  { canonical: 'base_price_revised', group: FIELD_GROUPS.price_fob, leaf: ['revised'] },
  { canonical: 'base_price_mumbai', group: FIELD_GROUPS.price_fob, leaf: ['mumbai'] },
  { canonical: 'weight_kg', group: null, leaf: ['weight (kgs.)', 'item weight (kgs.)', 'net weight in kg', 'product net weight in kg'] },

  { canonical: 'length', group: FIELD_GROUPS.item_size, leaf: ['l'] },
  { canonical: 'breadth', group: FIELD_GROUPS.item_size, leaf: ['w'] },
  { canonical: 'height', group: FIELD_GROUPS.item_size, leaf: ['h'] },

  { canonical: 'inner_pack_length', group: FIELD_GROUPS.inner_pack, leaf: ['l'] },
  { canonical: 'inner_pack_breadth', group: FIELD_GROUPS.inner_pack, leaf: ['w'] },
  { canonical: 'inner_pack_height', group: FIELD_GROUPS.inner_pack, leaf: ['h'] },
  { canonical: 'inner_pack_qty', group: FIELD_GROUPS.inner_pack.concat(['quantities']), leaf: ['qty', 'inner'] },
  { canonical: 'inner_pack_weight_kg', group: FIELD_GROUPS.inner_pack, leaf: ['weight (kgs.)', 'weight (kgs.) approximate', 'inner weight'] },

  { canonical: 'master_pack_length', group: FIELD_GROUPS.master_pack, leaf: ['l'] },
  { canonical: 'master_pack_breadth', group: FIELD_GROUPS.master_pack, leaf: ['w'] },
  { canonical: 'master_pack_height', group: FIELD_GROUPS.master_pack, leaf: ['h'] },
  { canonical: 'master_pack_qty', group: FIELD_GROUPS.master_pack.concat(['quantities']), leaf: ['qty', 'outer'] },
  { canonical: 'master_pack_weight_kg', group: FIELD_GROUPS.master_pack, leaf: ['weight (kgs.)', 'weight (kgs.) approximate', 'outer weight'] },

  { canonical: 'item_cbm', group: null, leaf: ['cbm/pcs'] },
  { canonical: 'master_pack_cbm', group: null, leaf: ['cbm/master carton', 'cbm/mc', 'cbm of 1 carton'] },

  { canonical: 'units_per_20ft', group: FIELD_GROUPS.container_20, leaf: ['qty'] },
  { canonical: 'units_per_40ft', group: FIELD_GROUPS.container_40, leaf: ['qty'] },

  { canonical: 'packing_material', group: null, leaf: ['packing'] },
];

const CONCAT_RULES = [
  { canonical: 'master_pack_cbm', tokens: ['cbm', 'm/c'] },
  { canonical: 'master_pack_cbm', tokens: ['cbm', 'master', 'carton'] },
];

const EXCLUDED_LEAF = ['order qty', 'total cbm', 'amount', 'no. of pcs'];

const NUMERIC_FIELDS = new Set([
  'base_price', 'base_price_revised', 'base_price_mumbai', 'weight_kg', 'length', 'breadth', 'height',
  'inner_pack_length', 'inner_pack_breadth', 'inner_pack_height', 'inner_pack_qty', 'inner_pack_weight_kg',
  'master_pack_length', 'master_pack_breadth', 'master_pack_height', 'master_pack_qty', 'master_pack_weight_kg',
  'item_cbm', 'master_pack_cbm', 'units_per_20ft', 'units_per_40ft',
]);

const ID_FIELDS = new Set(['buyer_sku_ref', 'vendor_sku_ref']);
const SUBHEADER_TOKENS = new Set(['l', 'w', 'h', 'qty']);
const FLAGGABLE_FIELDS = ['buyer_sku_ref', 'description', 'base_price'];

function norm(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }

function leafMatches(leaf, ruleLeaf) {
  if (ruleLeaf.length <= 1) return leaf === ruleLeaf;
  return leaf === ruleLeaf || leaf.includes(ruleLeaf);
}

function detectTier(leaf) {
  if (leaf.startsWith('inner')) return 'inner';
  if (leaf.startsWith('outer')) return 'outer';
  return null;
}

function mapTierLeafToCanonical(tier, leaf) {
  const prefix = tier === 'inner' ? 'inner_pack' : 'master_pack';
  if (leaf.includes('dimensions')) return null;
  if (leaf.includes('weight')) return `${prefix}_weight_kg`;
  if (leaf === 'qty') return `${prefix}_qty`;
  return null;
}

function splitDimensionString(cell) {
  if (typeof cell !== 'string') return null;
  const match = cell.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  return { l: parseFloat(match[1]), w: parseFloat(match[2]), h: parseFloat(match[3]) };
}

function looksLikeSubHeaderRow(row) {
  const nonNull = row.filter(c => c !== null && String(c).trim() !== '');
  if (nonNull.length < 2) return false;
  return nonNull.filter(c => SUBHEADER_TOKENS.has(norm(c))).length >= 2;
}

function flattenHeaders(row1, row2) {
  const width = Math.max(row1.length, (row2 || []).length);
  const filledGroup = [];
  let lastGroup = null;
  for (let i = 0; i < width; i++) {
    const cell = row1[i];
    if (cell !== null && cell !== undefined && String(cell).trim() !== '') lastGroup = norm(cell);
    filledGroup[i] = lastGroup;
  }
  return Array.from({ length: width }, (_, i) => {
    const leaf = row2 ? norm(row2[i]) : '';
    return { group: filledGroup[i], leaf: leaf || norm(row1[i]) };
  });
}

function matchColumn({ group, leaf }) {
  if (!leaf) return null;
  if (EXCLUDED_LEAF.some(x => leaf.includes(x))) return { excluded: true };

  const tier = detectTier(leaf);
  if (tier) {
    const tierField = mapTierLeafToCanonical(tier, leaf);
    if (tierField) return { canonical: tierField, confidence: 'tier-detected' };
  }

  const scoped = FIELD_RULES.filter(r => r.group).find(r =>
    r.group.some(g => group && group.includes(g)) && r.leaf.some(l => leafMatches(leaf, l))
  );
  if (scoped) return { canonical: scoped.canonical, confidence: 'group-scoped' };

  const bare = FIELD_RULES.filter(r => !r.group).find(r => r.leaf.some(l => leafMatches(leaf, l)));
  if (bare) return { canonical: bare.canonical, confidence: leaf === bare.leaf[0] ? 'exact' : 'fuzzy' };

  const combined = `${group || ''} ${leaf}`;
  const concatMatch = CONCAT_RULES.find(r => r.tokens.every(t => combined.includes(t)));
  if (concatMatch) return { canonical: concatMatch.canonical, confidence: 'concat-fallback' };

  return null;
}

function parseNumeric(cell) {
  if (cell === null || cell === undefined || cell === '') return { value: null, raw: cell, parsed: false };
  if (typeof cell === 'number') return { value: cell, raw: cell, parsed: true };
  const match = String(cell).match(/-?\d+(\.\d+)?/);
  if (!match) return { value: null, raw: cell, parsed: false };
  return { value: parseFloat(match[0]), raw: cell, parsed: true };
}

// xlsx.read's format auto-detection is lenient — given arbitrary binary
// (e.g. a PDF mistakenly attached as the product sheet instead of an actual
// vendor Excel file) it can still "succeed" by treating the bytes as
// garbage CSV-like text, rather than throwing. That garbage can even pass
// the header-row heuristic below, silently producing nonsense SKU rows
// instead of a clean failure. Rejecting anything that isn't a real .xlsx
// (zip signature `PK`) or legacy .xls (OLE2 signature) up front catches
// this before it gets anywhere near "succeeding" on the wrong file type.
function looksLikeExcelFile(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const sig = buffer.subarray(0, 4);
  const isZip  = sig[0] === 0x50 && sig[1] === 0x4b; // PK.. — .xlsx (OOXML)
  const isOle2 = sig[0] === 0xd0 && sig[1] === 0xcf && sig[2] === 0x11 && sig[3] === 0xe0; // legacy .xls
  return isZip || isOle2;
}

function parseWorkbook(buffer) {
  if (!looksLikeExcelFile(buffer)) {
    throw new Error('This file doesn\'t look like a valid Excel file (.xlsx/.xls) — please attach a real product sheet.');
  }
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheetIndex = 0;
  const sheetName = workbook.SheetNames[sheetIndex];
  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });

  const headerRowIdx = rows.findIndex(r => r.filter(c => c !== null).length >= 3);
  if (headerRowIdx === -1) throw new Error('Could not locate a header row in this sheet');

  const row1 = rows[headerRowIdx];
  const candidateRow2 = rows[headerRowIdx + 1] || [];
  const row2 = looksLikeSubHeaderRow(candidateRow2) ? candidateRow2 : null;
  const dataStartIdx = headerRowIdx + (row2 ? 2 : 1);

  const flatHeaders = flattenHeaders(row1, row2);
  const columnMap = flatHeaders.map(matchColumn);
  // absoluteIndex (0-indexed into the raw sheet) is what embedded-image
  // anchors are expressed in — carried through so the /import route can
  // match a picture pasted into a cell back to the row it belongs to.
  const rawDataRows = rows
    .map((r, absoluteIndex) => ({ r, absoluteIndex }))
    .slice(dataStartIdx)
    .filter(({ r }) => r.some(c => c !== null));

  const parsedRows = rawDataRows.map(({ r: row, absoluteIndex }) => {
    const mapped = {};
    const unmatched = {};
    row.forEach((cell, i) => {
      const fh = flatHeaders[i];
      if (!fh) return;

      if (fh.leaf.includes('dimensions')) {
        const dims = splitDimensionString(cell);
        const tier = detectTier(fh.leaf);
        const prefix = tier === 'inner' ? 'inner_pack' : 'master_pack';
        if (dims) {
          mapped[`${prefix}_length`] = dims.l;
          mapped[`${prefix}_breadth`] = dims.w;
          mapped[`${prefix}_height`] = dims.h;
        } else if (cell && cell !== 'N/A') {
          unmatched[`${prefix}_dimensions`] = cell;
        }
        return;
      }

      const match = columnMap[i];
      if (!match || match.excluded) return;

      if (NUMERIC_FIELDS.has(match.canonical)) {
        const { value, raw, parsed } = parseNumeric(cell);
        mapped[match.canonical] = value;
        if (!parsed && cell !== null) unmatched[match.canonical] = raw;
      } else if (ID_FIELDS.has(match.canonical)) {
        mapped[match.canonical] = cell !== null ? String(cell).trim() : null;
      } else {
        mapped[match.canonical] = cell;
      }
    });

    if (mapped.base_price == null) {
      mapped.base_price = mapped.base_price_revised ?? mapped.base_price_mumbai ?? null;
    }
    return { mapped, unmatched, absoluteIndex };
  });

  const allNull = r => Object.values(r.mapped).every(v => v === null || v === undefined);
  return { sheetName, sheetIndex, rows: parsedRows.filter(r => !allNull(r)) };
}

function classifyRow({ mapped, unmatched }) {
  const confirmed = {};
  const needs_confirm = {};
  const needs_input = {};

  for (const [field, value] of Object.entries(mapped)) {
    if (field.startsWith('base_price_') && field !== 'base_price') continue;
    if (unmatched[field] !== undefined) continue;
    if (value === null || value === undefined) {
      if (FLAGGABLE_FIELDS.includes(field)) needs_input[field] = null;
    } else {
      confirmed[field] = value;
    }
  }
  for (const [field, rawValue] of Object.entries(unmatched)) {
    needs_confirm[field] = rawValue;
  }
  FLAGGABLE_FIELDS.forEach(f => {
    if (!(f in confirmed) && !(f in needs_confirm) && !(f in needs_input)) needs_input[f] = null;
  });

  return { confirmed, needs_confirm, needs_input };
}

// ---- Embedded image extraction ----
// Vendor sheets tend to paste product photos directly into cells rather than
// linking a URL, so there's no column value for `xlsx` (a plain cell-value
// reader) to pick up — the images live as separate parts of the .xlsx zip
// (a drawing anchored to a cell, referencing a file under xl/media/). This
// walks that structure with plain regexes against the small, highly
// predictable XML involved, rather than pulling in a full XML parser.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']);

function xmlAttr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

// workbook.xml lists <sheet .../> in the same order as workbook.SheetNames;
// workbook.xml.rels maps each sheet's r:id to its worksheets/sheetN.xml file.
function findSheetXmlPath(zip, sheetIndex) {
  const wbXml = zip.getEntry('xl/workbook.xml')?.getData().toString('utf8');
  const wbRels = zip.getEntry('xl/_rels/workbook.xml.rels')?.getData().toString('utf8');
  if (!wbXml || !wbRels) return null;

  const sheetTags = [...wbXml.matchAll(/<sheet\b[^>]*\/>/g)].map(m => m[0]);
  const rId = xmlAttr(sheetTags[sheetIndex] || '', 'r:id');
  if (!rId) return null;

  const relTags = [...wbRels.matchAll(/<Relationship\b[^>]*\/>/g)].map(m => m[0]);
  const relTag = relTags.find(t => xmlAttr(t, 'Id') === rId);
  const target = relTag && xmlAttr(relTag, 'Target');
  if (!target) return null;
  return `xl/${target.replace(/^\.?\/?/, '')}`;
}

// Returns { [absoluteRowIndex]: { buffer, ext } } for every embedded image
// anchored to a cell in the given sheet. Best-effort: any missing/unexpected
// part (no drawing, unsupported format, malformed zip) just yields fewer
// entries rather than throwing — a sheet with no embedded images is the
// common case, not an error.
function extractEmbeddedImagesByRow(buffer, sheetIndex) {
  const byRow = {};
  try {
    const zip = new AdmZip(buffer);

    const sheetPath = findSheetXmlPath(zip, sheetIndex);
    if (!sheetPath) return byRow;
    const sheetFile = sheetPath.split('/').pop();

    const sheetRelsXml = zip.getEntry(`xl/worksheets/_rels/${sheetFile}.rels`)?.getData().toString('utf8');
    if (!sheetRelsXml) return byRow;
    const drawingRelTags = [...sheetRelsXml.matchAll(/<Relationship\b[^>]*\/>/g)].map(m => m[0]);
    const drawingRelTag = drawingRelTags.find(t => (xmlAttr(t, 'Target') || '').includes('drawing'));
    const drawingTarget = drawingRelTag && xmlAttr(drawingRelTag, 'Target');
    if (!drawingTarget) return byRow;

    const drawingPath = `xl/drawings/${drawingTarget.split('/').pop()}`;
    const drawingFile = drawingPath.split('/').pop();
    const drawingXml = zip.getEntry(drawingPath)?.getData().toString('utf8');
    if (!drawingXml) return byRow;

    const drawingRelsXml = zip.getEntry(`xl/drawings/_rels/${drawingFile}.rels`)?.getData().toString('utf8');
    if (!drawingRelsXml) return byRow;
    const mediaByRid = {};
    for (const tag of drawingRelsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
      const id = xmlAttr(tag[0], 'Id');
      const target = xmlAttr(tag[0], 'Target');
      if (id && target) mediaByRid[id] = `xl/media/${target.split('/').pop()}`;
    }

    const anchorBlocks = drawingXml.matchAll(/<xdr:(?:twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g);
    for (const anchor of anchorBlocks) {
      const block = anchor[1];
      const rowMatch = block.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
      const ridMatch = block.match(/r:embed="([^"]+)"/);
      if (!rowMatch || !ridMatch) continue;

      const mediaPath = mediaByRid[ridMatch[1]];
      const entry = mediaPath && zip.getEntry(mediaPath);
      if (!entry) continue;

      const ext = mediaPath.split('.').pop().toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue; // e.g. clipboard-pasted EMF/WMF — not web-renderable

      const absoluteRow = parseInt(rowMatch[1], 10); // 0-indexed, matches parseWorkbook's absoluteIndex
      byRow[absoluteRow] = { buffer: entry.getData(), ext };
    }
  } catch {
    return byRow; // malformed/unexpected zip structure — treat as "no images found"
  }
  return byRow;
}

function pathSegment(s, fallback) {
  const trimmed = (s ?? '').toString().trim();
  return trimmed ? trimmed.replace(/[\\/]+/g, '-') : fallback;
}

// ---- Material matching ----
// The parser already extracts a raw material string into
// confirmed.primary_base_material via the existing 'material'/'material /
// finish'/'composition' column rules — this just tries to resolve that text
// to a material_options row so the reviewer doesn't have to re-pick it by
// hand when the sheet's wording happens to already match the curated list
// (normalized exact match only, by label or code — not fuzzy). No match just
// means the picker in SkuReviewDrawer starts empty, same as before.
async function fetchMaterialLookup() {
  const { data, error } = await supabase.from('material_options').select('id, code, label');
  const map = new Map();
  if (error || !data) return map;
  for (const m of data) {
    map.set(norm(m.label), m.id);
    if (m.code) map.set(norm(m.code), m.id);
  }
  return map;
}

// ---- Routes ----

// A SKU is identified by buyer_sku_ref *within a given variant* — the same
// buyer ref legitimately repeats across colour/size variants (each is its
// own skus row via sku_variant), so both have to match for something to
// count as already existing, not buyer_sku_ref alone.
function dedupeKey(buyerSkuRef, variant) {
  return `${norm(buyerSkuRef)}|${norm(variant)}`;
}

// Tags a thrown error with which HTTP status it should map to, so callers
// with different needs (the /import route maps this to a response status;
// the product-details-uploaded webhook just logs and moves on) can both use
// the same function without duplicating the parsing/dedupe/image logic.
function taggedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Vendor sheets routinely mix genuinely new SKUs with ones already created
// for this buyer (an earlier import, or by hand) — a matching row stays in
// the batch but gets linked to that existing sku_id instead of creating a
// duplicate on confirm (confirm_sku_import_row already merges into an
// existing sku_id when one's set on the row — see sql/sku_import.sql).
// Paginated (not a single unbounded select) — a buyer with a large enough
// catalog would otherwise silently fall past PostgREST's default row cap
// and this lookup would miss real matches past that point. Shared by both
// the deterministic and Gemini-fallback parsing paths.
async function fetchExistingSkuIdsByDedupeKey(buyerOrgId) {
  const EXISTING_SKUS_PAGE_SIZE = 1000;
  let existingSkus = [];
  let existingFrom = 0;
  while (true) {
    const { data, error: existingErr } = await supabase
      .from('skus')
      .select('id, buyer_sku_ref, sku_variant')
      .eq('buyer_org_id', buyerOrgId)
      .is('delete_meta', null)
      .range(existingFrom, existingFrom + EXISTING_SKUS_PAGE_SIZE - 1);
    if (existingErr) throw taggedError('DB_ERROR', existingErr.message);

    existingSkus = existingSkus.concat(data ?? []);
    if ((data ?? []).length < EXISTING_SKUS_PAGE_SIZE) break;
    existingFrom += EXISTING_SKUS_PAGE_SIZE;
  }
  return new Map(existingSkus.map(s => [dedupeKey(s.buyer_sku_ref, s.sku_variant), s.id]));
}

// Same normalized (label/code) lookup the deterministic path already
// performs — factored out so the Gemini fallback resolves materials
// identically instead of duplicating the lookup.
function resolveMaterialId(confirmed, materialLookup) {
  if (!confirmed.primary_base_material) return;
  const materialId = materialLookup.get(norm(confirmed.primary_base_material));
  if (materialId) confirmed.primary_base_material_id = materialId;
}

// ---- Gemini fallback parsing ----
// For files parseSkuSheet's deterministic xlsx-based parser can't handle —
// either not Excel at all (a PDF product sheet) or a genuine Excel file whose
// layout doesn't match any FIELD_RULES column pattern. Produces the exact
// same shape parseSkuSheet returns, so callers need no changes downstream of
// the parse call — every row still goes through the same classifyRow/
// material/dedupe logic, only how the raw fields get extracted differs.

function isPdfFile(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const sig = buffer.subarray(0, 4);
  return sig[0] === 0x25 && sig[1] === 0x50 && sig[2] === 0x44 && sig[3] === 0x46; // %PDF
}

// For a genuine .xlsx/.xls the deterministic parser still couldn't make
// sense of — skips parseWorkbook's header-row heuristic and column-matching
// entirely and just hands Gemini the raw grid as text; it's often better
// than a rigid column-matcher at inferring structure from an unusual layout.
// If xlsx.read itself throws here, the buffer is genuinely corrupted (not
// just an unusual layout) — let that propagate, nothing more to try.
function dumpRawSheetText(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  return xlsx.utils.sheet_to_csv(workbook.Sheets[sheetName]);
}

// Mirrors plm.js's extractSlidesFromPdf — render each page to a PNG via
// pdfjs-dist + canvas, plus pull any embedded text as OCR-assist grounding
// for the Gemini prompt. Capped at MAX_PDF_PAGES: a product sheet is
// realistically a handful of pages; this just guards against a
// pathologically large attachment blowing up a single Gemini call.
const MAX_PDF_PAGES = 20;

async function renderPdfPagesToImages(buffer) {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  const pages = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const textContent = await page.getTextContent();
    const lines = textContent.items.map(item => item.str?.trim()).filter(Boolean);

    pages.push({ buffer: canvas.toBuffer('image/png'), mimeType: 'image/png', lines });
  }

  return pages;
}

// Broader than FIELD_RULES (the Excel column-mapper's field set) — Gemini
// isn't limited to "which column exists in this sheet" the way the
// deterministic parser is, so this instead mirrors the FULL field set the
// review UI actually supports (src/components/orderManagement/
// skuFieldGroups.js in the frontend repo), so nothing visible on the
// document gets silently dropped just because the Excel parser never had a
// column rule for it (e.g. barcode, padding, 40HQ container loading).
// Excludes base_price_revised/base_price_mumbai — those are an
// Excel-column-specific sub-split merged into base_price upstream in
// parseWorkbook; a document Gemini reads has no equivalent split to
// preserve, just one price. Also excludes primary_base_material, which
// isn't part of skuFieldGroups.js's generic field list (rendered via its
// own MaterialSelectField.jsx) but is still resolved separately below via
// classifyRow/resolveMaterialId, same as the deterministic path.
const AI_EXTRACTION_FIELDS = [
  'buyer_sku_ref', 'vendor_sku_ref', 'description', 'colour', 'primary_base_material', 'base_price',
  'weight_kg', 'padding_cm', 'item_barcode', 'length', 'breadth', 'height',
  'inner_pack_qty', 'inner_pack_weight_kg', 'inner_pack_barcode',
  'inner_pack_length', 'inner_pack_breadth', 'inner_pack_height',
  'master_pack_qty', 'master_pack_weight_kg', 'master_pack_barcode',
  'master_pack_length', 'master_pack_breadth', 'master_pack_height',
  'item_cbm', 'inner_pack_cbm', 'master_pack_cbm',
  'units_per_20ft', 'units_per_40ft', 'units_per_40hq', 'packing_material',
];

function buildSkuSheetExtractionPrompt() {
  const fieldLines = AI_EXTRACTION_FIELDS.map(f => `    "${f}": ...`).join(',\n');
  return `You are a product catalog data extractor. You will receive a product/SKU sheet (as page images, or as raw sheet text) that a deterministic column parser could not make sense of.

Your job is to return every distinct SKU / line item you can find as a JSON array. Only include fields that are EXPLICITLY present in the document — do NOT infer, guess, or fill in anything not stated. Set a field to null if it is not explicitly present for that row.

Return ONLY a valid JSON array, one object per SKU/line item, each with exactly these keys:
[
  {
${fieldLines},
    "low_confidence_fields": ["field_name", ...]
  }
]

Rules:
- "low_confidence_fields" lists the keys above (only ones you actually returned a non-null value for) that you are NOT fully confident are correctly read — e.g. blurry text, ambiguous units, an unclear cell. Leave it as an empty array if every field you returned is clearly legible.
- Numeric fields (weight_kg, padding_cm, length, breadth, height, *_qty, *_cbm, units_per_*, base_price) must be plain numbers, no units or currency symbols.
- Barcode fields (item_barcode, inner_pack_barcode, master_pack_barcode) are the printed number/code itself (e.g. a UPC/EAN/GTIN digit string, or any code printed near/under a barcode symbol) — as a string. Not whether a barcode is present.
- weight_kg/length/breadth/height/barcode each exist at three levels: the item itself, its inner pack/carton, and its master pack/carton. If the document only gives ONE value for a field with no inner-pack or master-pack section around it, treat it as the item-level field (weight_kg, length, breadth, height, item_barcode) — only use the inner_pack_*/master_pack_* variants when the document clearly labels or groups that value under an inner-pack/carton or master-pack/carton section.
- Never invent or approximate a value.
- No explanation, no markdown — just the JSON array.`;
}

// Shared by any Gemini-based document extraction (product sheet, PI, …) —
// decides whether the buffer is Excel or PDF and builds the right
// `contents.parts` for either. Returns null for an unrecognized format
// (cheap no-op — nothing this pipeline can do for it).
async function buildGeminiExtractionParts(buffer, prompt) {
  if (looksLikeExcelFile(buffer)) {
    let csvText;
    try {
      csvText = dumpRawSheetText(buffer);
    } catch (err) {
      throw taggedError('AI_PARSE_ERROR', `Could not read this Excel file at all: ${err.message}`);
    }
    return { parts: [{ text: `${prompt}\n\nRaw sheet contents (CSV):\n${csvText}` }], docKind: 'Excel' };
  }
  if (isPdfFile(buffer)) {
    const pages = await renderPdfPagesToImages(buffer);
    const groundingText = pages
      .map((p, i) => (p.lines.length ? `\n\nPage ${i + 1} text:\n${p.lines.map(l => `• ${l}`).join('\n')}` : ''))
      .join('');
    const parts = [
      ...pages.map(p => ({ inlineData: { data: p.buffer.toString('base64'), mimeType: p.mimeType } })),
      { text: `${prompt}${groundingText}` },
    ];
    return { parts, docKind: 'PDF' };
  }
  return null;
}

// Shared Gemini call + JSON-array parsing, same strip-markdown-fence
// convention plm.js's extractFieldsWithGemini uses.
async function extractJsonArrayViaGemini(parts) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts },
    });
    const text = response.candidates[0].content.parts.find(p => p.text)?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    if (!Array.isArray(result)) throw new Error('Gemini did not return a JSON array');
    return result;
  } catch (err) {
    throw taggedError('AI_PARSE_ERROR', `Gemini extraction failed: ${err.message}`);
  }
}

async function parseSkuSheetWithGemini({ buffer, vendorId, buyerOrgId }) {
  const built = await buildGeminiExtractionParts(buffer, buildSkuSheetExtractionPrompt());
  if (!built) {
    // Nothing this function can do for an unrecognized format — cheap no-op,
    // caller's existing skip-with-no-batch behavior applies.
    return { batchId: null, sheetUsed: null, rowsParsed: 0, rowsLinkedExisting: 0, rows: [] };
  }
  const sheetUsed = `AI-extracted (Gemini, ${built.docKind})`;

  const extractedRows = await extractJsonArrayViaGemini(built.parts);

  const existingSkuIds = await fetchExistingSkuIdsByDedupeKey(buyerOrgId);
  const materialLookup = await fetchMaterialLookup();
  const batchId = randomUUID();

  const stagingRows = extractedRows.map((row, idx) => {
    const lowConfidence = new Set(Array.isArray(row.low_confidence_fields) ? row.low_confidence_fields : []);
    const mapped = {};
    const unmatched = {};
    for (const field of AI_EXTRACTION_FIELDS) {
      const value = row[field] ?? null;
      if (value !== null && lowConfidence.has(field)) unmatched[field] = value;
      else mapped[field] = value;
    }

    const { confirmed, needs_confirm, needs_input } = classifyRow({ mapped, unmatched });
    resolveMaterialId(confirmed, materialLookup);

    return {
      row_id: `${batchId}-${idx}`,
      batch_id: batchId,
      vendor_id: vendorId,
      status: 'pending_review',
      confirmed,
      needs_confirm,
      needs_input,
      raw_mapped: mapped,
      // Set (not dropped) when a matching SKU already exists — the row
      // still gets reviewed, but confirming it will enrich that SKU
      // (confirm_sku_import_row merges into an existing sku_id) instead of
      // creating a duplicate.
      sku_id: existingSkuIds.get(dedupeKey(mapped.buyer_sku_ref, mapped.colour)) ?? null,
    };
  });

  return {
    batchId,
    sheetUsed,
    rowsParsed: stagingRows.length,
    rowsLinkedExisting: stagingRows.filter(r => r.sku_id).length,
    rows: stagingRows,
  };
}

// ---- PI (Proforma Invoice) parsing ----
// A PI lists line items (ref, description, qty, price) rather than the
// physical/logistics fields a product sheet has — Gemini-only (no
// deterministic column-mapper attempt; an invoice layout isn't a fit for
// FIELD_RULES), reusing the same PDF/Excel extraction plumbing above via
// buildGeminiExtractionParts/extractJsonArrayViaGemini. See sql/pi_import.sql's
// confirm_pi_import_row for the other half — unlike a product-sheet row, a PI
// row's confirm step never writes to an existing SKU's fields, it only
// finds-or-creates (bare identity) and writes the PO's line item.

const PI_EXTRACTION_FIELDS = ['buyer_sku_ref', 'sku_variant', 'description', 'quantity_ordered', 'unit_price', 'currency'];
const PI_FLAGGABLE_FIELDS = ['buyer_sku_ref', 'description', 'quantity_ordered', 'unit_price'];

// Mirrors classifyRow's tiering logic exactly, just against PI_FLAGGABLE_FIELDS
// instead of the product-sheet's FLAGGABLE_FIELDS (kept as its own function
// rather than parameterizing classifyRow — the two field sets/semantics don't
// overlap enough to be worth threading a param through every existing call).
function classifyPiRow({ mapped, unmatched }) {
  const confirmed = {};
  const needs_confirm = {};
  const needs_input = {};

  for (const [field, value] of Object.entries(mapped)) {
    if (unmatched[field] !== undefined) continue;
    if (value === null || value === undefined) {
      if (PI_FLAGGABLE_FIELDS.includes(field)) needs_input[field] = null;
    } else {
      confirmed[field] = value;
    }
  }
  for (const [field, rawValue] of Object.entries(unmatched)) {
    needs_confirm[field] = rawValue;
  }
  PI_FLAGGABLE_FIELDS.forEach(f => {
    if (!(f in confirmed) && !(f in needs_confirm) && !(f in needs_input)) needs_input[f] = null;
  });

  return { confirmed, needs_confirm, needs_input };
}

function buildPiExtractionPrompt() {
  return `You are a purchase-order line-item extractor. You will receive a Proforma Invoice (PI) document (as page images, or as raw sheet text) listing the items being ordered.

Your job is to return every distinct line item you can find as a JSON array. Only include fields that are EXPLICITLY present in the document — do NOT infer, guess, or fill in anything not stated. Set a field to null if it is not explicitly present for that row.

Return ONLY a valid JSON array, one object per line item, each with exactly these keys:
[
  {
    "buyer_sku_ref": ...,
    "sku_variant": ...,
    "description": ...,
    "quantity_ordered": ...,
    "unit_price": ...,
    "currency": ...,
    "low_confidence_fields": ["field_name", ...]
  }
]

Rules:
- "buyer_sku_ref" is the buyer's/customer's own item/style/reference number for this line — not an internal PI line number or serial index.
- "sku_variant" is the colour/size/variant distinguishing this line from another with the same ref, if stated.
- "quantity_ordered" and "unit_price" must be plain numbers, no units or currency symbols.
- "currency" is the 3-letter code (e.g. USD, INR) the unit price is quoted in, if stated.
- "low_confidence_fields" lists the keys above (only ones you actually returned a non-null value for) that you are NOT fully confident are correctly read. Leave it as an empty array if every field you returned is clearly legible.
- Never invent or approximate a value.
- No explanation, no markdown — just the JSON array.`;
}

// A line already added to this PO shouldn't restage on a re-parse — but a
// SKU existing elsewhere in the catalog is exactly what should stage (to be
// *found* at confirm time, not silently dropped), so this dedupes against
// this PO's own po_line_items rather than the whole skus catalog the way
// product-sheet parsing does.
async function fetchExistingLineItemSkuIds(poId) {
  const { data, error } = await supabase.from('po_line_items').select('sku_id').eq('po_id', poId);
  if (error) throw taggedError('DB_ERROR', error.message);
  return new Set((data || []).map(r => r.sku_id).filter(Boolean));
}

async function parsePiFileWithGemini({ buffer, vendorId, buyerOrgId, poId }) {
  const built = await buildGeminiExtractionParts(buffer, buildPiExtractionPrompt());
  if (!built) {
    return { batchId: null, sheetUsed: null, rowsParsed: 0, rowsLinkedExisting: 0, rows: [] };
  }
  const sheetUsed = `AI-extracted (Gemini, ${built.docKind})`;

  const extractedRows = await extractJsonArrayViaGemini(built.parts);

  const existingSkuIds = await fetchExistingSkuIdsByDedupeKey(buyerOrgId);
  const existingLineItemSkuIds = await fetchExistingLineItemSkuIds(poId);
  const batchId = randomUUID();

  const stagingRows = extractedRows
    .map((row, idx) => {
      const lowConfidence = new Set(Array.isArray(row.low_confidence_fields) ? row.low_confidence_fields : []);
      const mapped = {};
      const unmatched = {};
      for (const field of PI_EXTRACTION_FIELDS) {
        const value = row[field] ?? null;
        if (value !== null && lowConfidence.has(field)) unmatched[field] = value;
        else mapped[field] = value;
      }

      const { confirmed, needs_confirm, needs_input } = classifyPiRow({ mapped, unmatched });
      const matchedSkuId = existingSkuIds.get(dedupeKey(mapped.buyer_sku_ref, mapped.sku_variant)) ?? null;

      return {
        row_id: `${batchId}-${idx}`,
        batch_id: batchId,
        vendor_id: vendorId,
        status: 'pending_review',
        confirmed,
        needs_confirm,
        needs_input,
        raw_mapped: mapped,
        sku_id: matchedSkuId,
        _alreadyOnThisPo: matchedSkuId ? existingLineItemSkuIds.has(matchedSkuId) : false,
      };
    })
    .filter(r => !r._alreadyOnThisPo)
    .map(({ _alreadyOnThisPo, ...r }) => r);

  return {
    batchId,
    sheetUsed,
    rowsParsed: stagingRows.length,
    rowsLinkedExisting: stagingRows.filter(r => r.sku_id).length,
    rows: stagingRows,
  };
}

// Extracted from the /import route so it's callable from other places that
// need "parse this sheet into staging rows" without going through HTTP —
// see the webhook route below, which reacts to a PO's product details file
// changing rather than a direct upload. Never touches sku_import_batches/
// sku_import_rows itself — callers persist the returned rows however suits
// them (the frontend does this client-side today, see createBatch in
// useSkuImport.js; the webhook route does it directly via supabase below).
async function parseSkuSheet({ buffer, vendorId, buyerOrgId }) {
  let result;
  try {
    result = parseWorkbook(buffer);
  } catch (err) {
    throw taggedError('PARSE_ERROR', err.message);
  }

  // Vendor sheets routinely mix genuinely new SKUs with ones already created
  // for this buyer (an earlier import, or by hand) — those rows stay in the
  // batch for review, linked to the existing sku_id, so confirming one
  // enriches that SKU rather than creating a duplicate.
  const existingSkuIds = await fetchExistingSkuIdsByDedupeKey(buyerOrgId);
  const materialLookup = await fetchMaterialLookup();

  const batchId = randomUUID();

  // Pasted-in photos, not a linked URL column — matched back to their row by
  // absoluteIndex, then uploaded here (rather than waiting for confirm) so
  // the review drawer can show them immediately, same product_images bucket
  // and buyerOrgId/skuRef/variant path convention the frontend's own
  // uploadSkuImage() uses (see useSkuImport.js) — a later manual re-upload
  // during review overwrites this same path via upsert.
  //
  // Reads the raw buffer as a zip (OOXML), independent of parseWorkbook's
  // own xlsx.read above — xlsx.read's format auto-detection can succeed
  // (as garbage CSV-like content) on a buffer that isn't really an Excel
  // file at all, e.g. a PDF mistakenly attached as the product sheet. AdmZip
  // then throws on that same buffer since it's not a valid zip, and unlike
  // parseWorkbook that throw was never tagged PARSE_ERROR, so it fell
  // through to the route's catch-all as a bare 500. No embedded images is a
  // fully recoverable case (same "non-fatal" reasoning as the per-image
  // upload failure below) — just means no image gets auto-attached.
  let imagesByRow = {};
  try {
    imagesByRow = extractEmbeddedImagesByRow(buffer, result.sheetIndex);
  } catch (err) {
    console.error('⚠️ Embedded image extraction failed, continuing without images:', err.message);
  }

  const stagingRows = await Promise.all(result.rows.map(async (row, idx) => {
    const { confirmed, needs_confirm, needs_input } = classifyRow(row);

    resolveMaterialId(confirmed, materialLookup);

    const image = imagesByRow[row.absoluteIndex];
    if (image) {
      const path = `${pathSegment(buyerOrgId, 'misc')}/${pathSegment(confirmed.buyer_sku_ref, 'unref')}/${pathSegment(confirmed.colour, 'default')}.${image.ext}`;
      const { error: uploadErr } = await supabase.storage
        .from('product_images')
        .upload(path, image.buffer, { upsert: true, contentType: `image/${image.ext === 'jpg' ? 'jpeg' : image.ext}` });
      if (!uploadErr) confirmed.image_url = `product_images::${path}`;
      // Upload failures are non-fatal — the row still imports, just without
      // a photo; the reviewer can attach one by hand in SkuReviewDrawer.
    }

    return {
      row_id: `${batchId}-${idx}`,
      batch_id: batchId,
      vendor_id: vendorId,
      status: 'pending_review',
      confirmed,
      needs_confirm,
      needs_input,
      raw_mapped: row.mapped,
      // Set (not dropped) when a matching SKU already exists — see the
      // Gemini path's identical comment above.
      sku_id: existingSkuIds.get(dedupeKey(row.mapped.buyer_sku_ref, row.mapped.colour)) ?? null,
    };
  }));

  return {
    batchId,
    sheetUsed: result.sheetName,
    rowsParsed: stagingRows.length,
    rowsLinkedExisting: stagingRows.filter(r => r.sku_id).length,
    rows: stagingRows,
  };
}

router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.body.vendor_id) return res.status(400).json({ error: 'vendor_id is required' });
  if (!req.body.buyer_org_id) return res.status(400).json({ error: 'buyer_org_id is required' });

  const vendorId = req.body.vendor_id;
  const buyerOrgId = req.body.buyer_org_id;

  let result;
  try {
    result = await parseSkuSheet({ buffer: req.file.buffer, vendorId, buyerOrgId });
  } catch (err) {
    if (err.code !== 'PARSE_ERROR') return res.status(500).json({ error: err.message });
    result = { rows: [] };
  }

  // A genuine .xlsx/.xls can "succeed" (real sheet, real header row) but
  // still end up with zero usable rows if none of its columns match any
  // FIELD_RULES pattern — same dead end for the reviewer as an outright
  // parse failure, and the same case the product-details-uploaded webhook
  // now falls back to Gemini for. Try it here too rather than handing back
  // an empty batch with no path forward besides manual entry.
  if (!result.rows.length) {
    try {
      result = await parseSkuSheetWithGemini({ buffer: req.file.buffer, vendorId, buyerOrgId });
    } catch (aiErr) {
      return res.status(422).json({ error: 'Could not parse this file', detail: aiErr.message });
    }
  }

  if (!result.rows.length) {
    return res.status(422).json({ error: 'Could not find any usable SKU rows in this file' });
  }

  return res.status(200).json({
    batch_id: result.batchId,
    sheet_used: result.sheetUsed,
    rows_parsed: result.rowsParsed,
    rows_linked_existing: result.rowsLinkedExisting,
    rows: result.rows,
  });
});


module.exports = router;
module.exports.parseSkuSheet = parseSkuSheet;
module.exports.parseSkuSheetWithGemini = parseSkuSheetWithGemini;
module.exports.parsePiFileWithGemini = parsePiFileWithGemini;