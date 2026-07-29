const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')
const { sendAlertEmail } = require('../service/emailService')

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


module.exports = router;