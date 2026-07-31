const express = require('express')
const axios = require('axios')
const { Resend } = require('resend')
const { PhoneNumberUtil, PhoneNumberFormat } = require('google-libphonenumber')
const supabase = require('../supabaseClient')
const { requireAuth,requireOrgAdmin,requireSuperAdmin } = require('../middleware/auth')
const { buildSignedNdaPdf } = require('../service/ndaPdfService')

const dotenv = require("dotenv");
dotenv.config();



const router = express.Router()
const resend = new Resend(process.env.RESEND_KEY)
const phoneUtil = PhoneNumberUtil.getInstance()

const {
  SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN,
  ADMIN_EMAIL, RESEND_FROM_EMAIL, FRONTEND_URL
} = process.env

// ─────────────────────────────────────────────
// Free email domains
// ─────────────────────────────────────────────
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'icloud.com', 'live.com', 'aol.com', 'protonmail.com',
  'mail.com', 'yandex.com', 'gmx.com'
])

function extractDomain(email) {
  return email.split('@')[1]?.toLowerCase() || null
}

// ─────────────────────────────────────────────
// Phone validation
// ─────────────────────────────────────────────
const countryToPhoneCode = {
  'United States': 'US', 'Canada': 'CA', 'United Kingdom': 'GB',
  'Germany': 'DE', 'France': 'FR', 'Australia': 'AU', 'Japan': 'JP',
  'India': 'IN', 'China': 'CN', 'Brazil': 'BR', 'Mexico': 'MX', 'Other': 'US'
}

function validatePhoneNumber(phoneNumber, countryCode) {
  if (!phoneNumber || !phoneNumber.trim()) {
    return { isValid: true, formattedNumber: '' }
  }
  try {
    const number = phoneUtil.parseAndKeepRawInput(phoneNumber, countryCode)
    const isValid = phoneUtil.isValidNumber(number)
    if (!isValid) return { isValid: false, error: 'Invalid phone number format' }
    return { isValid: true, formattedNumber: phoneUtil.format(number, PhoneNumberFormat.INTERNATIONAL) }
  } catch {
    return { isValid: false, error: 'Invalid phone number format' }
  }
}

