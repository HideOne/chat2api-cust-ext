/**
 * GLM Adapter
 * Implements GLM (Zhipu Qingyan) web API protocol
 */

import axios, { AxiosResponse } from 'axios'
import crypto from 'crypto'
import { Account, Provider } from '../../store/types'
import { storeManager } from '../../store/store'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import FormData from 'form-data'
import mime from 'mime-types'
import path from 'path'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'

const GLM_API_BASE = 'https://chatglm.cn/chatglm'
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796'
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'
const ACCESS_TOKEN_EXPIRES = 3600
const FILE_MAX_SIZE = 100 * 1024 * 1024 // 100MB

const FAKE_HEADERS = {
  Accept: 'text/event-stream',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'App-Name': 'chatglm',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
  Origin: 'https://chatglm.cn',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-App-Fr': 'browser_extension',
  'X-App-Platform': 'pc',
  'X-App-Version': '0.0.1',
  'X-Device-Brand': '',
  'X-Device-Model': '',
  'X-Lang': 'zh',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface GLMMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface GLMUploadInput {
  url: string
  name?: string
}

interface GLMUploadedFile {
  file_id: string
  file_url: string
  file_name: string
  file_size: number
  file_type?: string
  cover_images?: string[]
  url?: string
  width?: number
  height?: number
  maxReadPercent?: number
}

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: GLMMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  deep_research?: boolean
  tools?: any[]
  tool_choice?: any
}

