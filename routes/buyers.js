const axios = require("axios");
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const express = require("express");
const supabase = require('../supabaseClient')
const { SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN} = process.env;

// Month mapping (column indices in the sheet)
const MONTHS = [
  { month: "Apr 2025", countCol: 1, valueCol: 2 },
  { month: "May 2025", countCol: 3, valueCol: 4 },
  { month: "Jun 2025", countCol: 5, valueCol: 6 },
  { month: "Jul 2025", countCol: 7, valueCol: 8 },
  { month: "Aug 2025", countCol: 9, valueCol: 10 },
  { month: "Sep 2025", countCol: 11, valueCol: 12 },
  { month: "Oct 2025", countCol: 13, valueCol: 14 },
  { month: "Nov 2025", countCol: 15, valueCol: 16 },
  { month: "Dec 2025", countCol: 17, valueCol: 18 },
  { month: "Jan 2026", countCol: 19, valueCol: 20 },
  { month: "Feb 2026", countCol: 21, valueCol: 22 },
  { month: "Mar 2026", countCol: 23, valueCol: 24 },
];



const router = express.Router();

router.get("/po-count-value/all", async (req, res) => {
  try {
    const filePath = path.join(__dirname, "..", "public", "openpos.xlsx");

    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ success: false, message: `Excel file not found.` });
    }

    // Expect comma-separated buyer names: ?buyers=NKUKU,HOUSE DOCTOR
    const allowedBuyers = req.query.buyers
      ? req.query.buyers.split('||').map(b => b.trim().toUpperCase()).filter(Boolean)
      : [];

    if (!allowedBuyers.length) {
      return res.status(400).json({ success: false, message: 'No buyers specified.' });
    }

    const workbook = XLSX.read(filePath, { type: "file" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: 0 });

    const buyerBreakdown = {};

    data.slice(1).forEach(row => {
      const name = row[0]?.toString().trim();
      if (!name || name.toLowerCase() === 'total') return;
      if (!allowedBuyers.includes(name.toUpperCase())) return; // filter here

      buyerBreakdown[name] = MONTHS.map(({ month, countCol, valueCol }) => ({
        month,
        count: row[countCol] || 0,
        value: row[valueCol] || 0,
      }));
    });

    return res.json({ success: true, buyerBreakdown });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});



