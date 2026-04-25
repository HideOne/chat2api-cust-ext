import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useSettingsStore } from './settingsStore'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  model?: string
  status?: 'sending' | 'streaming' | 'done' | 'error'
  error?: string
}

export interface Conversation {
  id: string
  title: string
  model: string
  messages: Message[]
  systemPrompt?: string
  createdAt: number
  updatedAt: number
}

export interface ModelInfo {
  id: string
  owned_by: string
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  models: ModelInfo[]
  modelsLoading: boolean
  isStreaming: boolean
  abortController: AbortController | null

  createConversation: (model: string) => string
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  setActiveConversation: (id: string | null) => void
  clearAllConversations: () => void
  updateConversationModel: (id: string, model: string) => void
  updateConversationSystemPrompt: (id: string, prompt: string | undefined) => void
  updateMessageContent: (
    conversationId: string,
    messageId: string,
    content: string,
    status: Message['status'],
    error?: string
  ) => void
  fetchModels: () => Promise<void>
  sendMessage: (conversationId: string, content: string) => Promise<void>
  stopStreaming: () => void
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function getProxyBaseUrl(): string {
  const config = useSettingsStore.getState().config
  const port = config?.proxyPort ?? 8080
  return `http://127.0.0.1:${port}`
}

function getAuthHeaders(): Record<string, string> {
  const config = useSettingsStore.getState().config
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config?.enableApiKey && config.apiKeys && config.apiKeys.length > 0) {
    const enabledKey = config.apiKeys.find((k: any) => k.enabled)
    if (enabledKey) {
      headers['Authorization'] = `Bearer ${enabledKey.key}`
    }
  }
  return headers
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,
      models: [],
      modelsLoading: false,
      isStreaming: false,
      abortController: null,

      createConversation: (model: string) => {
        const id = generateId()
        const conversation: Conversation = {
          id,
          title: '',
          model,
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: id,
        }))
        return id
      },

      deleteConversation: (id: string) => {
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== id),
          activeConversationId:
            state.activeConversationId === id ? null : state.activeConversationId,
        }))
      },

      renameConversation: (id: string, title: string) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c
          ),
        }))
      },

      setActiveConversation: (id: string | null) => {
        set({ activeConversationId: id })
      },

      clearAllConversations: () => {
        set({ conversations: [], activeConversationId: null })
      },

      updateConversationModel: (id: string, model: string) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, model, updatedAt: Date.now() } : c
          ),
        }))
      },

      updateConversationSystemPrompt: (id: string, prompt: string | undefined) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, systemPrompt: prompt, updatedAt: Date.now() } : c
          ),
        }))
      },

      updateMessageContent: (
        conversationId: string,
        messageId: string,
        content: string,
        status: Message['status'],
        error?: string
      ) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, content, status, error } : m
                  ),
                }
              : c
          ),
        }))
      },

      fetchModels: async () => {
        set({ modelsLoading: true })
        try {
          const baseUrl = getProxyBaseUrl()
          const headers = getAuthHeaders()
          const response = await fetch(`${baseUrl}/v1/models`, { headers })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          const models: ModelInfo[] = (data.data || []).map((m: any) => ({
            id: m.id,
            owned_by: m.owned_by,
          }))
          set({ models, modelsLoading: false })
        } catch (error) {
          console.error('Failed to fetch models:', error)
          set({ modelsLoading: false })
        }
      },

      sendMessage: async (conversationId: string, content: string) => {
        const state = get()
        const conversation = state.conversations.find((c) => c.id === conversationId)
        if (!conversation) return

        // Add user message and placeholder assistant message
        const userMessage: Message = {
          id: generateId(),
          role: 'user',
          content,
          timestamp: Date.now(),
        }
        const assistantMessage: Message = {
          id: generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          model: conversation.model,
          status: 'streaming',
        }

        const updatedMessages = [...conversation.messages, userMessage, assistantMessage]
        const autoTitle =
          conversation.title || content.slice(0, 50) + (content.length > 50 ? '...' : '')

        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, messages: updatedMessages, title: autoTitle, updatedAt: Date.now() }
              : c
          ),
        }))

        // Start streaming
        const abortController = new AbortController()
        set({ isStreaming: true, abortController })

        try {
          const baseUrl = getProxyBaseUrl()
          const headers = getAuthHeaders()

          // Build API messages array
          const apiMessages: any[] = []
          if (conversation.systemPrompt) {
            apiMessages.push({ role: 'system', content: conversation.systemPrompt })
          }
          for (const msg of conversation.messages) {
            if (msg.status === 'error') continue
            apiMessages.push({ role: msg.role, content: msg.content })
          }
          apiMessages.push({ role: 'user', content })

          const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: conversation.model,
              messages: apiMessages,
              stream: true,
            }),
            signal: abortController.signal,
          })

          if (!response.ok) {
            const errorData = await response.json().catch(() => null)
            throw new Error(errorData?.error?.message || `HTTP ${response.status}`)
          }

          const reader = response.body!.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let accumulated = ''

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || !trimmed.startsWith('data: ')) continue
              const data = trimmed.slice(6)
              if (data === '[DONE]') {
                get().updateMessageContent(conversationId, assistantMessage.id, accumulated, 'done')
                break
              }
              try {
                const parsed = JSON.parse(data)
                const delta = parsed.choices?.[0]?.delta?.content
                if (delta) {
                  accumulated += delta
                  get().updateMessageContent(
                    conversationId,
                    assistantMessage.id,
                    accumulated,
                    'streaming'
                  )
                }
              } catch {
                // skip malformed JSON
              }
            }
          }

          // Ensure final status
          get().updateMessageContent(conversationId, assistantMessage.id, accumulated, 'done')
        } catch (error: any) {
          if (error.name === 'AbortError') {
            const current = get().conversations.find((c) => c.id === conversationId)
            const msg = current?.messages.find((m) => m.id === assistantMessage.id)
            get().updateMessageContent(
              conversationId,
              assistantMessage.id,
              msg?.content || '',
              'done'
            )
          } else {
            get().updateMessageContent(
              conversationId,
              assistantMessage.id,
              '',
              'error',
              error.message
            )
          }
        } finally {
          set({ isStreaming: false, abortController: null })
        }
      },

      stopStreaming: () => {
        const { abortController } = get()
        abortController?.abort()
        set({ isStreaming: false, abortController: null })
      },
    }),
    {
      name: 'chat2api-chat',
      partialize: (state) => ({
        conversations: state.conversations.map((c) => ({
          ...c,
          messages: c.messages.map((m) => ({
            ...m,
            status: m.status === 'streaming' ? 'done' : m.status,
          })),
        })),
        activeConversationId: state.activeConversationId,
      }),
    }
  )
)
