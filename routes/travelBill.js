const express = require('express')
const upload = require('../upload')
const supabase = require('../supabaseClient')

const router = express.Router()

router.post(
  '/upload-travel-bill',
  upload.single('billFile'),
  async (req, res) => {
    let filePath = null
    const BUCKET_NAME = 'TRAVEL BILL FY26'

    try {
      const { travelDate, comments, shopifyCustomerId, amount } = req.body
      const file = req.file

      // file is now optional — only date, comments, email, amount required
      if (!travelDate || !comments || !shopifyCustomerId || !amount) {
        return res.status(400).json({ error: 'Missing required fields' })
      }

      const parsedAmount = parseFloat(amount)
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' })
      }

      // Find member
      const { data: member, error: memberError } = await supabase
        .from('organization_members')
        .select('id')
        .eq('shopify_customer_id', shopifyCustomerId)
        .single()

      if (memberError || !member) {
        return res.status(404).json({ error: 'Organization member not found' })
      }

      const organizationMemberId = member.id

      // Upload file only if provided
      if (file) {
        const dateObj = new Date(travelDate)
        const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
        const month = months[dateObj.getMonth()]
        const day = String(dateObj.getDate()).padStart(2, '0')
        const safeName = file.originalname.replace(/\s+/g, '_')
        filePath = `${month}/${day}/travel_${Date.now()}_${safeName}`

        const { error: uploadError } = await supabase.storage
          .from(BUCKET_NAME)
          .upload(filePath, file.buffer, {
            contentType: file.mimetype,
            upsert: false
          })

        if (uploadError) throw uploadError
      }

      // Insert
      const { data, error: insertError } = await supabase
        .from('travel_bill_request')
        .insert([{
          organization_member_id: organizationMemberId,
          travel_bill_date: travelDate,
          travel_bill_url: filePath || null,  // null if no file
          travel_bill_comment: comments,
          amount: parsedAmount,
          status: 'pending'                   // add this column to your table
        }])
        .select()
        .single()

      if (insertError) throw insertError

      return res.json({
        success: true,
        travelBillId: data.id,
        message: 'Travel bill submitted successfully'
      })

    } catch (err) {
      console.error('Travel Bill Upload Error:', err)

      if (filePath) {
        await supabase.storage.from(BUCKET_NAME).remove([filePath])
      }

      return res.status(500).json({
        error: err.message || 'Travel bill upload failed'
      })
    }
  }
)

router.get('/travel-bills', async (req, res) => {
  try {
    const { shopifyCustomerId } = req.query

    if (!shopifyCustomerId) {
      return res.status(400).json({ error: 'shopifyCustomerId required' })
    }

    const { data: member } = await supabase
      .from('organization_members')
      .select('id')
      .eq('shopify_customer_id', shopifyCustomerId) 
      .single()

    if (!member) {
      return res.status(404).json({ error: 'Member not found' })
    }

    const { data, error } = await supabase
      .from('travel_bill_request')
      .select('*')
      .eq('organization_member_id', member.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.json({ bills: data })

  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Failed to fetch travel bills' })
  }
})

module.exports = router