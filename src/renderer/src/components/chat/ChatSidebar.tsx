import { useTranslation } from 'react-i18next'
import { useChatStore } from '@/stores/chatStore'
import { ConversationItem } from './ConversationItem'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Plus, Trash2 } from 'lucide-react'

export function ChatSidebar() {
  const { t } = useTranslation()
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeConversationId)
  const models = useChatStore((s) => s.models)
  const createConversation = useChatStore((s) => s.createConversation)
  const clearAllConversations = useChatStore((s) => s.clearAllConversations)

  const handleNewChat = () => {
    const defaultModel = models.length > 0 ? models[0].id : ''
    createConversation(defaultModel)
  }

  return (
    <div className="w-64 border-r bg-muted/30 flex flex-col shrink-0">
      {/* Header */}
      <div className="p-3 border-b">
        <Button className="w-full justify-start gap-2" size="sm" onClick={handleNewChat}>
          <Plus className="h-4 w-4" />
          {t('chat.newConversation')}
        </Button>
      </div>

      {/* Conversation list */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {conversations.length === 0 ? (
            <div className="text-center py-8 px-4">
              <p className="text-xs text-muted-foreground">{t('chat.noConversations')}</p>
            </div>
          ) : (
            conversations.map((c) => (
              <ConversationItem key={c.id} conversation={c} isActive={c.id === activeId} />
            ))
          )}
        </div>
      </ScrollArea>

      {/* Footer */}
      {conversations.length > 0 && (
        <div className="p-2 border-t">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-destructive hover:text-destructive"
            onClick={clearAllConversations}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('chat.clearAll')}
          </Button>
        </div>
      )}
    </div>
  )
}
