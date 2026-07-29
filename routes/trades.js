const express = require('express');
const router = express.Router();
const axios = require('axios');

router.get('/', async (req, res) => {
  try {
    const response = await axios.get(
      "https://api-v1.eximtradedata.com/EximAPI/key-A87U25H12@e$3/india/import/2025-01-01/2025-04-30/0-100/and/hs_code-30/and/importer_Name-HERAEUS%20TECHNOLOGIES%20INDIA%20PRIVATE%20LIMITED",
    );
   //"https://api-v1.eximtradedata.com/EximAPI/key-A87U25H12@e$3/india/import/2025-01-01/2025-04-30/0-2/and/hs_code-30/and/importer_Name-tata/and/declaration_Number-9801874",
    console.log("API Data:", response.data);
    res.json(response.data);
   
  } catch (error) {
    console.error("Status:", error.response?.status);
    console.error("Data:", error.response?.data);
    console.error("Message:", error.message);

    res.status(error.response?.status || 500).json({
      error: "Exim API request failed",
      details: error.response?.data || error.message
    });
  }
});
// https://api-v1.eximtradedata.com/EximAPI/key-A87U25H12@e$3/india/import/2025-01-01/2025-01-31/0-1/and/hs_code-30


router.get('/ip-test', async (req, res) => {
  try {
    const r = await axios.get("https://api.ipify.org?format=json");
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;