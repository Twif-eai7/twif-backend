const nodemailer = require('nodemailer');
const express = require("express");
const { PhoneNumberUtil, PhoneNumberFormat } = require('google-libphonenumber');
const { admin, db } = require("../firebaseConfig.js");
const router = express.Router();
const axios = require("axios");
const {authenticate,authenticateShopifyProxy,authenticateManualHmac} = require("../middleware/authenticate.js");

// Initialize phone number utility
const phoneUtil = PhoneNumberUtil.getInstance();

// Get email credentials from environment variables
const { EMAIL_PASS, EMAIL_USER,SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN} = process.env;


const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail', 
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
});
const shopifyApi = axios.create({
  baseURL: `https://${process.env.SHOPIFY_STORE}/admin/api/2025-07`,
  headers: {
    "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
    "Content-Type": "application/json",
  },
});


async function sendAdminNotification(customerData) {
  const emailContent = `
    <h2>New Customer Profile Created - Verification Required</h2>
    
    <h3>Customer Details:</h3>
    <ul>
      <li><strong>Name:</strong> ${customerData.customer_name}</li>
      <li><strong>Email:</strong> ${customerData.customer_email || 'Not provided'}</li>
      <li><strong>Phone:</strong> ${customerData.customer_phone || 'Not provided'}</li>
      <li><strong>Country:</strong> ${customerData.country}</li>
      <li><strong>Role:</strong> ${customerData.customer_role}</li>
    </ul>
    
    <h3>Business Information:</h3>
    <ul>
      <li><strong>Company:</strong> ${customerData.business_name}</li>
      <li><strong>Website:</strong> ${customerData.domain_name || 'Not provided'}</li>
      <li><strong>Employees:</strong> ${customerData.number_of_employees}</li>
      ${customerData.customer_role === 'Buyer' ? 
        `<li><strong>Retailer Type:</strong> ${customerData.retailer_type || 'Not specified'}</li>` : 
        `<li><strong>Supplier Type:</strong> ${customerData.supplier_type || 'Not specified'}</li>
         <li><strong>Registration #:</strong> ${customerData.business_registration || 'Not provided'}</li>`
      }
    </ul>
    
    <p><strong>Customer ID:</strong> ${customerData.customerId}</p>
    <p><strong>Submitted:</strong> ${new Date().toLocaleString()}</p>
    
    <p>Please review and verify this customer profile.</p>
  `;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.ADMIN_EMAIL,
    subject: `New ${customerData.customer_role} Profile - ${customerData.business_name}`,
    html: emailContent
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Admin notification email sent successfully');
  } catch (error) {
    console.error('Failed to send admin notification:', error);
    // Don't fail the main request if email fails
  }
}

// Phone validation function
function validatePhoneNumber(phoneNumber, countryCode) {
  if (!phoneNumber || !phoneNumber.trim()) {
    return { isValid: true, formattedNumber: '' }; // Phone is optional
  }

  try {
    const number = phoneUtil.parseAndKeepRawInput(phoneNumber, countryCode);
    const isValid = phoneUtil.isValidNumber(number);
    
    if (!isValid) {
      return { isValid: false, error: 'Invalid phone number format' };
    }

    const formattedNumber = phoneUtil.format(number, PhoneNumberFormat.INTERNATIONAL);
    return { isValid: true, formattedNumber };
  } catch (error) {
    return { isValid: false, error: 'Invalid phone number format' };
  }
}

// Country code mapping for phone validation
const countryToPhoneCode = {
  'United States': 'US',
  'Canada': 'CA',
  'United Kingdom': 'GB',
  'Germany': 'DE',
  'France': 'FR',
  'Australia': 'AU',
  'Japan': 'JP',
  'India': 'IN',
  'China': 'CN',
  'Brazil': 'BR',
  'Mexico': 'MX',
  'Other': 'US' // Default to US format for 'Other'
};

async function resolveBuyersForMerchant(merchant, fallbackBuyers) {
  if (!merchant) return fallbackBuyers;
  
  const merchantQuery = `
    query findCustomerByEmail($email: String!) {
      customers(first: 1, query: $email) {
        edges {
          node {
            id
            metafield(namespace: "custom", key: "buyers") { value }
          }
        }
      }
    }
  `;
  
  try {
    const res = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: { 
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN 
      },
      data: { query: merchantQuery, variables: { email: `email:${merchant}` } },
    });
    
    const raw = res.data?.data?.customers?.edges?.[0]?.node?.metafield?.value;
    if (!raw) return [];
    
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.map(b => b.trim().toUpperCase()).filter(Boolean)
        : [raw.trim().toUpperCase()];
    } catch {
      return raw.split(',').map(b => b.trim().toUpperCase()).filter(Boolean);
    }
  } catch (err) {
    console.error('resolveBuyersForMerchant error:', err.message);
    return fallbackBuyers;
  }
}


// ✅ ADD THIS NEW ENDPOINT TO YOUR EXISTING customers.js ROUTER

/**
 * POST /api/customers/sync-from-mobile
 * Creates/updates a Shopify customer from mobile app sign-up
 * Uses the SAME customerId from Firebase for consistency
 */


router.post("/sync-from-mobile", async (req, res) => {
  const {
    customerId,
    customer_name,
    business_name,
    email,
    customer_role,
    customer_phone,
    country = 'India',
    domain_name,
    number_of_employees = '1-10',
  } = req.body;

  // Input validation
  if (!customerId || !customer_name || !email) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields',
      details: 'customerId, customer_name, and email are required'
    });
  }

  console.log(`🔄 Mobile sync request for customer: ${customerId}`);
  console.log(`   Email: ${email}`);
  console.log(`   Role: ${customer_role}`);

  try {
    // ✅ STEP 1: Check if customer already exists in Shopify
    let shopifyCustomerId;
    let shopifyCustomerExists = false;

    try {
      console.log('🔍 Searching for existing Shopify customer...');

      // Search by the customerId stored in metafields
      const searchQuery = `
        query {
          customers(first: 1, query: "email:${email}") {
            edges {
              node {
                id
                email
                metafield(namespace: "custom", key: "customer_id") {
                  value
                }
              }
            }
          }
        }
      `;

      const searchResponse = await axios({
        method: "POST",
        url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
        },
        data: { query: searchQuery }
      });

      const customers = searchResponse.data?.data?.customers?.edges || [];

      if (customers.length > 0) {
        const existingCustomer = customers[0].node;
        shopifyCustomerId = existingCustomer.id.split('/').pop();
        shopifyCustomerExists = true;
        console.log(`✅ Found existing Shopify customer: ${shopifyCustomerId}`);
      }
    } catch (searchError) {
      console.log('⚠️ Search failed, will create new customer:', searchError.message);
    }

    // ✅ STEP 2: Create or update Shopify customer
    if (!shopifyCustomerExists) {
      console.log('🔄 Creating new Shopify customer...');

      const nameParts = customer_name.trim().split(' ');
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ') || firstName;

      // Create customer using REST API
      const createPayload = {
        customer: {
          first_name: firstName,
          last_name: lastName,
          email: email,
          phone: customer_phone || null,
          tags: 'mobile-app-synced',
          note: `Synced from mobile app. Firebase customerId: ${customerId}`,
          email_marketing_consent: {
            state: 'not_subscribed',
            opt_in_level: 'single_opt_in'
          }
        }
      };

      try {
        const createResponse = await shopifyApi.post('/customers.json', createPayload);
        shopifyCustomerId = createResponse.data.customer.id;
        console.log(`✅ Created Shopify customer: ${shopifyCustomerId}`);
      } catch (createError) {
        if (createError.response?.status === 422) {
          // Customer exists, search again
          console.log('Customer exists, searching...');
          const encodedEmail = encodeURIComponent(email);
          const existingCust = await shopifyApi.get(`/customers/search.json?query=email:${encodedEmail}`);

          if (existingCust.data.customers?.length > 0) {
            shopifyCustomerId = existingCust.data.customers[0].id;
            console.log(`✅ Found existing customer: ${shopifyCustomerId}`);
          } else {
            throw new Error('Customer exists but could not be found');
          }
        } else {
          throw createError;
        }
      }
    }

    // ✅ STEP 3: Update Shopify metafields with all customer data
    console.log('🔄 Updating Shopify metafields...');

    const metafieldsPayload = [
      {
        ownerId: `gid://shopify/Customer/${shopifyCustomerId}`,
        namespace: "custom",
        key: "customer_id",
        type: "single_line_text_field",
        value: customerId // ✅ Store Firebase customerId
      },
      {
        ownerId: `gid://shopify/Customer/${shopifyCustomerId}`,
        namespace: "custom",
        key: "name",
        type: "single_line_text_field",
        value: customer_name
      },
      {
        ownerId: `gid://shopify/Customer/${shopifyCustomerId}`,
        namespace: "custom",
        key: "business_name",
        type: "single_line_text_field",
        value: business_name || customer_name
      },
      {
        ownerId: `gid://shopify/Customer/${shopifyCustomerId}`,
        namespace: "custom",
        key: "role",
        type: "single_line_text_field",
        value: customer_role || 'Buyer'
      },
      {
        ownerId: `gid://shopify/Customer/${shopifyCustomerId}`,
        namespace: "custom",
        key: "contact",
        type: "single_line_text_field",
        value: customer_phone || ""
      },
      {
        ownerId: `gid://shopify/Customer/${shopifyCustomerId}`,
        namespace: "custom",
        key: "country",
        type: "single_line_text_field",
        value: country
      },
      {
        ownerId: `gid://shopify/Customer/${shopifyCustomerId}`,
        namespace: "custom",
        key: "number_of_employees",
        type: "single_line_text_field",
        value: number_of_employees
      }
    ];

    if (domain_name) {
      metafieldsPayload.push({
        ownerId: `gid://shopify/Customer/${shopifyCustomerId}`,
        namespace: "custom",
        key: "domain",
        type: "single_line_text_field",
        value: domain_name
      });
    }

    const metafieldsQuery = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key value }
          userErrors { field message }
        }
      }
    `;

    const metafieldsResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
      },
      data: {
        query: metafieldsQuery,
        variables: { metafields: metafieldsPayload }
      }
    });

    const metafieldsResult = metafieldsResponse.data;

    if (metafieldsResult.data?.metafieldsSet?.userErrors?.length > 0) {
      console.warn('⚠️ Metafields update had errors:', metafieldsResult.data.metafieldsSet.userErrors);
    } else {
      console.log('✅ All metafields updated successfully');
    }

    // ✅ STEP 4: Return success response
    res.json({
      success: true,
      message: 'Customer synced to Shopify successfully',
      data: {
        firebaseCustomerId: customerId,
        shopifyCustomerId: shopifyCustomerId,
        email: email,
        name: customer_name,
        role: customer_role,
        synced: true
      }
    });

    console.log(`✅ Mobile sync completed for customer ${customerId}`);

  } catch (error) {
    console.error('❌ Mobile sync error:', error.message);

    // Return detailed error for debugging
    res.status(500).json({
      success: false,
      error: 'Failed to sync customer to Shopify',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      shopifyError: error.response?.data
    });
  }
});








router.post("/register-firebase", async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;

    // 1. Create Firebase Auth User (ignore if already exists)
    let user;
    try {
      user = await admin.auth().createUser({
        email,
        password,
        displayName: `${firstName} ${lastName}`.trim()
      });
    } catch(e) {
      if (e.errorInfo?.code === "auth/email-already-exists") {
        user = await admin.auth().getUserByEmail(email);
      } else throw e;
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("Firebase Sync Error:", err);
    return res.status(200).json({ success: false, note: "Non-blocking sync" });
  }
});


router.post("/", authenticateManualHmac,async (req, res) => {
  const { 
    customerId, 
    customer_name,
    business_name, 
    email,
    customer_role, 
    customer_phone,
    country,
    domain_name,
    number_of_employees,
    retailer_type,
    supplier_type,
    business_registration
  } = req.body;

  // Input validation
  if (!customerId || !customer_name || !customer_role || !country || !business_name || !number_of_employees || !email) {
    return res.status(400).json({
      error: 'Missing required fields',
      details: 'customerId, customer_name, customer_role, country, business_name, number_of_employees and email are required fields'
    });
  }

  // Validate customerId is numeric
  if (!/^\d+$/.test(customerId.toString())) {
    return res.status(400).json({
      error: 'Invalid customerId',
      details: 'customerId must be a numeric value'
    });
  }

  // Validate role
  if (!['Buyer', 'Supplier/Vendor'].includes(customer_role)) {
    return res.status(400).json({
      error: 'Invalid customer role',
      details: 'customer_role must be either "Buyer" or "Supplier/Vendor"'
    });
  }

  // Validate URL format if domain_name is provided
  if (domain_name && domain_name.trim() && !/^https?:\/\/.+\..+/.test(domain_name.trim())) {
    return res.status(400).json({
      error: 'Invalid website URL',
      details: 'domain_name must be a valid URL starting with http:// or https://'
    });
  }

  // Validate phone number using Google libphonenumber
  const phoneCountryCode = countryToPhoneCode[country] || 'US';
  const phoneValidation = validatePhoneNumber(customer_phone, phoneCountryCode);
  
  if (!phoneValidation.isValid) {
    return res.status(400).json({
      error: 'Invalid phone number',
      details: phoneValidation.error + ` for ${country}`
    });
  }

  // Use formatted phone number if validation passed
  const formattedPhone = phoneValidation.formattedNumber;

  // Validate employee count
  const validEmployeeCounts = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];
  if (!validEmployeeCounts.includes(number_of_employees)) {
    return res.status(400).json({
      error: 'Invalid employee count',
      details: 'number_of_employees must be one of: ' + validEmployeeCounts.join(', ')
    });
  }

  // Prepare customer data for Firestore
  const customerData = {
    customerId: customerId.toString(),
    customerName: customer_name,
    businessName: business_name,
    role: customer_role,
    contact: formattedPhone || "",
    email: email || "",
    country: country,
    domain: domain_name || "",
    numberOfEmployees: number_of_employees,  
    isVerified: false, // Default to false for new customers
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Add role-specific fields
  if (customer_role === 'Buyer' && retailer_type) {
    customerData.retailerType = retailer_type;
  }

  if (customer_role === 'Supplier/Vendor') {
    if (supplier_type) {
      customerData.supplierType = supplier_type;
    }
    if (business_registration) {
      customerData.businessRegistration = business_registration;
    }
  }

  try {
    // Check if customer exists in Firebase
    const customerRef = db.collection('customers').doc(customerId.toString());
    const doc = await customerRef.get();
    
    if (doc.exists) {
      // Update existing customer
      delete customerData.createdAt; // Don't update creation date
      await customerRef.update(customerData);
      console.log(`Successfully updated customer ${customerId} in Firebase:`, customerData);
    } else {
      // Create new customer
      await customerRef.set(customerData);
      console.log(`Successfully created customer ${customerId} in Firebase:`, customerData);
    }

    // Update all Shopify metafields
    const query = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key value namespace type }
          userErrors { field message code }
        }
      }
    `;

    // Construct the metafields array based on the expected types
    const metafieldsPayload = [
      {
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace: "custom",
        key: "name",
        type: "single_line_text_field",
        value: customer_name
      },
      {
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace: "custom",
        key: "business_name",
        type: "single_line_text_field",
        value: business_name
      },
      {
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace: "custom",
        key: "role",
        type: "single_line_text_field",
        value: customer_role
      },
      {
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace: "custom",
        key: "contact",
        type: "single_line_text_field",
        value: formattedPhone || ""
      },
      {
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace: "custom",
        key: "country",
        type: "single_line_text_field",
        value: country
      },
      {
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace: "custom",
        key: "domain",
        type: "single_line_text_field",
        value: domain_name || ""
      },
      {
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace: "custom",
        key: "number_of_employees",
        type: "single_line_text_field",
        value: number_of_employees
      }
    ];

    // Add role-specific fields
    if (customer_role === 'Buyer' && retailer_type) {
      metafieldsPayload.push({
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace: "custom",
        key: "retailer_type",
        type: "single_line_text_field",
        value: retailer_type
      });
    }

    if (customer_role === 'Supplier/Vendor') {
      if (supplier_type) {
        metafieldsPayload.push({
          ownerId: `gid://shopify/Customer/${customerId}`,
          namespace: "custom",
          key: "supplier_type",
          type: "single_line_text_field",
          value: supplier_type
        });
      }
      
      if (business_registration) {
        metafieldsPayload.push({
          ownerId: `gid://shopify/Customer/${customerId}`,
          namespace: "custom",
          key: "business_registration",
          type: "single_line_text_field",
          value: business_registration
        });
      }
    }

    const variables = {
      metafields: metafieldsPayload
    };

    const shopifyResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
      },
      data: { query, variables }
    });

    const shopifyResult = shopifyResponse.data;

    if (shopifyResult.errors) {
      console.error('Shopify GraphQL errors:', shopifyResult.errors);
      console.warn('Firebase updated successfully but Shopify metafields update failed');
    }

    if (shopifyResult.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('Shopify user errors:', shopifyResult.data.metafieldsSet.userErrors);
      console.warn('Firebase updated successfully but Shopify metafields update had validation errors');
    } else {
      console.log(`Successfully updated all Shopify metafields for customer ${customerId}:`, {
        name: customer_name,
        role: customer_role,
        business: business_name,
        country: country,
        phone: formattedPhone || 'not provided',
        employees: number_of_employees,
        domain: domain_name || 'not provided',
        retailer_type: retailer_type || 'not applicable',
        supplier_type: supplier_type || 'not applicable',
        registration: business_registration || 'not provided'
      });
    }

    // Send admin notification
    //await sendAdminNotification({ ...req.body, customer_email });

    res.json({
      success: true,
      data: customerData,
      message: doc.exists ? 'Customer profile updated successfully' : 'Customer profile created successfully',
      shopifyMetafieldsUpdated: !shopifyResult.errors && !shopifyResult.data?.metafieldsSet?.userErrors?.length
    });

  } catch (err) {
    console.error('Unexpected error:', err.message);
    
    // If it's a Shopify-specific error but Firebase succeeded, still return success
    if (err.response && err.config?.url?.includes('shopify')) {
      console.error('Shopify API error:', err.response.data);
      console.warn('Firebase updated successfully but Shopify API call failed');
      
      return res.json({
        success: true,
        data: customerData,
        message: 'Customer profile updated in Firebase, but Shopify metafields update failed',
        shopifyMetafieldsUpdated: false,
        shopifyError: err.response.data || err.message
      });
    }

    // Firebase or other critical error
    return res.status(500).json({
      error: "Failed to update customer data",
      details: err.message || 'An unexpected error occurred'
    });
  }
});



