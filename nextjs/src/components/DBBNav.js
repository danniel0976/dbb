'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect } from 'react'

const NAV_LINKS = [
  { href: '/library', label: 'Library' },
  { href: '/bazaar', label: 'Bazaar' },
  { href: '/import', label: 'Import' },
  { href: '/profile', label: 'Profile' },
]

function CartBadge() {
  const [count, setCount] = useState(null)

  useEffect(() => {
    fetch('/api/cart/count')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.count > 0) setCount(data.count) })
      .catch(() => {})
  }, [])

  if (!count) return null
  return (
    <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] text-[10px] font-bold bg-dbb-accent text-white rounded-full px-1">
      {count > 99 ? '99+' : count}
    </span>
  )
}

export default function DBBNav({ userEmail, extra }) {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-40 bg-dbb-primary/95 backdrop-blur border-b border-dbb-accent/20">
      <div className="container mx-auto px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="text-xl font-bold text-dbb-accent">Dan's Bizarre Bazaar</span>
          <nav className="hidden sm:flex items-center gap-3 text-sm text-gray-400">
            {NAV_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={
                  pathname?.startsWith(href)
                    ? 'text-white font-medium'
                    : 'hover:text-white transition-colors'
                }
              >
                {label}
              </Link>
            ))}
            {userEmail && (
              <Link
                href="/cart"
                className={`flex items-center ${
                  pathname?.startsWith('/cart')
                    ? 'text-white font-medium'
                    : 'hover:text-white transition-colors'
                }`}
              >
                Cart
                <CartBadge />
              </Link>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {extra}
          {userEmail ? (
            <>
              <span className="text-xs text-gray-500 hidden sm:inline">{userEmail}</span>
              <form action="/api/auth/signout" method="POST">
                <button
                  type="submit"
                  className="text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-1.5 transition-colors"
                >
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link
              href="/login"
              className="text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-1.5 transition-colors"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  )
}
