const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')
const upload = require('../upload')
const { sendAlertEmail } = require('../service/emailService');
const { parseFileRef, buildFileRef, ACTIVE_BUCKET, resolveFileUrl,getPublicUrls } = require('../helper/storage');
const { convertAndStorePdf } = require('../helper/convertAndStorePdf');

const EXCEL_EXT = /\.(xlsx|xls|xlsm|xlsb|csv)$/i
const isExcel = filename => EXCEL_EXT.test(filename)

router.post('/upload-buyer-po', upload.single('poFile'), async (req, res) => {
  let filePath = null
  const BUCKET_NAME = ACTIVE_BUCKET

  try {
    const {
      buyerName,
      supplierName,
      poReceivedDate,
      quantity,
      value,
      value_usd,
      currency,
      poId,
      onBehalfOfId,
      test
    } = req.body

    const { createdBy } = req.query
    const file = req.file

    // ── Trim all string fields & sanitize PO number (strip slashes) ──
    const trimmedOnBehalfOfId = onBehalfOfId?.trim() || null
    const trimmedBuyerName     = buyerName?.trim()
    const trimmedSupplierName  = supplierName?.trim()
    const trimmedPoReceivedDate = poReceivedDate?.trim()
    const trimmedQuantity      = quantity?.toString().trim()
    const trimmedValue         = value?.toString().trim()
    const trimmedValueUsd      = value_usd?.toString().trim()
    const trimmedCurrency      = currency?.trim()
    const trimmedCreatedBy     = createdBy?.trim()
    const trimmedPoId          = poId?.trim()                        // original, saved to DB
    const safePoId             = trimmedPoId?.replace(/\//g, '-')   // slashes replaced, used in storage path only

    if (!trimmedBuyerName || !trimmedSupplierName || !trimmedPoReceivedDate || !file || !trimmedCreatedBy || !trimmedQuantity || !trimmedValue || !trimmedValueUsd || !trimmedCurrency || !trimmedPoId) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const quantityNum = Number(trimmedQuantity)
    const valueNum    = Number(trimmedValue)
    const valueUsdNum = Number(trimmedValueUsd)

    if (Number.isNaN(quantityNum) || Number.isNaN(valueNum) || Number.isNaN(valueUsdNum)) {
      return res.status(400).json({ error: 'Invalid quantity, value, or value in USD' })
    }

    /* ========================= RESOLVE BUYER–SUPPLIER LINK ========================= */

    const { data: link, error: linkError } = await supabase
      .from('buyer_supplier_links')
      .select('id')
      .eq('buyer_org_id', trimmedBuyerName)
      .eq('supplier_org_id', trimmedSupplierName)
      .eq('relationship_status', 'active')
      .maybeSingle()

    if (linkError) throw linkError
    if (!link) return res.status(400).json({ error: 'Invalid buyer–supplier relationship' })

    const buyerSupplierLinkId = link.id

    /* ========================= DUPLICATE PO CHECK ========================= */

    const { data: existingPO, error: duplicateCheckError } = await supabase
      .from('purchase_orders')
      .select('id')
      .eq('buyer_supplier_link_id', buyerSupplierLinkId)
      .eq('po_number', trimmedPoId)
      .is('deleted_at', null)
      .is('delete_meta', null)
      .maybeSingle()

    if (duplicateCheckError) throw duplicateCheckError
    if (existingPO) {
      return res.status(409).json({
        error: `PO number "${trimmedPoId}" already exists for this buyer–supplier relationship`,
      })
    }

    /* ========================= DATE + PATH HELPERS ========================= */

    const dateObj = new Date(trimmedPoReceivedDate)
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December']

    const monthFolder    = months[dateObj.getMonth()]
    const dayFolder      = String(dateObj.getDate()).padStart(2, '0')
    const year           = dateObj.getFullYear()
    const dbFormattedDate = `${monthFolder}-${dayFolder}-${year}`

    /* ========================= RESOLVE BUYER NAME (FOR PATH) ========================= */

    const { data: buyerOrg, error: buyerOrgError } = await supabase
      .from('organizations')
      .select('display_name')
      .eq('id', trimmedBuyerName)
      .maybeSingle()

    if (buyerOrgError) console.error('❌ Buyer org fetch error:', buyerOrgError)

    const safeBuyer = (buyerOrg?.display_name || 'UnknownBuyer')
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .trim()

    /* ========================= UPLOAD FILE ========================= */

    const safeFileName = file.originalname.replace(/\s+/g, '_')
    filePath = `${safeBuyer}/${monthFolder}/${dayFolder}/${safePoId}/po_${Date.now()}_${safeFileName}`

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
        created_by:             trimmedCreatedBy,
        on_behalf_of:           trimmedOnBehalfOfId,   // ← add this (null if uploading for self)
        po_file_url:            buildFileRef(filePath),
        quantity_ordered:       quantityNum,
        amount:                 valueNum,
        amount_usd:              valueUsdNum,
        currency:               trimmedCurrency,
        po_number:              trimmedPoId,
        is_test:                test,
      }])
      .select()

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
    amount_usd: 'amount_usd',
    currency: 'currency',
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
        buyer_name: existingPO.buyer_name,
        po_number: existingPO.po_number,
        po_received_date: existingPO.po_received_date,
        quantity_ordered: existingPO.quantity_ordered,
        amount: existingPO.amount,
        amount_usd: existingPO.amount_usd,
        currency: existingPO.currency,
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


router.put('/revise-confirmed-po/:poId', upload.fields([{ name: 'piFile', maxCount: 1 },{ name: 'poFile', maxCount: 1 }]), async (req, res) => {
  let newPiFilePath = null;
  let newPoFilePath = null;
  let oldPoFilePath = null;
  let newPiFileBucket = ACTIVE_BUCKET;
  let newPoFileBucket = ACTIVE_BUCKET;

  try {
    const { poId } = req.params;
    const { updatedBy } = req.query;

    const {
      buyerName,
      supplierName,
      poNumber,
      poReceivedDate,
      quantity,
      value,
      value_usd,
      currency,
      piReceivedDate,
      exFactoryDate,
    } = req.body;

    const trimmedPoNumber       = poNumber?.trim()
    const trimmedQuantity       = quantity?.toString().trim()
    const trimmedValue          = value?.toString().trim()
    const trimmedValueUsd       = value_usd?.toString().trim()
    const trimmedCurrency       = currency?.trim()


    const piFile = req.files?.piFile?.[0];
    const poFile = req.files?.poFile?.[0];

    if (!poId || !updatedBy) {
      return res.status(400).json({ error: 'poId and updatedBy are required' });
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
        pi_received_date,
        ex_factory_date,
        quantity_ordered,
        amount,
        amount_usd, 
        currency,
        po_number,
        buyer_supplier_link_id,
        buyer_name,
        po_file_url,
        pi_file_url,
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
                       existingPO.buyer_supplier_links?.buyer_org_id ||
                       existingPO.buyer_name;

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
    updateData.updated_by_name = updatedBy;

    // Buyer/supplier link
    if (newLinkId && newLinkId !== existingPO.buyer_supplier_link_id) {
      updateData.buyer_supplier_link_id = newLinkId;
      updateData.buyer_name = null;
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
  const valueNum = Number(trimmedValue);
      if (Number.isNaN(valueNum)) {
        return res.status(400).json({ error: 'Invalid amount' });
      }
      updateData.amount = valueNum;
    }

    // ✅ Add after the existing amount block
    if (trimmedValueUsd !== undefined && trimmedValueUsd !== '') {
      const valueUsdNum = Number(trimmedValueUsd);
      if (Number.isNaN(valueUsdNum)) {
        return res.status(400).json({ error: 'Invalid USD amount' });
      }
      updateData.amount_usd = valueUsdNum;
    }

    if (trimmedCurrency) {
      updateData.currency = trimmedCurrency;
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

    if (Object.keys(updateData).length === 1 && updateData.updated_by_name) {
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
    const poNumberForPath = (updateData.po_number || existingPO.po_number).replace(/\//g, '-');

    /* =========================
       HANDLE NEW PO FILE UPLOAD
    ========================= */

    if (poFile) {
      console.log('📄 New PO file uploaded');
      const { bucket: oldPoBucket } = parseFileRef(existingPO.po_file_url);
        newPoFileBucket = oldPoBucket;


      const safeName = poFile.originalname.replace(/\s+/g, '_');
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

      const safeName = piFile.originalname.replace(/\s+/g, '_');
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
      updatedBy,
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
      revisionChanges.push(`Amount: ${existingPO.amount} → ${updateData.amount}`);
    if (updateData.currency && updateData.currency !== existingPO.currency)
      revisionChanges.push(`Currency: ${existingPO.currency} → ${updateData.currency}`);
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
    const revisionMessage = `PO#${finalPoNum} revised by ${updatedBy}${revisionChanges.length ? ': ' + revisionChanges.join(', ') : ''}`;

    if (existingAlerts && existingAlerts.length > 0) {
      console.log('📋 Promoting alerts to PO_REVISION:', existingAlerts.length);

      const updatePromises = existingAlerts.map(alert => {
        const updatedSnapshot = {
          ...alert.po_snapshot,
          ...(updateData.quantity_ordered !== undefined && { quantity_ordered: updateData.quantity_ordered }),
          ...(updateData.amount !== undefined && { amount: updateData.amount_usd || updateData.amount }),
          ...(updateData.po_number !== undefined && { po_number: updateData.po_number }),
          ...(updateData.po_received_date !== undefined && { po_received_date: updateData.po_received_date }),
          ...(updateData.pi_received_date !== undefined && { pi_received_date: updateData.pi_received_date }),
          ...(updateData.ex_factory_date !== undefined && { ex_factory_date: updateData.ex_factory_date }),
          ...(updateData.po_file_url !== undefined && { po_file_url: updateData.po_file_url }),
          ...(updateData.pi_file_url !== undefined && { pi_file_url: updateData.pi_file_url }),
          ...(buyerNameText && { buyer_name: buyerNameText }),
          ...(supplierNameText && { supplier_name: supplierNameText }),
          last_updated_at: new Date().toISOString(),
          last_updated_by: updatedBy,
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
            amount:           updateData.amount ?? existingPO.amount,
            date:             updateData.po_received_date || existingPO.po_received_date,
            revised_by:       updatedBy,
            changes:          revisionChanges.join(', ') || 'No field changes',
          },
          'PO_REVISION'
        ).then(r => console.log('📧 PO revision email result:', r))
         .catch(err => console.error('❌ PO revision email failed:', err));
      })
      .catch(err => console.error('❌ Admin fetch for revision email failed:', err));

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

    return res.status(500).json({
      error: err.message || 'Failed to revise PO'
    });
  }
});
router.post('/po-comments/:poId', async (req, res) => {
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

router.get('/po-comments/:poId', async (req, res) => {
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

router.put('/update-buyer-po/:poId', upload.single('poFile'), async (req, res) => {
  let newFilePath = null;
  let oldFilePath = null;
  let newPiFilePath = null;
  let oldPiFilePath = null;
  let newPiFileBucket = ACTIVE_BUCKET; 
  let newFileBucket = ACTIVE_BUCKET;

  try {
    const { poId } = req.params;
    const { updatedBy } = req.query;

    const { buyerName, supplierName, poReceivedDate, quantity, value, value_usd, currency, poNumber } = req.body;
    const trimmedValue    = value?.toString().trim()
    const trimmedValueUsd = value_usd?.toString().trim()
    const trimmedCurrency = currency?.trim()
    const trimmedPoNumber      = poNumber?.trim()
    const trimmedQuantity      = quantity?.toString().trim()
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
        amount_usd,
        currency,
        po_number,
        buyer_supplier_link_id,
        buyer_name,
        po_file_url,
        pi_file_url,
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

    const buyerOrgId = buyerName ||
                       existingPO.buyer_supplier_links?.buyer_org_id ||
                       existingPO.buyer_name;

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
        return res.status(400).json({
          error: 'Invalid buyer–supplier relationship',
        });
      }

      newLinkId = link.id;
      console.log('✅ New buyer-supplier link resolved:', newLinkId);
    }

    /* =========================
       BUILD UPDATE DATA
    ========================= */

    const updateData = {};
    updateData.updated_by_name = updatedBy;

    if (newLinkId && newLinkId !== existingPO.buyer_supplier_link_id) {
      updateData.buyer_supplier_link_id = newLinkId;
      updateData.buyer_name = null;
    }

    if (trimmedQuantity !== undefined && trimmedQuantity !== '') {
      const quantityNum = Number(trimmedQuantity);
      if (Number.isNaN(quantityNum)) {
        return res.status(400).json({ error: 'Invalid quantity' });
      }
      updateData.quantity_ordered = quantityNum;
    }

    if (trimmedValue !== undefined && trimmedValue !== '') {
      const valueNum = Number(trimmedValue);
      if (Number.isNaN(valueNum)) {
        return res.status(400).json({ error: 'Invalid amount' });
      }
      updateData.amount = valueNum;
    }
    // ✅ Add after the existing amount block
    if (trimmedValueUsd !== undefined && trimmedValueUsd !== '') {
      const valueUsdNum = Number(trimmedValueUsd);
      if (Number.isNaN(valueUsdNum)) {
        return res.status(400).json({ error: 'Invalid USD amount' });
      }
      updateData.amount_usd = valueUsdNum;
    }

    if (trimmedCurrency) {
      updateData.currency = trimmedCurrency;
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
      const safeFileName = file.originalname.replace(/\s+/g, '_');
      const poNumberForPath = (trimmedPoNumber || existingPO.po_number).replace(/\//g, '-');

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
      const poNumberForPath = (updateData.po_number || existingPO.po_number).replace(/\//g, '-');

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

    // ========================================
    // SCENARIO 3: PI FILE ALSO NEEDS TO MOVE
    // ========================================

    if (pathChangingFieldsUpdated && existingPO.pi_file_url) {
      console.log('📦 Moving PI file due to date/PO number change');

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

      const extractedOldPiPath = extractPathFromUrl(existingPO.pi_file_url);
      const { bucket: oldPiBucket } = parseFileRef(existingPO.pi_file_url);
      const piFileName = extractedOldPiPath.split('/').pop();
      const poNumberForPath = (updateData.po_number || existingPO.po_number).replace(/\//g, '-');
      newPiFileBucket = oldPiBucket;

      newPiFilePath = `${safeBuyer}/${monthFolder}/${dayFolder}/${poNumberForPath}/${piFileName}`;

      console.log('📥 Old PI path:', extractedOldPiPath);
      console.log('📤 New PI path:', newPiFilePath);

      if (extractedOldPiPath !== newPiFilePath) {
        const { data: oldPiFile, error: downloadError } = await supabase.storage
        .from(oldPiBucket)              // ← reads from wherever it actually is
        .download(extractedOldPiPath);

        if (downloadError) {
          console.error('❌ PI download error:', downloadError);
          throw downloadError;
        }

        const { error: uploadError } = await supabase.storage
          .from(oldPiBucket)
          .upload(newPiFilePath, oldPiFile, { upsert: false });

        if (uploadError) {
          console.error('❌ PI upload error:', uploadError);
          throw uploadError;
        }

        console.log('✅ PI file moved successfully');

        updateData.pi_file_url = buildFileRef(newPiFilePath, oldPiBucket);
        oldPiFilePath = extractedOldPiPath; // retained for version snapshot, NOT deleted
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

    // Build change list once
    const updateChanges = [];
    if (updateData.quantity_ordered !== undefined && updateData.quantity_ordered !== existingPO.quantity_ordered)
      updateChanges.push(`Quantity: ${existingPO.quantity_ordered} → ${updateData.quantity_ordered}`);
    if (updateData.amount !== undefined && updateData.amount !== existingPO.amount)
      updateChanges.push(`Amount: ${existingPO.amount} → ${updateData.amount}`);
    if (updateData.po_number && updateData.po_number !== existingPO.po_number)
      updateChanges.push(`PO#: ${existingPO.po_number} → ${updateData.po_number}`); 
    if (updateData.currency && updateData.currency !== existingPO.currency)
      updateChanges.push(`Currency: ${existingPO.currency} → ${updateData.currency}`);
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
          ...(updateData.amount !== undefined && { amount: updateData.amount_usd || updateData.amount }),
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
        piFile: !!oldPiFilePath
      }
    });

  } catch (err) {
    console.error('❌ Update PO Error:', err);

    /* =========================
       ROLLBACK NEW FILES IF NEEDED
    ========================= */

    if (newFilePath) {
      console.log('🗑️ Rolling back uploaded PO file:', newFilePath);
      await supabase.storage
        .from(newFileBucket)
        .remove([newFilePath])
        .catch(rollbackErr => console.error('❌ Rollback failed:', rollbackErr));
    }

    if (newPiFilePath) {
      console.log('🗑️ Rolling back uploaded PI file:', newPiFilePath);
      await supabase.storage
        .from(newPiFileBucket)
        .remove([newPiFilePath])
        .catch(rollbackErr => console.error('❌ Rollback failed:', rollbackErr));
    }

    return res.status(500).json({
      error: err.message || 'Failed to update PO'
    });
  }
});


// ========================================
// HELPER FUNCTION
// ========================================

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

router.post('/upload-buyer-pi/:poId',
  upload.fields([
    { name: 'piFile', maxCount: 1 },
    { name: 'productDetailsFile', maxCount: 1 },
  ]),
  async (req, res) => {
  let filePath = null
  let poBucket = ACTIVE_BUCKET

  try {
    const databasePoId = req.params.poId
    const { poNumber, piReceivedDate, exFactoryDate } = req.body
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
        buyer_supplier_link_id
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

    const safeName = file.originalname.replace(/\s+/g, '_')
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
      const safeDetailName = productDetailsFile.originalname.replace(/\s+/g, '_')
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
        ex_factory_date: dbFormattedExFactoryDate,
        pi_file_url: buildFileRef(filePath, poBucket),
        pi_confirmed: true,
        pi_uploaded_at: new Date().toISOString(),
        status: 'open',
        // ↓ NEW
        ...(productDetailsFileRef ? { product_details_file_url: productDetailsFileRef } : {}),
        ...(poNumber && poNumber !== 'N/A' ? { po_number: poNumber } : {})
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
       CREATE COMPLETE PO SNAPSHOT (with all fields)
    ========================= */

    const completePoSnapshot = {
      po_id: databasePoId,
      po_number: finalPoNumber,
      buyer_name: buyerNameText,
      supplier_name: supplierNameText,
      po_received_date: poData.po_received_date,
      quantity_ordered: poData.quantity_ordered,
      amount: poData.amount,
      pi_confirmed: true,
      pi_received_date: dbFormattedDate,
      ex_factory_date: dbFormattedExFactoryDate,
      po_file_url: poData.po_file_url,
      pi_file_url: filePath,
    }

    console.log('📸 Complete PO snapshot created:', completePoSnapshot)
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
      console.log('🗑️ Cleaning up uploaded product details file :', filePath)
      await supabase.storage.from(poBucket).remove([productDetailsFilePath])
    }

    return res.status(500).json({
      error: err.message || 'PI upload failed',
    })
  }
})

router.get('/alerts', async (req, res) => {
  try {
    const { userId } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'userId required' })
    }

    const { data: alerts, error } = await supabase
      .from('alerts')
      .select(`
        *,
        purchase_orders (
          buyer_name,
          po_received_date,
          po_file_url,
          quantity_ordered,
          amount,
          pi_received_date,
          pi_file_url,
          po_number,
          pi_confirmed,
          created_by
        )
      `)
      .eq('recipient_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw error

    return res.json({
      success: true,
      alerts: alerts || []
    })

  } catch (err) {
    console.error('Error fetching alerts:', err)
    res.status(500).json({ error: 'Failed to fetch alerts' })
  }
})
router.get('/my-alerts', async (req, res) => {
  try {
    const { shopifyCustomerId } = req.query
    if (!shopifyCustomerId) {
      return res.status(400).json({
        error: 'shopifyCustomerId required'
      })
    }

    /* =========================
       RESOLVE MEMBER (IF EXISTS)
    ========================= */
    const { data: member } = await supabase
      .from('organization_members')
      .select('id')
      .eq('shopify_customer_id', shopifyCustomerId)
      .maybeSingle()

    const recipientIds = [shopifyCustomerId]
    if (member?.id) {
      recipientIds.push(member.id)
    }

    /* =========================
       FETCH ALERTS
    ========================= */
    const { data: alerts, error } = await supabase
      .from('alerts')
      .select(`
        id,
        message,
        is_read,
        created_at,
        po_snapshot,
        alert_type,
        purchase_orders (
          id,
          po_received_date,
          po_file_url,
          po_number,
          pi_confirmed,
          pi_received_date,
          pi_file_url,
          created_by,
          buyer_supplier_links (
            buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (
              display_name
            ),
            supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (
              display_name
            )
          )
        )
      `)
      .in('recipient_user_id', recipientIds)
      .order('updated_at', { ascending: false })
      .limit(300)

    if (error) throw error

    /* =========================
       HYBRID APPROACH: Merge snapshot + live data
    ========================= */
    const enrichedAlerts = (alerts || []).map(alert => {
      // If we have a snapshot, use it as the source of truth
      if (alert.po_snapshot) {
        if (alert.po_snapshot.delete_meta) {
          return {
            ...alert,
            po_snapshot: {
              ...alert.po_snapshot,
              deleted: alert.po_snapshot.delete_meta.deleted || false,
              deleted_at: alert.po_snapshot.delete_meta.deletedAt || null,
              deleted_by: alert.po_snapshot.delete_meta.deletedByName || null,
              deleted_by_id: alert.po_snapshot.delete_meta.deletedById || null,
              reason: alert.po_snapshot.delete_meta.reason || null,
            },
            purchase_orders: alert.purchase_orders
          }
        }

        return {
          ...alert,
          po_snapshot: alert.po_snapshot,
          purchase_orders: alert.purchase_orders
        }
      }

      // No snapshot — build synthetic one from live purchase_orders (backward compat)
      if (alert.purchase_orders) {
        const po = alert.purchase_orders

        const syntheticSnapshot = {
          po_id: po.id,
          po_number: po.po_number,
          buyer_name: po.buyer_supplier_links?.buyer?.display_name || null,
          supplier_name: po.buyer_supplier_links?.supplier?.display_name || null,
          po_received_date: po.po_received_date,
          quantity_ordered: null,  // removed from join to avoid PostgREST alias conflict
          amount: null,            // removed from join to avoid PostgREST alias conflict
          currency: 'USD',
          pi_confirmed: po.pi_confirmed || false,
          pi_received_date: po.pi_received_date,
          po_file_url: po.po_file_url,
          pi_file_url: po.pi_file_url,
          deleted: false,
          deleted_at: null,
          deleted_by: null,
          deleted_by_id: null,
          reason: null,
          last_updated_at: null,
          last_updated_by: null,
          changes: null
        }

        return {
          ...alert,
          po_snapshot: syntheticSnapshot,
          purchase_orders: alert.purchase_orders
        }
      }

      // No snapshot, no PO data
      return alert
    })

   // Collect ALL unique file refs from all alerts in one pass
const allFileRefs = new Set();
for (const alert of enrichedAlerts) {
  if (alert.po_snapshot?.po_file_url) allFileRefs.add(alert.po_snapshot.po_file_url);
  if (alert.po_snapshot?.pi_file_url) allFileRefs.add(alert.po_snapshot.pi_file_url);
  if (alert.purchase_orders?.po_file_url) allFileRefs.add(alert.purchase_orders.po_file_url);
  if (alert.purchase_orders?.pi_file_url) allFileRefs.add(alert.purchase_orders.pi_file_url);
}

// Single batch resolution — N unique paths instead of 300×2 calls
const urlMap = getPublicUrls(supabase, [...allFileRefs]);

// Map signed URLs back — pure O(1) lookup, no async work here
const resolvedAlerts = enrichedAlerts.map(alert => {
  const result = { ...alert };

  if (result.po_snapshot) {
    result.po_snapshot = {
      ...result.po_snapshot,
      po_file_url: urlMap.get(result.po_snapshot.po_file_url) ?? null,
      pi_file_url: urlMap.get(result.po_snapshot.pi_file_url) ?? null,
    };
  }

  if (result.purchase_orders) {
    result.purchase_orders = {
      ...result.purchase_orders,
      po_file_url: urlMap.get(result.purchase_orders.po_file_url) ?? null,
      pi_file_url: urlMap.get(result.purchase_orders.pi_file_url) ?? null,
    };
  }

  return result;
});

    return res.json({
      success: true,
      alerts: resolvedAlerts
    })

  } catch (err) {
    console.error('Error fetching alerts:', err)
    res.status(500).json({
      error: 'Failed to fetch alerts'
    })
  }
})

router.get('/my-pos', async (req, res) => {
  try {
    const { createdBy } = req.query;

    console.log('Fetching POs for:', createdBy);

    if (!createdBy) {
      return res.status(400).json({
        error: 'Missing createdBy parameter'
      });
    }

    // Fetch POs created by this customer
    const { data: pos, error } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('created_by', createdBy)
      .order('created_at', { ascending: false });

    if (error) throw error;

    console.log(`✅ Found ${pos.length} POs for ${createdBy}`);

    const resolvedPOs = await Promise.all(
      pos.map(async (po) => ({
        ...po,
        po_file_url: await resolveFileUrl(supabase, po.po_file_url),
        pi_file_url: await resolveFileUrl(supabase, po.pi_file_url),
      }))
    );

    return res.json({
      success: true,
      pos: resolvedPOs,
      count: resolvedPOs.length
    });

  } catch (err) {
    console.error('Fetch POs Error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch POs' });
  }
});

// router.get('/my-buyer-pos', async (req, res) => {
//   try {
//     const {
//       shopifyCustomerId,
//       page = 1,
//       limit = 20,
//       poNumber,
//       piStatus,
//       dateFrom,
//       dateTo,
//       supplierName,
//     } = req.query

//     if (!shopifyCustomerId) {
//       return res.status(400).json({ error: 'shopifyCustomerId required' })
//     }

//     const pageNum  = Math.max(1, parseInt(page))
//     const pageSize = Math.min(50, Math.max(1, parseInt(limit)))
//     const from     = (pageNum - 1) * pageSize
//     const to       = from + pageSize - 1

//     /* =========================
//        RESOLVE MEMBER + ACCESS
//     ========================= */
//     const { data: member, error: memberError } = await supabase
//       .from('organization_members')
//       .select(`
//         id,
//         member_organization_access ( organization_id )
//       `)
//       .eq('shopify_customer_id', shopifyCustomerId)
//       .maybeSingle()

//     if (memberError) throw memberError
//     if (!member || !member.member_organization_access?.length) {
//       return res.json({ success: true, pos: [], count: 0, pagination: { page: pageNum, limit: pageSize, total: 0, hasMore: false } })
//     }

//     const buyerOrgIds = member.member_organization_access.map(a => a.organization_id)

//     /* =========================
//        RESOLVE SUPPLIER FILTER (if provided)
//     ========================= */
//     let supplierLinkIds = null
//     // In /my-buyer-pos, replace the supplierName block with:
// if (supplierName?.trim()) {
//   const names = supplierName.split(',').map(n => n.trim()).filter(Boolean)

//   const { data: matchingOrgs } = await supabase
//     .from('organizations')
//     .select('id')
//     .in('display_name', names)  // exact match since names come from our own dropdown
//     .eq('type', 'supplier')

//   if (!matchingOrgs?.length) {
//     return res.json({
//       success: true, pos: [],
//       pagination: { page: pageNum, limit: pageSize, total: 0, hasMore: false }
//     })
//   }

//   const orgIds = matchingOrgs.map(o => o.id)
//   const { data: linksByOrg } = await supabase
//     .from('buyer_supplier_links')
//     .select('id')
//     .in('buyer_org_id', buyerOrgIds)
//     .in('supplier_org_id', orgIds)
//     .eq('relationship_status', 'active')

//   supplierLinkIds = (linksByOrg || []).map(l => l.id)

//   if (!supplierLinkIds.length) {
//     return res.json({
//       success: true, pos: [],
//       pagination: { page: pageNum, limit: pageSize, total: 0, hasMore: false }
//     })
//   }
// }

//     /* =========================
//        BUILD QUERY
//     ========================= */
//     let query = supabase
//       .from('purchase_orders')
//       .select(`
//       *,
//       buyer_supplier_links!inner (
//         buyer_org_id,
//         buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
//         supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
//       ),
//       on_behalf_of_member:organization_members!purchase_orders_on_behalf_of_fkey (full_name)
//     `, { count: 'exact' })
//       .is('deleted_at', null)
//       .is('delete_meta', null)
//       .neq('status', 'closed')
//       .gte('po_received_date', '2026-01-01')
//       .in('buyer_supplier_links.buyer_org_id', buyerOrgIds)
//       .order('created_at', { ascending: false })
//       .range(from, to)

//     if (poNumber?.trim())          query = query.ilike('po_number', `%${poNumber.trim()}%`)
//     if (piStatus === 'confirmed')  query = query.eq('pi_confirmed', true)
//     if (piStatus === 'pending')    query = query.or('pi_confirmed.is.null,pi_confirmed.eq.false')
//     if (dateFrom)                  query = query.gte('po_received_date', dateFrom)
//     if (dateTo)                    query = query.lte('po_received_date', dateTo)
//     if (supplierLinkIds)           query = query.in('buyer_supplier_link_id', supplierLinkIds)

//     const { data: pos, error: posError, count } = await query
//     if (posError) throw posError

//     /* =========================
//        NORMALIZE
//     ========================= */
//     const normalizedPOs = (pos || []).map(po => ({
//       ...po,
//       buyer_name:    po.buyer_supplier_links?.buyer?.display_name    || null,
//       supplier_name: po.buyer_supplier_links?.supplier?.display_name || null,
//       uploaded_by: po.on_behalf_of_member?.full_name || po.created_by || null,
//       _source: 'relational'
//     }))

//     return res.json({
//       success: true,
//       pos: normalizedPOs,
//       pagination: {
//         page:       pageNum,
//         limit:      pageSize,
//         total:      count,
//         totalPages: Math.ceil(count / pageSize),
//         hasMore:    to < count - 1
//       }
//     })

//   } catch (err) {
//     console.error('❌ Fetch buyer POs failed:', err)
//     res.status(500).json({ error: err.message || 'Server Error' })
//   }
// })

router.get('/my-buyer-pos', async (req, res) => {
  try {
    const {
      shopifyCustomerId,
      page = 1,
      limit = 20,
      poNumber,
      piStatus,
      dateFrom,
      dateTo,
      supplierName,
      buyerName,             // <-- ADD THIS
    } = req.query

    if (!shopifyCustomerId) {
      return res.status(400).json({ error: 'shopifyCustomerId required' })
    }

    const pageNum  = Math.max(1, parseInt(page))
    const pageSize = Math.min(50, Math.max(1, parseInt(limit)))
    const from     = (pageNum - 1) * pageSize
    const to       = from + pageSize - 1

    /* =========================
       RESOLVE MEMBER + ACCESS
    ========================= */
    const { data: member, error: memberError } = await supabase
      .from('organization_members')
      .select(`
        id,
        member_organization_access ( organization_id )
      `)
      .eq('shopify_customer_id', shopifyCustomerId)
      .maybeSingle()

    if (memberError) throw memberError
    if (!member || !member.member_organization_access?.length) {
      return res.json({ success: true, pos: [], count: 0, pagination: { page: pageNum, limit: pageSize, total: 0, hasMore: false } })
    }

    const buyerOrgIds = member.member_organization_access.map(a => a.organization_id)

    /* =========================
       BUYER FILTER (new)
    ========================= */
    let buyerLinkIds = null
    if (buyerName?.trim()) {
      const names = buyerName.split(',').map(n => n.trim()).filter(Boolean)

      const { data: matchingOrgs } = await supabase
        .from('organizations')
        .select('id')
        .in('display_name', names)
        .eq('type', 'buyer')

      if (!matchingOrgs?.length) {
        return res.json({
          success: true, pos: [],
          pagination: { page: pageNum, limit: pageSize, total: 0, hasMore: false }
        })
      }

      const orgIds = matchingOrgs.map(o => o.id)
      const { data: linksByOrg } = await supabase
        .from('buyer_supplier_links')
        .select('id')
        .in('buyer_org_id', orgIds)
        .eq('relationship_status', 'active')

      buyerLinkIds = (linksByOrg || []).map(l => l.id)

      if (!buyerLinkIds.length) {
        return res.json({
          success: true, pos: [],
          pagination: { page: pageNum, limit: pageSize, total: 0, hasMore: false }
        })
      }
    }

    /* =========================
       SUPPLIER FILTER (unchanged)
    ========================= */
    let supplierLinkIds = null
    if (supplierName?.trim()) {
      const names = supplierName.split(',').map(n => n.trim()).filter(Boolean)

      const { data: matchingOrgs } = await supabase
        .from('organizations')
        .select('id')
        .in('display_name', names)
        .eq('type', 'supplier')

      if (!matchingOrgs?.length) {
        return res.json({
          success: true, pos: [],
          pagination: { page: pageNum, limit: pageSize, total: 0, hasMore: false }
        })
      }

      const orgIds = matchingOrgs.map(o => o.id)
      const { data: linksByOrg } = await supabase
        .from('buyer_supplier_links')
        .select('id')
        .in('buyer_org_id', buyerOrgIds)    // must be one of the allowed buyer orgs
        .in('supplier_org_id', orgIds)
        .eq('relationship_status', 'active')

      supplierLinkIds = (linksByOrg || []).map(l => l.id)

      if (!supplierLinkIds.length) {
        return res.json({
          success: true, pos: [],
          pagination: { page: pageNum, limit: pageSize, total: 0, hasMore: false }
        })
      }
    }

    /* =========================
       BUILD QUERY
    ========================= */
    let query = supabase
      .from('purchase_orders')
      .select(`
        *,
        buyer_supplier_links!inner (
          buyer_org_id,
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
        ),
        on_behalf_of_member:organization_members!purchase_orders_on_behalf_of_fkey (full_name)
      `, { count: 'exact' })
      .is('deleted_at', null)
      .is('delete_meta', null)
      .neq('status', 'closed')
      .gte('po_received_date', '2026-01-01')
      .in('buyer_supplier_links.buyer_org_id', buyerOrgIds)   // always restrict to accessible buyer orgs
      .order('created_at', { ascending: false })
      .range(from, to)

    if (poNumber?.trim())          query = query.ilike('po_number', `%${poNumber.trim()}%`)
    if (piStatus === 'confirmed')  query = query.eq('pi_confirmed', true)
    if (piStatus === 'pending')    query = query.or('pi_confirmed.is.null,pi_confirmed.eq.false')
    if (dateFrom)                  query = query.gte('po_received_date', dateFrom)
    if (dateTo)                    query = query.lte('po_received_date', dateTo)
    if (supplierLinkIds)           query = query.in('buyer_supplier_link_id', supplierLinkIds)
    if (buyerLinkIds)              query = query.in('buyer_supplier_link_id', buyerLinkIds)   // <-- ADD THIS

    const { data: pos, error: posError, count } = await query
    if (posError) throw posError

    /* =========================
       NORMALIZE
    ========================= */
    const normalizedPOs = (pos || []).map(po => ({
      ...po,
      buyer_name:    po.buyer_supplier_links?.buyer?.display_name    || null,
      supplier_name: po.buyer_supplier_links?.supplier?.display_name || null,
      uploaded_by:   po.on_behalf_of_member?.full_name || po.created_by || null,
      _source: 'relational'
    }))

    return res.json({
      success: true,
      pos: normalizedPOs,
      pagination: {
        page:       pageNum,
        limit:      pageSize,
        total:      count,
        totalPages: Math.ceil(count / pageSize),
        hasMore:    to < count - 1
      }
    })

  } catch (err) {
    console.error('❌ Fetch buyer POs failed:', err)
    res.status(500).json({ error: err.message || 'Server Error' })
  }
})

router.get('/my-suppliers', async (req, res) => {
  try {
    const { shopifyCustomerId } = req.query
    if (!shopifyCustomerId) return res.status(400).json({ error: 'shopifyCustomerId required' })

    const { data: member, error: memberError } = await supabase
      .from('organization_members')
      .select(`id, member_organization_access ( organization_id )`)
      .eq('shopify_customer_id', shopifyCustomerId)
      .maybeSingle()

    if (memberError) throw memberError
    if (!member?.member_organization_access?.length) {
      return res.json({ success: true, suppliers: [] })
    }

    const buyerOrgIds = member.member_organization_access.map(a => a.organization_id)

    const { data, error } = await supabase
      .from('buyer_supplier_links')
      .select(`
        supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (
          id,
          display_name
        )
      `)
      .in('buyer_org_id', buyerOrgIds)
      .eq('relationship_status', 'active')

    if (error) throw error

    const suppliers = [...new Map(
      data.map(r => [r.supplier.id, r.supplier.display_name])
    ).entries()].map(([id, display_name]) => ({ id, display_name }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name))

    return res.json({ success: true, suppliers })

  } catch (err) {
    console.error('❌ Fetch suppliers failed:', err)
    res.status(500).json({ error: err.message || 'Server Error' })
  }
})

router.get('/my-buyers', async (req, res) => {
  try {
    const { shopifyCustomerId } = req.query
    if (!shopifyCustomerId) return res.status(400).json({ error: 'shopifyCustomerId required' })

    const { data: member, error: memberError } = await supabase
      .from('organization_members')
      .select(`
        id,
        member_organization_access ( organization_id )
      `)
      .eq('shopify_customer_id', shopifyCustomerId)
      .maybeSingle()

    if (memberError) throw memberError
    if (!member?.member_organization_access?.length) {
      return res.json({ success: true, buyers: [] })
    }

    const buyerOrgIds = member.member_organization_access.map(a => a.organization_id)

    const { data, error } = await supabase
      .from('organizations')
      .select('display_name')
      .in('id', buyerOrgIds)
      .eq('type', 'buyer')

    if (error) throw error

    const buyers = (data || []).map(b => ({ display_name: b.display_name }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name))

    return res.json({ success: true, buyers })

  } catch (err) {
    console.error('❌ Fetch buyers failed:', err)
    res.status(500).json({ error: err.message || 'Server Error' })
  }
})

// Mark single alert as read
router.post('/alerts/:alertId/read', async (req, res) => {
  try {
    const { alertId } = req.params

    const { error } = await supabase
      .from('alerts')
      .update({ 
        is_read: true, 
        read_at: new Date().toISOString() 
      })
      .eq('id', alertId)

    if (error) throw error

    return res.json({ success: true })

  } catch (err) {
    console.error('Error marking alert as read:', err)
    res.status(500).json({ error: 'Failed to mark alert as read' })
  }
})

router.post('/alerts-all-read', async (req, res) => {
  try {
    const { shopifyCustomerId } = req.query

    if (!shopifyCustomerId) {
      return res.status(400).json({
        error: 'shopifyCustomerId required'
      })
    }

    /* =========================
       RESOLVE MEMBER (IF EXISTS)
    ========================= */

    const { data: member } = await supabase
      .from('organization_members')
      .select('id')
      .eq('shopify_customer_id', shopifyCustomerId)
      .maybeSingle()

    const recipientIds = [shopifyCustomerId]

    // Include new-style alerts if mapped
    if (member?.id) {
      recipientIds.push(member.id)
    }

    /* =========================
       MARK ALERTS AS READ
    ========================= */

    const { error } = await supabase
      .from('alerts')
      .update({
        is_read: true,
        read_at: new Date().toISOString()
      })
      .in('recipient_user_id', recipientIds)
      .eq('is_read', false)

    if (error) throw error

    return res.json({
      success: true
    })

  } catch (err) {
    console.error('Error marking alerts as read:', err)
    res.status(500).json({
      error: 'Failed to mark alerts as read'
    })
  }
})


// Mark all alerts as read
router.post('/alerts/mark-all-read', async (req, res) => {
  try {
    const { userId } = req.query

    if (!userId) {
      return res.status(400).json({ error: 'userId required' })
    }

    const { error } = await supabase
      .from('alerts')
      .update({ 
        is_read: true, 
        read_at: new Date().toISOString() 
      })
      .eq('recipient_user_id', userId)
      .eq('is_read', false)

    if (error) throw error

    return res.json({ success: true })

  } catch (err) {
    console.error('Error marking all alerts as read:', err)
    res.status(500).json({ error: 'Failed to mark alerts as read' })
  }
})


// GET /api/buyers/:buyerOrgId/suppliers
router.get("/buyers/:buyerOrgId/suppliers", async (req, res) => {
  const { buyerOrgId } = req.params;

  const { data, error } = await supabase
    .from("buyer_supplier_links")
    .select(`
      organizations!buyer_supplier_links_supplier_org_id_fkey (
        id,
        display_name
      )
    `)
    .eq("buyer_org_id", buyerOrgId)
    .eq("relationship_status", "active");

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const suppliers = data.map(
    (row) => row.organizations
  );

  res.json(suppliers);
});



// GET /api/merchant/:memberId/buyers
// GET /api/buyers?email=
router.get("/buyers", async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: "Missing email" });
  }

  const { data: member, error: memberError } = await supabase
    .from("organization_members")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (memberError || !member) {
    return res.status(403).json({ error: "Invalid member" });
  }

  const { data, error } = await supabase
    .from("member_organization_access")
    .select(`
      organizations!inner (
        id,
        display_name,
        type
      )
    `)
    .eq("member_id", member.id)
    .eq("organizations.type", "buyer"); // now works correctly with !inner

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const buyers = data.map(row => row.organizations);

  res.json(buyers);
});

// Updated /buyers route — returns address fields for auto-fill
router.get("/buyer-details", async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: "Missing email" });
  }

  // 1. Find member by email
  const { data: member, error: memberError } = await supabase
    .from("organization_members")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (memberError || !member) {
    return res.status(403).json({ error: "Invalid member" });
  }

  // 2. Fetch buyers this member can access — include address fields
  const { data, error } = await supabase
    .from("member_organization_access")
    .select(`
      organizations (
        id,
        name,
        display_name,
        address,
        country,
        type
      )
    `)
    .eq("member_id", member.id)
    .eq("organizations.type", "buyer");

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Filter out nulls (from the inner join filter) and flatten
  const buyers = data
    .map((row) => row.organizations)
    .filter(Boolean);

  res.json(buyers);
});


