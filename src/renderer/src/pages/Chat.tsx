import { ChatSidebar } from '@/components/chat/ChatSidebar'
import { ChatMain } from '@/components/chat/ChatMain'

export function Chat() {
  return (
    <div className="-m-6 flex h-[calc(100vh-3rem)]">
      <ChatSidebar />
      <ChatMain />
    </div>
  )
}
