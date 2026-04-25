import { useEffect, useRef } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { MessageBubble } from './MessageBubble'

export function MessageList() {
  const activeId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const conversation = conversations.find((c) => c.id === activeId)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [conversation?.messages])

  if (!conversation) return null

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
      {conversation.messages.length === 0 ? (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Start a conversation...
        </div>
      ) : (
        conversation.messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
      )}
    </div>
  )
}
