'use client'

import { useState, useRef, useCallback } from 'react'
import { Upload, FileText, CheckCircle, AlertCircle, ChevronDown, ChevronUp, Download, ArrowRight, RotateCcw } from 'lucide-react'
import Link from 'next/link'

const EXPECTED_HEADERS = [
  'Binder Name', 'Binder Type', 'Name', 'Set code', 'Set name', 'Collector number',
  'Foil', 'Rarity', 'Quantity', 'ManaBox ID', 'Scryfall ID', 'Purchase price',
  'Misprint', 'Altered', 'Condition', 'Language', 'Purchase price currency', 'Added',
]

function parseCSVPreview(text) {
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return { headers: [], rows: [], total: 0, headerMismatch: false }

  const headers = parseCSVLine(lines[0])
  const missingHeaders = EXPECTED_HEADERS.filter(h => !headers.includes(h))
  const rows = []
  for (let i = 1; i < Math.min(lines.length, 21); i++) {
    const vals = parseCSVLine(lines[i])
    const row = {}
    headers.forEach((h, idx) => { row[h] = vals[idx] || '' })
    rows.push(row)
  }
  return { headers, rows, total: lines.length - 1, headerMismatch: missingHeaders.length > 0, missingHeaders }
}

function parseCSVLine(line) {
  const result = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(cur.trim()); cur = ''
    } else {
      cur += ch
    }
  }
  result.push(cur.trim())
  return result
}

function downloadSkippedCSV(skipped) {
  const header = 'Line,Name,Set,Reason'
  const rows = skipped.map(s => `${s.line || ''},${JSON.stringify(s.name)},${JSON.stringify(s.set_code || '')},${JSON.stringify(s.reason)}`)
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'dbb-import-skipped.csv'
  a.click()
  URL.revokeObjectURL(url)
}

