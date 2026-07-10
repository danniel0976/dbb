import './globals.css'
import { Inter } from 'next/font/google'
import { ToastProvider } from '@/components/Toast'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: "MTG Bazaar",
  description: 'Magic: The Gathering Card Claim Sales',
  keywords: ['MTG', 'Magic The Gathering', 'cards', 'claim sales', 'Malaysia', 'CardKingdom'],
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  )
}
