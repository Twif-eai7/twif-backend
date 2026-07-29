const express = require('express')
const supabase = require('../supabaseClient')
const upload = require('../upload')

const router = express.Router()

const TABLE = 'domestic_courier_logs_outwards'
const INVOICE_BUCKET = 'logistics_document'
const sanitizePath = s => (s || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')
const { enrichDomesticLogs } = require('../utils/courierLogZips')

const REQUIRED_FIELDS = [
  'invoice_number',
  'dispatch_date',
  'merchant_name',
  'vendor_name',
  'vendor_address',
  'cost_centre',
  'tracking_number',
  'product_description',
  'package_quantity',
  'service',
]

// GET /logistics/courier-logs/filter-options
router.get('/filter-options', async (req, res) => {
  try {
    const [merchants, vendors] = await Promise.all([
      supabase.from(TABLE).select('merchant_name').neq('merchant_name', null),
      supabase.from(TABLE).select('vendor_name').neq('vendor_name', null)
    ])

    if (merchants.error) throw merchants.error
    if (vendors.error)   throw vendors.error

    return res.json({
      merchants: [...new Set(merchants.data.map(r => r.merchant_name))].filter(Boolean).sort(),
      vendors:   [...new Set(vendors.data.map(r => r.vendor_name))].filter(Boolean).sort()
    })
  } catch (err) {
    console.error('GET domestic_courier_logs_outwards/filter-options error:', err)
    return res.status(500).json({ error: 'Failed to fetch filter options' })
  }
})

// GET /logistics/courier-logs
// Query params: from, to, cost_centre, merchant_name, vendor_name, search
router.get('/', async (req, res) => {
  try {
    const { from, to, cost_centre, merchant_name, vendor_name, search } = req.query

    let query = supabase
      .from(TABLE)
      .select('*')
      .eq('is_archive', false)
      .order('dispatch_date', { ascending: false })

    if (from)          query = query.gte('dispatch_date', from)
    if (to)            query = query.lte('dispatch_date', to)
    if (cost_centre)   query = query.eq('cost_centre', cost_centre)
    if (merchant_name) query = query.eq('merchant_name', merchant_name)
    if (vendor_name)   query = query.eq('vendor_name', vendor_name)
    if (search)        query = query.or(
      `invoice_number.ilike.%${search}%,vendor_name.ilike.%${search}%,merchant_name.ilike.%${search}%,tracking_number.ilike.%${search}%`
    )

    const { data, error } = await query
    if (error) throw error

    return res.json({ logs: await enrichDomesticLogs(data) })
  } catch (err) {
    console.error('GET domestic_courier_logs_outwards error:', err)
    return res.status(500).json({ error: 'Failed to fetch courier logs' })
  }
})

// GET /logistics/courier-logs/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Courier log not found' })

    const [log] = await enrichDomesticLogs([data])
    return res.json({ log })
  } catch (err) {
    console.error('GET domestic_courier_logs_outwards/:id error:', err)
    return res.status(500).json({ error: 'Failed to fetch courier log' })
  }
})

// GET /logistics/courier-logs/:id/invoice — returns a signed URL for the uploaded invoice
router.get('/:id/invoice', async (req, res) => {
  try {
    const { data: log, error } = await supabase
      .from(TABLE)
      .select('upload_invoice')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!log) return res.status(404).json({ error: 'Courier log not found' })
    if (!log.upload_invoice) return res.status(404).json({ error: 'No invoice uploaded for this log' })

    const { data: signed, error: signErr } = await supabase.storage
      .from(INVOICE_BUCKET)
      .createSignedUrl(log.upload_invoice, 3600)

    if (signErr) throw signErr

    return res.json({ url: signed.signedUrl })
  } catch (err) {
    console.error('GET domestic courier log invoice error:', err)
    return res.status(500).json({ error: 'Failed to get invoice URL' })
  }
})

// POST /logistics/courier-logs/:id/invoice — upload invoice file (multipart field: invoiceFile)
// Storage path: logistics_document/{vendor_name}/{invoice_number}.{ext}
router.post('/:id/invoice', upload.single('invoiceFile'), async (req, res) => {
  let filePath = null
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' })

    const { data: log, error: fetchErr } = await supabase
      .from(TABLE)
      .select('vendor_name, invoice_number, upload_invoice')
      .eq('id', req.params.id)
      .single()

    if (fetchErr) throw fetchErr
    if (!log) return res.status(404).json({ error: 'Courier log not found' })

    const ext = req.file.originalname.includes('.')
      ? '.' + req.file.originalname.split('.').pop()
      : ''
    filePath = `domestic-courier/${sanitizePath(log.vendor_name)}/${sanitizePath(log.invoice_number)}${ext}`

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
    console.error('POST domestic courier log invoice upload error:', err)
    if (filePath) await supabase.storage.from(INVOICE_BUCKET).remove([filePath])
    return res.status(500).json({ error: 'Failed to upload invoice' })
  }
})

