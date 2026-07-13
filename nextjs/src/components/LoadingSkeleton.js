'use client'

export default function LoadingSkeleton({ count = 12 }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="bg-white dark:bg-dbb-secondary rounded-dbb overflow-hidden border border-gray-200 dark:border-dbb-tertiary/30"
        >
          {/* Card image placeholder — TCG card silhouette */}
          <div className="aspect-[2/3] card-skeleton" />
          
          {/* Content placeholder */}
          <div className="p-2.5 space-y-1.5">
            {/* Name */}
            <div className="h-4 skeleton rounded w-3/4" />
            
            {/* Set and rarity */}
            <div className="flex justify-between">
              <div className="h-3 skeleton rounded w-8" />
              <div className="h-3 skeleton rounded w-12" />
            </div>
            
            {/* Condition + seller */}
            <div className="h-3 skeleton rounded w-2/3" />
            
            {/* Price */}
            <div className="pt-2 border-t border-gray-200 dark:border-dbb-tertiary/30">
              <div className="h-4 skeleton rounded w-16" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}