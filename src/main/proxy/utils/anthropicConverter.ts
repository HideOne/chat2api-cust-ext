/**
 * Anthropic Messages API Converter
 * Converts between Anthropic Messages API and OpenAI Chat Completions API formats
 */

import { Transform } from 'stream'
import { ChatCompletionRequest, ChatMessage, ChatCompletionTool, ToolCall } from '../types'
import { SSEParser } from '../stream'

// ─── Request Conversion: Anthropic → OpenAI ───

/**
 * Convert Anthropic Messages API request to OpenAI Chat Completions request
 */
export function convertAnthropicToOpenAI(anthropicRequest: any): ChatCompletionRequest {
  const messages: ChatMessage[] = []

  // Convert system prompt
  if (anthropicRequest.system) {
    const systemContent = typeof anthropicRequest.system === 'string'
      ? anthropicRequest.system
      : Array.isArray(anthropicRequest.system)
        ? anthropicRequest.system
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('\n')
        : ''
    if (systemContent) {
      messages.push({ role: 'system', content: systemContent })
    }
  }

  // Convert messages
  if (Array.isArray(anthropicRequest.messages)) {
    for (const msg of anthropicRequest.messages) {
      const converted = convertAnthropicMessage(msg)
      messages.push(...converted)
    }
  }

  // Convert tools
  let tools: ChatCompletionTool[] | undefined
  if (Array.isArray(anthropicRequest.tools) && anthropicRequest.tools.length > 0) {
    tools = anthropicRequest.tools.map((tool: any) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }))
  }

  // Convert tool_choice
  let toolChoice: ChatCompletionRequest['tool_choice']
  if (anthropicRequest.tool_choice) {
    const tc = anthropicRequest.tool_choice
    if (typeof tc === 'object') {
      switch (tc.type) {
        case 'auto':
          toolChoice = 'auto'
          break
        case 'any':
          toolChoice = 'required'
          break
        case 'tool':
          toolChoice = { type: 'function', function: { name: tc.name } }
          break
        case 'none':
          toolChoice = 'none'
          break
      }
    }
  }

  return {
    model: anthropicRequest.model,
    messages,
    stream: anthropicRequest.stream || false,
    max_tokens: anthropicRequest.max_tokens,
    temperature: anthropicRequest.temperature,
    top_p: anthropicRequest.top_p,
    stop: anthropicRequest.stop_sequences,
    tools,
    tool_choice: toolChoice,
    tool_format: 'native',
    user: anthropicRequest.metadata?.user_id,
  }
}

/**
 * Convert a single Anthropic message to one or more OpenAI messages
 */
