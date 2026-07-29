const supabase = require('../supabaseClient')

async function resolveMember(req, res, selectFields = 'id') {
  const { data: member, error } = await supabase
    .from('organization_members')
    .select(selectFields)
    .eq('user_id', req.user.id)
    .maybeSingle()
  if (error) {
    res.status(500).json({ error: error.message })
    return null
  }
  if (!member) {
    res.status(401).json({ error: 'Member not found for this user' })
    return null
  }
  return member
}

module.exports = { resolveMember }