// ─────────────────────────────────────────────
// Shopify metafields (kept for transition period)
// ─────────────────────────────────────────────
async function updateShopifyMetafields(metafieldsPayload) {
  const query = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value namespace type }
        userErrors { field message code }
      }
    }
  `
  const response = await axios({
    method: 'POST',
    url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN
    },
    data: { query, variables: { metafields: metafieldsPayload } }
  })
  return response.data
}

// ─────────────────────────────────────────────
// Helper: create org + owner member
// Org is created with status = 'pending' — needs super-admin approval
// ─────────────────────────────────────────────
async function createOrgAndOwner({
  userId, email, orgEmail, fullName, jobTitle, orgName, orgType,
  country, phone, domain, numberOfEmployees,
  retailerType, supplierType, businessRegistration,
  categories = [],
  cin, udyam, msme, isi, iec, bankAccountNumber, bankIfsc,
  pincode, address, ownerName, ownerEmail, ownerPhone, reasonForContact, logoUrl,
  ndaAccepted, ndaSignatureName, ndaSignatureType, ndaSignatureImage, ndaIp
}) {
  // 1. Create organization — pending until super-admin approves
  const websiteDomain = domain ? extractDomain(domain) : null

  const orgInsert = {
    name: orgName,
    display_name: orgName,
    type: orgType,
    email: (orgEmail || email).toLowerCase().trim(),
    country,
    phone_no: phone || null,
    domain: websiteDomain,
    website: domain || null,
    no_of_employees: numberOfEmployees || null,
    no_of_members: 1,
    status: 'pending'
  }

  if (orgType === 'supplier') {
    Object.assign(orgInsert, {
      zip: pincode || null,
      address: address || null,
      owner_name: ownerName || null,
      owner_email: ownerEmail || null,
      owner_phone: ownerPhone || null,
      reason_for_contact: reasonForContact || null,
      logo_url: logoUrl || null,
      nda_accepted: !!ndaAccepted,
      nda_signature_name: ndaSignatureName || null,
      nda_signature_type: ndaSignatureType || null,
      nda_signature_image: ndaSignatureImage || null,
      nda_accepted_at: ndaAccepted ? new Date().toISOString() : null,
      nda_ip_address: ndaIp || null
    })
  }

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .insert([orgInsert])
    .select()
    .single()

  if (orgError) throw new Error(`Failed to create organization: ${orgError.message}`)

  // 2. Type-specific details row
  if (orgType === 'buyer') {
    const { error: buyerDetailsError } = await supabase.from('buyer_details').insert([{
      organization_id: org.id,
      retailer_type: retailerType || null,
      no_of_employees: numberOfEmployees || null,
      website: domain || null,
    }])
    if (buyerDetailsError) throw new Error(`Failed to create buyer details: ${buyerDetailsError.message}`)
  } else if (orgType === 'supplier') {
    const { error: supplierDetailsError } = await supabase.from('supplier_details').insert([{
      organization_id: org.id,
      gst_number: businessRegistration || null,
      supplier_type: supplierType || null,
      no_of_employees: numberOfEmployees || null,
      website: domain || null,
      cin_no: cin || null,
      udyam_no: udyam || null,
      msme_no: msme || null,
      isi_code: isi || null,
      iec_code: iec || null,
      bank_account_number: bankAccountNumber || null,
      bank_ifsc_code: bankIfsc || null,
    }])
    if (supplierDetailsError) throw new Error(`Failed to create supplier details: ${supplierDetailsError.message}`)
    if (categories.length > 0) {
      const { error: categoriesError } = await supabase.from('supplier_categories').insert(
        categories.map(categoryId => ({ supplier_org_id: org.id, category_id: categoryId }))
      )
      if (categoriesError) throw new Error(`Failed to save supplier categories: ${categoriesError.message}`)
    }
  }
 
  // 3. Create owner member row
  const { data: member, error: memberError } = await supabase
    .from('organization_members')
    .insert([{
      organization_id: org.id,
      full_name: fullName,
      email: email.toLowerCase().trim(),
      role: 'owner',
      user_id: userId,
      job_title: jobTitle || null
    }])
    .select()
    .single()
 
  if (memberError) throw new Error(`Failed to create org member: ${memberError.message}`)
 
  return { org, member }
}
 
// ─────────────────────────────────────────────
// Helper: notify super-admin of a new pending org
// ─────────────────────────────────────────────
async function notifyAdminNewOrg(orgData, submitterEmail) {
  try {
    const dashboardUrl = `${FRONTEND_URL}/dashboard/approvals?tab=orgs`
    await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: ADMIN_EMAIL,
      subject: `New org pending approval - ${orgData.business_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
          <h2 style="color:#1a1a1a;">New organisation pending approval</h2>
          <table style="width:100%;border-collapse:collapse;margin:24px 0;">
            <tr><td style="padding:8px 0;color:#8e8e8e;font-size:13px;">Name</td><td style="padding:8px 0;font-weight:600;">${orgData.customer_name}</td></tr>
            <tr><td style="padding:8px 0;color:#8e8e8e;font-size:13px;">Email</td><td style="padding:8px 0;">${submitterEmail}</td></tr>
            <tr><td style="padding:8px 0;color:#8e8e8e;font-size:13px;">Company</td><td style="padding:8px 0;">${orgData.business_name}</td></tr>
            <tr><td style="padding:8px 0;color:#8e8e8e;font-size:13px;">Role</td><td style="padding:8px 0;">${orgData.customer_role}</td></tr>
            <tr><td style="padding:8px 0;color:#8e8e8e;font-size:13px;">Country</td><td style="padding:8px 0;">${orgData.country}</td></tr>
            <tr><td style="padding:8px 0;color:#8e8e8e;font-size:13px;">Employees</td><td style="padding:8px 0;">${orgData.number_of_employees}</td></tr>
            <tr><td style="padding:8px 0;color:#8e8e8e;font-size:13px;">Website</td><td style="padding:8px 0;">${orgData.domain_name || '-'}</td></tr>
          </table>
          <a href="${dashboardUrl}"
             style="background:#1a1a1a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
            Review in dashboard
          </a>
          <p style="color:#8e8e8e;font-size:13px;margin-top:24px;">Submitted: ${new Date().toLocaleString()}</p>
        </div>
      `
    })
  } catch (err) {
    console.error('Failed to send admin org notification:', err.message)
  }
}

// ─────────────────────────────────────────────
// Helper: email the vendor a copy of their signed application (org details + NDA)
// ─────────────────────────────────────────────
async function sendVendorApplicationCopy({ toEmail, application, signatureName, signedAt, ip }) {
  try {
    const signedDate = new Date(signedAt).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    })
    const businessName = application.business_name
    const row = (label, value) =>
      `<tr><td style="padding:6px 0;color:#8e8e8e;width:180px;">${label}</td><td style="padding:6px 0;">${value || '-'}</td></tr>`

    const { data, error } = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: toEmail,
      subject: `Your submitted application & signed NDA - Twif Technologies Private Limited`,
      html: `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto;padding:40px 20px;color:#1a1a1a;">
          <h2 style="margin-bottom:4px;">Application submitted for review</h2>
          <p style="color:#8e8e8e;font-size:13px;margin-top:0;">This is your copy of the details you submitted to Twif Technologies Private Limited ("Twif") as part of vendor onboarding.</p>

          <h3 style="margin-bottom:8px;">Personal &amp; business info</h3>
          <table style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:13px;">
            ${row('Full name', application.customer_name)}
            ${row('Phone', application.customer_phone)}
            ${row('Country', application.country)}
            ${row('Company name', businessName)}
            ${row('Website', application.domain_name)}
            ${row('Employees', application.number_of_employees)}
            ${row('Business type', application.supplier_type)}
          </table>

          <h3 style="margin-bottom:8px;">Business &amp; compliance details</h3>
          <table style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:13px;">
            ${row('GST No.', application.business_registration)}
            ${row('CIN No.', application.cin_no)}
            ${row('Udyam No.', application.udyam_no)}
            ${row('MSME No.', application.msme_no)}
            ${row('ISI code', application.isi_code)}
            ${row('Bank account number', application.bank_account_number)}
            ${row('IFSC code', application.bank_ifsc_code)}
            ${row('Address', application.address)}
            ${row('Owner / Director name', application.owner_name)}
            ${row('Owner / Director email', application.owner_email)}
            ${row('Owner / Director phone', application.owner_phone)}
            ${row('Reason for contact', application.reason_for_contact)}
            ${row('Vendor logo', application.logo_url)}
          </table>

          <h2 style="margin-bottom:4px;">Master Non-Disclosure, Non-Circumvention &amp; Non-Solicitation Agreement</h2>
          <p style="color:#8e8e8e;font-size:13px;margin-top:0;">Vendor Confidentiality &amp; Business Protection Agreement</p>

          <p>This confirms that <strong>${businessName}</strong> has electronically signed the Agreement below as part of vendor onboarding with Twif.</p>

          <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:13px;">
            <tr><td style="padding:6px 0;color:#8e8e8e;width:160px;">Signed by</td><td style="padding:6px 0;font-weight:600;">${signatureName}</td></tr>
            <tr><td style="padding:6px 0;color:#8e8e8e;">On behalf of</td><td style="padding:6px 0;">${businessName}</td></tr>
            <tr><td style="padding:6px 0;color:#8e8e8e;">Date &amp; time</td><td style="padding:6px 0;">${signedDate}</td></tr>
            <tr><td style="padding:6px 0;color:#8e8e8e;">IP address</td><td style="padding:6px 0;">${ip || '-'}</td></tr>
          </table>

          <h3 style="margin-bottom:8px;">Declarations accepted</h3>
          <ul style="font-size:13px;line-height:1.6;color:#333;">
            <li>I have read and understood this Agreement, including all schedule and annexure.</li>
            <li>I confirm I am authorized to sign on behalf of my organization.</li>
          </ul>

          <h3 style="margin-bottom:8px;">Summary of key terms</h3>
          <p style="font-size:13px;line-height:1.6;color:#333;">
            By submitting this application, the Vendor agrees to keep all buyer identities, product
            developments, designs, samples, pricing, and other business information shared by Twif
            strictly confidential, and to use it solely for executing Twif business. For a period of
            five (5) years following the termination or expiration of the relationship with Twif, the
            Vendor agrees not to directly or indirectly contact, solicit, quote, supply, negotiate, or
            otherwise engage with any buyer introduced by Twif, nor divert any business away from
            Twif-introduced clients, irrespective of whether orders are active, sampling has commenced,
            or discussions are ongoing. All buyer-exclusive designs, samples, packaging, and product
            concepts shall remain strictly confidential and may not be shown to other customers, sold,
            supplied, displayed, marketed, or used in exhibitions, catalogues, websites, social media,
            or any other medium without Twif's prior written approval. All intellectual property
            developed in connection with Twif shall remain the exclusive property of the Buyer or Twif.
            The Vendor acknowledges that any breach of this Agreement shall entitle Twif to immediate
            termination of the relationship, suspension of orders, injunctive relief, recovery of
            damages, and legal expenses.
          </p>

          <p style="color:#8e8e8e;font-size:12px;margin-top:32px;">
            This email serves as your copy of record for the application and electronic signature
            submitted during vendor registration on the Twif Portal.
          </p>
        </div>
      `
    })

    if (error) {
      console.error(`❌ Resend rejected vendor application copy to ${toEmail}:`, error)
      return { success: false, error: error.message || String(error) }
    }

    console.log(`✅ Vendor application copy sent to ${toEmail} (id: ${data?.id})`)
    return { success: true }
  } catch (err) {
    console.error('❌ Failed to send vendor application copy:', err.message)
    return { success: false, error: err.message }
  }
}

// ─────────────────────────────────────────────
// Helper: notify org admin of a new join request
// ─────────────────────────────────────────────
async function notifyOrgAdminJoinRequest({ orgAdmin, orgDisplayName, fullName, normalizedEmail, joinRequestId }) {
  try {
    const dashboardUrl = `${FRONTEND_URL}/dashboard/approvals?tab=members&id=${joinRequestId}`
    await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: orgAdmin.email,
      subject: `New member request for ${orgDisplayName}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
          <h2 style="color:#1a1a1a;">New member request</h2>
          <p style="color:#586069;">
            <strong>${fullName}</strong> (${normalizedEmail}) has requested to join
            <strong>${orgDisplayName}</strong>.
          </p>
          <a href="${dashboardUrl}"
             style="background:#1a1a1a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
            Review in dashboard
          </a>
          <p style="color:#8e8e8e;font-size:13px;margin-top:24px;">
            Sign in to your portal to approve or reject this request.
          </p>
        </div>
      `
    })
  } catch (err) {
    console.error('Failed to notify org admin:', err.message)
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /customers/categories — public
// ─────────────────────────────────────────────
router.get('/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('id, name')
      .order('name', { ascending: true })

    if (error) throw error
    return res.json({ success: true, data })
  } catch (err) {
    console.error('GET /categories error:', err.message)
    return res.status(500).json({ error: 'Failed to fetch categories' })
  }
})

// ─────────────────────────────────────────────
// GET /customers/org-lookup
// Query: ?domain=ikea.com&type=buyer
// Identity from JWT
//
// Status logic:
//   null     = ERP-imported org, no members yet  -> caller can claim as owner
//   'active' = live org -> join request if has members, claim if no members
//   'pending' = created via portal, awaiting super-admin approval -> block
// ─────────────────────────────────────────────
router.get('/org-lookup', requireAuth, async (req, res) => {
  try {
    const { domain, type } = req.query
    const { id: userId, email } = req.user

    if (!domain || !type) {
      return res.status(400).json({ error: 'Missing required fields: domain, type' })
    }

    if (FREE_EMAIL_DOMAINS.has(domain.toLowerCase())) {
      return res.json({ found: false, reason: 'free_email' })
    }

    const emailDomain = extractDomain(email)
    if (emailDomain !== domain.toLowerCase()) {
      return res.status(400).json({ error: 'Domain does not match your verified email' })
    }

    // Fetch org regardless of status so we handle each case explicitly
    const { data: org, error } = await supabase
      .from('organizations')
      .select('id, name, display_name, type, country, status')
      .eq('domain', domain.toLowerCase())
      .eq('type', type)
      .maybeSingle()

    if (error) throw error
    if (!org) return res.json({ found: false })

    // Created via portal but not yet approved by super-admin
    if (org.status === 'pending') {
      return res.json({
        found: true,
        pendingApproval: true,
        org: { id: org.id, displayName: org.display_name || org.name, type: org.type }
      })
    }

    // Check if caller is already a member
    const { data: existingMember } = await supabase
      .from('organization_members')
      .select('id, role')
      .eq('organization_id', org.id)
      .eq('user_id', userId)
      .maybeSingle()

    if (existingMember) {
      return res.json({
        found: true,
        alreadyMember: true,
        org: { id: org.id, displayName: org.display_name || org.name, type: org.type }
      })
    }

    // Count members to decide: claim ownership vs submit join request
    const { count: memberCount } = await supabase
      .from('organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', org.id)

    // No members yet — ERP org never claimed, caller becomes owner
    if (memberCount === 0) {
      return res.json({
        found: true,
        claimable: true,
        org: { id: org.id, displayName: org.display_name || org.name, type: org.type, country: org.country }
      })
    }

    // Has members — check for existing pending join request
    const { data: existingRequest } = await supabase
      .from('join_requests')
      .select('id, status')
      .eq('organization_id', org.id)
      .eq('user_id', userId)
      .maybeSingle()

    if (existingRequest) {
      return res.json({
        found: true,
        alreadyRequested: true,
        requestStatus: existingRequest.status,
        org: { id: org.id, displayName: org.display_name || org.name, type: org.type, country: org.country }
      })
    }

    // Normal join request path
    return res.json({
      found: true,
      claimable: false,
      alreadyRequested: false,
      alreadyMember: false,
      org: { id: org.id, displayName: org.display_name || org.name, type: org.type, country: org.country }
    })

  } catch (err) {
    console.error('Org lookup error:', err)
    return res.status(500).json({ error: err.message || 'Lookup failed' })
  }
})

// ─────────────────────────────────────────────
// POST /customers/claim-org
// Submit a claim request for an unclaimed ERP org (no members)
// Stored as type='claim' in join_requests
// Super-admin approves/rejects from /dashboard/approvals
// Body: { organizationId, fullName }
// ─────────────────────────────────────────────
router.post('/claim-org', requireAuth, async (req, res) => {
  try {
    const { organizationId, fullName } = req.body
    const { id: userId, email } = req.user

    if (!organizationId || !fullName) {
      return res.status(400).json({ error: 'Missing required fields: organizationId, fullName' })
    }

    const normalizedEmail = email.toLowerCase().trim()

    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('id, name, display_name, domain, type, status')
      .eq('id', organizationId)
      .single()

    if (orgError || !org) return res.status(404).json({ error: 'Organization not found' })

    // Block if already a portal-created org pending approval
    if (org.status === 'pending') {
      return res.status(400).json({ error: 'This organisation is pending approval and cannot be claimed' })
    }

    // Validate email domain
    const emailDomain = extractDomain(normalizedEmail)
    if (emailDomain !== org.domain) {
      return res.status(403).json({ error: 'Your email domain does not match this organization' })
    }

    // Race condition guard — re-check no members appeared since the lookup
    const { count: memberCount } = await supabase
      .from('organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)

    if (memberCount > 0) {
      return res.status(409).json({
        error: 'This organisation already has members. Please submit a join request instead.',
        shouldJoin: true
      })
    }

    // Check for an existing pending claim from this user
    const { data: existingClaim } = await supabase
      .from('join_requests')
      .select('id, status')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .eq('type', 'claim')
      .maybeSingle()

    if (existingClaim) {
      return res.status(409).json({
        error: `You already have a ${existingClaim.status} claim request for this organisation.`
      })
    }

    // Insert claim request — type='claim', pending super-admin review
    const { data: claimRequest, error: insertError } = await supabase
      .from('join_requests')
      .insert([{
        organization_id: organizationId,
        user_id: userId,
        full_name: fullName,
        email: normalizedEmail,
        requested_role: 'owner',
        status: 'pending',
        type: 'claim'
      }])
      .select()
      .single()

    if (insertError) throw insertError

    const orgDisplayName = org.display_name || org.name
    const dashboardUrl = `${FRONTEND_URL}/dashboard/approvals?tab=claims&id=${claimRequest.id}`

    // Notify super-admin
    try {
      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: ADMIN_EMAIL,
        subject: `[Claim Request] ${fullName} wants to claim ${orgDisplayName}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
            <h2 style="color:#1a1a1a;">New ownership claim request</h2>
            <p style="color:#586069;">
              <strong>${fullName}</strong> (${normalizedEmail}) has requested to claim
              <strong>${orgDisplayName}</strong> as owner.
              This organisation has no existing members.
            </p>
            <table style="width:100%;border-collapse:collapse;margin:24px 0;">
              <tr><td style="padding:8px 0;color:#8e8e8e;font-size:13px;">Organisation</td><td style="padding:8px 0;font-weight:600;">${orgDisplayName}</td></tr>
              <tr><td style="padding:8px 0;color:#8e8e8e;font-size:13px;">Type</td><td style="padding:8px 0;">${org.type}</td></tr>
              <tr><td style="padding:8px 0;color:#8e8e8e;font-size:13px;">Claimant</td><td style="padding:8px 0;">${fullName}</td></tr>
              <tr><td style="padding:8px 0;color:#8e8e8e;font-size:13px;">Email</td><td style="padding:8px 0;">${normalizedEmail}</td></tr>
            </table>
            <a href="${dashboardUrl}"
               style="background:#1a1a1a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
              Review in dashboard
            </a>
          </div>
        `
      })
    } catch (emailErr) {
      console.error('Failed to notify admin of claim request:', emailErr.message)
    }

    return res.json({
      success: true,
      message: 'Your claim request has been submitted. You will be notified once approved.',
      data: { requestId: claimRequest.id, status: 'pending' }
    })

  } catch (err) {
    console.error('Claim org error:', err)
    return res.status(500).json({ error: err.message || 'Failed to submit claim request' })
  }
})

// ─────────────────────────────────────────────
// POST /customers/join-request
// Member joining an existing org — approved by org's owner/admin
// Body: { fullName, organizationId }
// ─────────────────────────────────────────────
router.post('/join-request', requireAuth, async (req, res) => {
  try {
    const { fullName, organizationId } = req.body
    const { id: userId, email } = req.user

    if (!fullName || !organizationId) {
      return res.status(400).json({ error: 'Missing required fields: fullName, organizationId' })
    }

    const normalizedEmail = email.toLowerCase().trim()

    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('id, name, display_name, domain, type, status')
      .eq('id', organizationId)
      .single()

    if (orgError || !org) return res.status(404).json({ error: 'Organization not found' })
    if (org.status !== 'active') return res.status(400).json({ error: 'Organization is not active' })

    const emailDomain = extractDomain(normalizedEmail)
    if (emailDomain !== org.domain) {
      return res.status(403).json({ error: 'Your email domain does not match this organization' })
    }

    const { data: joinRequest, error: insertError } = await supabase
      .from('join_requests')
      .insert([{
        organization_id: organizationId,
        user_id: userId,
        full_name: fullName,
        email: normalizedEmail,
        requested_role: 'member',
        status: 'pending'
      }])
      .select()
      .single()

    if (insertError) throw insertError

    const orgDisplayName = org.display_name || org.name

    // Notify all owners/admins of that org
    const { data: orgAdmins } = await supabase
      .from('organization_members')
      .select('email, full_name')
      .eq('organization_id', organizationId)
      .in('role', ['owner', 'admin'])

    if (orgAdmins?.length) {
      await Promise.allSettled(
        orgAdmins.map(admin =>
          notifyOrgAdminJoinRequest({ orgAdmin: admin, orgDisplayName, fullName, normalizedEmail, joinRequestId: joinRequest.id })
        )
      )
    }

    return res.json({ success: true, requestId: joinRequest.id })

  } catch (err) {
    console.error('Join request error:', err)
    return res.status(500).json({ error: err.message || 'Failed to submit join request' })
  }
})

// ─────────────────────────────────────────────
// PATCH /customers/join-request/:id/approve
//
// type='member' -> org's owner/admin approves
//   Creates member row, increments org member count
//
// type='claim'  -> super-admin approves
//   Creates owner member row, activates org
// ─────────────────────────────────────────────
router.patch('/join-request/:id/approve', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const { id: userId } = req.user

    const { data: joinRequest, error: fetchError } = await supabase
      .from('join_requests')
      .select('*, organizations(id, name, display_name, type, status)')
      .eq('id', id)
      .single()

    if (fetchError || !joinRequest) return res.status(404).json({ error: 'Join request not found' })
    if (joinRequest.status !== 'pending') return res.status(400).json({ error: `Request already ${joinRequest.status}` })

    const isClaim = joinRequest.type === 'claim'

    if (isClaim) {
      // Only super-admin can approve claim requests
      const { data: adminRow } = await supabase
        .from('organization_members')
        .select('id')
        .eq('user_id', userId)
        .eq('role', 'admin')
        .maybeSingle()

      if (!adminRow) {
        return res.status(403).json({ error: 'Only a super-admin can approve ownership claim requests' })
      }

      // Re-check no members appeared while request was pending
      const { count: memberCount } = await supabase
        .from('organization_members')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', joinRequest.organization_id)

      if (memberCount > 0) {
        return res.status(409).json({
          error: 'This organisation now has members and cannot be claimed. Reject this request.'
        })
      }

      // Create owner member row
      const { error: memberInsertError } = await supabase
        .from('organization_members')
        .insert([{
          organization_id: joinRequest.organization_id,
          full_name: joinRequest.full_name,
          email: joinRequest.email,
          role: 'owner',
          user_id: joinRequest.user_id
        }])

      if (memberInsertError) throw new Error(`Failed to create owner member: ${memberInsertError.message}`)

      // Activate the org and set member count to 1
      await supabase
        .from('organizations')
        .update({ status: 'active', no_of_members: 1 })
        .eq('id', joinRequest.organization_id)

      await supabase
        .from('join_requests')
        .update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: adminRow.id })
        .eq('id', id)

      const orgDisplayName = joinRequest.organizations.display_name || joinRequest.organizations.name

      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: joinRequest.email,
        subject: `Your ownership claim has been approved - ${orgDisplayName}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
            <h2 style="color:#1a1a1a;">Claim approved!</h2>
            <p style="color:#586069;margin-bottom:24px;">
              Your request to claim <strong>${orgDisplayName}</strong> has been approved.
              You are now the owner and have full access to your portal.
            </p>
            <a href="${FRONTEND_URL}/dashboard"
               style="background:#1a1a1a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Go to your dashboard
            </a>
          </div>
        `
      })

      return res.json({ success: true, message: 'Ownership claim approved successfully' })

    } else {
      // type='member' — org's owner/admin approves
      const isOrgAdmin = await requireOrgAdmin(joinRequest.organization_id, userId)
      if (!isOrgAdmin) {
        return res.status(403).json({ error: 'Only an admin or owner of this organization can approve join requests' })
      }

      // Get reviewer's member row id for audit
      const { data: reviewer } = await supabase
        .from('organization_members')
        .select('id')
        .eq('organization_id', joinRequest.organization_id)
        .eq('user_id', userId)
        .single()

      const { error: memberInsertError } = await supabase
        .from('organization_members')
        .insert([{
          organization_id: joinRequest.organization_id,
          full_name: joinRequest.full_name,
          email: joinRequest.email,
          role: 'member',
          user_id: joinRequest.user_id
        }])

      if (memberInsertError) throw new Error(`Failed to create member: ${memberInsertError.message}`)

      await supabase
        .from('join_requests')
        .update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: reviewer?.id || null })
        .eq('id', id)

      // Increment member count
      await supabase.rpc('increment_org_members', { org_id: joinRequest.organization_id })

      const orgDisplayName = joinRequest.organizations.display_name || joinRequest.organizations.name

      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: joinRequest.email,
        subject: `You've been approved - welcome to ${orgDisplayName}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
            <h2 style="color:#1a1a1a;">You're in!</h2>
            <p style="color:#586069;margin-bottom:24px;">
              Your request to join <strong>${orgDisplayName}</strong> has been approved.
              You now have full access to your portal.
            </p>
            <a href="${FRONTEND_URL}/dashboard"
               style="background:#1a1a1a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Go to your dashboard
            </a>
          </div>
        `
      })

      return res.json({ success: true, message: 'Member approved successfully' })
    }

  } catch (err) {
    console.error('Approve request error:', err)
    return res.status(500).json({ error: err.message || 'Approval failed' })
  }
})

// ─────────────────────────────────────────────
// PATCH /customers/join-request/:id/reject
//
// type='member' -> org's owner/admin rejects
// type='claim'  -> super-admin rejects
// Body: { reason? }
// ─────────────────────────────────────────────
router.patch('/join-request/:id/reject', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const { reason } = req.body
    const { id: userId } = req.user

    const { data: joinRequest, error: fetchError } = await supabase
      .from('join_requests')
      .select('*, organizations(name, display_name)')
      .eq('id', id)
      .single()

    if (fetchError || !joinRequest) return res.status(404).json({ error: 'Join request not found' })
    if (joinRequest.status !== 'pending') return res.status(400).json({ error: `Request already ${joinRequest.status}` })

    const isClaim = joinRequest.type === 'claim'

    if (isClaim) {
      // Only super-admin can reject claim requests
      const { data: adminRow } = await supabase
        .from('organization_members')
        .select('id')
        .eq('user_id', userId)
        .eq('role', 'admin')
        .maybeSingle()

      if (!adminRow) {
        return res.status(403).json({ error: 'Only a super-admin can reject ownership claim requests' })
      }
    } else {
      // type='member' — must be org owner/admin
      const isOrgAdmin = await requireOrgAdmin(joinRequest.organization_id, userId)
      if (!isOrgAdmin) {
        return res.status(403).json({ error: 'Only an admin or owner of this organization can reject join requests' })
      }
    }

    await supabase
      .from('join_requests')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString(), rejection_reason: reason || null })
      .eq('id', id)

    const orgDisplayName = joinRequest.organizations.display_name || joinRequest.organizations.name

    const subjectLine = isClaim
      ? `Update on your ownership claim for ${orgDisplayName}`
      : `Update on your request to join ${orgDisplayName}`

    const bodyText = isClaim
      ? `Your request to claim <strong>${orgDisplayName}</strong> as owner was not approved at this time.`
      : `Your request to join <strong>${orgDisplayName}</strong> was not approved at this time.`

    await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: joinRequest.email,
      subject: subjectLine,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
          <h2 style="color:#1a1a1a;">Request update</h2>
          <p style="color:#586069;">
            ${bodyText}
            ${reason ? `<br><br>Reason: ${reason}` : ''}
          </p>
          <p style="color:#8e8e8e;font-size:13px;margin-top:24px;">
            If you believe this is a mistake, please reply to this email.
          </p>
        </div>
      `
    })

    return res.json({ success: true, message: 'Request rejected' })

  } catch (err) {
    console.error('Reject request error:', err)
    return res.status(500).json({ error: err.message || 'Rejection failed' })
  }
})

