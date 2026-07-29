const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')



router.get('/all-merchants', async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('get_distinct_merchants')
    if (error) throw error

    const merchants = (data || []).map(r => ({ name: r.created_by }))
    return res.json({ success: true, merchants })

  } catch (err) {
    console.error('❌ Admin merchants fetch failed:', err)
    res.status(500).json({ error: err.message })
  }
})


router.get('/all-pos', async (req, res) => {
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
      buyerName,
      merchantName,
      erpStatus,
    } = req.query

    const includeStats = req.query.includeStats === '1'

    if (!shopifyCustomerId) return res.status(400).json({ error: 'shopifyCustomerId required' })

    const pageNum  = Math.max(1, parseInt(page))
    const pageSize = Math.min(50, Math.max(1, parseInt(limit)))
    const from     = (pageNum - 1) * pageSize
    const to       = from + pageSize - 1

    /* =========================
       SUPPLIER FILTER
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
          pagination: { page: pageNum, limit: pageSize, total: 0, totalPages: 0, hasMore: false },
          stats: { confirmed_count: 0, pending_count: 0, total_amount: 0 }
        })
      }

      const { data: linksByOrg } = await supabase
        .from('buyer_supplier_links')
        .select('id')
        .in('supplier_org_id', matchingOrgs.map(o => o.id))
        .eq('relationship_status', 'active')

      supplierLinkIds = (linksByOrg || []).map(l => l.id)

      if (!supplierLinkIds.length) {
        return res.json({
          success: true, pos: [],
          pagination: { page: pageNum, limit: pageSize, total: 0, totalPages: 0, hasMore: false },
          stats: { confirmed_count: 0, pending_count: 0, total_amount: 0 }
        })
      }
    }

    /* =========================
       BUYER FILTER
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
          pagination: { page: pageNum, limit: pageSize, total: 0, totalPages: 0, hasMore: false },
          stats: { confirmed_count: 0, pending_count: 0, total_amount: 0 }
        })
      }

      const { data: linksByOrg } = await supabase
        .from('buyer_supplier_links')
        .select('id')
        .in('buyer_org_id', matchingOrgs.map(o => o.id))
        .eq('relationship_status', 'active')

      buyerLinkIds = (linksByOrg || []).map(l => l.id)

      if (!buyerLinkIds.length) {
        return res.json({
          success: true, pos: [],
          pagination: { page: pageNum, limit: pageSize, total: 0, totalPages: 0, hasMore: false },
          stats: { confirmed_count: 0, pending_count: 0, total_amount: 0 }
        })
      }
    }

    /* =========================
       PAGED QUERY
    ========================= */
    let pagedQuery = supabase
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
      .order('created_at', { ascending: false })
      .range(from, to)

    if (poNumber?.trim())         pagedQuery = pagedQuery.ilike('po_number', `%${poNumber.trim()}%`)
    if (piStatus === 'confirmed') pagedQuery = pagedQuery.eq('pi_confirmed', true)
    if (piStatus === 'pending')   pagedQuery = pagedQuery.or('pi_confirmed.is.null,pi_confirmed.eq.false')
    if (dateFrom)                 pagedQuery = pagedQuery.gte('po_received_date', dateFrom)
    if (dateTo)                   pagedQuery = pagedQuery.lte('po_received_date', dateTo)
    if (erpStatus === 'synced')   pagedQuery = pagedQuery.eq('erp_synced', true)
    if (erpStatus === 'pending')  pagedQuery = pagedQuery.eq('erp_synced', false)
    if (supplierLinkIds)          pagedQuery = pagedQuery.in('buyer_supplier_link_id', supplierLinkIds)
    if (buyerLinkIds)             pagedQuery = pagedQuery.in('buyer_supplier_link_id', buyerLinkIds)
    if (merchantName?.trim())     pagedQuery = pagedQuery.ilike('created_by', `%${merchantName.trim()}%`)

    /* =========================
       STATS RPC + PAGED QUERY
       run in parallel
    ========================= */

    const queries = [pagedQuery]
    if (includeStats) {
    queries.push( supabase.rpc('get_po_stats', {
        p_supplier_link_ids: supplierLinkIds  ?? null,
        p_buyer_link_ids:    buyerLinkIds     ?? null,
        p_po_number:         poNumber?.trim() || null,
        p_pi_status:         piStatus         || null,
        p_date_from:         dateFrom         || null,
        p_date_to:           dateTo           || null,
        p_erp_status:        erpStatus        || null,
        p_merchant_name:     merchantName?.trim() || null,
      }))
    }
    const results = await Promise.all(queries)
   const { data: pos, error: posError, count: pagedQueryCount } = results[0]
    if (posError) throw posError

    let confirmed_count = 0, pending_count = 0, total_amount = 0
    if (includeStats) {
    const { data: statsData, error: statsError } = results[1]
    if (statsError) throw statsError
    ;({ confirmed_count, pending_count, total_amount } = statsData)
    }

    const count = pagedQueryCount || 0
    /* =========================
       NORMALIZE
    ========================= */
    const normalizedPOs = (pos || []).map(po => ({
  ...po,
  buyer_name:    po.buyer_supplier_links?.buyer?.display_name    || null,
  supplier_name: po.buyer_supplier_links?.supplier?.display_name || null,
  uploaded_by:   po.on_behalf_of_member?.full_name || po.created_by || null,
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
      },
      stats: { confirmed_count, pending_count, total_amount }
    })

  } catch (err) {
    console.error('❌ Admin fetch POs failed:', err)
    res.status(500).json({ error: err.message || 'Server Error' })
  }
})