function convertAnthropicMessage(msg: any): ChatMessage[] {
  const results: ChatMessage[] = []
  const content = msg.content

  if (typeof content === 'string' || content === null || content === undefined) {
    results.push({
      role: msg.role,
      content: content || '',
    })
    return results
  }

  if (!Array.isArray(content)) {
    results.push({ role: msg.role, content: String(content) })
    return results
  }

  if (msg.role === 'assistant') {
    // Assistant messages: extract text and tool_use blocks
    const textParts: string[] = []
    const toolUses: any[] = []

    for (const block of content) {
      if (block.type === 'text') {
        textParts.push(block.text || '')
      } else if (block.type === 'tool_use') {
        toolUses.push(block)
      } else if (block.type === 'thinking') {
        // Skip thinking blocks - not supported in OpenAI format
      }
    }

    const openaiMsg: ChatMessage = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('') : (toolUses.length > 0 ? null : ''),
    }

    if (toolUses.length > 0) {
      openaiMsg.tool_calls = toolUses.map((tu: any, index: number) => ({
        index,
        id: tu.id,
        type: 'function' as const,
        function: {
          name: tu.name,
          arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}),
        },
      }))
    }

    results.push(openaiMsg)
  } else if (msg.role === 'user') {
    // User messages: separate text content from tool_result blocks
    const textParts: string[] = []
    const imageParts: any[] = []
    const toolResults: any[] = []

    for (const block of content) {
      if (block.type === 'text') {
        textParts.push(block.text || '')
      } else if (block.type === 'image') {
        imageParts.push(block)
      } else if (block.type === 'tool_result') {
        toolResults.push(block)
      }
    }

    // Emit tool results as separate tool role messages
    for (const tr of toolResults) {
      const resultContent = typeof tr.content === 'string'
        ? tr.content
        : Array.isArray(tr.content)
          ? tr.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('')
          : JSON.stringify(tr.content)
      results.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: resultContent,
      })
    }

    // Emit remaining user content
    const userContent: any[] = []
    for (const text of textParts) {
      userContent.push({ type: 'text', text })
    }
    for (const img of imageParts) {
      if (img.source?.type === 'base64') {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:${img.source.media_type};base64,${img.source.data}`,
          },
        })
      }
    }

    if (userContent.length > 0) {
      results.push({
        role: 'user',
        content: userContent.length === 1 && userContent[0].type === 'text'
          ? userContent[0].text
          : userContent,
      })
    }
  } else {
    // Fallback: stringify content
    const text = content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('')
    results.push({ role: msg.role, content: text })
  }

  return results
}

// ─── Response Conversion: OpenAI → Anthropic ───

/**
 * Convert OpenAI Chat Completions response to Anthropic Messages API response
 */
export function convertOpenAIToAnthropic(openaiResponse: any, requestedModel: string): any {
  const choice = openaiResponse.choices?.[0]
  if (!choice) {
    return createAnthropicErrorResponse('invalid_request_error', 'No response choices')
  }

  const message = choice.message || choice.delta || {}
  const content: any[] = []

  // Text content
  if (message.content) {
    content.push({ type: 'text', text: message.content })
  }

  // Tool calls
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input: any = {}
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        input = {}
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  // If no content blocks, add empty text
  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  const stopReason = mapStopReason(choice.finish_reason)

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: requestedModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  }
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason
 */
function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case 'stop':
    case 'end_turn':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return 'end_turn'
  }
}

/**
 * Generate Anthropic-style message ID
 */
function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Create Anthropic error response
 */
export function createAnthropicErrorResponse(type: string, message: string): any {
  return {
    type: 'error',
    error: { type, message },
  }
}

// ─── Streaming: OpenAI SSE → Anthropic SSE ───

/**
 * Anthropic Stream Transformer
 * Converts OpenAI Chat Completions SSE stream to Anthropic Messages SSE stream
 */
export class AnthropicStreamTransformer extends Transform {
  private parser = new SSEParser()
  private messageStarted = false
  private currentBlockIndex = -1
  private currentBlockType: 'text' | 'tool_use' | null = null
  private messageId = generateMessageId()
  private requestedModel: string
  private inputTokens = 0
  private outputTokens = 0
  private hasContent = false

  constructor(requestedModel: string) {
    super({ objectMode: true })
    this.requestedModel = requestedModel
  }

  _transform(chunk: Buffer, encoding: string, callback: () => void): void {
    try {
      const events = this.parser.parse(chunk.toString())

      for (const event of events) {
        if (event.data === '[DONE]') {
          this.emitDone()
          continue
        }

        let data: any
        try {
          data = JSON.parse(event.data)
        } catch {
          continue
        }

        this.processChunk(data)
      }

      callback()
    } catch (error) {
      callback()
    }
  }

  private processChunk(data: any): void {
    const choice = data.choices?.[0]
    if (!choice) return

    const delta = choice.delta || choice.message || {}
    const finishReason = choice.finish_reason

    // Start message on first content
    if (!this.messageStarted) {
      if (delta.content || delta.tool_calls || delta.role) {
        this.emitMessageStart()
        this.messageStarted = true
      }
    }

    // Handle text content
    if (delta.content) {
      this.hasContent = true
      if (this.currentBlockType !== 'text') {
        // Close previous block if any
        this.closeCurrentBlock()
        // Start new text block
        this.currentBlockIndex++
        this.currentBlockType = 'text'
        this.push(this.formatSSE('content_block_start', {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: { type: 'text', text: '' },
        }))
      }
      this.push(this.formatSSE('content_block_delta', {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: { type: 'text_delta', text: delta.content },
      }))
    }

    // Handle tool calls
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0

        // Check if this is a new tool call (has id and name)
        if (tc.id || tc.function?.name) {
          // Close previous block if any
          this.closeCurrentBlock()

          // Start new tool_use block
          this.currentBlockIndex++
          this.currentBlockType = 'tool_use'
          this.hasContent = true
          this.push(this.formatSSE('content_block_start', {
            type: 'content_block_start',
            index: this.currentBlockIndex,
            content_block: {
              type: 'tool_use',
              id: tc.id || `toolu_${Date.now().toString(36)}`,
              name: tc.function?.name || '',
              input: {},
            },
          }))
        }

        // Emit argument fragments
        if (tc.function?.arguments) {
          this.push(this.formatSSE('content_block_delta', {
            type: 'content_block_delta',
            index: this.currentBlockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            },
          }))
        }
      }
    }

    // Handle finish reason
    if (finishReason) {
      this.closeCurrentBlock()

      const stopReason = mapStopReason(finishReason)
      this.push(this.formatSSE('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: this.outputTokens || 1 },
      }))

      this.push(this.formatSSE('message_stop', {
        type: 'message_stop',
      }))
    }
  }

  private emitMessageStart(): void {
    this.push(this.formatSSE('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.requestedModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    }))
  }

  private closeCurrentBlock(): void {
    if (this.currentBlockType !== null) {
      this.push(this.formatSSE('content_block_stop', {
        type: 'content_block_stop',
        index: this.currentBlockIndex,
      }))
      this.currentBlockType = null
    }
  }

  private emitDone(): void {
    // If message was never started (no content at all), emit minimal response
    if (!this.messageStarted) {
      this.emitMessageStart()
      this.messageStarted = true
      this.currentBlockIndex++
      this.currentBlockType = 'text'
      this.push(this.formatSSE('content_block_start', {
        type: 'content_block_start',
        index: this.currentBlockIndex,
        content_block: { type: 'text', text: '' },
      }))
    }

    // Close any remaining block
    this.closeCurrentBlock()

    // If no finish_reason was emitted, emit one now
    if (this.hasContent) {
      this.push(this.formatSSE('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: this.outputTokens || 1 },
      }))

      this.push(this.formatSSE('message_stop', {
        type: 'message_stop',
      }))
    }
  }

  private formatSSE(event: string, data: any): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  }
}