// ─────────────────────────────────────────────
// GET /customers/join-requests/pending
//
// Super-admin sees all pending requests (both 'member' and 'claim' types)
// Org owner/admin sees only 'member' type requests for their own orgs
//   (claim requests are never shown to org-level admins)
// ─────────────────────────────────────────────
// GET /customers/join-requests/pending
//
// Super-admin sees all pending requests (both 'member' and 'claim' types)
// Org owner/admin sees only 'member' type requests for their own orgs
//   (claim requests are never shown to org-level admins)
// ─────────────────────────────────────────────
router.get('/join-requests/pending', requireAuth, async (req, res) => {
  try {
    const { id: userId } = req.user
 
    // Check if super-admin (owner or admin of a merchant org)
    const { data: adminRow } = await supabase
      .from('organization_members')
      .select('id, organizations!inner(type)')
      .eq('user_id', userId)
      .in('role', ['admin', 'owner'])
      .eq('organizations.type', 'merchant')
      .maybeSingle()
 
    if (adminRow) {
      // Super-admin — return all pending requests of both types
      const { data, error } = await supabase
        .from('join_requests')
        .select(`
          id, full_name, email, requested_at, status, type, user_id,
          organizations ( id, name, display_name, type, country )
        `)
        .eq('status', 'pending')
        .order('requested_at', { ascending: false })
 
      if (error) throw error
      return res.json({ success: true, data })
    }
 
    // Org-level admin — only 'member' type requests for orgs they manage
    const { data: managedOrgs } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', userId)
      .in('role', ['owner', 'admin'])
 
    const orgIds = managedOrgs?.map(r => r.organization_id) || []
    if (orgIds.length === 0) return res.json({ success: true, data: [] })
 
    const { data, error } = await supabase
      .from('join_requests')
      .select(`
        id, full_name, email, requested_at, status, type, user_id,
        organizations ( id, name, display_name, type, country )
      `)
      .eq('status', 'pending')
      .eq('type', 'member')
      .in('organization_id', orgIds)
      .order('requested_at', { ascending: false })
 
    if (error) throw error
    return res.json({ success: true, data })
 
  } catch (err) {
    console.error('Fetch pending requests error:', err)
    return res.status(500).json({ error: err.message || 'Failed to fetch requests' })
  }
})
// ─────────────────────────────────────────────
// GET /customers/orgs/pending
// Super-admin only — new orgs awaiting approval
// ─────────────────────────────────────────────
router.get('/orgs/pending', requireSuperAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('organizations')
      .select(`
        id, name, display_name, type, country, domain, created_on,
        address, owner_name, owner_email, owner_phone, reason_for_contact, logo_url,
        nda_accepted, nda_signature_name, nda_signature_type, nda_signature_image, nda_accepted_at,
        nda_verified_at, nda_verified_by,
        jng_signature_type, jng_signature_name, jng_signature_image,
        jng_signatory_name, jng_signatory_designation, jng_signed_at,
        organization_members ( id, full_name, email, role, user_id, job_title ),
        supplier_details ( gst_number, supplier_type, cin_no, udyam_no, msme_no, isi_code, iec_code, bank_account_number, bank_ifsc_code )
      `)
      .eq('status', 'pending')
      .order('created_on', { ascending: false })

    if (error) throw error
    return res.json({ success: true, data })

  } catch (err) {
    console.error('GET /orgs/pending error:', err.message)
    return res.status(500).json({ error: 'Failed to fetch pending orgs' })
  }
})

