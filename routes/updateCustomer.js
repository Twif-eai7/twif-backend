// const express = require("express");

// const axios = require("axios");
// const router = express.Router();


// // Get Shopify credentials from environment variables
// const { SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN } = process.env;

// // The route is now POST /, because the base path '/update-customer-metafields' is defined in server.js
// router.post("/", async (req, res) => {
//   const { customerId, customer_name, business_name, customer_role, customer_phone } = req.body;

//   // Input validation
//   if (!customerId || !customer_name || !customer_role) {
//     return res.status(400).json({
//       error: 'Missing required fields',
//       details: 'customerId, customer_name, and customer_role are required fields'
//     });
//   }

//   // Validate customerId is numeric
//   if (!/^\d+$/.test(customerId.toString())) {
//     return res.status(400).json({
//       error: 'Invalid customerId',
//       details: 'customerId must be a numeric value'
//     });
//   }

//   const query = `
//     mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
//       metafieldsSet(metafields: $metafields) {
//         metafields { id key value namespace type }
//         userErrors { field message code }
//       }
//     }
//   `;

//   // Construct the metafields array based on the expected types
//   const metafieldsPayload = [
//     {
//       ownerId: `gid://shopify/Customer/${customerId}`,
//       namespace: "custom",
//       key: "name",
//       type: "single_line_text_field",
//       value: customer_name
//     },
//     {
//       ownerId: `gid://shopify/Customer/${customerId}`,
//       namespace: "custom",
//       key: "business_name",
//       type: "single_line_text_field",
//       value: business_name || ""
//     },
//     {
//       ownerId: `gid://shopify/Customer/${customerId}`,
//       namespace: "custom",
//       key: "role",
//       type: "single_line_text_field",
//       value: customer_role
//     },
//     {
//       ownerId: `gid://shopify/Customer/${customerId}`,
//       namespace: "custom",
//       key: "phone",
//       type: "number_integer",
//       value: customer_phone ? customer_phone.toString() : ""
//     }
//   ];

//   const variables = {
//     metafields: metafieldsPayload
//   };

//   try {
//     const response = await axios({
//       method: "POST",
//       url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
//       headers: {
//         "Content-Type": "application/json",
//         "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
//       },
//       data: { query, variables }
//     });

//     const result = response.data;

//     if (result.errors) {
//       console.error('GraphQL errors:', result.errors);
//       return res.status(400).json({
//         error: 'GraphQL errors occurred',
//         details: result.errors
//       });
//     }

//     if (result.data?.metafieldsSet?.userErrors?.length > 0) {
//       console.error('User errors:', result.data.metafieldsSet.userErrors);
//       return res.status(400).json({
//         error: 'Metafield validation errors',
//         details: result.data.metafieldsSet.userErrors
//       });
//     }

//     res.json({
//       success: true,
//       data: result.data.metafieldsSet.metafields,
//       message: 'Customer metafields updated successfully'
//     });

//   } catch (err) {
//     console.error('Unexpected error:', err.message);
//     res.status(500).json({
//       error: "Failed to update metafields",
//       details: err.message || 'An unexpected error occurred'
//     });
//   }
// });

// // Export the router to be used in server.js
// module.exports = router;
const nodemailer = require('nodemailer');
const express = require("express");
const axios = require("axios");
const { PhoneNumberUtil, PhoneNumberFormat } = require('google-libphonenumber');
const router = express.Router();

// Initialize phone number utility
const phoneUtil = PhoneNumberUtil.getInstance();

// Get Shopify credentials from environment variables
const { SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN, EMAIL_PASS, EMAIL_USER} = process.env;
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
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

