export const runtime = 'nodejs'

const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-lite-image'

type GeminiPart = {
  text?: string
  inlineData?: { mimeType?: string; data?: string }
  inline_data?: { mime_type?: string; data?: string }
}
type GeminiContent = { parts?: GeminiPart[] }
type GeminiResponse = { candidates?: Array<{ content?: GeminiContent }> }

const imageStyle =
  'Strictly black and white editorial style photography. Single subject. No text inside the image. ' +
  'No grid format, no multiple panels, just one single cohesive image. High-resolution, cinematic lighting. ' +
  'For abstract or scientific concepts (like physics or chemistry), do not depict people unless specifically requested. '

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'GEMINI_API_KEY is not configured. Add it to .env.local and restart the server.' }, { status: 503 })
  }

  let prompt = ''
  let imageBase64 = ''
  try {
    const body = await request.json() as { prompt?: unknown; imageBase64?: unknown }
    prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : ''
  } catch {
    return Response.json({ error: 'Invalid JSON request.' }, { status: 400 })
  }

  if (!prompt) return Response.json({ error: 'Prompt is required.' }, { status: 400 })
  if (prompt.length > 2000) return Response.json({ error: 'Prompt must be 2000 characters or fewer.' }, { status: 400 })

  const parts: GeminiPart[] = [{ text: imageStyle + prompt }]
  const match = imageBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/)
  if (match) parts.unshift({ inlineData: { mimeType: match[1], data: match[2] } })

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(IMAGE_MODEL)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: '4:3' },
        },
      }),
    })

    if (!response.ok) {
      const detail = await response.text()
      console.error('Gemini image generation failed:', response.status, detail)
      return Response.json({ error: `Gemini image generation failed (${response.status}).` }, { status: 502 })
    }

    const data = await response.json() as GeminiResponse
    for (const part of data.candidates?.[0]?.content?.parts ?? []) {
      const inline = part.inlineData ?? part.inline_data
      const mimeType = part.inlineData?.mimeType ?? part.inline_data?.mime_type ?? 'image/jpeg'
      const base64 = part.inlineData?.data ?? part.inline_data?.data
      if (inline && base64) return Response.json({ imageUrl: `data:${mimeType};base64,${base64}` })
    }

    return Response.json({ error: 'No image generated.' }, { status: 502 })
  } catch (error) {
    console.error('Image generation error:', error)
    return Response.json({ error: 'Failed to generate image.' }, { status: 500 })
  }
}