// ─────────────────────────────────────────────
// Shared: fetch the fields buildSignedNdaPdf() needs off an organization row
// ─────────────────────────────────────────────
const NDA_ORG_SELECT = `
  id, name, display_name, status, type, address, owner_name,
  nda_accepted, nda_signature_name, nda_signature_type, nda_signature_image,
  nda_accepted_at, nda_ip_address, created_on,
  nda_verified_at, nda_verified_by,
  jng_signature_type, jng_signature_name, jng_signature_image,
  jng_signatory_name, jng_signatory_designation, jng_signed_at
`

function adminSignatureFromOrg(org) {
  if (!org.jng_signed_at) return null
  return {
    full_name: org.jng_signatory_name,
    designation: org.jng_signatory_designation,
    signature_type: org.jng_signature_type,
    signature_name: org.jng_signature_name,
    signature_image: org.jng_signature_image,
    signed_at: org.jng_signed_at,
  }
}

// ─────────────────────────────────────────────
// GET /customers/orgs/:id/nda-preview
// Super-admin only — dry-run PDF using current data, no persistence. Lets the
// admin review the exact document before Verify/Sign/Approve. The Twif side
// renders as "not yet configured" until the Sign step has actually happened.
// ─────────────────────────────────────────────
router.get('/orgs/:id/nda-preview', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const { data: org, error } = await supabase.from('organizations').select(NDA_ORG_SELECT).eq('id', id).single()
    if (error || !org) return res.status(404).json({ error: 'Organization not found' })
    if (org.type !== 'supplier') return res.status(400).json({ error: 'Preview is only available for supplier NDAs' })

    const { data: owner } = await supabase
      .from('organization_members')
      .select('job_title')
      .eq('organization_id', id)
      .eq('role', 'owner')
      .single()

    const { data: activityLog } = await supabase
      .from('nda_activity_log')
      .select('event_type, actor_name, actor_email, ip_address, created_at')
      .eq('organization_id', id)
      .order('created_at', { ascending: true })

    const pdfBuffer = await buildSignedNdaPdf({
      organization: org,
      ownerJobTitle: owner?.job_title,
      adminSignature: adminSignatureFromOrg(org),
      activityLog: activityLog || []
    })

    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', 'inline; filename="nda-preview.pdf"')
    return res.send(pdfBuffer)
  } catch (err) {
    console.error('NDA preview generation failed:', err.message)
    return res.status(500).json({ error: 'Failed to generate preview' })
  }
})

