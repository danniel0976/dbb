import { NextResponse } from 'next/server'

// Force Node.js runtime
export const runtime = 'nodejs'

// Health check + Supabase keep-alive endpoint
// Called by Vercel cron every 5 days to prevent Supabase free tier pause (7-day idle timeout)

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json(
      { status: 'error', error: 'Missing Supabase env vars', timestamp: new Date().toISOString() },
      { status: 500 }
    )
  }

  try {
    // Ping Supabase with a lightweight count query
    const response = await fetch(
      `${supabaseUrl}/rest/v1/cards?select=id&limit=1`,
      {
        headers: {
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${supabaseAnonKey}`,
          'Accept': 'application/json',
        },
        // Don't cache — we want the actual DB hit for keep-alive
        cache: 'no-store',
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      return NextResponse.json(
        {
          status: 'error',
          error: `Supabase returned ${response.status}`,
          details: errorText.substring(0, 200),
          timestamp: new Date().toISOString(),
        },
        { status: response.status }
      )
    }

    // Parse the response — we just need to know it worked
    const data = await response.json()

    // Also get a total count
    const countResponse = await fetch(
      `${supabaseUrl}/rest/v1/cards?select=id&is_available=eq.true`,
      {
        headers: {
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${supabaseAnonKey}`,
          'Accept': 'application/json',
          'Prefer': 'count=exact',
        },
        cache: 'no-store',
      }
    )

    let cardCount = null
    if (countResponse.ok) {
      const countData = await countResponse.json()
      cardCount = Array.isArray(countData) ? countData.length : null
    }

    return NextResponse.json(
      {
        status: 'ok',
        cards: cardCount,
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      }
    )
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}