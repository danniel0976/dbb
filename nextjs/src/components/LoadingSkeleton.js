'use client'

export default function LoadingSkeleton({ count = 12 }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="bg-dbb-secondary rounded-lg overflow-hidden border-2 border-gray-700"
        >
          {/* Image Placeholder */}
          <div className="aspect-[2/3] skeleton" />
          
          {/* Content Placeholder */}
          <div className="p-3 space-y-2">
            {/* Name */}
            <div className="h-4 skeleton rounded w-3/4" />
            
            {/* Set and Number */}
            <div className="flex justify-between">
              <div className="h-3 skeleton rounded w-12" />
              <div className="h-3 skeleton rounded w-16" />
            </div>
            
            {/* Price */}
            <div className="pt-2 border-t border-gray-700 space-y-2">
              <div className="flex justify-between">
                <div className="h-3 skeleton rounded w-8" />
                <div className="h-3 skeleton rounded w-12" />
              </div>
              <div className="h-5 skeleton rounded w-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
