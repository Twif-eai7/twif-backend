/**
 * routes/dashboard.js
 *
 * Dashboard data routes — email-based, Supabase Storage backed.
 * Replaces the old Shopify metafield + customerId routes.
 *
 * All routes require a valid Supabase JWT via requireAuth middleware.
 * Email is taken from req.user (the verified JWT), not from query params,
 * except for admin merchant-switching where an explicit ?merchant= email
 * is accepted after verifying the caller is a merchant org admin.
 *
 * Files live in Supabase Storage bucket: portal-data
 *   merchant-performance.xlsx
 *   volume-shipped-ytd.xlsx
 *   open-orders-ytd.xlsx
 *   open-po-summary-fy26.xlsx
 *   open-po-summary-fy27.xlsx
 */

const express = require('express')
const XLSX = require('xlsx')
const supabase = require('../supabaseClient')
const { requireAuth } = require('../middleware/auth')
const axios = require("axios");
const { EMAIL_PASS, EMAIL_USER,SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN} = process.env;


const router = express.Router()

// ─────────────────────────────────────────────
// File key constants — never change these.
// Actual storage paths live in portal_files table.
// ─────────────────────────────────────────────
const FILE_KEYS = {
  merchantPerformance: 'merchant-performance',
  merchantPerformanceFy27: 'merchant-performance-fy27',
  volumeShippedYtdFy27: 'volume-shipped-ytd-fy27',
  volumeShippedYtd:    'volume-shipped-ytd',
  openOrdersYtd:       'open-orders-ytd',       // monthly count+value → table + chart bars
  openPoFy26:          'open-po-fy26',           // FY26 full PO detail rows
  openPoFy27:          'open-po-fy27',           // FY27 full PO detail rows
  shippedPoFy26:       'shipped-po-fy26',        // shipped PO summary for FY26 (for chart + table)
  shippedPoFy27:       'shipped-po-fy27',        // shipped PO summary for FY27 (for chart + table)
}

// ─────────────────────────────────────────────
// In-process path cache — busted on file update
// ─────────────────────────────────────────────
const _filePathCache = {}

async function resolveFilePath(key) {
  if (_filePathCache[key]) return _filePathCache[key]
  const { data, error } = await supabase
    .from('portal_files')
    .select('storage_path, bucket')
    .eq('key', key)
    .single()
  if (error || !data) throw new Error(`No file configured for key: ${key}`)
  _filePathCache[key] = { path: data.storage_path, bucket: data.bucket }
  return _filePathCache[key]
}

function invalidateFileCache(key) {
  if (key) delete _filePathCache[key]
  else Object.keys(_filePathCache).forEach(k => delete _filePathCache[k])
}

// ─────────────────────────────────────────────
// Helper: verify caller is owner/admin of a merchant org
// ─────────────────────────────────────────────
async function getMerchantOrg(userId) {
  const { data } = await supabase
    .from('organization_members')
    .select('id, role, organizations!inner(id, type)')
    .eq('user_id', userId)
    .eq('organizations.type', 'merchant')
    .maybeSingle()
  return data || null
}

// ─────────────────────────────────────────────
// Helper: download workbook from Supabase Storage
// Auto-retries once on stale cache
// ─────────────────────────────────────────────
async function downloadWorkbook(fileKey) {
  const { path, bucket } = await resolveFilePath(fileKey)
  const { data, error } = await supabase.storage.from(bucket).download(path)
  if (error) {
    invalidateFileCache(fileKey)
    const resolved = await resolveFilePath(fileKey)
    const retry = await supabase.storage.from(resolved.bucket).download(resolved.path)
    if (retry.error) throw new Error(`Storage download failed for key "${fileKey}" (path: ${resolved.path}): ${retry.error.message}`)
    const ab2 = await retry.data.arrayBuffer()
    return XLSX.read(Buffer.from(ab2), { type: 'buffer', cellDates: true, cellNF: false, cellHTML: false })
  }
  const arrayBuffer = await data.arrayBuffer()
  return XLSX.read(Buffer.from(arrayBuffer), { type: 'buffer', cellDates: true, cellNF: false, cellHTML: false })
}

// ─────────────────────────────────────────────
// Helper: parse first sheet into { headers, rows }
// ─────────────────────────────────────────────
function parseSheet(workbook, sheetIndex = 0) {
  const worksheet = workbook.Sheets[workbook.SheetNames[sheetIndex]]
  const jsonData = XLSX.utils.sheet_to_json(worksheet, {
    header: 1, defval: '', blankrows: false, raw: true,
  })
  if (!jsonData.length) return { headers: [], rows: [] }
  const headers = jsonData[0].map(h =>
    h?.toString().trim().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ') || ''
  )
  const rows = jsonData.slice(1).map(row => {
    const obj = {}
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : '' })
    return obj
  })
  return { headers, rows }
}

// ─────────────────────────────────────────────
// Helper: safely parse number from any value
// ─────────────────────────────────────────────
function cleanNumber(val) {
  if (val === null || val === undefined || val === '') return 0
  if (typeof val === 'number') return val
  if (typeof val === 'string') {
    const num = parseFloat(val.trim().replace(/[$,\s]/g, ''))
    return isNaN(num) ? 0 : num
  }
  return 0
}

// ─────────────────────────────────────────────
// Helper: extract YYYY-MM key from a target/date string
// Mirrors the frontend extractMonthKey logic
// ─────────────────────────────────────────────
function extractMonthKey(target) {
  if (!target) return null
  const d = new Date(target)
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }
  const m = target.match(/^(\d{4}-\d{2})/)
  return m ? m[1] : null
}

function normBuyerName(name) {
  return name?.toString().trim().replace(/\u00A0/g, '').replace(/\s+/g, ' ').toUpperCase() || ''
}

// ─────────────────────────────────────────────
// Summary helpers for merchant-performance
// ─────────────────────────────────────────────
function makeSummaryFromRow(row) {
  return {
    volumeLY25:           cleanNumber(row['Volume LY25']),
    targetFY26:           cleanNumber(row['Target FY26']),
    ytdActual:            cleanNumber(row['YTD FY26']),
    ytdTarget:            cleanNumber(row['Target FY26']),
    totalOpenPos:         cleanNumber(row['Open Pos']),
    totalOrders:          cleanNumber(row['Total orders']),
    otifRate:             `${cleanNumber(row['OTIF']).toFixed(0)}%`,
    otifRawAverage:       cleanNumber(row['OTIF']),
    otifLY:               cleanNumber(row['OTIF LY']),
    otifLatest:           `${cleanNumber(row['OTIF Latest']).toFixed(0)}%`,
    totalQualityClaims:   cleanNumber(row['Quality Claims']),
    totalQualityClaimsLY: cleanNumber(row['Quality Claims LY']),
    totalConvertedSKUs:   cleanNumber(row['Converted SKUs']),
    totalSKUs:            cleanNumber(row['Total SKUs']),
    numberOfPos:          cleanNumber(row['Number of Pos']),
    openPosCount:         cleanNumber(row['Open Pos count']),
    growth:               cleanNumber(row['Growth']),
    latePos:              cleanNumber(row['Late Pos']),
    onTimePos:            cleanNumber(row['Ontime Pos']),
  }
}

function aggregateSummary(rows) {
  const t = {
    volumeLY25: 0, targetFY26: 0, ytdFY26: 0, totalOpenPos: 0,
    totalOrders: 0, otifValues: [], otifLYValues: [], otifLatestValues: [],
    totalQualityClaims: 0, totalQualityClaimsLY: 0,
    totalSKUs: 0, totalConvertedSKUs: 0, numberOfPos: 0,
    openPosCount: 0, growth: 0, latePos: 0, onTimePos: 0,
  }
  rows.forEach(row => {
    t.volumeLY25           += cleanNumber(row['Volume LY25'])
    t.targetFY26           += cleanNumber(row['Target FY26'])
    t.ytdFY26              += cleanNumber(row['YTD FY26'])
    t.totalOpenPos         += cleanNumber(row['Open Pos'])
    t.totalOrders          += cleanNumber(row['Total orders'])
    const otif = cleanNumber(row['OTIF'])
    if (otif > 0) t.otifValues.push(otif)
    const otifLY = cleanNumber(row['OTIF LY'])
    if (otifLY > 0) t.otifLYValues.push(otifLY)
    const otifLatest = cleanNumber(row['OTIF Latest'])
    if (otifLatest > 0) t.otifLatestValues.push(otifLatest)
    t.growth               += cleanNumber(row['Growth'])
    t.totalQualityClaims   += cleanNumber(row['Quality Claims'])
    t.totalQualityClaimsLY += cleanNumber(row['Quality Claims LY'])
    t.totalSKUs            += cleanNumber(row['Total SKUs'])
    t.totalConvertedSKUs   += cleanNumber(row['Converted SKUs'])
    t.numberOfPos          += cleanNumber(row['Number of Pos'])
    t.openPosCount         += cleanNumber(row['Open Pos count'])
    t.latePos              += cleanNumber(row['Late Pos'])
    t.onTimePos            += cleanNumber(row['Ontime Pos'])
  })
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  return {
    volumeLY25:           t.volumeLY25,
    targetFY26:           t.targetFY26,
    ytdActual:            t.ytdFY26,
    ytdTarget:            t.targetFY26,
    totalOpenPos:         t.totalOpenPos,
    totalOrders:          t.totalOrders,
    otifRate:             `${avg(t.otifValues).toFixed(0)}%`,
    otifRawAverage:       avg(t.otifValues),
    otifLY:               avg(t.otifLYValues),
    otifLatest:           `${avg(t.otifLatestValues).toFixed(0)}%`,
    totalQualityClaims:   t.totalQualityClaims,
    totalQualityClaimsLY: t.totalQualityClaimsLY,
    totalConvertedSKUs:   t.totalConvertedSKUs,
    totalSKUs:            t.totalSKUs,
    numberOfPos:          t.numberOfPos,
    openPosCount:         t.openPosCount,
    growth:               t.growth,
    latePos:              t.latePos,
    onTimePos:            t.onTimePos,
  }
}
function makeSummaryFromRowFy27(row) {
  return {
    volumeLY26:           cleanNumber(row['Volume LY26']),
    targetFY27:           cleanNumber(row['Target FY27']),
    ytdActual:            cleanNumber(row['YTD FY27']),
    ytdTarget:            cleanNumber(row['Target FY27']),
    totalOpenPos:         cleanNumber(row['Open Pos']),
    totalOrders:          cleanNumber(row['Total orders']),
    otifRate:             `${cleanNumber(row['OTIF']).toFixed(0)}%`,
    otifRawAverage:       cleanNumber(row['OTIF']),
    otifLY:               cleanNumber(row['OTIF LY']),
    otifLatest:           `${cleanNumber(row['OTIF Latest']).toFixed(0)}%`,
    totalQualityClaims:   cleanNumber(row['Quality Claims']),
    totalQualityClaimsLY: cleanNumber(row['Quality Claims LY']),
    totalConvertedSKUs:   cleanNumber(row['Converted SKUs']),
    totalSKUs:            cleanNumber(row['Total SKUs']),
    numberOfPos:          cleanNumber(row['Number of Pos']),
    openPosCount:         cleanNumber(row['Open Pos count']),
    growth:               cleanNumber(row['Growth']),
    latePos:              cleanNumber(row['Late Pos']),
    onTimePos:            cleanNumber(row['Ontime Pos']),
  }
}

