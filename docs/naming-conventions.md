# Nexora naming conventions

Aligned with common React + Node professional practice.

## Frontend (`client/src`)

| Kind | Convention | Example |
|------|------------|---------|
| React components / pages | **PascalCase** | `Feed.jsx`, `AuthContext.jsx` |
| Hooks | **camelCase** + `use` prefix | `usePageTitle.js` |
| Utilities | **camelCase** | `mediaUrl.js` |
| Services / API | **camelCase** under `services/` | `services/api.js` |
| Styles | **kebab-case** or `index.css` in `styles/` | `styles/index.css` |
| Context folder | plural **`contexts/`** | `contexts/AuthContext.jsx` |
| Constants / i18n | **camelCase** | `i18n/translations.js` |

## Backend (`server`)

| Kind | Convention | Example |
|------|------------|---------|
| Entry / modules | **camelCase** | `index.js`, `rateLimit.js` |
| Routes | **camelCase** (resource name) | `posts.js`, `friendRequests` N/A |
| Middleware | **camelCase** | `auth.js`, `rateLimit.js` |
| Utils | **camelCase** | `email.js`, `storage.js` |
| SQL migrations | **snake_case** + optional number | `migrations/001_setup_step_a.sql` |
| Scripts | **camelCase** | `scripts/smoke.js` |

## Docs (repo root / `docs/`)

| Kind | Convention | Example |
|------|------------|---------|
| Markdown guides | **kebab-case** | `docs/deploy.md` |
| README | **README.md** (standard) | `README.md` |

## Rules of thumb

1. **React UI files** → PascalCase  
2. **Non-component JS** → camelCase  
3. **SQL / shell / multi-word docs** → snake_case or kebab-case  
4. **Never** spaces or mixed `snake_Case`  
5. Prefer **folders by role** (`pages`, `components`, `services`, `hooks`, `utils`, `contexts`)