// DELETE /logistics/courier-logs/:id/invoice — remove uploaded invoice
router.delete('/:id/invoice', async (req, res) => {
  try {
    const { data: log, error } = await supabase
      .from(TABLE)
      .select('upload_invoice')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!log) return res.status(404).json({ error: 'Courier log not found' })
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
    console.error('DELETE domestic courier log invoice error:', err)
    return res.status(500).json({ error: 'Failed to delete invoice' })
  }
})

// POST /logistics/courier-logs
router.post('/', async (req, res) => {
  try {
    const {
      invoice_number,
      dispatch_date,
      merchant_name,
      vendor_name,
      vendor_address,
      zip_code,
      cost_centre,
      tracking_number,
      product_description,
      delivery_date,
      service,
      remarks
    } = req.body

    const numberOfPackages = req.body['package_quantity']
    const amount = req.body['Amount']

    // Validate all required fields
    const missing = REQUIRED_FIELDS.filter(f => {
      const val = f === 'package_quantity' ? numberOfPackages
                : f === 'Amount'             ? amount
                : req.body[f]
      return val === undefined || val === null || val === ''
    })

    if (missing.length === 1) {
      return res.status(400).json({ error: `Please fill in the required field: ${missing[0]}` })
    }
    if (missing.length > 1) {
      return res.status(400).json({ error: `Please fill in the required fields: ${missing.join(', ')}` })
    }

    const parsedPackages = Number(numberOfPackages)
    const parsedAmount   = amount !== undefined && amount !== null && amount !== '' ? Number(amount) : null

    if (isNaN(parsedPackages) || parsedPackages <= 0) {
      return res.status(400).json({ error: 'package_quantity must be a positive number' })
    }
    if (parsedAmount !== null && (isNaN(parsedAmount) || parsedAmount < 0)) {
      return res.status(400).json({ error: 'Amount must be a non-negative number' })
    }

    const { data, error } = await supabase
      .from(TABLE)
      .insert([{
        invoice_number,
        dispatch_date,
        merchant_name,
        vendor_name,
        vendor_address,
        zip_code:             zip_code || null,
        cost_centre: cost_centre?.toString().toLowerCase() || null,
        tracking_number,
        product_description,
        'package_quantity': parsedPackages,
        Amount:               parsedAmount ?? null,
        delivery_date:        delivery_date || null,
        service:              service,
        remarks:              remarks || null
      }])
      .select()
      .single()

    if (error) throw error

    return res.status(201).json({ log: data })
  } catch (err) {
    console.error('POST domestic_courier_logs_outwards error:', err)
    return res.status(500).json({ error: 'Failed to create courier log' })
  }
})

// PATCH /logistics/courier-logs/:id
router.patch('/:id', async (req, res) => {
  try {
    const ALLOWED = [
      'invoice_number', 'dispatch_date', 'merchant_name', 'vendor_name',
      'vendor_address', 'zip_code', 'cost_centre', 'tracking_number', 'product_description',
      'package_quantity', 'Amount', 'delivery_date', 'service', 'remarks', 'upload_invoice'
    ]

    const updates = {}
    for (const key of ALLOWED) {
      if (key in req.body) updates[key] = req.body[key]
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided to update' })
    }

    // Validate numeric fields if present
    if ('package_quantity' in updates) {
      const val = Number(updates['package_quantity'])
      if (isNaN(val) || val <= 0) {
        return res.status(400).json({ error: 'package_quantity must be a positive number' })
      }
      updates['package_quantity'] = val
    }
    if ('Amount' in updates) {
      const val = Number(updates['Amount'])
      if (isNaN(val) || val < 0) {
        return res.status(400).json({ error: 'Amount must be a non-negative number' })
      }
      updates['Amount'] = val
    }

    if ('cost_centre' in updates && updates.cost_centre) {
      updates.cost_centre = updates.cost_centre.toString().toLowerCase()
    }

    // Prevent clearing required fields
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
    if (!data) return res.status(404).json({ error: 'Courier log not found' })

    return res.json({ log: data })
  } catch (err) {
    console.error('PATCH domestic_courier_logs_outwards/:id error:', err)
    return res.status(500).json({ error: 'Failed to update courier log' })
  }
})

// DELETE /logistics/courier-logs/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from(TABLE)
      .update({ is_archive: true, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)

    if (error) throw error

    return res.json({ success: true })
  } catch (err) {
    console.error('DELETE domestic_courier_logs_outwards/:id error:', err)
    return res.status(500).json({ error: 'Failed to delete courier log' })
  }
})

module.exports = router