// ─────────────────────────────────────────────
// PATCH /customers/orgs/:id/verify
// Super-admin confirms they've reviewed the NDA preview. Unlocks Sign.
// ─────────────────────────────────────────────
router.patch('/orgs/:id/verify', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const { data: org, error } = await supabase.from('organizations').select('id, status, type').eq('id', id).single()
    if (error || !org) return res.status(404).json({ error: 'Organization not found' })
    if (org.status !== 'pending') return res.status(400).json({ error: `Organization already ${org.status}` })
    if (org.type !== 'supplier') return res.status(400).json({ error: 'Verify only applies to supplier NDAs' })

    await supabase.from('organizations').update({
      nda_verified_at: new Date().toISOString(),
      nda_verified_by: req.user.email,
    }).eq('id', id)

    await supabase.from('nda_activity_log').insert([{
      organization_id: id, event_type: 'verified', actor_name: req.user.email, actor_email: req.user.email, ip_address: req.ip
    }])

    return res.json({ success: true })
  } catch (err) {
    console.error('Verify org error:', err)
    return res.status(500).json({ error: err.message || 'Verify failed' })
  }
})

// ─────────────────────────────────────────────
// PATCH /customers/orgs/:id/sign
// Super-admin countersigns on behalf of Twif — captured fresh for this specific
// approval (not a shared reusable signature). Requires Verify to have happened
// first. Unlocks Approve.
// ─────────────────────────────────────────────
router.patch('/orgs/:id/sign', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { signatory_name, designation, signature_type, signature_name, signature_image } = req.body

    const { data: org, error } = await supabase.from('organizations').select('id, status, type, nda_verified_at').eq('id', id).single()
    if (error || !org) return res.status(404).json({ error: 'Organization not found' })
    if (org.status !== 'pending') return res.status(400).json({ error: `Organization already ${org.status}` })
    if (org.type !== 'supplier') return res.status(400).json({ error: 'Sign only applies to supplier NDAs' })
    if (!org.nda_verified_at) return res.status(400).json({ error: 'You must verify the agreement before signing' })

    if (!signatory_name?.trim()) {
      return res.status(400).json({ error: 'Missing required field', details: 'Signatory name is required' })
    }
    if (!['typed', 'drawn', 'uploaded'].includes(signature_type)) {
      return res.status(400).json({ error: 'Invalid signature_type', details: 'Must be typed, drawn, or uploaded' })
    }
    if (signature_type === 'drawn' || signature_type === 'uploaded') {
      if (!signature_image?.trim()) {
        return res.status(400).json({
          error: 'Signature missing',
          details: signature_type === 'drawn' ? 'Please draw your signature' : 'Please upload your signature'
        })
      }
      if (!/^data:image\/(png|jpe?g);base64,/.test(signature_image.trim()) || signature_image.length > 3_000_000) {
        return res.status(400).json({ error: 'Invalid signature image', details: 'Signature image must be a valid PNG/JPEG data URL under ~2MB' })
      }
    } else if (!signature_name?.trim()) {
      return res.status(400).json({ error: 'Missing required field', details: 'Please type the signature text' })
    }

    const signedAt = new Date().toISOString()
    await supabase.from('organizations').update({
      jng_signature_type: signature_type,
      jng_signature_name: signature_type === 'typed' ? signature_name : null,
      jng_signature_image: signature_type === 'typed' ? null : signature_image,
      jng_signatory_name: signatory_name,
      jng_signatory_designation: designation || null,
      jng_signed_at: signedAt,
    }).eq('id', id)

    await supabase.from('nda_activity_log').insert([{
      organization_id: id, event_type: 'jng_countersigned', actor_name: signatory_name, actor_email: req.user.email, ip_address: req.ip
    }])

    return res.json({ success: true })
  } catch (err) {
    console.error('Sign org error:', err)
    return res.status(500).json({ error: err.message || 'Sign failed' })
  }
})

