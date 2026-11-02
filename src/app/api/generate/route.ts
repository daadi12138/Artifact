export const runtime = 'nodejs'

const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash-lite'

type GeminiPart = { text?: string }
type GeminiContent = { parts?: GeminiPart[] }
type GeminiResponse = { candidates?: Array<{ content?: GeminiContent }> }

const systemInstruction = [
  'You are an infinite spatial-knowledge-engine generator.',
  "Respond to the user's query with JSON containing 'text' and 'prompts'.",
  "'text' is a concise, informative markdown explanation of the topic.",
  'CRITICAL: wrap 2 to 4 key concepts or interesting terms in the text as markdown links using the exact format `[Search Term](Search Term)`, so users can click them to explore further.',
  "'prompts' is an array of exactly three useful follow-up questions or sub-topics.",
].join(' ')

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'GEMINI_API_KEY is not configured. Add it to .env.local and restart the server.' }, { status: 503 })
  }

  let prompt = ''
  try {
    const body = await request.json() as { prompt?: unknown }
    prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  } catch {
    return Response.json({ error: 'Invalid JSON request.' }, { status: 400 })
  }

  if (!prompt) return Response.json({ error: 'Prompt is required.' }, { status: 400 })
  if (prompt.length > 2000) return Response.json({ error: 'Prompt must be 2000 characters or fewer.' }, { status: 400 })

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(TEXT_MODEL)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              text: { type: 'STRING' },
              prompts: { type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: ['text', 'prompts'],
          },
        },
      }),
    })

    if (!response.ok) {
      const detail = await response.text()
      console.error('Gemini text generation failed:', response.status, detail)
      return Response.json({ error: `Gemini text generation failed (${response.status}).` }, { status: 502 })
    }

    const data = await response.json() as GeminiResponse
    const rawText = data.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') ?? ''
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    const parsed = JSON.parse(cleaned || '{}') as { text?: unknown; prompts?: unknown }
    const text = typeof parsed.text === 'string' ? parsed.text : ''
    const prompts = Array.isArray(parsed.prompts)
      ? parsed.prompts.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 3)
      : []

    if (!text) return Response.json({ error: 'Gemini returned no usable text.' }, { status: 502 })
    return Response.json({ text, prompts })
  } catch (error) {
    console.error('Text generation error:', error)
    return Response.json({ error: 'Failed to generate text content.' }, { status: 500 })
  }
}