export default function ImportWizard() {
  const defaultBinderName = () => {
    const d = new Date()
    return `Import ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  const [step, setStep] = useState(1)
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [binderName, setBinderName] = useState(defaultBinderName)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [skippedOpen, setSkippedOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)

  const handleFile = useCallback((f) => {
    if (!f || !f.name.endsWith('.csv')) {
      setError('Please select a .csv file')
      return
    }
    setError(null)
    setFile(f)

    const reader = new FileReader()
    reader.onload = (e) => {
      const parsed = parseCSVPreview(e.target.result)
      setPreview(parsed)
    }
    reader.readAsText(f)
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    handleFile(f)
  }, [handleFile])

  const handleImport = async () => {
    if (!file) return
    setUploading(true)
    setError(null)

    const fd = new FormData()
    fd.append('file', file)
    fd.append('binderName', binderName.trim())

    try {
      const res = await fetch('/api/import/manabox', { method: 'POST', body: fd })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Import failed')
        setUploading(false)
        return
      }

      setResult(data)
      setStep(3)
    } catch {
      setError('Network error — please try again')
    } finally {
      setUploading(false)
    }
  }

  const reset = () => {
    setStep(1)
    setFile(null)
    setPreview(null)
    setBinderName(defaultBinderName())
    setResult(null)
    setError(null)
    setSkippedOpen(false)
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {[1, 2, 3].map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
              step === s ? 'bg-dbb-accent text-white' :
              step > s ? 'bg-green-600 text-white' :
              'bg-gray-700 text-gray-400'
            }`}>{step > s ? '✓' : s}</div>
            <span className={`text-sm hidden sm:inline ${step === s ? 'text-white' : 'text-gray-500'}`}>
              {['Upload', 'Destination', 'Results'][i]}
            </span>
            {i < 2 && <div className="w-8 h-px bg-gray-700 mx-1" />}
          </div>
        ))}
      </div>

      {/* Step 1: File drop */}
      {step === 1 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-bold text-white mb-1">Upload ManaBox Export</h2>
            <p className="text-gray-400 text-sm">Export your collection from ManaBox as CSV, then upload it here.</p>
          </div>

          <div
            className={`border-2 border-dashed rounded-xl p-10 text-center transition-colors cursor-pointer ${
              dragOver ? 'border-dbb-accent bg-dbb-accent/10' :
              file ? 'border-green-500 bg-green-500/5' :
              'border-gray-600 hover:border-gray-500 bg-gray-800/30'
            }`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={e => handleFile(e.target.files[0])}
            />
            {file ? (
              <div className="flex flex-col items-center gap-2">
                <FileText className="w-10 h-10 text-green-400" />
                <p className="text-white font-medium">{file.name}</p>
                <p className="text-gray-400 text-sm">{preview?.total?.toLocaleString()} rows found</p>
                <button
                  className="text-xs text-gray-500 hover:text-gray-300 underline mt-1"
                  onClick={e => { e.stopPropagation(); setFile(null); setPreview(null) }}
                >
                  Remove file
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Upload className="w-10 h-10 text-gray-500" />
                <p className="text-gray-300 font-medium">Drop your ManaBox CSV here</p>
                <p className="text-gray-500 text-sm">or click to browse</p>
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-400 text-sm bg-red-900/20 border border-red-800 rounded-lg px-4 py-3">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {preview?.headerMismatch && (
            <div className="bg-yellow-900/20 border border-yellow-700 rounded-lg px-4 py-3 text-sm text-yellow-300">
              <strong>Header mismatch:</strong> Missing columns: {preview.missingHeaders.join(', ')}. Import may have issues.
            </div>
          )}

          {/* Preview table */}
          {preview?.rows?.length > 0 && (
            <div>
              <p className="text-gray-400 text-xs mb-2">Preview — first {preview.rows.length} rows</p>
              <div className="overflow-x-auto rounded-lg border border-gray-700">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-800 text-gray-400">
                      {['Name', 'Set code', 'Quantity', 'Condition', 'Foil'].map(h => (
                        <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, i) => (
                      <tr key={i} className="border-t border-gray-800 hover:bg-gray-800/40">
                        <td className="px-3 py-2 text-gray-200 truncate max-w-[160px]">{row['Name']}</td>
                        <td className="px-3 py-2 text-gray-400">{row['Set code']}</td>
                        <td className="px-3 py-2 text-gray-400">{row['Quantity']}</td>
                        <td className="px-3 py-2 text-gray-400">{row['Condition']}</td>
                        <td className="px-3 py-2 text-gray-400">{row['Foil']}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <button
            disabled={!file || !preview}
            onClick={() => setStep(2)}
            className="w-full py-3 bg-dbb-accent hover:bg-dbb-accent/80 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
          >
            Next <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Step 2: Name binder */}
      {step === 2 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-bold text-white mb-1">Name Your Binder</h2>
            <p className="text-gray-400 text-sm">
              <span className="text-white">{file?.name}</span> · {preview?.total?.toLocaleString()} rows
            </p>
          </div>

          <div className="p-4 rounded-xl border border-dbb-accent/40 bg-dbb-accent/5">
            <label className="block text-sm font-medium text-gray-300 mb-2">Binder name</label>
            <input
              type="text"
              value={binderName}
              onChange={e => setBinderName(e.target.value)}
              className="w-full bg-dbb-primary border border-gray-600 focus:border-dbb-accent rounded-lg px-3 py-2 text-white placeholder-gray-500 text-sm outline-none transition-colors"
              maxLength={60}
              autoFocus
            />
            <p className="mt-3 text-xs text-gray-500">Each import creates a new binder. You can merge binders later.</p>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-400 text-sm bg-red-900/20 border border-red-800 rounded-lg px-4 py-3">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setStep(1)}
              className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-xl transition-colors"
            >
              Back
            </button>
            <button
              disabled={uploading || !binderName.trim()}
              onClick={handleImport}
              className="flex-[2] py-3 bg-dbb-accent hover:bg-dbb-accent/80 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {uploading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Uploading and processing...
                </>
              ) : (
                'Import'
              )}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Results */}
      {step === 3 && result && (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-8 h-8 text-green-400 flex-shrink-0" />
            <div>
              <h2 className="text-xl font-bold text-white">Import complete</h2>
              <p className="text-gray-400 text-sm">Imported into <span className="text-white">{result.binderName}</span></p>
            </div>
          </div>

          {/* Stat tiles */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-green-900/20 border border-green-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-green-400">{result.inserted.toLocaleString()}</p>
              <p className="text-xs text-green-300 mt-1">Cards added</p>
            </div>
            <div className="bg-blue-900/20 border border-blue-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-blue-400">{result.merged.toLocaleString()}</p>
              <p className="text-xs text-blue-300 mt-1">Quantities merged</p>
            </div>
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-gray-300">{result.skipped.length.toLocaleString()}</p>
              <p className="text-xs text-gray-400 mt-1">Skipped</p>
            </div>
          </div>

          {/* Skipped rows */}
          {result.skipped.length > 0 && (
            <div className="border border-gray-700 rounded-xl overflow-hidden">
              <button
                onClick={() => setSkippedOpen(o => !o)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-800 hover:bg-gray-700 transition-colors text-sm"
              >
                <span className="text-gray-300 font-medium">{result.skipped.length} skipped rows</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); downloadSkippedCSV(result.skipped) }}
                    className="flex items-center gap-1 text-xs text-gray-400 hover:text-white border border-gray-600 hover:border-gray-400 rounded px-2 py-1 transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    Download CSV
                  </button>
                  {skippedOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </div>
              </button>
              {skippedOpen && (
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-900">
                      <tr className="text-gray-500">
                        <th className="px-3 py-2 text-left">Line</th>
                        <th className="px-3 py-2 text-left">Name</th>
                        <th className="px-3 py-2 text-left">Set</th>
                        <th className="px-3 py-2 text-left">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.skipped.map((s, i) => (
                        <tr key={i} className="border-t border-gray-800">
                          <td className="px-3 py-2 text-gray-500">{s.line || '—'}</td>
                          <td className="px-3 py-2 text-gray-300 truncate max-w-[120px]">{s.name}</td>
                          <td className="px-3 py-2 text-gray-400">{s.set_code}</td>
                          <td className="px-3 py-2 text-red-400">{s.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={reset}
              className="flex items-center gap-2 px-4 py-3 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-xl transition-colors text-sm"
            >
              <RotateCcw className="w-4 h-4" />
              Import another
            </button>
            <Link
              href="/library"
              className="flex-1 py-3 bg-dbb-accent hover:bg-dbb-accent/80 text-white font-medium rounded-xl transition-colors text-center text-sm"
            >
              Go to Library →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
