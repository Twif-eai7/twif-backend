const express = require ('express');
const supabase = require('../supabaseClient')
const { sendAlertEmail } = require('../service/emailService');
const { parseFileRef } = require('../helper/storage');
const { parseSkuSheet, parseSkuSheetWithGemini, parsePiFileWithGemini } = require('./skuItems');
const dotenv = require("dotenv");
dotenv.config();
const router = express.Router();

router.post('/po-alerts', async (req, res) => {
  // ── Security check ──
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const po = req.body?.record;
    if (!po) return res.status(400).json({ error: 'No record in payload' });

    if (po.is_test || po.erp_last_synced_at) {
  console.log('🧪 Test record — skipping alerts');
  return res.status(200).json({ success: true, skipped: true, reason: 'Test record' });
  }

    console.log(`🚀 Processing PO: ${po.id} (PO#${po.po_number})`);

    // ── Resolve buyer & supplier names ──
    const { data: linkData, error: linkError } = await supabase
      .from('buyer_supplier_links')
      .select(`
        id,
        buyer_org_id,
        supplier_org_id,
        buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
        supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
      `)
      .eq('id', po.buyer_supplier_link_id)
      .maybeSingle();

    if (linkError) throw linkError;
    if (!linkData) return res.status(404).json({ error: 'Buyer-supplier link not found' });
    let createdByName = 'System';
    if(po.created_by_member_id != null) {
    const { data: createdByMember, error: createdByError } = await supabase
    .from('organization_members')
    .select('full_name')
    .eq('id', po.created_by_member_id)
    .maybeSingle();
    if (createdByError) console.error('❌ Created by member fetch error:', createdByError);
    createdByName = createdByMember?.full_name;}
    else 
    createdByName = po.created_by;

    const buyerName    = linkData.buyer?.display_name    || 'Unknown Buyer';
    const supplierName = linkData.supplier?.display_name || 'Unknown Supplier';
    const buyerOrgId   = linkData.buyer_org_id;

    // ── Build PO snapshot ──
    const poSnapshot = {
  po_id:            po.id,
  po_number:        po.po_number,
  buyer_name:       buyerName,
  supplier_name:    supplierName,
  po_received_date: po.po_received_date,
  quantity_ordered: po.quantity_ordered,
  amount:           po.amount,
  amount_usd:       po.amount_usd ?? po.amount,
  currency:         po.currency || 'USD',
  pi_confirmed:     false,
  pi_received_date: null,
  po_file_url:      po.po_file_url,
  pi_file_url:      null,
};

    // ── Resolve recipients: link-specific access first, org-wide as fallback ──
    const { data: linkAccessRows } = await supabase
      .from('member_organization_access')
      .select('member_id')
      .eq('buyer_supplier_link_id', po.buyer_supplier_link_id);

    let memberIds = [...new Set((linkAccessRows || []).map(r => r.member_id))];

    if (memberIds.length === 0 && buyerOrgId) {
      const { data: orgAccessRows } = await supabase
        .from('member_organization_access')
        .select('member_id')
        .eq('organization_id', buyerOrgId)
        .is('buyer_supplier_link_id', null);
      memberIds = [...new Set((orgAccessRows || []).map(r => r.member_id))];
    }

    if (memberIds.length === 0) {
      return res.status(200).json({ success: true, alerts: 0, reason: 'No members with buyer-org access' });
    }

    // Merchandising admins, or anyone in tech/erp — merchant-org members only.
    const { data: candidateMembers, error: adminError } = await supabase
      .from('organization_members')
      .select(`
        id, full_name, email, role, department,
        organizations!inner ( type )
      `)
      .eq('organizations.type', 'merchant')
      .in('id', memberIds);

    if (adminError) console.error('❌ Admin fetch error:', adminError);

    const adminMembers = (candidateMembers || []).filter(m =>
      (m.department === 'merchandising' && m.role === 'admin') || m.department === 'tech' || m.department === 'erp'
    );

    if (!adminMembers?.length) {
      return res.status(200).json({ success: true, alerts: 0, reason: 'No eligible recipients' });
    }

    // ── Create in-app alerts ──
    const alertMessage = `PO received for ${buyerName} → ${supplierName} by ${createdByName} on ${po.po_received_date}`;

    const alertInserts = adminMembers.map(member => ({
      message:           alertMessage,
      alert_type:        'PO_UPLOAD',
      po_id:             po.id,
      po_snapshot:       poSnapshot,
      recipient_user_id: member.id,
      recipient_name:    member.full_name,
      is_read:           false,
      retry_count:       0,
      scheduled_for:     new Date().toISOString(),
      email_sent:        false,
    }));

    const { data: insertedAlerts, error: alertError } = await supabase
      .from('alerts')
      .insert(alertInserts)
      .select();

    if (alertError) console.error('❌ Alert insert error:', alertError);
    else console.log(`✅ ${insertedAlerts?.length || 0} alerts created`);

    // ── Email is no longer sent here — the daily upload-alerts-digest cron
    // picks up alerts with email_sent = false and sends one summary per admin ──

    return res.status(200).json({
      success:        true,
      po_id:          po.id,
      alerts_created: insertedAlerts?.length || 0,
    });

  } catch (err) {
    console.error('❌ handle-po-alerts error:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/pi-alerts', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { record, old_record } = req.body;

    if (!record) return res.status(400).json({ error: 'No record in payload' });

    if (record.is_test || record.erp_last_synced_at) {
  console.log('🧪 Test record — skipping alerts');
  return res.status(200).json({ success: true, skipped: true, reason: 'Test record' });
}

    // ── Early return if PI fields unchanged ──
    const piJustConfirmed = record.pi_confirmed === true && old_record?.pi_confirmed !== true;
    const piFileAdded     = record.pi_file_url && !old_record?.pi_file_url;

    if (!piJustConfirmed && !piFileAdded) {
      console.log('ℹ️ PI fields unchanged — skipping');
      return res.status(200).json({ success: true, skipped: true, reason: 'PI fields unchanged' });
    }

    console.log(`🚀 Processing PI confirmation for PO: ${record.id} (PO#${record.po_number})`);

    // ── Resolve buyer & supplier ──
    const { data: link, error: linkError } = await supabase
      .from('buyer_supplier_links')
      .select(`
        buyer_org_id,
        buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
        supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
      `)
      .eq('id', record.buyer_supplier_link_id)
      .maybeSingle();

    if (linkError) throw linkError;
    if (!link) return res.status(404).json({ error: 'Buyer-supplier link not found' });

    const buyerOrgId      = link.buyer_org_id;
    const buyerNameText   = link.buyer?.display_name   || 'Unknown Buyer';
    const supplierNameText= link.supplier?.display_name|| 'Unknown Supplier';

    const finalPoNumber = record.po_number;

    /* =========================
       UPDATE EXISTING PO_UPLOAD ALERTS
    ========================= */

    const { data: existingAlerts, error: fetchAlertsError } = await supabase
      .from('alerts')
      .select('id, po_snapshot')
      .eq('po_id', record.id)
      .eq('alert_type', 'PO_UPLOAD')

    if (fetchAlertsError) console.error('❌ Error fetching existing alerts:', fetchAlertsError);

    if (existingAlerts && existingAlerts.length > 0) {
      const updatePromises = existingAlerts.map(alert => {
        const updatedSnapshot = {
        ...(alert.po_snapshot || {}),
        pi_confirmed:     true,
        pi_received_date: record.pi_received_date,
        ex_factory_date:  record.ex_factory_date,
        pi_file_url:      record.pi_file_url,
        // ↓ pick up any overrides written by the PI route
        ...(record.amount     != null ? { amount:     record.amount }     : {}),
        ...(record.amount_usd != null ? { amount_usd: record.amount_usd } : {}),
        ...(record.currency             ? { currency:   record.currency }   : {}),
        ...(record.quantity_ordered != null ? { quantity_ordered: record.quantity_ordered } : {}),
      };

        return supabase
          .from('alerts')
          .update({
            po_snapshot: updatedSnapshot,
            is_read:     false,
          })
          .eq('id', alert.id);
      });

      const results = await Promise.all(updatePromises);
      const errors = results.filter(r => r.error);

      if (errors.length > 0) console.error('❌ Alert update errors:', errors);
      else console.log(`✅ Updated ${existingAlerts.length} existing alert snapshots`);
    }

    const { error: deleteReminderError } = await supabase
  .from('alerts')
  .delete()
  .eq('po_id', record.id)
  .in('alert_type', ['PI_REMINDER', 'PI_OVERDUE', 'PI_DELAY'])

if (deleteReminderError) {
  console.error('❌ Error clearing reminder/delay alerts:', deleteReminderError)
} else {
  console.log('✅ PI_REMINDER, PI_OVERDUE and PI_DELAY alerts cleared on PI confirmation')
}

    /* =========================
       FETCH MERCHANT + ELIGIBLE MEMBERS
    ========================= */

  // ── Resolve recipients: link-specific access first, org-wide as fallback ──
  const { data: linkAccessRows } = await supabase
    .from('member_organization_access')
    .select('member_id')
    .eq('buyer_supplier_link_id', record.buyer_supplier_link_id);

  let memberIds = [...new Set((linkAccessRows || []).map(r => r.member_id))];

  if (memberIds.length === 0 && buyerOrgId) {
    const { data: orgAccessRows } = await supabase
      .from('member_organization_access')
      .select('member_id')
      .eq('organization_id', buyerOrgId)
      .is('buyer_supplier_link_id', null);
    memberIds = [...new Set((orgAccessRows || []).map(r => r.member_id))];
  }

  if (memberIds.length === 0) {
    return res.status(200).json({ success: true, alerts: 0, reason: 'No members with buyer-org access' });
  }

  // Merchandising admins, or anyone in tech/erp — merchant-org members only.
  const { data: candidateMembers, error: adminError } = await supabase
    .from('organization_members')
    .select(`
      id, full_name, email, role, department,
      organizations!inner ( type )
    `)
    .eq('organizations.type', 'merchant')
    .in('id', memberIds);

  if (adminError) console.error('❌ Admin fetch error:', adminError);

  const adminMembers = (candidateMembers || []).filter(m =>
    (m.department === 'merchandising' && m.role === 'admin') || m.department === 'tech' || m.department === 'erp'
  );

  if (!adminMembers?.length) {
    return res.status(200).json({ success: true, alerts: 0, reason: 'No eligible recipients' });
  }

    /* =========================
       CREATE NEW PI_UPLOAD ALERTS
       (use merged snapshot from existing alert, same as your route)
    ========================= */

    const alertMessage = `PI uploaded for ${buyerNameText} → ${supplierNameText} (PO#${finalPoNumber})`;

    const completeSnapshotForPI = existingAlerts && existingAlerts.length > 0
      ? {
          ...(existingAlerts[0].po_snapshot || {}),
          pi_confirmed:     true,
          pi_received_date: record.pi_received_date,
          ex_factory_date:  record.ex_factory_date,
          pi_file_url:      record.pi_file_url,
        }
      : {
    po_id:            record.id,
    po_number:        record.po_number,
    buyer_name:       buyerNameText,
    supplier_name:    supplierNameText,
    po_received_date: record.po_received_date,
    quantity_ordered: record.quantity_ordered,
    amount:           record.amount,
    amount_usd:       record.amount_usd ?? record.amount,
    currency:         record.currency || 'USD',
    pi_confirmed:     true,
    pi_received_date: record.pi_received_date,
    ex_factory_date:  record.ex_factory_date,
    po_file_url:      record.po_file_url,
    pi_file_url:      record.pi_file_url,
  };


    const alertInserts = adminMembers.map(m => ({
      message:           alertMessage,
      alert_type:        'PI_UPLOAD',
      po_id:             record.id,
      po_snapshot:       completeSnapshotForPI,
      recipient_user_id: m.id,
      recipient_name:    m.full_name,
      is_read:           false,
      email_sent:        false,
      retry_count:       0,
      scheduled_for:     new Date().toISOString(),
    }));

    const { data: insertedAlerts, error: alertError } = await supabase
      .from('alerts')
      .insert(alertInserts)
      .select();

    if (alertError) console.error('❌ Alert insert error:', alertError);
    else console.log(`✅ ${insertedAlerts?.length || 0} PI alerts created`);

    // ── Email is no longer sent here — the daily upload-alerts-digest cron
    // picks up alerts with email_sent = false and sends one summary per admin ──

    return res.status(200).json({
      success:        true,
      po_id:          record.id,
      alerts_created: insertedAlerts?.length || 0,
    });

  } catch (err) {
    console.error('❌ handle-pi-alerts error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* =========================
   POST /webhooks/pi-delay-alerts
   Triggered by Supabase on INSERT to po_comments
========================= */
router.post('/pi-delay-reason-alerts', async (req, res) => {
  const secret = req.headers['x-webhook-secret']
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const record = req.body?.record
    if (!record) return res.status(400).json({ error: 'No record in payload' })

    if (record.comment_type !== 'PI_DELAY') {
      console.log('ℹ️ Not a PI_DELAY comment — skipping')
      return res.status(200).json({ success: true, skipped: true, reason: 'Not PI_DELAY' })
    }

    console.log(`🚀 Processing PI delay alert for PO: ${record.po_id}`)

    /* ========================= FETCH PO ========================= */

    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .select(`
        id,
        po_number,
        po_received_date,
        is_test,
        buyer_supplier_link_id
      `)
      .eq('id', record.po_id)
      .maybeSingle()

    if (poError) throw poError
    if (!po) return res.status(404).json({ error: 'PO not found' })

    if (po.is_test) {
      console.log('🧪 Test record — skipping')
      return res.status(200).json({ success: true, skipped: true, reason: 'Test record' })
    }

    const { data: createdByMember } = await supabase
  .from('organization_members')
  .select('full_name')
  .eq('id', record.created_by)
  .maybeSingle();


  const createdByName = createdByMember?.full_name || 'Unknown Creator';
    /* ========================= RESOLVE BUYER + SUPPLIER ========================= */

    const { data: link, error: linkError } = await supabase
      .from('buyer_supplier_links')
      .select(`
        buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
        supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
      `)
      .eq('id', po.buyer_supplier_link_id)
      .maybeSingle()

    if (linkError) throw linkError
    if (!link) throw new Error('Buyer–Supplier link not found')

    const buyerNameText    = link.buyer?.display_name    || 'Unknown Buyer'
    const supplierNameText = link.supplier?.display_name || 'Unknown Supplier'

    /* ========================= FETCH EXISTING PI_OVERDUE ALERTS ========================= */

    const { data: overdueAlerts, error: fetchError } = await supabase
      .from('alerts')
      .select('id, recipient_user_id, po_snapshot')
      .eq('po_id', record.po_id)
      .in('alert_type', ['PI_OVERDUE', 'PI_DELAY'])

    if (fetchError) console.error('❌ Error fetching overdue alerts:', fetchError)

    console.log(`📋 Found ${overdueAlerts?.length || 0} PI_OVERDUE alerts for PO ${po.po_number}`)

    if (!overdueAlerts?.length) {
      console.warn('⚠️ No PI_OVERDUE alerts found — nothing to update')
      // still send email to admins below
    }

    /* ========================= FETCH ADMIN MEMBER IDS ========================= */

   const { data: adminMembers, error: adminError } = await supabase
  .from('organization_members')
  .select(`
    id,
    full_name,
    email,
    organizations!inner (
      id,
      type
    )
  `)
  .eq('role', 'admin')
  .eq('organizations.type', 'merchant')

    if (adminError) console.error('❌ Admin fetch error:', adminError)

    const adminIds = new Set((adminMembers || []).map(m => m.id))

    /* ========================= SPLIT ALERTS BY ROLE ========================= */

    const adminAlertIds   = (overdueAlerts || []).filter(a => adminIds.has(a.recipient_user_id)).map(a => a.id)
    const nonAdminAlertIds = (overdueAlerts || []).filter(a => !adminIds.has(a.recipient_user_id)).map(a => a.id)

    console.log(`👤 Admin alerts to update: ${adminAlertIds.length}`)
    console.log(`👥 Non-admin alerts to delete: ${nonAdminAlertIds.length}`)

    /* ========================= BUILD UPDATED SNAPSHOT ========================= */

    const existingSnapshot = overdueAlerts?.[0]?.po_snapshot || {}

    const updatedSnapshot = {
      ...existingSnapshot,
      comment:    record.comment,
      created_by: createdByName,
      created_at: record.created_at,
    }

    const alertMessage = `PI delay reason stated for ${buyerNameText} → ${supplierNameText} (PO#${po.po_number}) by ${createdByName}`

    /* ========================= UPDATE ADMIN ALERTS → PI_DELAY ========================= */

    if (adminAlertIds.length > 0) {
      const { error: updateError } = await supabase
        .from('alerts')
        .update({
          alert_type:  'PI_DELAY',
          message:     alertMessage,
          po_snapshot: updatedSnapshot,
          is_read:     false,
          email_sent:  false,
        })
        .in('id', adminAlertIds)

      if (updateError) console.error('❌ Admin alert update error:', updateError)
      else console.log(`✅ ${adminAlertIds.length} admin alerts converted to PI_DELAY`)
    }

    /* ========================= DELETE NON-ADMIN ALERTS ========================= */

    if (nonAdminAlertIds.length > 0) {
      const { error: deleteError } = await supabase
        .from('alerts')
        .delete()
        .in('id', nonAdminAlertIds)

      if (deleteError) console.error('❌ Non-admin alert delete error:', deleteError)
      else console.log(`✅ ${nonAdminAlertIds.length} non-admin alerts deleted`)
    }

    /* ========================= SEND EMAIL TO ADMINS ========================= */

    if (adminMembers?.length) {
      sendAlertEmail(
        adminMembers.map(m => ({ email: m.email, name: m.full_name })),
        alertMessage,
        {
          buyer_name:    buyerNameText,
          supplier_name: supplierNameText,
          po_number:     po.po_number,
          comment:       record.comment,
          created_by:    createdByName,
          date:          po.po_received_date,
        },
        'PI_DELAY'
      ).then(async (result) => {
        console.log('📧 PI delay email result:', result)
        if (result.success && adminAlertIds.length > 0) {
          const { error } = await supabase
            .from('alerts')
            .update({ email_sent: true })
            .in('id', adminAlertIds)
          if (error) console.error('❌ email_sent update error:', error)
        }
      }).catch(err => {
        console.error('❌ PI delay email failed:', err)
      })
    }

    /* ========================= SUCCESS ========================= */

    return res.status(200).json({
      success:             true,
      po_id:               po.id,
      admin_alerts_updated: adminAlertIds.length,
      non_admin_deleted:   nonAdminAlertIds.length,
    })

  } catch (err) {
    console.error('❌ PI delay webhook error:', err)
    return res.status(500).json({ error: err.message })
  }
})

router.post('/po-delete-alerts', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { record, old_record } = req.body;

    if (!record) return res.status(400).json({ error: 'No record in payload' });

    if (record.is_test || record.erp_last_synced_at) {
      console.log('🧪 Test record — skipping alerts');
      return res.status(200).json({ success: true, skipped: true, reason: 'Test record' });
    }

    // ── Early return if PO wasn't just deleted ──
    const poJustDeleted = record.delete_meta != null && old_record?.delete_meta == null;
    if (!poJustDeleted) {
      console.log('ℹ️ Not a delete event — skipping');
      return res.status(200).json({ success: true, skipped: true, reason: 'Not a delete event' });
    }

    console.log(`🚀 Processing PO delete alerts for PO: ${record.id} (PO#${record.po_number})`);

    const deleteMeta = record.delete_meta;

    /* =========================
       FETCH LINK DATA
    ========================= */

    const { data: link, error: linkError } = await supabase
      .from('buyer_supplier_links')
      .select(`
        buyer_org_id,
        buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
        supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
      `)
      .eq('id', record.buyer_supplier_link_id)
      .maybeSingle();

    if (linkError) throw linkError;

    const buyerName    = link?.buyer?.display_name    || 'Unknown Buyer';
    const supplierName = link?.supplier?.display_name || 'Unknown Supplier';
    const buyerOrgId   = link?.buyer_org_id;

    /* =========================
       FETCH ELIGIBLE MEMBERS
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
      .eq('organization_id', buyerOrgId);

    const eligibleMembers = (accessRows || [])
      .map(r => r.organization_members)
      .filter(m => m && merchantOrg && m.organization_id === merchantOrg.id);

    if (eligibleMembers.length === 0) {
      console.log('ℹ️ No eligible members — skipping alerts');
      return res.status(200).json({ success: true, skipped: true, reason: 'No eligible members' });
    }

    /* =========================
       PATCH EXISTING ALERT SNAPSHOTS
    ========================= */

    const { data: existingAlerts } = await supabase
      .from('alerts')
      .select('id, po_snapshot')
      .eq('po_id', record.id);

    if (existingAlerts?.length > 0) {
      const results = await Promise.all(
        existingAlerts.map(alert =>
          supabase
            .from('alerts')
            .update({
              po_snapshot: {
                ...(alert.po_snapshot || {}),
                delete_meta: deleteMeta,
              }
            })
            .eq('id', alert.id)
        )
      );

      const errors = results.filter(r => r.error);
      if (errors.length > 0) {
        console.error('❌ Alert snapshot update errors:', errors);
      } else {
        console.log('✅ Updated alert snapshots:', existingAlerts.length);
      }
    }

    /* =========================
       EMAIL ALERT
    ========================= */

    const emailMessage = `PO ${record.po_number} for ${buyerName} → ${supplierName} was deleted by ${deleteMeta.deletedByName}${deleteMeta.reason ? `: ${deleteMeta.reason}` : ' (no reason provided)'}`;

    sendAlertEmail(
      eligibleMembers.map(m => ({ email: m.email, name: m.full_name })),
      emailMessage,
      {
        buyer_name:       buyerName,
        supplier_name:    supplierName,
        po_number:        record.po_number,
        quantity_ordered: record.quantity_ordered,
        amount:           record.amount,
        date:             record.po_received_date,
        deleted_by:       deleteMeta.deletedByName,
        reason:           deleteMeta.reason || 'No reason provided',
      },
      'PO_DELETED'
    ).catch(err => console.error('❌ Delete email failed:', err));

    console.log(`✅ Email alerts dispatched: ${eligibleMembers.length}`);

    /* =========================
       SUCCESS
    ========================= */

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('❌ PO delete alert error:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/otif-exception-alerts', async (req, res) => {
  // ── Security check ──
  const secret = req.headers['x-webhook-secret']
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const record = req.body?.record
    if (!record) return res.status(400).json({ error: 'No record in payload' })

    // Only fire on new pending exceptions
    if (record.status !== 'pending') {
      return res.status(200).json({ success: true, skipped: true, reason: 'Not a new pending exception' })
    }

    // otif_exceptions holds both OTIF exceptions and quantity cancellation
    // requests (exception_type distinguishes them) - see
    // supabase/migrations/20260824_extend_otif_exceptions_for_cancellations.sql
    const isQuantityCancellation = record.exception_type === 'quantity_cancellation'

    console.log(`🚀 Processing ${isQuantityCancellation ? 'quantity cancellation' : 'OTIF'} exception: ${record.id} for PO: ${record.po_id}`)

    // ── Fetch PO + buyer/supplier names ──
    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .select(`
        id, po_number, ex_factory_date,
        buyer_supplier_links(
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey(display_name),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey(display_name)
        )
      `)
      .eq('id', record.po_id)
      .maybeSingle()

    if (poError) throw poError
    if (!po) return res.status(404).json({ error: 'Purchase order not found' })

    const buyerName    = po.buyer_supplier_links?.buyer?.display_name    || 'Unknown Buyer'
    const supplierName = po.buyer_supplier_links?.supplier?.display_name || 'Unknown Supplier'

    // ── Fetch the SKU line item, for cancellation requests only ──
    let lineItem = null
    if (isQuantityCancellation && record.line_item_id) {
      const { data: li, error: liError } = await supabase
        .from('po_line_items')
        .select('buyer_sku_ref, quantity_ordered, cancelled_quantity')
        .eq('id', record.line_item_id)
        .maybeSingle()

      if (liError) console.error('❌ Line item fetch error:', liError)
      lineItem = li
    }

    // ── Fetch senior + tech admins only ──
    const { data: adminMembers, error: adminError } = await supabase
      .from('organization_members')
      .select(`
        id, full_name, email,
        organizations!inner(type)
      `)
      .in('role', ['admin', 'owner'])
      .eq('organizations.type', 'merchant')
      .or('department.is.null,department.eq.tech')

    if (adminError) console.error('❌ Admin fetch error:', adminError)

    if (!adminMembers?.length) {
      return res.status(200).json({ success: true, alerts: 0, reason: 'No eligible reviewers' })
    }

    // ── Build details ──
    const alertType = isQuantityCancellation ? 'QUANTITY_CANCELLATION' : 'OTIF_EXCEPTION'

    const alertMessage = isQuantityCancellation
      ? `Quantity cancellation requested for PO#${po.po_number} (${buyerName})${lineItem?.buyer_sku_ref ? ` · SKU ${lineItem.buyer_sku_ref}` : ''} by ${record.reported_by}`
      : `OTIF exception raised for PO#${po.po_number} (${buyerName}) by ${record.reported_by}`

    const poDetails = isQuantityCancellation
      ? {
          buyer_name:         buyerName,
          supplier_name:      supplierName,
          po_number:          po.po_number,
          sku:                lineItem?.buyer_sku_ref,
          requested_quantity: record.requested_quantity,
          quantity_ordered:   lineItem?.quantity_ordered,
          already_cancelled:  lineItem?.cancelled_quantity,
          reason:             record.reason,
          comment:            record.comment,
          reported_by:        record.reported_by,
        }
      : {
          buyer_name:               buyerName,
          supplier_name:            supplierName,
          po_number:                po.po_number,
          ex_factory_date:          po.ex_factory_date,
          proposed_ex_factory_date: record.proposed_ex_factory_date,
          reason:                   record.reason,
          comment:                  record.comment,
          reported_by:              record.reported_by,
        }

    // ── Insert in-app alerts ──
    const alertInserts = adminMembers.map(member => ({
      message:           alertMessage,
      alert_type:        alertType,
      po_id:             record.po_id,
      po_snapshot:       poDetails,
      recipient_user_id: member.id,
      recipient_name:    member.full_name,
      is_read:           false,
      retry_count:       0,
      scheduled_for:     new Date().toISOString(),
      email_sent:        false,
    }))

    const { data: insertedAlerts, error: alertError } = await supabase
      .from('alerts')
      .insert(alertInserts)
      .select()

    if (alertError) console.error('❌ Alert insert error:', alertError)
    else console.log(`✅ ${insertedAlerts?.length || 0} alerts created`)

    // ── Send emails ──
    const emailResult = await sendAlertEmail(
      adminMembers.map(m => ({ email: m.email, name: m.full_name })),
      alertMessage,
      poDetails,
      alertType
    )

    console.log('📧 Email result:', emailResult)

    // ── Mark email_sent ──
    if (emailResult.success && insertedAlerts?.length) {
      const { error: updateError } = await supabase
        .from('alerts')
        .update({ email_sent: true })
        .in('id', insertedAlerts.map(a => a.id))

      if (updateError) console.error('❌ email_sent update error:', updateError)
      else console.log('✅ Alerts marked email_sent')
    }

    return res.status(200).json({
      success:        true,
      exception_id:   record.id,
      alerts_created: insertedAlerts?.length || 0,
      emails_sent:    emailResult.successCount,
    })

  } catch (err) {
    console.error('❌ OTIF exception alert error:', err)
    return res.status(500).json({ error: err.message })
  }
})

router.post('/qa-inspection-comment', async (req, res) => {

   const secret = req.headers['x-webhook-secret']
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const { type, record } = req.body

  if (type !== 'INSERT' || record?.comment_type !== 'QA_INSPECTION') {
    return res.status(200).json({ skipped: true })
  }

  const { po_id, comment, created_by } = record

  try {
    // 1. Fetch PO — need buyer_supplier_link_id, buyer_org_id, and display names
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .select(`
        id, po_number, buyer_supplier_link_id,
        buyer_supplier_links (
          buyer_org_id,
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
        )
      `)
      .eq('id', po_id)
      .single()

    if (poErr || !po) {
      console.warn('[qa-webhook] PO not found:', po_id)
      return res.status(200).json({ skipped: 'po_not_found' })
    }

    const buyerOrgId = po.buyer_supplier_links?.buyer_org_id ?? null

    // 2a. Direct recipients — member_organization_access rows with explicit link match
    const { data: directAccess } = await supabase
      .from('member_organization_access')
      .select('member_id')
      .eq('buyer_supplier_link_id', po.buyer_supplier_link_id)

    const directIds = (directAccess || []).map(r => r.member_id).filter(Boolean)

    // 2b. Fallback — members scoped by buyer org (organization_id = buyer_org_id, no direct link set)
    let fallbackIds = []
    if (buyerOrgId) {
      const { data: fallbackAccess } = await supabase
        .from('member_organization_access')
        .select('member_id')
        .eq('organization_id', buyerOrgId)
        .is('buyer_supplier_link_id', null)

      fallbackIds = (fallbackAccess || []).map(r => r.member_id).filter(Boolean)
    }

    const recipientIds = [...new Set([...directIds, ...fallbackIds])]

    if (!recipientIds.length) {
      return res.status(200).json({ skipped: 'no_recipients' })
    }

    // 3. Insert one alert row per recipient
    const buyer_name    = po.buyer_supplier_links?.buyer?.display_name    ?? null
    const supplier_name = po.buyer_supplier_links?.supplier?.display_name ?? null

    const alerts = recipientIds.map(member_id => ({
      alert_type:        'INSPECTION_COMMENT',
      message:           `QA inspection comment on PO ${po.po_number}`,
      recipient_user_id: member_id,
      is_read:           false,
      po_snapshot: {
        po_id,
        po_number:    po.po_number,
        buyer_name,
        supplier_name,
        comment_text: comment,
        comment_by:   created_by,
      },
    }))

    const { error: insertErr } = await supabase.from('alerts').insert(alerts)
    if (insertErr) throw insertErr

    return res.status(200).json({ inserted: alerts.length })
  } catch (err) {
    console.error('[qa-webhook] error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})



/* =========================
   Shared by both entry points below — parses `record.product_details_file_url`
   and creates a review batch. Never writes to skus/po_line_items directly —
   a human still confirms each row before anything lands there. Best-effort:
   a bad/unparseable sheet or missing link just means no batch gets created
   (returned as `skipped`, never throws for those cases) — PO Drawer falls
   back to the manual "Create SKUs" upload flow when no batch exists for a PO.

   Also fires in-app alerts to erp/tech members, but only once a batch is
   actually created — deliberately not on any `skipped` path. An earlier
   version alerted unconditionally on any file change via a separate
   webhook, which meant erp/tech got pinged for sheets the parser couldn't
   extract anything from, with nothing to actually go review.
========================= */
async function parseAndCreateBatchForPo(record) {
  console.log(`🚀 Parsing product details sheet for PO: ${record.id} (PO#${record.po_number})`)

  /* ========================= RESOLVE BUYER + VENDOR ORG IDS ========================= */

  const { data: link, error: linkError } = await supabase
    .from('buyer_supplier_links')
    .select(`
      buyer_org_id, supplier_org_id,
      buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
      supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
    `)
    .eq('id', record.buyer_supplier_link_id)
    .maybeSingle()

  if (linkError) throw linkError
  if (!link) return { success: true, skipped: true, reason: 'Buyer-supplier link not found' }

  const { buyer_org_id: buyerOrgId, supplier_org_id: vendorId } = link
  const buyerName    = link.buyer?.display_name    || 'Unknown Buyer'
  const supplierName = link.supplier?.display_name || 'Unknown Supplier'

  /* ========================= DOWNLOAD THE ALREADY-UPLOADED FILE ========================= */

  const { bucket, path } = parseFileRef(record.product_details_file_url)
  if (!bucket || !path) {
    return { success: true, skipped: true, reason: 'Could not resolve file location' }
  }

  const { data: fileBlob, error: downloadError } = await supabase.storage.from(bucket).download(path)
  if (downloadError) throw downloadError
  const buffer = Buffer.from(await fileBlob.arrayBuffer())

  /* ========================= PARSE ========================= */

  let parsed
  let parseFailureDetail = null
  try {
    parsed = await parseSkuSheet({ buffer, vendorId, buyerOrgId })
  } catch (err) {
    console.error('❌ Product sheet parse failed:', err.message)
    parsed = { rows: [] }
    parseFailureDetail = err.message
  }

  // A genuine .xlsx/.xls can "succeed" (real sheet, real header row) but
  // still end up with zero usable rows if none of its columns match any
  // FIELD_RULES pattern — that's not a thrown error, so it wouldn't be
  // caught above, but it's the same practical dead end for the reviewer as
  // a parse failure. Try the Gemini fallback for either case.
  if (!parsed.rows.length) {
    console.error('⚠️ Deterministic parse produced no rows, trying Gemini fallback')
    try {
      parsed = await parseSkuSheetWithGemini({ buffer, vendorId, buyerOrgId })
    } catch (aiErr) {
      console.error('❌ Gemini fallback also failed:', aiErr.message)
      return { success: true, skipped: true, reason: 'Parse failed', detail: parseFailureDetail || aiErr.message }
    }
  }

  if (!parsed.rows.length) {
    return { success: true, skipped: true, reason: 'No new SKU rows found' }
  }

  /* ========================= REPLACE ANY EXISTING BATCH(ES) FOR THIS PO =========================
     Only once we know the new file actually parsed into something — a re-upload represents "here's
     the current sheet", so whatever batch already exists for this PO (e.g. from the original upload,
     still sitting unreviewed) gets replaced rather than left duplicated alongside the new one. Cascades
     sku_import_rows away via FK; never touches `skus` — any already-confirmed SKU is untouched either way. */

  const { error: deleteOldBatchesError } = await supabase
    .from('sku_import_batches')
    .delete()
    .eq('po_id', record.id)
  if (deleteOldBatchesError) throw deleteOldBatchesError

  /* ========================= PERSIST BATCH + ROWS ========================= */

  const { data: batch, error: batchError } = await supabase
    .from('sku_import_batches')
    .insert({
      buyer_org_id: buyerOrgId,
      vendor_org_id: vendorId,
      po_id: record.id,
      file_name: path.split('/').pop(),
      sheet_used: parsed.sheetUsed,
      uploaded_by: null,
      import_type: 'product_sheet',
    })
    .select()
    .single()
  if (batchError) throw batchError

  const { error: rowsError } = await supabase
    .from('sku_import_rows')
    .insert(parsed.rows.map((r, idx) => ({
      batch_id: batch.id,
      row_index: idx,
      confirmed: r.confirmed || {},
      needs_confirm: r.needs_confirm || {},
      needs_input: r.needs_input || {},
      raw_mapped: r.raw_mapped || null,
      sku_id: r.sku_id ?? null,
    })))
  if (rowsError) throw rowsError

  console.log(`✅ Created SKU import batch ${batch.id} (${parsed.rows.length} rows) for PO ${record.id}`)

  /* ========================= IN-APP ALERTS — ERP/TECH ONLY, ON REAL SUCCESS =========================
     Deliberately only fires from here, not on any of the `skipped`/failure returns above — an alert
     saying "product sheet uploaded" is only useful once there's actually something to review. Firing it
     unconditionally on file-change (an earlier version did this as a separate webhook) meant erp/tech
     could get pinged for a sheet the parser couldn't extract anything from, with nothing to act on. */

  const { data: recipients, error: recipientsError } = await supabase
    .from('organization_members')
    .select(`id, full_name, organizations!inner (type)`)
    .in('department', ['erp', 'tech'])
    .eq('organizations.type', 'merchant')

  if (recipientsError) {
    console.error('❌ Alert recipient fetch error:', recipientsError)
  } else if (recipients?.length) {
    const alertMessage = `Product sheet parsed for PO#${record.po_number} (${buyerName} → ${supplierName}) — ${parsed.rows.length} SKU${parsed.rows.length === 1 ? '' : 's'} ready to review`
    const alertInserts = recipients.map(member => ({
      message:           alertMessage,
      alert_type:        'PRODUCT_SHEET_UPDATE',
      po_id:             record.id,
      po_snapshot:       { po_id: record.id, po_number: record.po_number, buyer_name: buyerName, supplier_name: supplierName, batch_id: batch.id },
      recipient_user_id: member.id,
      recipient_name:    member.full_name,
      is_read:           false,
      retry_count:       0,
      scheduled_for:     new Date().toISOString(),
      email_sent:        false,
    }))

    const { error: alertError } = await supabase.from('alerts').insert(alertInserts)
    if (alertError) console.error('❌ Product sheet alert insert error:', alertError)
    else console.log(`✅ ${alertInserts.length} product sheet alerts created`)
  }

  return { success: true, po_id: record.id, batch_id: batch.id, rows_created: parsed.rows.length }
}

/* =========================
   POST /webhooks/product-details-uploaded
   Two ways to call this, both behind the same x-webhook-secret auth:

   1. Supabase webhook — triggered on INSERT/UPDATE to purchase_orders.
      Body: { record, old_record }. Only proceeds if product_details_file_url
      actually changed, so this doesn't re-parse on every unrelated PO edit.

   2. Manual — `{ "poId": "<uuid>" }`, no `record`/`old_record`. For POs that
      had a product details file attached before this feature shipped (the
      webhook never fired for those, since nothing changed after it existed)
      or where the webhook failed — always re-parses the PO's current file
      regardless of whether it "changed", since calling this manually means
      "yes, do it". e.g.:
        curl -X POST https://<backend>/webhooks/product-details-uploaded \
          -H "x-webhook-secret: $WEBHOOK_SECRET" -H "Content-Type: application/json" \
          -d '{"poId":"<po-uuid>"}'
========================= */
router.post('/product-details-uploaded', async (req, res) => {
  const secret = req.headers['x-webhook-secret']
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    let record

    if (req.body.poId) {
      const { data: po, error: poError } = await supabase
        .from('purchase_orders')
        .select('id, po_number, buyer_supplier_link_id, product_details_file_url')
        .eq('id', req.body.poId)
        .maybeSingle()
      if (poError) throw poError
      if (!po) return res.status(404).json({ error: 'Purchase order not found' })
      if (!po.product_details_file_url) {
        return res.status(200).json({ success: true, skipped: true, reason: 'No product details file on this PO' })
      }
      record = po
    } else {
      const { record: webhookRecord, old_record } = req.body
      if (!webhookRecord) return res.status(400).json({ error: 'No record in payload' })

      const fileAdded = webhookRecord.product_details_file_url && webhookRecord.product_details_file_url !== old_record?.product_details_file_url
      if (!fileAdded) {
        return res.status(200).json({ success: true, skipped: true, reason: 'product_details_file_url unchanged' })
      }
      record = webhookRecord
    }

    const result = await parseAndCreateBatchForPo(record)
    return res.status(200).json(result)

  } catch (err) {
    console.error('❌ product-details-uploaded error:', err)
    return res.status(500).json({ error: err.message })
  }
})


/* =========================
   Shared by both entry points below — mirrors parseAndCreateBatchForPo
   exactly, parsing `record.pi_file_url` instead. Gemini-only (no
   deterministic parser attempt — an invoice layout isn't a fit for the
   FIELD_RULES column-mapper) via parsePiFileWithGemini. Kept as its own
   function/route rather than folded into the existing /pi-alerts webhook,
   which has unrelated PO_UPLOAD-alert-updating logic — same separation of
   concerns as the product-sheet webhook above.
========================= */
async function parseAndCreatePiBatchForPo(record) {
  console.log(`🚀 Parsing PI for PO: ${record.id} (PO#${record.po_number})`)

  const { data: link, error: linkError } = await supabase
    .from('buyer_supplier_links')
    .select(`
      buyer_org_id, supplier_org_id,
      buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
      supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
    `)
    .eq('id', record.buyer_supplier_link_id)
    .maybeSingle()

  if (linkError) throw linkError
  if (!link) return { success: true, skipped: true, reason: 'Buyer-supplier link not found' }

  const { buyer_org_id: buyerOrgId, supplier_org_id: vendorId } = link
  const buyerName    = link.buyer?.display_name    || 'Unknown Buyer'
  const supplierName = link.supplier?.display_name || 'Unknown Supplier'

  const { bucket, path } = parseFileRef(record.pi_file_url)
  if (!bucket || !path) {
    return { success: true, skipped: true, reason: 'Could not resolve file location' }
  }

  const { data: fileBlob, error: downloadError } = await supabase.storage.from(bucket).download(path)
  if (downloadError) throw downloadError
  const buffer = Buffer.from(await fileBlob.arrayBuffer())

  let parsed
  try {
    parsed = await parsePiFileWithGemini({ buffer, vendorId, buyerOrgId, poId: record.id })
  } catch (err) {
    console.error('❌ PI parse failed:', err.message)
    return { success: true, skipped: true, reason: 'Parse failed', detail: err.message }
  }

  if (!parsed.rows.length) {
    return { success: true, skipped: true, reason: 'No new PI line items found' }
  }

  // Replace any existing PI batch for this PO (a re-uploaded/revised PI
  // represents "here's the current one") — same reasoning as the
  // product-sheet path, scoped to import_type so it never touches a
  // product-sheet batch for the same PO.
  const { error: deleteOldBatchesError } = await supabase
    .from('sku_import_batches')
    .delete()
    .eq('po_id', record.id)
    .eq('import_type', 'pi')
  if (deleteOldBatchesError) throw deleteOldBatchesError

  const { data: batch, error: batchError } = await supabase
    .from('sku_import_batches')
    .insert({
      buyer_org_id: buyerOrgId,
      vendor_org_id: vendorId,
      po_id: record.id,
      file_name: path.split('/').pop(),
      sheet_used: parsed.sheetUsed,
      uploaded_by: null,
      import_type: 'pi',
    })
    .select()
    .single()
  if (batchError) throw batchError

  const { error: rowsError } = await supabase
    .from('sku_import_rows')
    .insert(parsed.rows.map((r, idx) => ({
      batch_id: batch.id,
      row_index: idx,
      confirmed: r.confirmed || {},
      needs_confirm: r.needs_confirm || {},
      needs_input: r.needs_input || {},
      raw_mapped: r.raw_mapped || null,
      sku_id: r.sku_id ?? null,
    })))
  if (rowsError) throw rowsError

  console.log(`✅ Created PI import batch ${batch.id} (${parsed.rows.length} rows) for PO ${record.id}`)

  /* ── In-app alerts — erp/tech only, on real success — same reasoning as PRODUCT_SHEET_UPDATE ── */
  const { data: recipients, error: recipientsError } = await supabase
    .from('organization_members')
    .select(`id, full_name, organizations!inner (type)`)
    .in('department', ['erp', 'tech'])
    .eq('organizations.type', 'merchant')

  if (recipientsError) {
    console.error('❌ Alert recipient fetch error:', recipientsError)
  } else if (recipients?.length) {
    const alertMessage = `PI parsed for PO#${record.po_number} (${buyerName} → ${supplierName}) — ${parsed.rows.length} line item${parsed.rows.length === 1 ? '' : 's'} ready to review`
    const alertInserts = recipients.map(member => ({
      message:           alertMessage,
      alert_type:        'PI_SHEET_PARSED',
      po_id:             record.id,
      po_snapshot:       { po_id: record.id, po_number: record.po_number, buyer_name: buyerName, supplier_name: supplierName, batch_id: batch.id },
      recipient_user_id: member.id,
      recipient_name:    member.full_name,
      is_read:           false,
      retry_count:       0,
      scheduled_for:     new Date().toISOString(),
      email_sent:        false,
    }))

    const { error: alertError } = await supabase.from('alerts').insert(alertInserts)
    if (alertError) console.error('❌ PI alert insert error:', alertError)
    else console.log(`✅ ${alertInserts.length} PI alerts created`)
  }

  return { success: true, po_id: record.id, batch_id: batch.id, rows_created: parsed.rows.length }
}

/* =========================
   POST /webhooks/pi-uploaded — same dual entry point (Supabase webhook, or
   manual `{poId}`) and x-webhook-secret auth as /product-details-uploaded.
========================= */
router.post('/pi-uploaded', async (req, res) => {
  const secret = req.headers['x-webhook-secret']
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    let record

    if (req.body.poId) {
      const { data: po, error: poError } = await supabase
        .from('purchase_orders')
        .select('id, po_number, buyer_supplier_link_id, pi_file_url')
        .eq('id', req.body.poId)
        .maybeSingle()
      if (poError) throw poError
      if (!po) return res.status(404).json({ error: 'Purchase order not found' })
      if (!po.pi_file_url) {
        return res.status(200).json({ success: true, skipped: true, reason: 'No PI file on this PO' })
      }
      record = po
    } else {
      const { record: webhookRecord, old_record } = req.body
      if (!webhookRecord) return res.status(400).json({ error: 'No record in payload' })

      const fileAdded = webhookRecord.pi_file_url && webhookRecord.pi_file_url !== old_record?.pi_file_url
      if (!fileAdded) {
        return res.status(200).json({ success: true, skipped: true, reason: 'pi_file_url unchanged' })
      }
      record = webhookRecord
    }

    const result = await parseAndCreatePiBatchForPo(record)
    return res.status(200).json(result)

  } catch (err) {
    console.error('❌ pi-uploaded error:', err)
    return res.status(500).json({ error: err.message })
  }
})


module.exports = router;