// The route is now POST /, because the base path '/update-customer-metafields' is defined in server.js
router.post("/", async (req, res) => {
  const { 
    customerId, 
    customer_name, 
    business_name, 
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
  if (!customerId || !customer_name || !customer_role || !country || !business_name || !number_of_employees) {
    return res.status(400).json({
      error: 'Missing required fields',
      details: 'customerId, customer_name, customer_role, country, business_name, and number_of_employees are required fields'
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

  try {
    const response = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
      },
      data: { query, variables }
    });

    const result = response.data;

    if (result.errors) {
      console.error('GraphQL errors:', result.errors);
      return res.status(400).json({
        error: 'GraphQL errors occurred',
        details: result.errors
      });
    }

    if (result.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('User errors:', result.data.metafieldsSet.userErrors);
      return res.status(400).json({
        error: 'Metafield validation errors',
        details: result.data.metafieldsSet.userErrors
      });
    }

    // Log successful update for debugging
    console.log(`Successfully updated metafields for customer ${customerId}:`, {
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
    await sendAdminNotification(req.body);

    res.json({
      success: true,
      data: result.data.metafieldsSet.metafields,
      message: 'Customer profile updated successfully'
    });

  } catch (err) {
    console.error('Unexpected error:', err.message);
    
    // Handle specific axios errors
    if (err.response) {
      // The request was made and the server responded with a status code outside 2xx range
      console.error('Response error:', err.response.data);
      return res.status(err.response.status).json({
        error: "Failed to update metafields - Server Error",
        details: err.response.data || err.message
      });
    } else if (err.request) {
      // The request was made but no response was received
      console.error('Request error:', err.request);
      return res.status(500).json({
        error: "Failed to update metafields - Network Error",
        details: 'No response received from Shopify API'
      });
    } else {
      // Something happened in setting up the request
      return res.status(500).json({
        error: "Failed to update metafields",
        details: err.message || 'An unexpected error occurred'
      });
    }
  }
});

// Optional: Add a GET route to retrieve customer metafields for debugging
router.get("/customer/:customerId", async (req, res) => {
  const { customerId } = req.params;

  if (!customerId || !/^\d+$/.test(customerId.toString())) {
    return res.status(400).json({
      error: 'Invalid customerId',
      details: 'customerId must be a numeric value'
    });
  }

  const query = `
    query getCustomer($id: ID!) {
      customer(id: $id) {
        id
        firstName
        lastName
        email
        metafields(first: 20, namespace: "custom") {
          edges {
            node {
              id
              namespace
              key
              value
              type
            }
          }
        }
      }
    }
  `;

  const variables = {
    id: `gid://shopify/Customer/${customerId}`
  };

  try {
    const response = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
      },
      data: { query, variables }
    });

    const result = response.data;

    if (result.errors) {
      console.error('GraphQL errors:', result.errors);
      return res.status(400).json({
        error: 'GraphQL errors occurred',
        details: result.errors
      });
    }

    res.json({
      success: true,
      data: result.data.customer
    });

  } catch (err) {
    console.error('Unexpected error:', err.message);
    res.status(500).json({
      error: "Failed to retrieve customer data",
      details: err.message || 'An unexpected error occurred'
    });
  }
});

