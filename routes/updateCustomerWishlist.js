const express = require("express");
const axios = require("axios");
const router = express.Router();

// Create a centralized Axios instance for Shopify API calls
const shopifyApi = axios.create({
  baseURL: `https://${process.env.SHOPIFY_STORE}/admin/api/2024-07`,
  headers: {
    "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
    "Content-Type": "application/json",
  },
});

/**
 * Helper function to find the wishlist metafield for a customer.
 * @param {string} customerId - The Shopify customer ID.
 * @returns {Promise<object|null>} The existing metafield object or null.
 */
const getWishlistMetafield = async (customerId) => {
  try {
    const response = await shopifyApi.get(`/customers/${customerId}/metafields.json`);
    const { metafields } = response.data;
    return metafields.find((m) => m.namespace === "custom" && m.key === "wishlist") || null;
  } catch (error) {
    // Re-throw the error to be caught by the route handler
    throw error;
  }
};


// POST /wishlist/add
router.post("/add", async (req, res) => {
  const { customerId, productId } = req.body;

  if (!customerId || !productId) {
    return res.status(400).json({ error: "customerId and productId are required" });
  }

  // A Shopify product reference metafield requires the GID format.
  const productGid = `gid://shopify/Product/${productId}`;

  try {
    const existingMetafield = await getWishlistMetafield(customerId);

    let wishlist = [];
    if (existingMetafield) {
      // The value is stored as a JSON string of an array.
      wishlist = JSON.parse(existingMetafield.value);
    }

    // Add product GID only if it's not already in the wishlist
    if (!wishlist.includes(productGid)) {
      wishlist.push(productGid);
    } else {
      // Product already in wishlist, return success without making an API call.
      return res.json({ success: true, message: "Product already in wishlist", metafield: existingMetafield });
    }

    const payload = {
      metafield: {
        namespace: "custom",
        key: "wishlist",
        type: "list.product_reference",
        // The value for a list type must be a JSON-formatted string.
        value: JSON.stringify(wishlist),
      },
    };

    let updatedMetafield;

    if (existingMetafield) {
      // Update the existing metafield
      const response = await shopifyApi.put(`/metafields/${existingMetafield.id}.json`, payload);
      updatedMetafield = response.data.metafield;
    } else {
      // Create a new metafield for the customer
      const response = await shopifyApi.post(`/customers/${customerId}/metafields.json`, payload);
      updatedMetafield = response.data.metafield;
    }

    res.json({ success: true, metafield: updatedMetafield });
  } catch (err) {
    console.error("Error adding to wishlist:", err.response ? err.response.data : err.message);
    res.status(500).json({ error: "Failed to update wishlist" });
  }
});


// POST /wishlist/remove
// 

router.post("/remove", async (req, res) => {
  const { customerId, productId } = req.body;

  if (!customerId || !productId) {
    return res.status(400).json({ error: "customerId and productId are required" });
  }

  console.log('Remove request - Customer ID:', customerId, 'Product ID:', productId);

  try {
    const existingMetafield = await getWishlistMetafield(customerId);

    if (!existingMetafield) {
      // No wishlist exists, so the item is already "removed".
      return res.json({ success: true, message: "Wishlist not found, no action needed." });
    }

    let wishlist = JSON.parse(existingMetafield.value);
    const initialCount = wishlist.length;

    console.log('Current wishlist before removal:', wishlist);

    // Handle both formats: numeric IDs and GIDs
    // Remove all possible formats of the product ID
    const productGid = `gid://shopify/Product/${productId}`;
    const numericId = productId.toString();
    
    wishlist = wishlist.filter((item) => {
      // Convert item to string for comparison
      const itemStr = item.toString();
      
      // Remove if it matches any of these formats:
      return itemStr !== productGid &&           // GID format
             itemStr !== numericId &&            // Numeric format
             itemStr !== `gid://shopify/Product/${itemStr}` && // If item is numeric but we're comparing to GID
             itemStr.replace('gid://shopify/Product/', '') !== numericId; // Extract numeric from GID
    });
    
    console.log('Wishlist after removal:', wishlist);
    
    // If the list hasn't changed, the item wasn't there in the first place.
    if (wishlist.length === initialCount) {
        console.log('Product not found in wishlist');
        return res.json({ 
          success: true, 
          message: "Product not found in wishlist.", 
          originalWishlist: JSON.parse(existingMetafield.value),
          productId: productId,
          searchedFormats: [productGid, numericId]
        });
    }

    const payload = {
      metafield: {
        id: existingMetafield.id,
        value: JSON.stringify(wishlist),
      },
    };

    const response = await shopifyApi.put(`/metafields/${existingMetafield.id}.json`, payload);
    const updatedMetafield = response.data.metafield;

    console.log('Successfully removed product from wishlist');
    res.json({ 
      success: true, 
      metafield: updatedMetafield,
      removedProductId: productId,
      newWishlistLength: wishlist.length
    });
  } catch (err) {
    console.error("Error removing from wishlist:", err.response ? err.response.data : err.message);
    res.status(500).json({ error: "Failed to remove product from wishlist" });
  }
});



router.post('/check', async (req, res) => {
  try {
    const { customerId, productId } = req.body;

    if (!customerId || !productId) {
      return res.json({
        success: false,
        error: 'Customer ID and Product ID are required'
      });
    }

    // Get current customer data with metafields
    const customerData = await shopifyFetch(`customers/${customerId}.json`);
    
    if (!customerData.customer) {
      return res.json({
        success: false,
        error: 'Customer not found'
      });
    }

    // Get existing wishlist metafield
    const wishlistMetafield = customerData.customer.metafields?.find(
      metafield => metafield.namespace === 'custom' && metafield.key === 'wishlist'
    );

    if (!wishlistMetafield || !wishlistMetafield.value) {
      return res.json({
        success: true,
        inWishlist: false
      });
    }

    let wishlistIds = [];
    try {
      wishlistIds = JSON.parse(wishlistMetafield.value);
      if (!Array.isArray(wishlistIds)) {
        wishlistIds = [];
      }
    } catch (e) {
      wishlistIds = [];
    }

    const inWishlist = wishlistIds.includes(productId.toString());

    res.json({
      success: true,
      inWishlist: inWishlist
    });

  } catch (error) {
    console.error('Error checking wishlist:', error);
    res.json({
      success: false,
      error: 'Internal server error'
    });
  }
});



async function shopifyFetch(endpoint, options = {}) {
  const url = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-07/${endpoint}`;

  try {
    const response = await axios({
      url,
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        ...(options.headers || {}),
      },
      data: options.body || undefined, // axios uses `data` instead of body
    });

    return response.data; // axios auto-parses JSON
  } catch (error) {
    if (error.response) {
      throw new Error(
        `Shopify API error: ${error.response.status} ${error.response.statusText} - ${JSON.stringify(error.response.data)}`
      );
    } else {
      throw new Error(`Shopify API request failed: ${error.message}`);
    }
  }
}

module.exports = router;