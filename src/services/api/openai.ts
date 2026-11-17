import type { CreateMessageRequest, MessageStreamEvent } from './types.js'
import { useSettings } from '../settings.js'
import * as db from '../chat/db.js'
import { readServerSentEvents } from './sse.js'

type InputPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; data: string }
  | { kind: 'file'; filename: string; data: string; pdf: boolean }
type InputMessage = {
  role: 'system' | 'assistant' | 'user'
  parts: InputPart[]
}
type Mode = 'chat' | 'responses'

const TEXT_EXTS = new Set([
  'txt', 'text', 'md', 'markdown', 'json', 'jsonl', 'ndjson', 'json5',
  'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'py', 'java', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb',
  'php', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'swift', 'kt', 'lua',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'csv', 'tsv',
  'log', 'diff', 'patch', 'srt', 'vtt', 'tex', 'gradle', 'gitignore',
])

const extensionOf = (filename: string): string =>
  filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : ''

const isText = (filename: string, mime: string) =>
  mime.startsWith('text/') ||
  TEXT_EXTS.has(extensionOf(filename)) ||
  ['application/json', 'application/xml', 'application/x-yaml', 'application/yaml',
   'application/javascript', 'application/typescript'].includes(mime)

const asDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Unable to read attachment as base64'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('File reading failed'))
    reader.readAsDataURL(blob)
  })

/** Always resolve the local original; a file_id from another provider must never be reused. */
const localPart = async (
  fileId: string,
  filename: string,
  isImage: boolean
): Promise<InputPart> => {
  if (!fileId.startsWith('local:')) {
    throw new Error('Attachment does not have a local reference; please upload it again')
  }
  const blob = await db.loadFile(fileId.slice('local:'.length))
  if (!blob) {
    throw new Error('The original file ' + filename + ' is missing locally. Please upload it again.')
  }
  const name = filename || (blob instanceof File ? blob.name : '') || 'attachment'
  const mime = blob.type.toLowerCase()
  if (isImage) {
    return { kind: 'image', data: await asDataUrl(blob) }
  }
  if (isText(name, mime)) {
    return {
      kind: 'text',
      text: '[Attached file: ' + name + ']\n' + await blob.text() + '\n[End of file: ' + name + ']',
    }
  }
  const pdf = mime === 'application/pdf' || extensionOf(name) === 'pdf'
  return { kind: 'file', filename: name, data: await asDataUrl(blob), pdf }
}

const prepare = async (body: CreateMessageRequest): Promise<InputMessage[]> => {
  const messages: InputMessage[] = [
    { role: 'system', parts: [{ kind: 'text', text: body.system }] },
  ]
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      messages.push({ role: 'system', parts: [{ kind: 'text', text: message.content }] })
    } else if (message.role === 'assistant') {
      const text = message.content
        .filter(block => block.type === 'text')
        .map(block => block.type === 'text' ? block.text : '')
        .filter(Boolean)
        .join('\n\n')
      if (text) messages.push({ role: 'assistant', parts: [{ kind: 'text', text }] })
    } else {
      const parts: InputPart[] = []
      if (typeof message.content === 'string') {
        parts.push({ kind: 'text', text: message.content })
      } else {
        for (const block of message.content) {
          if (block.type === 'text') {
            parts.push({ kind: 'text', text: block.text })
          } else {
            parts.push(await localPart(
              block.source.file_id,
              block.filename ?? '',
              block.type === 'image'
            ))
          }
        }
      }
      messages.push({ role: 'user', parts })
    }
  }
  return messages
}

/** Chat Completions accepts inline text/image and (on supporting providers) PDFs. */
const chatMessages = (messages: InputMessage[]) =>
  messages.map(message => {
    const textOnly = message.parts.every(part => part.kind === 'text')
    return {
      role: message.role,
      content: textOnly
        ? message.parts.map(part => part.kind === 'text' ? part.text : '').join('\n')
        : message.parts.map(part => {
            if (part.kind === 'text') return { type: 'text', text: part.text }
            if (part.kind === 'image') {
              return { type: 'image_url', image_url: { url: part.data } }
            }
            return { type: 'file', file: { filename: part.filename, file_data: part.data } }
          }),
    }
  })

/** Responses API supports a broader set of rich documents and spreadsheets. */
const responseInput = (messages: InputMessage[]) =>
  messages.map(message =>
    message.role !== 'user'
      ? {
          role: message.role,
          content: message.parts.map(part => part.kind === 'text' ? part.text : '').join('\n'),
        }
      : {
          role: 'user',
          content: message.parts.map(part => {
            if (part.kind === 'text') return { type: 'input_text', text: part.text }
            if (part.kind === 'image') return { type: 'input_image', image_url: part.data }
            return { type: 'input_file', filename: part.filename, file_data: part.data }
          }),
        }
  )

