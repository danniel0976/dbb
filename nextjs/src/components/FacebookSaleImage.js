'use client'

import { useEffect, useState } from 'react'
import { Download, Image as ImageIcon, Loader2, Share2 } from 'lucide-react'
import { useToast } from '@/components/Toast'

const MULTIPLIERS = [2.5, 2.8, 3.0]

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create JPEG')), 'image/jpeg', 0.9)
  })
}

function fitFont(ctx, text, maxWidth, startSize, minSize = 24) {
  let size = startSize
  while (size > minSize) {
    ctx.font = `700 ${size}px system-ui, sans-serif`
    if (ctx.measureText(text).width <= maxWidth) break
    size -= 2
  }
  return size
}

export default function FacebookSaleImage({ libraryRow, hasPhoto, hasUnsavedDetails }) {
  const { toast } = useToast()
  const [multiplier, setMultiplier] = useState(2.8)
  const [referenceCkdUsd, setReferenceCkdUsd] = useState(undefined)
  const [quote, setQuote] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState(null)
  const [rememberedAt, setRememberedAt] = useState(null)

  useEffect(() => {
    fetch(`/api/facebook-export/${libraryRow.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => setRememberedAt(data?.snapshot?.generated_at || null))
      .catch(() => {})
  }, [libraryRow.id])

  useEffect(() => {
    let active = true
    setReferenceCkdUsd(undefined)
    fetch('/api/pricing/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ scryfall_id: libraryRow.scryfall_id, foil: libraryRow.foil }] }),
    })
      .then(async response => response.ok ? response.json() : Promise.reject(new Error('Price unavailable')))
      .then(data => {
        if (active) setReferenceCkdUsd(data?.prices?.[`${libraryRow.scryfall_id}:${libraryRow.foil}`]?.ckd_usd ?? null)
      })
      .catch(() => {
        if (active) setReferenceCkdUsd(null)
      })
    return () => { active = false }
  }, [libraryRow.scryfall_id, libraryRow.foil])

  useEffect(() => () => {
    if (result?.url) URL.revokeObjectURL(result.url)
  }, [result])

  const disabledReason = !hasPhoto
    ? 'Take a condition photo first.'
    : hasUnsavedDetails
      ? 'Save condition or finish changes before generating.'
      : null
  const referenceMyr = referenceCkdUsd == null
    ? null
    : Math.round(referenceCkdUsd * multiplier * 2) / 2

  function chooseMultiplier(value) {
    setMultiplier(value)
    setQuote(null)
  }

  async function generate() {
    if (disabledReason) return
    setGenerating(true)
    try {
      const preparationResponse = await fetch(`/api/facebook-export/${libraryRow.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'prepare', multiplier }),
      })
      const preparationData = await preparationResponse.json().catch(() => ({}))
      if (!preparationResponse.ok) throw new Error(preparationData.error || 'Could not prepare sale image')
      const prepared = preparationData.preparation
      if (!prepared?.preparation_token) throw new Error('Server returned an incomplete image preparation')
      setMultiplier(prepared.multiplier)
      setQuote({ multiplier: prepared.multiplier, ckdUsd: prepared.ckd_usd, myrPrice: prepared.myr_price })

      // The photo, labels and prices used for pixels all come from this one
      // server-signed preparation. Do not independently re-read any of them.
      const sourceResponse = await fetch(prepared.photo_url)
      if (!sourceResponse.ok) throw new Error('Could not download condition photo')
      const bitmap = await createImageBitmap(await sourceResponse.blob())

      const maxPhotoWidth = 1600
      const scale = Math.min(1, maxPhotoWidth / bitmap.width)
      const photoWidth = Math.round(bitmap.width * scale)
      const photoHeight = Math.round(bitmap.height * scale)
      const padding = Math.max(48, Math.round(photoWidth * 0.05))
      const topPanel = Math.max(170, Math.round(photoWidth * 0.14))
      const bottomPanel = Math.max(210, Math.round(photoWidth * 0.18))
      const canvas = document.createElement('canvas')
      canvas.width = photoWidth + padding * 2
      canvas.height = photoHeight + padding * 2 + topPanel + bottomPanel
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#f4efe4'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      const cardName = prepared.card_name
      const detail = `${prepared.set_code} #${prepared.collector_number}  •  ${prepared.condition}  •  ${prepared.finish}`
      ctx.fillStyle = '#171717'
      const nameSize = fitFont(ctx, cardName, canvas.width - padding * 2, Math.min(64, canvas.width * 0.055))
      ctx.font = `700 ${nameSize}px system-ui, sans-serif`
      ctx.fillText(cardName, padding, padding + nameSize)
      ctx.fillStyle = '#5a554d'
      ctx.font = `500 ${Math.max(24, Math.round(nameSize * 0.48))}px system-ui, sans-serif`
      ctx.fillText(detail, padding, padding + nameSize + Math.max(42, nameSize * 0.75))

      const photoY = padding + topPanel
      ctx.drawImage(bitmap, padding, photoY, photoWidth, photoHeight)
      bitmap.close()

      const priceY = photoY + photoHeight + Math.round(bottomPanel * 0.48)
      ctx.fillStyle = '#b42318'
      ctx.font = `800 ${Math.max(68, Math.round(canvas.width * 0.085))}px system-ui, sans-serif`
      ctx.fillText(`RM ${prepared.myr_price.toFixed(2)}`, padding, priceY)
      ctx.fillStyle = '#5a554d'
      ctx.font = `600 ${Math.max(25, Math.round(canvas.width * 0.027))}px system-ui, sans-serif`
      ctx.fillText(`CKD $${prepared.ckd_usd.toFixed(2)} × ${prepared.multiplier}`, padding, priceY + Math.max(52, canvas.width * 0.055))
      ctx.textAlign = 'right'
      ctx.fillText('Dan’s Bizarre Bazaar', canvas.width - padding, priceY + Math.max(52, canvas.width * 0.055))
      ctx.textAlign = 'left'

      const blob = await canvasBlob(canvas)
      const snapshotResponse = await fetch(`/api/facebook-export/${libraryRow.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'commit', preparation_token: prepared.preparation_token }),
      })
      const snapshotData = await snapshotResponse.json().catch(() => ({}))
      if (snapshotResponse.status === 409) {
        const current = snapshotData.current
        if (current) {
          setMultiplier(current.multiplier)
          setQuote({ multiplier: current.multiplier, ckdUsd: current.ckd_usd, myrPrice: current.myr_price })
        }
        throw new Error(snapshotData.error || 'Sale-image inputs changed. Generate again.')
      }
      if (!snapshotResponse.ok) throw new Error(snapshotData.error || 'Could not remember generated image')

      if (result?.url) URL.revokeObjectURL(result.url)
      const safeName = cardName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'card'
      setResult({
        blob,
        url: URL.createObjectURL(blob),
        filename: `DBB-${safeName}-RM${prepared.myr_price.toFixed(2)}.jpg`,
        generationId: prepared.generation_id,
      })
      setRememberedAt(snapshotData.snapshot.generated_at)
      toast('Facebook sale image generated', 'success')
    } catch (error) {
      toast(error.message || 'Could not generate image', 'error')
    } finally {
      setGenerating(false)
    }
  }

  function save() {
    if (!result) return
    const link = document.createElement('a')
    link.href = result.url
    link.download = result.filename
    link.click()
  }

  async function share() {
    if (!result) return
    const file = new File([result.blob], result.filename, { type: 'image/jpeg' })
    if (!navigator.share || !navigator.canShare?.({ files: [file] })) return save()
    try {
      await navigator.share({ files: [file], title: libraryRow.card_index?.name || 'DBB sale image' })
    } catch (error) {
      if (error.name !== 'AbortError') toast('Could not open the share sheet', 'error')
    }
  }

  return (
    <section className="pt-3 border-t border-gray-200 dark:border-gray-700 space-y-3">
      <div>
        <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
          <ImageIcon className="w-3.5 h-3.5" /> Facebook Sale Image
        </p>
        <p className="text-xs text-gray-500 mt-1">Creates an offline share image. It does not list or reserve this card on DBB.</p>
      </div>

      <div className="flex gap-2">
        {MULTIPLIERS.map(value => (
          <button key={value} onClick={() => chooseMultiplier(value)} className={`flex-1 py-1.5 rounded border text-xs font-medium ${multiplier === value ? 'border-dbb-accent bg-dbb-accent/10 text-dbb-accent' : 'border-gray-200 dark:border-gray-700 text-gray-500'}`}>
            ×{value}{quote?.multiplier === value ? ` · RM ${quote.myrPrice.toFixed(2)}` : ''}
          </button>
        ))}
      </div>

      <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-xs">
        {referenceCkdUsd === undefined ? (
          <p className="text-gray-500">Loading price reference…</p>
        ) : referenceCkdUsd === null ? (
          <p className="text-gray-500">CKD price reference unavailable for this finish.</p>
        ) : (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-gray-500">CKD reference ${referenceCkdUsd.toFixed(2)}</span>
            <span className="font-semibold text-gray-700 dark:text-gray-300">Estimated RM {referenceMyr.toFixed(2)} at ×{multiplier}</span>
          </div>
        )}
        <p className="mt-1 text-[10px] text-gray-500">Reference only. Final price is verified by the server when you generate.</p>
      </div>

      {disabledReason && <p className="text-xs text-amber-500">{disabledReason}</p>}
      {!disabledReason && !quote && <p className="text-[11px] text-gray-500">Current CKD price and condition photo are verified when you generate.</p>}
      {quote && <p className="text-[11px] text-gray-500">CKD ${quote.ckdUsd.toFixed(2)} · server-verified for this image</p>}
      {rememberedAt && <p className="text-[11px] text-gray-500">Last generated {new Date(rememberedAt).toLocaleString()}</p>}

      <button onClick={generate} disabled={Boolean(disabledReason) || generating} className="w-full py-2 rounded-lg bg-dbb-accent hover:bg-red-600 text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
        {generating ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</> : 'Generate preview'}
      </button>

      {result && (
        <div className="space-y-2">
          <img src={result.url} alt="Facebook sale image preview" className="w-full rounded-lg border border-gray-200 dark:border-gray-700" />
          <p className="text-[11px] text-gray-500">Image generated. Cancelling Save or Share does not remove it; you can try again below.</p>
          <div className="flex gap-2">
            <button onClick={save} className="flex-1 py-2 border border-gray-300 dark:border-gray-700 rounded-lg text-sm flex items-center justify-center gap-2"><Download className="w-4 h-4" /> Save</button>
            <button onClick={share} className="flex-1 py-2 border border-gray-300 dark:border-gray-700 rounded-lg text-sm flex items-center justify-center gap-2"><Share2 className="w-4 h-4" /> Share</button>
          </div>
        </div>
      )}
    </section>
  )
}
