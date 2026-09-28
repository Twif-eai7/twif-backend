const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const supabase = require('../supabaseClient')
const { sendAlertEmail } = require('../service/emailService')
const { generateInspectionReportPdf } = require('../service/inspectionReportPdf')
const { requireAuth } = require('../middleware/auth')

// router.post('/date-update', async (req, res) => {
//   try {
//     const { date, buyer, poNo } = req.body;
//     console.log(`📅 Received inspection schedule update: buyer="${buyer}", poNo="${poNo}", date="${date}"`);

//     if (!buyer) return res.status(400).json({ error: 'Missing required fields: buyer' });
//     if (!poNo)  return res.status(400).json({ error: 'Missing required fields: poNo' });
//     if (!date)  return res.status(400).json({ error: 'Missing required fields: date' });

//     // ── Step 1: Find organization by buyer display_name ──
//     const { data: matchedOrgs, error: orgError } = await supabase
//       .from('organizations')
//       .select('id, display_name')
//       .ilike('display_name', `%${buyer}%`);

//     if (orgError) throw orgError;

//     if (!matchedOrgs || matchedOrgs.length === 0) {
//       console.warn(`⚠️ No organization found matching buyer: "${buyer}"`);
//       return res.status(404).json({ error: `No organization found for buyer: ${buyer}` });
//     }

//     const buyerOrgIds = matchedOrgs.map(org => org.id);
//     console.log(`✅ Found ${matchedOrgs.length} org(s) for buyer "${buyer}":`, buyerOrgIds);

//     // ── Step 2: Find member_ids via member_organization_access ──
//     const { data: accessRows, error: accessError } = await supabase
//       .from('member_organization_access')
//       .select('member_id')
//       .in('organization_id', buyerOrgIds);

//     if (accessError) throw accessError;

//     if (!accessRows || accessRows.length === 0) {
//       console.warn(`⚠️ No members found for org(s): ${buyerOrgIds}`);
//       return res.status(200).json({ success: true, reminded: 0, reason: 'No members found for organization' });
//     }

//     const memberIds = [...new Set(accessRows.map(row => row.member_id).filter(Boolean))];
//     console.log(`✅ Found ${memberIds.length} member(s) for buyer orgs`);

//     // ── Step 3: Get emails from organization_members ──
//     const { data: members, error: membersError } = await supabase
//       .from('organization_members')
//       .select('id, full_name, email')
//       .in('id', memberIds);

//     if (membersError) throw membersError;

//     const recipients = (members || []).filter(m => m.email);

//     if (recipients.length === 0) {
//       console.warn(`⚠️ No email-eligible members found`);
//       return res.status(200).json({ success: true, reminded: 0, reason: 'No eligible recipients' });
//     }

//     console.log(`📧 Sending to ${recipients.length} recipient(s) for PO#${poNo}`);

//     const alertMessage = `Inspection date updated for ${buyer} · PO#${poNo}. Scheduled for ${date}.`;

//     // ── Step 4: Insert in-app alerts ──
//     const alertInserts = recipients.map(m => ({
//       message:           alertMessage,
//       alert_type:        'INSPECTION_DATE_UPDATE',
//       po_snapshot: {
//         po_number:        poNo,
//         buyer_name:       buyer,
//         inspection_date:  date,
//       },
//       recipient_user_id: m.id,
//       recipient_name:    m.full_name,
//       is_read:           false,
//       email_sent:        false,
//       retry_count:       0,
//       scheduled_for:     new Date().toISOString(),
//     }));

//     const { data: insertedAlerts, error: alertError } = await supabase
//       .from('alerts')
//       .insert(alertInserts)
//       .select();

//     if (alertError) {
//       console.error(`❌ Alert insert error:`, alertError);
//       throw alertError;
//     }

//     console.log(`✅ ${insertedAlerts.length} in-app alert(s) created for PO#${poNo}`);

//     // ── Step 5: Send email (fire and forget) ──
//     sendAlertEmail(
//       recipients.map(m => ({ email: m.email, name: m.full_name })),
//       alertMessage,
//       {
//         buyer_name: buyer,
//         po_number:  poNo,
//         date:       date,
//       },
//       'INSPECTION_NOTIFICATION'
//     ).then(async () => {
//       const { error } = await supabase
//         .from('alerts')
//         .update({ email_sent: true })
//         .in('id', insertedAlerts.map(a => a.id));
//       if (error) console.error('❌ Email flag update failed:', error);
//       console.log(`📧 Emails sent for PO#${poNo}`);
//     }).catch(err => {
//       console.error(`❌ Email failed for PO#${poNo}:`, err);
//     });

//     return res.status(200).json({
//       success:        true,
//       reminded:       recipients.length,
//       alerts_created: insertedAlerts.length,
//       po_number:      poNo,
//       buyer:          buyer,
//     });

//   } catch (err) {
//     console.error('❌ Date-update route error:', err);
//     return res.status(500).json({ error: err.message });
//   }
// });



router.post('/date-update', async (req, res) => {
  try {
    const payload = req.body;

    console.log("📦 Incoming payload:", payload);

    const date  = payload.date;
    const buyer = payload.buyer;
    const poNo  = payload.poNo;
    const vendorName = payload.vendorName;
    // ── Validation ──
    if (!buyer) return res.status(400).json({ error: 'Missing required field: buyer' });
    if (!poNo)  return res.status(400).json({ error: 'Missing required field: poNo' });
    if (!date)  return res.status(400).json({ error: 'Missing required field: date' });
    if (!vendorName) return res.status(400).json({ error: 'Missing required field: vendorName' });

    console.log(`📅 Update: buyer="${buyer}", poNo="${poNo}", date="${date}", vendorName="${vendorName}"`);

    // ── Step 1: Find organization ──
    const { data: matchedOrgs, error: orgError } = await supabase
      .from('organizations')
      .select('id, display_name')
      .ilike('display_name', `%${buyer}%`);

    if (orgError) throw orgError;

    if (!matchedOrgs?.length) {
      return res.status(404).json({ error: `No organization found for buyer: ${buyer}` });
    }

    const buyerOrgIds = matchedOrgs.map(org => org.id);

    // ── Step 2: Members ──
    const { data: accessRows, error: accessError } = await supabase
      .from('member_organization_access')
      .select('member_id')
      .in('organization_id', buyerOrgIds);

    if (accessError) throw accessError;

    const memberIds = [...new Set(accessRows.map(r => r.member_id).filter(Boolean))];

    if (!memberIds.length) {
      return res.status(200).json({ success: true, reminded: 0 });
    }

    // ── Step 3: Emails ──
    const { data: members, error: membersError } = await supabase
      .from('organization_members')
      .select('id, full_name, email')
      .in('id', memberIds);

    if (membersError) throw membersError;

    const recipients = members.filter(m => m.email);

    if (!recipients.length) {
      return res.status(200).json({ success: true, reminded: 0 });
    }

    // ── 🔥 NEW: include full payload snapshot ──
    const alertMessage = `Inspection update: ${buyer}: (${vendorName}) · PO#${poNo} → ${date} `;

    const alertInserts = recipients.map(m => ({
      message: alertMessage,
      alert_type: 'INSPECTION_DATE_UPDATE',

      // 👇 store FULL dynamic payload
      po_snapshot: payload,

      recipient_user_id: m.id,
      recipient_name: m.full_name,
      is_read: false,
      email_sent: false,
      retry_count: 0,
      scheduled_for: new Date().toISOString(),
    }));

    const { data: insertedAlerts, error: alertError } = await supabase
      .from('alerts')
      .insert(alertInserts)
      .select();

    if (alertError) throw alertError;

    console.log(`✅ ${insertedAlerts.length} alerts created`);

    // ── Email ──
    sendAlertEmail(
      recipients.map(m => ({ email: m.email, name: m.full_name })),
      alertMessage,
      payload, // 👈 send full payload
      'INSPECTION_NOTIFICATION'
    ).then(async () => {
      await supabase
        .from('alerts')
        .update({ email_sent: true })
        .in('id', insertedAlerts.map(a => a.id));
    }).catch(err => {
      console.error("Email error:", err);
    });

    return res.status(200).json({
      success: true,
      reminded: recipients.length,
      alerts_created: insertedAlerts.length
    });

  } catch (err) {
    console.error('❌ Route error:', err);
    return res.status(500).json({ error: err.message });
  }
});