// Updated GET route to fetch all customers with their metafields
router.get("/customers", async (req, res) => {
  const { limit = 50, after } = req.query; // Support pagination
  
  const query = `
  query getCustomers($first: Int!, $after: String) {
    customers(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      edges {
        cursor
        node {
          id
          firstName
          lastName
          email
          phone
          createdAt
          updatedAt
          tags
          metafields(first: 20, namespace: "custom") {
            edges {
              node {
                id
                namespace
                key
                value
                type
              }
            }
          }
        }
      }
    }
  }
`;

  const variables = {
  first: Math.min(parseInt(limit),20), // Increased from 100 to 250 for more recent customers
  ...(after && { after })
};

  try {
    const response = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
      },
      data: { query, variables }
    });

    const result = response.data;

    if (result.errors) {
      console.error('GraphQL errors:', result.errors);
      return res.status(400).json({
        error: 'GraphQL errors occurred',
        details: result.errors
      });
    }

    // Transform the data to make it easier to work with
    const transformedCustomers = result.data.customers.edges.map(edge => {
      const customer = edge.node;
      const metafields = {};
      
      // Convert metafields array to object for easier access
      customer.metafields.edges.forEach(metafieldEdge => {
        const metafield = metafieldEdge.node;
        metafields[metafield.key] = metafield.value;
      });

      return {
        id: customer.id.replace('gid://shopify/Customer/', ''), // Extract numeric ID
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        createdAt: customer.createdAt,
        updatedAt: customer.updatedAt,
        tags: customer.tags,
        cursor: edge.cursor,
        // Custom metafields
        customerName: metafields.name || '',
        businessName: metafields.business_name || '',
        role: metafields.role || '',
        contact: metafields.contact || '',
        isVerified: metafields.isverified || "false",
        country: metafields.country || '',
        domainName: metafields.domain || '',
        numberOfEmployees: metafields.number_of_employees || '',
        retailerType: metafields.retailer_type || '',
        supplierType: metafields.supplier_type || '',
        businessRegistration: metafields.business_registration || ''
      };
    });

    res.json({
      success: true,
      data: {
        customers: transformedCustomers,
        pageInfo: result.data.customers.pageInfo,
        totalCount: transformedCustomers.length
      }
    });

  } catch (err) {
    console.error('Unexpected error:', err.message);
    
    if (err.response) {
      console.error('Response error:', err.response.data);
      return res.status(err.response.status).json({
        error: "Failed to retrieve customers - Server Error",
        details: err.response.data || err.message
      });
    } else if (err.request) {
      console.error('Request error:', err.request);
      return res.status(500).json({
        error: "Failed to retrieve customers - Network Error",
        details: 'No response received from Shopify API'
      });
    } else {
      return res.status(500).json({
        error: "Failed to retrieve customers",
        details: err.message || 'An unexpected error occurred'
      });
    }
  }
});


router.post("/verify", async (req, res) => {
  const { customerId, isVerified } = req.body;

  // Input Validation
  if (!customerId) {
    return res.status(400).json({
      error: 'Missing required field',
      details: 'customerId is a required field'
    });
  }
  
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

  // GraphQL Mutation
  const query = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value namespace type }
        userErrors { field message code }
      }
    }
  `;

  // Construct Metafield Payload
  const metafieldsPayload = [
    {
      ownerId: `gid://shopify/Customer/${customerId}`,
      namespace: "custom",
      key: "isverified",
      type: "boolean",
      value: isVerified.toString() // Booleans must be passed as strings "true" or "false"
    }
  ];

  const variables = {
    metafields: metafieldsPayload
  };

  // API Call to Shopify
  try {
    const response = await axios({
      method: "POST",
      url: `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
      },
      data: { query, variables }
    });

    const result = response.data;

    // Handle Shopify's response
    if (result.errors) {
      console.error('GraphQL errors:', result.errors);
      return res.status(400).json({
        error: 'GraphQL errors occurred',
        details: result.errors
      });
    }

    if (result.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('User errors:', result.data.metafieldsSet.userErrors);
      return res.status(400).json({
        error: 'Metafield validation errors',
        details: result.data.metafieldsSet.userErrors
      });
    }

    console.log(`Successfully updated isVerified status for customer ${customerId} to ${isVerified}`);

    res.json({
      success: true,
      data: result.data.metafieldsSet.metafields,
      message: `Customer verification status updated to ${isVerified}`
    });

  } catch (err) {
    // Handle network/server errors
    console.error('Unexpected error during verification update:', err.message);
    
    if (err.response) {
      console.error('Response error:', err.response.data);
      return res.status(err.response.status).json({
        error: "Failed to update verification status - Server Error",
        details: err.response.data || err.message
      });
    } else if (err.request) {
      console.error('Request error:', err.request);
      return res.status(500).json({
        error: "Failed to update verification status - Network Error",
        details: 'No response received from Shopify API'
      });
    } else {
      return res.status(500).json({
        error: "Failed to update verification status",
        details: err.message || 'An unexpected error occurred'
      });
    }
  }
});


// Export the router to be used in server.js
module.exports = router;