const tokenCache = new Map<string, TokenInfo>()

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now()
  const A = e.toString()
  const t = A.length
  const o = A.split('').map((c) => Number(c))
  const i = o.reduce((acc, val) => acc + val, 0) - o[t - 2]
  const a = i % 10
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t)
  const nonce = uuid()
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SECRET}`)
  return { timestamp, nonce, sign }
}

export class GLMAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getRefreshToken(): string {
    const credentials = this.account.credentials
    return credentials.chatglm_refresh_token || credentials.refresh_token || credentials.refreshToken || credentials.token || ''
  }

  private decodeJwtPayload(token: string): Record<string, any> | null {
    try {
      const payload = token.split('.')[1]
      if (!payload) {
        return null
      }

      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
      return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    } catch {
      return null
    }
  }

  private buildAuthCookie(accessToken: string): string | undefined {
    if (this.account.credentials.cookie) {
      return this.account.credentials.cookie
    }

    const refreshToken = this.getRefreshToken()
    const payload = this.decodeJwtPayload(accessToken)
    const userId = payload?.uid
    const parts: string[] = []

    if (userId) {
      parts.push(`chatglm_user_id=${userId}`)
    }
    if (accessToken) {
      parts.push(`chatglm_token=${accessToken}`)
    }
    if (refreshToken) {
      parts.push(`chatglm_refresh_token=${refreshToken}`)
    }

    return parts.length > 0 ? parts.join('; ') : undefined
  }

  private async acquireToken(): Promise<string> {
    const refreshToken = this.getRefreshToken()
    const cached = tokenCache.get(refreshToken)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.accessToken
    }

    console.log('[GLM] Refreshing Token...')
    const sign = generateSign()
    const response = await axios.post(
      `${GLM_API_BASE}/user-api/user/refresh`,
      {},
      {
        headers: {
          Authorization: `Bearer ${refreshToken}`,
          ...FAKE_HEADERS,
          'X-Device-Id': uuid(),
          'X-Nonce': sign.nonce,
          'X-Request-Id': uuid(),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    console.log('[GLM] Token response:', JSON.stringify(response.data, null, 2))
    const { code, status, message } = response.data || {}
    const isSuccess = code === 0 || status === 0
    if (response.status !== 200 || !isSuccess) {
      const errorMsg = message || `HTTP ${response.status}`
      throw new Error(`Token refresh failed: ${errorMsg}`)
    }

    const { access_token, refresh_token } = response.data.result
    const tokenInfo: TokenInfo = {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES * 1000,
    }
    tokenCache.set(refreshToken, tokenInfo)

    if (refresh_token !== refreshToken) {
      console.log('[GLM] Token updated, saving new token')
      const decryptedCredentials = {
        refresh_token,
      }
      await storeManager.updateAccount(this.account.id, {
        credentials: decryptedCredentials,
      })
    }

    console.log('[GLM] Token refresh successful')
    return access_token
  }

  /**
   * Check if URL is base64 data
   */
  private isBase64Data(url: string): boolean {
    return url.startsWith('data:')
  }

  /**
   * Extract MIME type from base64 data URL
   */
  private extractBase64Format(url: string): string {
    const match = url.match(/^data:([^;]+);/)
    return match ? match[1] : 'application/octet-stream'
  }

  /**
   * Remove base64 data header
   */
  private removeBase64Header(url: string): string {
    return url.replace(/^data:[^;]+;base64,/, '')
  }

  /**
   * Upload file to GLM
   */
  private async uploadFile(fileUrl: string, assistantId: string, fallbackName?: string): Promise<GLMUploadedFile> {
    console.log('[GLM] Uploading file:', fileUrl.substring(0, 50) + '...')
    
    let filename: string
    let fileData: Buffer
    let mimeType: string

    if (this.isBase64Data(fileUrl)) {
      mimeType = this.extractBase64Format(fileUrl)
      const ext = mime.extension(mimeType) || 'bin'
      filename = fallbackName || `${uuid()}.${ext}`
      fileData = Buffer.from(this.removeBase64Header(fileUrl), 'base64')
    } else {
      filename = fallbackName || path.basename(fileUrl.split('?')[0])
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        maxContentLength: FILE_MAX_SIZE,
        timeout: 60000,
      })
      fileData = Buffer.from(response.data)
      mimeType = response.headers['content-type'] || mime.lookup(filename) || 'application/octet-stream'
    }

    const formData = new FormData()
    formData.append('file', fileData, {
      filename,
      contentType: mimeType,
    })
    formData.append('from', 'chat')
    formData.append('assistant_id', assistantId)

    const token = await this.acquireToken()
    const sign = generateSign()
    const cookie = this.buildAuthCookie(token)
    const uploadBaseHeaders = { ...FAKE_HEADERS }
    delete uploadBaseHeaders.Accept
    delete uploadBaseHeaders['Content-Type']
    const response = await axios.post(
      `${GLM_API_BASE}/productivity-api/file/chat_upload`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...uploadBaseHeaders,
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://chatglm.cn/main/alltoolsdetail',
          'X-App-Fr': 'default',
          'X-Device-Id': uuid(),
          'X-Request-Id': uuid(),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
          'X-Nonce': sign.nonce,
          ...(cookie ? { Cookie: cookie } : {}),
          ...formData.getHeaders(),
        },
        maxBodyLength: FILE_MAX_SIZE,
        timeout: 60000,
        validateStatus: () => true,
      }
    )

    const { status, message, result } = response.data || {}
    const isSuccess = response.status === 200 && (status === 0 || response.data?.code === 0) && result?.file_id
    if (!isSuccess) {
      const responseText = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data || {})
      throw new Error(`File upload failed: ${message || `HTTP ${response.status}`}; response=${responseText.slice(0, 500)}`)
    }

    console.log('[GLM] File uploaded successfully:', result.file_id)
    return result
  }

  /**
   * Extract file URLs from message content
   */
  private extractFileUrls(messages: GLMMessage[]): { fileUrls: GLMUploadInput[]; imageUrls: GLMUploadInput[] } {
    const fileUrls: GLMUploadInput[] = []
    const imageUrls: GLMUploadInput[] = []

    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'image_url' && part.image_url?.url) {
            imageUrls.push({
              url: part.image_url.url,
              name: part.image_url.name,
            })
          } else if (part.type === 'file' && part.file_url?.url) {
            fileUrls.push({
              url: part.file_url.url,
              name: part.file_url.name,
            })
          }
        }
      }
    }

    return { fileUrls, imageUrls }
  }

  private normalizeMessagesForPrompt(messages: GLMMessage[]): GLMMessage[] {
    return messages.map(msg => {
      // Handle tool calls in assistant message
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCallsText = msg.tool_calls.map(tc => {
          return `[call:${tc.function.name}]${tc.function.arguments}[/call]`
        }).join('\n')
        return { ...msg, content: `[function_calls]\n${toolCallsText}\n[/function_calls]` }
      }
      // Handle tool response message
      if (msg.role === 'tool' && msg.tool_call_id) {
        return {
          ...msg,
          role: 'user' as const,
          content: `[TOOL_RESULT for ${msg.tool_call_id}] ${msg.content || ''}`,
        }
      }
      return msg
    })
  }

  private buildPromptText(messages: GLMMessage[], toolsPrompt?: string, isMultiTurn: boolean = false): string {
    const processedMessages = this.normalizeMessagesForPrompt(messages)

    // For multi-turn mode, only send the last user message
    if (isMultiTurn) {
      let lastUserIdx = -1
      for (let i = processedMessages.length - 1; i >= 0; i--) {
        if (processedMessages[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }

      if (lastUserIdx !== -1) {
        const lastUserMsg = processedMessages[lastUserIdx]
        let textContent = ''
        if (typeof lastUserMsg.content === 'string') {
          textContent = lastUserMsg.content
        } else if (Array.isArray(lastUserMsg.content)) {
          textContent = lastUserMsg.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        }

        // Include any tool results after the last user message
        for (let i = lastUserIdx + 1; i < processedMessages.length; i++) {
          if (processedMessages[i].role === 'user') {
            const toolText = typeof processedMessages[i].content === 'string'
              ? processedMessages[i].content
              : ''
            textContent += '\n' + toolText
          }
        }

        if (toolsPrompt) {
          textContent = textContent.trim() + "\n\n" + toolsPrompt
        }

        return textContent
      }
    }

    // Extract text from messages
    if (processedMessages.length < 2) {
      let textContent = processedMessages.reduce((acc, msg) => {
        if (typeof msg.content === 'string') {
          return acc + msg.content + '\n'
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter((c) => c.type === 'text').map((c) => c.text)
          return acc + textParts.join('') + '\n'
        }
        return acc
      }, '')

      // Inject tools prompt at the VERY END
      if (toolsPrompt) {
        textContent = textContent.trim() + "\n\n" + toolsPrompt
      }

      return textContent
    }

    let textContent = processedMessages.reduce((acc, msg) => {
      const role = msg.role
        .replace('system', 'System')
        .replace('assistant', 'Assistant')
        .replace('user', 'User')
        .replace('tool', 'User')
      if (typeof msg.content === 'string') {
        return acc + `${role}: ${msg.content}\n\n`
      } else if (Array.isArray(msg.content)) {
        const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        return acc + `${role}: ${text}\n\n`
      }
      return acc
    }, '')

    // Inject tools prompt at the VERY END
    if (toolsPrompt) {
      textContent = textContent.trim() + "\n\n" + toolsPrompt
    }

    return textContent + 'Assistant: '
  }

  private toPromptFileRef(ref: any, order: number): Record<string, unknown> {
    if (ref.file_id) {
      return {
        file_id: ref.file_id,
        file_url: ref.file_url,
        file_name: ref.file_name,
        file_size: ref.file_size,
        file_type: ref.file_type,
        order,
        maxReadPercent: ref.maxReadPercent ?? 0,
        cover_images: ref.cover_images || [''],
        url: ref.url || ref.file_url,
        width: ref.width ?? 0,
        height: ref.height ?? 0,
      }
    }

    return {
      source_id: ref.source_id,
      file_url: ref.file_url,
    }
  }

  private messagesToPrompt(messages: GLMMessage[], refs: any[] = [], toolsPrompt?: string, isMultiTurn: boolean = false, includeText: boolean = true): { role: string; content: any[] }[] {
    // Separate image refs and file refs
    const imageRefs = refs.filter((ref) => ref.image_url && !ref.file_id)
    const fileRefs = refs.filter((ref) => !ref.image_url || ref.file_id)

    // Build content array
    const content: any[] = []

    // Add file references first
    if (fileRefs.length > 0) {
      content.push({
        type: 'file',
        file: fileRefs.map((ref, index) => this.toPromptFileRef(ref, index)),
      })
    }

    // Add image references
    for (const imageRef of imageRefs) {
      content.push({
        type: 'image_url',
        image_url: {
          url: imageRef.image_url || imageRef.source_id,
        },
      })
    }

    if (includeText) {
      const textContent = this.buildPromptText(messages, toolsPrompt, isMultiTurn)
      if (textContent.trim()) {
        content.push({ type: 'text', text: textContent })
      }
    }

    return [{ role: 'user', content }]
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; conversationId: string }> {
    const token = await this.acquireToken()
    const sign = generateSign()

    // Clone messages to avoid modifying original request
    const messages = [...request.messages]

    // Check if tool prompt has already been injected by client
    const toolPromptExists = hasToolPromptInjected(messages)

    // Inject tools definition into prompt if tools are provided and not already injected
    let toolsPrompt = ''
    if (request.tools && request.tools.length > 0 && !toolPromptExists) {
      const glmStrictHint = `