async function notifyMerchants({ customerToOrgId, vendorSet }) {
  const resolvedOrgIds = [...new Set(Object.values(customerToOrgId).filter(Boolean))];
  if (!resolvedOrgIds.length) return;

  // ── Step 1: Resolve vendor names → supplier org ids ──
  const vendorNames = [...vendorSet];
  const vendorToOrgId = {};

  if (vendorNames.length) {
    const { data: supplierOrgs } = await supabase
      .from('organizations')
      .select('id, display_name')
      .eq('type', 'supplier')
      .in('display_name', vendorNames);

    (supplierOrgs || []).forEach(o => {
      vendorToOrgId[o.display_name] = o.id;
    });
  }

  const resolvedSupplierOrgIds = new Set(Object.values(vendorToOrgId).filter(Boolean));

  // ── Step 2: Fetch all access rows ──
  const { data: accessRows } = await supabase
    .from('member_organization_access')
    .select('member_id, organization_id, buyer_supplier_link_id');

  if (!accessRows?.length) return;

  // ── Step 3: Resolve link ids → buyer_org_id + supplier_org_id ──
  const linkIds = [...new Set(accessRows.map(r => r.buyer_supplier_link_id).filter(Boolean))];
  const linkMap = {};  // link_id → { buyer_org_id, supplier_org_id }

  if (linkIds.length) {
    const { data: links } = await supabase
      .from('buyer_supplier_links')
      .select('id, buyer_org_id, supplier_org_id')
      .in('id', linkIds);

    (links || []).forEach(l => {
      linkMap[l.id] = { buyer_org_id: l.buyer_org_id, supplier_org_id: l.supplier_org_id };
    });
  }

  // ── Step 4: Build member → matched buyer org ids ──
  // A member qualifies for notification only if:
  //   - their buyer_org_id is in resolvedOrgIds (buyer matches sync data)
  //   - AND their supplier_org_id is in resolvedSupplierOrgIds (vendor matches sync data)
  // Fallback (no link): just check organization_id is in resolvedOrgIds
  const memberOrgMap = {};

  accessRows.forEach(r => {
    let buyerOrgId;

    if (r.buyer_supplier_link_id) {
      const link = linkMap[r.buyer_supplier_link_id];
      if (!link) return;

      // Both buyer AND supplier must match sync data
      if (
        !resolvedOrgIds.includes(link.buyer_org_id) ||
        !resolvedSupplierOrgIds.has(link.supplier_org_id)
      ) return;

      buyerOrgId = link.buyer_org_id;
    } else {
      // Fallback — just check org_id matches a buyer in this sync
      if (!resolvedOrgIds.includes(r.organization_id)) return;
      buyerOrgId = r.organization_id;
    }

    if (!memberOrgMap[r.member_id]) memberOrgMap[r.member_id] = new Set();
    memberOrgMap[r.member_id].add(buyerOrgId);
  });

  const memberIds = Object.keys(memberOrgMap);
  if (!memberIds.length) return;

  // ── Step 5: Fetch member emails ──
  const { data: members } = await supabase
    .from('organization_members')
    .select('id, full_name, email')
    .in('id', memberIds);

  if (!members?.length) return;

  const orgToCustomer = {};
  Object.entries(customerToOrgId).forEach(([customer, orgId]) => {
    if (orgId) orgToCustomer[orgId] = customer;
  });

  const updatedOn = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  });

  // ── Step 6: Send one email per merchant ──
  for (const member of members) {
    if (!member.email) continue;

    const memberOrgs   = [...(memberOrgMap[member.id] || [])];
    const buyerNames   = [...new Set(memberOrgs.map(id => orgToCustomer[id]).filter(Boolean))];
    const buyerDisplay = buyerNames.join(', ');

    if (!buyerNames.length) continue;

    const { count: openCount } = await supabase
  .from('inspection_po_style_summary')
  .select('*', { count: 'exact', head: true })
  .in('organization_id', memberOrgs)
  .eq('status', 'open');
const { count: shippedCount } = await supabase
  .from('inspection_po_style_summary')
  .select('*', { count: 'exact', head: true })
  .in('organization_id', memberOrgs)
  .eq('status', 'shipped');
  const { count: factoryCount } = await supabase   // ← this was missing
  .from('inspection_po_style_summary')
  .select('*', { count: 'exact', head: true })
  .in('organization_id', memberOrgs)
  .eq('still_in_factory', true);

    await sendAlertEmail(
      [{ email: member.email, name: member.full_name }],
      `Inspection tracker updated on ${updatedOn}`,
    {
  updated_on:    updatedOn,
  buyer_names:   buyerDisplay,
  open_count:    openCount    ?? 0,
  shipped_count: shippedCount ?? 0,
  factory_count: factoryCount ?? 0,
},
      'INSPECTION_SYNC_UPDATE'
    );

    console.log(`📧 Notified ${member.full_name} (${member.email}) → buyers: ${buyerDisplay}`);
  }
}

router.post('/sync', async (req, res) => {
  try {
    const { data: rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Payload must contain a non-empty "data" array.' });
    }

    console.log(`📦 Incoming open rows: ${rows.length}`);

    const now = new Date().toISOString();

    // ── Step 1: Resolve unique customer names → organization_id ──
    const uniqueCustomers = [...new Set(rows.map(r => r['Customer']).filter(Boolean))];
    const customerToOrgId = {};

    for (const customer of uniqueCustomers) {
      const { data: matched, error: orgError } = await supabase
        .from('organizations')
        .select('id')
        .ilike('display_name', `%${customer}%`)
        .limit(1)
        .single();

      if (orgError || !matched) {
        console.warn(`⚠️  No org match for customer: "${customer}"`);
        customerToOrgId[customer] = null;
      } else {
        console.log(`✅ Resolved "${customer}" → org ${matched.id}`);
        customerToOrgId[customer] = matched.id;
      }
    }

    // ── Step 2: Normalise incoming rows ──
    const incoming = rows.map(r => ({
      organization_id:     customerToOrgId[r['Customer']] ?? null,
      customer:            r['Customer'],
      vendor:              r['Vendor'] ?? null,
      customer_po_no:      String(r['Customer Po No.']),
      style:               String(r['Style#']),
      total_quantity_open: r['Total Quantity(open)'] ?? null,
      activity:            r['Activity'] ?? null,
      inspection_date:     r['Inspection Date']
                             ? new Date(r['Inspection Date']).toISOString().split('T')[0]
                             : null,
      target_date:         r['Target Date']
                             ? new Date(r['Target Date']).toISOString().split('T')[0]
                             : null,
      inspection_status:   r['Inspection Status'] ?? null,
      inspector:           r['Inspector'] ?? null,
      items_accepted:      r['Items Accepted'] ?? null,
      items_inspected:     r['Items Inspected'] ?? null,
      to_inspect_items:    r['To Inspect Items'] ?? null,
    }));

    // Filter out rows missing key fields
    const valid = incoming.filter(r => r.customer_po_no && r.style && r.inspection_date);
    const invalid = incoming.length - valid.length;

    if (invalid > 0) {
      console.warn(`⚠️  Skipped ${invalid} rows with missing customer_po_no / style / inspection_date`);
    }

    const incomingKeys = new Set(
      valid.map(r => `${r.customer_po_no}||${r.style}||${r.inspection_date}`)
    );

    // ── Step 3: Fetch currently open rows for shipped diff ──
    const { data: existingOpen, error: fetchError } = await supabase
      .from('inspection_open_items')
      .select('id, customer_po_no, style, inspection_date')
      .eq('status', 'open');

    if (fetchError) throw fetchError;

    // ── Step 4: Upsert all valid incoming rows ──
    const upsertPayload = valid.map(r => ({
      ...r,
      status:       'open',
      last_seen_at: now,
    }));

    const { error: upsertError } = await supabase
      .from('inspection_open_items')
      .upsert(upsertPayload, {
        onConflict:       'customer_po_no,style,inspection_date',
        ignoreDuplicates: false,
      });

    if (upsertError) {
      console.error('❌ Upsert error:', upsertError);
      return res.status(500).json({ error: upsertError.message });
    }

    console.log(`✅ Upserted ${valid.length} rows`);

    // ── Step 5: Mark rows no longer in payload as shipped ──
    const toShip = existingOpen.filter(
      r => !incomingKeys.has(`${r.customer_po_no}||${r.style}||${r.inspection_date}`)
    );

    console.log(`📦 Rows to mark shipped: ${toShip.length}`);

    if (toShip.length) {
      const { error: shipError } = await supabase
        .from('inspection_open_items')
        .update({ status: 'shipped', shipped_at: now })
        .in('id', toShip.map(r => r.id));

      if (shipError) {
        console.error('❌ Ship update error:', shipError);
        return res.status(500).json({ error: shipError.message });
      }
    }

const vendorSet = new Set(valid.map(r => r.vendor).filter(Boolean));

notifyMerchants({ customerToOrgId, vendorSet })
  .catch(err => console.error('❌ Notify error:', err));

    return res.status(200).json({
      success:         true,
      upserted:        valid.length,
      skipped_invalid: invalid,
      shipped:         toShip.length,
      unresolved_orgs: uniqueCustomers.filter(c => customerToOrgId[c] === null),
    });

  } catch (err) {
    console.error('❌ Route error:', err);
    return res.status(500).json({ error: err.message });
  }
});


/**
 * Resolves shopifyCustomerId → array of organization_ids
 */
