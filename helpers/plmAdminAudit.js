const supabase = require('../supabaseClient')

// Records every mutating action taken through the PLM Super Admin / Admin console —
// this is the security/integrity trail the console exists to provide, so every
// grant/revoke/delete/reassign route must call this after (or instead of failing on)
// its own write.
async function logAdminAction({ actorMemberId, action, targetType, targetId = null, detail = null }) {
  const { error } = await supabase.from('npd2_admin_audit_log').insert({
    actor_member_id: actorMemberId,
    action,
    target_type: targetType,
    target_id: targetId,
    detail,
  })
  if (error) console.error('[plm admin audit] failed to log', action, targetType, targetId, error.message)
}

module.exports = { logAdminAction }
