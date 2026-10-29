## 2026-09-27 - Lazy Loading Modals
**Learning:** The Storage Explorer modals can render many images (bot avatars, asset thumbnails) but lacked `loading="lazy"` and `decoding="async"`, which is critical for the ~4GB RAM Android target to prevent jank.
**Action:** Always verify `<img>` tags in lists/modals use lazy loading and async decoding.