GLM STRICT RULES:
- If user asks to create/modify code or files, you MUST call tools instead of replying with plain text.
- You MUST output ONLY one [function_calls] block when calling tools.
- Use exact tool names from list, case-sensitive, do not rename.`
      toolsPrompt = toolsToSystemPrompt(request.tools) + glmStrictHint

      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const currentContent = messages[i].content
          if (typeof currentContent === 'string') {
            messages[i] = { ...messages[i], content: currentContent + TOOL_WRAP_HINT }
          } else if (Array.isArray(currentContent)) {
            messages[i] = {
              ...messages[i],
              content: [...currentContent, { type: 'text', text: TOOL_WRAP_HINT }],
            }
          }
          break
        }
      }
    }

    let assistantId = DEFAULT_ASSISTANT_ID
    let chatMode = ''
    let isNetworking = false

    // Use request parameters for mode control (OpenAI compatible)
    if (request.reasoning_effort) {
      chatMode = 'zero'
      console.log('[GLM] Using reasoning mode, effort:', request.reasoning_effort)
    }
    
    if (request.web_search) {
      isNetworking = true
      console.log('[GLM] Web search enabled')
    }
    
    if (request.deep_research) {
      chatMode = 'deep_research'
      console.log('[GLM] Using deep research mode')
    }

    // Fallback: check model name for backward compatibility
    // Use originalModel for feature detection (preserves user's intent before mapping)
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    if (!chatMode && (modelLower.includes('think') || modelLower.includes('zero'))) {
      chatMode = 'zero'
      console.log('[GLM] Using reasoning mode (from model name)')
    }
    if (!chatMode && modelLower.includes('deepresearch')) {
      chatMode = 'deep_research'
      console.log('[GLM] Using deep research mode (from model name)')
    }
    
    // Check if model is an assistant ID (24+ alphanumeric characters)
    if (/^[a-z0-9]{24,}$/.test(request.model)) {
      assistantId = request.model
    }

    // Extract and upload files
    const { fileUrls, imageUrls } = this.extractFileUrls(messages)
    const refs: any[] = []

    // Upload files
    for (const file of fileUrls) {
      try {
        const result = await this.uploadFile(file.url, assistantId, file.name)
        refs.push(result)
      } catch (error) {
        console.error('[GLM] Failed to upload file:', error)
      }
    }

    // Upload images
    for (const image of imageUrls) {
      try {
        const result = await this.uploadFile(image.url, assistantId, image.name)
        refs.push(result)
      } catch (error) {
        console.error('[GLM] Failed to upload image:', error)
      }
    }

    const preparedMessages = this.messagesToPrompt(messages, refs, toolsPrompt, false)

    console.log('[GLM] Sending chat request...')
    
    const response = await axios.post(
      `${GLM_API_BASE}/backend-api/assistant/stream`,
      {
        assistant_id: assistantId,
        conversation_id: '',
        project_id: '',
        chat_type: 'user_chat',
        messages: preparedMessages,
        meta_data: {
          channel: '',
          chat_mode: chatMode || undefined,
          draft_id: '',
          if_plus_model: true,
          input_question_type: 'xxxx',
          is_networking: isNetworking,
          is_test: false,
          platform: 'pc',
          quote_log_id: '',
          cogview: {
            rm_label_watermark: false,
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          'X-Device-Id': uuid(),
          'X-Request-Id': uuid(),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
          'X-Nonce': sign.nonce,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
      }
    )

    return { response, conversationId: '' }
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const sign = generateSign()
      await axios.post(
        `${GLM_API_BASE}/backend-api/assistant/conversation/delete`,
        {
          assistant_id: DEFAULT_ASSISTANT_ID,
          conversation_id: conversationId,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )
      console.log('[GLM] Conversation deleted:', conversationId)
      return true
    } catch (error) {
      console.error('[GLM] Failed to delete conversation:', error)
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.acquireToken()

      // Step 1: Get all conversations (handle pagination)
      const allConversationIds: string[] = []
      let page = 1
      let hasMore = true

      while (hasMore) {
        const sign = generateSign()
        const listResponse = await axios.post(
          `${GLM_API_BASE}/mainchat-api/conversation/recent_list`,
          { page, page_size: 100 },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Referer: 'https://chatglm.cn/main/alltoolsdetail',
              'X-Device-Id': uuid(),
              'X-Request-Id': uuid(),
              'X-Sign': sign.sign,
              'X-Timestamp': sign.timestamp,
              'X-Nonce': sign.nonce,
              ...FAKE_HEADERS,
            },
            timeout: 30000,
            validateStatus: () => true,
          }
        )

        console.log('[GLM] Get conversation list page', page, 'response:', JSON.stringify(listResponse.data, null, 2))

        const { status, result } = listResponse.data || {}
        if (listResponse.status !== 200 || status !== 0) {
          console.error('[GLM] Failed to get conversation list')
          return false
        }

        const conversationList = result?.conversation_list || []
        for (const c of conversationList) {
          allConversationIds.push(c.conversation_id)
        }

        hasMore = result?.has_more || false
        page++

        if (conversationList.length === 0) {
          break
        }
      }

      if (allConversationIds.length === 0) {
        console.log('[GLM] No conversations to delete')
        return true
      }

      console.log('[GLM] Found', allConversationIds.length, 'conversations to delete')

      // Step 2: Bulk delete conversations
      const sign = generateSign()
      const deleteResponse = await axios.post(
        `${GLM_API_BASE}/mainchat-api/conversation/bulk_delete`,
        { conversation_ids: allConversationIds },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            ...FAKE_HEADERS,
          },
          timeout: 60000,
          validateStatus: () => true,
        }
      )

      console.log('[GLM] Bulk delete response:', JSON.stringify(deleteResponse.data, null, 2))

      const deleteResult = deleteResponse.data || {}
      const success = deleteResponse.status === 200 && deleteResult.status === 0
      if (success) {
        console.log('[GLM] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[GLM] Failed to delete all chats:', error)
      return false
    }
  }

  static isGLMProvider(provider: Provider): boolean {
    return provider.id === 'glm' || provider.apiEndpoint.includes('chatglm.cn')
  }
}

export class GLMStreamHandler {
  private conversationId: string = ''
  private model: string
  private created: number
  private onEnd?: () => void
  private toolCallState: ToolCallState

  constructor(model: string, onEnd?: () => void, initialConversationId?: string) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallState = createToolCallState()
    if (initialConversationId) {
      this.conversationId = initialConversationId
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    const cachedParts: any[] = []
    let sentContent = ''
    let sentReasoning = ''
    let sentRole = false

    transStream.write(
      `data: ${JSON.stringify({
        id: '',
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        created: this.created,
      })}\n\n`
    )

    const parser = createParser({
      onEvent: (event: any) => {
        try {
          const result = JSON.parse(event.data)

          if (!this.conversationId && result.conversation_id) {
            this.conversationId = result.conversation_id
          }

          if (result.status !== 'finish' && result.status !== 'intervene') {
            if (result.parts) {
              result.parts.forEach((part: any) => {
                const index = cachedParts.findIndex((p) => p.logic_id === part.logic_id)
                if (index !== -1) {
                  cachedParts[index] = part
                } else {
                  cachedParts.push(part)
                }
              })
            }

            const searchMap = new Map<string, any>()
            cachedParts.forEach((part) => {
              if (!part.content || !Array.isArray(part.content)) return
              const { meta_data } = part
              part.content.forEach((item: any) => {
                if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                  meta_data.tool_result_extra.search_results.forEach((res: any) => {
                    if (res.match_key) {
                      searchMap.set(res.match_key, res)
                    }
                  })
                }
              })
            })

            const keyToIdMap = new Map<string, number>()
            let counter = 1
            let fullText = ''
            let fullReasoning = ''

            cachedParts.forEach((part) => {
              const { content, meta_data } = part
              if (!Array.isArray(content)) return

              let partText = ''
              let partReasoning = ''

              content.forEach((value: any) => {
                const { type, text, think, image, code, content: innerContent } = value

                if (type === 'text') {
                  let txt = text
                  if (searchMap.size > 0) {
                    txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                      const searchInfo = searchMap.get(key)
                      if (!searchInfo) return match
                      if (!keyToIdMap.has(key)) {
                        keyToIdMap.set(key, counter++)
                      }
                      return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                    })
                  }
                  partText += txt
                } else if (type === 'think') {
                  partReasoning += think
                } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                  const imageText =
                    image.reduce((imgs: string, v: any) => {
                      return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                    }, '') + '\n'
                  partText += imageText
                } else if (type === 'code') {
                  partText += '```python\n' + code + (part.status === 'finish' ? '\n```\n' : '')
                } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                  partText += innerContent + '\n'
                }
              })

              if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
              if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
            })

            const reasoningChunk = fullReasoning.substring(sentReasoning.length)
            if (reasoningChunk) {
              sentReasoning += reasoningChunk
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.conversationId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { reasoning_content: reasoningChunk }, finish_reason: null }],
                  created: this.created,
                })}\n\n`
              )
            }

            const chunk = fullText.substring(sentContent.length)
            if (chunk) {
              sentContent += chunk
            }
            
            // Process tool call interception - use toolCallState's buffer for accumulation
            const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
            const { chunks: outputChunks } = processStreamContent(
              chunk, 
              this.toolCallState, 
              baseChunk, 
              !sentRole,
              'glm'
            )

            for (const outChunk of outputChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }

            if (outputChunks.length > 0) sentRole = true
          } else {
            // Flush any remaining tool call buffer before finishing
            const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
            const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'glm')
            for (const outChunk of flushChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }

            // Determine finish_reason based on whether we had tool calls
            const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'

            transStream.write(
              `data: ${JSON.stringify({
                id: this.conversationId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [
                  {
                    index: 0,
                    delta:
                      result.status === 'intervene' && result.last_error?.intervene_text
                        ? { content: '\n\n' + result.last_error.intervene_text }
                        : {},
                    finish_reason: finishReason,
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                created: this.created,
              })}\n\n`
            )
            transStream.end('data: [DONE]\n\n')
            this.onEnd?.()
          }
        } catch (err) {
          console.error('[GLM] Stream parse error:', err)
        }
      },
    })

    const decoder = new TextDecoder('utf-8')
    stream.on('data', (buffer: Buffer) => parser.feed(decoder.decode(buffer, { stream: true })))

    // Handle stream errors - ensure proper cleanup
    stream.once('error', (err: Error) => {
      console.error('[GLM] Stream error:', err.message)
      // Flush any remaining tool call buffer
      const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
      const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'glm')
      for (const outChunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
      }
      const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
      transStream.write(
        `data: ${JSON.stringify({
          id: this.conversationId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      this.onEnd?.()
    })

    // Handle stream close - ensure proper cleanup if not already finished
    stream.once('close', () => {
      console.log('[GLM] Stream closed')
      // Only send finish if we haven't already
      if (!transStream.closed) {
        const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
        const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'glm')
        for (const outChunk of flushChunks) {
          transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
        }
        const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
        transStream.write(
          `data: ${JSON.stringify({
            id: this.conversationId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            created: this.created,
          })}\n\n`
        )
        transStream.end('data: [DONE]\n\n')
        this.onEnd?.()
      }
    })

    return transStream
  }

  async handleNonStream(stream: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const cachedParts: any[] = []

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            const result = JSON.parse(event.data)

            if (!this.conversationId && result.conversation_id) {
              this.conversationId = result.conversation_id
            }

            if (result.status !== 'finish') {
              if (result.parts) {
                // Accumulate parts (same as handleStream), don't replace
                // GLM sends incremental parts, each event only contains new content
                result.parts.forEach((part: any) => {
                  const index = cachedParts.findIndex((p) => p.logic_id === part.logic_id)
                  if (index !== -1) {
                    cachedParts[index] = part
                  } else {
                    cachedParts.push(part)
                  }
                })
              }
            } else {
              const searchMap = new Map<string, any>()
              cachedParts.forEach((part) => {
                if (!part.content || !Array.isArray(part.content)) return
                const { meta_data } = part
                part.content.forEach((item: any) => {
                  if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                    meta_data.tool_result_extra.search_results.forEach((res: any) => {
                      if (res.match_key) {
                        searchMap.set(res.match_key, res)
                      }
                    })
                  }
                })
              })

              const keyToIdMap = new Map<string, number>()
              let counter = 1
              let fullText = ''
              let fullReasoning = ''

              cachedParts.forEach((part) => {
                const { content, meta_data } = part
                if (!Array.isArray(content)) return

                let partText = ''
                let partReasoning = ''

                content.forEach((value: any) => {
                  const { type, text, think, image, code, content: innerContent } = value

                  if (type === 'text') {
                    let txt = text
                    if (searchMap.size > 0) {
                      txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                        const searchInfo = searchMap.get(key)
                        if (!searchInfo) return match
                        if (!keyToIdMap.has(key)) {
                          keyToIdMap.set(key, counter++)
                        }
                        return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                      })
                    }
                    partText += txt
                  } else if (type === 'think') {
                    partReasoning += think
                  } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                    const imageText =
                      image.reduce((imgs: string, v: any) => {
                        return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                      }, '') + '\n'
                    partText += imageText
                  } else if (type === 'code') {
                    partText += '```python\n' + code + '\n```\n'
                  } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                    partText += innerContent + '\n'
                  }
                })

                if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
                if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
              })

              const { content: cleanContent, toolCalls } = parseToolCallsFromText(fullText, 'glm')

              resolve({
                id: this.conversationId,
                model: this.model,
                object: 'chat.completion',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: toolCalls.length > 0 ? null : cleanContent.trim(),
                      reasoning_content: fullReasoning || null,
                      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
                    },
                    finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                created: Math.floor(Date.now() / 1000),
              })
            }
          } catch (err) {
            reject(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      stream.once('error', reject)
      stream.once('close', () => {
        resolve({
          id: this.conversationId,
          model: this.model,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '', reasoning_content: null },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: Math.floor(Date.now() / 1000),
        })
      })
    })
  }

  getConversationId(): string {
    return this.conversationId
  }
}

export const glmAdapter = {
  GLMAdapter,
  GLMStreamHandler,
}
