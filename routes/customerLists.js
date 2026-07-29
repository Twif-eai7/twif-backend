const express = require('express');
const axios = require('axios');
const router = express.Router();
const { shopify } = require('../shopify');

const { SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN } = process.env;

// Helper for Shopify REST API requests
const shopifyApi = axios.create({
  baseURL: `https://${SHOPIFY_STORE}/admin/api/2025-07`,
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
  }
});


// Fetch all customer lists
router.get('/get', async (req, res) => {
  const { customerId } = req.query;
  if (!customerId) return res.status(400).json({ success: false, error: 'Missing customerId' });

  try {
    const response = await shopifyApi.get(`/customers/${customerId}/metafields.json?namespace=custom&key=favList`);
    const metafield = (response.data.metafields || [])[0];
    let listNames = [];
    if (metafield && metafield.value) {
      try {
        listNames = JSON.parse(metafield.value);
      } catch (parseError) {
        console.error('Error parsing list names:', parseError);
        listNames = [];
      }
    }
    res.json({ success: true, lists: listNames });
  } catch (error) {
    console.error('Error fetching customer lists:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add a new list name to the metafield
router.post('/add', async (req, res) => {
  const { customerId, listName } = req.body;
  if (!customerId || !listName) {
    return res.status(400).json({ success: false, error: 'Missing customerId or listName' });
  }

  try {
    // Fetch existing lists
    const response = await shopifyApi.get(`/customers/${customerId}/metafields.json?namespace=custom&key=favList`);
    let listNames = [];
    let metafieldId = null;
    
    if (response.data.metafields && response.data.metafields[0]) {
      metafieldId = response.data.metafields[0].id;
      try {
        listNames = JSON.parse(response.data.metafields[0].value);
      } catch (parseError) {
        console.error('Error parsing existing list names:', parseError);
        listNames = [];
      }
    }

    // Check if list already exists (case-insensitive)
    const existingList = listNames.find(name => 
      name.toLowerCase() === listName.toLowerCase()
    );
    
    if (existingList) {
      return res.json({ 
        success: true, 
        message: 'List already exists', 
        lists: listNames 
      });
    }

    // Add new list name
    listNames.push(listName);

    const payload = {
      metafield: {
        namespace: 'custom',
        key: 'favList',
        value: JSON.stringify(listNames),
        type: 'list.single_line_text_field'
      }
    };

    let saveResp;
    if (metafieldId) {
      saveResp = await shopifyApi.put(`/metafields/${metafieldId}.json`, payload);
    } else {
      saveResp = await shopifyApi.post(`/customers/${customerId}/metafields.json`, payload);
    }

    res.json({ 
      success: true, 
      lists: listNames, 
      metafield: saveResp.data.metafield,
      message: 'List created successfully'
    });
  } catch (error) {
    console.error('Error adding list:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/create', async (req, res) => {
  const { customerId, listName} = req.body;

  // 1. Input validation
  if (!customerId || !listName) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: customerId and listName are required'
    });
  }

  // Ensure shop has correct format
  const shopDomain = process.env.SHOPIFY_STORE;
  const accessToken = process.env.SHOPIFY_ADMIN_TOKEN;

  try {
    console.log(`Processing request for customer ${customerId} on shop ${shopDomain}`);

    // 2. Set up axios configurations for REST and GraphQL
    const restConfig = {
      baseURL: `https://${shopDomain}/admin/api/2025-01`,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    };

    const graphqlConfig = {
      url: `https://${shopDomain}/admin/api/2025-01/graphql.json`,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    };

    // 3. Fetch existing metafield that stores the list of names
    console.log('Fetching existing metafields...');
    let metafieldsResponse;
    try {
      metafieldsResponse = await axios.get(
        `/customers/${customerId}/metafields.json?namespace=custom&key=favList`,
        restConfig
      );
    } catch (error) {
      if (error.response?.status === 404) {
        // Customer not found or no metafields
        console.log('No existing metafields found or customer not found');
        metafieldsResponse = { data: { metafields: [] } };
      } else {
        throw error;
      }
    }

    let listNames = [];
    let metafieldId = null;
    const existingMetafield = metafieldsResponse.data?.metafields?.[0];

    if (existingMetafield) {
      metafieldId = existingMetafield.id;
      try {
        const parsedValue = existingMetafield.value ? JSON.parse(existingMetafield.value) : [];
        listNames = Array.isArray(parsedValue) ? parsedValue : [];
      } catch (parseError) {
        console.error('Error parsing existing list names:', parseError);
        listNames = [];
      }
    }

    console.log('Current lists:', listNames);

    // 4. Check for duplicates (case-insensitive)
    const listExists = listNames.some(name => 
      typeof name === 'string' && name.toLowerCase() === listName.toLowerCase()
    );
    
    if (listExists) {
      return res.json({
        success: true,
        message: 'List already exists',
        lists: listNames
      });
    }

    // 5. Add the new list name and save the updated array
    listNames.push(listName);
    const metafieldPayload = {
      metafield: {
        namespace: 'custom',
        key: 'favList',
        value: JSON.stringify(listNames),
        type: 'list.single_line_text_field'
      }
    };

    console.log('Updating metafield with new list:', listName);

    if (metafieldId) {
      // Update existing metafield
      await axios.put(`/metafields/${metafieldId}.json`, metafieldPayload, restConfig);
    } else {
      // Create new metafield for the customer
      await axios.post(`/customers/${customerId}/metafields.json`, metafieldPayload, restConfig);
    }

    // 6. Create metafield definition using GraphQL
    const safeListKey = listName
      .replace(/[^a-z0-9]+/g, '_') 
      .replace(/^_|_$/g, '')
      .substring(0, 30);

    console.log('Creating metafield definition with key:', safeListKey);

    const createMutation = `
      mutation MetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            id
            name
            key
            namespace
            type {
              name
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const definitionInput = {
      name: listName,
      namespace: "custom",
      key: safeListKey,
      type: "list.product_reference",
      ownerType: "CUSTOMER",
      access: {
        storefront: 'PUBLIC_READ'
    },
      description: `Favorite products list: ${listName}`
    };

    const graphqlPayload = {
      query: createMutation,
      variables: { definition: definitionInput }
    };

    let definitionResult = null;
    try {
      const graphqlResponse = await axios.post(graphqlConfig.url, graphqlPayload, {
        headers: graphqlConfig.headers
      });

      console.log('GraphQL Response:', JSON.stringify(graphqlResponse.data, null, 2));

      // Properly handle GraphQL response structure
      if (graphqlResponse.data?.data?.metafieldDefinitionCreate) {
        const createResult = graphqlResponse.data.data.metafieldDefinitionCreate;
        
        if (createResult.userErrors && createResult.userErrors.length > 0) {
          const firstError = createResult.userErrors[0];
          console.log('GraphQL User Error:', firstError);
          
          // Handle duplicate key error gracefully
          if (firstError.code === "DUPLICATE_KEY_NAMESPACE" || firstError.code === "TAKEN") {
            console.log(`✅ Metafield definition already exists for key: ${safeListKey}`);
            definitionResult = { status: 'exists', message: 'Definition already exists' };
          } else {
            console.error('GraphQL Error:', firstError);
            definitionResult = { status: 'error', error: firstError };
          }
        } else if (createResult.createdDefinition) {
          console.log('✅ Successfully created metafield definition:', createResult.createdDefinition);
          definitionResult = { status: 'created', definition: createResult.createdDefinition };
        }
      } else {
        console.error('Unexpected GraphQL response structure:', graphqlResponse.data);
        definitionResult = { status: 'error', error: 'Unexpected response structure' };
      }

    } catch (graphqlError) {
      console.error('GraphQL request failed:', {
        message: graphqlError.message,
        response: graphqlError.response?.data,
        status: graphqlError.response?.status
      });
      // Don't fail the whole request if just the definition creation fails
      definitionResult = { status: 'error', error: graphqlError.message };
    }

    // 7. Send success response
    const response = {
      success: true,
      message: 'List created successfully',
      lists: listNames,
      data: {
        customerId,
        listName,
        metafieldKey: safeListKey,
        totalLists: listNames.length,
        shopDomain: shopDomain,
        metafieldId: metafieldId,
        wasUpdate: !!metafieldId
      }
    };

    // Add definition result if available
    if (definitionResult) {
      response.definitionResult = definitionResult;
    }

    console.log('✅ Successfully processed request');
    res.status(201).json(response);

  } catch (error) {
    console.error('Error creating customer list:', {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      customerId,
      listName,
      shop: shopDomain
    });

    // Determine appropriate status code
    let statusCode = 500;
    let errorMessage = 'Failed to create customer list';

    if (error.response) {
      statusCode = error.response.status;
      
      // Handle specific Shopify errors
      if (statusCode === 401) {
        errorMessage = 'Unauthorized: Invalid access token or insufficient permissions';
      } else if (statusCode === 404) {
        errorMessage = 'Customer not found or shop domain invalid';
      } else if (statusCode === 429) {
        errorMessage = 'Rate limit exceeded. Please try again later';
      } else if (statusCode === 422) {
        errorMessage = 'Invalid data provided';
      }
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      message: error.message,
      details: {
        customerId,
        listName,
        shop: shopDomain,
        statusCode: error.response?.status,
        shopifyError: error.response?.data
      }
    });
  }
});

// Test endpoint to verify setup
router.post('/test', async (req, res) => {
  const { shop, accessToken } = req.body;
  
  if (!shop || !accessToken) {
    return res.status(400).json({
      error: 'Missing shop or accessToken',
      required: ['shop', 'accessToken']
    });
  }

  const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;

  try {
    // Test connection by fetching shop info
    const response = await axios.get(`https://${shopDomain}/admin/api/2025-01/shop.json`, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });

    res.json({
      success: true,
      message: 'Connection successful',
      shop: response.data.shop.name,
      domain: response.data.shop.domain,
      apiVersion: '2025-01'
    });

  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: 'Connection failed',
      message: error.message,
      details: error.response?.data
    });
  }
});

// Debug endpoint to check existing metafields and their types
router.post('/debug', async (req, res) => {
  const { customerId} = req.body;
  
  if (!customerId) {
    return res.status(400).json({
      error: 'Missing required fields: customerId, shop, accessToken'
    });
  }

  const shopDomain = process.env.SHOPIFY_STORE;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  try {
    const restConfig = {
      baseURL: `https://${shopDomain}/admin/api/2025-01`,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    };

    // Get all metafields for this customer
    const metafieldsResponse = await axios.get(`/customers/${customerId}/metafields.json`, restConfig);
    
    // Get metafield definitions
    const definitionsQuery = `
      query {
        metafieldDefinitions(first: 50, ownerType: CUSTOMER, namespace: "custom") {
          edges {
            node {
              id
              name
              key
              namespace
              type {
                name
              }
              description
            }
          }
        }
      }
    `;

    const graphqlResponse = await axios.post(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
      query: definitionsQuery
    }, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });

    res.json({
      success: true,
      customer: customerId,
      metafields: metafieldsResponse.data.metafields,
      definitions: graphqlResponse.data?.data?.metafieldDefinitions?.edges || []
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data
    });
  }
});