router.get('/all-suppliers', async (req, res) => {
  try {
    const { merchantName, buyerName } = req.query

    if (merchantName?.trim() || buyerName?.trim()) {
      // filtered path — existing query-based logic
      let poQuery = supabase
        .from('purchase_orders')
        .select('buyer_supplier_link_id')
        .gte('po_received_date', '2026-01-01')
        .is('deleted_at', null)
        .is('delete_meta', null)

      if (merchantName?.trim()) {
        poQuery = poQuery.ilike('created_by', `%${merchantName.trim()}%`)
      }

      if (buyerName?.trim()) {
        const { data: matchingOrgs } = await supabase
          .from('organizations')
          .select('id')
          .eq('display_name', buyerName.trim())
          .eq('type', 'buyer')

        const orgIds = (matchingOrgs || []).map(o => o.id)
        if (!orgIds.length) return res.json({ success: true, suppliers: [] })

        const { data: buyerLinks } = await supabase
          .from('buyer_supplier_links')
          .select('id')
          .in('buyer_org_id', orgIds)
          .eq('relationship_status', 'active')

        const linkIds = (buyerLinks || []).map(l => l.id)
        if (!linkIds.length) return res.json({ success: true, suppliers: [] })

        poQuery = poQuery.in('buyer_supplier_link_id', linkIds)
      }

      const { data: pos, error: posError } = await poQuery
      if (posError) throw posError

      const linkIds = [...new Set((pos || []).map(r => r.buyer_supplier_link_id).filter(Boolean))]
      if (!linkIds.length) return res.json({ success: true, suppliers: [] })

      const { data, error } = await supabase
        .from('buyer_supplier_links')
        .select('supplier:organizations!buyer_supplier_links_supplier_org_id_fkey(id, display_name)')
        .in('id', linkIds)
        .eq('relationship_status', 'active')

      if (error) throw error

      const suppliers = [...new Map(data.map(r => [r.supplier.id, r.supplier.display_name])).entries()]
        .map(([id, display_name]) => ({ id, display_name }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name))

      return res.json({ success: true, suppliers })
    }

    // No filters — use fast RPC
    const { data, error } = await supabase.rpc('get_distinct_suppliers')
    if (error) throw error

    const suppliers = (data || []).map(r => ({ id: r.supplier_org_id, display_name: r.display_name }))
    return res.json({ success: true, suppliers })

  } catch (err) {
    console.error('❌ Admin suppliers fetch failed:', err)
    res.status(500).json({ error: err.message })
  }
})

router.get('/all-buyers', async (req, res) => {
  try {
    const { merchantName } = req.query

    // If merchantName filter is active, fall back to the query approach
    // since RPC doesn't accept params — or use a separate filtered RPC
    if (merchantName?.trim()) {
      // existing query-based logic with merchantName filter
      const { data: pos, error: posError } = await supabase
        .from('purchase_orders')
        .select('buyer_supplier_link_id')
        .gte('po_received_date', '2026-01-01')
        .is('deleted_at', null)
        .is('delete_meta', null)
        .ilike('created_by', `%${merchantName.trim()}%`)

      if (posError) throw posError

      const linkIds = [...new Set((pos || []).map(r => r.buyer_supplier_link_id).filter(Boolean))]
      if (!linkIds.length) return res.json({ success: true, buyers: [] })

      const { data, error } = await supabase
        .from('buyer_supplier_links')
        .select('buyer:organizations!buyer_supplier_links_buyer_org_id_fkey(id, display_name)')
        .in('id', linkIds)
        .eq('relationship_status', 'active')

      if (error) throw error

      const buyers = [...new Map(data.map(r => [r.buyer.id, r.buyer.display_name])).entries()]
        .map(([id, display_name]) => ({ id, display_name }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name))

      return res.json({ success: true, buyers })
    }

    // No filter — use fast RPC
    const { data, error } = await supabase.rpc('get_distinct_buyers')
    if (error) throw error

    const buyers = (data || []).map(r => ({ id: r.buyer_org_id, display_name: r.display_name }))
    return res.json({ success: true, buyers })

  } catch (err) {
    console.error('❌ Admin buyers fetch failed:', err)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router