router.get("/customer/:customerId/open-orders", async (req, res) => {
  try {
    const { customerId } = req.params;
    const { merchant } = req.query;

    if (!customerId) {
      return res.status(401).json({ error: "Unauthorized", details: "Customer ID is required" });
    }

    // ── 1. Resolve allowed buyers (same logic as admin-volume-origin) ──────────
    let allowedBuyers = [];

    const buyersParam = req.query.buyers;
    if (buyersParam) {
      allowedBuyers = buyersParam.split("||").map((b) => b.trim().toUpperCase()).filter(Boolean);
    } else {
      const customerQuery = `
        query getCustomerBuyers($customerId: ID!) {
          customer(id: $customerId) {
            metafield(namespace: "custom", key: "buyers") { value }
          }
        }`;
      const customerResponse = await axios({
        method: "POST",
        url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
        data: { query: customerQuery, variables: { customerId: `gid://shopify/Customer/${customerId}` } },
      });
      const raw = customerResponse.data?.data?.customer?.metafield?.value;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          allowedBuyers = Array.isArray(parsed)
            ? parsed.map((b) => b.trim().toUpperCase()).filter(Boolean)
            : [raw.trim().toUpperCase()];
        } catch {
          allowedBuyers = raw.split(",").map((b) => b.trim().toUpperCase()).filter(Boolean);
        }
      }
    }

    // ── 2. Fetch the open-orders Excel from the shop metafield ────────────────
    //    Metafield key: "openordersytd"  (change if your key differs)
    const shopQuery = `
      query getShopMetafield {
        shop {
          metafield(namespace: "custom", key: "openordersytd") {
            id value type
          }
        }
      }`;
    const shopifyResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
      data: { query: shopQuery },
    });

    const metafieldData = shopifyResponse.data?.data?.shop?.metafield;
    if (!metafieldData) {
      return res.status(404).json({ error: "Open orders Excel not found", details: "No openordersytd metafield" });
    }

    let fileUrl;
    if (metafieldData.type === "file_reference") {
      const fileQuery = `
        query getFileUrl($fileId: ID!) {
          node(id: $fileId) {
            ... on GenericFile { url }
            ... on MediaImage { image { url } }
          }
        }`;
      const fileRes = await axios({
        method: "POST",
        url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
        data: { query: fileQuery, variables: { fileId: metafieldData.value } },
      });
      fileUrl = fileRes.data?.data?.node?.url || fileRes.data?.data?.node?.image?.url;
      if (!fileUrl) return res.status(404).json({ error: "File URL not found" });
    } else {
      fileUrl = metafieldData.value;
    }

    const fileResponse = await axios({ method: "GET", url: fileUrl, responseType: "arraybuffer" });

    // ── 3. Parse Excel ─────────────────────────────────────────────────────────
    const XLSX = require("xlsx");
    const workbook = XLSX.read(fileResponse.data, { type: "buffer" });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1, defval: "", blankrows: false, raw: false,
    });

    if (!jsonData.length) return res.status(404).json({ error: "Empty file" });

    // Find header row
    let headerRowIndex = 0;
    for (let i = 0; i < jsonData.length; i++) {
      if (jsonData[i]?.[0]) { headerRowIndex = i; break; }
    }

    const headers = jsonData[headerRowIndex].map((h) =>
      h?.toString().trim().replace(/\u00A0/g, " ").replace(/\s+/g, " ")
    );

    // Identify column groups: each "month" has a count col and a value col
    // Pattern: "<month> count" then "<month>"  OR just "<month>"
    // Build a list of { month, countIdx, valueIdx }
    const totalIdx = headers.findIndex((h) => h.toLowerCase() === "total");

    // We walk headers[2..totalIdx-1] and pair "X count" with "X"
    const monthPairs = []; // { month, countIdx, valueIdx }
    const seenMonths = new Set();
    for (let i = 2; i < (totalIdx !== -1 ? totalIdx : headers.length); i++) {
      const h = headers[i].toLowerCase().replace(/ count$/, "").trim();
      if (seenMonths.has(h)) continue;
      seenMonths.add(h);
      const countIdx = headers.findIndex((x, xi) => xi >= 2 && x.toLowerCase() === h + " count");
      const valueIdx = headers.findIndex((x, xi) => xi >= 2 && x.toLowerCase() === h && !x.toLowerCase().endsWith(" count"));
      if (valueIdx === -1) continue;
      monthPairs.push({ month: h, countIdx, valueIdx });
    }

    const monthColumns   = monthPairs.map((p) => p.month);   // e.g. ["jun","jul",...,"forjan26"]
    const monthsWithCount = monthPairs.map((p) => ({
      month: p.month,
      countCol: p.countIdx !== -1 ? headers[p.countIdx] : null,
      valueCol: headers[p.valueIdx],
    }));

    const cleanNumber = (val) => {
      if (val === null || val === undefined || val === "") return 0;
      if (typeof val === "number") return val;
      const cleaned = val.toString().replace(/[^0-9.\-]/g, "");
      return cleaned ? parseFloat(cleaned) : 0;
    };

    // Parse data rows
    const dataRows = jsonData.slice(headerRowIndex + 1).filter((r) => r?.[0]);

    const parsedRows = dataRows.map((row) => {
      const buyer  = row[0]?.toString().trim().replace(/\u00A0/g, "").toUpperCase() || "";
      const vendor = row[1]?.toString().trim().replace(/\u00A0/g, "") || "";
      const isTotalRow =
        buyer.endsWith(" TOTAL") ||
        buyer.includes("SUB TOTAL") ||
        buyer.replace(/\s/g, "").toUpperCase().startsWith("GRANDTOTAL") ||
        (!vendor || vendor.toLowerCase() === "sub total");

      const obj = { buyer, vendor, isTotalRow };
      monthPairs.forEach(({ month, countIdx, valueIdx }) => {
        obj[`${month}_count`] = cleanNumber(countIdx !== -1 ? row[countIdx] : 0);
        obj[month]             = cleanNumber(row[valueIdx]);
      });
      if (totalIdx !== -1) obj.total = cleanNumber(row[totalIdx]);
      return obj;
    });

    // ── 4. Admin / merchant override (same pattern as volume-origin) ───────────
    if (!buyersParam) {
      const allBuyers = [
        ...new Set(
          parsedRows
            .filter((r) => !r.isTotalRow)
            .map((r) => r.buyer.replace(/ TOTAL$/, "").trim().toUpperCase())
            .filter(Boolean)
        ),
      ];
      const isAdmin = allowedBuyers.filter((b) => !b.includes("TOTAL")).length >= allBuyers.length;

      if (isAdmin && merchant) {
        const merchantLookupQuery = `
          query findCustomerByEmail($email: String!) {
            customers(first: 1, query: $email) {
              edges { node { metafield(namespace: "custom", key: "buyers") { value } } }
            }
          }`;
        const mRes = await axios({
          method: "POST",
          url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
          data: { query: merchantLookupQuery, variables: { email: `email:${merchant}` } },
        });
        const mRaw = mRes.data?.data?.customers?.edges?.[0]?.node?.metafield?.value;
        if (mRaw) {
          try {
            const parsed = JSON.parse(mRaw);
            allowedBuyers = Array.isArray(parsed)
              ? parsed.map((b) => b.trim().toUpperCase()).filter(Boolean)
              : [mRaw.trim().toUpperCase()];
          } catch {
            allowedBuyers = mRaw.split(",").map((b) => b.trim().toUpperCase()).filter(Boolean);
          }
        } else {
          allowedBuyers = [];
        }
      }
    }

    // ── 5. Filter rows by allowed buyers ──────────────────────────────────────
    const individualRows = parsedRows.filter((r) => !r.isTotalRow);
    const filteredRows = allowedBuyers.length > 0
      ? individualRows.filter((r) => {
          const b = r.buyer.replace(/ TOTAL$/, "").trim().toUpperCase();
          return allowedBuyers.includes(b);
        })
      : individualRows;

    // ── 6. Build buyerBreakdown (same shape as /po-count-value/all) ───────────
    //   { [buyerName]: [ { month: "June 2025", count, value }, ... ] }
    //
    // Month label mapping – the Excel uses keys like "jun", "forjan26" etc.
    // We map them to human-readable labels matching what the existing table renders.
    const MONTH_LABEL_MAP = {
      jan: "January 2025", feb: "February 2025", mar: "March 2025",
      apr: "April 2025",   may: "May 2025",      jun: "June 2025",
      jul: "July 2025",    aug: "August 2025",    sep: "September 2025",
      oct: "October 2025", nov: "November 2025",  dec: "December 2025",
      forjan26: "January 2026", forfeb26: "February 2026", formar26: "March 2026",
      forapr26: "April 2026",   formay26: "May 2026",      forjun26: "June 2026",
      forjul26: "July 2026", foraug26: "August 2026", forsep26: "September 2026",
      foroct26: "October 2026", fornov26: "November 2026", fordec26: "December 2026",
      forjan27: "January 2027", forfeb27: "February 2027", formar27: "March 2027",
    };

    const buyerBreakdown = {};
    filteredRows.forEach((row) => {
      const buyerKey = row.buyer.replace(/ TOTAL$/, "").trim();
      if (!buyerBreakdown[buyerKey]) buyerBreakdown[buyerKey] = {};
      monthPairs.forEach(({ month }) => {
        const label = MONTH_LABEL_MAP[month.toLowerCase()] || month;
        if (!buyerBreakdown[buyerKey][label]) {
          buyerBreakdown[buyerKey][label] = { month: label, count: 0, value: 0 };
        }
        buyerBreakdown[buyerKey][label].count += row[`${month}_count`] || 0;
        buyerBreakdown[buyerKey][label].value += row[month] || 0;
      });
    });

    // Convert inner objects to arrays, dropping zero-count+zero-value months
    const buyerBreakdownFinal = {};
    Object.entries(buyerBreakdown).forEach(([buyer, monthMap]) => {
      buyerBreakdownFinal[buyer] = Object.values(monthMap).filter(
        (m) => m.count > 0 || m.value > 0
      );
    });

    // ── 7. Summary ─────────────────────────────────────────────────────────────
    const totalsByMonth = {};
    monthColumns.forEach((m) => {
      totalsByMonth[m] = filteredRows.reduce((sum, r) => sum + (r[m] || 0), 0);
    });
    const grandTotal = Object.values(totalsByMonth).reduce((s, v) => s + v, 0);

    // ── 8. Respond ─────────────────────────────────────────────────────────────
    res.json({
      success: true,
      data: {
        rows: filteredRows,          // individual rows with month_count + month value fields
        months: monthColumns,        // value-column keys  (e.g. ["jun","jul","forjan26"])
        monthsWithCount,             // { month, countCol, valueCol } metadata
        buyerBreakdown: buyerBreakdownFinal,  // same shape as /po-count-value/all
        summary: { totalsByMonth, grandTotal, rowCount: filteredRows.length },
      },
      customerBuyers: allowedBuyers,
    });

  } catch (err) {
    console.error("open-orders-volume error:", err.message);
    return res.status(500).json({
      error: "Failed to fetch or parse open orders file",
      details: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

router.get('/pos', async (req, res) => {
  try {
    const {
      shopifyCustomerId,
      businessName,
      page = 1,
      limit = 20,
      poNumber,
      piStatus,
      dateFrom,
      dateTo,
      supplierName,
    } = req.query

    if (!shopifyCustomerId) return res.status(400).json({ error: 'shopifyCustomerId required' })
    if (!businessName?.trim()) return res.status(400).json({ error: 'businessName required' })

    // ── Resolve buyer org ─────────────────────────────────
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('id')
      .eq('display_name', businessName.trim())
      .eq('type', 'buyer')
      .single()

    if (orgError || !org) return res.status(404).json({ error: 'Buyer org not found' })

    // ── Resolve active link ids for this buyer ────────────
    const { data: links, error: linkError } = await supabase
      .from('buyer_supplier_links')
      .select('id')
      .eq('buyer_org_id', org.id)
      .eq('relationship_status', 'active')

    if (linkError) throw linkError

    const linkIds = (links || []).map(l => l.id)
    if (!linkIds.length) return res.json({
      success: true, pos: [],
      pagination: { page: 1, limit: parseInt(limit), total: 0, totalPages: 0, hasMore: false }
    })

    // ── Supplier filter ───────────────────────────────────
    let activeLinkIds = linkIds  // start with all buyer's links

    if (supplierName?.trim()) {
      const names = supplierName.split(',').map(n => n.trim()).filter(Boolean)

      const { data: matchingOrgs } = await supabase
        .from('organizations')
        .select('id')
        .in('display_name', names)
        .eq('type', 'supplier')

      if (!matchingOrgs?.length) return res.json({
        success: true, pos: [],
        pagination: { page: 1, limit: parseInt(limit), total: 0, totalPages: 0, hasMore: false }
      })

      const { data: supplierLinks } = await supabase
        .from('buyer_supplier_links')
        .select('id')
        .in('supplier_org_id', matchingOrgs.map(o => o.id))
        .eq('relationship_status', 'active')

      // intersect — must be buyer's link AND match supplier
      const supplierLinkSet = new Set((supplierLinks || []).map(l => l.id))
      activeLinkIds = linkIds.filter(id => supplierLinkSet.has(id))

      if (!activeLinkIds.length) return res.json({
        success: true, pos: [],
        pagination: { page: 1, limit: parseInt(limit), total: 0, totalPages: 0, hasMore: false }
      })
    }

    const pageNum  = Math.max(1, parseInt(page))
    const pageSize = Math.min(50, Math.max(1, parseInt(limit)))
    const from     = (pageNum - 1) * pageSize
    const to       = from + pageSize - 1

    // ── Paged query ───────────────────────────────────────
    let query = supabase
      .from('purchase_orders')
      .select(`
        *,
        buyer_supplier_links!inner (
          buyer_org_id,
          supplier_org_id,
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
        )
      `, { count: 'exact' })
      .in('buyer_supplier_link_id', activeLinkIds)
      .is('deleted_at', null)
      .is('delete_meta', null)
      .neq('status', 'closed')
      .gte('po_received_date', '2026-01-01')
      .order('created_at', { ascending: false })
      .range(from, to)

    if (poNumber?.trim())         query = query.ilike('po_number', `%${poNumber.trim()}%`)
    if (piStatus === 'confirmed') query = query.eq('pi_confirmed', true)
    if (piStatus === 'pending')   query = query.eq('pi_confirmed', false)
    if (dateFrom)                 query = query.gte('po_received_date', dateFrom)
    if (dateTo)                   query = query.lte('po_received_date', dateTo)

    const { data: pos, error: posError, count } = await query
    if (posError) throw posError

    const normalizedPOs = (pos || []).map(po => ({
      ...po,
      buyer_name:    po.buyer_supplier_links?.buyer?.display_name    || null,
      supplier_name: po.buyer_supplier_links?.supplier?.display_name || null,
    }))

    return res.json({
      success: true,
      pos: normalizedPOs,
      pagination: {
        page:       pageNum,
        limit:      pageSize,
        total:      count || 0,
        totalPages: Math.ceil((count || 0) / pageSize),
        hasMore:    to < (count || 0) - 1
      }
    })

  } catch (err) {
    console.error('❌ Buyer POs fetch failed:', err)
    res.status(500).json({ error: err.message || 'Server Error' })
  }
})

module.exports = router;