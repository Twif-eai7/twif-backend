const { shopifyApi } = require('@shopify/shopify-api');
const { MemorySessionStorage } = require('@shopify/shopify-app-session-storage-memory');
require('@shopify/shopify-api/adapters/node');
require('dotenv/config');

// Modern Shopify API Configuration (2025)
const shopify = shopifyApi({
  // Required configuration
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_API_SCOPES?.split(',') || [],
  apiVersion: '2025-01', // Use latest stable API version
  
  // Host configuration
  hostName: process.env.HOST || 'https://shopify-backend-gt39.onrender.com',
  hostScheme: 'https',
  sessionStorage: new MemorySessionStorage(),
  logger: {
    level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  },
});

module.exports = { shopify };