const express = require('express')
const supabase = require('../supabaseClient')
const upload = require('../upload')

const router = express.Router()

const TABLE = 'international_courier_logs_export'
const INVOICE_BUCKET = 'logistics_document'
const sanitizePath = s => (s || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')
const { enrichInternationalLogs } = require('../utils/courierLogZips')

const REQUIRED_FIELDS = [
  'invoice_number',
  'date_of_invoice',
  'merchant_name',
  'vendor_name',
  'vendor_address',
  'buyer_name',
  'buyer_address',
  'courier_company',
  'tracking_number',
  'dispatch_date',
  'courier_cost_by',
  'charge_to',
  'product_description',
  'package_quantity'
]

// GET /logistics/international-courier-logs/filter-options
// Returns distinct values for dropdown filters
router.get('/filter-options', async (req, res) => {
  try {
    const [merchants, vendors, buyers, couriers] = await Promise.all([
      supabase.from(TABLE).select('merchant_name').neq('merchant_name', null),
      supabase.from(TABLE).select('vendor_name').neq('vendor_name', null),
      supabase.from(TABLE).select('buyer_name').neq('buyer_name', null),
      supabase.from(TABLE).select('courier_company').neq('courier_company', null)
    ])

    if (merchants.error) throw merchants.error
    if (vendors.error)   throw vendors.error
    if (buyers.error)    throw buyers.error
    if (couriers.error)  throw couriers.error

    return res.json({
      merchants:  [...new Set(merchants.data.map(r => r.merchant_name))].sort(),
      vendors:    [...new Set(vendors.data.map(r => r.vendor_name))].sort(),
      buyers:     [...new Set(buyers.data.map(r => r.buyer_name))].sort(),
      couriers:   [...new Set(couriers.data.map(r => r.courier_company))].sort()
    })
  } catch (err) {
    console.error('GET international_courier_logs_export/filter-options error:', err)
    return res.status(500).json({ error: 'Failed to fetch filter options' })
  }
})

// GET /logistics/international-courier-logs
// Query params: from, to, buyer_name, vendor_name, merchant_name, courier_company, search
router.get('/', async (req, res) => {
  try {
    const { from, to, search, buyer_name, vendor_name, merchant_name, courier_company } = req.query

    let query = supabase
      .from(TABLE)
      .select('*')
      .eq('is_archive', false)
      .order('dispatch_date', { ascending: false })

    if (from)           query = query.gte('dispatch_date', from)
    if (to)             query = query.lte('dispatch_date', to)
    if (buyer_name)     query = query.eq('buyer_name', buyer_name)
    if (vendor_name)    query = query.eq('vendor_name', vendor_name)
    if (merchant_name)  query = query.eq('merchant_name', merchant_name)
    if (courier_company) query = query.eq('courier_company', courier_company)
    if (search)         query = query.or(
      `invoice_number.ilike.%${search}%,buyer_name.ilike.%${search}%,merchant_name.ilike.%${search}%,tracking_number.ilike.%${search}%,vendor_name.ilike.%${search}%`
    )

    const { data, error } = await query
    if (error) throw error

    return res.json({ logs: await enrichInternationalLogs(data) })
  } catch (err) {
    console.error('GET international_courier_logs_export error:', err)
    return res.status(500).json({ error: 'Failed to fetch international courier logs' })
  }
})

// GET /logistics/international-courier-logs/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'International courier log not found' })

    const [log] = await enrichInternationalLogs([data])
    return res.json({ log })
  } catch (err) {
    console.error('GET international_courier_logs_export/:id error:', err)
    return res.status(500).json({ error: 'Failed to fetch international courier log' })
  }
})

// GET /logistics/international-courier-logs/:id/invoice — returns a signed URL for the uploaded invoice
router.get('/:id/invoice', async (req, res) => {
  try {
    const { data: log, error } = await supabase
      .from(TABLE)
      .select('upload_invoice')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!log) return res.status(404).json({ error: 'International courier log not found' })
    if (!log.upload_invoice) return res.status(404).json({ error: 'No invoice uploaded for this log' })

    const { data: signed, error: signErr } = await supabase.storage
      .from(INVOICE_BUCKET)
      .createSignedUrl(log.upload_invoice, 3600)

    if (signErr) throw signErr

    return res.json({ url: signed.signedUrl })
  } catch (err) {
    console.error('GET international courier log invoice error:', err)
    return res.status(500).json({ error: 'Failed to get invoice URL' })
  }
})

// POST /logistics/international-courier-logs/:id/invoice — upload invoice file (multipart field: invoiceFile)
// Storage path: logistics_document/{buyer_name}/{vendor_name}/{invoice_number}.{ext}
router.post('/:id/invoice', upload.single('invoiceFile'), async (req, res) => {
  let filePath = null
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' })

    const { data: log, error: fetchErr } = await supabase
      .from(TABLE)
      .select('buyer_name, vendor_name, invoice_number, upload_invoice')
      .eq('id', req.params.id)
      .single()

    if (fetchErr) throw fetchErr
    if (!log) return res.status(404).json({ error: 'International courier log not found' })

    const ext = req.file.originalname.includes('.')
      ? '.' + req.file.originalname.split('.').pop()
      : ''
    filePath = `international-courier/${sanitizePath(log.buyer_name)}/${sanitizePath(log.vendor_name)}/${sanitizePath(log.invoice_number)}${ext}`

    const { error: uploadErr } = await supabase.storage
      .from(INVOICE_BUCKET)
      .upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true })

    if (uploadErr) throw uploadErr

    // Remove old file from storage if it differs from the new path
    if (log.upload_invoice && log.upload_invoice !== filePath) {
      await supabase.storage.from(INVOICE_BUCKET).remove([log.upload_invoice])
    }

    const { data, error: updateErr } = await supabase
      .from(TABLE)
      .update({ upload_invoice: filePath, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (updateErr) throw updateErr

    return res.json({ success: true, path: filePath, log: data })
  } catch (err) {
    console.error('POST international courier log invoice upload error:', err)
    if (filePath) await supabase.storage.from(INVOICE_BUCKET).remove([filePath])
    return res.status(500).json({ error: 'Failed to upload invoice' })
  }
})