router.post('/delete-po/:poId', async (req, res) => {
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

router.post('/erp-sync-po', async (req, res) => {
  try {
    const { poIds, shopifyCustomerId, erp_synced } = req.body

    if (!poIds || !Array.isArray(poIds) || poIds.length === 0) {
      return res.status(400).json({ error: 'poIds must be a non-empty array' })
    }
    if (!shopifyCustomerId) {
      return res.status(400).json({ error: 'Missing shopifyCustomerId' })
    }

    const syncing = erp_synced !== false  // defaults to true if not sent
    const now     = syncing ? new Date().toISOString() : null

    const { data, error } = await supabase
      .from('purchase_orders')
      .update({
        erp_synced:    syncing,
        erp_synced_at: now
      })
      .in('id', poIds)
      .is('deleted_at', null)
      .select('id, erp_synced, erp_synced_at')

    if (error) throw error

    return res.json({
      success:      true,
      synced:       data.length,
      erp_synced:   syncing,
      erp_synced_at: now
    })

  } catch (err) {
    console.error('❌ ERP Sync Error:', err)
    return res.status(500).json({ error: err.message || 'ERP sync failed' })
  }
})

router.get('/team-members', async (req, res) => {
  try {
    const { shopifyCustomerId } = req.query

    // Step 1 — find the requesting member's id and org
    const { data: self, error: selfError } = await supabase
      .from('organization_members')
      .select('id')
      .eq('shopify_customer_id', shopifyCustomerId)
      .maybeSingle()

    if (selfError) throw selfError
    if (!self) return res.status(404).json({ error: 'Member not found' })

    // Step 2 — find their org from access table
    const { data: access, error: accessError } = await supabase
      .from('member_organization_access')
      .select('organization_id')
      .eq('member_id', self.id)
      .maybeSingle()

    if (accessError) throw accessError
    if (!access) return res.status(404).json({ error: 'No organization found for member' })

    // Step 3 — fetch all other members in that org
    // Step 3 — fetch all other members in that org
    const { data: members, error: membersError } = await supabase
      .from('member_organization_access')
      .select(`
        member_id,
        organization_members!inner(
          id,
          full_name,
          shopify_customer_id,
          role
        )
      `)
      .eq('organization_id', access.organization_id)
      .neq('member_id', self.id)

    if (membersError) throw membersError

    // Filter out admin/owner in JS instead
    const result = members
      .filter(m => !['admin', 'owner'].includes(m.organization_members.role))
      .map(m => ({
        memberId: m.member_id,
        full_name: m.organization_members.full_name
      }))

    res.json({ success: true, members: result })

  } catch (err) {
    console.error('❌ team-members error:', err)  // add this line
    res.status(500).json({ error: 'Failed to fetch team members' })
  }
})


const ALLOWED_BUCKETS = ['POFY26', 'POFY25', 'InvoicesFY26','POFY27']

router.get('/po-files',async (req, res) => {
  const { bucket, shopifyCustomerId } = req.query

  if (!ALLOWED_BUCKETS.includes(bucket)) {
    return res.status(400).json({ error: 'Invalid bucket' })
  }

  // ── Step 1: Match Shopify customer ID to member UUID ──
  const { data: member, error: memberError } = await supabase
    .from('organization_members')
    .select('id')
    .eq('shopify_customer_id', shopifyCustomerId)
    .maybeSingle()

  if (memberError || !member) {
    return res.status(403).json({ error: 'Member not found' })
  }

  // ── Step 2: Get all org IDs this member has access to ──
  const { data: accessRows, error: accessError } = await supabase
    .from('member_organization_access')
    .select('organization_id')
    .eq('member_id', member.id)

  if (accessError || !accessRows?.length) {
    return res.status(403).json({ error: 'No organization access found' })
  }

  const orgIds = accessRows.map(r => r.organization_id)

  // ── Step 3: Get display names for all orgs ──
  const { data: orgs, error: orgsError } = await supabase
    .from('organizations')
    .select('id, display_name')
    .in('id', orgIds)

  if (orgsError || !orgs?.length) {
    return res.status(403).json({ error: 'Organizations not found' })
  }

  // ── Step 4: List files for each org folder ──
  const results = await Promise.all(
    orgs.map(async (org) => {
      const safeName = org.display_name
        .replace(/[^a-zA-Z0-9 _-]/g, '')
        .trim()

      const { data, error } = await supabase.storage
        .from(bucket)
        .list(safeName, { limit: 1000 })

      return {
        orgId: org.id,
        displayName: org.display_name,
        basePath: safeName,
        items: error ? [] : data
      }
    })
  )
  const filteredResults = results.filter(buyer => buyer.items && buyer.items.length > 0)
  res.json({ buyers: results })
})

// Level 2: click a month → get day folders
router.get('/po-files/month', async (req, res) => {
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
router.get('/po-files/folder', async (req, res) => {
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
