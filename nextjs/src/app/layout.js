import './globals.css'
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: "Dan's Bizarre Bazaar",
  description: 'MTG Card Claim Sales - Facebook Group',
  keywords: ['MTG', 'Magic The Gathering', 'cards', 'claim sales', 'Malaysia'],
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  )
}
