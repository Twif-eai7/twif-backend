const dotenv = require("dotenv");
dotenv.config();
const express = require("express");
const cors = require("cors");

// --- Import modular routes ---
const updateCustomerRoutes = require('./routes/updateCustomer');
const aiSearchRoutes = require('./routes/aiSearch');
const updateCustomerWishlistRoutes = require('./routes/updateCustomerWishlist');
const getCustomerWishListRoutes = require('./routes/getCustomerWishlist');
const customerListsRoutes = require('./routes/customerLists');
const shareListRoutes = require('./routes/shareList'); 
const customers = require('./routes/customers');
const visualSearchRoutes = require('./routes/visualSearch');
const merchantsRoutes = require('./routes/merchants');
const proxyRoutes = require('./routes/proxy');
const tradeRoutes = require('./routes/trades');
const travelRoutes = require('./routes/travelBill');
const testRoutes = require('./routes/test');
const buyersRoutes = require('./routes/buyers');
const consultancyInvoicesRoutes = require('./routes/consultancyInvoices');
const cronJobsRoutes = require('./routes/cronJobs');
const onBoardCustomersRoutes = require('./routes/onBoardCustomers');
const dashboardRoutes = require('./routes/dashboard');
const databaseWebhooks = require('./routes/databaseWebhooks');
const suppliersRoutes = require('./routes/suppliers');
const adminRoutes = require('./routes/admin');
const inspectionScheduleRoutes = require('./routes/inspectionSchedule');
const npdRoutes = require('./routes/npd');
const plmRoutes = require('./routes/plm');
const pctRoutes = require('./routes/pct');
const pofileRecordsRoutes = require('./routes/poFileRecords');
const travelExpensesroutes = require('./routes/travelExpense');
const purchaseOrdersRoutes = require('./routes/purchaseOrders');
const skuItemsRoutes = require('./routes/skuItems')
const courierLogsRoutes = require('./routes/courierLogs');
const internationalCourierLogsRoutes = require('./routes/internationalCourierLogs');
const internalEmailRoutes = require('./routes/internalEmail');

 
// --- Environment Variable Validation ---
const { SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN, GEMINI_API_KEY} = process.env;
const PORT = process.env.PORT || 8080;


if (!SHOPIFY_STORE || !SHOPIFY_ADMIN_TOKEN) {
  console.error('Missing required Shopify environment variables: SHOPIFY_STORE and/or SHOPIFY_ADMIN_TOKEN');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
    console.error("Missing GEMINI_API_KEY environment variable. AI Search will fail.");
}

// --- App Initialization & Middleware ---
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

const allowedOrigins = [
  "https://jn-global.myshopify.com",
  "https://jnitin.com",
  "https://www.jnitin.com",
  "http://localhost:5173",
  "http://localhost:5174",
  "https://jng-686756139829.asia-south2.run.app",
  "https://warm-physics-470205-e0.web.app",
  "https://warm-physics-470205-e0.firebaseapp.com",
  "https://jng.global"
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // allow non-browser tools (e.g. Postman)
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.log(`🚫 CORS blocked origin: ${origin}`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS","PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Add right after your cors() middleware, before any routes:
app.options(/.*/, cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// --- App Proxy Routes (must be mounted at /apps/proxy) ---
// These routes are accessed via: yourstore.myshopify.com/apps/proxy/...
// app.use("/proxy/customers", customers);
app.use("/customers", customers);
// --- Regular API Routes (non-proxy) ---
app.use("/update-customer-metafields", updateCustomerRoutes);
app.use("/inspection-schedule", inspectionScheduleRoutes);
app.use("/ai-search", aiSearchRoutes);
app.use("/wishlist", updateCustomerWishlistRoutes);
app.use("/customer-wishlist", getCustomerWishListRoutes);
app.use('/customer-lists', customerListsRoutes); 
app.use("/share-list", shareListRoutes);
app.use("/visual-search", visualSearchRoutes);
app.use("/merchants",merchantsRoutes)
app.use('/proxy', proxyRoutes);
app.use('/trades', tradeRoutes);
app.use('/travel-bill', travelRoutes);
app.use('/test', testRoutes);
app.use('/buyers', buyersRoutes);
app.use('/consultancy', consultancyInvoicesRoutes);
app.use('/cron', cronJobsRoutes);
app.use('/pofiles', pofileRecordsRoutes);
app.use('/purchase-orders', purchaseOrdersRoutes);
// app.use('/org-customers', onBoardCustomersRoutes);
// app.use('/auth', authRoutes);
app.use('/webhooks', databaseWebhooks);
app.use('/suppliers', suppliersRoutes);
app.use('/org-customers', onBoardCustomersRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/admin', adminRoutes);
app.use('/npd', npdRoutes);
app.use('/plm', plmRoutes);
app.use('/pct', pctRoutes);
app.use('/travel-expenses', travelExpensesroutes);
app.use('/skus', skuItemsRoutes)
app.use('/logistics/courier-logs', courierLogsRoutes);
app.use('/logistics/international-courier-logs', internationalCourierLogsRoutes);
app.use('/internal', internalEmailRoutes);
// --- Core Routes ---
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    shopify_store: SHOPIFY_STORE ? "configured" : "not configured"
  }); 
});

// // --- 404 Handler for debugging ---
// app.use((req, res) => {
//   console.log('❌ 404 - Route not found:', req.method, req.originalUrl);
//   console.log('Headers:', JSON.stringify(req.headers, null, 2));
//   res.status(404).json({ 
//     success: false, 
//     error: 'Route not found',
//     path: req.originalUrl,
//     method: req.method
//   });
// });

// --- Server Startup ---
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Shopify Store: ${SHOPIFY_STORE}`);
  console.log('App Proxy routes mounted at: /apps/proxy/customers');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT to a free port.`);
  } else {
    console.error('Server failed to start:', err);
  }
  process.exit(1);
});

module.exports = app;