async function getOrgIds(shopifyCustomerId) {
  // ── Step 1: Get member id ──
  const { data: memberData, error: memberError } = await supabase
    .from('organization_members')
    .select('id')
    .eq('shopify_customer_id', shopifyCustomerId);

  if (memberError) throw memberError;
  if (!memberData?.length) return { buyerOrgIds: [], supplierOrgIds: [] };

  const memberIds = memberData.map(m => m.id);

  // ── Step 2: Get access rows with link id ──
  const { data: accessRows, error: accessError } = await supabase
    .from('member_organization_access')
    .select('organization_id, buyer_supplier_link_id')
    .in('member_id', memberIds);

  if (accessError) throw accessError;
  if (!accessRows?.length) return { buyerOrgIds: [], supplierOrgIds: [] };

  // ── Step 3: Resolve link ids → buyer + supplier org ids ──
  const linkIds = [...new Set(accessRows.map(r => r.buyer_supplier_link_id).filter(Boolean))];
  const linkMap = {};

  if (linkIds.length) {
    const { data: links } = await supabase
      .from('buyer_supplier_links')
      .select('id, buyer_org_id, supplier_org_id')
      .in('id', linkIds);

    (links || []).forEach(l => {
      linkMap[l.id] = { buyer_org_id: l.buyer_org_id, supplier_org_id: l.supplier_org_id };
    });
  }

  // ── Step 4: Collect buyer org ids + supplier org ids ──
  const buyerOrgIds    = new Set();
  const supplierOrgIds = new Set();

  accessRows.forEach(r => {
    if (r.buyer_supplier_link_id) {
      const link = linkMap[r.buyer_supplier_link_id];
      if (!link) return;
      if (link.buyer_org_id)    buyerOrgIds.add(link.buyer_org_id);
      if (link.supplier_org_id) supplierOrgIds.add(link.supplier_org_id);
    } else {
      // Fallback — treat organization_id as buyer org
      if (r.organization_id) buyerOrgIds.add(r.organization_id);
    }
  });

  return {
    buyerOrgIds:    [...buyerOrgIds],
    supplierOrgIds: [...supplierOrgIds],
  };
}

/**
 * GET /inspection-schedule/items?shopifyCustomerId=<id>
 *
 * Returns aggregated summary rows from inspection_po_style_summary view.
 * One row per (customer_po_no, style) with totals, AQL check, still_in_factory flag.
 */
