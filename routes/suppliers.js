const express = require("express");
const router = express.Router()
const supabase = require('../supabaseClient')

router.get("/ftpr", async (req, res) => {
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year) || new Date().getFullYear();

  const { data, error } = await supabase
    .from("supplier_ftpr")
    .select(`
      total_inspections,
      accepted,
      rejected,
      ftpr,
      organizations (
        display_name
      )
    `)
    .eq("month", month)
    .eq("year", year);

  if (error) return res.status(500).json({ error: error.message });

  const result = data.map((s) => ({
    name: s.organizations?.display_name,
    total_inspections: s.total_inspections,
    accepted: s.accepted,
    rejected: s.rejected,
    ftpr: s.ftpr,
  }));

  res.json(result);
});


module.exports = router