// GET /customer/:customerId - Retrieve specific customer data
router.get("/customer/:customerId",async (req, res) => {
  const { customerId } = req.params;

  if (!customerId) {
    return res.status(400).json({
      error: 'Invalid customerId',
      details: 'customerId is required'
    });
  }

  try {
    const customerRef = db.collection('customers').doc(customerId.toString());
    const doc = await customerRef.get();

    if (!doc.exists) {
      return res.status(404).json({
        error: 'Customer not found',
        details: `No customer found with ID: ${customerId}`
      });
    }

    const customerData = doc.data();
    
    res.json({
      success: true,
      data: {
        id: doc.id,
        ...customerData
      }
    });

  } catch (err) {
    console.error('Unexpected error:', err.message);
    res.status(500).json({
      error: "Failed to retrieve customer data",
      details: err.message || 'An unexpected error occurred'
    });
  }
});


/**
 * This endpoint is the first step for a new user.
 * It takes a Firebase Auth UID and user details, then:
 * 1. Creates a new customer in Shopify or finds them if they already exist by email.
 * 2. Creates a corresponding user profile in Firestore, using the Shopify Customer ID as the document ID.
 */


// The new, all-in-one endpoint
router.post('/create-and-sync-user',async (req, res) => {
  const { uid, email, name } = req.body;

  // Enhanced validation
  if (!uid || !email || !name) {
    return res.status(400).json({ 
      success: false, 
      error: 'Firebase UID, email, and name are required' 
    });
  }

  // Email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid email format' 
    });
  }

  try {
    let shopifyCustomerId;

    // Split name into first and last
    const nameParts = name.trim().split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || firstName;

    // STEP 1: Create or find the customer in Shopify
    try {
      const shopifyPayload = { 
        customer: { 
          first_name: firstName,
          last_name: lastName,
          email: email,
          email_marketing_consent: {
            state: 'not_subscribed',
            opt_in_level: 'single_opt_in'
          },
          tags: 'firebase-synced',
          note: `Synced from Firebase UID: ${uid}`
        } 
      };
      
      // Use versioned endpoint
      const shopifyResponse = await shopifyApi.post('/customers.json', shopifyPayload);
      shopifyCustomerId = shopifyResponse.data.customer.id;
      console.log(`Created new Shopify customer with ID: ${shopifyCustomerId}`);
      
    } catch (error) {
      if (error.response && error.response.status === 422) {
        // Customer already exists, search for them
        console.log('Customer exists in Shopify. Searching...');
        
        // URL-encode the email for safe query
        const encodedEmail = encodeURIComponent(email);
        const searchUrl = `/customers/search.json?query=email:${encodedEmail}`;
        const existingCust = await shopifyApi.get(searchUrl);
        
        if (!existingCust.data.customers || existingCust.data.customers.length === 0) {
          throw new Error('Customer exists but could not be found by email search.');
        }
        
        shopifyCustomerId = existingCust.data.customers[0].id;
        console.log(`Found existing Shopify customer with ID: ${shopifyCustomerId}`);
        
      } else {
        // Log detailed error info for debugging
        console.error('Shopify API Error:', {
          status: error.response?.status,
          data: error.response?.data,
          message: error.message
        });
        throw error;
      }
    }

    // STEP 2: Store the link and user data in Firestore
    const userDocRef = db.collection('users').doc(uid);
    await userDocRef.set({
      name: name,
      email: email,
      shopifyCustomerId: String(shopifyCustomerId), // Ensure it's a string
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSyncedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }); // Use merge to avoid overwriting existing data
    
    console.log(`Stored user data in Firestore for UID: ${uid}`);

    // STEP 3: Return the Shopify ID to the client
    res.json({
      success: true,
      message: 'User synced successfully across Shopify and Firebase.',
      shopifyCustomerId: shopifyCustomerId
    });

  } catch (error) {
    console.error('FATAL SYNC ERROR:', error.message, error.stack);
    
    // Return more specific error messages
    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.errors || error.message || 'Failed to sync user';
    
    res.status(statusCode).json({ 
      success: false, 
      error: 'Failed to sync user.',
      details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
    });
  }
});
// GET /customers - Retrieve all customers with pagination
router.get("/all", authenticateManualHmac, async (req, res) => {
  const { 
    limit = 50,
    startAfter, 
    role, 
    isVerified,
    country,
    sortBy = 'createdAt',
    sortOrder = 'desc' 
  } = req.query;

  try {
    let query = db.collection('customers');

    // Apply filters
    if (role) {
      query = query.where('role', '==', role);
    }
    
    if (isVerified !== undefined) {
      query = query.where('isVerified', '==', isVerified === 'true');
    }
    
    if (country) {
      query = query.where('country', '==', country);
    }

    // Apply sorting
    query = query.orderBy(sortBy, sortOrder);

    // Apply pagination
    const limitNum = Math.min(parseInt(limit), 100);
    query = query.limit(limitNum);

    if (startAfter) {
      const startAfterDoc = await db.collection('customers').doc(startAfter).get();
      if (startAfterDoc.exists) {
        query = query.startAfter(startAfterDoc);
      }
    }

    // Execute query
    const snapshot = await query.get();
    
    const customers = [];
    let lastDocId = null;
    
    snapshot.forEach(doc => {
      const data = doc.data();
      customers.push({
        id: doc.id,
        firstName: data.firstName || '',
        lastName: data.lastName || '',
        email: data.email || '',
        phone: data.contact || '',
        createdAt: data.createdAt || '',
        updatedAt: data.updatedAt || '',
        tags: data.tags || [],
        customerName: data.customerName || '',
        businessName: data.businessName || '',
        role: data.role || '',
        contact: data.contact || '',
        isVerified: data.isVerified || false,
        country: data.country || '',
        domainName: data.domain || '',
        numberOfEmployees: data.numberOfEmployees || '',
        retailerType: data.retailerType || '',
        supplierType: data.supplierType || '',
        businessRegistration: data.businessRegistration || ''
      });
      lastDocId = doc.id;
    });

    const hasNextPage = customers.length === limitNum;

    res.json({
      success: true,
      data: {
        customers: customers,
        pageInfo: {
          hasNextPage: hasNextPage,
          lastDocId: lastDocId,
          totalCount: customers.length
        }
      }
    });

  } catch (err) {
    console.error('Unexpected error:', err.message);
    return res.status(500).json({
      error: "Failed to retrieve customers",
      details: err.message || 'An unexpected error occurred'
    });
  }
});