router.get('/items', async (req, res) => {
  try {
    const { shopifyCustomerId } = req.query;
    if (!shopifyCustomerId) {
      return res.status(400).json({ error: 'Missing required query param: shopifyCustomerId' });
    }

    const { buyerOrgIds, supplierOrgIds } = await getOrgIds(shopifyCustomerId);
    if (!buyerOrgIds.length) return res.status(200).json({ data: [] });

    // Resolve supplier org ids → vendor display names
    let vendorNames = [];
    if (supplierOrgIds.length) {
      const { data: supplierOrgs } = await supabase
        .from('organizations')
        .select('display_name')
        .eq('type', 'supplier')
        .in('id', supplierOrgIds);

      vendorNames = (supplierOrgs || []).map(o => o.display_name);
    }

    let query = supabase
      .from('inspection_po_style_summary')
      .select('*')
      .in('organization_id', buyerOrgIds)
      .order('latest_inspection_date', { ascending: false });

    // If supplier orgs resolved → filter by vendor name too
    if (vendorNames.length) {
      query = query.in('vendor', vendorNames);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({ data });
  } catch (err) {
    console.error('❌ /items error:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.get('/batches', async (req, res) => {
  try {
    const { shopifyCustomerId } = req.query;
    if (!shopifyCustomerId) {
      return res.status(400).json({ error: 'Missing required query param: shopifyCustomerId' });
    }

    const { buyerOrgIds, supplierOrgIds } = await getOrgIds(shopifyCustomerId);
    if (!buyerOrgIds.length) return res.status(200).json({ data: [] });

    let vendorNames = [];
    if (supplierOrgIds.length) {
      const { data: supplierOrgs } = await supabase
        .from('organizations')
        .select('display_name')
        .eq('type', 'supplier')
        .in('id', supplierOrgIds);

      vendorNames = (supplierOrgs || []).map(o => o.display_name);
    }

    let query = supabase
      .from('inspection_open_items')
      .select('customer_po_no, style, inspection_date, target_date, items_inspected, items_accepted, to_inspect_items, inspection_status, inspector, activity')
      .in('organization_id', buyerOrgIds)
      .order('inspection_date', { ascending: true });

    if (vendorNames.length) {
      query = query.in('vendor', vendorNames);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({ data });
  } catch (err) {
    console.error('❌ /batches error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Never included in an inspection notification's recipient list (or its
// preview dialog) regardless of which source would otherwise resolve them -
// currently just the one admin account the user asked to leave out of these
// specifically.
const EXCLUDED_RECIPIENT_EMAILS = new Set(['sk@twif.io']);

// Shared by /notify, /notify/preview, /report-submitted and
// /report-submitted/preview below - "everyone with org access to this PO"
// (direct buyer_supplier_link_id match, falling back to the buyer org
// generally, mirroring databaseWebhooks.js's qa-inspection-comment handler)
// plus every admin/owner org-member platform-wide (mirrors
// purchaseOrders.js's PO_REVISION email, widened to include 'owner').
// `seedRecipients` carries whatever source-specific recipients (scheduler,
// assigned QA) the caller already resolved - this only appends to it.
async function appendPoContactsAndAdmins(recipients, buyerSupplierLinkId, buyerOrgId) {
  const { data: directAccess } = await supabase
    .from('member_organization_access')
    .select('member_id')
    .eq('buyer_supplier_link_id', buyerSupplierLinkId);

  let fallbackAccess = [];
  if (buyerOrgId) {
    const { data } = await supabase
      .from('member_organization_access')
      .select('member_id')
      .eq('organization_id', buyerOrgId)
      .is('buyer_supplier_link_id', null);
    fallbackAccess = data || [];
  }

  const poContactIds = [...new Set([
    ...(directAccess || []).map(r => r.member_id),
    ...fallbackAccess.map(r => r.member_id),
  ])].filter(Boolean);

  if (poContactIds.length) {
    const { data: poContacts } = await supabase
      .from('organization_members')
      .select('full_name, email')
      .in('id', poContactIds);
    for (const m of poContacts || []) if (m.email) recipients.push({ email: m.email, name: m.full_name });
  }

  // Admins/owners outside QA (tech, merchandising, etc.) have nothing to do
  // with inspections - narrowed to department = 'qa' so this stops pulling
  // in every admin/owner platform-wide regardless of what they actually
  // work on.
  const { data: admins } = await supabase
    .from('organization_members')
    .select('full_name, email')
    .in('role', ['admin', 'owner'])
    .eq('department', 'qa');
  for (const m of admins || []) if (m.email) recipients.push({ email: m.email, name: m.full_name });

  const seen = new Set();
  return recipients.filter(r => r.email && !EXCLUDED_RECIPIENT_EMAILS.has(r.email.toLowerCase()) && !seen.has(r.email) && seen.add(r.email));
}

// selectedEmails (from the frontend's recipient-confirmation dialog) is a
// flat array of email strings - some are resolved candidates the user left
// checked, others can be ad-hoc addresses typed into the dialog that were
// never in `uniqueRecipients` at all. Map each back to its resolved
// {email, name} when known, or synthesize one (no real name available) for
// an ad-hoc address - a union, not a pure filter, so ad-hoc adds actually
// get mailed. `selectedEmails` omitted entirely (nothing sent it) keeps
// today's behaviour: mail everyone resolved, unchanged.
function applySelectedEmails(uniqueRecipients, selectedEmails) {
  if (!selectedEmails) return uniqueRecipients;
  return selectedEmails
    .map(email => uniqueRecipients.find(r => r.email.toLowerCase() === String(email).toLowerCase()) || { email, name: email })
    .filter(r => r.email);
}

// Resolves everything /notify and /notify/preview both need from a
// scheduleId - the actual sendAlertEmail call is left to /notify itself so
// the preview route can stop right after recipient resolution.
async function resolveScheduleContext(scheduleId, scheduledByEmail, scheduledByName) {
  const { data: entry, error: entryErr } = await supabase
    .from('inspection_schedules')
    .select(`
      id, inspection_type, scheduled_date, line_items,
      organization_members!assigned_qa_id ( full_name, email ),
      purchase_orders (
        po_number, buyer_supplier_link_id,
        buyer_supplier_links (
          buyer_org_id,
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey ( display_name ),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey ( display_name )
        ),
        po_line_items ( id, buyer_sku_ref, quantity_ordered )
      )
    `)
    .eq('id', scheduleId)
    .single();

  if (entryErr || !entry) return { skipped: 'entry_not_found' };

  const po = entry.purchase_orders;
  const qa = entry.organization_members;

  // SKU list - scoped to line_items when the entry was narrowed to specific
  // SKUs (each carrying its own quantity override), otherwise every line
  // item on the PO at its full ordered quantity.
  const scopedIds = entry.line_items?.length ? entry.line_items.map(x => x.id) : null;
  const skuRows = (po?.po_line_items || []).filter(li => !scopedIds || scopedIds.includes(li.id));
  const skuList = skuRows
    .map(li => {
      const qty = entry.line_items?.find(x => x.id === li.id)?.quantity ?? li.quantity_ordered;
      return `${li.buyer_sku_ref} (Qty: ${qty})`;
    })
    .join(', ');

  const recipients = [];
  if (scheduledByEmail) recipients.push({ email: scheduledByEmail, name: scheduledByName || 'User' });
  if (qa?.email) recipients.push({ email: qa.email, name: qa.full_name });

  const uniqueRecipients = await appendPoContactsAndAdmins(recipients, po?.buyer_supplier_link_id, po?.buyer_supplier_links?.buyer_org_id);

  // A SKU being scheduled again after its Final was rejected is worth
  // calling out explicitly in the same email, rather than a separate one -
  // same recipients already care about this PO either way.
  let rejectedSkusText = null;
  let reassignedOn = null;
  if (skuRows.length) {
    const { data: rejectedReports } = await supabase
      .from('inspection_reports')
      .select('po_line_item_id, submitted_at')
      .eq('inspection_type', 'final')
      .eq('status', 'submitted')
      .eq('inspection_result', 'rejected')
      .in('po_line_item_id', skuRows.map(li => li.id));

    if (rejectedReports?.length) {
      const skuByLineItemId = Object.fromEntries(skuRows.map(li => [li.id, li.buyer_sku_ref]));
      rejectedSkusText = rejectedReports
        .map(r => `${skuByLineItemId[r.po_line_item_id] || r.po_line_item_id} (rejected ${new Date(r.submitted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })})`)
        .join(', ');
      reassignedOn = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }
  }

  return { entry, po, qa, skuList, uniqueRecipients, rejectedSkusText, reassignedOn };
}

// Preview-only: returns the recipient list a /notify call for this schedule
// would resolve, without sending anything - powers the frontend's
// recipient-confirmation dialog.
router.post('/notify/preview', async (req, res) => {
  try {
    const { scheduleId, scheduledByEmail, scheduledByName } = req.body;
    if (!scheduleId) return res.status(400).json({ error: 'Missing scheduleId' });
    const ctx = await resolveScheduleContext(scheduleId, scheduledByEmail, scheduledByName);
    if (ctx.skipped) return res.status(200).json(ctx);
    return res.status(200).json({ recipients: ctx.uniqueRecipients });
  } catch (err) {
    console.error('❌ /inspection-schedule/notify/preview error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Fired by InspectionScheduleForm.jsx right after a NEW inspection_schedules
// row is created (not on edits) - notifies the scheduler, the assigned QA,
// everyone with org access to the PO, and admins/owners.
router.post('/notify', async (req, res) => {
  try {
    const { scheduleId, scheduledByEmail, scheduledByName, selectedEmails } = req.body;
    if (!scheduleId) return res.status(400).json({ error: 'Missing scheduleId' });

    const ctx = await resolveScheduleContext(scheduleId, scheduledByEmail, scheduledByName);
    if (ctx.skipped) {
      console.warn('[inspection-schedule notify] entry not found:', scheduleId);
      return res.status(200).json(ctx);
    }
    const { entry, po, qa, skuList, rejectedSkusText, reassignedOn } = ctx;
    const finalRecipients = applySelectedEmails(ctx.uniqueRecipients, selectedEmails);

    if (!finalRecipients.length) {
      return res.status(200).json({ skipped: 'no_recipients' });
    }

    sendAlertEmail(
      finalRecipients,
      `Inspection scheduled for PO ${po?.po_number || ''}`,
      {
        po_number: po?.po_number,
        buyer_name: po?.buyer_supplier_links?.buyer?.display_name,
        supplier_name: po?.buyer_supplier_links?.supplier?.display_name,
        sku_list: skuList,
        inspection_date: entry.scheduled_date,
        stage: entry.inspection_type,
        assigned_qa: qa?.full_name,
        scheduled_by: scheduledByName,
        rejected_skus: rejectedSkusText,
        reassigned_date: reassignedOn,
      },
      'INSPECTION_SCHEDULED'
    )
      .then(r => console.log('📧 Inspection scheduled email result:', r))
      .catch(err => console.error('❌ Inspection scheduled email failed:', err));

    return res.status(200).json({ success: true, recipients: finalRecipients.length });
  } catch (err) {
    console.error('❌ /inspection-schedule/notify error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// role/department are independent attributes on organization_members - a
// PO's creator, its assigned QA, or a merchandising contact can each
// individually happen to also hold an admin/owner role (e.g. Ritiika Jain,
// Faisal Hanif, Nitin Jain are all role='admin' AND department=
// 'merchandising'). Excluding admins/owners from `visible` below has to be
// checked at every source, not just skipped by leaving out a separate "all
// admins" rule - that rule being gone doesn't stop an admin from qualifying
// some other way.
const isAdminOrOwner = (m) => m?.role === 'admin' || m?.role === 'owner';

const dedupeRecipients = (list) => {
  const seen = new Set();
  return list.filter(r => r.email && !EXCLUDED_RECIPIENT_EMAILS.has(r.email.toLowerCase()) && !seen.has(r.email.toLowerCase()) && seen.add(r.email.toLowerCase()));
};

// Everything the report-submitted recipient dialog resolves for a PO -
// whoever created it, every distinct QA ever assigned to inspect any stage
// of it, every merchandising-department member concerned with it (granted
// access to its buyer via member_organization_access - direct link match,
// falling back to the buyer org generally), and every logistics-department
// member unconditionally (see below - unlike merchandising, not scoped to
// this PO's buyer at all). Admins/owners are excluded from every source.
// This is a manual-send button - the email only ever goes to whoever's
// actually left checked (or added ad-hoc) here, nothing sent silently on
// top of that.
async function resolvePoRecipients(poId) {
  const visible = [];

  let vendorOrgId = null;
  let vendorName = null;
  let poBuyerOrgId = null;
  let buyerName = null;

  if (poId) {
    const { data: po } = await supabase
      .from('purchase_orders')
      .select(`
        created_by_member_id, buyer_supplier_link_id,
        buyer_supplier_links (
          buyer_org_id, supplier_org_id,
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey ( display_name ),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey ( display_name )
        )
      `)
      .eq('id', poId)
      .single();
    if (po?.created_by_member_id) {
      const { data: owner } = await supabase
        .from('organization_members')
        .select('full_name, email, department, role')
        .eq('id', po.created_by_member_id)
        .single();
      if (owner?.email && !isAdminOrOwner(owner)) visible.push({ email: owner.email, name: owner.full_name, department: owner.department });
    }

    const { data: schedules } = await supabase
      .from('inspection_schedules')
      .select('organization_members!assigned_qa_id ( full_name, email, department, role )')
      .eq('po_id', poId);
    for (const s of schedules || []) {
      const qa = s.organization_members;
      if (qa?.email && !isAdminOrOwner(qa)) visible.push({ email: qa.email, name: qa.full_name, department: qa.department });
    }

    const buyerSupplierLinkId = po?.buyer_supplier_link_id;
    poBuyerOrgId = po?.buyer_supplier_links?.buyer_org_id || null;
    buyerName = po?.buyer_supplier_links?.buyer?.display_name || null;
    const { data: directAccess } = await supabase
      .from('member_organization_access')
      .select('member_id')
      .eq('buyer_supplier_link_id', buyerSupplierLinkId);
    let fallbackAccess = [];
    if (poBuyerOrgId) {
      const { data } = await supabase
        .from('member_organization_access')
        .select('member_id')
        .eq('organization_id', poBuyerOrgId)
        .is('buyer_supplier_link_id', null);
      fallbackAccess = data || [];
    }
    const poContactIds = [...new Set([
      ...(directAccess || []).map(r => r.member_id),
      ...fallbackAccess.map(r => r.member_id),
    ])].filter(Boolean);
    if (poContactIds.length) {
      // "Concerned merchants" means merchandising specifically - the
      // broader access-grant list otherwise pulls in ERP/finance/tech/
      // logistics staff who happen to have a blanket grant but have
      // nothing to do with this PO's day-to-day handling.
      const { data: poContacts } = await supabase
        .from('organization_members')
        .select('full_name, email, department, role')
        .in('id', poContactIds)
        .eq('department', 'merchandising');
      for (const m of poContacts || []) if (m.email && !isAdminOrOwner(m)) visible.push({ email: m.email, name: m.full_name, department: m.department });
    }

    vendorOrgId = po?.buyer_supplier_links?.supplier_org_id || null;
    vendorName = po?.buyer_supplier_links?.supplier?.display_name || null;

    // Saved vendor contacts (see vendor_contacts table / the "Add vendor
    // contact" section in the dialog) - once someone adds one for this
    // vendor, it shows up pre-checked here on every future PO tied to the
    // same vendor, same as the sources above.
    if (vendorOrgId) {
      const { data: vendorContacts } = await supabase
        .from('vendor_contacts')
        .select('name, email')
        .eq('organization_id', vendorOrgId);
      for (const c of vendorContacts || []) if (c.email) visible.push({ email: c.email, name: c.name || c.email, department: 'vendor' });
    }

    // "Other" contacts saved for this exact Customer + Vendor pair (see
    // buyer_supplier_link_contacts) - pre-checked on every PO for that pair.
    // Best-effort: a missing table (migration not applied yet) just adds nobody.
    if (buyerSupplierLinkId) {
      try {
        let { data: linkContacts, error: linkErr } = await supabase
          .from('buyer_supplier_link_contacts')
          .select('name, email, kind')
          .eq('buyer_supplier_link_id', buyerSupplierLinkId);
        if (linkErr) {
          // `kind` column not there yet: read without it (all treated as 'other').
          ({ data: linkContacts, error: linkErr } = await supabase
            .from('buyer_supplier_link_contacts')
            .select('name, email')
            .eq('buyer_supplier_link_id', buyerSupplierLinkId));
        }
        if (!linkErr) for (const c of linkContacts || []) if (c.email) visible.push({ email: c.email, name: c.name || c.email, department: c.kind || 'other' });
      } catch { /* ignore */ }
    }

    // Saved buyer contacts (see buyer_contacts table / the "Add Contact"
    // section in the dialog) - the buyer-side counterpart to vendor
    // contacts above: once added for this PO's buyer, shows up pre-checked
    // on every future PO tied to the same buyer.
    if (poBuyerOrgId) {
      const { data: buyerContacts } = await supabase
        .from('buyer_contacts')
        .select('name, email')
        .eq('organization_id', poBuyerOrgId);
      for (const c of buyerContacts || []) if (c.email) visible.push({ email: c.email, name: c.name || c.email, department: 'buyer' });
    }
  }

  // Logistics department - unlike merchandising above, these show up on
  // every single PO by default, unconditionally, regardless of any
  // member_organization_access grant to this PO's specific buyer. Still
  // shown as checkboxes (not silently sent like the old blanket-admin rule
  // was) so they stay reviewable/trimmable per send.
  const { data: logisticsMembers } = await supabase
    .from('organization_members')
    .select('full_name, email, department, role')
    .eq('department', 'logistics');
  for (const m of logisticsMembers || []) if (m.email && !isAdminOrOwner(m)) visible.push({ email: m.email, name: m.full_name, department: m.department });

  return { visible: dedupeRecipients(visible), vendorOrgId, vendorName, buyerOrgId: poBuyerOrgId, buyerName };
}

// Resolves everything /report-submitted and /report-submitted/preview both
// need from a reportId.
async function resolveReportContext(reportId) {
  const { data: report, error: reportErr } = await supabase
    .from('inspection_reports')
    .select(`
      id, inspection_type, inspection_result, fulfilled_schedule_id,
      po_line_items (
        buyer_sku_ref,
        purchase_orders (
          id, po_number, buyer_supplier_link_id,
          buyer_supplier_links (
            buyer_org_id,
            buyer:organizations!buyer_supplier_links_buyer_org_id_fkey ( display_name ),
            supplier:organizations!buyer_supplier_links_supplier_org_id_fkey ( display_name )
          )
        )
      )
    `)
    .eq('id', reportId)
    .single();

  if (reportErr || !report) return { skipped: 'report_not_found' };

  const li = report.po_line_items;
  const po = li?.purchase_orders;

  const { visible, vendorOrgId, vendorName, buyerOrgId, buyerName } = await resolvePoRecipients(po?.id);
  return { report, po, li, visible, vendorOrgId, vendorName, buyerOrgId, buyerName };
}

// Preview-only: returns the recipient list a /report-submitted call for
// this report would resolve, without sending anything - powers the
// frontend's recipient-confirmation dialog.
router.post('/report-submitted/preview', async (req, res) => {
  try {
    const { reportId } = req.body;
    if (!reportId) return res.status(400).json({ error: 'Missing reportId' });
    const ctx = await resolveReportContext(reportId);
    if (ctx.skipped) return res.status(200).json(ctx);
    return res.status(200).json({
      recipients: ctx.visible,
      vendor: ctx.vendorOrgId ? { organizationId: ctx.vendorOrgId, name: ctx.vendorName } : null,
      buyer: ctx.buyerOrgId ? { organizationId: ctx.buyerOrgId, name: ctx.buyerName } : null,
    });
  } catch (err) {
    console.error('❌ /inspection-schedule/report-submitted/preview error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Saves a vendor contact (name + email) so it shows up pre-checked on every
// future PO tied to the same vendor, instead of being re-typed each time -
// fired by SendRecipientsModal.jsx's "Add vendor contact" section. Resolves
// the target vendor org the same way resolveReportContext/resolvePoRecipients
// do, from the same reportId already driving the rest of this dialog.
// Saves a Send Mail contact for a Customer + Vendor pair. Written to tolerate the `kind`
// column not existing yet (migration 20260921_add_kind_to_link_contacts.sql not applied):
// it retries without `kind`, so saving keeps working either way.
async function upsertLinkContact(row) {
  const attempt = (r) => supabase
    .from('buyer_supplier_link_contacts')
    .upsert(r, { onConflict: 'buyer_supplier_link_id,email' })
    .select('id, name, email')
    .single();
  let res = await attempt(row);
  if (res.error && /kind/i.test(res.error.message || '')) {
    const { kind: _k, ...withoutKind } = row;
    res = await attempt(withoutKind);
  }
  return res;
}

router.post('/report-submitted/vendor-contact', async (req, res) => {
  try {
    const { reportId, name, email, createdBy } = req.body;
    if (!reportId) return res.status(400).json({ error: 'Missing reportId' });
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const ctx = await resolveReportContext(reportId);
    if (ctx.skipped) return res.status(200).json(ctx);
    if (!ctx.vendorOrgId) return res.status(200).json({ skipped: 'no_vendor' });
    // Saved for this exact Customer + Vendor pair (buyer_supplier_link), not for the vendor
    // across every buyer: it comes back pre-checked on that pair's future POs only.
    const linkId = ctx.po?.buyer_supplier_link_id;
    if (!linkId) return res.status(200).json({ skipped: 'no_link' });

    const { data: saved, error } = await upsertLinkContact(
      { buyer_supplier_link_id: linkId, kind: 'vendor', name: name || null, email: String(email).trim().toLowerCase(), created_by: createdBy || null }
    );

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ contact: saved });
  } catch (err) {
    console.error('❌ /inspection-schedule/report-submitted/vendor-contact error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// "Other" contact: saved for the PO's Customer + Vendor combination
// (buyer_supplier_link), so it is pre-checked on every future PO for that same
// pair - and only that pair.
router.post('/report-submitted/link-contact', async (req, res) => {
  try {
    const { reportId, name, email, createdBy } = req.body;
    if (!reportId) return res.status(400).json({ error: 'Missing reportId' });
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) return res.status(400).json({ error: 'Missing email' });

    const ctx = await resolveReportContext(reportId);
    if (ctx.skipped) return res.status(200).json(ctx);
    const linkId = ctx.po?.buyer_supplier_link_id;
    if (!linkId) return res.status(200).json({ skipped: 'no_link' });

    const { data: saved, error } = await upsertLinkContact(
      { buyer_supplier_link_id: linkId, kind: 'other', name: name || null, email: cleanEmail, created_by: createdBy || null }
    );

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ contact: saved });
  } catch (err) {
    console.error('❌ /inspection-schedule/report-submitted/link-contact error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Buyer-side counterpart to /report-submitted/vendor-contact above - same
// shape, targets buyer_contacts/the PO's buyer org instead of the vendor.
router.post('/report-submitted/buyer-contact', async (req, res) => {
  try {
    const { reportId, name, email, createdBy } = req.body;
    if (!reportId) return res.status(400).json({ error: 'Missing reportId' });
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const ctx = await resolveReportContext(reportId);
    if (ctx.skipped) return res.status(200).json(ctx);
    if (!ctx.buyerOrgId) return res.status(200).json({ skipped: 'no_buyer' });
    // Saved for this exact Customer + Vendor pair (see the vendor-contact route above).
    const linkId = ctx.po?.buyer_supplier_link_id;
    if (!linkId) return res.status(200).json({ skipped: 'no_link' });

    const { data: saved, error } = await upsertLinkContact(
      { buyer_supplier_link_id: linkId, kind: 'buyer', name: name || null, email: String(email).trim().toLowerCase(), created_by: createdBy || null }
    );

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ contact: saved });
  } catch (err) {
    console.error('❌ /inspection-schedule/report-submitted/buyer-contact error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Display labels for the email body only - the frontend's own RESULT_LABEL
// (stageStatus.jsx) isn't shared across repos, so this is a small,
// intentionally duplicated subset just for what a submitted report's result
// can actually be.
const EMAIL_RESULT_LABEL = {
  accepted: 'Accepted',
  partially_accepted: 'Partially Accepted',
  accepted_with_deviations: 'Accepted with deviations',
  rejected: 'Rejected',
  plan_aborted: 'Plan Aborted',
  on_hold: 'On Hold',
};

// Fired by InspectionReportEntry.jsx's manual "Send Mail" button - the only
// place an inspection notification email fires from anymore (wizard Submit
// and bulk Accept no longer send one automatically). Accepts either a
// single `reportId` or a `reportIds` array - Send Mail always sends the
// array, one email covering the whole checked batch (not one per SKU),
// since every SKU in a batch is already required to share the same PO and
// stage. `reportId` alone is still accepted for backward compatibility, in
// case anything else ever calls this with just one.
router.post('/report-submitted', async (req, res) => {
  try {
    const { reportId, reportIds, submittedByName, pdfStoragePath, pdfDownloadUrl, pdfTooLargeToAttach, pdfIsZip, selectedEmails } = req.body;
    const ids = reportIds?.length ? reportIds : (reportId ? [reportId] : []);
    if (!ids.length) return res.status(400).json({ error: 'Missing reportId(s)' });

    const ctx = await resolveReportContext(ids[0]);
    if (ctx.skipped) {
      console.warn('[inspection-schedule report-submitted] report not found:', ids[0]);
      return res.status(200).json(ctx);
    }
    const { po } = ctx;
    // Manual-send button - only whoever's actually left checked (or added
    // ad-hoc) in the dialog receives this. Nothing sent on top of that.
    const finalRecipients = applySelectedEmails(ctx.visible, selectedEmails);

    if (!finalRecipients.length) {
      return res.status(200).json({ skipped: 'no_recipients' });
    }

    // Every SKU/result in this batch, for the email body. Stage is uniform
    // across the batch (Send Mail's own stage picker already requires every
    // checked SKU to need the same one), but result can still differ SKU to
    // SKU (e.g. one accepted, one rejected within the same batch) - each
    // gets its own line rather than collapsing to one shared verdict.
    const { data: batchReports } = await supabase
      .from('inspection_reports')
      .select('id, inspection_type, inspection_result, accepted_quantity, available_quantity, submitted_at, po_line_items(buyer_sku_ref)')
      .in('id', ids);
    const rows = batchReports || [];
    const rejected = rows.some(r => r.inspection_result === 'rejected');
    const stage = rows[0]?.inspection_type;
    // When the batch was submitted: the latest submitted_at among its reports
    // (a batch is submitted report by report, a few minutes apart), shown in
    // India time since that is where the team reads it.
    const latestSubmittedMs = rows.reduce((m, r) => {
      const t = r.submitted_at ? new Date(r.submitted_at).getTime() : NaN;
      return Number.isNaN(t) ? m : Math.max(m, t);
    }, 0);
    const submittedAtText = latestSubmittedMs
      ? `${new Date(latestSubmittedMs).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} IST`
      : null;
    // Accepted Qty is the number that actually matters once a verdict's in
    // (what's really going out the door) - falls back to Available Qty for
    // a report with no accepted_quantity recorded (e.g. a workflow state
    // like Plan Aborted/On Hold, which never fills that field in), so a SKU
    // still shows SOME real quantity instead of a blank. One line per SKU:
    // "SKU (Qty) - (Result)".
    const skuList = rows
      .map(r => `${r.po_line_items?.buyer_sku_ref || r.id} (${r.accepted_quantity ?? r.available_quantity ?? '-'}) - (${EMAIL_RESULT_LABEL[r.inspection_result] || r.inspection_result || 'Submitted'})`)
      .join(', ');
    // Subject-line summary of the batch's result(s) - a single shared
    // result across every SKU reads as just that label ("Accepted"); a
    // mixed batch reads as each distinct result with its own count
    // ("Accepted 5 Rejected 2"), in the order that result first appears
    // among the SKUs - previously collapsed any mixed batch to a generic
    // "Submitted", which lost exactly the "some of these failed" signal a
    // subject-line scan most needs.
    const resultCounts = new Map();
    for (const r of rows) {
      if (!r.inspection_result) continue;
      resultCounts.set(r.inspection_result, (resultCounts.get(r.inspection_result) || 0) + 1);
    }
    const overallStatus = resultCounts.size === 0
      ? 'Submitted'
      : resultCounts.size === 1
        ? (EMAIL_RESULT_LABEL[[...resultCounts.keys()][0]] || [...resultCounts.keys()][0])
        : [...resultCounts.entries()].map(([r, n]) => `${EMAIL_RESULT_LABEL[r] || r} ${n}`).join(' ');

    // Combined-document reference number (TWFCMB..., see
    // supabase/migrations/20260917_create_inspection_report_batches.sql) for
    // this exact set of report ids, if one was ever allocated - the PDF this
    // email attaches was built via the same 'final'-mode generator that
    // allocates one (getOrCreateBatchReportNo, service/inspectionReportPdf.js),
    // keyed off the identical sha256(sorted ids) hash, so a lookup here finds
    // it without regenerating anything. A single-report send never gets one
    // (batch numbers are for combined/multi-report documents only - see that
    // function's own `single` check) - batchNo stays null in that case, and
    // the subject line's own [TWFCMB..] suffix is simply omitted.
    let batchNo = null;
    if (ids.length > 1) {
      const key = crypto.createHash('sha256').update([...ids].sort().join(',')).digest('hex');
      const { data: batchRow } = await supabase.from('inspection_report_batches').select('batch_no').eq('report_ids_key', key).maybeSingle();
      batchNo = batchRow?.batch_no ?? null;
    }

    // Bucket name matches the frontend/src/lib/inspectionStorage.js's
    // BUCKET constant - the two repos can't share a config value directly.
    // One combined PDF for the whole batch (built by the frontend from
    // every selected report), not one per SKU. `pdfTooLargeToAttach` comes
    // straight from the frontend's own size check against the built PDF
    // (full-resolution photos can push a multi-SKU batch well past what an
    // email provider will attach) - skipped here entirely rather than
    // letting resolveEmailAttachment's own size guard silently drop it
    // after a wasted download; `pdf_download_url` below is the fallback so
    // the recipient still has a way to get the report.
    // pdfIsZip - the frontend split a too-large-for-one-PDF selection into
    // several part-PDFs zipped into one file (see the frontend's
    // exportSplitInspectionReportPdfs) - the filename here has to match
    // what's actually stored at pdfStoragePath, not just always ".pdf".
    const attachment = pdfStoragePath && !pdfTooLargeToAttach
      ? {
          bucket: 'inspection-reports',
          path: pdfStoragePath,
          filename: `Inspection Report - PO ${po?.po_number || ''}.${pdfIsZip ? 'zip' : 'pdf'}`,
        }
      : null;

    sendAlertEmail(
      finalRecipients,
      rejected
        ? `Inspection results for PO ${po?.po_number || ''} (includes a rejection)`
        : `Inspection submitted for PO ${po?.po_number || ''}`,
      {
        po_number: po?.po_number,
        buyer_name: po?.buyer_supplier_links?.buyer?.display_name,
        supplier_name: po?.buyer_supplier_links?.supplier?.display_name,
        sku_list: skuList,
        stage,
        overall_status: overallStatus,
        submitted_by: submittedByName,
        submitted_at: submittedAtText,
        pdf_download_url: pdfTooLargeToAttach ? pdfDownloadUrl : null,
        batch_no: batchNo,
      },
      'INSPECTION_SUBMITTED',
      attachment,
      // combinedTo: everyone selected in the Send Mail dialog goes into
      // ONE email's To together, so a Reply-All reaches the whole group
      // at once - deliberate, confirmed choice for this notification type
      // (see sendAlertEmail's own combinedTo doc for what this opts out of).
      { combinedTo: true }
    )
      .then(r => console.log('📧 Inspection submitted email result:', r))
      .catch(err => console.error('❌ Inspection submitted email failed:', err));

    return res.status(200).json({ success: true, recipients: finalRecipients.length, skus: ids.length });
  } catch (err) {
    console.error('❌ /inspection-schedule/report-submitted error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Resolves everything /callout-notify and /callout-notify/preview both need
// from a calloutId (a po_comments row). Unlike a report, a callout has no
// inspection_reports row/wizard of its own - PPM/Pilot Run are schedule-only
// stages - so recipients are resolved straight off the PO via
// resolvePoRecipients (already generic, keyed only on poId), the same
// function /report-submitted's own resolveReportContext calls internally.
async function resolveCalloutContext(calloutId) {
  const { data: callout, error: calloutErr } = await supabase
    .from('po_comments')
    .select(`
      id, po_id, line_item_id, comment_type, comment, created_by,
      po_line_items ( buyer_sku_ref ),
      purchase_orders ( po_number )
    `)
    .eq('id', calloutId)
    .single();

  if (calloutErr || !callout) return { skipped: 'callout_not_found' };

  const { visible, vendorOrgId, vendorName, buyerOrgId, buyerName } = await resolvePoRecipients(callout.po_id);
  return { callout, visible, vendorOrgId, vendorName, buyerOrgId, buyerName };
}

// Preview-only counterpart to /callout-notify below - powers the same
// frontend recipient-confirmation dialog /report-submitted/preview does,
// just for a single callout record instead of a batch of reports.
router.post('/callout-notify/preview', async (req, res) => {
  try {
    const { calloutId } = req.body;
    if (!calloutId) return res.status(400).json({ error: 'Missing calloutId' });
    const ctx = await resolveCalloutContext(calloutId);
    if (ctx.skipped) return res.status(200).json(ctx);
    // vendor/buyer deliberately omitted (unlike /report-submitted/preview) -
    // the recipient dialog only shows "Add vendor/buyer contact" when these
    // are present, and there's no /callout-notify/vendor-contact or
    // /buyer-contact route behind that action yet, which would dead-end.
    return res.status(200).json({ recipients: ctx.visible });
  } catch (err) {
    console.error('❌ /inspection-schedule/callout-notify/preview error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Fired by CalloutModal.jsx's per-callout "Send Mail" button. Every photo
// on the callout is bundled into one zip attachment (resolveEmailAttachment
// in service/emailAttachments.js - same helper /report-submitted's PDF
// already goes through, extended to accept several storage paths instead
// of one) - it fails closed rather than blocking the send if the batch
// turns out too large for a single email (see that helper's own size cap),
// same "attachment failure must never block the email itself" rule the
// single-file case already followed.
router.post('/callout-notify', async (req, res) => {
  try {
    const { calloutId, selectedEmails } = req.body;
    if (!calloutId) return res.status(400).json({ error: 'Missing calloutId' });

    const ctx = await resolveCalloutContext(calloutId);
    if (ctx.skipped) {
      console.warn('[inspection-schedule callout-notify] callout not found:', calloutId);
      return res.status(200).json(ctx);
    }
    const { callout } = ctx;
    const finalRecipients = applySelectedEmails(ctx.visible, selectedEmails);
    if (!finalRecipients.length) return res.status(200).json({ skipped: 'no_recipients' });

    const { data: photos } = await supabase
      .from('po_comment_photos')
      .select('storage_path')
      .eq('comment_id', callout.id);
    const photoPaths = (photos || []).map(p => p.storage_path).filter(Boolean);

    const calloutTypeLabel = callout.comment_type === 'PPM_CALLOUT' ? 'PPM Callout' : 'Pilot Run Callout';

    // Bucket matches the frontend/src/lib/inspectionStorage.js's
    // BUCKET constant - CalloutModal.jsx uploads callout photos there too
    // (under a callouts/<type>/<poId> prefix), same as the report-submitted
    // PDF attachment above.
    const attachment = photoPaths.length
      ? { bucket: 'inspection-reports', paths: photoPaths, filename: `${calloutTypeLabel.replace(/\s+/g, '-')}-${callout.purchase_orders?.po_number || callout.po_id}-photos.zip` }
      : null;

    sendAlertEmail(
      finalRecipients,
      `${calloutTypeLabel} - PO ${callout.purchase_orders?.po_number || ''}`,
      {
        po_number: callout.purchase_orders?.po_number,
        buyer_name: ctx.buyerName,
        supplier_name: ctx.vendorName,
        sku_ref: callout.po_line_items?.buyer_sku_ref,
        callout_type: calloutTypeLabel,
        comment: callout.comment,
        photo_count: photoPaths.length,
        posted_by: callout.created_by,
      },
      'CALLOUT_POSTED',
      attachment,
      // combinedTo - same deliberate choice as report-submitted above:
      // everyone in one shared To so a Reply-All reaches the whole group.
      { combinedTo: true }
    )
      .then(r => console.log('📧 Callout email result:', r))
      .catch(err => console.error('❌ Callout email failed:', err));

    return res.status(200).json({ success: true, recipients: finalRecipients.length });
  } catch (err) {
    console.error('❌ /inspection-schedule/callout-notify error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Fired by the frontend right after a direct Supabase write to
// inspection_rework_requests (insert on request, the approve_inspection_rework
// RPC on approval, a plain status update on rejection) - this route only
// ever resolves recipients and creates alerts/emails, it never touches
// inspection_rework_requests itself. `action` picks who gets notified:
// 'requested' goes to every org admin/owner (see isQaReworkAdmin.js on the
// frontend - same rule, admin/owner regardless of department), 'approved'/
// 'rejected' go back to whoever originally requested it.
router.post('/rework-notify', async (req, res) => {
  try {
    const { requestId, action } = req.body;
    if (!requestId) return res.status(400).json({ error: 'Missing requestId' });
    if (!['requested', 'approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const { data: request, error: reqErr } = await supabase
      .from('inspection_rework_requests')
      .select(`
        id, items, reason, requested_by, requested_by_member_id, review_note,
        purchase_orders (
          po_number,
          buyer_supplier_links!inner ( buyer:organizations!buyer_supplier_links_buyer_org_id_fkey(display_name) )
        )
      `)
      .eq('id', requestId)
      .single();
    if (reqErr || !request) return res.status(404).json({ error: 'Rework request not found' });

    const poNumber = request.purchase_orders?.po_number || 'N/A';
    const buyerName = request.purchase_orders?.buyer_supplier_links?.buyer?.display_name || '';
    const skuCount = (request.items || []).length;
    const skuNoun = `${skuCount} SKU${skuCount === 1 ? '' : 's'}`;

    let recipients = [];
    let alertType;
    let message;
    if (action === 'requested') {
      alertType = 'INSPECTION_REWORK_REQUESTED';
      message = `${request.requested_by || 'A QA'} requested rework on ${skuNoun} - PO#${poNumber}`;
      const { data: admins } = await supabase
        .from('organization_members')
        .select('id, full_name, email')
        .in('role', ['admin', 'owner']);
      recipients = (admins || []).filter(m => m.email);
    } else {
      alertType = action === 'approved' ? 'INSPECTION_REWORK_APPROVED' : 'INSPECTION_REWORK_REJECTED';
      message = action === 'approved'
        ? `Your rework request for PO#${poNumber} was approved - ${skuNoun} reset for reinspection`
        : `Your rework request for PO#${poNumber} was rejected${request.review_note ? `: ${request.review_note}` : ''}`;
      if (request.requested_by_member_id) {
        const { data: requester } = await supabase
          .from('organization_members').select('id, full_name, email')
          .eq('id', request.requested_by_member_id).single();
        if (requester?.email) recipients = [requester];
      }
    }

    if (!recipients.length) return res.status(200).json({ skipped: 'no_recipients' });

    const payload = { po_number: poNumber, buyer_name: buyerName, reason: request.reason, sku_count: skuCount, review_note: request.review_note };
    const alertInserts = recipients.map(m => ({
      message, alert_type: alertType, po_snapshot: payload,
      recipient_user_id: m.id, recipient_name: m.full_name,
      is_read: false, email_sent: false, retry_count: 0, scheduled_for: new Date().toISOString(),
    }));

    const { data: insertedAlerts, error: alertError } = await supabase.from('alerts').insert(alertInserts).select();
    if (alertError) throw alertError;

    sendAlertEmail(recipients.map(m => ({ email: m.email, name: m.full_name })), message, payload, alertType)
      .then(async () => {
        await supabase.from('alerts').update({ email_sent: true }).in('id', insertedAlerts.map(a => a.id));
      })
      .catch(err => console.error('[rework-notify] email error:', err.message));

    return res.status(200).json({ success: true, notified: recipients.length });
  } catch (err) {
    console.error('❌ /inspection-schedule/rework-notify error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Phase 3 - the permanent home for server-side inspection-report PDF
// generation (see service/inspectionReportPdf.js), replacing what used to
// run in the browser (the frontend's own exportInspectionReportPdf.js,
// now retired) for every Preview/Download/Send Mail/Export All call site.
// Proven at real scale against PO 131759 (12 SKUs, 442 photos, 60s, zero
// crash) before being wired in here.
//
// mode: 'preview' (default) - one merged PDF, downscaled photos, no batch
// number, never split; 'final' - full quality, batch number allocated,
// split into part-PDFs zipped together only if the photo count actually
// warrants it. No auth here, matching this entire route family's existing
// (unauthenticated) posture - see the plan's own note on why this isn't a
// new gap Phase 3 introduces.
//
// Response is always {url, filename, isZip} JSON, never the raw file bytes -
// Cloud Run buffers any response that isn't chunked/streamed and hard-caps
// it at 32MiB (docs.cloud.google.com/run/quotas), which a real batch blows
// past easily (300 full-quality photos alone is ~450MB+ going by this
// session's own measured ~1.58MB average photo size) - production proved
// this live as a browser-side "Failed to fetch" once traffic stopped going
// through the local dev server this was originally verified against. So the
// built file is uploaded to Storage here instead and only its public URL
// goes back over the Cloud Run response, which stays tiny regardless of
// batch size; the frontend then fetches the real bytes from that URL
// directly, off Cloud Run entirely.
// Was reachable with no auth at all while every caller was internal
// Merchant Portal staff - a latent gap, never actually exploitable since
// nothing external ever had a UI button pointed at it. SupplierQcReports.jsx
// (the frontend) is the first EXTERNAL (vendor-org) UI to call this,
// so that gap became real: a supplier could otherwise substitute any
// poId/reportIds via devtools and pull another supplier's full report
// (defects/photos included, even though the frontend never shows them).
// requireAuth (middleware/auth.js) validates the Supabase JWT; the ownership
// check below then additionally confirms the caller's own org is actually
// entitled to poId/reportIds - a merchant-org staff member keeps today's
// unrestricted access (matches every existing internal caller, zero
// regression), a supplier-org member is confined to POs where their org is
// the linked supplier, and every requested report id must genuinely belong
// to a line item on that same PO (guards against a supplier substituting an
// unrelated report id even for a PO they do legitimately own).
router.post('/generate-pdf', express.json(), requireAuth, async (req, res) => {
  const startedAt = Date.now();
  try {
    const { reportIds, poId, mode = 'preview', createdBy = null } = req.body;
    if (!Array.isArray(reportIds) || !reportIds.length) return res.status(400).json({ error: 'Missing reportIds array' });
    if (!poId) return res.status(400).json({ error: 'Missing poId' });

    const { data: member, error: memberErr } = await supabase
      .from('organization_members')
      .select('organization_id, organizations!inner(type)')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (memberErr || !member) return res.status(403).json({ error: 'No organization membership found for this account' });
    const orgType = member.organizations?.type;
    const orgId = member.organization_id;

    const [{ data: poRow, error: poErr }, { data: reports, error: reportErr }] = await Promise.all([
      supabase
        .from('purchase_orders')
        .select(`
          id, po_number, inspection_level, ex_factory_date, exceptional_ex_factory_date,
          buyer_supplier_links (
            supplier_org_id,
            buyer:organizations!buyer_supplier_links_buyer_org_id_fkey ( display_name ),
            supplier:organizations!buyer_supplier_links_supplier_org_id_fkey ( display_name, city, address, state, zip, country, phone_no )
          ),
          po_line_items ( id, sku_id, buyer_sku_ref, sku_variant, quantity_ordered, balance_quantity, target_date )
        `)
        .eq('id', poId)
        .single(),
      supabase
        .from('inspection_reports')
        .select('*, inspection_report_defects(*), inspection_report_photos(*)')
        .in('id', reportIds),
    ]);
    if (poErr || !poRow) return res.status(404).json({ error: 'PO not found' });
    if (reportErr || !reports?.length) return res.status(404).json({ error: 'No reports found' });

    // Merchant staff keep today's unrestricted access. A supplier is
    // confined to their own linked POs; anything else (buyer org, no
    // recognized type) is denied by default rather than assumed safe.
    if (orgType === 'supplier') {
      if (poRow.buyer_supplier_links?.supplier_org_id !== orgId) {
        return res.status(403).json({ error: 'Forbidden - this PO does not belong to your organization' });
      }
      const validLineItemIds = new Set((poRow.po_line_items || []).map((li) => li.id));
      const foreignReport = reports.find((r) => !validLineItemIds.has(r.po_line_item_id));
      if (foreignReport) {
        return res.status(403).json({ error: 'Forbidden - one or more reports do not belong to this PO' });
      }
    } else if (orgType !== 'merchant') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const po = {
      ...poRow,
      buyer_name: poRow.buyer_supplier_links?.buyer?.display_name ?? null,
      supplier_name: poRow.buyer_supplier_links?.supplier?.display_name ?? null,
      supplier_city: poRow.buyer_supplier_links?.supplier?.city ?? null,
      supplier_address: poRow.buyer_supplier_links?.supplier?.address ?? null,
      supplier_state: poRow.buyer_supplier_links?.supplier?.state ?? null,
      supplier_zip: poRow.buyer_supplier_links?.supplier?.zip ?? null,
      supplier_country: poRow.buyer_supplier_links?.supplier?.country ?? null,
      supplier_phone: poRow.buyer_supplier_links?.supplier?.phone_no ?? null,
    };

    // Cache key: same SHA-256-of-sorted-ids convention as
    // inspection_report_batches (order-independent, fixed-length). Freshness
    // marker is the newest timestamp anywhere in this exact batch - every
    // report's own updated_at, and every one of their photos' created_at
    // (a report's own updated_at doesn't change just because a photo got
    // added to it). A cache hit only counts if nothing in the batch has
    // gotten newer since that row was written - see the migration's own doc
    // (supabase/migrations/20260918_create_inspection_report_exports.sql)
    // for why this table exists and what it caches.
    //
    // Every read/write here is best-effort (try/catch, never thrown) - a
    // cache miss (including the table not existing yet, before its
    // migration has been applied) must fall through to a normal fresh
    // generation, exactly like getOrCreateBatchReportNo's own established
    // "secondary feature never blocks the primary export" rule.
    const reportIdsKey = crypto.createHash('sha256').update('pdf-v2:' + [...reportIds].sort().join(',')).digest('hex'); // version prefix: retires PDFs cached before photos were put in camera order and before per-round partial status
    const sourceMaxUpdatedAt = new Date(Math.max(
      ...reports.map((r) => new Date(r.updated_at || r.created_at).getTime()),
      ...reports.flatMap((r) => (r.inspection_report_photos || []).map((p) => new Date(p.created_at).getTime())),
      0,
    )).toISOString();

    let cacheHit = null;
    try {
      const { data: cached } = await supabase
        .from('inspection_report_exports')
        .select('*')
        .eq('report_ids_key', reportIdsKey)
        .eq('mode', mode)
        .maybeSingle();
      if (cached && new Date(cached.source_max_updated_at).getTime() >= new Date(sourceMaxUpdatedAt).getTime()) cacheHit = cached;
    } catch { /* table may not exist yet, or a transient read error - fall through to a fresh build */ }

    if (cacheHit) {
      const elapsedMs = Date.now() - startedAt;
      console.log(`[generate-pdf] mode=${mode}: cache hit for ${reports.length} reports in ${elapsedMs}ms`);
      return res.json({
        url: cacheHit.url, path: cacheHit.path, size: cacheHit.size, filename: cacheHit.filename,
        isZip: cacheHit.is_zip, partCount: cacheHit.part_count, elapsedMs, cached: true,
      });
    }

    const skuIds = [...new Set(reports.map((r) => po.po_line_items?.find((li) => li.id === r.po_line_item_id)?.sku_id).filter(Boolean))];
    const { data: skus } = skuIds.length
      ? await supabase.from('skus').select('*, categories(name, level_name, parent_id)').in('id', skuIds)
      : { data: [] };
    const skuMasterById = {};
    (skus || []).forEach((s) => { skuMasterById[s.id] = s; });

    const { buffer, filename, isZip, partCount } = await generateInspectionReportPdf(po, reports, skuMasterById, { mode, createdBy });
    const elapsedMs = Date.now() - startedAt;
    const totalPhotos = reports.reduce((n, r) => n + (r.inspection_report_photos || []).length, 0);
    console.log(`[generate-pdf] mode=${mode}: ${reports.length} reports, ${totalPhotos} photos, ${partCount} part(s), ${buffer.length} bytes in ${elapsedMs}ms`);

    const storagePath = `exports/${poId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename}`;
    const { error: uploadErr } = await supabase.storage
      .from('inspection-reports')
      .upload(storagePath, buffer, { contentType: isZip ? 'application/zip' : 'application/pdf', upsert: true });
    if (uploadErr) throw uploadErr;
    const { data: { publicUrl } } = supabase.storage.from('inspection-reports').getPublicUrl(storagePath);

    try {
      await supabase.from('inspection_report_exports').upsert({
        report_ids_key: reportIdsKey, mode, url: publicUrl, path: storagePath, filename,
        is_zip: isZip, size: buffer.length, part_count: partCount, source_max_updated_at: sourceMaxUpdatedAt,
      }, { onConflict: 'report_ids_key,mode' });
    } catch { /* best-effort - a failed cache write must never fail the export that just succeeded */ }

    res.json({ url: publicUrl, path: storagePath, size: buffer.length, filename, isZip, partCount, elapsedMs });
  } catch (err) {
    console.error('[generate-pdf] failed:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;