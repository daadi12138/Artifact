import { readRunReview } from '@/run-review'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  try {
    const path = new URL(request.url).searchParams.get('path') ?? undefined
    return Response.json(await readRunReview(id, path), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '无法读取变更' }, { status: 400 })
  }
}
