import { useSyncExternalStore } from 'react'
import { Icon, type IconName } from './Icon'
import { messages, type MessageKind } from '../lib/messages'

const ICONS: Record<MessageKind, IconName> = {
  success: 'check',
  error: 'alert',
  warning: 'warning',
  info: 'info',
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
          <span className="text-h6">消息记录</span>
          <div className="flex-grow-1" />
          {items.length > 0 && (
            <button
              type="button"
              className="v-btn v-btn--size-small v-btn--variant-text"
              style={{ color: 'inherit' }}
              onClick={() => messages.clear()}
            >
              清空
            </button>
          )}
          <button
            type="button"
            className="v-btn v-btn--icon v-btn--variant-text"
            style={{ color: 'inherit' }}
            onClick={() => messages.close()}
            aria-label="关闭"
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="v-list" style={{ padding: '8px 0' }}>
          {items.length === 0 ? (
            <div className="v-list-item" style={{ minHeight: 56 }}>
              <Icon name="inbox" size={20} className="mr-4 text-grey" />
              <span className="v-list-item-title text-grey">暂无消息</span>
            </div>
          ) : (
            items.map((item) => (
              <div className="v-list-item message-item" key={item.id}>
                <Icon
                  name={ICONS[item.kind]}
                  size={20}
                  className={`mr-4 text-${COLORS[item.kind]}`}
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