// ─────────────────────────────────────────────
// PATCH /customers/orgs/:id/approve
// Super-admin approves a new org — sets status to active
// ─────────────────────────────────────────────
router.patch('/orgs/:id/approve', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const { data: org, error: fetchError } = await supabase
      .from('organizations')
      .select(NDA_ORG_SELECT)
      .eq('id', id)
      .single()

    if (fetchError || !org) return res.status(404).json({ error: 'Organization not found' })
    if (org.status !== 'pending') return res.status(400).json({ error: `Organization already ${org.status}` })

    if (org.type === 'supplier') {
      if (!org.nda_verified_at) return res.status(400).json({ error: 'You must verify the agreement before approving' })
      if (!org.jng_signed_at) return res.status(400).json({ error: 'You must sign the agreement before approving' })
    }

    await supabase
      .from('organizations')
      .update({ status: 'active' })
      .eq('id', id)

    // Find the owner to notify
    const { data: owner } = await supabase
      .from('organization_members')
      .select('email, full_name, job_title')
      .eq('organization_id', id)
      .eq('role', 'owner')
      .single()

    const orgDisplayName = org.display_name || org.name

    let pdfAttachment = null

    if (org.type === 'supplier') {
      try {
        const { data: activityLog } = await supabase
          .from('nda_activity_log')
          .select('event_type, actor_name, actor_email, ip_address, created_at')
          .eq('organization_id', id)
          .order('created_at', { ascending: true })

        const pdfBuffer = await buildSignedNdaPdf({
          organization: org,
          ownerJobTitle: owner?.job_title,
          adminSignature: adminSignatureFromOrg(org),
          activityLog: activityLog || []
        })

        pdfAttachment = {
          filename: `${orgDisplayName} - NDA.pdf`,
          content: pdfBuffer.toString('base64'),
        }
      } catch (pdfErr) {
        // A PDF failure must never block the approval or the notification email.
        console.error('Failed to generate signed NDA PDF:', pdfErr.message)
        await resend.emails.send({
          from: RESEND_FROM_EMAIL,
          to: ADMIN_EMAIL,
          subject: `Signed NDA PDF generation failed - ${orgDisplayName}`,
          html: `<p>Generating the signed NDA PDF for <strong>${orgDisplayName}</strong> (org ${id}) failed on approval. The org was still approved and the owner was notified, but without the PDF attached.</p><p>Error: ${pdfErr.message}</p>`
        }).catch(err => console.error('Failed to send PDF-failure alert:', err.message))
      }
    }

    // ── Send to the vendor owner ──
    if (owner) {
      const { data, error } = await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: owner.email,
        subject: `Your organisation has been approved - welcome to Twif Portal`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
            <h2 style="color:#1a1a1a;">You're approved!</h2>
            <p style="color:#586069;">
              <strong>${orgDisplayName}</strong> has been approved and your account is now active.
              You can sign in to your dashboard to get started.
              ${pdfAttachment ? ' Your countersigned NDA is attached to this email.' : ''}
            </p>
          </div>
        `,
        ...(pdfAttachment && { attachments: [pdfAttachment] })
      })

      if (error) {
        console.error(`❌ Resend rejected approval email to ${owner.email}:`, error)
        await resend.emails.send({
          from: RESEND_FROM_EMAIL,
          to: ADMIN_EMAIL,
          subject: `Approval email failed to send - ${orgDisplayName}`,
          html: `<p>The approval notification to <strong>${owner.email}</strong> for <strong>${orgDisplayName}</strong> (org ${id}) failed to send.</p><p>Error: ${error.message || JSON.stringify(error)}</p>`
        }).catch(err => console.error('Failed to send approval-failure alert:', err.message))
      } else {
        if (org.type === 'supplier') {
          await supabase.from('nda_activity_log').insert([{
            organization_id: id, event_type: 'sent', actor_name: 'System', actor_email: owner.email, ip_address: null
          }])
        }
        console.log(`✅ Sent approval email${pdfAttachment ? ' with signed NDA PDF' : ''} to ${owner.email} (id: ${data?.id})`)
      }
    }

    // ── Send the executed copy to the approving admin's own login email ──
    if (org.type === 'supplier' && pdfAttachment) {
      const { data, error } = await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: req.user.email,
        subject: `Countersigned NDA - ${orgDisplayName}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
            <h2 style="color:#1a1a1a;">NDA executed</h2>
            <p style="color:#586069;">
              You approved and countersigned the NDA for <strong>${orgDisplayName}</strong>.
              The fully executed copy is attached for your records.
            </p>
          </div>
        `,
        attachments: [pdfAttachment]
      })

      if (error) {
        console.error(`❌ Resend rejected admin copy to ${req.user.email}:`, error)
        await resend.emails.send({
          from: RESEND_FROM_EMAIL,
          to: ADMIN_EMAIL,
          subject: `Admin copy of signed NDA failed to send - ${orgDisplayName}`,
          html: `<p>The countersigned-NDA copy to <strong>${req.user.email}</strong> for <strong>${orgDisplayName}</strong> (org ${id}) failed to send.</p><p>Error: ${error.message || JSON.stringify(error)}</p>`
        }).catch(err => console.error('Failed to send admin-copy-failure alert:', err.message))
      } else {
        await supabase.from('nda_activity_log').insert([{
          organization_id: id, event_type: 'sent', actor_name: 'System', actor_email: req.user.email, ip_address: null
        }])
        console.log(`✅ Sent countersigned NDA copy to approving admin ${req.user.email} (id: ${data?.id})`)
      }
    }

    return res.json({ success: true, message: 'Organization approved successfully' })

  } catch (err) {
    console.error('Approve org error:', err)
    return res.status(500).json({ error: err.message || 'Approval failed' })
  }
})

// ─────────────────────────────────────────────
// PATCH /customers/orgs/:id/reject
// Super-admin rejects a new org
// ─────────────────────────────────────────────
router.patch('/orgs/:id/reject', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { reason } = req.body

    const { data: org, error: fetchError } = await supabase
      .from('organizations')
      .select('id, name, display_name, status')
      .eq('id', id)
      .single()

    if (fetchError || !org) return res.status(404).json({ error: 'Organization not found' })
    if (org.status !== 'pending') return res.status(400).json({ error: `Organization already ${org.status}` })

    // Delete org and cascade — owner can re-apply
    await supabase.from('organization_members').delete().eq('organization_id', id)
    await supabase.from('organizations').delete().eq('id', id)

    const { data: owner } = await supabase
      .from('organization_members')
      .select('email')
      .eq('organization_id', id)
      .eq('role', 'owner')
      .maybeSingle()

    if (owner) {
      await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: owner.email,
        subject: `Update on your organisation application`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
            <h2 style="color:#1a1a1a;">Application update</h2>
            <p style="color:#586069;">
              Your application for <strong>${org.display_name || org.name}</strong> was not approved at this time.
              ${reason ? `<br><br>Reason: ${reason}` : ''}
            </p>
            <p style="color:#8e8e8e;font-size:13px;margin-top:24px;">
              If you believe this is a mistake, please reply to this email.
            </p>
          </div>
        `
      })
    }

    return res.json({ success: true, message: 'Organization rejected and removed' })

  } catch (err) {
    console.error('Reject org error:', err)
    return res.status(500).json({ error: err.message || 'Rejection failed' })
  }
})