// POST /verify - Update customer verification status
router.post("/verify",authenticateManualHmac, async (req, res) => {
  const { customerId, isVerified } = req.body;

  // Input Validation
  if (!customerId) {
    return res.status(400).json({
      error: 'Missing required field',
      details: 'customerId is a required field'
    });
  }

  // Validate customerId is numeric
  if (!/^\d+$/.test(customerId.toString())) {
    return res.status(400).json({
      error: 'Invalid customerId',
      details: 'customerId must be a numeric value'
    });
  }

  if (typeof isVerified !== 'boolean') {
    return res.status(400).json({
      error: 'Invalid isVerified value',
      details: 'isVerified must be a boolean (true or false)'
    });
  }

  try {
    const customerRef = db.collection('customers').doc(customerId.toString());
    
    // Check if customer exists
    const doc = await customerRef.get();
    if (!doc.exists) {
      return res.status(404).json({
        error: 'Customer not found',
        details: `No customer found with ID: ${customerId}`
      });
    }

    // Update verification status in Firebase
    await customerRef.update({
      isVerified: isVerified,
      updatedAt: new Date().toISOString(),
      verifiedAt: isVerified ? new Date().toISOString() : null
    });

    console.log(`Successfully updated isVerified status in Firebase for customer ${customerId} to ${isVerified}`);

    // Update Shopify metafield for isVerified
    const query = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key value namespace type }
          userErrors { field message code }
        }
      }
    `;

    const metafieldsPayload = [
      {
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace: "custom",
        key: "isverified",
        type: "boolean",
        value: isVerified.toString()
      }
    ];

    const variables = {
      metafields: metafieldsPayload
    };

    const shopifyResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
      },
      data: { query, variables }
    });

    const shopifyResult = shopifyResponse.data;

    if (shopifyResult.errors) {
      console.error('Shopify GraphQL errors:', shopifyResult.errors);
      console.warn('Firebase updated successfully but Shopify metafield update failed');
    }

    if (shopifyResult.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('Shopify user errors:', shopifyResult.data.metafieldsSet.userErrors);
      console.warn('Firebase updated successfully but Shopify metafield update had validation errors');
    } else {
      console.log(`Successfully updated Shopify is_verified metafield for customer ${customerId}: ${isVerified}`);
    }

    res.json({
      success: true,
      message: `Customer verification status updated to ${isVerified}`,
      data: {
        customerId: customerId,
        isVerified: isVerified,
        updatedAt: new Date().toISOString()
      },
      shopifyMetafieldUpdated: !shopifyResult.errors && !shopifyResult.data?.metafieldsSet?.userErrors?.length
    });

  } catch (err) {
    console.error('Unexpected error during verification update:', err.message);
    
    // If it's a Shopify-specific error but Firebase succeeded, still return success
    if (err.response && err.config?.url?.includes('shopify')) {
      console.error('Shopify API error:', err.response.data);
      console.warn('Firebase updated successfully but Shopify API call failed');
      
      return res.json({
        success: true,
        message: `Customer verification status updated in Firebase to ${isVerified}, but Shopify metafield update failed`,
        data: {
          customerId: customerId,
          isVerified: isVerified,
          updatedAt: new Date().toISOString()
        },
        shopifyMetafieldUpdated: false,
        shopifyError: err.response.data || err.message
      });
    }

    // Firebase or other critical errors
    return res.status(500).json({
      error: "Failed to update verification status",
      details: err.message || 'An unexpected error occurred'
    });
  }
});
// DELETE /customer/:customerId - Delete a customer (optional endpoint)
router.delete("/customer/:customerId",authenticate, async (req, res) => {
  const { customerId } = req.params;

  if (!customerId) {
    return res.status(400).json({
      error: 'Invalid customerId',
      details: 'customerId is required'
    });
  }
 
  try {
    const customerRef = db.collection('customers').doc(customerId.toString());
    
    // Check if customer exists
    const doc = await customerRef.get();
    if (!doc.exists) {
      return res.status(404).json({
        error: 'Customer not found',
        details: `No customer found with ID: ${customerId}`
      });
    }

    // Delete the customer
    await customerRef.delete();
    
    console.log(`Successfully deleted customer ${customerId}`);

    res.json({
      success: true,
      message: `Customer ${customerId} deleted successfully`
    });

  } catch (err) {
    console.error('Unexpected error during deletion:', err.message);
    return res.status(500).json({
      error: "Failed to delete customer",
      details: err.message || 'An unexpected error occurred'
    });
  }
});


router.get("/customer/:customerId/admin-merchant-performance", async (req, res) => {
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
          metafield(namespace: "custom", key: "merchantperformance") {
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

    // const myRows = parsedData.filter(
    //   r => r["Email"]?.toString().toLowerCase().trim() === customerEmail.toLowerCase().trim()
    // );
    // const myNonTotalBuyers = [...new Set(
    //   myRows
    //     .map(r => r["Buyer"]?.toString().trim())
    //     .filter(b => b && b.toUpperCase() !== "TOTAL")
    // )];

    // const isAdmin = myNonTotalBuyers.length >= totalBuyerCount;

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
        volumeLY25: 0, targetFY26: 0, ytdFY26: 0, totalOpenPos: 0,
        totalOrders: 0, otifValues: [], otifLYValues: [],
        totalQualityClaimsLY: 0, totalQualityClaims: 0,
        totalSKUs: 0, totalConvertedSKUs: 0, numberOfPos: 0,
        openPosCount: 0, growth: 0, latePos: 0, onTimePos: 0,otifLatestValues:[]
      };
      rows.forEach(row => {
        totals.volumeLY25           += cleanNumber(row["Volume LY25"]);
        totals.targetFY26           += cleanNumber(row["Target FY26"]);
        totals.ytdFY26              += cleanNumber(row["YTD FY26"]);
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
        volumeLY25: totals.volumeLY25,
        targetFY26: totals.targetFY26,
        ytdActual: totals.ytdFY26,
        ytdFY26: totals.ytdFY26,
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
        ytdTarget: totals.targetFY26,
        lytd: totals.volumeLY25,
        latePos: totals.latePos,
        onTimePos: totals.onTimePos,
      };
    };

    const makeSummaryFromRow = (row) => ({
      totalRows: 1,
      volumeLY25: cleanNumber(row["Volume LY25"]),
      targetFY26: cleanNumber(row["Target FY26"]),
      ytdActual: cleanNumber(row["YTD FY26"]),
      ytdFY26: cleanNumber(row["YTD FY26"]),
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
      ytdTarget: cleanNumber(row["Target FY26"]),
      lytd: cleanNumber(row["Volume LY25"]),
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

router.get("/customer/:customerId/buyer-performance", async (req, res) => {
 const { customerId } = req.params;

 if (!customerId) {
 return res.status(400).json({
 error: "Invalid customerId",  
 details: "customerId is required",
 });
 }

 try {
 // First, get the customer's email
 const customerQuery = `
 query getCustomer($customerId: ID!) {
 customer(id: $customerId) {
 id
 email
 }
 }
 `;

 const customerVariables = {
 customerId: `gid://shopify/Customer/${customerId}`,
 };

 const customerResponse = await axios({
 method: "POST",
 url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
 headers: {
 "Content-Type": "application/json",
 "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
 },
 data: { query: customerQuery, variables: customerVariables },
 });

 const customerEmail = customerResponse.data?.data?.customer?.email;

 if (!customerEmail) {
 return res.status(404).json({
 error: "Customer not found",
 details: `No customer found with ID ${customerId}`,
 });
 }

 // Fetch shop metafield for the buyer's performance Excel file
 const shopMetafieldQuery = `
 query getShopMetafield {
 shop {
 metafield(namespace: "custom", key: "buyers_performance") {
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
 details: "No shop metafield found for buyer performance",
 });
 }

 let fileUrl;

 // Case 1: metafield type is file_reference
 if (metafieldData.type === "file_reference") {
 const fileId = metafieldData.value;

 const fileQuery = `
 query getFileUrl($fileId: ID!) {
 node(id: $fileId) {
 ... on GenericFile {
 url
 }
 ... on MediaImage {
 image {
 url
 }
 }
 }
 }
 `;

 const fileApiResponse = await axios({
 method: "POST",
 url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
 headers: {
 "Content-Type": "application/json",
 "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
 },
 data: { query: fileQuery, variables: { fileId } },
 });

 fileUrl =
 fileApiResponse.data?.data?.node?.url ||
 fileApiResponse.data?.data?.node?.image?.url;

 if (!fileUrl) {
 return res.status(404).json({
 error: "File URL not found",
 details: "Could not resolve file reference metafield",
 });
 }
 } else {
 // Case 2: direct URL stored as value
 fileUrl = metafieldData.value;
 }

 // Download the file
 const fileResponse = await axios({
 method: "GET",
 url: fileUrl,
 responseType: "arraybuffer",
 });

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
 return res.status(404).json({
 error: "Empty file",
 details: "The Excel file contains no data",
 });
 }

 // Clean and normalize headers
 const headers = jsonData[0].map(h =>
 h?.toString().trim().replace(/\u00A0/g, " ")
 );
 const rows = jsonData.slice(1);

 // Helper to safely parse numbers and currency
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
 const obj = {};
 headers.forEach((header, index) => {
 obj[header] = row[index] !== undefined ? row[index] : "";
 });
 return obj;
 });

 // Find customer's data by matching email
 const customerData = parsedData.find(
 (row) => row["Email"]?.toString().toLowerCase().trim() === customerEmail.toLowerCase().trim()
 );

 if (!customerData) {
 return res.status(404).json({
 error: "Customer data not found",
 details: `No performance data found for customer email: ${customerEmail}`,
 availableEmails: parsedData.map(r => r["Email"]).filter(Boolean),
 });
 }
const volumeBuyerNames = (customerData["Volume Buyer Name"] || customerData["Business Name"])
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const summary = {
  totalRows: 1,
  // Identity
  name:             customerData["Name"],
  businessName:     customerData["Business Name"],
  // PO counts
  shippedPosYTD:     cleanNumber(customerData["Shipped Pos YTD"]),       // total shipped POs YTD count

  // Values
  ytdActual:    cleanNumber(customerData["YTD FY26"]),        // shipped $ value YTD FY26
  totalOrders:  cleanNumber(customerData["Total orders"]),    // total $ incl open
  openPosValue: cleanNumber(customerData["Open Pos"]),        // $ value of open POs

  // OTIF
  otifRate: `${cleanNumber(customerData["OTIF"]).toFixed(0)}%`,
  otifRaw:   cleanNumber(customerData["OTIF"]),
  volumeLY25:             cleanNumber(customerData["FY 25 shipped"]),
  fy25_shipped_count:     cleanNumber(customerData["FY 25 shipped count"]),
  otifLY:                 cleanNumber(customerData["OTIF LY"]),
  totalQualityClaims:     cleanNumber(customerData["Quality claims"]),  
  totalQualityClaimsLY:   cleanNumber(customerData["Quality Claims LY"]), 
  onTimePos:              cleanNumber(customerData["Ontime Pos"]),
  latePos:                cleanNumber(customerData["Late Pos"]),  
  totalConvertedSKUs:     cleanNumber(customerData["Converted Skus"]),
  volumeBuyerNames:   volumeBuyerNames, //merchant-level bifurcation
};

 res.json({
 success: true,
 data: {
 headers,
 rows: [customerData],
 summary,
 rowCount: 1,
 },
 });
 } catch (err) {
 console.error("Error fetching/parsing Excel file:", err.message);
 console.error("Full error:", err);

 if (err.response?.status === 404) {
 return res.status(404).json({
 error: "File not found",
 details: "The Excel file URL is not accessible",
 });
 }

 return res.status(500).json({
 error: "Failed to fetch or parse Excel file",
 details: err.message || "An unexpected error occurred",
 });
 }
});

router.get("/customer/:customerId/performance", async (req, res) => {
  const { customerId } = req.params;

  if (!customerId) {
    return res.status(400).json({
      error: "Invalid customerId",
      details: "customerId is required",
    });
  }

  try {
    const query = `
      query getCustomerMetafield($customerId: ID!) {
        customer(id: $customerId) {
          id
          metafield(namespace: "custom", key: "po_excel") {
            id
            value
            type
          }
        }
      }
    `;

    const variables = {
      customerId: `gid://shopify/Customer/${customerId}`,
    };

    const shopifyResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      },
      data: { query, variables },
    });

    const metafieldData = shopifyResponse.data?.data?.customer?.metafield;

    if (!metafieldData) {
      return res.status(404).json({
        error: "Excel file not found",
        details: `No metafield found for customer ${customerId}`,
      });
    }

    let fileUrl;

    // Case 1: metafield type is file_reference
    if (metafieldData.type === "file_reference") {
      const fileId = metafieldData.value;

      const fileQuery = `
        query getFileUrl($fileId: ID!) {
          node(id: $fileId) {
            ... on GenericFile {
              url
            }
            ... on MediaImage {
              image {
                url
              }
            }
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

      fileUrl =
        fileResponse.data?.data?.node?.url ||
        fileResponse.data?.data?.node?.image?.url;

      if (!fileUrl) {
        return res.status(404).json({
          error: "File URL not found",
          details: "Could not resolve file reference metafield",
        });
      }
    } else {
      // Case 2: direct URL stored as value
      fileUrl = metafieldData.value;
    }

    // Download the file
    const fileResponse = await axios({
      method: "GET",
      url: fileUrl,
      responseType: "arraybuffer",
    });

    const XLSX = require("xlsx");
    const workbook = XLSX.read(fileResponse.data, { type: "buffer" });

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });

    if (jsonData.length === 0) {
      return res.status(404).json({
        error: "Empty file",
        details: "The Excel file contains no data",
      });
    }

    // Clean and normalize headers
    const headers = jsonData[0].map(h =>
      h?.toString().trim().replace(/\u00A0/g, " ")
    );

    const rows = jsonData.slice(1);

    // Helper to safely parse numbers
    const cleanNumber = (val) => {
      if (typeof val === "number") return val;
      if (typeof val === "string") {
        const cleaned = val.replace(/[^0-9.\-]/g, "");
        return cleaned ? parseFloat(cleaned) : 0;
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

    // Calculate totals and averages
    const totalOTIFSum = parsedData.reduce(
      (sum, row) => sum + cleanNumber(row["OTIF"]),
      0
    );
    const rowsWithOTIF = parsedData.filter(row => cleanNumber(row["OTIF"]) > 0).length;
    const avgOTIF = rowsWithOTIF > 0 ? (totalOTIFSum / rowsWithOTIF) : 0;

    const summary = {
      totalRows: parsedData.length,
      
      // Open POs
      totalOpenPos: parsedData.reduce(
        (sum, row) => sum + cleanNumber(row["Open Pos"]),
        0
      ),
      
      // Total Orders (shipped)
      totalOrders: parsedData.reduce(
        (sum, row) => sum + cleanNumber(row["Total orders"]),
        0
      ),
      
      // YTD FY26 Target and Actual
      ytdTarget: parsedData.reduce(
        (sum, row) => sum + cleanNumber(row["YTD Target FY26"]),
        0
      ),
      ytdActual: parsedData.reduce(
        (sum, row) => sum + cleanNumber(row["YTD Actual FY26"]),
        0
      ),
      
      // LYTD (Last Year To Date)
      lytd: parsedData.reduce(
        (sum, row) => sum + cleanNumber(row["LYTD"]),
        0
      ),
      
      // OTIF Rate (average percentage)
      otifRate: `${avgOTIF.toFixed(0)}%`,
      otifRawAverage: avgOTIF,
      
      // Quality Claims
      totalQualityClaimsLY: parsedData.reduce(
        (sum, row) => sum + cleanNumber(row["Quality Claims LY"]),
        0
      ),
      totalQualityClaims: parsedData.reduce(
        (sum, row) => sum + cleanNumber(row["Quality Claims"]),
        0
      ),
      
      
      // SKUs
      totalSKUs: parsedData.reduce(
        (sum, row) => sum + cleanNumber(row["Total SKUs"]),
        0
      ),
      totalConvertedSKUs: parsedData.reduce(
        (sum, row) => sum + cleanNumber(row["Converted SKUs"]),
        0
      ),
    };

    res.json({
      success: true,
      data: {
        headers,
        rows: parsedData,
        summary,
        rowCount: parsedData.length,
      },
    });
  } catch (err) {
    console.error("Error fetching/parsing Excel file:", err.message);

    if (err.response?.status === 404) {
      return res.status(404).json({
        error: "File not found",
        details: "The Excel file URL is not accessible",
      });
    }

    return res.status(500).json({
      error: "Failed to fetch or parse Excel file",
      details: err.message || "An unexpected error occurred",
    });
  }
});

const XLSX = require("xlsx");

router.get("/customer/:customerId/volume-shipped-ytd", async (req, res) => {
  try {
    // Get customer ID from request (adjust based on your auth setup)
    const { customerId } = req.params; // or req.query.customerId, req.session.customerId, etc.

   if (!customerId) {
      return res.status(401).json({
        error: "Unauthorized",
        details: "Customer ID is required"
      });
    }

    // Fetch customer's buyers metafield
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
    
    // Parse the buyers list
    let allowedBuyers = [];
    if (customerBuyersValue) {
      try {
        // Try parsing as JSON first (for list metafield type)
        const parsed = JSON.parse(customerBuyersValue);
        allowedBuyers = Array.isArray(parsed) 
          ? parsed.map(b => b.trim().toUpperCase()).filter(b => b)
          : [customerBuyersValue.trim().toUpperCase()];
      } catch (e) {
        // If not JSON, treat as comma-separated string
        allowedBuyers = customerBuyersValue
          .split(',')
          .map(b => b.trim().toUpperCase())
          .filter(b => b);
      }
    }

    console.log("Customer ID:", customerId);
    console.log("Raw customer buyers value:", customerBuyersValue);
    console.log("Customer allowed buyers (normalized):", allowedBuyers);

    // Fetch shop metafield for Excel file
    const query = `
      query getShopMetafield {
        shop {
          metafield(namespace: "custom", key: "volumeshippedytd") {
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

    console.log("Shopify Response:", JSON.stringify(shopifyResponse.data, null, 2));

    const metafieldData = shopifyResponse.data?.data?.shop?.metafield;

    if (!metafieldData) {
      return res.status(404).json({
        error: "Excel file not found",
        details: "No volumeshippedytd metafield found",
        debugInfo: shopifyResponse.data
      });
    }

    let fileUrl;

    // Case 1: metafield type is file_reference
    if (metafieldData.type === "file_reference") {
      const fileId = metafieldData.value;

      const fileQuery = `
        query getFileUrl($fileId: ID!) {
          node(id: $fileId) {
            ... on GenericFile {
              url
            }
            ... on MediaImage {
              image {
                url
              }
            }
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

      fileUrl =
        fileResponse.data?.data?.node?.url ||
        fileResponse.data?.data?.node?.image?.url;

      if (!fileUrl) {
        return res.status(404).json({
          error: "File URL not found",
          details: "Could not resolve file reference metafield",
        });
      }
    } else {
      // Case 2: direct URL stored as value
      fileUrl = metafieldData.value;
    }

    // Download the file
    const fileResponse = await axios({
      method: "GET",
      url: fileUrl,
      responseType: "arraybuffer",
    });

    // Parse Excel file
    const XLSX = require("xlsx");
    const workbook = XLSX.read(fileResponse.data, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Get the range for debugging
    const range = XLSX.utils.decode_range(worksheet['!ref']);
    console.log("Sheet range:", range);

    // Convert to JSON array format
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false,
    });

    console.log("=== DEBUG INFO ===");
    console.log("Total rows read:", jsonData.length);
    console.log("First 3 rows:", JSON.stringify(jsonData.slice(0, 3), null, 2));
    console.log("==================");

    if (jsonData.length === 0) {
      return res.status(404).json({
        error: "Empty file",
        details: "The Excel file contains no data",
      });
    }

    // Find the first non-empty row (header row)
    let headerRowIndex = 0;
    for (let i = 0; i < jsonData.length; i++) {
      if (jsonData[i] && jsonData[i].length > 0 && jsonData[i][0]) {
        headerRowIndex = i;
        break;
      }
    }

    // Clean and normalize headers
    const headers = jsonData[headerRowIndex].map((h) =>
      h?.toString().trim().replace(/\u00A0/g, " ").replace(/\s+/g, " ")
    );

    console.log("Headers found:", headers);

    // Get data rows (skip header and filter empty rows)
    const rows = jsonData.slice(headerRowIndex + 1).filter(row => 
      row && row.length > 0 && (row[0] || row[1])
    );

    console.log("Number of data rows:", rows.length);

    if (rows.length === 0) {
      return res.status(404).json({
        error: "No data rows found",
        details: "The Excel file contains headers but no data rows",
        headers: headers,
      });
    }

    // Helper to safely parse numbers
    const cleanNumber = (val) => {
      if (val === null || val === undefined || val === "") return 0;
      if (typeof val === "number") return val;
      if (typeof val === "string") {
        const cleaned = val.replace(/[^0-9.\-]/g, "");
        return cleaned ? parseFloat(cleaned) : 0;
      }
      return 0;
    };

    // Parse data rows
    const parsedData = rows.map((row) => {
      const obj = {
        buyer: row[0]?.toString().trim().toUpperCase() || "", // Convert to uppercase
        vendor: row[1]?.toString().trim() || "",
      };

      // Map month columns (starting from index 2)
      headers.slice(2).forEach((month, index) => {
        obj[month] = cleanNumber(row[index + 2]);
      });

      return obj;
    });

    // FILTER DATA BY CUSTOMER'S ALLOWED BUYERS
    const filteredData = allowedBuyers.length > 0
      ? parsedData.filter(row => allowedBuyers.includes(row.buyer))
      : parsedData; // If no buyers specified, return all data

    console.log("Total parsed rows:", parsedData.length);
    console.log("Filtered data rows:", filteredData.length);

    if (filteredData.length === 0 && allowedBuyers.length > 0) {
      return res.json({
        success: true,
        data: {
          headers,
          rows: [],
          summary: {
            totalRows: 0,
            totalsByMonth: {},
            totalsByBuyer: {},
            totalsByVendor: {},
            grandTotal: 0,
          },
          rowCount: 0,
          months: headers.slice(2),
        },
        message: "No data available for your assigned buyers",
        customerBuyers: allowedBuyers
      });
    }

    // Calculate summary statistics BASED ON FILTERED DATA
    const monthColumns = headers.slice(2);
    const summary = {
      totalRows: filteredData.length,
      totalsByMonth: {},
      totalsByBuyer: {},
      totalsByVendor: {},
      grandTotal: 0,
    };

    // Calculate totals by month
    monthColumns.forEach((month) => {
      summary.totalsByMonth[month] = filteredData.reduce(
        (sum, row) => sum + (row[month] || 0),
        0
      );
    });

    // Calculate totals by buyer
    filteredData.forEach((row) => {
      if (row.buyer) {
        if (!summary.totalsByBuyer[row.buyer]) {
          summary.totalsByBuyer[row.buyer] = 0;
        }
        monthColumns.forEach((month) => {
          summary.totalsByBuyer[row.buyer] += row[month] || 0;
        });
      }
    });

    // Calculate totals by vendor
    filteredData.forEach((row) => {
      if (row.vendor) {
        if (!summary.totalsByVendor[row.vendor]) {
          summary.totalsByVendor[row.vendor] = 0;
        }
        monthColumns.forEach((month) => {
          summary.totalsByVendor[row.vendor] += row[month] || 0;
        });
      }
    });

    // Calculate grand total
    summary.grandTotal = Object.values(summary.totalsByMonth).reduce(
      (sum, val) => sum + val,
      0
    );

    res.json({
      success: true,
      data: {
        headers,
        rows: filteredData,
        summary,
        rowCount: filteredData.length,
        months: monthColumns,
      },
      customerBuyers: allowedBuyers, // Include for debugging/transparency
    });
  } catch (err) { 
    console.error("Error fetching/parsing Excel file:", err.message);
    console.error("Full error:", err);

    if (err.response?.status === 404) {
      return res.status(404).json({
        error: "File not found",
        details: "The Excel file URL is not accessible",
      });
    }

    return res.status(500).json({
      error: "Failed to fetch or parse Excel file",
      details: err.message || "An unexpected error occurred",
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

router.get("/customer/:customerId/admin-volume-origin", async (req, res) => {
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
          metafield(namespace: "custom", key: "volumeshippedytd") {
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
    const FISCAL_MONTHS = [
      'April', 'May', 'June', 'July', 'August', 'September',
      'October', 'November', 'December', 'forjan26', 'forfeb26', 'formar26'
    ];
    const scopedMonths = monthColumns.filter(m => FISCAL_MONTHS.includes(m));

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

function normalizeMonthTarget(value) {
  if (!value) return '';
  const str = value.toString().trim();
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // Already a YYYY-MM slug
  const slugMatch = /^([0-9]{4})-(0[1-9]|1[0-2])$/.exec(str);
  if (slugMatch) {
    return `${slugMatch[1]}-${slugMatch[2]}`;
  }

  // "MonthName YYYY" — e.g. "August 2026"
  const labelMatch = /^([A-Za-z]+)\s+([0-9]{4})$/.exec(str);
  if (labelMatch) {
    const monthIndex = monthNames.findIndex(m => m.toLowerCase() === labelMatch[1].toLowerCase());
    if (monthIndex !== -1) {
      return `${labelMatch[2]}-${String(monthIndex + 1).padStart(2, '0')}`;
    }
  }

  // Extract YYYY-MM from longer ISO strings like "2026-08-01", "2026-08-15T00:00:00"
  const isoPartial = str.match(/(\d{4})-(0[1-9]|1[0-2])/);
  if (isoPartial) {
    return `${isoPartial[1]}-${isoPartial[2]}`;
  }

  // Fallback: let JS Date parse it — handles MM/DD/YYYY, DD-Mon-YYYY, Excel date strings, etc.
  // This mirrors exactly what the frontend does
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  return str;
}

function monthMatches(target, month) {
  if (!target || !month) return false;
  const rawTarget = target.toString().trim();
  const rawMonth = month.toString().trim();
  if (!rawTarget || !rawMonth) return false;
  if (rawTarget.startsWith(rawMonth) || rawMonth.startsWith(rawTarget)) return true;
  const normalizedTarget = normalizeMonthTarget(rawTarget);
  const normalizedMonth = normalizeMonthTarget(rawMonth);
  return normalizedTarget && normalizedMonth && normalizedTarget === normalizedMonth;
}

router.get("/customer/:customerId/fy26-open-po", async (req, res) => {
  try {
    const { customerId } = req.params;
    const { buyers: buyersParam, merchant } = req.query;

    if (!customerId) {
      return res.status(401).json({ error: "Unauthorized", details: "Customer ID is required" });
    }

    // ── STEP 1: Resolve allowedBuyers ──
    let allowedBuyers = [];
    let fullBuyerList = [];

    const customerQuery = `
      query getCustomerBuyers($customerId: ID!) {
        customer(id: $customerId) {
          id
          metafield(namespace: "custom", key: "buyers") { value }
        }
      }
    `;
    const customerResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
      data: { query: customerQuery, variables: { customerId: `gid://shopify/Customer/${customerId}` } },
    });
    const rawValue = customerResponse.data?.data?.customer?.metafield?.value;
    if (rawValue) {
      try {
        const parsed = JSON.parse(rawValue);
        fullBuyerList = Array.isArray(parsed)
          ? parsed.map(b => b.trim().toUpperCase()).filter(Boolean)
          : [rawValue.trim().toUpperCase()];
      } catch {
        fullBuyerList = rawValue.split(',').map(b => b.trim().toUpperCase()).filter(Boolean);
      }
    }

    if (buyersParam) {
      allowedBuyers = buyersParam.split('||').map(b => b.trim().toUpperCase()).filter(Boolean);
    } else {
      allowedBuyers = fullBuyerList;
    }

    // ── STEP 2: Fetch Excel file from shop metafield ──
    const shopQuery = `
      query getShopMetafield {
        shop {
          metafield(namespace: "custom", key: "openposummary26") {
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
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
      data: { query: shopQuery },
    });

    const metafieldData = shopifyResponse.data?.data?.shop?.metafield;
    if (!metafieldData) {
      return res.status(404).json({ error: "Excel file not found", details: "No openposummary26 metafield found" });
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
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
        data: { query: fileQuery, variables: { fileId: metafieldData.value } },
      });
      fileUrl = fileResponse.data?.data?.node?.url || fileResponse.data?.data?.node?.image?.url;
      if (!fileUrl) return res.status(404).json({ error: "File URL not found" });
    } else {
      fileUrl = metafieldData.value;
    }

    const fileResponse = await axios({ method: "GET", url: fileUrl, responseType: "arraybuffer" });

    // ── STEP 3: Parse Excel ──
    // File is pre-cleaned (flat, one row per line item, no subtotals, no merged cells)
    const XLSX = require("xlsx");
    const workbook = XLSX.read(fileResponse.data, { type: "buffer" });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];

    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false,
    });

    if (jsonData.length < 2) {
      return res.status(404).json({ error: "Empty or invalid file" });
    }

    // Row 0 is headers — map by name so column order changes don't break anything
    const headers = jsonData[0].map(h => h?.toString().trim().replace(/\s+/g, " ") || "");
    const colIdx  = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

    const col = {
      customer:       colIdx("Customer"),
      vendor:         colIdx("Vendor"),
      poNo:           colIdx("PO No."),
      item:           colIdx("Item"),
      orderQty:       colIdx("Order Qty"),
      orderPrice:     colIdx("Order Price"),
      orderValue:     colIdx("Order Value in US $"),
      orderDate:      colIdx("Order Date"),
      shippedQty:     colIdx("Shipped Qty"),
      shippedValue:   colIdx("Shipped Value in US $"),
      shippedDate:    colIdx("Shipped Date"),
      cancelledQty:   colIdx("Cancelled Qty"),
      cancelledValue: colIdx("Cancelled Value in US $"),
      balanceQty:     colIdx("Balance Qty"),
      balanceValue:   colIdx("Balance Value in US $"),
      target:         colIdx("Target"),
      totalBusiness:  colIdx("Total Business"),
      status:         colIdx("Status"),
    };

    const cleanNum = (val) => {
      if (val === null || val === undefined || val === "") return 0;
      if (typeof val === "number") return val;
      const cleaned = val.toString().replace(/[^0-9.\-]/g, "");
      return cleaned ? parseFloat(cleaned) : 0;
    };

    // Straight map — no forward-fill, no subtotal filtering needed
    // The Apps Script cleaner produces one clean row per line item
    const allRows = jsonData.slice(1)
      .filter(row => row && row.length > 0 && (row[col.customer] || "").toString().trim())
      .map(row => ({
        customer:       (row[col.customer]  || "").toString().trim(),
        vendor:         (row[col.vendor]    || "").toString().trim(),
        poNo:           (row[col.poNo]      || "").toString().trim(),
        item:           (row[col.item]      || "").toString().trim(),
        orderQty:       cleanNum(row[col.orderQty]),
        orderPrice:     cleanNum(row[col.orderPrice]),
        orderValue:     cleanNum(row[col.orderValue]),
        orderDate:      (row[col.orderDate]  || "").toString().trim(),
        shippedQty:     cleanNum(row[col.shippedQty]),
        shippedValue:   cleanNum(row[col.shippedValue]),
        shippedDate:    (row[col.shippedDate] || "").toString().trim(),
        cancelledQty:   cleanNum(row[col.cancelledQty]),
        cancelledValue: cleanNum(row[col.cancelledValue]),
        balanceQty:     cleanNum(row[col.balanceQty]),
        balanceValue:   cleanNum(row[col.balanceValue]),
        target:         (row[col.target]     || "").toString().trim(),
        totalBusiness:  cleanNum(row[col.totalBusiness]),
        status:         (row[col.status]     || "").toString().trim(),
      }));

    // STEP 4: Merchant override — only resolve merchant's buyers when NO specific buyer passed
    if (merchant) {
      if (buyersParam) {
        // Specific buyer explicitly selected — keep it, just verify merchant context is set
        // allowedBuyers already set from buyersParam, merchant is just context for the backend
        // No override needed — the buyer filter takes priority
        console.log(`Merchant ${merchant} set but specific buyer ${buyersParam} takes priority`);
      } else {
        // No specific buyer — resolve all buyers for this merchant
        allowedBuyers = await resolveBuyersForMerchant(merchant, allowedBuyers);
      }
    }

    // ── STEP 5: Filter by customer (exact match, uppercase) ──
    const filteredRows = allowedBuyers.length > 0
      ? allRows.filter(row => allowedBuyers.includes(row.customer.toUpperCase()))
      : allRows;
    
    const { month } = req.query;  // e.g. "2026-05" or "May 2026"
    const monthFilteredRows = month
      ? filteredRows.filter(r => monthMatches(r.target, month))
      : filteredRows;

    console.log("Total parsed rows:", allRows.length, "| Month Filtered rows:", monthFilteredRows.length);

    if (monthFilteredRows.length === 0 && allowedBuyers.length > 0) {
      return res.json({
        success: true,
        data: {
          rows: [],
          summary: {
            totalOrderValue: 0, totalBalanceValue: 0,
            totalShippedValue: 0, totalCancelledValue: 0,
            totalBusiness: 0, byStatus: {}, byPo: {}, byVendor: {},
          },
          rowCount: 0,
        },
        message: "No open PO data available for your assigned buyers",
        customerBuyers: allowedBuyers,
      });
    }

    // ── STEP 6: Build summary ──
    const summary = {
      totalOrderValue:     monthFilteredRows.reduce((s, r) => s + r.orderValue,    0),
      totalShippedValue:   monthFilteredRows.reduce((s, r) => s + r.shippedValue,  0),
      totalCancelledValue: monthFilteredRows.reduce((s, r) => s + r.cancelledValue,0),
      totalBalanceValue:   monthFilteredRows.reduce((s, r) => s + r.balanceValue,  0),
      totalBusiness:       monthFilteredRows.reduce((s, r) => s + r.totalBusiness, 0),
      byStatus:   {},
      byPo:       {},
      byVendor:   {},
      byCustomer: {},
    };

    monthFilteredRows.forEach(row => {
      const status = row.status || "Unknown";
      if (!summary.byStatus[status]) summary.byStatus[status] = { count: 0, orderValue: 0, balanceValue: 0 };
      summary.byStatus[status].count++;
      summary.byStatus[status].orderValue   += row.orderValue;
      summary.byStatus[status].balanceValue += row.balanceValue;
    });

    monthFilteredRows.forEach(row => {
      const key = `${row.vendor}__${row.poNo}` || "Unknown";
      if (!summary.byPo[key]) {
        summary.byPo[key] = {
          customer: row.customer, vendor: row.vendor, poNo: row.poNo,
          orderDate: row.orderDate, target: row.target,
          orderValue: 0, balanceValue: 0, shippedValue: 0, itemCount: 0,
        };
      }
      summary.byPo[key].orderValue   += row.orderValue;
      summary.byPo[key].balanceValue += row.balanceValue;
      summary.byPo[key].shippedValue += row.shippedValue;
      summary.byPo[key].itemCount++;
    });

    monthFilteredRows.forEach(row => {
      const vendor = row.vendor || "Unknown";
      if (!summary.byVendor[vendor]) summary.byVendor[vendor] = { orderValue: 0, balanceValue: 0, poCount: 0 };
      summary.byVendor[vendor].orderValue   += row.orderValue;
      summary.byVendor[vendor].balanceValue += row.balanceValue;
    });
    Object.values(summary.byPo).forEach(po => {
      const vk = po.vendor || "Unknown";
      if (summary.byVendor[vk]) summary.byVendor[vk].poCount++;
    });

    monthFilteredRows.forEach(row => {
      const customer = row.customer || "Unknown";
      if (!summary.byCustomer[customer]) summary.byCustomer[customer] = { orderValue: 0, balanceValue: 0, poCount: 0 };
      summary.byCustomer[customer].orderValue   += row.orderValue;
      summary.byCustomer[customer].balanceValue += row.balanceValue;
    });
    Object.values(summary.byPo).forEach(po => {
      if (summary.byCustomer[po.customer]) summary.byCustomer[po.customer].poCount++;
    });

    return res.json({
      success: true,
      data: {
        rows: monthFilteredRows,
        summary,
        rowCount: monthFilteredRows.length,
      },
      customerBuyers: allowedBuyers,
      allCustomerBuyers: fullBuyerList, 
    });

  } catch (err) {
    console.error("Error fetching/parsing open PO file:", err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: "File not found", details: "The Excel file URL is not accessible" });
    }
    return res.status(500).json({
      error: "Failed to fetch or parse open PO file",
      details: err.message || "An unexpected error occurred",
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

router.get("/customer/:customerId/fy27-open-po", async (req, res) => {
  try {
    const { customerId } = req.params;
    const { buyers: buyersParam, merchant } = req.query;

    if (!customerId) {
      return res.status(401).json({ error: "Unauthorized", details: "Customer ID is required" });
    }

    // ── STEP 1: Resolve allowedBuyers ──
    let allowedBuyers = [];
    let fullBuyerList = []; // ← always the complete list for this merchant/customer

    // Always fetch full list from metafield first
    const customerQuery = `
      query getCustomerBuyers($customerId: ID!) {
        customer(id: $customerId) {
          id
          metafield(namespace: "custom", key: "buyers") { value }
        }
      }
    `;
    const customerResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
      data: { query: customerQuery, variables: { customerId: `gid://shopify/Customer/${customerId}` } },
    });
    const rawValue = customerResponse.data?.data?.customer?.metafield?.value;
    if (rawValue) {
      try {
        const parsed = JSON.parse(rawValue);
        fullBuyerList = Array.isArray(parsed)
          ? parsed.map(b => b.trim().toUpperCase()).filter(Boolean)
          : [rawValue.trim().toUpperCase()];
      } catch {
        fullBuyerList = rawValue.split(',').map(b => b.trim().toUpperCase()).filter(Boolean);
      }
    }

    // buyersParam overrides filtering only — NOT the full list
    if (buyersParam) {
      allowedBuyers = buyersParam.split('||').map(b => b.trim().toUpperCase()).filter(Boolean);
      console.log("Buyers passed directly via param:", allowedBuyers);
    } else {
      allowedBuyers = fullBuyerList;
      console.log("Customer ID:", customerId, "| Allowed buyers:", allowedBuyers);
    }

    // ── STEP 2: Fetch Excel file from shop metafield ──
    const shopQuery = `
      query getShopMetafield {
        shop {
          metafield(namespace: "custom", key: "openpofy27summary") {
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
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
      data: { query: shopQuery },
    });

    const metafieldData = shopifyResponse.data?.data?.shop?.metafield;
    if (!metafieldData) {
      return res.status(404).json({ error: "Excel file not found", details: "No openpofy27summary metafield found" });
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
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
        data: { query: fileQuery, variables: { fileId: metafieldData.value } },
      });
      fileUrl = fileResponse.data?.data?.node?.url || fileResponse.data?.data?.node?.image?.url;
      if (!fileUrl) return res.status(404).json({ error: "File URL not found" });
    } else {
      fileUrl = metafieldData.value;
    }

    const fileResponse = await axios({ method: "GET", url: fileUrl, responseType: "arraybuffer" });

    // ── STEP 3: Parse Excel ──
    // File is pre-cleaned by Apps Script (flat, one row per line item, no subtotals)
    const XLSX = require("xlsx");
    const workbook = XLSX.read(fileResponse.data, { type: "buffer" });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];

    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false,
    });

    if (jsonData.length < 2) {
      return res.status(404).json({ error: "Empty or invalid file" });
    }

    // Row 0 is headers — map by name so column order changes don't break anything
    const headers = jsonData[0].map(h => h?.toString().trim().replace(/\s+/g, " ") || "");
    const colIdx  = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

    const col = {
      customer:       colIdx("Customer"),
      vendor:         colIdx("Vendor"),
      poNo:           colIdx("PO No."),
      item:           colIdx("Item"),
      orderQty:       colIdx("Order Qty"),
      orderPrice:     colIdx("Order Price"),
      orderValue:     colIdx("Order Value in US $"),
      orderDate:      colIdx("Order Date"),
      shippedQty:     colIdx("Shipped Qty"),
      shippedValue:   colIdx("Shipped Value in US $"),
      shippedDate:    colIdx("Shipped Date"),
      cancelledQty:   colIdx("Cancelled Qty"),
      cancelledValue: colIdx("Cancelled Value in US $"),
      balanceQty:     colIdx("Balance Qty"),
      balanceValue:   colIdx("Balance Value in US $"),
      target:         colIdx("Target"),
      totalBusiness:  colIdx("Total Business"),
      status:         colIdx("Status"),
    };

    const cleanNum = (val) => {
      if (val === null || val === undefined || val === "") return 0;
      if (typeof val === "number") return val;
      const cleaned = val.toString().replace(/[^0-9.\-]/g, "");
      return cleaned ? parseFloat(cleaned) : 0;
    };

    // Straight map — no forward-fill, no subtotal filtering needed
    // The Apps Script cleaner produces one clean row per line item
    const allRows = jsonData.slice(1)
      .filter(row => row && row.length > 0 && (row[col.customer] || "").toString().trim())
      .map(row => ({
        customer:       (row[col.customer]  || "").toString().trim(),
        vendor:         (row[col.vendor]    || "").toString().trim(),
        poNo:           (row[col.poNo]      || "").toString().trim(),
        item:           (row[col.item]      || "").toString().trim(),
        orderQty:       cleanNum(row[col.orderQty]),
        orderPrice:     cleanNum(row[col.orderPrice]),
        orderValue:     cleanNum(row[col.orderValue]),
        orderDate:      (row[col.orderDate]  || "").toString().trim(),
        shippedQty:     cleanNum(row[col.shippedQty]),
        shippedValue:   cleanNum(row[col.shippedValue]),
        shippedDate:    (row[col.shippedDate] || "").toString().trim(),
        cancelledQty:   cleanNum(row[col.cancelledQty]),
        cancelledValue: cleanNum(row[col.cancelledValue]),
        balanceQty:     cleanNum(row[col.balanceQty]),
        balanceValue:   cleanNum(row[col.balanceValue]),
        target:         (row[col.target]     || "").toString().trim(),
        totalBusiness:  cleanNum(row[col.totalBusiness]),
        status:         (row[col.status]     || "").toString().trim(),
      }));

    // STEP 4: Merchant override — only resolve merchant's buyers when NO specific buyer passed
    if (merchant) {
      if (buyersParam) {
        // Specific buyer explicitly selected — keep it, just verify merchant context is set
        // allowedBuyers already set from buyersParam, merchant is just context for the backend
        // No override needed — the buyer filter takes priority
        console.log(`Merchant ${merchant} set but specific buyer ${buyersParam} takes priority`);
      } else {
        // No specific buyer — resolve all buyers for this merchant
        allowedBuyers = await resolveBuyersForMerchant(merchant, allowedBuyers);
      }
    }

    // ── STEP 5: Filter by customer (exact match, uppercase) ──
    const filteredRows = allowedBuyers.length > 0
      ? allRows.filter(row => allowedBuyers.includes(row.customer.toUpperCase()))
      : allRows;

    const { month } = req.query;
    const monthFilteredRows = month
      ? filteredRows.filter(r => monthMatches(r.target, month))
      : filteredRows;

    console.log("Total parsed rows:", allRows.length, "| Month Filtered rows:", monthFilteredRows.length);

    if (monthFilteredRows.length === 0 && allowedBuyers.length > 0) {
      return res.json({
        success: true,
        data: {
          rows: [],
          summary: {
            totalOrderValue: 0, totalBalanceValue: 0,
            totalShippedValue: 0, totalCancelledValue: 0,
            totalBusiness: 0, byStatus: {}, byPo: {}, byVendor: {},
          },
          rowCount: 0,
        },
        message: "No open PO data available for your assigned buyers",
        customerBuyers: allowedBuyers,
      });
    }

    // ── STEP 6: Build summary ──
    const summary = {
      totalOrderValue:     monthFilteredRows.reduce((s, r) => s + r.orderValue,    0),
      totalShippedValue:   monthFilteredRows.reduce((s, r) => s + r.shippedValue,  0),
      totalCancelledValue: monthFilteredRows.reduce((s, r) => s + r.cancelledValue,0),
      totalBalanceValue:   monthFilteredRows.reduce((s, r) => s + r.balanceValue,  0),
      totalBusiness:       monthFilteredRows.reduce((s, r) => s + r.totalBusiness, 0),
      byStatus:   {},
      byPo:       {},
      byVendor:   {},
      byCustomer: {},
    };

    monthFilteredRows.forEach(row => {
      const status = row.status || "Unknown";
      if (!summary.byStatus[status]) summary.byStatus[status] = { count: 0, orderValue: 0, balanceValue: 0 };
      summary.byStatus[status].count++;
      summary.byStatus[status].orderValue   += row.orderValue;
      summary.byStatus[status].balanceValue += row.balanceValue;
    });

    monthFilteredRows.forEach(row => {
      const key = `${row.vendor}__${row.poNo}` || "Unknown";
      if (!summary.byPo[key]) {
        summary.byPo[key] = {
          customer: row.customer, vendor: row.vendor, poNo: row.poNo,
          orderDate: row.orderDate, target: row.target,
          orderValue: 0, balanceValue: 0, shippedValue: 0, itemCount: 0,
        };
      }
      summary.byPo[key].orderValue   += row.orderValue;
      summary.byPo[key].balanceValue += row.balanceValue;
      summary.byPo[key].shippedValue += row.shippedValue;
      summary.byPo[key].itemCount++;
    });

    monthFilteredRows.forEach(row => {
      const vendor = row.vendor || "Unknown";
      if (!summary.byVendor[vendor]) summary.byVendor[vendor] = { orderValue: 0, balanceValue: 0, poCount: 0 };
      summary.byVendor[vendor].orderValue   += row.orderValue;
      summary.byVendor[vendor].balanceValue += row.balanceValue;
    });
    Object.values(summary.byPo).forEach(po => {
      const vk = po.vendor || "Unknown";
      if (summary.byVendor[vk]) summary.byVendor[vk].poCount++;
    });

    monthFilteredRows.forEach(row => {
      const customer = row.customer || "Unknown";
      if (!summary.byCustomer[customer]) summary.byCustomer[customer] = { orderValue: 0, balanceValue: 0, poCount: 0 };
      summary.byCustomer[customer].orderValue   += row.orderValue;
      summary.byCustomer[customer].balanceValue += row.balanceValue;
    });
    Object.values(summary.byPo).forEach(po => {
      if (summary.byCustomer[po.customer]) summary.byCustomer[po.customer].poCount++;
    });

    return res.json({
      success: true,
      data: {
        rows: monthFilteredRows,
        summary,
        rowCount: monthFilteredRows.length,
      },
      customerBuyers: allowedBuyers,
      allCustomerBuyers: fullBuyerList,  
    });

  } catch (err) {
    console.error("Error fetching/parsing FY27 open PO file:", err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: "File not found", details: "The Excel file URL is not accessible" });
    }
    return res.status(500).json({
      error: "Failed to fetch or parse FY27 open PO file",
      details: err.message || "An unexpected error occurred",
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});


router.get("/customer/:customerId/fy26-shipped-po", async (req, res) => {
  try {
    const { customerId } = req.params;
    const { buyers: buyersParam, merchant } = req.query;

    if (!customerId) {
      return res.status(401).json({ error: "Unauthorized", details: "Customer ID is required" });
    }

    // ── STEP 1: Resolve allowedBuyers ──
    let allowedBuyers = [];
    let fullBuyerList = [];

    const customerQuery = `
      query getCustomerBuyers($customerId: ID!) {
        customer(id: $customerId) {
          id
          metafield(namespace: "custom", key: "buyers") { value }
        }
      }
    `;
    const customerResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
      data: { query: customerQuery, variables: { customerId: `gid://shopify/Customer/${customerId}` } },
    });
    const rawValue = customerResponse.data?.data?.customer?.metafield?.value;
    if (rawValue) {
      try {
        const parsed = JSON.parse(rawValue);
        fullBuyerList = Array.isArray(parsed)
          ? parsed.map(b => b.trim().toUpperCase()).filter(Boolean)
          : [rawValue.trim().toUpperCase()];
      } catch {
        fullBuyerList = rawValue.split(',').map(b => b.trim().toUpperCase()).filter(Boolean);
      }
    }

    if (buyersParam) {
      allowedBuyers = buyersParam.split('||').map(b => b.trim().toUpperCase()).filter(Boolean);
    } else {
      allowedBuyers = fullBuyerList;
    }

    // ── STEP 2: Fetch Excel file from shop metafield ──
    const shopQuery = `
      query getShopMetafield {
        shop {
          metafield(namespace: "custom", key: "shippedpofy26summary") {
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
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
      data: { query: shopQuery },
    });

    const metafieldData = shopifyResponse.data?.data?.shop?.metafield;
    if (!metafieldData) {
      return res.status(404).json({ error: "Excel file not found", details: "No shippedpofy26summary metafield found" });
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
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
        data: { query: fileQuery, variables: { fileId: metafieldData.value } },
      });
      fileUrl = fileResponse.data?.data?.node?.url || fileResponse.data?.data?.node?.image?.url;
      if (!fileUrl) return res.status(404).json({ error: "File URL not found" });
    } else {
      fileUrl = metafieldData.value;
    }

    const fileResponse = await axios({ method: "GET", url: fileUrl, responseType: "arraybuffer" });

    // ── STEP 3: Parse Excel ──
    // File is pre-cleaned by Apps Script (flat, one row per line item, no subtotals)
    const XLSX = require("xlsx");
    const workbook = XLSX.read(fileResponse.data, { type: "buffer" });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];

    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false,
    });

    if (jsonData.length < 2) {
      return res.status(404).json({ error: "Empty or invalid file" });
    }

    // Row 0 is headers — map by name so column order changes don't break anything
    const headers = jsonData[0].map(h => h?.toString().trim().replace(/\s+/g, " ") || "");
    const colIdx  = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

    const col = {
      customer:       colIdx("Customer"),
      vendor:         colIdx("Vendor"),
      poNo:           colIdx("PO No."),
      item:           colIdx("Item"),
      orderQty:       colIdx("Order Qty"),
      orderPrice:     colIdx("Order Price"),
      orderValue:     colIdx("Order Value in US $"),
      orderDate:      colIdx("Order Date"),
      shippedQty:     colIdx("Shipped Qty"),
      shippedValue:   colIdx("Shipped Value in US $"),
      shippedDate:    colIdx("Shipped Date"),
      cancelledQty:   colIdx("Cancelled Qty"),
      cancelledValue: colIdx("Cancelled Value in US $"),
      balanceQty:     colIdx("Balance Qty"),
      balanceValue:   colIdx("Balance Value in US $"),
      target:         colIdx("Target"),
      totalBusiness:  colIdx("Total Business"),
      status:         colIdx("Status"),
    };

    const cleanNum = (val) => {
      if (val === null || val === undefined || val === "") return 0;
      if (typeof val === "number") return val;
      const cleaned = val.toString().replace(/[^0-9.\-]/g, "");
      return cleaned ? parseFloat(cleaned) : 0;
    };

    // Straight map — no forward-fill, no subtotal filtering needed
    // The Apps Script cleaner produces one clean row per line item
    const allRows = jsonData.slice(1)
      .filter(row => row && row.length > 0 && (row[col.customer] || "").toString().trim())
      .map(row => ({
        customer:       (row[col.customer]  || "").toString().trim(),
        vendor:         (row[col.vendor]    || "").toString().trim(),
        poNo:           (row[col.poNo]      || "").toString().trim(),
        item:           (row[col.item]      || "").toString().trim(),
        orderQty:       cleanNum(row[col.orderQty]),
        orderPrice:     cleanNum(row[col.orderPrice]),
        orderValue:     cleanNum(row[col.orderValue]),
        orderDate:      (row[col.orderDate]  || "").toString().trim(),
        shippedQty:     cleanNum(row[col.shippedQty]),
        shippedValue:   cleanNum(row[col.shippedValue]),
        shippedDate:    (row[col.shippedDate] || "").toString().trim(),
        cancelledQty:   cleanNum(row[col.cancelledQty]),
        cancelledValue: cleanNum(row[col.cancelledValue]),
        balanceQty:     cleanNum(row[col.balanceQty]),
        balanceValue:   cleanNum(row[col.balanceValue]),
        target:         (row[col.target]     || "").toString().trim(),
        totalBusiness:  cleanNum(row[col.totalBusiness]),
        status:         (row[col.status]     || "").toString().trim(),
      }));

    // STEP 4: Merchant override — only resolve merchant's buyers when NO specific buyer passed
    if (merchant) {
      if (buyersParam) {
        // Specific buyer explicitly selected — keep it, just verify merchant context is set
        // allowedBuyers already set from buyersParam, merchant is just context for the backend
        // No override needed — the buyer filter takes priority
        console.log(`Merchant ${merchant} set but specific buyer ${buyersParam} takes priority`);
      } else {
        // No specific buyer — resolve all buyers for this merchant
        allowedBuyers = await resolveBuyersForMerchant(merchant, allowedBuyers);
      }
    }

    // ── STEP 5: Filter by customer (exact match, uppercase) ──
    const filteredRows = allowedBuyers.length > 0
      ? allRows.filter(row => allowedBuyers.includes(row.customer.toUpperCase()))
      : allRows;

    const { month } = req.query;
    const monthFilteredRows = month
      ? filteredRows.filter(r => monthMatches(r.target, month))
      : filteredRows;

    console.log("Total parsed rows:", allRows.length, "| Month Filtered rows:", monthFilteredRows.length);

    if (monthFilteredRows.length === 0 && allowedBuyers.length > 0) {
      return res.json({
        success: true,
        data: {
          rows: [],
          summary: {
            totalOrderValue: 0, totalBalanceValue: 0,
            totalShippedValue: 0, totalCancelledValue: 0,
            totalBusiness: 0, byStatus: {}, byPo: {}, byVendor: {},
          },
          rowCount: 0,
        },
        message: "No open PO data available for your assigned buyers",
        customerBuyers: allowedBuyers,
      });
    }

    // ── STEP 6: Build summary ──
    const summary = {
      totalOrderValue:     monthFilteredRows.reduce((s, r) => s + r.orderValue,    0),
      totalShippedValue:   monthFilteredRows.reduce((s, r) => s + r.shippedValue,  0),
      totalCancelledValue: monthFilteredRows.reduce((s, r) => s + r.cancelledValue,0),
      totalBalanceValue:   monthFilteredRows.reduce((s, r) => s + r.balanceValue,  0),
      totalBusiness:       monthFilteredRows.reduce((s, r) => s + r.totalBusiness, 0),
      byStatus:   {},
      byPo:       {},
      byVendor:   {},
      byCustomer: {},
    };

    monthFilteredRows.forEach(row => {
      const status = row.status || "Unknown";
      if (!summary.byStatus[status]) summary.byStatus[status] = { count: 0, orderValue: 0, balanceValue: 0 };
      summary.byStatus[status].count++;
      summary.byStatus[status].orderValue   += row.orderValue;
      summary.byStatus[status].balanceValue += row.balanceValue;
    });

    monthFilteredRows.forEach(row => {
      const key = `${row.vendor}__${row.poNo}` || "Unknown";
      if (!summary.byPo[key]) {
        summary.byPo[key] = {
          customer: row.customer, vendor: row.vendor, poNo: row.poNo,
          orderDate: row.orderDate, target: row.target,
          orderValue: 0, balanceValue: 0, shippedValue: 0, itemCount: 0,
        };
      }
      summary.byPo[key].orderValue   += row.orderValue;
      summary.byPo[key].balanceValue += row.balanceValue;
      summary.byPo[key].shippedValue += row.shippedValue;
      summary.byPo[key].itemCount++;
    });

    monthFilteredRows.forEach(row => {
      const vendor = row.vendor || "Unknown";
      if (!summary.byVendor[vendor]) summary.byVendor[vendor] = { orderValue: 0, balanceValue: 0, poCount: 0 };
      summary.byVendor[vendor].orderValue   += row.orderValue;
      summary.byVendor[vendor].balanceValue += row.balanceValue;
    });
    Object.values(summary.byPo).forEach(po => {
      const vk = po.vendor || "Unknown";
      if (summary.byVendor[vk]) summary.byVendor[vk].poCount++;
    });

    monthFilteredRows.forEach(row => {
      const customer = row.customer || "Unknown";
      if (!summary.byCustomer[customer]) summary.byCustomer[customer] = { orderValue: 0, balanceValue: 0, poCount: 0 };
      summary.byCustomer[customer].orderValue   += row.orderValue;
      summary.byCustomer[customer].balanceValue += row.balanceValue;
    });
    Object.values(summary.byPo).forEach(po => {
      if (summary.byCustomer[po.customer]) summary.byCustomer[po.customer].poCount++;
    });

    return res.json({
      success: true,
      data: {
        rows: monthFilteredRows,
        summary,
        rowCount: monthFilteredRows.length,
      },
      customerBuyers: allowedBuyers,
      allCustomerBuyers: fullBuyerList,
    });

  } catch (err) {
    console.error("Error fetching/parsing FY26 shipped PO file:", err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: "File not found", details: "The Excel file URL is not accessible" });
    }
    return res.status(500).json({
      error: "Failed to fetch or parse FY26 shipped PO file",
      details: err.message || "An unexpected error occurred",
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

router.get("/customer/:customerId/fy27-shipped-po", async (req, res) => {
  try {
    const { customerId } = req.params;
    const { buyers: buyersParam, merchant } = req.query;

    if (!customerId) {
      return res.status(401).json({ error: "Unauthorized", details: "Customer ID is required" });
    }

    // ── STEP 1: Resolve allowedBuyers ──
    let allowedBuyers = [];
    let fullBuyerList = [];

    const customerQuery = `
      query getCustomerBuyers($customerId: ID!) {
        customer(id: $customerId) {
          id
          metafield(namespace: "custom", key: "buyers") { value }
        }
      }
    `;
    const customerResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
      data: { query: customerQuery, variables: { customerId: `gid://shopify/Customer/${customerId}` } },
    });
    const rawValue = customerResponse.data?.data?.customer?.metafield?.value;
    if (rawValue) {
      try {
        const parsed = JSON.parse(rawValue);
        fullBuyerList = Array.isArray(parsed)
          ? parsed.map(b => b.trim().toUpperCase()).filter(Boolean)
          : [rawValue.trim().toUpperCase()];
      } catch {
        fullBuyerList = rawValue.split(',').map(b => b.trim().toUpperCase()).filter(Boolean);
      }
    }

    if (buyersParam) {
      allowedBuyers = buyersParam.split('||').map(b => b.trim().toUpperCase()).filter(Boolean);
    } else {
      allowedBuyers = fullBuyerList;
    }

    // ── Fetch Excel file — KEY CHANGE: "shippedpofy27summary" ──
    const shopQuery = `
      query getShopMetafield {
        shop {
          metafield(namespace: "custom", key: "shippedpofy27summary") {
            id value type
          }
        }
      }
    `;
    const shopifyResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
      data: { query: shopQuery },
    });

    const metafieldData = shopifyResponse.data?.data?.shop?.metafield;
    if (!metafieldData) {
      return res.status(404).json({ error: "Excel file not found", details: "No shippedpofy27summary metafield found" });
    }

    let fileUrl;
    if (metafieldData.type === "file_reference") {
      const fileQuery = `query getFileUrl($fileId: ID!) { node(id: $fileId) { ... on GenericFile { url } ... on MediaImage { image { url } } } }`;
      const fileResponse = await axios({
        method: "POST",
        url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
        data: { query: fileQuery, variables: { fileId: metafieldData.value } },
      });
      fileUrl = fileResponse.data?.data?.node?.url || fileResponse.data?.data?.node?.image?.url;
      if (!fileUrl) return res.status(404).json({ error: "File URL not found" });
    } else {
      fileUrl = metafieldData.value;
    }

    const fileResponse = await axios({ method: "GET", url: fileUrl, responseType: "arraybuffer" });
    const XLSX = require("xlsx");
    const workbook = XLSX.read(fileResponse.data, { type: "buffer" });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", blankrows: false, raw: false });

    if (jsonData.length < 2) return res.status(404).json({ error: "Empty or invalid file" });

    const headers = jsonData[0].map(h => h?.toString().trim().replace(/\s+/g, " ") || "");
    const colIdx = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

    const col = {
      customer: colIdx("Customer"), vendor: colIdx("Vendor"), poNo: colIdx("PO No."),
      item: colIdx("Item"), orderQty: colIdx("Order Qty"), orderPrice: colIdx("Order Price"),
      orderValue: colIdx("Order Value in US $"), orderDate: colIdx("Order Date"),
      shippedQty: colIdx("Shipped Qty"), shippedValue: colIdx("Shipped Value in US $"),
      shippedDate: colIdx("Shipped Date"), cancelledQty: colIdx("Cancelled Qty"),
      cancelledValue: colIdx("Cancelled Value in US $"), balanceQty: colIdx("Balance Qty"),
      balanceValue: colIdx("Balance Value in US $"), target: colIdx("Target"),
      totalBusiness: colIdx("Total Business"), status: colIdx("Status"),
    };

    const cleanNum = (val) => {
      if (val === null || val === undefined || val === "") return 0;
      if (typeof val === "number") return val;
      const cleaned = val.toString().replace(/[^0-9.\-]/g, "");
      return cleaned ? parseFloat(cleaned) : 0;
    };

    const allRows = jsonData.slice(1)
      .filter(row => row && row.length > 0 && (row[col.customer] || "").toString().trim())
      .map(row => ({
        customer:       (row[col.customer]  || "").toString().trim(),
        vendor:         (row[col.vendor]    || "").toString().trim(),
        poNo:           (row[col.poNo]      || "").toString().trim(),
        item:           (row[col.item]      || "").toString().trim(),
        orderQty:       cleanNum(row[col.orderQty]),
        orderPrice:     cleanNum(row[col.orderPrice]),
        orderValue:     cleanNum(row[col.orderValue]),
        orderDate:      (row[col.orderDate]  || "").toString().trim(),
        shippedQty:     cleanNum(row[col.shippedQty]),
        shippedValue:   cleanNum(row[col.shippedValue]),
        shippedDate:    (row[col.shippedDate] || "").toString().trim(),
        cancelledQty:   cleanNum(row[col.cancelledQty]),
        cancelledValue: cleanNum(row[col.cancelledValue]),
        balanceQty:     cleanNum(row[col.balanceQty]),
        balanceValue:   cleanNum(row[col.balanceValue]),
        target:         (row[col.target]     || "").toString().trim(),
        totalBusiness:  cleanNum(row[col.totalBusiness]),
        status:         (row[col.status]     || "").toString().trim(),
      }));

    // STEP 4: Merchant override — only resolve merchant's buyers when NO specific buyer passed
    if (merchant) {
      if (buyersParam) {
        // Specific buyer explicitly selected — keep it, just verify merchant context is set
        // allowedBuyers already set from buyersParam, merchant is just context for the backend
        // No override needed — the buyer filter takes priority
        console.log(`Merchant ${merchant} set but specific buyer ${buyersParam} takes priority`);
      } else {
        // No specific buyer — resolve all buyers for this merchant
        allowedBuyers = await resolveBuyersForMerchant(merchant, allowedBuyers);
      }
    }

    const filteredRows = allowedBuyers.length > 0
      ? allRows.filter(row => allowedBuyers.includes(row.customer.toUpperCase()))
      : allRows;

    const { month } = req.query;
    const monthFilteredRows = month
      ? filteredRows.filter(r => monthMatches(r.target, month))
      : filteredRows;

    if (monthFilteredRows.length === 0 && allowedBuyers.length > 0) {
      return res.json({
        success: true,
        data: { rows: [], summary: { totalOrderValue: 0, totalBalanceValue: 0, totalShippedValue: 0, totalCancelledValue: 0, totalBusiness: 0, byStatus: {}, byPo: {}, byVendor: {} }, rowCount: 0 },
        message: "No shipped PO data available for your assigned buyers",
        customerBuyers: allowedBuyers,
      });
    }

    const summary = {
      totalOrderValue:     monthFilteredRows.reduce((s, r) => s + r.orderValue,    0),
      totalShippedValue:   monthFilteredRows.reduce((s, r) => s + r.shippedValue,  0),
      totalCancelledValue: monthFilteredRows.reduce((s, r) => s + r.cancelledValue,0),
      totalBalanceValue:   monthFilteredRows.reduce((s, r) => s + r.balanceValue,  0),
      totalBusiness:       monthFilteredRows.reduce((s, r) => s + r.totalBusiness, 0),
      byStatus: {}, byPo: {}, byVendor: {}, byCustomer: {},
    };

    return res.json({
      success: true,
      data: { rows: monthFilteredRows, summary, rowCount: monthFilteredRows.length },
      customerBuyers: allowedBuyers,
      allCustomerBuyers: fullBuyerList,
    });

  } catch (err) {
    console.error("Error fetching/parsing FY27 shipped PO file:", err.message);
    return res.status(500).json({ error: "Failed to fetch or parse FY27 shipped PO file", details: err.message });
  }
});

