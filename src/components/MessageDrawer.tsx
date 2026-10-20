import { useSyncExternalStore } from 'react'
import { MdiIcon } from './MdiIcon'
import { messages, type MessageKind } from '../lib/messages'

const ICONS: Record<MessageKind, string> = {
  success: 'check-circle',
  error: 'alert-circle',
  warning: 'alert',
  info: 'information',
}

const COLORS: Record<MessageKind, string> = {
  success: 'success',
  error: 'error',
  warning: 'warning',
  info: 'primary',
}

/** 消息记录抽屉：对齐 MessageLog.vue（右侧 400px、primary 工具栏、类型图标 + 时间）。 */
export function MessageDrawer() {
  const open = useSyncExternalStore(
    messages.subscribe,
    () => messages.drawerOpen,
    () => false,
  )
  const items = useSyncExternalStore(
    messages.subscribe,
    () => messages.getItems(),
    () => [],
  )

  return (
    <div className={`message-drawer-root ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="message-drawer-scrim" onClick={() => messages.close()} />
      <aside className="message-drawer" role="dialog" aria-label="消息记录">
        <div className="message-drawer-toolbar">
          <span className="message-drawer-title">消息记录</span>
        </div>

        <div className="v-list" style={{ padding: '8px 0' }}>
          {items.length === 0 ? (
            <div className="v-list-item rounded" style={{ minHeight: 40 }}>
              <MdiIcon name="inbox" size={24} className="mr-8 text-grey" />
              <span className="v-list-item-title text-grey">暂无消息</span>
            </div>
          ) : (
            items.map((item) => (
              <div className="v-list-item message-item rounded" key={item.id}>
                <MdiIcon
                  name={ICONS[item.kind]}
                  size={20}
                  className={`mr-8 text-${COLORS[item.kind]}`}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="v-list-item-title">{item.title}</div>
                  {item.message && <div className="v-list-item-subtitle">{item.message}</div>}
                  <div className="text-caption text-grey mt-1">
                    {new Date(item.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}
