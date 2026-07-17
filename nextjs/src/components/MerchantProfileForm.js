'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Store, Upload, X } from 'lucide-react'

const EMPTY = {
  bank_name: '',
  account_name: '',
  account_number: '',
  duitnow_id: '',
  payment_instructions: '',
  bank_qr_path: null,
  tng_qr_path: null,
  bank_qr_url: null,
  tng_qr_url: null,
}

export default function MerchantProfileForm() {
  const [form, setForm] = useState(EMPTY)
  const [complete, setComplete] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(null)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    fetch('/api/profile/merchant')
      .then(async res => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to load seller payment information')
        setForm({ ...EMPTY, ...(data.profile || {}) })
        setComplete(Boolean(data.complete))
      })
      .catch(error => setMessage({ type: 'error', text: error.message }))
      .finally(() => setLoading(false))
  }, [])

  const update = (field, value) => setForm(prev => ({ ...prev, [field]: value }))

  const uploadQr = async (kind, file) => {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setMessage({ type: 'error', text: 'QR image must be JPEG, PNG, or WebP.' })
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage({ type: 'error', text: 'QR image must be 5 MB or smaller.' })
      return
    }

    setUploading(kind)
    setMessage(null)
    try {
      const createRes = await fetch('/api/profile/merchant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      })
      const upload = await createRes.json()
      if (!createRes.ok) throw new Error(upload.error || 'Could not prepare QR upload')

      const putRes = await fetch(upload.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type, 'x-upsert': 'true' },
        body: file,
      })
      if (!putRes.ok) throw new Error('QR upload failed')

      const pathKey = `${kind}_path`
      const urlKey = `${kind}_url`
      setForm(prev => ({
        ...prev,
        [pathKey]: upload.storage_path,
        [urlKey]: URL.createObjectURL(file),
      }))
      setMessage({ type: 'success', text: 'QR uploaded. Save your seller information to keep this change.' })
    } catch (error) {
      setMessage({ type: 'error', text: error.message })
    } finally {
      setUploading(null)
    }
  }

  const removeQr = async (kind) => {
    setUploading(kind)
    setMessage(null)
    try {
      const res = await fetch(`/api/profile/merchant?kind=${kind}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not remove QR')
      setForm(prev => ({ ...prev, [`${kind}_path`]: null, [`${kind}_url`]: null }))
      setMessage({ type: 'success', text: 'QR removed.' })
    } catch (error) {
      setMessage({ type: 'error', text: error.message })
    } finally {
      setUploading(null)
    }
  }

  const save = async (event) => {
    event.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch('/api/profile/merchant', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bank_name: form.bank_name,
          account_name: form.account_name,
          account_number: form.account_number,
          duitnow_id: form.duitnow_id,
          payment_instructions: form.payment_instructions,
          bank_qr_path: form.bank_qr_path,
          tng_qr_path: form.tng_qr_path,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save seller payment information')
      setComplete(true)
      setMessage({ type: 'success', text: 'Seller payment information saved. You can list cards for sale.' })
    } catch (error) {
      setMessage({ type: 'error', text: error.message })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-dbb-accent" />
      </div>
    )
  }

  return (
    <form onSubmit={save} className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h3 className="text-dbb-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Seller payment information</h3>
          <p className="text-dbb-xs text-gray-500 mt-1">Required before listing. Buyers see these details only in their checkout result.</p>
        </div>
        <span className={`inline-flex items-center gap-1 text-dbb-xs px-2 py-1 rounded-full ${complete ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'}`}>
          {complete && <CheckCircle2 className="w-3.5 h-3.5" />}
          {complete ? 'Complete' : 'Required'}
        </span>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Bank / payment provider" value={form.bank_name} onChange={value => update('bank_name', value)} required placeholder="e.g. Maybank" />
        <Field label="Account holder name" value={form.account_name} onChange={value => update('account_name', value)} required />
        <Field label="Account number" value={form.account_number} onChange={value => update('account_number', value)} placeholder="Required if no DuitNow ID" />
        <Field label="DuitNow ID" value={form.duitnow_id} onChange={value => update('duitnow_id', value)} placeholder="Phone, NRIC, or business ID" />
      </div>

      <label className="block mt-4">
        <span className="block text-dbb-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Payment instructions</span>
        <textarea
          value={form.payment_instructions}
          onChange={event => update('payment_instructions', event.target.value)}
          maxLength={500}
          rows={3}
          placeholder="Optional reference or transfer note instructions"
          className="w-full bg-gray-50 dark:bg-dbb-primary border border-gray-200 dark:border-gray-700 rounded-lg h-11 px-3 text-dbb-sm focus:outline-none focus:border-dbb-accent"
        />
      </label>

      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        <QrField label="Bank / DuitNow QR" kind="bank_qr" url={form.bank_qr_url} busy={uploading === 'bank_qr'} onUpload={uploadQr} onRemove={removeQr} />
        <QrField label="Touch 'n Go QR" kind="tng_qr" url={form.tng_qr_url} busy={uploading === 'tng_qr'} onUpload={uploadQr} onRemove={removeQr} />
      </div>

      {message && (
        <p className={`text-dbb-xs mt-4 ${message.type === 'error' ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>{message.text}</p>
      )}

      <button type="submit" disabled={saving || Boolean(uploading)} className="btn btn-primary btn-md mt-5 inline-flex items-center gap-2">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Store className="w-4 h-4" />}
        Save seller information
      </button>
    </form>
  )
}

function Field({ label, value, onChange, required = false, placeholder = '' }) {
  return (
    <label>
      <span className="block text-dbb-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">{label}{required ? ' *' : ''}</span>
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        required={required}
        maxLength={120}
        placeholder={placeholder}
        className="w-full bg-gray-50 dark:bg-dbb-primary border border-gray-200 dark:border-gray-700 rounded-lg h-11 px-3 text-dbb-sm focus:outline-none focus:border-dbb-accent"
      />
    </label>
  )
}

function QrField({ label, kind, url, busy, onUpload, onRemove }) {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
      <p className="text-dbb-xs font-medium text-gray-600 dark:text-gray-400 mb-2">{label} (optional)</p>
      {url && <img src={url} alt={`${label} preview`} className="w-28 h-28 object-contain bg-white rounded border mb-2" />}
      <div className="flex items-center gap-2">
        <label className="btn btn-outline btn-sm inline-flex items-center gap-1 cursor-pointer">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {url ? 'Replace' : 'Upload'}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" disabled={busy} onChange={event => onUpload(kind, event.target.files?.[0])} />
        </label>
        {url && (
          <button type="button" className="btn btn-secondary btn-sm inline-flex items-center gap-1" disabled={busy} onClick={() => onRemove(kind)}>
            <X className="w-3.5 h-3.5" /> Remove
          </button>
        )}
      </div>
    </div>
  )
}