function aggregateSummaryFy27(rows) {
  const t = {
    volumeLY26: 0, targetFY27: 0, ytdFY27: 0, totalOpenPos: 0,
    totalOrders: 0, otifValues: [], otifLYValues: [], otifLatestValues: [],
    totalQualityClaims: 0, totalQualityClaimsLY: 0,
    totalSKUs: 0, totalConvertedSKUs: 0, numberOfPos: 0,
    openPosCount: 0, growth: 0, latePos: 0, onTimePos: 0,
  }
  rows.forEach(row => {
    t.volumeLY26           += cleanNumber(row['Volume LY26'])
    t.targetFY27           += cleanNumber(row['Target FY27'])
    t.ytdFY27              += cleanNumber(row['YTD FY27'])
    t.totalOpenPos         += cleanNumber(row['Open Pos'])
    t.totalOrders          += cleanNumber(row['Total orders'])
    const otif = cleanNumber(row['OTIF'])
    if (otif > 0) t.otifValues.push(otif)
    const otifLY = cleanNumber(row['OTIF LY'])
    if (otifLY > 0) t.otifLYValues.push(otifLY)
    const otifLatest = cleanNumber(row['OTIF Latest'])
    if (otifLatest > 0) t.otifLatestValues.push(otifLatest)
    t.growth               += cleanNumber(row['Growth'])
    t.totalQualityClaims   += cleanNumber(row['Quality Claims'])
    t.totalQualityClaimsLY += cleanNumber(row['Quality Claims LY'])
    t.totalSKUs            += cleanNumber(row['Total SKUs'])
    t.totalConvertedSKUs   += cleanNumber(row['Converted SKUs'])
    t.numberOfPos          += cleanNumber(row['Number of Pos'])
    t.openPosCount         += cleanNumber(row['Open Pos count'])
    t.latePos              += cleanNumber(row['Late Pos'])
    t.onTimePos            += cleanNumber(row['Ontime Pos'])
  })
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  return {
    volumeLY26:           t.volumeLY26,
    targetFY27:           t.targetFY27,
    ytdActual:            t.ytdFY27,
    ytdTarget:            t.targetFY27,
    totalOpenPos:         t.totalOpenPos,
    totalOrders:          t.totalOrders,
    otifRate:             `${avg(t.otifValues).toFixed(0)}%`,
    otifRawAverage:       avg(t.otifValues),
    otifLY:               avg(t.otifLYValues),
    otifLatest:           `${avg(t.otifLatestValues).toFixed(0)}%`,
    totalQualityClaims:   t.totalQualityClaims,
    totalQualityClaimsLY: t.totalQualityClaimsLY,
    totalConvertedSKUs:   t.totalConvertedSKUs,
    totalSKUs:            t.totalSKUs,
    numberOfPos:          t.numberOfPos,
    openPosCount:         t.openPosCount,
    growth:               t.growth,
    latePos:              t.latePos,
    onTimePos:            t.onTimePos,
  }
}

