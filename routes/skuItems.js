const { Redis } = require('@upstash/redis')
const express = require("express");
const router = express.Router()
const supabase = require('../supabaseClient')
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



module.exports = router