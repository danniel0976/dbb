const UNDEFINED_COLUMN = '42703'

export async function getMerchantProfileState(client, userId) {
  const { data, error } = await client
    .from('profiles')
    .select(`
      merchant_bank_name,
      merchant_account_name,
      merchant_account_number,
      merchant_duitnow_id,
      merchant_payment_instructions,
      merchant_bank_qr_path,
      merchant_tng_qr_path,
      merchant_profile_completed_at
    `)
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    if (error.code === UNDEFINED_COLUMN) {
      return { complete: false, unavailable: true, error: 'Seller payment information is not configured yet' }
    }
    return { complete: false, error: 'Could not verify seller payment information' }
  }

  const complete = Boolean(
    data?.merchant_profile_completed_at &&
    data?.merchant_bank_name?.trim() &&
    data?.merchant_account_name?.trim() &&
    (data?.merchant_account_number?.trim() || data?.merchant_duitnow_id?.trim())
  )

  return { complete, profile: data || null }
}

export async function requireCompleteMerchantProfile(client, userId) {
  const state = await getMerchantProfileState(client, userId)
  if (state.complete) return null
  return {
    error: state.error || 'Complete your seller payment information before listing',
    status: state.unavailable ? 503 : 422,
    code: state.unavailable ? 'MERCHANT_PROFILE_UNAVAILABLE' : 'MERCHANT_PROFILE_REQUIRED',
  }
}
