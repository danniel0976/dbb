import LoadingSkeleton from '@/components/LoadingSkeleton'

export default function BazaarLoading() {
  return <main className="container mx-auto px-4 py-6"><LoadingSkeleton count={12} /></main>
}
