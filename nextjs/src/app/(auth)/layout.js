export default function AuthLayout({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-dbb-accent font-display">DBB</h1>
          <p className="text-gray-400 text-sm mt-1">{"Dan's Bizarre Bazaar"}</p>
        </div>
        <div className="bg-dbb-secondary border border-dbb-tertiary/50 rounded-dbb p-8 shadow-2xl">
          {children}
        </div>
      </div>
    </div>
  )
}