// ═══════════════════════════════════════════════════════════════
// GET /dashboard/merchant-performance
//
// KPI summary for the logged-in merchant.
// Admins can pass ?merchant=email to view another merchant's data.
// Query: ?buyer=NKUKU  (optional — defaults to TOTAL row)
// ═══════════════════════════════════════════════════════════════
router.get('/merchant-performance', requireAuth, async (req, res) => {
  try {
    const callerEmail = req.user.email.toLowerCase().trim()
    const { buyer, merchant } = req.query

    const orgRow = await getMerchantOrg(req.user.id)
    if (!orgRow) return res.status(403).json({ error: 'Access restricted to merchant org members' })

    const isAdmin = ['admin', 'owner'].includes(orgRow.role)
    let targetEmail = callerEmail
    if (isAdmin && merchant?.trim()) targetEmail = merchant.toLowerCase().trim()

    const workbook = await downloadWorkbook(FILE_KEYS.merchantPerformance)
    const { rows: parsedData } = parseSheet(workbook)
    if (!parsedData.length) return res.status(404).json({ error: 'Empty file' })

    const allBuyersInSheet = [...new Set(
      parsedData.map(r => r['Buyer']?.toString().trim().toUpperCase()).filter(b => b && b !== 'TOTAL')
    )]

    let merchantList = []
    if (isAdmin) {
      const emailBuyerCounts = {}
      parsedData.forEach(row => {
        const email = row['Email']?.toString().toLowerCase().trim()
        const b = row['Buyer']?.toString().trim()
        if (email && b && b.toUpperCase() !== 'TOTAL') {
          if (!emailBuyerCounts[email]) emailBuyerCounts[email] = new Set()
          emailBuyerCounts[email].add(b.toUpperCase())
        }
      })
      merchantList = Object.entries(emailBuyerCounts)
        .filter(([, buyerSet]) => buyerSet.size < allBuyersInSheet.length)
        .map(([email]) => {
          const row = parsedData.find(r => r['Email']?.toString().toLowerCase().trim() === email)
          return { email, name: row?.['Name']?.toString().trim() || email }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    }

    const customerRows = parsedData.filter(
      r => r['Email']?.toString().toLowerCase().trim() === targetEmail
    )
    if (!customerRows.length) {
      return res.status(404).json({ error: `No performance data found for ${targetEmail}` })
    }

    const buyersList = [...new Set(customerRows.map(r => r['Buyer']).filter(Boolean))].sort()

    let filteredRows = customerRows
    let determinedBuyer

    if (buyer && buyer !== 'All') {
      const norm = buyer.trim().toUpperCase()
      filteredRows = customerRows.filter(r => r['Buyer']?.toString().trim().toUpperCase() === norm)
      determinedBuyer = buyer
    } else {
      const totalBuyer = buyersList.find(b => b.trim().toUpperCase().includes('TOTAL'))
      determinedBuyer = totalBuyer || buyersList[0] || 'Unknown'
      const norm = determinedBuyer.trim().toUpperCase()
      filteredRows = customerRows.filter(r => r['Buyer']?.toString().trim().toUpperCase() === norm)
    }

    const isTotal = determinedBuyer.trim().toUpperCase().includes('TOTAL')
    const summary = isTotal && filteredRows.length === 1
      ? makeSummaryFromRow(filteredRows[0])
      : aggregateSummary(filteredRows)

    return res.json({
      success: true,
      data: {
        summary,
        availableBuyers: buyersList,
        currentBuyer: determinedBuyer,
        isAdmin,
        merchantList,
        currentMerchant: isAdmin ? (targetEmail === callerEmail ? null : targetEmail) : null,
      }
    })

  } catch (err) {
    console.error('GET /dashboard/merchant-performance error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
// GET /dashboard/merchant-performance-fy27
//
// FY27 KPI summary for the logged-in merchant.
// Admins can pass ?merchant=email to view another merchant's data.
// Query: ?buyer=NKUKU  (optional — defaults to TOTAL row)
// ═══════════════════════════════════════════════════════════════
router.get('/merchant-performance-fy27', requireAuth, async (req, res) => {
  try {
    const callerEmail = req.user.email.toLowerCase().trim()
    const { buyer, merchant } = req.query

    const orgRow = await getMerchantOrg(req.user.id)
    if (!orgRow) return res.status(403).json({ error: 'Access restricted to merchant org members' })

    const isAdmin = ['admin', 'owner'].includes(orgRow.role)
    let targetEmail = callerEmail
    if (isAdmin && merchant?.trim()) targetEmail = merchant.toLowerCase().trim()

    const workbook = await downloadWorkbook(FILE_KEYS.merchantPerformanceFy27)
    const { rows: parsedData } = parseSheet(workbook)
    if (!parsedData.length) return res.status(404).json({ error: 'Empty file' })

    const allBuyersInSheet = [...new Set(
      parsedData.map(r => r['Buyer']?.toString().trim().toUpperCase()).filter(b => b && b !== 'TOTAL')
    )]

    let merchantList = []
    if (isAdmin) {
      const emailBuyerCounts = {}
      parsedData.forEach(row => {
        const email = row['Email']?.toString().toLowerCase().trim()
        const b = row['Buyer']?.toString().trim()
        if (email && b && b.toUpperCase() !== 'TOTAL') {
          if (!emailBuyerCounts[email]) emailBuyerCounts[email] = new Set()
          emailBuyerCounts[email].add(b.toUpperCase())
        }
      })
      merchantList = Object.entries(emailBuyerCounts)
        .filter(([, buyerSet]) => buyerSet.size < allBuyersInSheet.length)
        .map(([email]) => {
          const row = parsedData.find(r => r['Email']?.toString().toLowerCase().trim() === email)
          return { email, name: row?.['Name']?.toString().trim() || email }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    }

    const customerRows = parsedData.filter(
      r => r['Email']?.toString().toLowerCase().trim() === targetEmail
    )
    if (!customerRows.length) {
      return res.status(404).json({ error: `No performance data found for ${targetEmail}` })
    }

    const buyersList = [...new Set(customerRows.map(r => r['Buyer']).filter(Boolean))].sort()

    let filteredRows = customerRows
    let determinedBuyer

    if (buyer && buyer !== 'All') {
      const norm = buyer.trim().toUpperCase()
      filteredRows = customerRows.filter(r => r['Buyer']?.toString().trim().toUpperCase() === norm)
      determinedBuyer = buyer
    } else {
      const totalBuyer = buyersList.find(b => b.trim().toUpperCase().includes('TOTAL'))
      determinedBuyer = totalBuyer || buyersList[0] || 'Unknown'
      const norm = determinedBuyer.trim().toUpperCase()
      filteredRows = customerRows.filter(r => r['Buyer']?.toString().trim().toUpperCase() === norm)
    }

    const isTotal = determinedBuyer.trim().toUpperCase().includes('TOTAL')
    const summary = isTotal && filteredRows.length === 1
      ? makeSummaryFromRowFy27(filteredRows[0])
      : aggregateSummaryFy27(filteredRows)

    return res.json({
      success: true,
      data: {
        summary,
        availableBuyers: buyersList,
        currentBuyer: determinedBuyer,
        isAdmin,
        merchantList,
        currentMerchant: isAdmin ? (targetEmail === callerEmail ? null : targetEmail) : null,
      }
    })

  } catch (err) {
    console.error('GET /dashboard/merchant-performance-fy27 error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
// GET /dashboard/volume-shipped-ytd
//
// Shipped volume by buyer+vendor+month. Feeds the chart and
// the sourcing pie. Mirrors admin-volume-origin logic.
// Query: ?buyers=NKUKU,NEXT  (optional)
//        ?merchant=email      (admin only)
// ═══════════════════════════════════════════════════════════════
router.get('/volume-shipped-ytd', requireAuth, async (req, res) => {
  try {
    const callerEmail = req.user.email.toLowerCase().trim()
    const { merchant } = req.query

    const orgRow = await getMerchantOrg(req.user.id)
    if (!orgRow) return res.status(403).json({ error: 'Access restricted to merchant org members' })

    const isAdmin = ['admin', 'owner'].includes(orgRow.role)

    let allowedBuyers = []
    if (req.query.buyers) {
      allowedBuyers = req.query.buyers.split('||').map(b => b.trim().toUpperCase()).filter(Boolean)
    } else {
      const targetEmail = (isAdmin && merchant) ? merchant.toLowerCase().trim() : callerEmail
      const perfWorkbook = await downloadWorkbook(FILE_KEYS.merchantPerformance)
      const { rows: perfRows } = parseSheet(perfWorkbook)
      allowedBuyers = [...new Set(
        perfRows
          .filter(r => r['Email']?.toString().toLowerCase().trim() === targetEmail)
          .map(r => r['Buyer']?.toString().trim().toUpperCase())
          .filter(b => b && !b.includes('TOTAL'))
      )]
    }

    const workbook = await downloadWorkbook(FILE_KEYS.volumeShippedYtd)
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1, defval: '', blankrows: false, raw: false,
    })
    if (!jsonData.length) return res.status(404).json({ error: 'Empty file' })

    let headerRowIndex = 0
    for (let i = 0; i < jsonData.length; i++) {
      if (jsonData[i]?.[0]) { headerRowIndex = i; break }
    }
    const headers = jsonData[headerRowIndex].map(h =>
      h?.toString().trim().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ') || ''
    )

    const totalIndex  = headers.findIndex(h => h.toLowerCase() === 'total')
    const originIndex = headers.findIndex(h => h.toLowerCase() === 'origin')
    const monthColumns = totalIndex !== -1
      ? headers.slice(2, totalIndex)
      : headers.slice(2).filter(h => h.toLowerCase() !== 'origin' && h.toLowerCase() !== 'total')

    const parsedData = jsonData.slice(headerRowIndex + 1)
      .filter(row => row?.[0] || row?.[1])
      .map(row => {
        const buyerRaw = row[0]?.toString().trim().toUpperCase() || ''
        const obj = {
          buyer: buyerRaw,
          vendor: row[1]?.toString().trim() || '',
          isTotalRow: buyerRaw.endsWith(' TOTAL'),
        }
        monthColumns.forEach(m => {
          obj[m] = cleanNumber(row[headers.indexOf(m)])
        })
        if (totalIndex !== -1) obj.total = cleanNumber(row[totalIndex])
        if (originIndex !== -1) obj.origin = row[originIndex]?.toString().trim() || ''
        return obj
      })

    const filteredData = allowedBuyers.length > 0
      ? parsedData.filter(row => {
          const name = row.buyer.replace(/ TOTAL$/, '').trim().toUpperCase()
          return allowedBuyers.some(b => b === name)
        })
      : parsedData

    const totalsByOrigin = {}
    let grandTotalValue = 0
    if (originIndex !== -1 && totalIndex !== -1) {
      filteredData.forEach(row => {
        if (row.isTotalRow && row.origin && row.total &&
            !(row.buyer.toUpperCase().includes('GRAND') && row.buyer.toUpperCase().includes('TOTAL'))) {
          totalsByOrigin[row.origin] = (totalsByOrigin[row.origin] || 0) + row.total
        }
      })
      grandTotalValue = Object.values(totalsByOrigin).reduce((s, v) => s + v, 0)
    }

    const originData = Object.entries(totalsByOrigin)
      .map(([origin, value]) => ({ origin, value, percentage: grandTotalValue > 0 ? (value / grandTotalValue) * 100 : 0 }))
      .sort((a, b) => b.value - a.value)

    const clientData = totalIndex !== -1
      ? (() => {
          const clientTotals = {}
          filteredData.forEach(row => {
            if (row.isTotalRow && row.total &&
                !(row.buyer.toUpperCase().includes('GRAND') && row.buyer.toUpperCase().includes('TOTAL'))) {
              const name = row.buyer.replace(/ TOTAL$/, '').trim()
              clientTotals[name] = (clientTotals[name] || 0) + row.total
            }
          })
          return Object.entries(clientTotals)
            .map(([client, value]) => ({ client, value, percentage: grandTotalValue > 0 ? (value / grandTotalValue) * 100 : 0 }))
            .sort((a, b) => b.value - a.value)
        })()
      : []

    return res.json({
      success: true,
      data: {
        rows: filteredData,
        months: monthColumns,
        hasTotal: totalIndex !== -1,
        hasOrigin: originIndex !== -1,
        originData,
        clientData,
        grandTotalValue,
      },
      customerBuyers: allowedBuyers,
    })

  } catch (err) {
    console.error('GET /dashboard/volume-shipped-ytd error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
// GET /dashboard/open-orders
//
// Monthly open PO count+value from openordersytd file.
// Feeds the open-po monthly table and the open PO bars in the chart.
// Excel structure: buyer | vendor | [month count] | [month value] | ... | total
//
// Query: ?buyers=A,B      (optional)
//        ?merchant=email  (admin only)
// ═══════════════════════════════════════════════════════════════
router.get('/open-orders', requireAuth, async (req, res) => {
  try {
    const callerEmail = req.user.email.toLowerCase().trim()
    const { buyers: buyersParam, merchant } = req.query

    const orgRow = await getMerchantOrg(req.user.id)
    if (!orgRow) return res.status(403).json({ error: 'Access restricted to merchant org members' })

    const isAdmin = ['admin', 'owner'].includes(orgRow.role)

    let allowedBuyers = buyersParam
      ? buyersParam.split('||').map(b => b.trim().toUpperCase()).filter(Boolean)
      : []

    if (!allowedBuyers.length) {
      const targetEmail = (isAdmin && merchant) ? merchant.toLowerCase().trim() : callerEmail
      const perfWorkbook = await downloadWorkbook(FILE_KEYS.merchantPerformance)
      const { rows: perfRows } = parseSheet(perfWorkbook)
      allowedBuyers = [...new Set(
        perfRows
          .filter(r => r['Email']?.toString().toLowerCase().trim() === targetEmail)
          .map(r => r['Buyer']?.toString().trim().toUpperCase())
          .filter(b => b && !b.includes('TOTAL'))
      )]
    }

    const MONTH_LABEL_MAP = {
      jan: 'January 2025',   feb: 'February 2025',  mar: 'March 2025',
      apr: 'April 2025',     may: 'May 2025',        jun: 'June 2025',
      jul: 'July 2025',      aug: 'August 2025',     sep: 'September 2025',
      oct: 'October 2025',   nov: 'November 2025',   dec: 'December 2025',
      forjan26: 'January 2026',  forfeb26: 'February 2026',  formar26: 'March 2026',
      forapr26: 'April 2026',    formay26: 'May 2026',       forjun26: 'June 2026',
      forjul26: 'July 2026', foraug26: 'August 2026',   forsep26: 'September 2026',
      foroct26: 'October 2026',  fornov26: 'November 2026',  fordec26: 'December 2026',
      forjan27: 'January 2027',  forfeb27: 'February 2027',  formar27: 'March 2027',
    }

    const workbook = await downloadWorkbook(FILE_KEYS.openOrdersYtd)
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1, defval: '', blankrows: false, raw: false,
    })
    if (!jsonData.length) return res.status(404).json({ error: 'Empty or invalid open orders file' })

    let headerRowIndex = 0
    for (let i = 0; i < jsonData.length; i++) {
      if (jsonData[i]?.[0]) { headerRowIndex = i; break }
    }

    const headers = jsonData[headerRowIndex].map(h =>
      h?.toString().trim().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ') || ''
    )

    const totalIdx = headers.findIndex(h => h.toLowerCase() === 'total')
    const limit = totalIdx !== -1 ? totalIdx : headers.length

    // Build month pairs — detect "X count" + "X" column pairs
    const monthPairs = []
    const seenMonths = new Set()
    for (let i = 2; i < limit; i++) {
      const h = headers[i].toLowerCase().replace(/ count$/, '').trim()
      if (seenMonths.has(h)) continue
      seenMonths.add(h)
      const countIdx = headers.findIndex((x, xi) => xi >= 2 && x.toLowerCase() === `${h} count`)
      const valueIdx = headers.findIndex((x, xi) => xi >= 2 && x.toLowerCase() === h && !x.toLowerCase().endsWith(' count'))
      if (valueIdx === -1) continue
      monthPairs.push({ month: h, countIdx, valueIdx })
    }

    const monthColumns = monthPairs.map(p => p.month)

    const parsedRows = jsonData.slice(headerRowIndex + 1)
      .filter(r => r?.[0])
      .map(row => {
        const buyer  = row[0]?.toString().trim().replace(/\u00A0/g, '').toUpperCase() || ''
        const vendor = row[1]?.toString().trim().replace(/\u00A0/g, '') || ''
        const isTotalRow =
          buyer.endsWith(' TOTAL') ||
          buyer.includes('SUB TOTAL') ||
          buyer.replace(/\s/g, '').toUpperCase().startsWith('GRANDTOTAL') ||
          !vendor ||
          vendor.toLowerCase() === 'sub total'

        const obj = { buyer, vendor, isTotalRow }
        monthPairs.forEach(({ month, countIdx, valueIdx }) => {
          obj[`${month}_count`] = cleanNumber(countIdx !== -1 ? row[countIdx] : 0)
          obj[month]             = cleanNumber(row[valueIdx])
        })
        if (totalIdx !== -1) obj.total = cleanNumber(row[totalIdx])
        return obj
      })

    const individualRows = parsedRows.filter(r => !r.isTotalRow)
    const filteredRows = allowedBuyers.length > 0
      ? individualRows.filter(r => {
          const b = r.buyer.replace(/ TOTAL$/, '').trim().toUpperCase()
          return allowedBuyers.includes(b)
        })
      : individualRows

    // Build buyerBreakdown with human-readable month labels
    const buyerBreakdown = {}
    filteredRows.forEach(row => {
      const buyerKey = row.buyer.replace(/ TOTAL$/, '').trim()
      if (!buyerBreakdown[buyerKey]) buyerBreakdown[buyerKey] = {}
      monthPairs.forEach(({ month }) => {
        const label = MONTH_LABEL_MAP[month.toLowerCase()] || month
        if (!buyerBreakdown[buyerKey][label]) {
          buyerBreakdown[buyerKey][label] = { month: label, count: 0, value: 0 }
        }
        buyerBreakdown[buyerKey][label].count += row[`${month}_count`] || 0
        buyerBreakdown[buyerKey][label].value += row[month] || 0
      })
    })

    const buyerBreakdownFinal = {}
    Object.entries(buyerBreakdown).forEach(([buyer, monthMap]) => {
      buyerBreakdownFinal[buyer] = Object.values(monthMap).filter(m => m.count > 0 || m.value > 0)
    })

    const totalsByMonth = {}
    monthColumns.forEach(m => {
      totalsByMonth[m] = filteredRows.reduce((sum, r) => sum + (r[m] || 0), 0)
    })
    const grandTotal = Object.values(totalsByMonth).reduce((s, v) => s + v, 0)

    return res.json({
      success: true,
      data: {
        rows: filteredRows,
        months: monthColumns,
        monthsWithCount: monthPairs.map(p => ({
          month:    p.month,
          countCol: p.countIdx !== -1 ? `${p.month} count` : null,
          valueCol: p.month,
        })),
        buyerBreakdown: buyerBreakdownFinal,
        summary: { totalsByMonth, grandTotal, rowCount: filteredRows.length },
      },
      customerBuyers: allowedBuyers,
    })

  } catch (err) {
    console.error('GET /dashboard/open-orders error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
// GET /dashboard/open-po-summary
//
// Full PO line-item detail rows from FY26 or FY27 summary files.
// Flat structure: one clean row per line item, no subtotals.
//
// Query: ?fy=26|27        (default: 26)
//        ?buyers=A,B      (optional)
//        ?merchant=email  (admin only)
// ═══════════════════════════════════════════════════════════════
router.get('/open-po-summary', requireAuth, async (req, res) => {
  try {
    const buyersParam = req.query.buyers
    const { fy = '27', page = '1', pageSize = '3' , month = ''} = req.query
    const pageNum  = Math.max(1, parseInt(page, 10))
    const pageSz   = Math.max(1, parseInt(pageSize, 10))

    const orgRow = await getMerchantOrg(req.user.id)
    if (!orgRow) return res.status(403).json({ error: 'Access restricted to merchant org members' })

    const isAdmin = ['admin', 'owner'].includes(orgRow.role)

    const { data: buyerSupplierOrgs, error: buyerSupplierOrgsError } = await supabase
      .from('member_organization_access')
      .select(`
        organization_id,
        buyer_supplier_link_id,
        organizations!inner(display_name),
        buyer_supplier_links(
          buyer_org_id,
          supplier_org_id,
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey(display_name),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey(display_name)
        )
      `)
      .eq('member_id', orgRow.id)

    if (buyerSupplierOrgsError) {
      console.error('Error fetching buyer/supplier orgs:', buyerSupplierOrgsError)
      return res.status(500).json({ error: 'Failed to fetch buyer/supplier organizations' })
    }

    const orgAllowedBuyers = buyerSupplierOrgs.map(o => o.buyer_supplier_links?.buyer.display_name.toUpperCase() || o.organizations.display_name.toUpperCase())
    const allowedSuppliers = buyerSupplierOrgs
      .map(o => o.buyer_supplier_links?.supplier.display_name.toUpperCase() || '')
      .filter(Boolean)

    let allowedBuyers
    if (buyersParam) {
      const requested = buyersParam.split('||').map(b => b.trim().toUpperCase()).filter(Boolean)
      allowedBuyers = isAdmin
        ? requested
        : requested.filter(b => orgAllowedBuyers.includes(b))
    } else if (isAdmin) {
      allowedBuyers = null
    } else {
      allowedBuyers = orgAllowedBuyers
    }

    if (buyersParam && Array.isArray(allowedBuyers) && allowedBuyers.length === 0) {
      return res.json({
        success: true,
        data: { rows: [], rowCount: 0 },
        pagination: { page: pageNum, pageSize: pageSz, totalPages: 0, totalCustomers: 0 },
        overall: {
          orderValue: 0, shippedValue: 0, cancelledValue: 0, balanceValue: 0,
          orderQty: 0, shippedQty: 0, cancelledQty: 0, balanceQty: 0,
          totalPoCount: 0, totalLineCount: 0,
        },
        customerBuyers: orgAllowedBuyers,
        customerSuppliers: allowedSuppliers,
      })
    }

    const fileKey = fy === '27' ? FILE_KEYS.openPoFy27 : FILE_KEYS.openPoFy26
    const workbook = await downloadWorkbook(fileKey)
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1, defval: '', blankrows: false, raw: false,
    })
    if (jsonData.length < 2) return res.status(404).json({ error: 'Empty or invalid file' })

    const headers = jsonData[0].map(h =>
      h?.toString().trim().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ') || ''
    )
    const colIdx = name => headers.findIndex(h => h.toLowerCase() === name.toLowerCase())

    const col = {
      customer:       colIdx('Customer'),
      vendor:         colIdx('Vendor'),
      poNo:           colIdx('PO No.'),
      item:           colIdx('Item'),
      orderQty:       colIdx('Order Qty'),
      orderPrice:     colIdx('Order Price'),
      orderValue:     colIdx('Order Value in US $'),
      orderDate:      colIdx('Order Date'),
      shippedQty:     colIdx('Shipped Qty'),
      shippedValue:   colIdx('Shipped Value in US $'),
      shippedDate:    colIdx('Shipped Date'),
      cancelledQty:   colIdx('Cancelled Qty'),
      cancelledValue: colIdx('Cancelled Value in US $'),
      balanceQty:     colIdx('Balance Qty'),
      balanceValue:   colIdx('Balance Value in US $'),
      target:         colIdx('Target'),
      totalBusiness:  colIdx('Total Business'),
      status:         colIdx('Status'),
    }

    const allRows = jsonData.slice(1)
      .filter(row => row?.[col.customer]?.toString().trim())
      .map(row => ({
        customer:       row[col.customer]?.toString().trim() || '',
        vendor:         row[col.vendor]?.toString().trim() || '',
        poNo:           row[col.poNo]?.toString().trim() || '',
        item:           row[col.item]?.toString().trim() || '',
        orderQty:       cleanNumber(row[col.orderQty]),
        orderPrice:     cleanNumber(row[col.orderPrice]),
        orderValue:     cleanNumber(row[col.orderValue]),
        orderDate:      row[col.orderDate]?.toString().trim() || '',
        shippedQty:     cleanNumber(row[col.shippedQty]),
        shippedValue:   cleanNumber(row[col.shippedValue]),
        shippedDate:    row[col.shippedDate]?.toString().trim() || '',
        cancelledQty:   cleanNumber(row[col.cancelledQty]),
        cancelledValue: cleanNumber(row[col.cancelledValue]),
        balanceQty:     cleanNumber(row[col.balanceQty]),
        balanceValue:   cleanNumber(row[col.balanceValue]),
        target:         row[col.target]?.toString().trim() || '',
        totalBusiness:  cleanNumber(row[col.totalBusiness]),
        status:         row[col.status]?.toString().trim() || '',
      }))

    const filteredRows = allowedBuyers === null
      ? allRows
      : allowedBuyers.length > 0
        ? allRows.filter(row => allowedBuyers.includes(row.customer.toUpperCase()))
        : []

    const allowedSuppliersNorm = allowedSuppliers.map(s => s.trim().toUpperCase())

    const filteredRowsWithSuppliers = (allowedSuppliersNorm.length > 0 && !buyersParam && allowedBuyers !== null)
    ? filteredRows.filter(row => 
        allowedSuppliersNorm.includes(row.vendor.trim().toUpperCase())
      )
    : filteredRows
    
    const monthFiltered = month
      ? filteredRowsWithSuppliers.filter(r => extractMonthKey(r.target) === month)
      : filteredRowsWithSuppliers

    const overall = {
      orderValue:     monthFiltered.reduce((s, r) => s + (r.orderValue     || 0), 0),
      shippedValue:   monthFiltered.reduce((s, r) => s + (r.shippedValue   || 0), 0),
      cancelledValue: monthFiltered.reduce((s, r) => s + (r.cancelledValue || 0), 0),
      balanceValue:   monthFiltered.reduce((s, r) => s + (r.balanceValue   || 0), 0),
      orderQty:       monthFiltered.reduce((s, r) => s + (r.orderQty       || 0), 0),
      shippedQty:     monthFiltered.reduce((s, r) => s + (r.shippedQty     || 0), 0),
      cancelledQty:   monthFiltered.reduce((s, r) => s + (r.cancelledQty   || 0), 0),
      balanceQty:     monthFiltered.reduce((s, r) => s + (r.balanceQty     || 0), 0),
      totalPoCount:   new Set(monthFiltered.map(r => `${r.vendor}__${r.poNo}`)).size,
      totalLineCount: monthFiltered.length,
    }

    const allCustomers   = [...new Set(monthFiltered.map(r => r.customer))].sort()
    const totalFilteredCustomers = allCustomers.length
    const totalPages     = Math.ceil(allCustomers.length / pageSz)  // ← use filtered count when month active
    const pageCustomers  = allCustomers.slice((pageNum - 1) * pageSz, pageNum * pageSz)
    const pageRows       = monthFiltered.filter(r => pageCustomers.includes(r.customer))

    return res.json({
      success: true,
      data:       { rows: pageRows, rowCount: pageRows.length },
      pagination: { page: pageNum, pageSize: pageSz, totalPages, totalCustomers : totalFilteredCustomers },
      overall,
      customerBuyers:    orgAllowedBuyers,
      customerSuppliers: allowedSuppliers,
    })
  } catch (err) {
    console.error('GET /dashboard/open-po-summary error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})


router.get('/shipped-po-summary', requireAuth, async (req, res) => {
  try {
    const buyersParam = req.query.buyers
    const { fy = '27', page = '1', pageSize = '3', month = '', merchant } = req.query
    const returnAllRows = req.query.allRows === '1' || req.query.allRows === 'true'
    const pageNum  = Math.max(1, parseInt(page, 10))
    const pageSz   = Math.max(1, parseInt(pageSize, 10))

    const orgRow = await getMerchantOrg(req.user.id)
    if (!orgRow) return res.status(403).json({ error: 'Access restricted to merchant org members' })

    const isAdmin = ['admin', 'owner'].includes(orgRow.role)

    const { data: buyerSupplierOrgs, error: buyerSupplierOrgsError } = await supabase
      .from('member_organization_access')
      .select(`
        organization_id,
        buyer_supplier_link_id,
        organizations!inner(display_name),
        buyer_supplier_links(
          buyer_org_id,
          supplier_org_id,
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey(display_name),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey(display_name)
        )
      `)
      .eq('member_id', orgRow.id)

    if (buyerSupplierOrgsError) {
      console.error('Error fetching buyer/supplier orgs:', buyerSupplierOrgsError)
      return res.status(500).json({ error: 'Failed to fetch buyer/supplier organizations' })
    }

    const orgAllowedBuyers = buyerSupplierOrgs.map(o => o.buyer_supplier_links?.buyer.display_name.toUpperCase() || o.organizations.display_name.toUpperCase())
    const allowedSuppliers = buyerSupplierOrgs
      .map(o => o.buyer_supplier_links?.supplier.display_name.toUpperCase() || '')
      .filter(Boolean)

    let allowedBuyers
    if (buyersParam) {
      const requested = buyersParam.split('||').map(b => normBuyerName(b)).filter(Boolean)
      if (isAdmin) {
        allowedBuyers = requested
      } else {
        allowedBuyers = requested.filter(b => orgAllowedBuyers.map(normBuyerName).includes(b))
      }
    } else if (isAdmin && merchant?.trim()) {
      const perfKey = fy === '27' ? FILE_KEYS.merchantPerformanceFy27 : FILE_KEYS.merchantPerformance
      const perfWorkbook = await downloadWorkbook(perfKey)
      const { rows: perfRows } = parseSheet(perfWorkbook)
      allowedBuyers = [...new Set(
        perfRows
          .filter(r => r['Email']?.toString().toLowerCase().trim() === merchant.toLowerCase().trim())
          .map(r => normBuyerName(r['Buyer']))
          .filter(b => b && !b.includes('TOTAL'))
      )]
    } else if (isAdmin) {
      allowedBuyers = null
    } else {
      allowedBuyers = orgAllowedBuyers.map(normBuyerName)
    }

    if (buyersParam && allowedBuyers.length === 0) {
      return res.json({
        success: true,
        data: { rows: [], rowCount: 0 },
        pagination: { page: pageNum, pageSize: pageSz, totalPages: 0, totalCustomers: 0 },
        overall: {
          orderValue: 0, shippedValue: 0, cancelledValue: 0, balanceValue: 0,
          orderQty: 0, shippedQty: 0, cancelledQty: 0, balanceQty: 0,
          totalPoCount: 0, totalLineCount: 0,
        },
        customerBuyers: orgAllowedBuyers,
        customerSuppliers: allowedSuppliers,
      })
    }

    const fileKey = fy === '27' ? FILE_KEYS.shippedPoFy27 : FILE_KEYS.shippedPoFy26
    const workbook = await downloadWorkbook(fileKey)
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1, defval: '', blankrows: false, raw: false,
    })
    if (jsonData.length < 2) return res.status(404).json({ error: 'Empty or invalid file' })

    const headers = jsonData[0].map(h =>
      h?.toString().trim().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ') || ''
    )
    const colIdx = name => headers.findIndex(h => h.toLowerCase() === name.toLowerCase())

    const col = {
      customer:       colIdx('Customer'),
      vendor:         colIdx('Vendor'),
      poNo:           colIdx('PO No.'),
      item:           colIdx('Item'),
      orderQty:       colIdx('Order Qty'),
      orderPrice:     colIdx('Order Price'),
      orderValue:     colIdx('Order Value in US $'),
      orderDate:      colIdx('Order Date'),
      shippedQty:     colIdx('Shipped Qty'),
      shippedValue:   colIdx('Shipped Value in US $'),
      shippedDate:    colIdx('Shipped Date'),
      cancelledQty:   colIdx('Cancelled Qty'),
      cancelledValue: colIdx('Cancelled Value in US $'),
      balanceQty:     colIdx('Balance Qty'),
      balanceValue:   colIdx('Balance Value in US $'),
      target:         colIdx('Target'),
      totalBusiness:  colIdx('Total Business'),
      status:         colIdx('Status'),
    }

    const allRows = jsonData.slice(1)
      .filter(row => row?.[col.customer]?.toString().trim())
      .map(row => ({
        customer:       row[col.customer]?.toString().trim() || '',
        vendor:         row[col.vendor]?.toString().trim() || '',
        poNo:           row[col.poNo]?.toString().trim() || '',
        item:           row[col.item]?.toString().trim() || '',
        orderQty:       cleanNumber(row[col.orderQty]),
        orderPrice:     cleanNumber(row[col.orderPrice]),
        orderValue:     cleanNumber(row[col.orderValue]),
        orderDate:      row[col.orderDate]?.toString().trim() || '',
        shippedQty:     cleanNumber(row[col.shippedQty]),
        shippedValue:   cleanNumber(row[col.shippedValue]),
        shippedDate:    row[col.shippedDate]?.toString().trim() || '',
        cancelledQty:   cleanNumber(row[col.cancelledQty]),
        cancelledValue: cleanNumber(row[col.cancelledValue]),
        balanceQty:     cleanNumber(row[col.balanceQty]),
        balanceValue:   cleanNumber(row[col.balanceValue]),
        target:         row[col.target]?.toString().trim() || '',
        totalBusiness:  cleanNumber(row[col.totalBusiness]),
        status:         row[col.status]?.toString().trim() || '',
      }))

    const filteredRows = allowedBuyers === null
      ? allRows
      : allowedBuyers.length > 0
        ? allRows.filter(row => allowedBuyers.includes(normBuyerName(row.customer)))
        : []

    const allowedSuppliersNorm = allowedSuppliers.map(s => normBuyerName(s))
    const skipSupplierFilter = !!buyersParam || (isAdmin && merchant?.trim()) || allowedBuyers === null

    const filteredRowsWithSuppliers = (allowedSuppliersNorm.length > 0 && !skipSupplierFilter)
    ? filteredRows.filter(row => 
        allowedSuppliersNorm.includes(normBuyerName(row.vendor))
      )
    : filteredRows
    

    // ── Server-side month filter ──────────────────────────────────────────
    const monthFiltered = month
      ? filteredRowsWithSuppliers.filter(r => extractMonthKey(r.shippedDate) === month)
      : filteredRowsWithSuppliers

    // ── Grand totals across ALL filtered rows (not just this page) ──────────
    const overall = {
      orderValue:     monthFiltered.reduce((s, r) => s + (r.orderValue     || 0), 0),
      shippedValue:   monthFiltered.reduce((s, r) => s + (r.shippedValue   || 0), 0),
      cancelledValue: monthFiltered.reduce((s, r) => s + (r.cancelledValue || 0), 0),
      balanceValue:   monthFiltered.reduce((s, r) => s + (r.balanceValue   || 0), 0),
      orderQty:       monthFiltered.reduce((s, r) => s + (r.orderQty       || 0), 0),
      shippedQty:     monthFiltered.reduce((s, r) => s + (r.shippedQty     || 0), 0),
      cancelledQty:   monthFiltered.reduce((s, r) => s + (r.cancelledQty   || 0), 0),
      balanceQty:     monthFiltered.reduce((s, r) => s + (r.balanceQty     || 0), 0),
      totalPoCount:   new Set(monthFiltered.map(r => `${r.vendor}__${r.poNo}`)).size,
      totalLineCount: monthFiltered.length,
    }

    const allCustomers   = [...new Set(monthFiltered.map(r => r.customer))].sort()
    const totalCustomers = allowedBuyers === null ? allCustomers.length : (allowedBuyers.length || orgAllowedBuyers.length)
    const totalPages     = returnAllRows ? 1 : Math.ceil(allCustomers.length / pageSz)
    const pageCustomers  = returnAllRows
      ? allCustomers
      : allCustomers.slice((pageNum - 1) * pageSz, pageNum * pageSz)
    const pageRows       = monthFiltered.filter(r => pageCustomers.includes(r.customer))
    const responseRows   = returnAllRows ? monthFiltered : pageRows

    return res.json({
      success: true,
      data:       { rows: responseRows, rowCount: responseRows.length },
      pagination: { page: returnAllRows ? 1 : pageNum, pageSize: pageSz, totalPages, totalCustomers },
      overall,
      customerBuyers:    orgAllowedBuyers,
      customerSuppliers: allowedSuppliers,
    })
  } catch (err) {
    console.error('GET /dashboard/shipped-po-summary error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
// PATCH /dashboard/files/:key
//
// Update storage path for a file key after uploading a new version.
// Busts in-process cache so the next request picks up the new path.
// Body: { storage_path: 'new-filename.xlsx', bucket?: 'portal-data' }
// ═══════════════════════════════════════════════════════════════
router.patch('/files/:key', requireAuth, async (req, res) => {
  try {
    const orgRow = await getMerchantOrg(req.user.id)
    if (!orgRow || !['admin', 'owner'].includes(orgRow.role)) {
      return res.status(403).json({ error: 'Admin access required' })
    }

    const { key } = req.params
    const { storage_path, bucket } = req.body
    if (!storage_path) return res.status(400).json({ error: 'storage_path is required' })

    const update = { storage_path }
    if (bucket) update.bucket = bucket

    const { error } = await supabase.from('portal_files').update(update).eq('key', key)
    if (error) throw error

    invalidateFileCache(key)
    return res.json({ success: true, key, storage_path })

  } catch (err) {
    console.error('PATCH /dashboard/files/:key error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
// GET /dashboard/files
// List all configured file keys and their current paths.
// ═══════════════════════════════════════════════════════════════
router.get('/files', requireAuth, async (req, res) => {
  try {
    const orgRow = await getMerchantOrg(req.user.id)
    if (!orgRow || !['admin', 'owner'].includes(orgRow.role)) {
      return res.status(403).json({ error: 'Admin access required' })
    }

    const { data, error } = await supabase
      .from('portal_files')
      .select('key, storage_path, bucket, description, updated_at')
      .order('key')

    if (error) throw error
    return res.json({ success: true, data })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.get("/customer/:customerId/merchant-performance-fy27", async (req, res) => {
  const { customerId } = req.params;
  const { buyer, merchant } = req.query;

  if (!customerId) {
    return res.status(400).json({
      error: "Invalid customerId",
      details: "customerId is required",
    });
  }

  try {
    // ── 1. Fetch customer email + buyers metafield ──────────────────────────
    const customerQuery = `
      query getCustomer($customerId: ID!) {
        customer(id: $customerId) {
          id
          email
          isadminField: metafield(namespace: "custom", key: "isadmin") {
            value
          }
        }
      }
    `;

    const customerResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      },
      data: {
        query: customerQuery,
        variables: { customerId: `gid://shopify/Customer/${customerId}` },
      },
    });

    const customerData = customerResponse.data?.data?.customer;
    const customerEmail = customerData?.email;

    if (!customerEmail) {
      return res.status(404).json({
        error: "Customer not found",
        details: `No customer found with ID ${customerId}`,
      });
    }

    let availableBuyers = [];
    if (customerData?.buyersField?.value) {
      try {
        availableBuyers = JSON.parse(customerData.buyersField.value);
      } catch (e) {
        console.warn("Failed to parse buyers metafield:", e);
      }
    }
    const isAdmin = customerData.isadminField?.value === 'true';

    // ── 2. Fetch + parse the Excel file ────────────────────────────────────
    const shopMetafieldQuery = `
      query getShopMetafield {
        shop {
          metafield(namespace: "custom", key: "merchantperformancefy27") {
            id
            value
            type
          }
        }
      }
    `;

    const shopifyResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      },
      data: { query: shopMetafieldQuery },
    });

    const metafieldData = shopifyResponse.data?.data?.shop?.metafield;
    if (!metafieldData) {
      return res.status(404).json({
        error: "Excel file not found",
        details: "No shop metafield found for merchant performance",
      });
    }

    let fileUrl;
    if (metafieldData.type === "file_reference") {
      const fileQuery = `
        query getFileUrl($fileId: ID!) {
          node(id: $fileId) {
            ... on GenericFile { url }
            ... on MediaImage { image { url } }
          }
        }
      `;
      const fileResponse = await axios({
        method: "POST",
        url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
        },
        data: { query: fileQuery, variables: { fileId: metafieldData.value } },
      });
      fileUrl = fileResponse.data?.data?.node?.url || fileResponse.data?.data?.node?.image?.url;
      if (!fileUrl) {
        return res.status(404).json({ error: "File URL not found" });
      }
    } else {
      fileUrl = metafieldData.value;
    }

    const fileResponse = await axios({ method: "GET", url: fileUrl, responseType: "arraybuffer" });

    const XLSX = require("xlsx");
    const workbook = XLSX.read(fileResponse.data, { type: "buffer" });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: true,
    });

    if (jsonData.length === 0) {
      return res.status(404).json({ error: "Empty file" });
    }

    const headers = jsonData[0].map(h => h?.toString().trim().replace(/\u00A0/g, " "));
    const rows = jsonData.slice(1);

    const cleanNumber = (val) => {
      if (val === null || val === undefined || val === "") return 0;
      if (typeof val === "number") return val;
      if (typeof val === "string") {
        const cleaned = val.trim().replace(/[$,\s]/g, "");
        const num = parseFloat(cleaned);
        return isNaN(num) ? 0 : num;
      }
      return 0;
    };

    const parsedData = rows.map((row) => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] !== undefined ? row[index] : "";
      });
      return obj;
    });

    // ── 3. Admin detection ─────────────────────────────────────────────────
    const allBuyersInSheet = [...new Set(
      parsedData
        .map(r => r["Buyer"]?.toString().trim())
        .filter(b => b && b.toUpperCase() !== "TOTAL")
    )];
    const totalBuyerCount = allBuyersInSheet.length;

    // ── 4. Resolve which merchant email to show data for ───────────────────
    let targetEmail = customerEmail;
    let merchantList = [];

    if (isAdmin) {
      // Build merchant list: emails that are NOT admins
      const emailBuyerCounts = {};
      parsedData.forEach(row => {
        const email = row["Email"]?.toString().toLowerCase().trim();
        const b = row["Buyer"]?.toString().trim();
        if (email && b && b.toUpperCase() !== "TOTAL") {
          if (!emailBuyerCounts[email]) emailBuyerCounts[email] = new Set();
          emailBuyerCounts[email].add(b.toUpperCase());
        }
      });

      const merchantEmails = Object.entries(emailBuyerCounts)
        .filter(([, buyerSet]) => buyerSet.size < totalBuyerCount)
        .map(([email]) => email)
        .sort();

      merchantList = merchantEmails.map(email => {
        const row = parsedData.find(
          r => r["Email"]?.toString().toLowerCase().trim() === email
        );
        return {
          email,
          name: row?.["Name"]?.toString().trim() || email,
        };
      });

      if (merchant && merchant.trim() !== "" && merchantEmails.includes(merchant.toLowerCase().trim())) {
        // Specific merchant selected — show their data
        targetEmail = merchant.toLowerCase().trim();
      } else {
        // No merchant param or empty string — fall back to admin's own rows.
        // The admin has a TOTAL row in the sheet which is the pre-calculated
        // combined figure for all merchants. Use that as the "All" view.
        targetEmail = customerEmail;
      }
    }

    // ── 5. Filter rows for target ──────────────────────────────────────────
    const customerRows = parsedData.filter(
      r => r["Email"]?.toString().toLowerCase().trim() === targetEmail.toLowerCase().trim()
    );

    if (customerRows.length === 0) {
      return res.status(404).json({
        error: "Customer data not found",
        details: `No performance data found for: ${targetEmail}`,
      });
    }

    // ── 6. Buyer filtering ─────────────────────────────────────────────────
    const buyerColumn = customerRows.map(r => r["Buyer"]).filter(Boolean);
    const isMultiBuyer = buyerColumn.length > 1;
    const hasTotal = customerRows.some(r => {
      const b = r["Buyer"]?.toString().trim().toUpperCase();
      return b === "TOTAL" || b.includes("TOTAL");
    });

    let filteredRows = customerRows;
    if (buyer && buyer !== "All") {
      const normalizedBuyer = buyer.trim().toUpperCase();
      filteredRows = customerRows.filter(
        r => r["Buyer"]?.toString().trim().toUpperCase() === normalizedBuyer
      );
      if (filteredRows.length === 0) {
        return res.status(404).json({
          error: "Buyer data not found",
          details: `No performance data found for buyer: ${buyer}`,
        });
      }
    }

    const isTotalSelected = buyer && buyer.trim().toUpperCase().includes("TOTAL");

    // ── 7. Aggregation helpers ─────────────────────────────────────────────
    const aggregateSummary = (rows) => {
      const totals = {
        volumeLY26: 0, targetFY27: 0, ytdFY27: 0, totalOpenPos: 0,
        totalOrders: 0, otifValues: [], otifLYValues: [],otifLatestValues: [],
        totalQualityClaimsLY: 0, totalQualityClaims: 0,
        totalSKUs: 0, totalConvertedSKUs: 0, numberOfPos: 0,
        openPosCount: 0, growth: 0, latePos: 0, onTimePos: 0,
      };
      rows.forEach(row => {
        totals.volumeLY26           += cleanNumber(row["Volume LY26"]);
        totals.targetFY27           += cleanNumber(row["Target FY27"]);
        totals.ytdFY27              += cleanNumber(row["YTD FY27"]);
        totals.totalOpenPos         += cleanNumber(row["Open Pos"]);
        totals.totalOrders          += cleanNumber(row["Total orders"]);
        const otif = cleanNumber(row["OTIF"]);
        if (otif > 0) totals.otifValues.push(otif);
        const otifLY = cleanNumber(row["OTIF LY"]);
        if (otifLY > 0) totals.otifLYValues.push(otifLY);
        const otifLatest = cleanNumber(row["OTIF Latest"]);
        if (otifLatest > 0) totals.otifLatestValues.push(otifLatest);
        totals.growth               += cleanNumber(row["Growth"]);
        totals.totalQualityClaimsLY += cleanNumber(row["Quality Claims LY"]);
        totals.totalQualityClaims   += cleanNumber(row["Quality Claims"]);
        totals.totalSKUs            += cleanNumber(row["Total SKUs"]);
        totals.totalConvertedSKUs   += cleanNumber(row["Converted SKUs"]);
        totals.numberOfPos          += cleanNumber(row["Number of Pos"]);
        totals.openPosCount         += cleanNumber(row["Open Pos count"]);
        totals.latePos              += cleanNumber(row["Late Pos"]);
        totals.onTimePos            += cleanNumber(row["Ontime Pos"]);
      });
      const avgOtif   = totals.otifValues.length > 0
        ? totals.otifValues.reduce((a, b) => a + b, 0) / totals.otifValues.length : 0;
      const avgOtifLY = totals.otifLYValues.length > 0
        ? totals.otifLYValues.reduce((a, b) => a + b, 0) / totals.otifLYValues.length : 0;
      const avgOtifLatest = totals.otifLatestValues.length > 0
        ? totals.otifLatestValues.reduce((a, b) => a + b, 0) / totals.otifLatestValues.length : 0;
      return {
        totalRows: rows.length,
        volumeLY26: totals.volumeLY26,
        targetFY27: totals.targetFY27,
        ytdActual: totals.ytdFY27,
        ytdFY27: totals.ytdFY27,
        totalOpenPos: totals.totalOpenPos,
        totalOrders: totals.totalOrders,
        otifRate: `${avgOtif.toFixed(0)}%`,
        otifRawAverage: avgOtif,
        otifLY: avgOtifLY,
        otifLatest: `${avgOtifLatest.toFixed(0)}%`,
        totalQualityClaimsLY: totals.totalQualityClaimsLY,
        totalQualityClaims: totals.totalQualityClaims,
        totalSKUs: totals.totalSKUs,
        totalConvertedSKUs: totals.totalConvertedSKUs,
        numberOfPos: totals.numberOfPos,
        openPosCount: totals.openPosCount,
        growth: totals.growth,
        ytdTarget: totals.targetFY27,
        lytd: totals.volumeLY26,
        latePos: totals.latePos,
        onTimePos: totals.onTimePos,
      };
    };

    const makeSummaryFromRow = (row) => ({
      totalRows: 1,
      volumeLY26: cleanNumber(row["Volume LY26"]),
      targetFY27: cleanNumber(row["Target FY27"]),
      ytdActual: cleanNumber(row["YTD FY27"]),
      ytdFY27: cleanNumber(row["YTD FY27"]),
      totalOpenPos: cleanNumber(row["Open Pos"]),
      totalOrders: cleanNumber(row["Total orders"]),
      otifRate: `${cleanNumber(row["OTIF"]).toFixed(0)}%`,
      otifRawAverage: cleanNumber(row["OTIF"]),
      otifLY: cleanNumber(row["OTIF LY"]),
      otifLatest: `${cleanNumber(row["OTIF Latest"]).toFixed(0)}%`,
      totalQualityClaimsLY: cleanNumber(row["Quality Claims LY"]),
      totalQualityClaims: cleanNumber(row["Quality Claims"]),
      totalSKUs: cleanNumber(row["Total SKUs"]),
      totalConvertedSKUs: cleanNumber(row["Converted SKUs"]),
      numberOfPos: cleanNumber(row["Number of Pos"]),
      openPosCount: cleanNumber(row["Open Pos count"]),
      growth: cleanNumber(row["Growth"]),
      ytdTarget: cleanNumber(row["Target FY27"]),
      lytd: cleanNumber(row["Volume LY26"]),
      latePos: cleanNumber(row["Late Pos"]),
      onTimePos: cleanNumber(row["Ontime Pos"]),
    });

    // ── 8. Build summary ───────────────────────────────────────────────────
    let summary;
    let determinedCurrentBuyer;
    const buyersList = Array.from(new Set(
      customerRows.map(r => r["Buyer"]).filter(Boolean)
    )).sort();

    if (buyer && buyer !== "All") {
      determinedCurrentBuyer = buyer;
      summary = isTotalSelected && filteredRows.length > 0
        ? makeSummaryFromRow(filteredRows[0])
        : aggregateSummary(filteredRows);
    } else {
      const totalBuyer = buyersList.find(b => b.trim().toUpperCase().includes("TOTAL"));
      const nonTotalBuyers = buyersList.filter(b => !b.trim().toUpperCase().includes("TOTAL"));
      determinedCurrentBuyer = totalBuyer || nonTotalBuyers[0] || buyersList[0] || "Unknown";

      const normalizedDetermined = determinedCurrentBuyer.trim().toUpperCase();
      filteredRows = customerRows.filter(
        r => r["Buyer"]?.toString().trim().toUpperCase() === normalizedDetermined
      );

      const isTotal = normalizedDetermined.includes("TOTAL");
      summary = isTotal && filteredRows.length > 0
        ? makeSummaryFromRow(filteredRows[0])
        : aggregateSummary(filteredRows);
    }

    // ── 9. Respond ─────────────────────────────────────────────────────────
    res.json({
      success: true,
      data: {
        headers,
        rows: filteredRows,
        summary,
        rowCount: filteredRows.length,
        isMultiBuyer,
        hasTotal,
        availableBuyers: buyersList,
        currentBuyer: determinedCurrentBuyer,
        metafieldBuyers: availableBuyers,
        isAdmin,
        merchantList,
        // null = admin viewing their own TOTAL row (All Merchants)
        // email string = admin viewing a specific merchant
        currentMerchant: isAdmin
          ? (targetEmail === customerEmail ? null : targetEmail)
          : null,
      },
    });

  } catch (err) {
    console.error("Error:", err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: "File not found" });
    }
    return res.status(500).json({
      error: "Failed to fetch or parse Excel file",
      details: err.message,
    });
  }
});

router.get("/customer/:customerId/volume-origin-fy27", async (req, res) => {
  try {
    const { customerId } = req.params;
    const { merchant } = req.query;

    if (!customerId) {
      return res.status(401).json({
        error: "Unauthorized",
        details: "Customer ID is required"
      });
    }

    // ── Declare allowedBuyers at the top so it's always in scope ──
    let allowedBuyers = [];

    // ── STEP 1: If ?buyers= passed directly, use them. Otherwise fetch from metafield ──
    const buyersParam = req.query.buyers;
    if (buyersParam) {
      allowedBuyers = buyersParam.split('||').map(b => b.trim().toUpperCase()).filter(b => b);
      console.log("Buyers passed directly via param:", allowedBuyers);
    } else {
      const customerQuery = `
        query getCustomerBuyers($customerId: ID!) {
          customer(id: $customerId) {
            id
            metafield(namespace: "custom", key: "buyers") {
              value
            }
          }
        }
      `;

      const customerResponse = await axios({
        method: "POST",
        url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
        },
        data: {
          query: customerQuery,
          variables: { customerId: `gid://shopify/Customer/${customerId}` }
        },
      });

      const customerBuyersValue = customerResponse.data?.data?.customer?.metafield?.value;

      if (customerBuyersValue) {
        try {
          const parsed = JSON.parse(customerBuyersValue);
          allowedBuyers = Array.isArray(parsed)
            ? parsed.map(b => b.trim().toUpperCase()).filter(b => b)
            : [customerBuyersValue.trim().toUpperCase()];
        } catch (e) {
          allowedBuyers = customerBuyersValue
            .split(',')
            .map(b => b.trim().toUpperCase())
            .filter(b => b);
        }
      }

      console.log("Customer ID:", customerId);
      console.log("Raw customer buyers value:", customerBuyersValue);
      console.log("Customer allowed buyers (normalized):", allowedBuyers);
    }

    // ── Fetch shop metafield for Excel file ──
    const query = `
      query getShopMetafield {
        shop {
          metafield(namespace: "custom", key: "volumeshippedytdfy27") {
            id
            value
            type
          }
        }
      }
    `;

    const shopifyResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      },
      data: { query },
    });

    const metafieldData = shopifyResponse.data?.data?.shop?.metafield;

    if (!metafieldData) {
      return res.status(404).json({
        error: "Excel file not found",
        details: "No volumeshippedytd metafield found",
        debugInfo: shopifyResponse.data
      });
    }

    let fileUrl;

    if (metafieldData.type === "file_reference") {
      const fileId = metafieldData.value;
      const fileQuery = `
        query getFileUrl($fileId: ID!) {
          node(id: $fileId) {
            ... on GenericFile { url }
            ... on MediaImage { image { url } }
          }
        }
      `;
      const fileResponse = await axios({
        method: "POST",
        url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
        },
        data: { query: fileQuery, variables: { fileId } },
      });
      fileUrl = fileResponse.data?.data?.node?.url || fileResponse.data?.data?.node?.image?.url;
      if (!fileUrl) {
        return res.status(404).json({ error: "File URL not found" });
      }
    } else {
      fileUrl = metafieldData.value;
    }

    const fileResponse = await axios({ method: "GET", url: fileUrl, responseType: "arraybuffer" });

    // ── Parse Excel ──
    const XLSX = require("xlsx");
    const workbook = XLSX.read(fileResponse.data, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false,
    });

    if (jsonData.length === 0) {
      return res.status(404).json({ error: "Empty file" });
    }

    let headerRowIndex = 0;
    for (let i = 0; i < jsonData.length; i++) {
      if (jsonData[i] && jsonData[i].length > 0 && jsonData[i][0]) {
        headerRowIndex = i;
        break;
      }
    }

    const headers = jsonData[headerRowIndex].map((h) =>
      h?.toString().trim().replace(/\u00A0/g, " ").replace(/\s+/g, " ")
    );

    const totalIndex = headers.findIndex(h => h.toLowerCase() === 'total');
    const originIndex = headers.findIndex(h => h.toLowerCase() === 'origin');

    let monthColumns = [];
    if (totalIndex !== -1) {
      monthColumns = headers.slice(2, totalIndex);
    } else {
      monthColumns = headers.slice(2).filter(h =>
        h.toLowerCase() !== 'origin' && h.toLowerCase() !== 'total'
      );
    }

    const rows = jsonData.slice(headerRowIndex + 1).filter(row =>
      row && row.length > 0 && (row[0] || row[1])
    );

    const cleanNumber = (val) => {
      if (val === null || val === undefined || val === "") return 0;
      if (typeof val === "number") return val;
      if (typeof val === "string") {
        const cleaned = val.replace(/[^0-9.\-]/g, "");
        return cleaned ? parseFloat(cleaned) : 0;
      }
      return 0;
    };

    const parsedData = rows.map((row) => {
      const buyerRaw = row[0]?.toString().trim().toUpperCase() || "";
      const obj = {
        buyer: buyerRaw,
        vendor: row[1]?.toString().trim() || "",
        isTotalRow: buyerRaw.endsWith(" TOTAL"),
      };
      monthColumns.forEach((month) => {
        const monthIndex = headers.indexOf(month);
        obj[month] = cleanNumber(row[monthIndex]);
      });
      if (totalIndex !== -1) obj.total = cleanNumber(row[totalIndex]);
      if (originIndex !== -1) {
        // Strip non-breaking spaces and ignore repeated header text
        const rawOrigin = (row[originIndex] || "")
          .toString()
          .replace(/\u00A0/g, " ")
          .trim();
        obj.origin = rawOrigin === "Origin" ? "" : rawOrigin;
      }
      return obj;
    });

    // ── STEP 2: Admin detection + merchant override (only when buyers came from metafield) ──
    if (!buyersParam) {
      const allBuyersInSheet = [...new Set(
        parsedData
          .map(r => r.buyer.replace(/ TOTAL$/, "").trim().toUpperCase())
          .filter(b => b && !b.includes("GRAND"))
      )];
      const totalBuyerCount = allBuyersInSheet.length;

      const isAdmin = allowedBuyers.filter(b => !b.includes("TOTAL")).length >= totalBuyerCount;

      if (isAdmin && merchant) {
        const merchantLookupQuery = `
          query findCustomerByEmail($email: String!) {
            customers(first: 1, query: $email) {
              edges {
                node {
                  id
                  metafield(namespace: "custom", key: "buyers") {
                    value
                  }
                }
              }
            }
          }
        `;

        const merchantResponse = await axios({
          method: "POST",
          url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
          },
          data: {
            query: merchantLookupQuery,
            variables: { email: `email:${merchant}` }
          },
        });

        const merchantBuyersValue = merchantResponse.data?.data?.customers?.edges?.[0]?.node?.metafield?.value;

        if (merchantBuyersValue) {
          try {
            const parsed = JSON.parse(merchantBuyersValue);
            allowedBuyers = Array.isArray(parsed)
              ? parsed.map(b => b.trim().toUpperCase()).filter(b => b)
              : [merchantBuyersValue.trim().toUpperCase()];
          } catch (e) {
            allowedBuyers = merchantBuyersValue
              .split(',')
              .map(b => b.trim().toUpperCase())
              .filter(b => b);
          }
          console.log(`Admin viewing merchant ${merchant}, buyers overridden to:`, allowedBuyers);
        } else {
          allowedBuyers = [];
          console.log(`Admin viewing merchant ${merchant}, no metafield found — returning empty`);
        }
      }
    }

    // ── Filter data ──
    const filteredData = allowedBuyers.length > 0
      ? parsedData.filter(row => {
          const buyerName = row.buyer.replace(/ TOTAL$/, "").trim().toUpperCase();
          return allowedBuyers.some(b => b === buyerName);
        })
      : parsedData;

    console.log("Total parsed rows:", parsedData.length);
    console.log("Filtered data rows:", filteredData.length);

    if (filteredData.length === 0 && allowedBuyers.length > 0) {
      return res.json({
        success: true,
        data: {
          headers,
          rows: [],
          summary: { totalRows: 0, totalsByMonth: {}, totalsByBuyer: {}, totalsByVendor: {}, totalsByOrigin: {}, grandTotal: 0 },
          rowCount: 0,
          months: monthColumns,
          hasTotal: totalIndex !== -1,
          hasOrigin: originIndex !== -1,
        },
        message: "No data available for your assigned buyers",
        customerBuyers: allowedBuyers
      });
    }

    // ── Only use non-total rows for all aggregations ──
    const vendorRows = filteredData.filter(row => !row.isTotalRow);

    // ── Fiscal scope: Apr 2025 → Mar 2026 ──
    // The sheet contains Jan/Feb/Mar 2025 which are outside FY26 scope.
    // clientData and originData are scoped to match what the GMV chart shows.
    const FISCAL_MONTHS_LOWER = [
  'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'january', 'february', 'march'
];
    const scopedMonths = monthColumns.filter(m => 
  FISCAL_MONTHS_LOWER.includes(m.toLowerCase())
);

    // ── Sub-buyers to exclude from charts (sub-entries under NKUKU parent) ──
    const SKIP_CLIENTS = ['NKUKU LALIT', 'NKUKU SUJATA', 'NKUKU SURAJ'];

    // ── STEP 3: Build buyerOriginMap from TOTAL rows ──
    const buyerOriginMap = {};
    if (originIndex !== -1) {
      filteredData.forEach((row) => {
        if (row.isTotalRow && row.origin) {
          const cleanOrigin = row.origin.replace(/\u00A0/g, " ").trim();
          if (cleanOrigin && cleanOrigin !== 'Origin') {
            const baseBuyer = row.buyer.replace(/ TOTAL$/, "").trim().toUpperCase();
            buyerOriginMap[baseBuyer] = cleanOrigin;
          }
        }
      });
    }

    console.log("buyerOriginMap:", buyerOriginMap);

    // ── STEP 4: summary (uses all monthColumns — frontend handles its own view scoping) ──
    const summary = {
      totalRows: filteredData.length,
      totalsByMonth: {},
      totalsByBuyer: {},
      totalsByVendor: {},
      totalsByOrigin: {},
      grandTotal: 0,
    };

    monthColumns.forEach((month) => {
      summary.totalsByMonth[month] = vendorRows.reduce((sum, row) => sum + (row[month] || 0), 0);
    });

    vendorRows.forEach((row) => {
      if (row.buyer) {
        if (!summary.totalsByBuyer[row.buyer]) summary.totalsByBuyer[row.buyer] = 0;
        monthColumns.forEach((m) => { summary.totalsByBuyer[row.buyer] += row[m] || 0; });
      }
      if (row.vendor) {
        if (!summary.totalsByVendor[row.vendor]) summary.totalsByVendor[row.vendor] = 0;
        monthColumns.forEach((m) => { summary.totalsByVendor[row.vendor] += row[m] || 0; });
      }
    });

    summary.grandTotal = Object.values(summary.totalsByMonth).reduce((sum, val) => sum + val, 0);

    // ── STEP 5: clientData — scoped to Apr 25 → Mar 26, skipping sub-buyers ──
    const clientTotals = {};
    vendorRows.forEach((row) => {
      const clientName = row.buyer.replace(/ TOTAL$/, "").trim();
      if (!clientName || clientName.toUpperCase().includes('GRAND')) return;
      if (SKIP_CLIENTS.includes(clientName.toUpperCase())) return;

      if (!clientTotals[clientName]) clientTotals[clientName] = 0;
      scopedMonths.forEach((m) => { clientTotals[clientName] += row[m] || 0; });
    });

    const clientGrandTotal = Object.values(clientTotals).reduce((sum, val) => sum + val, 0);
    const clientData = Object.entries(clientTotals)
      .map(([client, value]) => ({
        client,
        value,
        percentage: clientGrandTotal > 0 ? (value / clientGrandTotal) * 100 : 0
      }))
      .sort((a, b) => b.value - a.value);

    // ── STEP 6: originData — scoped to Apr 25 → Mar 26, skipping sub-buyers ──
    let originData = [];
    let grandTotalValue = 0;

    if (originIndex !== -1) {
      const originTotals = {};
      vendorRows.forEach((row) => {
        const baseBuyer = row.buyer.trim().toUpperCase();
        if (SKIP_CLIENTS.includes(baseBuyer)) return;
        const origin = buyerOriginMap[baseBuyer];
        if (!origin) return;
        if (!originTotals[origin]) originTotals[origin] = 0;
        scopedMonths.forEach((m) => { originTotals[origin] += row[m] || 0; });
      });

      grandTotalValue = Object.values(originTotals).reduce((sum, val) => sum + val, 0);
      originData = Object.entries(originTotals)
        .map(([origin, value]) => ({
          origin,
          value,
          percentage: grandTotalValue > 0 ? (value / grandTotalValue) * 100 : 0
        }))
        .sort((a, b) => b.value - a.value);
    }

    // ── STEP 7: final grandTotal ──
    if (totalIndex !== -1) {
      summary.grandTotal = filteredData.reduce((sum, row) => sum + (row.total || 0), 0);
    } else {
      summary.grandTotal = Object.values(summary.totalsByMonth).reduce((sum, val) => sum + val, 0);
    }

    res.json({
      success: true,
      data: {
        headers,
        rows: filteredData,
        summary,
        rowCount: filteredData.length,
        months: monthColumns,
        hasTotal: totalIndex !== -1,
        hasOrigin: originIndex !== -1,
        originData,
        clientData,
        grandTotalValue,
      },
      customerBuyers: allowedBuyers,
    });

  } catch (err) {
    console.error("Error fetching/parsing Excel file:", err.message);
    console.error("Full error:", err);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: "File not found", details: "The Excel file URL is not accessible" });
    }
    return res.status(500).json({
      error: "Failed to fetch or parse Excel file",
      details: err.message || "An unexpected error occurred",
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /dashboard/volume-shipped-fy27
//
// FY27 shipped volume by buyer+vendor+month.
// Mirrors volume-shipped-ytd but points at the FY27 file.
// Query: ?buyers=NKUKU||NEXT  (optional)
//        ?merchant=email       (admin only)
// ═══════════════════════════════════════════════════════════════
router.get('/volume-shipped-fy27', requireAuth, async (req, res) => {
  try {
    const callerEmail = req.user.email.toLowerCase().trim()
    const { merchant } = req.query

    const orgRow = await getMerchantOrg(req.user.id)
    if (!orgRow) return res.status(403).json({ error: 'Access restricted to merchant org members' })

    const isAdmin = ['admin', 'owner'].includes(orgRow.role)

    let allowedBuyers = []
    if (req.query.buyers) {
      allowedBuyers = req.query.buyers.split('||').map(b => b.trim().toUpperCase()).filter(Boolean)
    } else {
      const targetEmail = (isAdmin && merchant) ? merchant.toLowerCase().trim() : callerEmail
      const perfWorkbook = await downloadWorkbook(FILE_KEYS.volumeShippedYtdFy27)
      const { rows: perfRows } = parseSheet(perfWorkbook)
      allowedBuyers = [...new Set(
        perfRows
          .filter(r => r['Email']?.toString().toLowerCase().trim() === targetEmail)
          .map(r => r['Buyer']?.toString().trim().toUpperCase())
          .filter(b => b && !b.includes('TOTAL'))
      )]
    }

    const workbook = await downloadWorkbook(FILE_KEYS.volumeShippedYtdFy27)
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1, defval: '', blankrows: false, raw: false,
    })
    if (!jsonData.length) return res.status(404).json({ error: 'Empty file' })

    let headerRowIndex = 0
    for (let i = 0; i < jsonData.length; i++) {
      if (jsonData[i]?.[0]) { headerRowIndex = i; break }
    }
    const headers = jsonData[headerRowIndex].map(h =>
      h?.toString().trim().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ') || ''
    )

    const totalIndex  = headers.findIndex(h => h.toLowerCase() === 'total')
    const originIndex = headers.findIndex(h => h.toLowerCase() === 'origin')
    const monthColumns = totalIndex !== -1
      ? headers.slice(2, totalIndex)
      : headers.slice(2).filter(h => h.toLowerCase() !== 'origin' && h.toLowerCase() !== 'total')

    const parsedData = jsonData.slice(headerRowIndex + 1)
      .filter(row => row?.[0] || row?.[1])
      .map(row => {
        const buyerRaw = row[0]?.toString().trim().toUpperCase() || ''
        const obj = {
          buyer: buyerRaw,
          vendor: row[1]?.toString().trim() || '',
          isTotalRow: buyerRaw.endsWith(' TOTAL'),
        }
        monthColumns.forEach(m => {
          obj[m] = cleanNumber(row[headers.indexOf(m)])
        })
        if (totalIndex !== -1) obj.total = cleanNumber(row[totalIndex])
        if (originIndex !== -1) {
          const rawOrigin = (row[originIndex] || '').toString().replace(/\u00A0/g, ' ').trim()
          obj.origin = rawOrigin === 'Origin' ? '' : rawOrigin
        }
        return obj
      })

    const filteredData = allowedBuyers.length > 0
      ? parsedData.filter(row => {
          const name = row.buyer.replace(/ TOTAL$/, '').trim().toUpperCase()
          return allowedBuyers.some(b => b === name)
        })
      : parsedData

    if (filteredData.length === 0 && allowedBuyers.length > 0) {
      return res.json({
        success: true,
        data: {
          rows: [],
          summary: { totalRows: 0, totalsByMonth: {}, totalsByBuyer: {}, totalsByVendor: {}, grandTotal: 0 },
          rowCount: 0,
          months: monthColumns,
          hasTotal: totalIndex !== -1,
          hasOrigin: originIndex !== -1,
          originData: [],
          clientData: [],
          grandTotalValue: 0,
        },
        message: 'No data available for your assigned buyers',
        customerBuyers: allowedBuyers,
      })
    }

    const vendorRows = filteredData.filter(row => !row.isTotalRow)

    // FY27 fiscal scope: Apr 2026 → Mar 2027
    const FISCAL_MONTHS_LOWER = [
      'april', 'may', 'june', 'july', 'august', 'september',
      'october', 'november', 'december', 'january', 'february', 'march'
    ]
    const scopedMonths = monthColumns.filter(m => FISCAL_MONTHS_LOWER.includes(m.toLowerCase()))

    const SKIP_CLIENTS = ['NKUKU LALIT', 'NKUKU SUJATA', 'NKUKU SURAJ']

    // Build buyerOriginMap from TOTAL rows
    const buyerOriginMap = {}
    if (originIndex !== -1) {
      filteredData.forEach(row => {
        if (row.isTotalRow && row.origin) {
          const cleanOrigin = row.origin.replace(/\u00A0/g, ' ').trim()
          if (cleanOrigin && cleanOrigin !== 'Origin') {
            buyerOriginMap[row.buyer.replace(/ TOTAL$/, '').trim().toUpperCase()] = cleanOrigin
          }
        }
      })
    }

    // Summary — all months, frontend handles its own scoping
    const summary = {
      totalRows: filteredData.length,
      totalsByMonth: {},
      totalsByBuyer: {},
      totalsByVendor: {},
      grandTotal: 0,
    }
    monthColumns.forEach(m => {
      summary.totalsByMonth[m] = vendorRows.reduce((sum, row) => sum + (row[m] || 0), 0)
    })
    vendorRows.forEach(row => {
      if (row.buyer) {
        if (!summary.totalsByBuyer[row.buyer]) summary.totalsByBuyer[row.buyer] = 0
        monthColumns.forEach(m => { summary.totalsByBuyer[row.buyer] += row[m] || 0 })
      }
      if (row.vendor) {
        if (!summary.totalsByVendor[row.vendor]) summary.totalsByVendor[row.vendor] = 0
        monthColumns.forEach(m => { summary.totalsByVendor[row.vendor] += row[m] || 0 })
      }
    })
    summary.grandTotal = totalIndex !== -1
      ? filteredData.reduce((sum, row) => sum + (row.total || 0), 0)
      : Object.values(summary.totalsByMonth).reduce((s, v) => s + v, 0)

    // clientData — scoped months, skipping sub-buyers
    const clientTotals = {}
    vendorRows.forEach(row => {
      const clientName = row.buyer.replace(/ TOTAL$/, '').trim()
      if (!clientName || clientName.toUpperCase().includes('GRAND')) return
      if (SKIP_CLIENTS.includes(clientName.toUpperCase())) return
      if (!clientTotals[clientName]) clientTotals[clientName] = 0
      scopedMonths.forEach(m => { clientTotals[clientName] += row[m] || 0 })
    })
    const clientGrandTotal = Object.values(clientTotals).reduce((s, v) => s + v, 0)
    const clientData = Object.entries(clientTotals)
      .map(([client, value]) => ({
        client, value,
        percentage: clientGrandTotal > 0 ? (value / clientGrandTotal) * 100 : 0,
      }))
      .sort((a, b) => b.value - a.value)

    // originData — scoped months, skipping sub-buyers
    let originData = []
    let grandTotalValue = 0
    if (originIndex !== -1) {
      const originTotals = {}
      vendorRows.forEach(row => {
        const baseBuyer = row.buyer.trim().toUpperCase()
        if (SKIP_CLIENTS.includes(baseBuyer)) return
        const origin = buyerOriginMap[baseBuyer]
        if (!origin) return
        if (!originTotals[origin]) originTotals[origin] = 0
        scopedMonths.forEach(m => { originTotals[origin] += row[m] || 0 })
      })
      grandTotalValue = Object.values(originTotals).reduce((s, v) => s + v, 0)
      originData = Object.entries(originTotals)
        .map(([origin, value]) => ({
          origin, value,
          percentage: grandTotalValue > 0 ? (value / grandTotalValue) * 100 : 0,
        }))
        .sort((a, b) => b.value - a.value)
    }

    return res.json({
      success: true,
      data: {
        rows: filteredData,
        summary,
        rowCount: filteredData.length,
        months: monthColumns,
        hasTotal: totalIndex !== -1,
        hasOrigin: originIndex !== -1,
        originData,
        clientData,
        grandTotalValue,
      },
      customerBuyers: allowedBuyers,
    })

  } catch (err) {
    console.error('GET /dashboard/volume-shipped-fy27 error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})



module.exports = router