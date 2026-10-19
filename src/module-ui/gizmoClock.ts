/** 剛用過操作把手：這段時間內的點選不算「點到空白處／點到後面的零件」 */
let gizmoUsedAt = 0
export const markGizmoUsed = () => {
  gizmoUsedAt = performance.now()
}
export const gizmoRecentlyUsed = () => performance.now() - gizmoUsedAt < 350