// ─────────────────────────────────────────────
// POST /customers
// New org creation — creates org (status: pending) + owner member
// Body: { customer_name, business_name, customer_role, customer_phone,
//         country, domain_name, number_of_employees,
//         retailer_type?, supplier_type?, business_registration?, categories? }
// ─────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const {
    customer_name, business_name, customer_role,
    customer_phone, country, domain_name, number_of_employees,
    retailer_type, supplier_type, business_registration, categories,
    cin_no, udyam_no, msme_no, isi_code, iec_code, bank_account_number, bank_ifsc_code,
    pincode, address, owner_name, owner_email, owner_phone, reason_for_contact, logo_url,
    nda_accepted, nda_signature_name, nda_signature_type, nda_signature_image,
    org_email, job_title, via_vendor_entrance
  } = req.body

  const { id: userId, email } = req.user

  if (org_email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(org_email.trim())) {
    return res.status(400).json({ error: 'Invalid email', details: 'org_email must be a valid email address' })
  }
  const orgEmail = org_email?.trim() ? org_email.trim().toLowerCase() : email

  if (!customer_name || !customer_role || !country || !business_name || !number_of_employees) {
    return res.status(400).json({
      error: 'Missing required fields',
      details: 'customer_name, customer_role, country, business_name, number_of_employees are required'
    })
  }

  if (!['Buyer', 'Supplier/Vendor'].includes(customer_role)) {
    return res.status(400).json({ error: 'Invalid customer role', details: 'Must be "Buyer" or "Supplier/Vendor"' })
  }

  if (domain_name?.trim() && !/^https?:\/\/.+\..+/.test(domain_name.trim())) {
    return res.status(400).json({ error: 'Invalid website URL', details: 'Must start with http:// or https://' })
  }

  const phoneCountryCode = countryToPhoneCode[country] || 'US'
  const phoneValidation = validatePhoneNumber(customer_phone, phoneCountryCode)
  if (!phoneValidation.isValid) {
    return res.status(400).json({ error: 'Invalid phone number', details: `${phoneValidation.error} for ${country}` })
  }

  const validEmployeeCounts = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+']
  if (!validEmployeeCounts.includes(number_of_employees)) {
    return res.status(400).json({ error: 'Invalid employee count', details: 'Must be one of: ' + validEmployeeCounts.join(', ') })
  }

  if (customer_role === 'Supplier/Vendor') {
    if (!business_registration?.trim()) {
      return res.status(400).json({ error: 'Missing required field', details: 'GST No. is required for suppliers/vendors' })
    }
    if (via_vendor_entrance) {
      if (!customer_phone?.trim()) {
        return res.status(400).json({ error: 'Missing required field', details: 'Phone is required' })
      }
      if (!job_title?.trim()) {
        return res.status(400).json({ error: 'Missing required field', details: 'Title/Role is required' })
      }
      if (!iec_code?.trim()) {
        return res.status(400).json({ error: 'Missing required field', details: 'IEC code is required' })
      }
    } else if (!isi_code?.trim()) {
      return res.status(400).json({ error: 'Missing required field', details: 'ISI code is required for suppliers/vendors' })
    }
    if (!bank_account_number?.trim()) {
      return res.status(400).json({ error: 'Missing required field', details: 'Bank account number is required for suppliers/vendors' })
    }
    if (!bank_ifsc_code?.trim()) {
      return res.status(400).json({ error: 'Missing required field', details: 'IFSC code is required for suppliers/vendors' })
    }
    if (!pincode?.trim() || pincode.trim().length !== 6) {
      return res.status(400).json({ error: 'Missing required field', details: 'A valid 6-digit pincode is required for suppliers/vendors' })
    }
    if (!address?.trim()) {
      return res.status(400).json({ error: 'Missing required field', details: 'Address is required for suppliers/vendors' })
    }
    if (!owner_name?.trim()) {
      return res.status(400).json({ error: 'Missing required field', details: 'Owner / Director name is required for suppliers/vendors' })
    }
    if (!nda_accepted) {
      return res.status(400).json({ error: 'NDA not accepted', details: 'You must accept the NDA declarations to continue' })
    }
    if (nda_signature_type === 'drawn' || nda_signature_type === 'uploaded') {
      if (!nda_signature_image?.trim()) {
        return res.status(400).json({
          error: 'Signature missing',
          details: nda_signature_type === 'drawn' ? 'Please draw your signature' : 'Please upload your signature'
        })
      }
      if (!/^data:image\/(png|jpe?g);base64,/.test(nda_signature_image.trim()) || nda_signature_image.length > 3_000_000) {
        return res.status(400).json({ error: 'Invalid signature image', details: 'Signature image must be a valid PNG/JPEG data URL under ~2MB' })
      }
    } else if (!nda_signature_name?.trim()) {
      return res.status(400).json({ error: 'NDA not accepted', details: 'Please type your full legal name to sign the NDA' })
    }
  }

  try {
    const orgType = customer_role === 'Buyer' ? 'buyer' : 'supplier'

    const { org } = await createOrgAndOwner({
      userId,
      email,
      orgEmail,
      fullName: customer_name,
      jobTitle: job_title,
      orgName: business_name,
      orgType,
      country,
      phone: phoneValidation.formattedNumber,
      domain: domain_name,
      numberOfEmployees: number_of_employees,
      retailerType: retailer_type,
      supplierType: supplier_type,
      businessRegistration: business_registration,
      categories: categories || [],
      cin: cin_no,
      udyam: udyam_no,
      msme: msme_no,
      isi: isi_code,
      iec: iec_code,
      bankAccountNumber: bank_account_number,
      bankIfsc: bank_ifsc_code,
      pincode,
      address,
      ownerName: owner_name,
      ownerEmail: owner_email,
      ownerPhone: owner_phone,
      reasonForContact: reason_for_contact,
      logoUrl: logo_url,
      ndaAccepted: nda_accepted,
      ndaSignatureName: nda_signature_name,
      ndaSignatureType: nda_signature_type,
      ndaSignatureImage: nda_signature_image,
      ndaIp: req.ip
    })

    console.log(`✅ Created org ${org.id} (pending) for user ${userId}`)

    if (orgType === 'supplier') {
      // Two separate inserts so Postgres assigns each its own now() — these are
      // genuinely two distinct events, not one moment duplicated across rows.
      await supabase.from('nda_activity_log').insert([{
        organization_id: org.id, event_type: 'created', actor_name: customer_name, actor_email: email, ip_address: req.ip
      }])
      await supabase.from('nda_activity_log').insert([{
        organization_id: org.id, event_type: 'vendor_signed', actor_name: customer_name, actor_email: email, ip_address: req.ip
      }])
    }

    await notifyAdminNewOrg({ ...req.body, email }, email)

    if (orgType === 'supplier') {
      const copyResult = await sendVendorApplicationCopy({
        toEmail: email,
        application: req.body,
        signatureName: nda_signature_name,
        signedAt: new Date(),
        ip: req.ip
      })

      if (!copyResult.success) {
        await resend.emails.send({
          from: RESEND_FROM_EMAIL,
          to: ADMIN_EMAIL,
          subject: `Vendor NDA copy email failed - ${business_name}`,
          html: `<p>The signed-application copy email to <strong>${email}</strong> for <strong>${business_name}</strong> (org ${org.id}) failed to send.</p><p>Error: ${copyResult.error}</p>`
        }).catch(err => console.error('Failed to send NDA-copy-failure alert:', err.message))
      }
    }

    return res.json({
      success: true,
      message: 'Organisation submitted for review. You will be notified once approved.',
      data: { orgId: org.id, status: 'pending' }
    })

  } catch (err) {
    console.error('POST /customers error:', err.message)
    return res.status(500).json({ error: 'Failed to create organization', details: err.message })
  }
})