const mayTryOtherEndpoint = (status: number, detail: string) =>
  [404, 405, 415, 422, 501].includes(status) ||
  (status === 400 && /unsupported|not supported|unknown (?:field|parameter|type)|invalid (?:content|input|type)|not implemented|file input/i.test(detail))

type JsonError = { error?: { message?: string }; message?: string }
const explain = (status: number, details: string) => {
  let message = details
  try {
    const json = JSON.parse(details) as JsonError
    message = json.error?.message || json.message || details
  } catch {
    // Preserve the raw provider error when it is not JSON.
  }
  return 'Provider HTTP ' + status + ': ' + message.slice(0, 900)
}

/**
 * Adapt files based on format and supported endpoint, not on model name guesses.
 * Failover is performed ONLY after an HTTP rejection, before generation begins.
 */
export async function* streamOpenAIMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const messages = await prepare(body)
  const allParts = messages.flatMap(message => message.parts)
  // Include text/code attachments too: they are inlined as text but still come from files.
  const hasFiles = body.messages.some(
    message => message.role === 'user' &&
      typeof message.content !== 'string' &&
      message.content.some(block => block.type === 'image' || block.type === 'document')
  )
  const needsResponses = allParts.some(part => part.kind === 'file' && !part.pdf)
  const baseUrl = useSettings.getState().apiBaseUrl
  const headers = {
    Authorization: 'Bearer ' + apiKey,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  const send = (mode: Mode) =>
    fetch(baseUrl + (mode === 'chat' ? '/chat/completions' : '/responses'), {
      method: 'POST',
      headers,
      body: JSON.stringify(
        mode === 'chat'
          ? { model: body.model, messages: chatMessages(messages), stream: true }
          : { model: body.model, input: responseInput(messages), stream: true }
      ),
      signal,
    })

  let mode: Mode = needsResponses ? 'responses' : 'chat'
  let response = await send(mode)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    if (hasFiles && mayTryOtherEndpoint(response.status, detail)) {
      mode = mode === 'chat' ? 'responses' : 'chat'
      response = await send(mode)
    } else {
      throw new Error(explain(response.status, detail))
    }
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(explain(response.status, detail) + ' (provider file input not supported by either compatible endpoint)')
  }
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
    throw new Error('Provider did not return the expected event stream')
  }

  yield { type: 'message_start', message: { id: '', model: body.model } }

  let nextIndex = 0
  let active: { index: number; kind: 'text' | 'thinking' } | null = null
  let completed = false
  let stopReason: 'end_turn' | 'max_tokens' = 'end_turn'
  let usage: MessageStreamEvent & { type: 'message_delta' } | undefined

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
    if (data.trim() === '[DONE]') {
      completed = true
      break
    }
    let value: unknown
    try { value = JSON.parse(data) } catch { continue }
    if (!value || typeof value !== 'object') continue
    const evt = value as {
      type?: string
      message?: string
      error?: { message?: string }
      delta?: string
      response?: {
        status?: string
        error?: { message?: string }
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      choices?: {
        delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }
        finish_reason?: string | null
      }[]
    }

    if (mode === 'chat') {
      if (evt.error) throw new Error(evt.error.message || 'Provider streaming error')
      const choice = evt.choices?.[0]
      if (choice?.finish_reason) {
        completed = true
        if (choice.finish_reason === 'length') stopReason = 'max_tokens'
      }
      const delta = choice?.delta
      if (delta) {
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string') yield* append('thinking', reasoning)
        if (typeof delta.content === 'string') yield* append('text', delta.content)
      }
    } else {
      if (evt.type === 'error' || evt.type === 'response.failed') {
        throw new Error(evt.error?.message || evt.response?.error?.message || evt.message || 'Provider Responses API error')
      }
      if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
        yield* append('text', evt.delta)
      }
      if ((evt.type === 'response.reasoning_summary_text.delta' ||
           evt.type === 'response.reasoning_text.delta') && typeof evt.delta === 'string') {
        yield* append('thinking', evt.delta)
      }
      if (evt.type === 'response.completed' || evt.type === 'response.incomplete') {
        completed = true
        if (evt.type === 'response.incomplete') stopReason = 'max_tokens'
        const u = evt.response?.usage
        if (u) {
          usage = {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: {
              input_tokens: u.input_tokens ?? 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: u.output_tokens ?? 0,
            },
          }
        }
      }
    }
  }
  if (active) yield { type: 'content_block_stop', index: active.index }
  if (!completed) throw new Error('Provider stream ended before completing')
  yield usage ?? { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null } }
  yield { type: 'message_stop' }
}
