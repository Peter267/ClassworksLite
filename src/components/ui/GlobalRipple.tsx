import { useEffect } from 'react'

interface ActiveRipple {
  element: HTMLElement
  container: HTMLSpanElement
  animation: HTMLSpanElement
  startedAt: number
}

const SELECTOR = [
  '.v-btn:not(:disabled)',
  'button.v-chip',
  'button.v-list-item',
  '.v-tab',
  '.date-picker-day',
  '.v-card.cursor-pointer',
  '.hover-card',
  '.time-card',
].join(', ')

/** 对齐 Vuetify 3 的 v-ripple：btn / chip / list-item / 可点击卡片 */
export function GlobalRipple() {
  useEffect(() => {
    let ripples: ActiveRipple[] = []

    const hide = (ripple: ActiveRipple) => {
      const elapsed = performance.now() - ripple.startedAt
      window.setTimeout(() => {
        ripple.animation.classList.remove('v-ripple__animation--in')
        ripple.animation.classList.add('v-ripple__animation--out')
        window.setTimeout(() => {
          ripple.container.remove()
          if (
            ripple.element.dataset.ripplePosition &&
            !ripple.element.querySelector('.v-ripple__animation')
          ) {
            ripple.element.style.position = ripple.element.dataset.ripplePosition
            delete ripple.element.dataset.ripplePosition
          }
        }, 300)
      }, Math.max(0, 100 - elapsed))
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType !== 'touch') return
      const target = event.target
      if (!(target instanceof Element)) return
      const element = target.closest<HTMLElement>(SELECTOR)
      if (!element || element.getAttribute('aria-disabled') === 'true') return

      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const computed = window.getComputedStyle(element)
      if (computed.position === 'static') {
        element.dataset.ripplePosition = 'static'
        element.style.position = 'relative'
      }

      const isCircle =
        element.classList.contains('v-btn--icon') ||
        element.classList.contains('date-picker-day') ||
        element.classList.contains('v-chip--round')
      const radius = isCircle
        ? rect.width / 2
        : Math.sqrt(rect.width ** 2 + rect.height ** 2) / 2
      const localX = event.clientX - rect.left
      const localY = event.clientY - rect.top
      const centerX = (rect.width - radius * 2) / 2
      const centerY = (rect.height - radius * 2) / 2
      const scale = isCircle ? 0.15 : 0.3

      const container = document.createElement('span')
      container.className = 'v-ripple__container'
      const animation = document.createElement('span')
      animation.className =
        'v-ripple__animation v-ripple__animation--enter v-ripple__animation--visible'
      animation.style.width = `${radius * 2}px`
      animation.style.height = `${radius * 2}px`
      animation.style.transform = `translate(${localX - radius}px, ${
        localY - radius
      }px) scale3d(${scale}, ${scale}, ${scale})`
      container.appendChild(animation)
      element.appendChild(container)

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          animation.classList.remove('v-ripple__animation--enter')
          animation.classList.add('v-ripple__animation--in')
          animation.style.transform = `translate(${centerX}px, ${centerY}px) scale3d(1, 1, 1)`
        })
      })

      ripples.push({ element, container, animation, startedAt: performance.now() })
    }

    const hideAll = () => {
      const pending = ripples
      ripples = []
      pending.forEach(hide)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', hideAll, true)
    document.addEventListener('pointercancel', hideAll, true)
    window.addEventListener('blur', hideAll)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', hideAll, true)
      document.removeEventListener('pointercancel', hideAll, true)
      window.removeEventListener('blur', hideAll)
      hideAll()
    }
  }, [])

  return null
}
