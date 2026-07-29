const express = require("express");
const axios = require("axios");
const router = express.Router();

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

// Helper function to normalize product IDs
function normalizeProductId(id) {
  if (typeof id === 'string') {
    // If it's a Global ID, extract the numeric part
    if (id.includes('gid://shopify/Product/')) {
      return id.split('/').pop();
    }
    // If it's already numeric string, return as is
    return id;
  }
  // If it's a number, convert to string
  return id.toString();
}

router.post("/get", async (req, res) => {
  try {
    const { customerId } = req.body;

    if (!customerId) {
      return res.json({ success: false, error: "Customer ID is required" });
    }

    console.log('Received request for customer:', customerId); // Debug log

    // Normalize customer ID - handle both formats
    let customerGID;
    if (typeof customerId === 'string' && customerId.includes('gid://shopify/Customer/')) {
      customerGID = customerId;
    } else {
      customerGID = `gid://shopify/Customer/${customerId}`;
    }

    console.log('Using customer GID:', customerGID); // Debug log

    // Step 1: Fetch customer metafields
    const customerMetafields = await shopifyGraphQL(
      `
      query getCustomerMetafields($id: ID!) {
        customer(id: $id) {
          id
          metafields(first: 10, namespace: "custom") {
            edges {
              node {
                namespace
                key
                type
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
    `,
      { id: customerGID }
    );

    console.log('Customer metafields response:', JSON.stringify(customerMetafields, null, 2)); // Debug log

    if (!customerMetafields.customer) {
      return res.json({ success: false, error: "Customer not found" });
    }

    const wishlistField = customerMetafields.customer.metafields.edges.find(
      (edge) => edge.node.key === "wishlist"
    );

    if (!wishlistField) {
      console.log('No wishlist metafield found'); // Debug log
      return res.json({ success: true, products: [] });
    }

    console.log('Wishlist metafield value:', wishlistField.node.value); // Debug log

    let productIds;
    try {
      productIds = JSON.parse(wishlistField.node.value);
      if (!Array.isArray(productIds)) {
        console.log('Wishlist is not an array:', productIds); // Debug log
        productIds = [];
      }
    } catch (e) {
      console.log('Failed to parse wishlist JSON:', e.message); // Debug log
      productIds = [];
    }

    console.log('Parsed product IDs:', productIds); // Debug log

    if (productIds.length === 0) {
      return res.json({ success: true, products: [] });
    }

    // Step 2: Normalize all product IDs and create GraphQL IDs
    const productGIDs = productIds.map(id => {
      const numericId = normalizeProductId(id);
      return `gid://shopify/Product/${numericId}`;
    });

    console.log('Product GIDs for GraphQL:', productGIDs); // Debug log

    const productQuery = `
      query getProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            handle
            vendor
            featuredImage { url }
            metafields(first: 10, namespace: "custom") {
              edges {
                node {
                  namespace
                  key
                  value
                }
              }
            }
          }
        }
      }
    `;

    const productsResp = await shopifyGraphQL(productQuery, { ids: productGIDs });

    console.log('Products response:', JSON.stringify(productsResp, null, 2)); // Debug log

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
        product_code:
          metafields.find((m) => m.key === "product_code")?.value || "",
        catalogue_pdf:
         metafields.find((m) => m.key === "catalogue_pdf")?.reference?.url || null,
        group_catalogue:
          metafields.find((m) => m.key === "group_catalogue")?.reference?.image?.url || null,
      };
    }).filter(Boolean);

    // Keep order as per wishlist
    const orderedProducts = productIds
      .map((id) => {
        const numericId = normalizeProductId(id);
        return products.find((p) => p.id === numericId);
      })
      .filter(Boolean);

    console.log('Final ordered products:', orderedProducts); // Debug log

    res.json({ success: true, products: orderedProducts });
  } catch (error) {
    console.error("Error getting wishlist:", error);
    res.json({ success: false, error: error.message || "Internal server error" });
  }
});

// Add a simple health check endpoint
router.get("/health", (req, res) => {
  res.json({ success: true, message: "Wishlist service is running", timestamp: new Date().toISOString() });
});

module.exports = router;