// Endpoint to create the favList metafield definition if it doesn't exist
router.post('/setup-favlist-definition', async (req, res) => {
  const { shop, accessToken } = req.body;
  
  if (!shop || !accessToken) {
    return res.status(400).json({
      error: 'Missing shop or accessToken'
    });
  }

  const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;

  try {
    const createMutation = `
      mutation MetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            id
            name
            key
            namespace
            type {
              name
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const definitionInput = {
      name: "Favorite Lists",
      namespace: "custom",
      key: "favList",
      type: "list.single_line_text_field",
      ownerType: "CUSTOMER",
      visibleToStorefrontApi: true,
      description: "List of favorite list names for the customer"
    };

    const graphqlResponse = await axios.post(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
      query: createMutation,
      variables: { definition: definitionInput }
    }, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });

    const result = graphqlResponse.data?.data?.metafieldDefinitionCreate;
    
    if (result?.userErrors && result.userErrors.length > 0) {
      if (result.userErrors[0].code === "DUPLICATE_KEY_NAMESPACE") {
        return res.json({
          success: true,
          message: "FavList definition already exists",
          status: "exists"
        });
      } else {
        return res.status(422).json({
          success: false,
          error: "Failed to create definition",
          errors: result.userErrors
        });
      }
    }

    res.json({
      success: true,
      message: "FavList definition created successfully",
      definition: result?.createdDefinition
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data
    });
  }
});
// Fetch products for a specific list
router.post('/products', async (req, res) => {
  const { customerId, listName } = req.body;
  if (!customerId || !listName) {
    return res.status(400).json({ success: false, error: 'Missing customerId or listName' });
  }

  try {
    // Use a sanitized list name for the metafield key
    const metafieldKey = `favList_${listName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    
    // Fetch the specific list's products from metafield
    const response = await shopifyApi.get(`/customers/${customerId}/metafields.json?namespace=custom&key=${metafieldKey}`);
    
    let productIds = [];
    const metafield = (response.data.metafields || [])[0];
    if (metafield && metafield.value) {
      try {
        productIds = JSON.parse(metafield.value);
      } catch (parseError) {
        console.error('Error parsing product IDs:', parseError);
        return res.json({ success: true, products: [] });
      }
    }

    if (!productIds.length) {
      return res.json({ success: true, products: [] });
    }

    // Fetch product details using GraphQL
    const productsWithDetails = await fetchProductDetailsUsingGraphQL(productIds);

    res.json({ success: true, products: productsWithDetails });
  } catch (error) {
    console.error('Error fetching list products:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add product to a specific list
router.post('/add-product', async (req, res) => {
  const { customerId, listName, productId } = req.body;
  if (!customerId || !listName || !productId) {
    return res.status(400).json({ success: false, error: 'Missing customerId, listName, or productId' });
  }

  try {
    // Use a sanitized list name for the metafield key
    const metafieldKey = `favList_${listName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    
    // Fetch existing products for this list
    const response = await shopifyApi.get(`/customers/${customerId}/metafields.json?namespace=custom&key=${metafieldKey}`);
    
    let productIds = [];
    let metafieldId = null;
    
    const metafield = (response.data.metafields || [])[0];
    if (metafield) {
      metafieldId = metafield.id;
      try {
        productIds = JSON.parse(metafield.value) || [];
      } catch (parseError) {
        console.error('Error parsing existing product IDs:', parseError);
        productIds = [];
      }
    }

    // Convert to GID format (consistent with wishlist format)
    const productGid = `gid://shopify/Product/${productId}`;

    // Check if product already exists in the list
    const isAlreadyInList = productIds.some(id => {
      const numericId = id.toString().replace('gid://shopify/Product/', '');
      return numericId === productId.toString();
    });

    if (isAlreadyInList) {
      return res.json({ 
        success: true, 
        message: 'Product already in list', 
        products: productIds 
      });
    }

    // Add new product GID
    productIds.push(productGid);

    const payload = {
      metafield: {
        namespace: 'custom',
        key: metafieldKey,
        value: JSON.stringify(productIds),
        type: 'list.product_reference'
      }
    };

    let saveResp;
    if (metafieldId) {
      saveResp = await shopifyApi.put(`/metafields/${metafieldId}.json`, payload);
    } else {
      saveResp = await shopifyApi.post(`/customers/${customerId}/metafields.json`, payload);
    }

    res.json({ 
      success: true, 
      products: productIds, 
      metafield: saveResp.data.metafield,
      message: 'Product added to list successfully'
    });
  } catch (error) {
    console.error('Error adding product to list:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remove product from a specific list
router.post('/remove-product', async (req, res) => {
  const { customerId, listName, productId } = req.body;
  if (!customerId || !listName || !productId) {
    return res.status(400).json({ success: false, error: 'Missing customerId, listName, or productId' });
  }

  try {
    // Use a sanitized list name for the metafield key
    const metafieldKey = `favList_${listName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    
    // Fetch existing products for this list
    const response = await shopifyApi.get(`/customers/${customerId}/metafields.json?namespace=custom&key=${metafieldKey}`);
    
    let productIds = [];
    let metafieldId = null;
    
    const metafield = (response.data.metafields || [])[0];
    if (metafield) {
      metafieldId = metafield.id;
      try {
        productIds = JSON.parse(metafield.value) || [];
      } catch (parseError) {
        return res.status(404).json({ success: false, error: 'List not found or invalid' });
      }
    } else {
      return res.status(404).json({ success: false, error: 'List not found' });
    }

    // Remove product using the same logic as wishlist removal
    const productGid = `gid://shopify/Product/${productId}`;
    const numericId = productId.toString();
    
    const initialCount = productIds.length;
    
    // Filter out the product in all possible formats
    productIds = productIds.filter((item) => {
      const itemStr = item.toString();
      return itemStr !== productGid &&           
             itemStr !== numericId &&            
             itemStr !== `gid://shopify/Product/${itemStr}` && 
             itemStr.replace('gid://shopify/Product/', '') !== numericId;
    });

    // Check if anything was actually removed
    if (productIds.length === initialCount) {
      return res.json({ 
        success: true, 
        message: "Product not found in list.",
        productId: productId
      });
    }

    const payload = {
      metafield: {
        id: metafieldId,
        value: JSON.stringify(productIds),
      }
    };

    const saveResp = await shopifyApi.put(`/metafields/${metafieldId}.json`, payload);

    res.json({ 
      success: true, 
      products: productIds, 
      message: 'Product removed from list successfully',
      metafield: saveResp.data.metafield 
    });
  } catch (error) {
    console.error('Error removing product from list:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a list entirely
router.post('/delete', async (req, res) => {
  const { customerId, listName } = req.body;
  if (!customerId || !listName) {
    return res.status(400).json({ success: false, error: 'Missing customerId or listName' });
  }

  try {
    // First remove the list name from the main favList metafield
    const listResponse = await shopifyApi.get(`/customers/${customerId}/metafields.json?namespace=custom&key=favList`);
    
    let listNames = [];
    let listMetafieldId = null;
    
    if (listResponse.data.metafields && listResponse.data.metafields[0]) {
      listMetafieldId = listResponse.data.metafields[0].id;
      try {
        listNames = JSON.parse(listResponse.data.metafields[0].value);
      } catch (parseError) {
        console.error('Error parsing list names for deletion:', parseError);
        listNames = [];
      }
    }

    // Remove the list name (case-insensitive)
    const updatedListNames = listNames.filter(name => 
      name.toLowerCase() !== listName.toLowerCase()
    );

    // Update the main list metafield
    if (listMetafieldId) {
      const listPayload = {
        metafield: {
          namespace: 'custom',
          key: 'favList',
          value: JSON.stringify(updatedListNames),
          type: 'list.single_line_text_field'
        }
      };
      await shopifyApi.put(`/metafields/${listMetafieldId}.json`, listPayload);
    }

    // Delete the products metafield for this list
    const metafieldKey = `favList_${listName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const productResponse = await shopifyApi.get(`/customers/${customerId}/metafields.json?namespace=custom&key=${metafieldKey}`);
    
    if (productResponse.data.metafields && productResponse.data.metafields[0]) {
      const productMetafieldId = productResponse.data.metafields[0].id;
      await shopifyApi.delete(`/metafields/${productMetafieldId}.json`);
    }

    res.json({ 
      success: true, 
      message: 'List deleted successfully', 
      lists: updatedListNames 
    });
  } catch (error) {
    console.error('Error deleting list:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GraphQL product fetching function (reused from wishlist code)
async function fetchProductDetailsUsingGraphQL(productIds) {
  // Shopify GraphQL Fetcher
  async function shopifyGraphQL(query, variables = {}) {
    const url = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-07/graphql.json`;

    try {
      const response = await axios({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        },
        data: JSON.stringify({ query, variables }),
      });

      if (response.data.errors) {
        throw new Error(JSON.stringify(response.data.errors));
      }

      return response.data.data;
    } catch (error) {
      if (error.response) {
        throw new Error(
          `Shopify GraphQL error: ${error.response.status} ${error.response.statusText} - ${JSON.stringify(error.response.data)}`
        );
      } else {
        throw new Error(`Shopify GraphQL request failed: ${error.message}`);
      }
    }
  }

  // Add this route to your customer-lists.js file
router.post('/check-product', async (req, res) => {
  const { customerId, productId } = req.body;
  if (!customerId || !productId) {
    return res.status(400).json({ success: false, error: 'Missing customerId or productId' });
  }

  try {
    // Get all lists
    const listsResponse = await shopifyApi.get(`/customers/${customerId}/metafields.json?namespace=custom&key=favList`);
    let listNames = [];
    
    if (listsResponse.data.metafields && listsResponse.data.metafields[0]) {
      try {
        listNames = JSON.parse(listsResponse.data.metafields[0].value);
      } catch (parseError) {
        listNames = [];
      }
    }

    const listsContainingProduct = [];
    
    // Check each list for the product
    for (const listName of listNames) {
      const metafieldKey = `favList_${listName.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const response = await shopifyApi.get(`/customers/${customerId}/metafields.json?namespace=custom&key=${metafieldKey}`);
      
      if (response.data.metafields && response.data.metafields[0]) {
        try {
          const productIds = JSON.parse(response.data.metafields[0].value) || [];
          const productGid = `gid://shopify/Product/${productId}`;
          
          const isInList = productIds.some(id => {
            const numericId = id.toString().replace('gid://shopify/Product/', '');
            return numericId === productId.toString();
          });
          
          if (isInList) {
            listsContainingProduct.push(listName);
          }
        } catch (parseError) {
          continue;
        }
      }
    }

    res.json({ 
      success: true, 
      inLists: listsContainingProduct,
      isInAnyList: listsContainingProduct.length > 0
    });
  } catch (error) {
    console.error('Error checking product in lists:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

  // Helper function to normalize product IDs
  function normalizeProductId(id) {
    if (typeof id === 'string') {
      if (id.includes('gid://shopify/Product/')) {
        return id.split('/').pop();
      }
      return id;
    }
    return id.toString();
  }

  // Normalize all product IDs and create GraphQL IDs
  const productGIDs = productIds.map(id => {
    const numericId = normalizeProductId(id);
    return `gid://shopify/Product/${numericId}`;
  });

  const productQuery = `
    query getProducts($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          handle
          vendor
          descriptionHtml
          featuredImage { url }
          metafields(first: 10, namespace: "custom") {
            edges {
              node {
                namespace
                key
                value
                reference {
                  ... on GenericFile{
                    url
                  }
                  ... on MediaImage {
                    image {
                      url
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const productsResp = await shopifyGraphQL(productQuery, { ids: productGIDs });

  // Format products
  const products = (productsResp.nodes || []).map((product) => {
    if (!product) return null;

    const metafields = product.metafields.edges.map((edge) => edge.node);

    return {
      id: product.id.replace("gid://shopify/Product/", ""),
      title: product.title,
      handle: product.handle,
      vendor: product.vendor || "",
      featured_image: product.featuredImage?.url || "/assets/no-image.png",
      body_html: product.descriptionHtml || "",
      product_code: metafields.find((m) => m.key === "product_code")?.value || "",
      catalogue_pdf: metafields.find((m) => m.key === "catalogue_pdf")?.reference?.url || null,
      group_catalogue: metafields.find((m) => m.key === "group_catalogue")?.reference?.image?.url || null,
    };
  }).filter(Boolean);

  // Keep order as per the original list
  const orderedProducts = productIds
    .map((id) => {
      const numericId = normalizeProductId(id);
      return products.find((p) => p.id === numericId);
    })
    .filter(Boolean);

  return orderedProducts;
}



// Rename an existing list
router.post('/rename', async (req, res) => {
  const { customerId, oldListName, newListName } = req.body;

  if (!customerId || !oldListName || !newListName) {
    return res.status(400).json({ success: false, error: 'Missing customerId, oldListName, or newListName' });
  }

  try {
    // Fetch existing lists
    const response = await shopifyApi.get(`/customers/${customerId}/metafields.json?namespace=custom&key=favList`);
    let listNames = [];
    let metafieldId = null;
    if (response.data.metafields && response.data.metafields[0]) {
      metafieldId = response.data.metafields[0].id;
      try {
        listNames = JSON.parse(response.data.metafields[0].value);
      } catch (parseError) {
        console.error('Error parsing list names for rename:', parseError);
        return res.status(500).json({ success: false, error: 'Invalid list format' });
      }
    } else {
      return res.status(404).json({ success: false, error: 'No lists found' });
    }

    // Check if oldListName exists and newListName doesn't already exist
    const oldIdx = listNames.findIndex(name => name.toLowerCase() === oldListName.toLowerCase());
    if (oldIdx === -1) {
      return res.status(404).json({ success: false, error: 'Old list name not found' });
    }
    const duplicate = listNames.some(name => name.toLowerCase() === newListName.toLowerCase());
    if (duplicate) {
      return res.status(409).json({ success: false, error: 'A list with the new name already exists' });
    }

    // Update the list name
    listNames[oldIdx] = newListName;

    // Save back to Metafield
    const payload = {
      metafield: {
        namespace: 'custom',
        key: 'favList',
        value: JSON.stringify(listNames),
        type: 'list.single_line_text_field'
      }
    };
    await shopifyApi.put(`/metafields/${metafieldId}.json`, payload);

    // Also: Rename the per-list products metafield key (if exists)
    const oldKey = `favList_${oldListName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const newKey = `favList_${newListName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const perList = await shopifyApi.get(`/customers/${customerId}/metafields.json?namespace=custom&key=${oldKey}`);
    if (perList.data.metafields && perList.data.metafields[0]) {
      const products = perList.data.metafields[0].value;
      // Create new metafield for new name
      await shopifyApi.post(`/customers/${customerId}/metafields.json`, {
        metafield: {
          namespace: 'custom',
          key: newKey,
          value: products,
          type: 'list.product_reference'
        }
      });
      // Delete old metafield
      await shopifyApi.delete(`/metafields/${perList.data.metafields[0].id}.json`);
    }

    res.json({ success: true, lists: listNames, message: 'List renamed successfully' });
  } catch (error) {
    console.error('Error renaming list:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


router.get('/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  
  console.log('Image proxy request:', imageUrl);
  
  if (!imageUrl) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }
  
  try {
    console.log('Fetching image from:', imageUrl);
    
    const response = await axios({
      url: imageUrl,
      method: 'GET',
      responseType: 'stream',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    console.log('Image fetched successfully');
    
    // Set proper headers
    res.set({
      'Content-Type': response.headers['content-type'] || 'image/jpeg',
      'Content-Length': response.headers['content-length'],
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Cache-Control': 'public, max-age=3600'
    });
    
    // Stream the image to client
    response.data.pipe(res);
    
  } catch (error) {
    console.error('Image proxy error:', error.message);
    
    if (error.code === 'ETIMEDOUT') {
      return res.status(408).send('Request timeout');
    } else if (error.code === 'ENOTFOUND') {
      return res.status(404).send('Image not found');
    } else if (error.response && error.response.status) {
      return res.status(error.response.status).send('Image fetch failed');
    }
    
    res.status(500).send('Internal server error');
  }
});


// Make sure this comes AFTER all your routes
module.exports = router;


