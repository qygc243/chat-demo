import type { CreateMessageRequest, MessageStreamEvent } from './types.js'
import { useSettings } from '../settings.js'
import { readServerSentEvents } from './sse.js'

/**
 * OpenAI-compatible Chat Completions streaming adapter.
 * Supports text and commonly used reasoning_content/reasoning deltas.
 * Provider-specific tools, Files API, and speech are not supported by this adapter.
 */
export async function* streamOpenAIMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const baseUrl = useSettings.getState().apiBaseUrl
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: body.system },
  ]
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      messages.push({ role: 'system', content: message.content })
    } else if (message.role === 'user') {
      if (typeof message.content === 'string') {
        messages.push({ role: 'user', content: message.content })
      } else {
        if (message.content.some(block => block.type !== 'text')) {
          throw new Error('此提供商暂不支持 DeepSeek 文件附件，请在新对话中使用纯文本。')
        }
        messages.push({
          role: 'user',
          content: message.content.map(block => block.type === 'text' ? block.text : '').join(''),
        })
      }
    } else {
      messages.push({
        role: 'assistant',
        content: message.content.map(block => block.type === 'text' ? block.text : '').filter(Boolean).join('\n'),
      })
    }
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ model: body.model, messages, stream: true }),
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Chat Completions HTTP ${response.status}: ${detail.slice(0, 400)}`)
  }
  if (!response.body) throw new Error('Server did not return a response stream')

  yield { type: 'message_start', message: { id: '', model: body.model } }

  let nextIndex = 0
  let active: { index: number; kind: 'text' | 'thinking' } | null = null
  let finished = false
  let stopReason: 'end_turn' | 'max_tokens' = 'end_turn'

  async function* append(kind: 'text' | 'thinking', chunk: string): AsyncGenerator<MessageStreamEvent> {
    if (!chunk) return
    if (active?.kind !== kind) {
      if (active) yield { type: 'content_block_stop', index: active.index }
      const index = nextIndex++
      active = { kind, index }
      if (kind === 'text') {
        yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }
      } else {
        yield { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }
      }
    }
    if (!active) return
    if (kind === 'text') {
      yield { type: 'content_block_delta', index: active.index, delta: { type: 'text_delta', text: chunk } }
    } else {
      yield { type: 'content_block_delta', index: active.index, delta: { type: 'thinking_delta', thinking: chunk } }
    }
  }

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    if (data.trim() === '[DONE]') { finished = true; break }
    let payload: unknown
    try { payload = JSON.parse(data) } catch { continue }
    if (!payload || typeof payload !== 'object') continue
    const evt = payload as {
      error?: { message?: string }
      choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }; finish_reason?: string | null }[]
    }
    if (evt.error) throw new Error(evt.error.message || 'Provider returned a streaming error')
    const choice = evt.choices?.[0]
    if (choice?.finish_reason) {
      finished = true
      if (choice.finish_reason === 'length') stopReason = 'max_tokens'
    }
    const delta = choice?.delta
    if (!delta) continue
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string') yield* append('thinking', reasoning)
    if (typeof delta.content === 'string') yield* append('text', delta.content)
  }
  if (active) yield { type: 'content_block_stop', index: active.index }
  if (!finished) throw new Error('Provider closed the stream without a completion event')
  yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null } }
  yield { type: 'message_stop' }
}
