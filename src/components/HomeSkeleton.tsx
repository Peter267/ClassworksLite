import { useMediaQuery } from '../lib/hooks'

/** 纯 CSS 骨架屏，对齐上游 HomeSkeleton.vue */
export function HomeSkeleton() {
  const mobile = useMediaQuery('(max-width: 1279px)')
  const cardCount = mobile ? 3 : 6

  return (
    <div className="home-skeleton">
      <div className="skeleton-grid">
        {Array.from({ length: cardCount }, (_, index) => (
          <div className="skeleton-card" key={index}>
            <div className="skeleton-heading skeleton-pulse" />
            <div className="skeleton-line skeleton-pulse" />
            <div className="skeleton-line skeleton-line--short skeleton-pulse" />
          </div>
        ))}
      </div>
      <div className="d-flex justify-center mt-6" style={{ gap: 12 }}>
        <div className="skeleton-btn skeleton-pulse" />
        <div className="skeleton-btn skeleton-pulse" />
      </div>
    </div>
  )
}