// ─────────────────────────────────────────────
// GET /customers/customer/:userId
// Get own org membership — users can only fetch their own
// ─────────────────────────────────────────────
router.get('/customer/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params

  if (userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    const { data, error } = await supabase
      .from('organization_members')
      .select(`
        id, full_name, email, role, created_on, user_id,
        organizations ( id, name, display_name, type, country, domain, status )
      `)
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Member record not found' })

    return res.json({ success: true, data })

  } catch (err) {
    console.error('GET /customer/:userId error:', err.message)
    return res.status(500).json({ error: 'Failed to retrieve customer', details: err.message })
  }
})

router.get('/org-name-search', requireAuth, async (req, res) => {
  try {
    const { q, type } = req.query
 
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' })
    }
 
    // Use Postgres ilike with wildcard for simple fuzzy match.
    // Good enough for org names — avoids needing pg_trgm extension.
    const searchTerm = `%${q.trim().toLowerCase()}%`
 
    let query = supabase
      .from('organizations')
      .select('id, name, display_name, type, country, domain, status')
      .or(`name.ilike.${searchTerm},display_name.ilike.${searchTerm}`)
      .not('status', 'eq', 'pending')  // don't surface orgs mid-approval
      .limit(5)
 
    if (type) query = query.eq('type', type)
 
    const { data, error } = await query
    if (error) throw error
 
    return res.json({
      success: true,
      data: (data || []).map(o => ({
        id: o.id,
        displayName: o.display_name || o.name,
        type: o.type,
        country: o.country,
        hasDomain: !!o.domain,
        status: o.status
      }))
    })
 
  } catch (err) {
    console.error('Org name search error:', err)
    return res.status(500).json({ error: err.message || 'Search failed' })
  }
})

// ─────────────────────────────────────────────
// GET /customers/all — super-admin only
// ─────────────────────────────────────────────
router.get('/all', requireSuperAdmin, async (req, res) => {
  const { role, limit = 50, offset = 0 } = req.query

  try {
    let query = supabase
      .from('organization_members')
      .select(`
        id, full_name, email, role, created_on, user_id,
        organizations ( id, name, display_name, type, country, status )
      `, { count: 'exact' })
      .order('created_on', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1)

    if (role) query = query.eq('role', role)

    const { data, error, count } = await query
    if (error) throw error

    return res.json({
      success: true,
      data: {
        members: data,
        pageInfo: { total: count, limit: parseInt(limit), offset: parseInt(offset) }
      }
    })

  } catch (err) {
    console.error('GET /customers/all error:', err.message)
    return res.status(500).json({ error: 'Failed to retrieve customers', details: err.message })
  }
})

// GET /customers/orgs/all — super-admin only
// Returns all organisations with pagination
// ─────────────────────────────────────────────
router.get('/orgs/all', requireSuperAdmin, async (req, res) => {
  const { limit = 100, offset = 0 } = req.query
  try {
    const { data, error, count } = await supabase
      .from('organizations')
      .select(`
        id, name, display_name, type, country, domain,
        status, no_of_members, created_on
      `, { count: 'exact' })
      .order('created_on', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1)
 
    if (error) throw error
    return res.json({
      success: true,
      data: {
        orgs: data,
        pageInfo: { total: count, limit: parseInt(limit), offset: parseInt(offset) }
      }
    })
  } catch (err) {
    console.error('GET /orgs/all error:', err.message)
    return res.status(500).json({ error: 'Failed to fetch organisations' })
  }
})

// ─────────────────────────────────────────────
// Per-admin signature default — each admin sets up their own once; used to
// prefill their countersignature at sign-time. Upserted by user_id.
// ─────────────────────────────────────────────
router.get('/admin-signature', requireSuperAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('admin_signatures')
      .select('id, full_name, designation, signature_type, signature_image, updated_at')
      .eq('user_id', req.user.id)
      .maybeSingle()

    if (error) throw error
    return res.json({ success: true, data: data || null })
  } catch (err) {
    console.error('GET /admin-signature error:', err.message)
    return res.status(500).json({ error: 'Failed to fetch admin signature' })
  }
})

router.post('/admin-signature', requireSuperAdmin, async (req, res) => {
  const { full_name, designation, signature_type, signature_image } = req.body

  if (!full_name?.trim()) {
    return res.status(400).json({ error: 'Missing required field', details: 'full_name is required' })
  }
  if (!['typed', 'drawn', 'uploaded'].includes(signature_type)) {
    return res.status(400).json({ error: 'Invalid signature_type', details: 'Must be typed, drawn, or uploaded' })
  }
  if (signature_type === 'drawn' || signature_type === 'uploaded') {
    if (!signature_image?.trim()) {
      return res.status(400).json({ error: 'Missing signature image', details: 'signature_image is required for drawn/uploaded signatures' })
    }
    if (!/^data:image\/(png|jpe?g);base64,/.test(signature_image.trim()) || signature_image.length > 3_000_000) {
      return res.status(400).json({ error: 'Invalid signature image', details: 'signature_image must be a valid PNG/JPEG data URL under ~2MB' })
    }
  }

  try {
    const { data: existing } = await supabase
      .from('admin_signatures')
      .select('id')
      .eq('user_id', req.user.id)
      .maybeSingle()

    const row = {
      user_id: req.user.id,
      full_name: full_name.trim(),
      designation: designation?.trim() || null,
      signature_type,
      signature_image: signature_type === 'typed' ? null : signature_image,
      updated_at: new Date().toISOString()
    }

    const { data, error } = existing
      ? await supabase.from('admin_signatures').update(row).eq('id', existing.id).select().single()
      : await supabase.from('admin_signatures').insert([row]).select().single()

    if (error) throw error
    return res.json({ success: true, data })
  } catch (err) {
    console.error('POST /admin-signature error:', err.message)
    return res.status(500).json({ error: 'Failed to save admin signature' })
  }
})

module.exports = router