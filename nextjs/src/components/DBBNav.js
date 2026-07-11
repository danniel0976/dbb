'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_LINKS = [
  { href: '/library', label: 'Library' },
  { href: '/binders', label: 'Binders' },
  { href: '/bazaar', label: 'Bazaar' },
  { href: '/import', label: 'Import' },
  { href: '/profile', label: 'Profile' },
]

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
