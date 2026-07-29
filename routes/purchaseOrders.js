const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')
const upload = require('../upload')
const { sendAlertEmail } = require('../service/emailService');
const { parseFileRef, buildFileRef, ACTIVE_BUCKET, resolveFileUrl,getPublicUrls } = require('../helper/storage');
const { convertAndStorePdf } = require('../helper/convertAndStorePdf');
const { link } = require('pdfkit');
const { requireAuth } = require('../middleware/auth')

const EXCEL_EXT = /\.(xlsx|xls|xlsm|xlsb|csv)$/i
const isExcel = filename => EXCEL_EXT.test(filename)

// PO numbers are free text — users routinely include "#" (e.g. "NEW PO#1123 JUNE"), which is
// a valid character in a stored object key but breaks retrieval: browsers treat an unencoded
// "#" in a URL as the start of a fragment, so anything after it in an href never reaches the
// server, and Supabase Storage's own key validation rejects "#" (and other reserved/unsafe
// characters) on the GET path even when the encoded upload succeeded. Strip anything unsafe
// before it ever becomes part of a storage path — slashes become dashes (kept readable as a
// separator), everything else disallowed is just dropped.
const sanitizePathSegment = (s) => (s || '')
  .replace(/\//g, '-')
  .replace(/[^a-zA-Z0-9 _-]/g, '')
  .trim()

// Same problem as sanitizePathSegment, but for the actual uploaded FILENAME rather than a
// folder segment — the original file's own name can carry "#" etc. too (e.g. a scanned PO
// literally named "#P0#009859C3.pdf"), which broke retrieval the same way. Keeps "." so
// extensions survive, unlike sanitizePathSegment which is only ever used for folder names.
const sanitizeFileName = (name) => (name || '')
  .replace(/\s+/g, '_')
  .replace(/[^a-zA-Z0-9._-]/g, '')

function displayRef(ref) {
  if (ref == null) return ref;
  if (typeof ref !== 'string') return ref;
  const { path } = parseFileRef(ref);
  return path || ref;
}
async function snapshotPOVersion(supabase, existingPO, updateData, updatedBy, changeType = 'po_edit') {
  // Get next version number
  const nextVersion = (existingPO.current_version ?? 1);

  // Determine which fields actually changed
  const fieldMap = {
    quantity_ordered: 'quantity_ordered',
    amount: 'amount',
    po_number: 'po_number',
    po_received_date: 'po_received_date',
    po_file_url: 'po_file_url',
    pi_file_url: 'pi_file_url',
    buyer_supplier_link_id: 'buyer_supplier_link_id',
  };

  const changedFields = Object.keys(fieldMap).filter(
    field => updateData[field] !== undefined && updateData[field] !== existingPO[field]
  );

  const changeSummary = changedFields
    .map(f => `${f}: ${displayRef(existingPO[f])} → ${displayRef(updateData[f])}`)
    .join(', ');

  const { error } = await supabase
    .from('purchase_order_versions')
    .insert({
      po_id: existingPO.id,
      version_number: nextVersion,
      snapshot: {
        // Store everything you'd need to reconstruct the PO at this point
        buyer_supplier_link_id: existingPO.buyer_supplier_link_id,
        po_number: existingPO.po_number,
        po_received_date: existingPO.po_received_date,
        quantity_ordered: existingPO.quantity_ordered,
        amount: existingPO.amount,
        po_file_url: existingPO.po_file_url,
        pi_file_url: existingPO.pi_file_url,
      },
      changed_fields: changedFields,
      changed_by: updatedBy,
      change_summary: changeSummary,
      change_type: changeType, 
    });

  if (error) throw error;

  return { nextVersion, changedFields, changeSummary };
}

function extractPathFromUrl(fileUrl) {
  if (!fileUrl) return '';

  // Strip bucket prefix first if present
  const { path } = parseFileRef(fileUrl);
  const cleanRef = path || fileUrl;

  if (!cleanRef.startsWith('http')) return cleanRef;

  const parts = cleanRef.split('/storage/v1/object/public/');
  if (parts.length === 2) {
    return parts[1].split('/').slice(1).join('/');
  }

  return cleanRef;
}

router.post('/create', upload.single('poFile'), async (req, res) => {
  let filePath = null
  const BUCKET_NAME = ACTIVE_BUCKET

  try {
    const {
      buyerSupplierLinkId,
      poReceivedDate,
      quantity,
      currency,
      amountUsd,
      value,
      poNumber,
      test
    } = req.body
    const onBehalfOfId = req.body.onBehalfOfId || null

    const { createdBy } = req.query
    const file = req.file

    //  onBehalfOfId,

    // ── Trim all string fields & sanitize PO number (strip slashes) ──
    // const trimmedOnBehalfOfId = onBehalfOfId?.trim() || null
    const trimmedPoReceivedDate = poReceivedDate?.trim()
    const trimmedQuantity      = quantity?.toString().trim()
    const trimmedValue         = value?.toString().trim()
    const trimmedAmountusd     = amountUsd?.toString().trim()
    const trimmedPoNumber      = poNumber?.trim()                        // original, saved to DB
    const safePoNumber         = sanitizePathSegment(trimmedPoNumber)   // sanitized, used in storage path only

    if (!trimmedPoReceivedDate || !file || !createdBy || !trimmedQuantity || !trimmedValue || !trimmedAmountusd || !trimmedPoNumber || !buyerSupplierLinkId || !currency) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const quantityNum = Number(trimmedQuantity)
    const valueNum    = Number(trimmedValue)
    const amountUsdNum  = Number(trimmedAmountusd)

    if (Number.isNaN(quantityNum) || Number.isNaN(valueNum) || Number.isNaN(amountUsdNum)) {
      return res.status(400).json({ error: 'Invalid quantity, value, or amount' })
    }

    /* ========================= DUPLICATE PO CHECK ========================= */

    const { data: existingPO, error: duplicateCheckError } = await supabase
      .from('purchase_orders')
      .select('id')
      .eq('buyer_supplier_link_id', buyerSupplierLinkId)
      .eq('po_number', trimmedPoNumber)
      .is('deleted_at', null)
      .is('delete_meta', null)
      .maybeSingle()

    if (duplicateCheckError) throw duplicateCheckError
    if (existingPO) {
      return res.status(409).json({
        error: `PO number "${trimmedPoNumber}" already exists for this buyer–supplier relationship`,
      })
    }
    const { data: linkData, error: linkError } = await supabase
  .from('buyer_supplier_links')
  .select('buyer_org_id, buyer:organizations!buyer_supplier_links_buyer_org_id_fkey(display_name)')
  .eq('id', buyerSupplierLinkId)
  .maybeSingle()

    if (linkError) {
    console.error('❌ Error fetching buyer org:', linkError)
    throw linkError
    }

    const safeBuyer = (linkData?.buyer?.display_name || 'UnknownBuyer')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()

    /* ========================= DATE + PATH HELPERS ========================= */

    const dateObj = new Date(trimmedPoReceivedDate)
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December']

    const monthFolder    = months[dateObj.getMonth()]
    const dayFolder      = String(dateObj.getDate()).padStart(2, '0')
    const year           = dateObj.getFullYear()
    const dbFormattedDate = `${monthFolder}-${dayFolder}-${year}`

    const {data:memberinfo, error:memberError} = await supabase
    .from('organization_members')
    .select('full_name')
    .eq('id', createdBy)
    .maybeSingle()
    if(memberError) {
      console.error('❌ Error fetching member info:', memberError)
      throw memberError
    }



    /* ========================= UPLOAD FILE ========================= */

    const safeFileName = sanitizeFileName(file.originalname)
    filePath = `${safeBuyer}/${monthFolder}/${dayFolder}/${safePoNumber}/po_${Date.now()}_${safeFileName}`

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: false })

    if (uploadError) throw uploadError

    /* ========================= INSERT PURCHASE ORDER ========================= */
    // Inserting here will trigger the po-alerts webhook automatically

    const { data: poRows, error: insertError } = await supabase
      .from('purchase_orders')
      .insert([{
        buyer_supplier_link_id: buyerSupplierLinkId,
        po_received_date:       dbFormattedDate,
        created_by_member_id:   createdBy,
        created_by:              memberinfo?.full_name,
        po_file_url:            buildFileRef(filePath),
        quantity_ordered:       quantityNum,
        currency:               currency,
        amount:                 valueNum,
        amount_usd:             amountUsdNum,
        po_number:              trimmedPoNumber,
        on_behalf_of:           onBehalfOfId,
        is_test:                test // allow "test" flag to mark this PO as a test record
      }])
      .select()

// on_behalf_of:           trimmedOnBehalfOfId,

    if (insertError) throw insertError

    const po = poRows[0]
    console.log('✅ PO created with ID:', po.id)
    if (isExcel(filePath)) {
      convertAndStorePdf(supabase, buildFileRef, filePath, po.id, BUCKET_NAME, 'po').catch(err =>
        console.error('❌ PO PDF conversion failed:', err)
      );
    }

    return res.json({
      success: true,
      poId: po.id,
      message: 'PO uploaded successfully',
    })
  

  } catch (err) {
    console.error('❌ PO Upload Error:', err)

    if (filePath) {
      console.log('🗑️ Cleaning up uploaded file:', filePath)
      await supabase.storage.from(BUCKET_NAME).remove([filePath])
    }

    return res.status(500).json({ error: err.message || 'Upload failed' })
  }
})


