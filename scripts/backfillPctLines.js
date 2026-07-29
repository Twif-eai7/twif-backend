#!/usr/bin/env node
/**
 * One-time backfill: create pct_lines for pre-existing approved PLM workspaces.
 * Run: node scripts/backfillPctLines.js
 */
require('dotenv').config()
const { backfillFromApprovedWorkspaces } = require('../service/pctService')

backfillFromApprovedWorkspaces()
  .then((result) => {
    console.log('Backfill complete:', result)
    process.exit(0)
  })
  .catch((err) => {
    console.error('Backfill failed:', err)
    process.exit(1)
  })
