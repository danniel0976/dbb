import { NextResponse } from 'next/server'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const set = searchParams.get('set')
  const collectorNumber = searchParams.get('cn')

  if (!set || !collectorNumber) {
    return NextResponse.json(
      { error: 'Missing set or collector_number parameter' },
      { status: 400 }
    )
  }

  try {
    const response = await fetch(
      `https://api.scryfall.com/cards/search?q=set:${set}+cn:${collectorNumber}`,
      {
        headers: {
          'User-Agent': 'DansBizarreBazaar/1.0',
        },
        next: { revalidate: 86400 } // Cache for 24 hours
      }
    )

    if (!response.ok) {
      if (response.status === 429) {
        return NextResponse.json(
          { error: 'Rate limited by Scryfall' },
          { status: 429 }
        )
      }
      return NextResponse.json(
        { error: 'Card not found' },
        { status: 404 }
      )
    }

    const data = await response.json()
    
    if (data.data && data.data.length > 0) {
      const card = data.data[0]
      let images = {}
      
      // Priority 1: Top-level image_uris (for DFCs and most cards)
      if (card.image_uris) {
        images = {
          // Use "normal" size - good balance of quality and speed, shows full card
          image_crop_url: card.image_uris.normal,
          image_png_url: card.image_uris.png,
        }
      }
      // Priority 2: First card_face (for some special cases)
      else if (card.card_faces && card.card_faces.length > 0 && card.card_faces[0].image_uris) {
        const face = card.card_faces[0]
        images = {
          image_crop_url: face.image_uris.normal,
          image_png_url: face.image_uris.png,
        }
      }
      
      if (images.image_crop_url) {
        return NextResponse.json(images)
      }
    }

    return NextResponse.json(
      { error: 'No image found' },
      { status: 404 }
    )
  } catch (error) {
    console.error('Scryfall proxy error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch from Scryfall' },
      { status: 500 }
    )
  }
}