router.post('/confirm/:poId',
  upload.fields([
    { name: 'piFile', maxCount: 1 },
    { name: 'productDetailsFile', maxCount: 1 },
  ]),
  async (req, res) => {
  let filePath = null
  let poBucket = ACTIVE_BUCKET

  try {
    const databasePoId = req.params.poId
    const { poNumber, piReceivedDate, exFactoryDate, quantity, value, currency, amountUsd } = req.body
    const file = req.files?.piFile?.[0]
    const productDetailsFile = req.files?.productDetailsFile?.[0]  // optional

    if (!databasePoId || !piReceivedDate || !file || !exFactoryDate) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    /* =========================
       FETCH PO (WITH MORE FIELDS)
    ========================= */

    const { data: poData, error: poError } = await supabase
      .from('purchase_orders')
      .select(`
        id,
        po_file_url,
        po_number,
        po_received_date,
        quantity_ordered,
        amount,
        amount_usd,
        buyer_supplier_link_id,
        currency
      `)
      .eq('id', databasePoId)
      .maybeSingle()

    if (poError) {
      console.error('❌ PO fetch error:', poError)
      throw poError
    }

    if (!poData) {
      return res.status(404).json({ error: 'Purchase Order not found' })
    }

    console.log('✅ PO Data fetched:', poData)

    /* =========================
       RESOLVE BUYER + SUPPLIER
    ========================= */

    const { data: link, error: linkError } = await supabase
      .from('buyer_supplier_links')
      .select(`
        buyer_org_id,
        buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
        supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
      `)
      .eq('id', poData.buyer_supplier_link_id)
      .maybeSingle()

    if (linkError) {
      console.error('❌ Link fetch error:', linkError)
      throw linkError
    }

    if (!link) throw new Error('Buyer–Supplier link not found')

    const buyerOrgId = link.buyer_org_id
    const buyerNameText = link.buyer.display_name
    const supplierNameText = link.supplier.display_name

    console.log('✅ Buyer-Supplier link:', { buyerOrgId, buyerNameText, supplierNameText })

    /* =========================
       REUSE DIRECTORY
    ========================= */

    if (!poData.po_file_url) {
      throw new Error('PO file URL not found in database')
    }

    const { path: cleanPoPath } = parseFileRef(poData.po_file_url)
    const parts = cleanPoPath.split('/')
    const directoryPath = parts.slice(0, -1).join('/')

    console.log('📁 Original PO file URL:', poData.po_file_url)
    console.log('📁 Extracted directory path:', directoryPath)

    if (!directoryPath) {
      throw new Error('Could not extract directory path from PO file URL')
    }

    /* =========================
       UPLOAD PI FILE
    ========================= */
    poBucket = parseFileRef(poData.po_file_url).bucket;

    const safeName = sanitizeFileName(file.originalname)
    filePath = `${directoryPath}/pi_${Date.now()}_${safeName}`

    const { error: uploadError } = await supabase.storage
      .from(poBucket)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      })

    if (uploadError) {
      console.error('❌ File upload error:', uploadError)
      throw uploadError
    }

    console.log('✅ PI file uploaded to:', filePath)


    /* =========================
      UPLOAD PRODUCT DETAILS FILE (OPTIONAL)
    ========================= */
    let productDetailsFilePath = null
    let productDetailsFileRef = null

    if (productDetailsFile) {
      const safeDetailName = sanitizeFileName(productDetailsFile.originalname)
      productDetailsFilePath = `${directoryPath}/product_details_${Date.now()}_${safeDetailName}`

      const { error: detailUploadError } = await supabase.storage
        .from(poBucket)
        .upload(productDetailsFilePath, productDetailsFile.buffer, {
          contentType: productDetailsFile.mimetype,
          upsert: false,
        })

      if (detailUploadError) {
        console.error('❌ Product details file upload error:', detailUploadError)
        throw detailUploadError
      }

      productDetailsFileRef = buildFileRef(productDetailsFilePath, poBucket)
      console.log('✅ Product details file uploaded to:', productDetailsFilePath)
    }

    /* =========================
       FORMAT DATE
    ========================= */

    const d = new Date(piReceivedDate)
    const f= new Date(exFactoryDate)
    const months = [
      'January','February','March','April','May','June',
      'July','August','September','October','November','December'
    ]
    const dbFormattedDate =
      `${months[d.getMonth()]}-${String(d.getDate()).padStart(2,'0')}-${d.getFullYear()}`
      const dbFormattedExFactoryDate =
      `${months[f.getMonth()]}-${String(f.getDate()).padStart(2,'0')}-${f.getFullYear()}`

    console.log('📅 Formatted date:', dbFormattedDate)
    console.log('📅 Formatted ex factory date:', dbFormattedExFactoryDate)

    /* =========================
       UPDATE PO
    ========================= */

   const { error: updateError } = await supabase
  .from('purchase_orders')
  .update({
    pi_received_date: dbFormattedDate,
    ex_factory_date:  dbFormattedExFactoryDate,
    pi_file_url:      buildFileRef(filePath, poBucket),
    pi_confirmed:     true,
    pi_uploaded_at:   new Date().toISOString(),
    status:           'open',
    ...(productDetailsFileRef ? { product_details_file_url: productDetailsFileRef } : {}),
    ...(poNumber && poNumber !== 'N/A' ? { po_number: poNumber } : {}),
    // ↓ optional overrides
   ...(quantity  ? { quantity_ordered: parseInt(quantity, 10) } : {}),
   ...(value     ? { amount: parseFloat(value), amount_usd: parseFloat(amountUsd), currency } : {}),
  })
  .eq('id', databasePoId)


    if (updateError) {
      console.error('❌ PO update error:', updateError)
      throw updateError
    }

    console.log('✅ PO updated successfully')

    const finalPoNumber = poNumber && poNumber !== 'N/A'
      ? poNumber
      : poData.po_number

    /* =========================
       SUCCESS
    ========================= */
    if (isExcel(filePath)) {
      convertAndStorePdf(supabase, buildFileRef, filePath, databasePoId, poBucket, 'pi').catch(err =>
        console.error('❌ PI PDF conversion failed:', err)
      );
    }
    return res.json({
      success: true,
      poId: databasePoId,
      poNumber: finalPoNumber,
      message: 'PI uploaded successfully',
    })
    } catch (err) {
    console.error('❌ PI Upload Error:', err)
    console.error('❌ Error stack:', err.stack)

    if (filePath) {
      console.log('🗑️ Cleaning up uploaded file:', filePath)
      await supabase.storage.from(poBucket).remove([filePath])
    }

    if (productDetailsFilePath) {
      console.log('🗑️ Cleaning up uploaded product details file :', productDetailsFilePath)
      await supabase.storage.from(poBucket).remove([productDetailsFilePath])
    }

    return res.status(500).json({
      error: err.message || 'PI upload failed',
    })
  }
})