// DELETE /logistics/international-courier-logs/:id/invoice — remove uploaded invoice
router.delete('/:id/invoice', async (req, res) => {
  try {
    const { data: log, error } = await supabase
      .from(TABLE)
      .select('upload_invoice')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!log) return res.status(404).json({ error: 'International courier log not found' })
    if (!log.upload_invoice) return res.status(404).json({ error: 'No invoice to delete' })

    const { error: storageErr } = await supabase.storage
      .from(INVOICE_BUCKET)
      .remove([log.upload_invoice])

    if (storageErr) throw storageErr

    const { data: updated } = await supabase
      .from(TABLE)
      .update({ upload_invoice: null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    return res.json({ success: true, log: updated })
  } catch (err) {
    console.error('DELETE international courier log invoice error:', err)
    return res.status(500).json({ error: 'Failed to delete invoice' })
  }
})

// POST /logistics/international-courier-logs
router.post('/', async (req, res) => {
  try {
    const {
      invoice_number,
      date_of_invoice,
      merchant_name,
      vendor_name,
      vendor_address,
      zip_code_V,
      buyer_name,
      buyer_address,
      zip_code_B,
      courier_service,
      courier_company,
      tracking_number,
      dispatch_date,
      delivery_date,
      courier_cost_by,
      charge_to,
      account_number,
      product_description,
      remarks,
      upload_invoice
    } = req.body

    const packageQuantity = req.body['package_quantity']

    const missing = REQUIRED_FIELDS.filter(f => {
      const val = f === 'package_quantity' ? packageQuantity : req.body[f]
      return val === undefined || val === null || val === ''
    })

    if (missing.length === 1) {
      return res.status(400).json({ error: `Please fill in the required field: ${missing[0]}` })
    }
    if (missing.length > 1) {
      return res.status(400).json({ error: `Please fill in the required fields: ${missing.join(', ')}` })
    }

    const parsedPackages = Number(packageQuantity)
    if (isNaN(parsedPackages) || parsedPackages <= 0) {
      return res.status(400).json({ error: 'package_quantity must be a positive number' })
    }

    const { data, error } = await supabase
      .from(TABLE)
      .insert([{
        invoice_number,
        date_of_invoice,
        merchant_name,
        vendor_name,
        vendor_address,
        zip_code_V:       zip_code_V || null,
        buyer_name,
        buyer_address,
        zip_code_B:       zip_code_B || null,
        courier_service:  courier_service || null,
        courier_company,
        tracking_number,
        dispatch_date,
        delivery_date:    delivery_date || null,
        courier_cost_by,
        charge_to,
        account_number:   account_number || null,
        product_description,
        package_quantity: parsedPackages,
        remarks:          remarks || null,
        upload_invoice:   upload_invoice || null
      }])
      .select()
      .single()

    if (error) throw error

    return res.status(201).json({ log: data })
  } catch (err) {
    console.error('POST international_courier_logs_export error:', err)
    return res.status(500).json({ error: 'Failed to create international courier log' })
  }
})

// PATCH /logistics/international-courier-logs/:id
router.patch('/:id', async (req, res) => {
  try {
    const ALLOWED = [
      'invoice_number', 'date_of_invoice', 'merchant_name', 'vendor_name',
      'vendor_address', 'zip_code_V', 'buyer_name', 'buyer_address', 'zip_code_B', 'courier_service',
      'courier_company', 'tracking_number', 'dispatch_date', 'delivery_date',
      'courier_cost_by', 'charge_to', 'account_number', 'product_description', 'package_quantity',
      'remarks', 'upload_invoice'
    ]

    const updates = {}
    for (const key of ALLOWED) {
      if (key in req.body) updates[key] = req.body[key]
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided to update' })
    }

    if ('package_quantity' in updates) {
      const val = Number(updates['package_quantity'])
      if (isNaN(val) || val <= 0) {
        return res.status(400).json({ error: 'package_quantity must be a positive number' })
      }
      updates['package_quantity'] = val
    }

    const clearingRequired = REQUIRED_FIELDS.filter(
      f => f in updates && (updates[f] === null || updates[f] === '')
    )
    if (clearingRequired.length > 0) {
      return res.status(400).json({ error: `Cannot clear required fields: ${clearingRequired.join(', ')}` })
    }

    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from(TABLE)
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'International courier log not found' })

    return res.json({ log: data })
  } catch (err) {
    console.error('PATCH international_courier_logs_export/:id error:', err)
    return res.status(500).json({ error: 'Failed to update international courier log' })
  }
})

// DELETE /logistics/international-courier-logs/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from(TABLE)
      .update({ is_archive: true, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)

    if (error) throw error

    return res.json({ success: true })
  } catch (err) {
    console.error('DELETE international_courier_logs_export/:id error:', err)
    return res.status(500).json({ error: 'Failed to delete international courier log' })
  }
})

module.exports = router
