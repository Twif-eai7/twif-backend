const express = require ('express');
const supabase = require('../supabaseClient')
const { sendAlertEmail } = require('../service/emailService');
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

    // ── Fetch merchant org ──
// ── Fetch admin members ──
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

if (adminError) console.error('❌ Admin fetch error:', adminError);

if (!adminMembers?.length) {
  return res.status(200).json({ success: true, alerts: 0, reason: 'No admin members' });
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

    // ── Send emails via sendAlertEmail ──
        const poDetails = {
      buyer_name:       buyerName,
      supplier_name:    supplierName,
      po_number:        po.po_number,
      quantity_ordered: po.quantity_ordered,
      amount:           po.amount_usd ?? po.amount,
      currency:         po.currency || 'USD',
      date:             po.po_received_date,
    };


    const emailResult = await sendAlertEmail(
      adminMembers.map(m => ({ email: m.email, name: m.full_name })),
      alertMessage,
      poDetails,
      'PO_UPLOAD'
    );

    console.log('📧 Email result:', emailResult);

    // ── Mark alerts as email_sent ──
    if (emailResult.success && insertedAlerts?.length) {
      const alertIds = insertedAlerts.map(a => a.id);
      const { error: updateError } = await supabase
        .from('alerts')
        .update({ email_sent: true })
        .in('id', alertIds);

      if (updateError) console.error('❌ email_sent update error:', updateError);
      else console.log('✅ Alerts marked email_sent');
    }

    return res.status(200).json({
      success:        true,
      po_id:          po.id,
      alerts_created: insertedAlerts?.length || 0,
      emails_sent:    emailResult.successCount,
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

  // ── Fetch admin members ──
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



if (adminError) console.error('❌ Admin fetch error:', adminError);

if (!adminMembers?.length) {
  return res.status(200).json({ success: true, alerts: 0, reason: 'No admin members' });
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

    /* =========================
       SEND EMAILS (fire and forget)
    ========================= */

    sendAlertEmail(
      adminMembers.map(m => ({ email: m.email, name: m.full_name })),
      alertMessage,
      {
        buyer_name:       buyerNameText,
        supplier_name:    supplierNameText,
        po_number:        finalPoNumber,
        pi_received_date: record.pi_received_date,
      },
      'PI_UPLOAD'
    ).then(emailResult => {
      console.log('📧 Email result:', emailResult);
    }).catch(err => {
      console.error('❌ Email sending failed:', err);
    });

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

    console.log(`🚀 Processing OTIF exception: ${record.id} for PO: ${record.po_id}`)

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
    const alertMessage = `OTIF exception raised for PO#${po.po_number} (${buyerName}) by ${record.reported_by}`

    const poDetails = {
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
      alert_type:        'OTIF_EXCEPTION',
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
      'OTIF_EXCEPTION'
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



module.exports = router;