router.put('/update/:poId', upload.single('poFile'), async (req, res) => {
  let newFilePath = null;
  let oldFilePath = null; 
  let newFileBucket = ACTIVE_BUCKET;

  try {
    const { poId } = req.params;
    const { updatedBy } = req.query;

    const {
      buyerSupplierLinkId,
      poReceivedDate,
      quantity,
      amountUsd,
      currency,
      value,
      poNumber
    } = req.body;

    const trimmedPoNumber      = poNumber?.trim()
    const trimmedQuantity      = quantity?.toString().trim()
    const trimmedValue         = value?.toString().trim()
    const trimmedAmountUsd     = amountUsd?.toString().trim()

    const file = req.file;

    if (!poId || !updatedBy) {
      return res.status(400).json({
        error: 'poId and updatedBy required'
      });
    }

    /* =========================
       FETCH EXISTING PO
    ========================= */

    const { data: existingPO, error: fetchError } = await supabase
      .from('purchase_orders')
      .select(`
        id,
        pi_confirmed,
        po_received_date,
        quantity_ordered,
        amount,
        po_number,
        buyer_supplier_link_id,
        po_file_url,
        pi_file_url,
        amount_usd,
        currency,
        current_version,
        buyer_supplier_links (
          buyer_org_id,
          supplier_org_id
        )
      `)
      .eq('id', poId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existingPO) {
      return res.status(404).json({ error: 'Purchase Order not found' });
    }

    /* =========================
       PREVENT UPDATE AFTER PI
    ========================= */

    if (existingPO.pi_confirmed) {
      return res.status(400).json({
        error: 'PO cannot be modified after PI confirmation'
      });
    }

    /* =========================
       RESOLVE BUYER ORG ID
    ========================= */

    const buyerOrgId = existingPO.buyer_supplier_links?.buyer_org_id;

    /* =========================
       BUILD UPDATE DATA
    ========================= */

    const updateData = {};
    updateData.updated_by_member_id = updatedBy;

    if (buyerSupplierLinkId && buyerSupplierLinkId !== existingPO.buyer_supplier_link_id) {
      updateData.buyer_supplier_link_id = buyerSupplierLinkId;
    }

    if (trimmedQuantity !== undefined && trimmedQuantity !== '') {
      const quantityNum = Number(trimmedQuantity);
      if (Number.isNaN(quantityNum)) {
        return res.status(400).json({ error: 'Invalid quantity' });
      }
      updateData.quantity_ordered = quantityNum;
    }

    if (trimmedValue !== undefined && trimmedValue !== '') {
  const valueNum = Number(trimmedValue)
  if (Number.isNaN(valueNum)) return res.status(400).json({ error: 'Invalid amount' })
  updateData.amount = valueNum

    if (trimmedAmountUsd) {
        const amountUsdNum = Number(trimmedAmountUsd)
        if (!Number.isNaN(amountUsdNum)) updateData.amount_usd = amountUsdNum
    }
    if (currency) updateData.currency = currency
    }


    if (trimmedPoNumber  && trimmedPoNumber  !== 'N/A' && trimmedPoNumber  !== null) {
      updateData.po_number = trimmedPoNumber ;
    }

    console.log('Updated poNumber is:', updateData.po_number);

    /* =========================
       DATE HELPERS
    ========================= */

    const months = [
      'January','February','March','April','May','June',
      'July','August','September','October','November','December'
    ];

    if (poReceivedDate) {
      const dateObj = new Date(poReceivedDate);
      updateData.po_received_date =
        `${months[dateObj.getMonth()]}-${String(dateObj.getDate()).padStart(2,'0')}-${dateObj.getFullYear()}`;
    }

    /* =========================
       DETERMINE IF FILE NEEDS TO BE MOVED
    ========================= */

    const dateChanged = updateData.po_received_date &&
                       updateData.po_received_date !== existingPO.po_received_date;
    const poNumberChanged = updateData.po_number &&
                           updateData.po_number !== existingPO.po_number;
    const pathChangingFieldsUpdated = dateChanged || poNumberChanged;

    console.log('🔍 File movement check:', {
      dateChanged,
      poNumberChanged,
      needsMove: pathChangingFieldsUpdated && !file
    });

    /* =========================
       HANDLE FILE OPERATIONS
       (must run BEFORE the "nothing to update" check
        so a file-only update is not skipped)
    ========================= */

    if (file) {
      // ========================================
      // SCENARIO 1: NEW FILE UPLOADED
      // ========================================
      const { bucket: oldPoBucket } = parseFileRef(existingPO.po_file_url);
      newFileBucket = oldPoBucket; 
      console.log('📄 New file uploaded - replacing existing PO file');

      const { data: buyerOrg } = await supabase
        .from('organizations')
        .select('display_name')
        .eq('id', buyerOrgId)
        .maybeSingle();

      const buyerDisplayName = buyerOrg?.display_name || 'UnknownBuyer';
      const safeBuyer = buyerDisplayName
        .replace(/[^a-zA-Z0-9 _-]/g, '')
        .trim();

      const dateObj = new Date(poReceivedDate || existingPO.po_received_date);
      const monthFolder = months[dateObj.getMonth()];
      const dayFolder = String(dateObj.getDate()).padStart(2, '0');
      const safeFileName = sanitizeFileName(file.originalname);
      const poNumberForPath = sanitizePathSegment(trimmedPoNumber || existingPO.po_number);

      newFilePath =
        `${safeBuyer}/${monthFolder}/${dayFolder}/${poNumberForPath}/` +
        `po_${Date.now()}_${safeFileName}`;

      const { error: uploadError } = await supabase.storage
        .from(oldPoBucket)
        .upload(newFilePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (uploadError) throw uploadError;

      console.log('✅ New file uploaded:', newFilePath);

      updateData.po_file_url = buildFileRef(newFilePath, oldPoBucket);
      oldFilePath = existingPO.po_file_url; // retained for version snapshot, NOT deleted

    } else if (pathChangingFieldsUpdated && existingPO.po_file_url) {
      // ========================================
      // SCENARIO 2: NO NEW FILE, BUT DATE OR PO NUMBER CHANGED
      // ========================================
      console.log('📦 Moving existing file due to date/PO number change');

      const { data: buyerOrg } = await supabase
        .from('organizations')
        .select('display_name')
        .eq('id', buyerOrgId)
        .maybeSingle();

      const buyerDisplayName = buyerOrg?.display_name || 'UnknownBuyer';
      const safeBuyer = buyerDisplayName.replace(/[^a-zA-Z0-9 _-]/g, '').trim();

      const dateObj = new Date(poReceivedDate || existingPO.po_received_date);
      const monthFolder = months[dateObj.getMonth()];
      const dayFolder = String(dateObj.getDate()).padStart(2, '0');

      const extractedOldPath = extractPathFromUrl(existingPO.po_file_url);
      const { bucket: oldPoBucket } = parseFileRef(existingPO.po_file_url);
      const fileName = extractedOldPath.split('/').pop();
      const poNumberForPath = sanitizePathSegment(updateData.po_number || existingPO.po_number);

      newFilePath = `${safeBuyer}/${monthFolder}/${dayFolder}/${poNumberForPath}/${fileName}`;

      console.log('📥 Old file path:', extractedOldPath);
      console.log('📤 New file path:', newFilePath);

      if (extractedOldPath !== newFilePath) {
        const { data: oldFile, error: downloadError } = await supabase.storage
        .from(oldPoBucket)              // ← reads from wherever it actually is
        .download(extractedOldPath);

        if (downloadError) {
          console.error('❌ Download error:', downloadError);
          throw downloadError;
        }

        const { error: uploadError } = await supabase.storage
          .from(oldPoBucket)
          .upload(newFilePath, oldFile, { upsert: false });

        if (uploadError) {
          console.error('❌ Upload error:', uploadError);
          throw uploadError;
        }

        console.log('✅ File moved successfully');

        updateData.po_file_url = buildFileRef(newFilePath, oldPoBucket);
        oldFilePath = extractedOldPath; // retained for version snapshot, NOT deleted
      } else {
        console.log('ℹ️ Path unchanged, no file movement needed');
      }
    }
    /* =========================
       NOTHING TO UPDATE
       (checked AFTER file handling so file-only updates are not skipped)
    ========================= */

    if (Object.keys(updateData).length === 1 && updateData.updated_by_name) {
      return res.json({
        success: true,
        message: 'Nothing to update'
      });
    }

    /* =========================
       SNAPSHOT CURRENT VERSION
    ========================= */

    const { nextVersion } = await snapshotPOVersion(
      supabase,
      existingPO,
      updateData,
      updatedBy
    );

    // Bump version counter on the PO
    updateData.current_version = nextVersion + 1;

    /* =========================
       UPDATE PO
    ========================= */

    const { data: updatedPO, error: updateError } = await supabase
      .from('purchase_orders')
      .update(updateData)
      .eq('id', poId)
      .select()
      .maybeSingle();

    if (updateError) throw updateError;

    console.log('✅ PO updated:', poId);

    // ℹ️ Old files are intentionally NOT deleted — they are preserved
    // in the version snapshot (oldFilePath / oldPiFilePath) for audit/rollback.
    /* =========================
       UPDATE EXISTING ALERTS → PO_UPDATE
    ========================= */

    console.log('🔄 Promoting alerts to PO_UPDATE...');

    const { data: existingAlerts } = await supabase
      .from('alerts')
      .select('id, po_snapshot')
      .eq('po_id', poId);

    // Resolve buyer/supplier display names if the link changed
    let buyerNameText = null;
    let supplierNameText = null;

    if (buyerSupplierLinkId && buyerSupplierLinkId !== existingPO.buyer_supplier_link_id) {
      const { data: orgNames } = await supabase
        .from('buyer_supplier_links')
        .select(`
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
        `)
        .eq('id', buyerSupplierLinkId)
        .maybeSingle();

      buyerNameText = orgNames?.buyer?.display_name;
      supplierNameText = orgNames?.supplier?.display_name;
    }

    // Build change list once
    const updateChanges = [];
    if (updateData.quantity_ordered !== undefined && updateData.quantity_ordered !== existingPO.quantity_ordered)
      updateChanges.push(`Quantity: ${existingPO.quantity_ordered} → ${updateData.quantity_ordered}`);
    if (updateData.amount !== undefined && updateData.amount !== existingPO.amount)
    updateChanges.push(`Amount: ${existingPO.amount} ${existingPO.currency || 'USD'} → ${updateData.amount} ${updateData.currency || existingPO.currency || 'USD'}`)
    if (updateData.po_number && updateData.po_number !== existingPO.po_number)
      updateChanges.push(`PO#: ${existingPO.po_number} → ${updateData.po_number}`);
    if (updateData.po_received_date && updateData.po_received_date !== existingPO.po_received_date)
      updateChanges.push(`Date: ${existingPO.po_received_date} → ${updateData.po_received_date}`);
    if (file) updateChanges.push('PO file replaced');
    if (buyerNameText) updateChanges.push(`Buyer → ${buyerNameText}`);
    if (supplierNameText) updateChanges.push(`Supplier → ${supplierNameText}`);

    const finalPoNum = updateData.po_number || existingPO.po_number;
    const updateMessage = `PO#${finalPoNum} updated by ${updatedBy}${updateChanges.length ? ': ' + updateChanges.join(', ') : ''}`;

    if (existingAlerts && existingAlerts.length > 0) {
      console.log('📋 Found alerts to promote:', existingAlerts.length);

      const updatePromises = existingAlerts.map(alert => {
        const updatedSnapshot = {
          ...alert.po_snapshot,
          ...(updateData.quantity_ordered !== undefined && { quantity_ordered: updateData.quantity_ordered }),
          ...(updateData.amount     !== undefined && { amount:     updateData.amount }),
          ...(updateData.amount_usd !== undefined && { amount_usd: updateData.amount_usd }),
          ...(updateData.currency                 && { currency:   updateData.currency }),
          ...(updateData.po_number !== undefined && { po_number: updateData.po_number }),
          ...(updateData.po_received_date !== undefined && { po_received_date: updateData.po_received_date }),
          ...(updateData.po_file_url !== undefined && { po_file_url: updateData.po_file_url }),
          ...(updateData.pi_file_url !== undefined && { pi_file_url: updateData.pi_file_url }),
          ...(buyerNameText && { buyer_name: buyerNameText }),
          ...(supplierNameText && { supplier_name: supplierNameText }),
          last_updated_at: new Date().toISOString(),
          last_updated_by: updatedBy,
          version: updateData.current_version,
          ...(updateChanges.length > 0 && { changes: updateChanges.join(', ') }),
        };

        return supabase
          .from('alerts')
          .update({ alert_type: 'PO_UPDATE', message: updateMessage, po_snapshot: updatedSnapshot, is_read: false, updated_at: new Date().toISOString() })
          .eq('id', alert.id);
      });

      const results = await Promise.all(updatePromises);
      const errors = results.filter(r => r.error);
      if (errors.length > 0) console.error('❌ Alert update errors:', errors);
      else console.log('✅ Alerts promoted to PO_UPDATE:', existingAlerts.length);
    }

    /* =========================
       SUCCESS
    ========================= */

    if (newFilePath && isExcel(newFilePath)) {
      convertAndStorePdf(supabase, buildFileRef, newFilePath, poId, newFileBucket, 'po').catch(err =>
        console.error('❌ PO PDF conversion failed:', err)
      );
    }

    return res.json({
      success: true,
      message: 'PO updated successfully',
      po: updatedPO,
      version: updateData.current_version,
      filesMoved: {
        poFile: !!oldFilePath,
      }
    });

 } catch (err) {
  console.error('❌ Update PO Error:', err);

  if (newFilePath) {
    console.log('🗑️ Rolling back uploaded file:', newFilePath);
    await supabase.storage
      .from(newFileBucket)
      .remove([newFilePath])
      .catch(e => console.error('❌ Rollback failed:', e));
  }
  return res.status(500).json({ error: err.message || 'Failed to update PO' });
}
});



router.put('/revise-confirmed-po/:poId', upload.fields([{ name: 'piFile', maxCount: 1 },{ name: 'poFile', maxCount: 1 },{ name: 'productDetailsFile', maxCount: 1 }]), async (req, res) => {
  let newPiFilePath = null;
  let newPoFilePath = null;
  let oldPoFilePath = null;
  let newProductDetailsFilePath = null;        // ← add
  let newPiFileBucket = ACTIVE_BUCKET;
  let newPoFileBucket = ACTIVE_BUCKET;
  let newProductDetailsFileBucket = ACTIVE_BUCKET; 

  try {
    const { poId } = req.params;
    const { updatedBy } = req.query;

    const {
  buyerName, supplierName, poNumber, poReceivedDate,
  quantity, value, currency, amountUsd,
  piReceivedDate, exFactoryDate,
} = req.body;

const trimmedPoNumber  = poNumber?.trim()
const trimmedQuantity  = quantity?.toString().trim()
const trimmedValue     = value?.toString().trim()
const trimmedAmountUsd = amountUsd?.toString().trim()



    const piFile = req.files?.piFile?.[0];
    const poFile = req.files?.poFile?.[0];
    const productDetailsFile = req.files?.productDetailsFile?.[0];

    if (!poId || !updatedBy) {
      return res.status(400).json({ error: 'poId and updatedBy are required' });
    }

    const { data: updatedByMember } = await supabase
  .from('organization_members')
  .select('full_name')
  .eq('id', updatedBy)
  .maybeSingle();

const updatedByName = updatedByMember?.full_name || updatedBy;

    /* =========================
       FETCH EXISTING PO
    ========================= */

    const { data: existingPO, error: fetchError } = await supabase
      .from('purchase_orders')
      .select(`
        id,
        pi_confirmed,
        po_received_date,
        is_test,
        pi_received_date,
        ex_factory_date,
        quantity_ordered,
        amount,
        po_number,
        buyer_supplier_link_id,
        po_file_url,
        pi_file_url,
        amount_usd,
        currency,
        current_version,
        buyer_supplier_links (
          buyer_org_id,
          supplier_org_id
        )
      `)
      .eq('id', poId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existingPO) {
      return res.status(404).json({ error: 'Purchase Order not found' });
    }

    /* =========================
       MUST BE PI CONFIRMED TO USE THIS ROUTE
    ========================= */

    if (!existingPO.pi_confirmed) {
      return res.status(400).json({
        error: 'Use /update-buyer-po to edit a PO that has not been PI confirmed yet'
      });
    }

    /* =========================
       RESOLVE BUYER ORG ID
    ========================= */

    const buyerOrgId = buyerName ||
                       existingPO.buyer_supplier_links?.buyer_org_id;

    /* =========================
       HANDLE BUYER/SUPPLIER CHANGE
    ========================= */

    let newLinkId = existingPO.buyer_supplier_link_id;

    if (buyerName && supplierName) {
      const { data: link, error: linkError } = await supabase
        .from('buyer_supplier_links')
        .select('id')
        .eq('buyer_org_id', buyerOrgId)
        .eq('supplier_org_id', supplierName)
        .eq('relationship_status', 'active')
        .maybeSingle();

      if (linkError) throw linkError;

      if (!link) {
        return res.status(400).json({ error: 'Invalid buyer–supplier relationship' });
      }

      newLinkId = link.id;
      console.log('✅ New buyer-supplier link resolved:', newLinkId);
    }

    /* =========================
       DATE HELPER
    ========================= */

    const months = [
      'January','February','March','April','May','June',
      'July','August','September','October','November','December'
    ];

    const formatDate = (dateStr) => {
      const d = new Date(dateStr);
      return `${months[d.getMonth()]}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
    };

    /* =========================
       BUILD UPDATE DATA
    ========================= */

    const updateData = {};
    updateData.updated_by_member_id = updatedBy;

    // Buyer/supplier link
    if (newLinkId && newLinkId !== existingPO.buyer_supplier_link_id) {
      updateData.buyer_supplier_link_id = newLinkId;
    }

    // PO fields
    if (trimmedQuantity !== undefined && trimmedQuantity !== '') {
      const quantityNum = Number(trimmedQuantity);
      if (Number.isNaN(quantityNum)) {
        return res.status(400).json({ error: 'Invalid quantity' });
      }
      updateData.quantity_ordered = quantityNum;
    }

    if (trimmedValue !== undefined && trimmedValue !== '') {
  const valueNum = Number(trimmedValue)
  if (Number.isNaN(valueNum)) return res.status(400).json({ error: 'Invalid amount' })
  updateData.amount = valueNum

  if (trimmedAmountUsd) {
    const amountUsdNum = Number(trimmedAmountUsd)
    if (!Number.isNaN(amountUsdNum)) updateData.amount_usd = amountUsdNum
  }
  if (currency) updateData.currency = currency
}


    if (trimmedPoNumber && trimmedPoNumber !== 'N/A') {
  updateData.po_number = trimmedPoNumber;
}

    if (poReceivedDate) {
      updateData.po_received_date = formatDate(poReceivedDate);
    }

    // PI fields
    if (piReceivedDate) {
      updateData.pi_received_date = formatDate(piReceivedDate);
    }
    

    if (exFactoryDate) {
      updateData.ex_factory_date = formatDate(exFactoryDate);
    }

    console.log('📝 Revision updateData (pre-file):', updateData);

    /* =========================
       NOTHING TO UPDATE
    ========================= */

    if (Object.keys(updateData).length === 1 && updateData.updated_by_member_id) {
      return res.json({ success: true, message: 'Nothing to update' });
    }

    /* =========================
       DETERMINE IF PATHS NEED TO CHANGE
    ========================= */

    const dateChanged = updateData.po_received_date &&
                        updateData.po_received_date !== existingPO.po_received_date;
    const poNumberChanged = updateData.po_number &&
                            updateData.po_number !== existingPO.po_number;
    const pathChangingFieldsUpdated = dateChanged || poNumberChanged;

    console.log('🔍 Path change check:', { dateChanged, poNumberChanged });

    /* =========================
       RESOLVE BUYER DISPLAY NAME (shared across file ops)
    ========================= */

    const { data: buyerOrg } = await supabase
      .from('organizations')
      .select('display_name')
      .eq('id', buyerOrgId)
      .maybeSingle();

    const buyerDisplayName = buyerOrg?.display_name || 'UnknownBuyer';
    const safeBuyer = buyerDisplayName.replace(/[^a-zA-Z0-9 _-]/g, '').trim();

    const dateObj = new Date(poReceivedDate || existingPO.po_received_date);
    const monthFolder = months[dateObj.getMonth()];
    const dayFolder = String(dateObj.getDate()).padStart(2, '0');
    const poNumberForPath = sanitizePathSegment(updateData.po_number || existingPO.po_number);

    /* =========================
       HANDLE NEW PO FILE UPLOAD
    ========================= */

    if (poFile) {
      console.log('📄 New PO file uploaded');
      const { bucket: oldPoBucket } = parseFileRef(existingPO.po_file_url);
        newPoFileBucket = oldPoBucket;


      const safeName = sanitizeFileName(poFile.originalname);
      newPoFilePath = `${safeBuyer}/${monthFolder}/${dayFolder}/${poNumberForPath}/po_${Date.now()}_${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from(newPoFileBucket)
        .upload(newPoFilePath, poFile.buffer, {
          contentType: poFile.mimetype,
          upsert: false,
        });

      if (uploadError) throw uploadError;

      console.log('✅ New PO file uploaded:', newPoFilePath);
      updateData.po_file_url = buildFileRef(newPoFilePath, newPoFileBucket);
      oldPoFilePath = existingPO.po_file_url; // retained for version snapshot
    }

    /* =========================
       HANDLE NEW PI FILE UPLOAD
    ========================= */

    if (piFile) {
      console.log('📄 New PI file uploaded');
      const { bucket: poBucket } = parseFileRef(existingPO.po_file_url);
       newPiFileBucket = poBucket;

      const safeName = sanitizeFileName(piFile.originalname);
      newPiFilePath = `${safeBuyer}/${monthFolder}/${dayFolder}/${poNumberForPath}/pi_${Date.now()}_${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from(poBucket)
        .upload(newPiFilePath, piFile.buffer, {
          contentType: piFile.mimetype,
          upsert: false,
        });

      if (uploadError) throw uploadError;

      console.log('✅ New PI file uploaded:', newPiFilePath);
      updateData.pi_file_url = buildFileRef(newPiFilePath, poBucket);
      // old PI file retained for version snapshot
    }

    /* ── HANDLE PRODUCT DETAILS FILE (optional) ── */
    if (productDetailsFile) {
      const { bucket: pdBucket } = parseFileRef(existingPO.po_file_url);
      newProductDetailsFileBucket = pdBucket;   // ← assign hoisted var
      const safeName = sanitizeFileName(productDetailsFile.originalname);
      newProductDetailsFilePath = `${safeBuyer}/${monthFolder}/${dayFolder}/${poNumberForPath}/product_details_${Date.now()}_${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from(newProductDetailsFileBucket)
        .upload(newProductDetailsFilePath, productDetailsFile.buffer, {
          contentType: productDetailsFile.mimetype,
          upsert: false,
        });

      if (uploadError) throw uploadError;
      updateData.product_details_file_url = buildFileRef(newProductDetailsFilePath, newProductDetailsFileBucket);
    }



    /* =========================
       MOVE EXISTING PO FILE IF PATH CHANGED (no new PO file uploaded)
    ========================= */

    if (pathChangingFieldsUpdated && existingPO.po_file_url && !poFile) {
      console.log('📦 Moving existing PO file due to path change');

      const extractedOldPath = extractPathFromUrl(existingPO.po_file_url);
      const { bucket: oldPoBucket } = parseFileRef(existingPO.po_file_url);
      const fileName = extractedOldPath.split('/').pop();
      const movedPoPath = `${safeBuyer}/${monthFolder}/${dayFolder}/${poNumberForPath}/${fileName}`;

      console.log('📥 Old PO path:', extractedOldPath);
      console.log('📤 New PO path:', movedPoPath);

      if (extractedOldPath !== movedPoPath) {
        const { data: oldFile, error: downloadError } = await supabase.storage
        .from(oldPoBucket)              // ← reads from wherever it actually is
        .download(extractedOldPath);

        if (downloadError) throw downloadError;

        const { error: uploadError } = await supabase.storage
          .from(oldPoBucket)
          .upload(movedPoPath, oldFile, { upsert: false });

        if (uploadError) throw uploadError;

        console.log('✅ PO file moved');
        updateData.po_file_url = buildFileRef(movedPoPath, oldPoBucket);
        oldPoFilePath = extractedOldPath; // retained for version snapshot
      } else {
        console.log('ℹ️ PO path unchanged, no move needed');
      }
    }

    /* =========================
       MOVE EXISTING PI FILE IF PATH CHANGED (no new PI file uploaded)
    ========================= */

    if (pathChangingFieldsUpdated && existingPO.pi_file_url && !piFile) {
      console.log('📦 Moving existing PI file due to path change');

      const extractedOldPiPath = extractPathFromUrl(existingPO.pi_file_url);
      const { bucket: oldPiBucket } = parseFileRef(existingPO.pi_file_url);
      const piFileName = extractedOldPiPath.split('/').pop();
      const movedPiPath = `${safeBuyer}/${monthFolder}/${dayFolder}/${poNumberForPath}/${piFileName}`;

      console.log('📥 Old PI path:', extractedOldPiPath);
      console.log('📤 New PI path:', movedPiPath);

      if (extractedOldPiPath !== movedPiPath) {
        const { data: oldPiFile, error: downloadError } = await supabase.storage
          .from(oldPiBucket)              // ← reads from wherever it actually is
          .download(extractedOldPiPath);

        if (downloadError) throw downloadError;

        const { error: uploadError } = await supabase.storage
          .from(oldPiBucket)
          .upload(movedPiPath, oldPiFile, { upsert: false });

        if (uploadError) throw uploadError;

        console.log('✅ Existing PI file moved');
        updateData.pi_file_url = buildFileRef(movedPiPath, oldPiBucket);
        // old PI file retained for version snapshot
      } else {
        console.log('ℹ️ PI path unchanged, no move needed');
      }
    }

    /* =========================
       SNAPSHOT CURRENT VERSION
    ========================= */

    const { nextVersion } = await snapshotPOVersion(
      supabase,
      existingPO,
      updateData,
      updatedByName,
      'po_revision'
    );

    updateData.current_version = nextVersion + 1;

    /* =========================
       UPDATE PO
    ========================= */

    const { data: updatedPO, error: updateError } = await supabase
      .from('purchase_orders')
      .update(updateData)
      .eq('id', poId)
      .select()
      .maybeSingle();

    if (updateError) throw updateError;

    console.log('✅ PO revision saved:', poId, '— version:', updateData.current_version);

    /* =========================
       UPDATE EXISTING ALERTS → PO_REVISION
    ========================= */
    if (!existingPO.is_test) {
    const { data: existingAlerts } = await supabase
      .from('alerts')
      .select('id, po_snapshot')
      .eq('po_id', poId);

    // Resolve buyer/supplier display names if the link changed
    let buyerNameText = null;
    let supplierNameText = null;

    if (newLinkId && newLinkId !== existingPO.buyer_supplier_link_id) {
      const { data: orgNames } = await supabase
        .from('buyer_supplier_links')
        .select(`
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
        `)
        .eq('id', newLinkId)
        .maybeSingle();

      buyerNameText = orgNames?.buyer?.display_name;
      supplierNameText = orgNames?.supplier?.display_name;
    }

    // Build change list once — shared across all alert updates and the email
    const revisionChanges = [];
    if (updateData.quantity_ordered !== undefined && updateData.quantity_ordered !== existingPO.quantity_ordered)
      revisionChanges.push(`Quantity: ${existingPO.quantity_ordered} → ${updateData.quantity_ordered}`);
    if (updateData.amount !== undefined && updateData.amount !== existingPO.amount)
  revisionChanges.push(`Amount: ${existingPO.amount} ${existingPO.currency || 'USD'} → ${updateData.amount} ${updateData.currency || existingPO.currency || 'USD'}`)
    if (updateData.po_number && updateData.po_number !== existingPO.po_number)
      revisionChanges.push(`PO#: ${existingPO.po_number} → ${updateData.po_number}`);
    if (updateData.po_received_date && updateData.po_received_date !== existingPO.po_received_date)
      revisionChanges.push(`PO Date: ${existingPO.po_received_date} → ${updateData.po_received_date}`);
    if (updateData.pi_received_date && updateData.pi_received_date !== existingPO.pi_received_date)
      revisionChanges.push(`PI Date: ${existingPO.pi_received_date} → ${updateData.pi_received_date}`);
    if (updateData.ex_factory_date && updateData.ex_factory_date !== existingPO.ex_factory_date)
      revisionChanges.push(`Ex Factory: ${existingPO.ex_factory_date} → ${updateData.ex_factory_date}`);
    if (poFile) revisionChanges.push('PO file replaced');
    if (piFile) revisionChanges.push('PI file replaced');
    if (buyerNameText) revisionChanges.push(`Buyer → ${buyerNameText}`);
    if (supplierNameText) revisionChanges.push(`Supplier → ${supplierNameText}`);

    const finalPoNum = updateData.po_number || existingPO.po_number;
    const finalBuyerName = buyerNameText || existingAlerts?.[0]?.po_snapshot?.buyer_name || buyerDisplayName;
    const finalSupplierName = supplierNameText || existingAlerts?.[0]?.po_snapshot?.supplier_name || 'Unknown Supplier';
    const revisionMessage = `PO#${finalPoNum} revised by ${updatedByName}${revisionChanges.length ? ': ' + revisionChanges.join(', ') : ''}`;

    if (existingAlerts && existingAlerts.length > 0) {
      console.log('📋 Promoting alerts to PO_REVISION:', existingAlerts.length);

      const updatePromises = existingAlerts.map(alert => {
        const updatedSnapshot = {
          ...alert.po_snapshot,
          ...(updateData.quantity_ordered !== undefined && { quantity_ordered: updateData.quantity_ordered }),
          ...(updateData.amount_usd !== undefined && { amount_usd: updateData.amount_usd }),
          ...(updateData.currency   !== undefined && { currency:   updateData.currency }),
          ...(updateData.po_number !== undefined && { po_number: updateData.po_number }),
          ...(updateData.po_received_date !== undefined && { po_received_date: updateData.po_received_date }),
          ...(updateData.pi_received_date !== undefined && { pi_received_date: updateData.pi_received_date }),
          ...(updateData.ex_factory_date !== undefined && { ex_factory_date: updateData.ex_factory_date }),
          ...(updateData.po_file_url !== undefined && { po_file_url: updateData.po_file_url }),
          ...(updateData.pi_file_url !== undefined && { pi_file_url: updateData.pi_file_url }),
          ...(buyerNameText && { buyer_name: buyerNameText }),
          ...(supplierNameText && { supplier_name: supplierNameText }),
          last_updated_at: new Date().toISOString(),
          last_updated_by: updatedByName,
          revision: true,
          version: updateData.current_version,
          ...(revisionChanges.length > 0 && { changes: revisionChanges.join(', ') }),
        };

        return supabase
          .from('alerts')
          .update({ alert_type: 'PO_REVISION', message: revisionMessage, po_snapshot: updatedSnapshot, is_read: false, updated_at: new Date().toISOString() })
          .eq('id', alert.id);
      });

      const results = await Promise.all(updatePromises);
      const errors = results.filter(r => r.error);
      if (errors.length > 0) console.error('❌ Alert update errors:', errors);
      else console.log('✅ Alerts promoted to PO_REVISION');
    }

    // Send revision email to admins (fire and forget)
    supabase
      .from('organization_members')
      .select('full_name, email')
      .eq('role', 'admin')
      .then(({ data: adminMembers }) => {
        if (!adminMembers?.length) return;
        sendAlertEmail(
          adminMembers.map(m => ({ email: m.email, name: m.full_name })),
          revisionMessage,
          {
            buyer_name:       finalBuyerName,
            supplier_name:    finalSupplierName,
            po_number:        finalPoNum,
            quantity_ordered: updateData.quantity_ordered ?? existingPO.quantity_ordered,
            amount:    updateData.amount_usd ?? updateData.amount ?? existingPO.amount_usd ?? existingPO.amount,
            currency:  updateData.currency || existingPO.currency || 'USD',
            date:             updateData.po_received_date || existingPO.po_received_date,
            revised_by:       updatedByName,
            changes:          revisionChanges.join(', ') || 'No field changes',
          },
          'PO_REVISION'
        ).then(r => console.log('📧 PO revision email result:', r))
         .catch(err => console.error('❌ PO revision email failed:', err));
      })
      .catch(err => console.error('❌ Admin fetch for revision email failed:', err));
    }

    /* =========================
       SUCCESS
    ========================= */

    if (newPoFilePath && isExcel(newPoFilePath)) {
      convertAndStorePdf(supabase, buildFileRef, newPoFilePath, poId, newPoFileBucket, 'po').catch(err =>
        console.error('❌ PO PDF conversion failed:', err)
      );
    }
    if (newPiFilePath && isExcel(newPiFilePath)) {
      convertAndStorePdf(supabase, buildFileRef, newPiFilePath, poId, newPiFileBucket, 'pi').catch(err =>
        console.error('❌ PI PDF conversion failed:', err)
      );
    }

    return res.json({
      success: true,
      message: 'PO revised successfully',
      po: updatedPO,
      version: updateData.current_version,
      filesUploaded: {
        poFile: !!poFile,
        piFile: !!piFile,
        productDetailsFile: !!productDetailsFile,
      },
      filesMoved: {
        poFile: !!(pathChangingFieldsUpdated && existingPO.po_file_url && !poFile),
        piFile: !!(pathChangingFieldsUpdated && existingPO.pi_file_url && !piFile),
      }
    });

  } catch (err) {
    console.error('❌ Revise PO Error:', err);

    /* =========================
       ROLLBACK NEW FILES IF NEEDED
    ========================= */

    if (newPoFilePath) {
      console.log('🗑️ Rolling back new PO file:', newPoFilePath);
      await supabase.storage
        .from(newPoFileBucket)
        .remove([newPoFilePath])
        .catch(e => console.error('❌ PO file rollback failed:', e));
    }

    if (newPiFilePath) {
      console.log('🗑️ Rolling back new PI file:', newPiFilePath);
      await supabase.storage
        .from(newPiFileBucket)
        .remove([newPiFilePath])
        .catch(e => console.error('❌ PI file rollback failed:', e));
    }

    if (newProductDetailsFilePath) {
      await supabase.storage
        .from(newProductDetailsFileBucket)
        .remove([newProductDetailsFilePath])
        .catch(e => console.error('❌ Product details rollback failed:', e));
    }



    return res.status(500).json({
      error: err.message || 'Failed to revise PO'
    });
  }
});

async function resolveMember(req, res, selectFields = 'id') {
  const { data: member, error } = await supabase
    .from('organization_members')
    .select(selectFields)
    .eq('user_id', req.user.id)
    .maybeSingle()
  if (error) { res.status(500).json({ error: error.message }); return null }
  if (!member) { res.status(401).json({ error: 'Member not found for this user' }); return null }
  return member
}

router.post('/comment/:poId', async (req, res) => {
  try {
    const { poId } = req.params
    const { comment, createdBy } = req.body

    if (!poId || !comment || !createdBy) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    /* ========================= FETCH PO ========================= */

    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .select('id, po_number, pi_confirmed')
      .eq('id', poId)
      .maybeSingle()

    if (poError) throw poError
    if (!po) return res.status(404).json({ error: 'Purchase Order not found' })

    if (po.pi_confirmed) {
      return res.status(400).json({ error: 'Cannot add delay reason to a PI confirmed order' })
    }

    /* ========================= INSERT COMMENT ========================= */

    const { data: insertedComment, error: commentError } = await supabase
      .from('po_comments')
      .insert([{
        po_id:        poId,
        comment_type: 'PI_DELAY',
        comment,
        created_by:   createdBy,
      }])
      .select()
      .maybeSingle()

    if (commentError) throw commentError
    console.log('✅ PI delay comment saved:', insertedComment.id)

    /* ========================= SUCCESS ========================= */

    return res.json({
      success:   true,
      commentId: insertedComment.id,
      message:   'PI delay reason saved successfully',
    })

  } catch (err) {
    console.error('❌ PI Delay Comment Error:', err)
    return res.status(500).json({ error: err.message || 'Failed to save comment' })
  }
})

router.post('/otif-exception/:poId', requireAuth, upload.single('proofImage'), async (req, res) => {
  let filePath = null
  const BUCKET_NAME = ACTIVE_BUCKET

  try {
    const { poId }                           = req.params
    const { comment, proposedExFactoryDate, reason } = req.body
    const file                               = req.file
    const member = await resolveMember(req, res, 'id, full_name')
    if (!member) return

    const reportedBy = member?.full_name;

    /* ========================= VALIDATE ========================= */

    if (!poId || !comment || !proposedExFactoryDate || !reason || !file) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    /* ========================= FETCH PO + BUYER ========================= */

    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .select(`
        id, po_number, po_received_date, pi_confirmed,
        buyer_supplier_links(
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey(display_name)
        )
      `)
      .eq('id', poId)
      .maybeSingle()

    if (poError) throw poError
    if (!po) return res.status(404).json({ error: 'Purchase Order not found' })

    if (!po.pi_confirmed) {
      return res.status(400).json({ error: 'OTIF exception can only be reported for PI confirmed orders' })
    }

    /* ========================= BUILD STORAGE PATH ========================= */

    // po_received_date is stored as "January-05-2025"
    const [monthFolder, dayFolder] = po.po_received_date?.split('-') ?? ['Unknown', '00']

    const safeBuyer   = (po.buyer_supplier_links?.buyer?.display_name || 'UnknownBuyer')
      .replace(/[^a-zA-Z0-9 _-]/g, '').trim()
    const safePoNumber = sanitizePathSegment(po.po_number)
    const safeFileName = sanitizeFileName(file.originalname)

    filePath = `${safeBuyer}/${monthFolder}/${dayFolder}/${safePoNumber}/otif/${Date.now()}_${safeFileName}`

    /* ========================= UPLOAD PROOF IMAGE ========================= */

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: false })

    if (uploadError) throw uploadError

    /* ========================= INSERT OTIF EXCEPTION ========================= */

    const { data: inserted, error: insertError } = await supabase
      .from('otif_exceptions')
      .insert([{
        po_id:                    poId,
        proposed_ex_factory_date: proposedExFactoryDate,
        reason,
        proof_url:                buildFileRef(filePath),
        comment,
        reported_by:              reportedBy,
      }])
      .select()
      .maybeSingle()

    if (insertError) throw insertError
    console.log('✅ OTIF exception created:', inserted.id)

    return res.json({
      success:     true,
      exceptionId: inserted.id,
      message:     'OTIF exception reported successfully',
    })

  } catch (err) {
    console.error('❌ OTIF Exception Error:', err)

    if (filePath) {
      console.log('🗑️ Cleaning up uploaded file:', filePath)
      await supabase.storage.from(BUCKET_NAME).remove([filePath])
    }

    return res.status(500).json({ error: err.message || 'Failed to report OTIF exception' })
  }
})



router.get('/comments/:poId', async (req, res) => {
  try {
    const { poId } = req.params

    if (!poId) return res.status(400).json({ error: 'poId is required' })

    const { data: comments, error } = await supabase
      .from('po_comments')
      .select('id, comment_type, comment, created_by, created_at')
      .eq('po_id', poId)
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.json({
      success:  true,
      comments: comments || [],
    })

  } catch (err) {
    console.error('❌ Fetch Comments Error:', err)
    return res.status(500).json({ error: err.message || 'Failed to fetch comments' })
  }
})



router.post('/delete/:poId', async (req, res) => {
  try {
    const { poId } = req.params;
    const { shopifyCustomerId, reason } = req.body;

    if (!poId || !shopifyCustomerId) {
      return res.status(400).json({
        error: 'poId and shopifyCustomerId are required'
      });
    }

    /* =========================
       RESOLVE MEMBER IDENTITY
    ========================= */

    const { data: member, error: memberError } = await supabase
      .from('organization_members')
      .select('id, full_name')
      .eq('shopify_customer_id', shopifyCustomerId)
      .maybeSingle();

    if (memberError) throw memberError;

    if (!member) {
      return res.status(400).json({ error: 'Could not resolve member identity.' });
    }

    const deleteMeta = {
      deleted: true,
      deletedAt: new Date().toISOString(),
      deletedById: member.id,
      deletedByName: member.full_name,
      reason: reason || null
    };

    /* =========================
       FETCH PO + LINK DATA
    ========================= */

    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .select(`
        id,
        po_number,
        po_received_date,
        quantity_ordered,
        amount,
        po_file_url,
        pi_file_url,
        buyer_supplier_links (
          buyer_org_id,
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (
            display_name
          ),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (
            display_name
          )
        )
      `)
      .eq('id', poId)
      .is('delete_meta', null)
      .maybeSingle();

    if (poError) throw poError;
    if (!po) {
      return res.status(404).json({ error: 'PO not found or already deleted.' });
    }

    const buyerName    = po.buyer_supplier_links?.buyer?.display_name    || 'Unknown Buyer';
    const supplierName = po.buyer_supplier_links?.supplier?.display_name || 'Unknown Supplier';

    /* =========================
       SOFT DELETE PO
    ========================= */

    const { error: deleteError } = await supabase
      .from('purchase_orders')
      .update({ delete_meta: deleteMeta })
      .eq('id', poId);

    if (deleteError) throw deleteError;

    console.log('🗑️ PO soft deleted:', poId, 'by', member.full_name);

    /* =========================
       UPDATE ALERT SNAPSHOTS
    ========================= */

    const { data: existingAlerts } = await supabase
      .from('alerts')
      .select('id, po_snapshot')
      .eq('po_id', poId);

    if (existingAlerts?.length > 0) {
      const updatePromises = existingAlerts.map(alert =>
        supabase
          .from('alerts')
          .update({
            po_snapshot: {
              ...(alert.po_snapshot || {}),  
              delete_meta: deleteMeta        
            }
          })
          .eq('id', alert.id)
      );

      const results = await Promise.all(updatePromises);
      const errors  = results.filter(r => r.error);

      if (errors.length > 0) {
        console.error('❌ Alert snapshot update errors:', errors);
      } else {
        console.log('✅ Updated alert snapshots:', existingAlerts.length);
      }
    }

    /* =========================
       FETCH MERCHANT MEMBERS
    ========================= */

    const { data: merchantOrg } = await supabase
      .from('organizations')
      .select('id')
      .eq('type', 'merchant')
      .maybeSingle();

    const { data: accessRows } = await supabase
      .from('member_organization_access')
      .select(`
        organization_members (
          id,
          full_name,
          email,
          organization_id
        )
      `)
      .eq('organization_id', po.buyer_supplier_links.buyer_org_id);

    const eligibleMembers = (accessRows || [])
      .map(r => r.organization_members)
      .filter(m =>
        m &&
        merchantOrg &&
        m.organization_id === merchantOrg.id
      );

    /* =========================
       SEND EMAIL
    ========================= */

    if (eligibleMembers.length > 0) {
      const message = `PO ${po.po_number} for ${buyerName} → ${supplierName} was deleted by ${member.full_name}${reason ? `: ${reason}` : ' (no reason provided)'}`;

      sendAlertEmail(
        eligibleMembers.map(m => ({
          email: m.email,
          name:  m.full_name
        })),
        message,
        {
          buyer_name:        buyerName,
          supplier_name:     supplierName,
          po_number:         po.po_number,
          quantity_ordered:  po.quantity_ordered,
          amount:            po.amount,
          date:              po.po_received_date,
          deleted_by:        member.full_name,
          reason:            reason || 'No reason provided'
        },
        'PO_DELETED'
      ).catch(err => console.error('❌ Delete email failed:', err));
    }

    /* =========================
       SUCCESS
    ========================= */

    return res.json({
      success: true,
      message: 'PO deleted successfully.'
    });

  } catch (err) {
    console.error('❌ Delete PO Error:', err);
    return res.status(500).json({
      error: err.message || 'Failed to delete PO.'
    });
  }
});

module.exports = router;