router.get("/customer/:customerId/buyer-volume-shipped", async (req, res) => {
  try {
    const { customerId } = req.params;

    if (!customerId) {
      return res.status(401).json({
        error: "Unauthorized",
        details: "Customer ID is required"
      });
    }

    // Fetch customer's buyer name from metafield
    const customerQuery = `
      query getCustomerBuyer($customerId: ID!) {
        customer(id: $customerId) {
          id
          metafield(namespace: "custom", key: "business_name") {
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

    const buyerName = customerResponse.data?.data?.customer?.metafield?.value;
    
    if (!buyerName) {
      return res.status(404).json({
        error: "Buyer name not found",
        details: "Customer does not have a buyer_name metafield assigned"
      });
    }

    const normalizedBuyerName = buyerName.trim().toUpperCase();
    console.log("Customer ID:", customerId);
    console.log("Customer buyer name:", normalizedBuyerName);

    // Fetch shop metafield for Excel file
    const query = `
      query getShopMetafield {
        shop {
          metafield(namespace: "custom", key: "volumeshippedytd") {
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
        details: "No volumeshippedytd metafield found"
      });
    }

    let fileUrl;

    if (metafieldData.type === "file_reference") {
      const fileId = metafieldData.value;
      const fileQuery = `
        query getFileUrl($fileId: ID!) {
          node(id: $fileId) {
            ... on GenericFile {
              url
            }
            ... on MediaImage {
              image {
                url
              }
            }
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
        return res.status(404).json({
          error: "File URL not found",
          details: "Could not resolve file reference metafield",
        });
      }
    } else {
      fileUrl = metafieldData.value;
    }

    // Download and parse Excel file
    const fileResponse = await axios({
      method: "GET",
      url: fileUrl,
      responseType: "arraybuffer",
    });

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
      return res.status(404).json({
        error: "Empty file",
        details: "The Excel file contains no data",
      });
    }

    // Find header row
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

    // Find column indices for vendor email and contact person
    const vendorEmailIndex = headers.findIndex(h => 
      h.toLowerCase().includes('vendor') && h.toLowerCase().includes('email')
    );
    const contactPersonIndex = headers.findIndex(h => 
      h.toLowerCase().includes('contact') && h.toLowerCase().includes('person')
    );

    console.log("Vendor Email Column Index:", vendorEmailIndex);
    console.log("Contact Person Column Index:", contactPersonIndex);

    // Find where month columns start (typically after Buyer and Vendor columns)
    const monthStartIndex = 2; // Adjust if your structure is different
    const monthEndIndex = Math.min(
      vendorEmailIndex !== -1 ? vendorEmailIndex : headers.length,
      contactPersonIndex !== -1 ? contactPersonIndex : headers.length
    );

    // Parse all data rows
    const parsedData = rows.map((row) => {
      const obj = {
        buyer: row[0]?.toString().trim().toUpperCase() || "",
        vendor: row[1]?.toString().trim() || "",
        vendorEmail: vendorEmailIndex !== -1 ? (row[vendorEmailIndex]?.toString().trim() || "") : "",
        contactPerson: contactPersonIndex !== -1 ? (row[contactPersonIndex]?.toString().trim() || "") : "",
      };

      // Only parse month columns (between vendor name and contact info)
      headers.slice(monthStartIndex, monthEndIndex).forEach((month, index) => {
        obj[month] = cleanNumber(row[monthStartIndex + index]);
      });

      return obj;
    });

    // Filter by customer's buyer name
    const customerData = parsedData.filter(row => row.buyer === normalizedBuyerName);

    console.log("Total rows in file:", parsedData.length);
    console.log("Rows for this buyer:", customerData.length);

    if (customerData.length === 0) {
      return res.json({
        success: true,
        data: {
          buyerName: normalizedBuyerName,
          suppliers: [],
          volumeBySupplier: {},
          volumeByMonth: {},
          grandTotal: 0
        },
        message: "No volume data found for this buyer"
      });
    }

    // Get unique suppliers for this buyer with their contact info
    const supplierContactMap = {};
    customerData.forEach(row => {
      if (row.vendor && !supplierContactMap[row.vendor]) {
        supplierContactMap[row.vendor] = {
          email: row.vendorEmail,
          contactPerson: row.contactPerson
        };
      }
    });

    const suppliers = Object.keys(supplierContactMap).filter(v => v).sort();

    // Calculate volume by supplier (aggregated across all months)
    const volumeBySupplier = {};
    const monthColumns = headers.slice(monthStartIndex, monthEndIndex);

    customerData.forEach((row) => {
      if (row.vendor) {
        if (!volumeBySupplier[row.vendor]) {
          volumeBySupplier[row.vendor] = {
            totalVolume: 0,
            byMonth: {},
            email: row.vendorEmail,
            contactPerson: row.contactPerson
          };
        }
        
        monthColumns.forEach((month) => {
          const value = row[month] || 0;
          volumeBySupplier[row.vendor].totalVolume += value;
          
          if (!volumeBySupplier[row.vendor].byMonth[month]) {
            volumeBySupplier[row.vendor].byMonth[month] = 0;
          }
          volumeBySupplier[row.vendor].byMonth[month] += value;
        });
      }
    });

    // Calculate total volume by month (across all suppliers)
    const volumeByMonth = {};
    monthColumns.forEach((month) => {
      volumeByMonth[month] = customerData.reduce(
        (sum, row) => sum + (row[month] || 0),
        0
      );
    });

    // Calculate grand total
    const grandTotal = Object.values(volumeByMonth).reduce((sum, val) => sum + val, 0);

    res.json({
      success: true,
      data: {
        buyerName: normalizedBuyerName,
        suppliers: suppliers,
        volumeBySupplier,
        volumeByMonth,
        monthColumns,
        grandTotal,
        rowCount: customerData.length
      }
    });

  } catch (err) { 
    console.error("Error fetching/parsing Excel file:", err.message);
    console.error("Full error:", err);

    if (err.response?.status === 404) {
      return res.status(404).json({
        error: "File not found",
        details: "The Excel file URL is not accessible",
      });
    }

    return res.status(500).json({
      error: "Failed to fetch or parse Excel file",
      details: err.message || "An unexpected error occurred",
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

router.get("/customer/:customerId/recent-pos", async (req, res) => {
  const { customerId } = req.params;

  if (!customerId) {
    return res.status(400).json({
      error: "Invalid customerId",
      details: "customerId is required",
    });
  }

  try {
    console.log("📤 Fetching metafield for customer:", customerId);

    // 1. Fetch the metafield
    const query = `
      query getCustomerMetafield($customerId: ID!) {
        customer(id: $customerId) {
          id
          metafield(namespace: "custom", key: "recentpo") {
            id
            value
            type
          }
        }
      }
    `;

    const variables = {
      customerId: `gid://shopify/Customer/${customerId}`,
    };

    const shopifyResponse = await axios({
      method: "POST",
      url: `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      },
      data: { query, variables },
    });

    const metafieldData = shopifyResponse.data?.data?.customer?.metafield;

    if (!metafieldData) {
      return res.status(404).json({
        error: "Recent POs Excel file not found",
        details: `No 'recentpo' metafield found for customer ${customerId}`,
      });
    }

    console.log("✅ Metafield found, type:", metafieldData.type);

    let fileUrl;

    // 2. Resolve file URL
    if (metafieldData.type === "file_reference") {
      const fileId = metafieldData.value;
      console.log("📤 Resolving file URL...");

      const fileQuery = `
        query getFileUrl($fileId: ID!) {
          node(id: $fileId) {
            ... on GenericFile {
              url
            }
          }
        }
      `;

      const fileResponse = await axios({
        method: "POST",
        url: `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        },
        data: { query: fileQuery, variables: { fileId } },
        timeout: 10000,
      });

      fileUrl = fileResponse.data?.data?.node?.url;

      if (!fileUrl) {
        return res.status(404).json({
          error: "File URL not found",
          details: "Could not resolve file reference metafield",
        });
      }
    } else {
      fileUrl = metafieldData.value;
    }

    console.log("✅ File URL resolved, downloading...");

    // 3. Download Excel file with size limit
    const fileResponse = await axios({
      method: "GET",
      url: fileUrl,
      responseType: "arraybuffer",
      timeout: 30000,
      maxContentLength: 10 * 1024 * 1024, // Limit to 10MB
    });

    console.log("📥 File downloaded:", fileResponse.data.length, "bytes");

    // 4. Parse Excel efficiently
    const XLSX = require("xlsx");
    
    // Use read options to reduce memory usage
    const workbook = XLSX.read(fileResponse.data, { 
      type: "buffer",
      cellDates: true,
      cellNF: false,
      cellHTML: false
    });

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Get the range to avoid processing empty rows
    const range = XLSX.utils.decode_range(worksheet['!ref']);
    console.log(`📊 Sheet range: ${range.s.r} to ${range.e.r} rows`);

    // Convert to JSON with raw values only
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false // Get string values to reduce memory
    });

    console.log("📊 Parsed rows:", jsonData.length);

    if (jsonData.length === 0) {
      return res.status(404).json({
        error: "Empty file",
        details: "The Excel file contains no data",
      });
    }

    // Clean headers more thoroughly
    const headers = jsonData[0].map(h => {
      let cleaned = String(h || "")
        .trim()
        .replace(/\u00A0/g, " ")  // Non-breaking spaces
        .replace(/\s+/g, " ")      // Multiple spaces to single space
        .replace(/[\r\n\t]/g, ""); // Remove line breaks and tabs
      return cleaned;
    });

    console.log("📋 Cleaned Headers:", headers);

    // Define columns to keep
    const columnsToKeep = ["Purchase Order", "Supplier", "EWD", "AWD", "Due Date"];
    
    // Find indices with case-insensitive and flexible matching
    const columnIndices = columnsToKeep.map(col => {
      // Try exact match first
      let index = headers.indexOf(col);
      
      // If not found, try case-insensitive match
      if (index === -1) {
        index = headers.findIndex(h => 
          h.toLowerCase() === col.toLowerCase()
        );
      }
      
      // If still not found, try partial match (in case of extra characters)
      if (index === -1) {
        index = headers.findIndex(h => 
          h.toLowerCase().includes(col.toLowerCase())
        );
      }
      
      return {
        name: col,
        index: index,
        actualHeader: index !== -1 ? headers[index] : null
      };
    }).filter(col => col.index !== -1);

    console.log("✅ Column indices found:", columnIndices);

    // Log missing columns for debugging
    const missingColumns = columnsToKeep.filter(col => 
      !columnIndices.some(c => c.name === col)
    );
    if (missingColumns.length > 0) {
      console.log("⚠️ Missing columns:", missingColumns);
      console.log("Available headers:", headers);
    }

    // Also get indices for summary calculations
    const delayDaysIdx = headers.findIndex(h => h.toLowerCase().includes("delay"));
    const confirmedIdx = headers.findIndex(h => h.toLowerCase().includes("confirm"));
    const supplierIdx = headers.findIndex(h => h.toLowerCase() === "supplier");

    // Helper function
    const cleanNumber = (val) => {
      if (typeof val === "number") return val;
      if (typeof val === "string") {
        const cleaned = val.replace(/[^0-9.\-]/g, "");
        return cleaned ? parseFloat(cleaned) : 0;
      }
      return 0;
    };

    // Process rows more efficiently - only keep required columns
    const rows = jsonData.slice(1);
    const parsedData = [];
    
    let totalDelay = 0;
    let delayedCount = 0;
    let onTimeCount = 0;
    let confirmedCount = 0;
    let maxDelay = 0;
    const supplierSet = new Set();

    // Single pass through data
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const obj = {};
      
      // Only create object with required columns
      for (let col of columnIndices) {
        obj[col.name] = row[col.index] !== undefined ? row[col.index] : "";
      }
      
      parsedData.push(obj);
      
      // Calculate stats (still using all columns for accuracy)
      if (delayDaysIdx !== -1) {
        const delayDays = cleanNumber(row[delayDaysIdx]);
        if (delayDays > 0) {
          totalDelay += delayDays;
          delayedCount++;
          maxDelay = Math.max(maxDelay, delayDays);
        } else {
          onTimeCount++;
        }
      }
      
      if (confirmedIdx !== -1) {
        const confirmed = String(row[confirmedIdx] || "").toLowerCase();
        if (confirmed === "yes" || confirmed === "y") {
          confirmedCount++;
        }
      }
      
      if (supplierIdx !== -1) {
        const supplier = row[supplierIdx];
        if (supplier) {
          supplierSet.add(supplier);
        }
      }
    }

    const avgDelay = delayedCount > 0 ? (totalDelay / delayedCount) : 0;
    const totalPos = parsedData.length;

    const summary = {
      totalPurchaseOrders: totalPos,
      totalConfirmedPOs: confirmedCount,
      totalOnTimePOs: onTimeCount,
      totalDelayedPOs: delayedCount,
      onTimeRate: totalPos > 0 ? `${((onTimeCount / totalPos) * 100).toFixed(1)}%` : "N/A",
      avgDelayDays: avgDelay.toFixed(1),
      maxDelayDays: maxDelay,
      uniqueSuppliers: supplierSet.size,
      supplierList: Array.from(supplierSet),
    };

    console.log("✅ Processing complete");

    // Clear variables to help GC
    jsonData.length = 0;
    rows.length = 0;

    // Return only the column names that were found
    const returnedHeaders = columnIndices.map(col => col.name);

    res.json({
      success: true,
      data: {
        headers: returnedHeaders,
        rows: parsedData,
        summary,
        rowCount: parsedData.length,
      },
    });

    console.log("✅ Response sent");

  } catch (err) {
    console.error("💥 ERROR:", err.message);

    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({
        error: "Request timeout",
        details: "The file download or processing took too long",
      });
    }

    if (err.response?.status === 404) {
      return res.status(404).json({
        error: "File not found",
        details: "The Excel file URL is not accessible",
      });
    }

    return res.status(500).json({
      error: "Failed to fetch or parse Excel file",
      details: err.message || "An unexpected error occurred",
    });
  }
});
router.get("/customer/:customerId/buyer-recent-pos", async (req, res) => {
  const { customerId } = req.params;

  if (!customerId) {
    return res.status(400).json({
      error: "Invalid customerId",
      details: "customerId is required",
    });
  }

  try {
    console.log("📤 Fetching customer business name for:", customerId);

    // 1. Fetch the customer's business name metafield
    const customerQuery = `
      query getCustomerBusinessName($customerId: ID!) {
        customer(id: $customerId) {
          id
          metafield(namespace: "custom", key: "business_name") {
            value
          }
        }
      }
    `;

    const customerVariables = {
      customerId: `gid://shopify/Customer/${customerId}`,
    };

    const customerResponse = await axios({
      method: "POST",
      url: `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      },
      data: { query: customerQuery, variables: customerVariables },
    });

    const businessName = customerResponse.data?.data?.customer?.metafield?.value;

    if (!businessName) {
      return res.status(404).json({
        error: "Business name not found",
        details: `No 'businessname' metafield found for customer ${customerId}`,
      });
    }

    console.log("✅ Business name found:", businessName);

    // 2. Fetch the shop metafield containing the Excel file
    console.log("📤 Fetching shop metafield for recent POs...");

    const shopQuery = `
      query getShopMetafield {
        shop {
          metafield(namespace: "custom", key: "buyerrecentpo") {
            id
            value
            type
          }
        }
      }
    `;

    const shopifyResponse = await axios({
      method: "POST",
      url: `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      },
      data: { query: shopQuery },
    });

    const metafieldData = shopifyResponse.data?.data?.shop?.metafield;

    if (!metafieldData) {
      return res.status(404).json({
        error: "Recent POs Excel file not found",
        details: "No 'recentpo' metafield found in shop metafields",
      });
    }

    console.log("✅ Shop metafield found, type:", metafieldData.type);

    let fileUrl;

    // 3. Resolve file URL
    if (metafieldData.type === "file_reference") {
      const fileId = metafieldData.value;
      console.log("📤 Resolving file URL...");

      const fileQuery = `
        query getFileUrl($fileId: ID!) {
          node(id: $fileId) {
            ... on GenericFile {
              url
            }
          }
        }
      `;

      const fileResponse = await axios({
        method: "POST",
        url: `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        },
        data: { query: fileQuery, variables: { fileId } },
        timeout: 10000,
      });

      fileUrl = fileResponse.data?.data?.node?.url;

      if (!fileUrl) {
        return res.status(404).json({
          error: "File URL not found",
          details: "Could not resolve file reference metafield",
        });
      }
    } else {
      fileUrl = metafieldData.value;
    }

    console.log("✅ File URL resolved, downloading...");

    // 4. Download Excel file with size limit
    const fileResponse = await axios({
      method: "GET",
      url: fileUrl,
      responseType: "arraybuffer",
      timeout: 30000,
      maxContentLength: 10 * 1024 * 1024, // Limit to 10MB
    });

    console.log("📥 File downloaded:", fileResponse.data.length, "bytes");

    // 5. Parse Excel efficiently
    const XLSX = require("xlsx");
    
    const workbook = XLSX.read(fileResponse.data, { 
      type: "buffer",
      cellDates: true,
      cellNF: false,
      cellHTML: false
    });

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const range = XLSX.utils.decode_range(worksheet['!ref']);
    console.log(`📊 Sheet range: ${range.s.r} to ${range.e.r} rows`);

    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false
    });

    console.log("📊 Parsed rows:", jsonData.length);

    if (jsonData.length === 0) {
      return res.status(404).json({
        error: "Empty file",
        details: "The Excel file contains no data",
      });
    }

    // Clean headers
    const headers = jsonData[0].map(h => {
      let cleaned = String(h || "")
        .trim()
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .replace(/[\r\n\t]/g, "");
      return cleaned;
    });

    console.log("📋 Cleaned Headers:", headers);

    // Define columns to keep (updated based on new Excel structure)
    const columnsToKeep = ["Buyer", "Supplier", "PO No.", "Po Signed Date", "Ex factory Date"];
    
    // Find indices with flexible matching
    const columnIndices = columnsToKeep.map(col => {
      let index = headers.indexOf(col);
      
      if (index === -1) {
        index = headers.findIndex(h => 
          h.toLowerCase() === col.toLowerCase()
        );
      }
      
      if (index === -1) {
        index = headers.findIndex(h => 
          h.toLowerCase().includes(col.toLowerCase())
        );
      }
      
      return {
        name: col,
        index: index,
        actualHeader: index !== -1 ? headers[index] : null
      };
    }).filter(col => col.index !== -1);

    console.log("✅ Column indices found:", columnIndices);

    // Find Buyer column index for filtering
    const buyerIdx = headers.findIndex(h => 
      h.toLowerCase() === "buyer" || h.toLowerCase().includes("buyer")
    );

    if (buyerIdx === -1) {
      return res.status(500).json({
        error: "Invalid Excel structure",
        details: "Buyer column not found in Excel file",
      });
    }

    // Log missing columns for debugging
    const missingColumns = columnsToKeep.filter(col => 
      !columnIndices.some(c => c.name === col)
    );
    if (missingColumns.length > 0) {
      console.log("⚠️ Missing columns:", missingColumns);
      console.log("Available headers:", headers);
    }

    // Process rows and filter by business name
    const rows = jsonData.slice(1);
    const parsedData = [];
    
    let totalPos = 0;
    const supplierSet = new Set();

    // Single pass through data - filter and create objects
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const buyerValue = String(row[buyerIdx] || "").trim();
      
      // Only include rows where Buyer matches the customer's business name
      if (buyerValue.toLowerCase() === businessName.toLowerCase()) {
        const obj = {};
        
        // Only create object with required columns
        for (let col of columnIndices) {
          obj[col.name] = row[col.index] !== undefined ? row[col.index] : "";
        }
        
        parsedData.push(obj);
        totalPos++;
        
        // Track unique suppliers
        const supplierIdx = columnIndices.find(c => c.name === "Supplier")?.index;
        if (supplierIdx !== undefined) {
          const supplier = row[supplierIdx];
          if (supplier) {
            supplierSet.add(supplier);
          }
        }
      }
    }

    console.log(`✅ Filtered ${totalPos} POs for business: ${businessName}`);

    const summary = {
      businessName: businessName,
      totalPurchaseOrders: totalPos,
      uniqueSuppliers: supplierSet.size,
      supplierList: Array.from(supplierSet),
    };

    console.log("✅ Processing complete");

    // Clear variables to help GC
    jsonData.length = 0;
    rows.length = 0;

    // Return only the column names that were found
    const returnedHeaders = columnIndices.map(col => col.name);

    res.json({
      success: true,
      data: {
        headers: returnedHeaders,
        rows: parsedData,
        summary,
        rowCount: parsedData.length,
      },
    });

    console.log("✅ Response sent");

  } catch (err) {
    console.error("💥 ERROR:", err.message);

    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({
        error: "Request timeout",
        details: "The file download or processing took too long",
      });
    }

    if (err.response?.status === 404) {
      return res.status(404).json({
        error: "File not found",
        details: "The Excel file URL is not accessible",
      });
    }

    return res.status(500).json({
      error: "Failed to fetch or parse Excel file",
      details: err.message || "An unexpected error occurred",
    });
  }
});

router.get("/customer/:customerId/supplier-info", async (req, res) => {
  const { customerId } = req.params;

  if (!customerId) {
    return res.status(400).json({
      error: "Invalid customerId",
      details: "customerId is required",
    });
  }

  try {
    // Fetch customer metafield for the supplier info Excel file
    const customerMetafieldQuery = `
      query getCustomerMetafield($customerId: ID!) {
        customer(id: $customerId) {
          id
          email
          metafield(namespace: "custom", key: "supplier_info") {
            id
            value
            type
          }
        }
      }
    `;

    const customerVariables = {
      customerId: `gid://shopify/Customer/${customerId}`,
    };

    const shopifyResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      },
      data: { query: customerMetafieldQuery, variables: customerVariables },
    });

    const customerData = shopifyResponse.data?.data?.customer;
    const customerEmail = customerData?.email;

    if (!customerEmail) {
      return res.status(404).json({
        error: "Customer not found",
        details: `No customer found with ID ${customerId}`,
      });
    }

    const metafieldData = customerData?.metafield;

    if (!metafieldData) {
      return res.status(404).json({
        error: "Excel file not found",
        details: "No customer metafield found for supplier information",
      });
    }

    let fileUrl;

    // Case 1: metafield type is file_reference
    if (metafieldData.type === "file_reference") {
      const fileId = metafieldData.value;

      const fileQuery = `
        query getFileUrl($fileId: ID!) {
          node(id: $fileId) {
            ... on GenericFile {
              url
            }
            ... on MediaImage {
              image {
                url
              }
            }
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

      fileUrl =
        fileResponse.data?.data?.node?.url ||
        fileResponse.data?.data?.node?.image?.url;

      if (!fileUrl) {
        return res.status(404).json({
          error: "File URL not found",
          details: "Could not resolve file reference metafield",
        });
      }
    } else {
      // Case 2: direct URL stored as value
      fileUrl = metafieldData.value;
    }

    // Download the file
    const fileResponse = await axios({
      method: "GET",
      url: fileUrl,
      responseType: "arraybuffer",
    });

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
      return res.status(404).json({
        error: "Empty file",
        details: "The Excel file contains no data",
      });
    }

    // Clean and normalize headers
    const headers = jsonData[0].map(h =>
      h?.toString().trim().replace(/\u00A0/g, " ")
    );

    console.log("Supplier Info Headers found:", headers);

    const rows = jsonData.slice(1);

    const parsedData = rows.map((row) => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] !== undefined ? row[index] : "";
      });
      return obj;
    });

    // Transform all rows to supplier format
    // If you want to filter by customer, uncomment the filter logic
    const suppliers = parsedData
      // .filter(row => row["Buyer Email"]?.toString().toLowerCase().trim() === customerEmail.toLowerCase().trim())
      .map((row, index) => ({
        id: index + 1,
        company: row["Supplier Name"] || row["Company"] || row["Supplier"] || "",
        contactPerson: row["Contact person"] || row["Contact"] || "",
        email: row["Email ID"] || row["Supplier Email"] || "",
      }))
      .filter(s => s.company); // Filter out empty entries

    if (suppliers.length === 0) {
      return res.status(404).json({
        error: "No suppliers found",
        details: `No supplier data found in the Excel file`,
      });
    }

    res.json({
      success: true,
      data: {
        suppliers,
        totalSuppliers: suppliers.length,
      },
    });
  } catch (err) {
    console.error("Error fetching/parsing supplier info:", err.message);
    console.error("Full error:", err);

    if (err.response?.status === 404) {
      return res.status(404).json({
        error: "File not found",
        details: "The Excel file URL is not accessible",
      });
    }

    return res.status(500).json({
      error: "Failed to fetch or parse Excel file",
      details: err.message || "An unexpected error occurred",
    });
  }
});

router.get("/customer/:customerId/compliance-data", async (req, res) => {
  const { customerId } = req.params;

  if (!customerId) {
    return res.status(400).json({
      error: "Invalid customerId",
      details: "customerId is required",
    });
  }

  try {
    // Fetch customer metafield for the compliance Excel file
    const customerMetafieldQuery = `
      query getCustomerMetafield($customerId: ID!) {
        customer(id: $customerId) {
          id
          email
          metafield(namespace: "custom", key: "compliance_score") {
            id
            value
            type
          }
        }
      }
    `;

    const customerVariables = {
      customerId: `gid://shopify/Customer/${customerId}`,
    };

    const shopifyResponse = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      },
      data: { query: customerMetafieldQuery, variables: customerVariables },
    });

    const customerData = shopifyResponse.data?.data?.customer;
    const customerEmail = customerData?.email;

    if (!customerEmail) {
      return res.status(404).json({
        error: "Customer not found",
        details: `No customer found with ID ${customerId}`,
      });
    }

    const metafieldData = customerData?.metafield;

    if (!metafieldData) {
      return res.status(404).json({
        error: "Excel file not found",
        details: "No customer metafield found for compliance data",
      });
    }

    let fileUrl;

    // Case 1: metafield type is file_reference
    if (metafieldData.type === "file_reference") {
      const fileId = metafieldData.value;

      const fileQuery = `
        query getFileUrl($fileId: ID!) {
          node(id: $fileId) {
            ... on GenericFile {
              url
            }
            ... on MediaImage {
              image {
                url
              }
            }
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

      fileUrl =
        fileResponse.data?.data?.node?.url ||
        fileResponse.data?.data?.node?.image?.url;

      if (!fileUrl) {
        return res.status(404).json({
          error: "File URL not found",
          details: "Could not resolve file reference metafield",
        });
      }
    } else {
      // Case 2: direct URL stored as value
      fileUrl = metafieldData.value;
    }

    // Download the file
    const fileResponse = await axios({
      method: "GET",
      url: fileUrl,
      responseType: "arraybuffer",
    });

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
      return res.status(404).json({
        error: "Empty file",
        details: "The Excel file contains no data",
      });
    }

    // Clean and normalize headers
    const headers = jsonData[0].map(h =>
      h?.toString().trim().replace(/\u00A0/g, " ")
    );

    console.log("Compliance Headers found:", headers);

    const rows = jsonData.slice(1);

    const parsedData = rows.map((row) => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] !== undefined ? row[index] : "";
      });
      return obj;
    });

    // Transform rows to compliance format
    const complianceData = parsedData
      .filter(row => row["VENDOR"]) // Only include rows with vendor names
      .map((row, index) => {
        // Helper function to determine compliance status
        const getComplianceStatus = (row) => {
          const hasAnyAudit = row["BSCI"] || row["Sedex"] || row["Sa8000"];
          const hasExpiryDate = row["Sedex3"] || row["Sa80002"];

          if (!hasAnyAudit) return "Non-Compliant";

          // Check if any expiry date is in the past
          if (hasExpiryDate) {
            const expiryDate = row["Sedex3"] || row["Sa80002"];
            if (expiryDate) {
              const expiry = new Date(expiryDate);
              const today = new Date();
              if (expiry < today) return "Non-Compliant";
            }
          }

          return "Compliant";
        };

        return {
          id: index + 1,
          vendor: row["VENDOR"] || "",
          auditReports: {
            bsci: row["BSCI"] || "",
            sedex: row["Sedex"] || "",
            sa8000: row["Sa8000"] || ""
          },
          expiryDates: {
            bsci2: row["BSCI2"] || "",
            sedex3: row["Sedex3"] || "",
            sa80002: row["Sa80002"] || ""
          },
          status: getComplianceStatus(row),
          hasActiveAudit: !!(row["BSCI"] || row["Sedex"] || row["Sa8000"])
        };
      });

    if (complianceData.length === 0) {
      return res.status(404).json({
        error: "No compliance data found",
        details: `No vendor data found in the Excel file`,
      });
    }

    // Calculate summary statistics
    const totalVendors = complianceData.length;
    const compliantVendors = complianceData.filter(v => v.status === "Compliant").length;
    const nonCompliantVendors = complianceData.filter(v => v.status === "Non-Compliant").length;
    const complianceRate = ((compliantVendors / totalVendors) * 100).toFixed(1);

    res.json({
      success: true,
      data: {
        vendors: complianceData,
        summary: {
          totalVendors,
          compliantVendors,
          nonCompliantVendors,
          complianceRate: `${complianceRate}%`
        }
      },
    });
  } catch (err) {
    console.error("Error fetching/parsing compliance data:", err.message);
    console.error("Full error:", err);

    if (err.response?.status === 404) {
      return res.status(404).json({
        error: "File not found",
        details: "The Excel file URL is not accessible",
      });
    }

    return res.status(500).json({
      error: "Failed to fetch or parse Excel file",
      details: err.message || "An unexpected error occurred",
    });
  }
});

module.exports = router;