# Nexora UI Reference Guide

Your complete front-end UI files have been successfully duplicated into a local folder: **`ui-reference/`** in your project root directory.

This guide provides a detailed map of all the pages, components, contexts, and API integrations in Nexora. Your team can use this reference to replace the styles and HTML structure with their new designs while keeping the essential state hook bindings, event handlers, and API connections intact.

---

## 📂 Frontend Directory Structure

All files from the original UI are located in `ui-reference/` (copied from `client/src/`):

```text
ui-reference/
├── App.jsx                 # Central router, protected routes, layout wrapper
├── main.jsx                # App entry point rendering App.jsx inside React.StrictMode
├── index.css               # Global stylesheets, animation keyframes, HSL variables
├── assets/                 # SVGs and image files
│   ├── vite.svg
│   └── hero.png
├── components/
│   └── Navbar.jsx          # Logged-in top navigation bar, points badge, user menu
├── context/
│   └── AuthContext.jsx     # Global authentication provider (uses LocalStorage + Axios defaults)
├── i18n/
│   └── translations.js     # Multilingual translations (6 languages supported)
└── pages/
    ├── Landing.jsx         # Landing/marketing index page
    ├── Login.jsx           # User sign-in page
    ├── Register.jsx        # Account registration page
    ├── ForgotPassword.jsx  # Reset password & random password generator page
    ├── Feed.jsx            # Social feed dashboard with post limits & interactive actions
    ├── QA.jsx              # Searchable/filterable Q&A forum list
    ├── QuestionDetail.jsx  # Full question thread with vote scoring & accepted answers
    ├── AskQuestion.jsx     # New question form with daily quota checks
    ├── Subscriptions.jsx   # Upgrade plans & mock/live payment history (Razorpay)
    ├── Profile.jsx         # Personal/public profile details, badges & point transfers
    ├── Settings.jsx        # Language switches (with SMS/Email OTP), friend requests, and password reset
    └── Leaderboard.jsx     # User leaderboard by points & point transfer logs
```

---

## ⚡ Global Authentication Context (`context/AuthContext.jsx`)

The frontend relies on the `AuthContext` to share user and session state globally. The hook `useAuth()` exposes the following values and functions:

| Item | Type | Description |
| :--- | :--- | :--- |
| `user` | `Object` / `null` | The active user document (holds `id`/`_id`, `name`, `email`, `points`, `language`, `friends`, `subscription`, `avatar`, `badges`). |
| `token` | `String` / `null` | Bearer JWT token saved in `localStorage` under `nexora_token`. |
| `loading` | `Boolean` | State tracking whether authentication state is still loading from the backend on startup. |
| `login(email, password)` | `Function` | Triggers `/api/auth/login`, saves token, sets Axios auth headers, and updates the `user` state. |
| `register(name, email, phone, password)` | `Function` | Triggers `/api/auth/register`, logs the user in automatically, and updates user state. |
| `logout()` | `Function` | Wipes the local token, clears axios headers, and clears the user state. |
| `updateUser(updates)` | `Function` | Optimistically merges updates into the client-side `user` object. |
| `refreshUser()` | `Function` | Fetches the current user profile from `/api/auth/me` to refresh the state. |

---

## 🛣️ Routing Mapping (`App.jsx`)

The routing is built using `react-router-dom` with Public and Protected Route guards:

| Path | Element | Access | Notes |
| :--- | :--- | :--- | :--- |
| `/` | `<Landing />` | Public | Public landing page. |
| `/login` | `<Login />` | Public-Only | Redirects to `/feed` if already logged in. |
| `/register` | `<Register />` | Public-Only | Redirects to `/feed` if already logged in. |
| `/forgot-password`| `<ForgotPassword />` | Public | Allows recovery. |
| `/feed` | `<Feed />` | Protected | Redirects to `/login` if not authenticated. Displays navbar. |
| `/qa` | `<QA />` | Protected | Q&A Forum dashboard. |
| `/qa/:id` | `<QuestionDetail />`| Protected | View a specific question thread. |
| `/ask` | `<AskQuestion />` | Protected | Form to submit a question. |
| `/subscriptions` | `<Subscriptions />` | Protected | Plan upgrade screen. |
| `/profile/:id` | `<Profile />` | Protected | View a user's details (self or other). |
| `/settings` | `<Settings />` | Protected | Language settings, password updates, friend requests. |
| `/leaderboard` | `<Leaderboard />` | Protected | Point leaderboards and transfer logs. |

---

## 📄 Page-by-Page Integration Map

### 1. Landing Page (`pages/Landing.jsx`)
*   **Purpose**: Informational marketing page detailing features, plans, and community statistics.
*   **Navigation Hooks**: Uses `useNavigate()` to route users to `/register` and `/login`.
*   **API Integrations**: None (static text, visuals, icons).

### 2. Login Page (`pages/Login.jsx`)
*   **Form States**: `form.email`, `form.password`, `showPw` (toggle display), `loading` (spinner flag), and `error`.
*   **Action Handlers**: `handleSubmit` invokes `login(form.email, form.password)` from the auth context.
*   **Toasts**: Uses `react-hot-toast` for welcome messages.

### 3. Register Page (`pages/Register.jsx`)
*   **Form States**: `form.name`, `form.email`, `form.phone` (optional), `form.password`, `form.confirm`.
*   **Validation Checks**: Passwords must match and be $\ge 6$ characters.
*   **Action Handlers**: `handleSubmit` invokes `register(name, email, phone, password)` from the auth context.

### 4. Forgot Password Page (`pages/ForgotPassword.jsx`)
*   **Form States**: `method` (`'email'` or `'phone'`), `value` (email or phone input), `generatedPw` (random pass), `newPwResult` (recovery fallback password for developer testing).
*   **Action Handlers**:
    *   `handleGenerate`: Posts to `/api/auth/generate-password` to fetch a randomly generated pure-letter password.
    *   `handleSubmit`: Posts to `/api/auth/forgot-password` with `{ email }` or `{ phone }`.

### 5. Social Feed (`pages/Feed.jsx`)
This is a rich social network page. It integrates the post submission limits based on the user's friend count.
*   **Key Rules**:
    *   $0$ friends: Cannot post on the feed.
    *   $1$ friend: Limit of 1 post/day.
    *   $2-9$ friends: Limit of 2 posts/day.
    *   $10+$ friends: Unlimited posts.
*   **API Integrations**:
    *   Fetch feed: `GET /api/posts?page=X&limit=10`
    *   Create post: `POST /api/posts` (Uses multipart/form-data for media file attachments)
    *   Like post: `POST /api/posts/:id/like`
    *   Comment on post: `POST /api/posts/:id/comment`
    *   Share post count: `POST /api/posts/:id/share`
    *   Delete post: `DELETE /api/posts/:id`

### 6. Q&A Forums (`pages/QA.jsx`)
*   **State Hooks**: `search` query, `sort` (`'newest'`, `'votes'`, `'unanswered'`), `page`, and `total` count.
*   **API Integrations**:
    *   Fetch questions: `GET /api/questions` with query params `{ page, limit, sort, search }`.
*   **Action Handlers**:
    *   Clicking a question navigates to `/qa/:id`.
    *   Clicking "Ask Question" checks current quota limit rules before navigating to `/ask`.

### 7. Question Details & Answers (`pages/QuestionDetail.jsx`)
*   **State Hooks**: `question` (contains array of answers, likes, resolves), `answerBody`.
*   **API Integrations**:
    *   Fetch question thread: `GET /api/questions/:id`
    *   Upvote/Downvote thread: `POST /api/questions/:id/vote` (payload: `{ type: 'up' | 'down' }`)
    *   Upvote/Downvote answer: `POST /api/answers/:answerId/vote` (payload: `{ type: 'up' | 'down' }`)
    *   Post new answer: `POST /api/answers/:questionId` (payload: `{ body }`)
    *   Accept answer (marks resolved): `POST /api/answers/:answerId/accept` (only callable by the question author)
    *   Delete answer: `DELETE /api/answers/:answerId`

### 8. Ask Question (`pages/AskQuestion.jsx`)
*   **Form States**: `form.title` ($\ge 10$ chars), `form.body` ($\ge 20$ chars), `form.tags` (comma-separated string parsed into preview arrays).
*   **Quota rules check**:
    *   Displays current subscription tier and daily quota (Free: 1/day, Bronze: 5/day, Silver: 10/day, Gold: Unlimited).
*   **API Integrations**:
    *   Submit question: `POST /api/questions` with `{ title, body, tags }`. Returns `{ question }`.

### 9. Subscriptions & Payments (`pages/Subscriptions.jsx`)
Handles payments and order checkouts.
*   **Payment Window Constraints**:
    *   Payments are restricted to the time window **10:00 AM - 11:00 AM IST** on the production server.
    *   In local developer/demo mode, payment is automatically mocked and verified bypassing Razorpay checkout if `isMock: true` is returned.
*   **API Integrations**:
    *   Get payment window status: `GET /api/subscriptions/plans`
    *   Fetch payment invoice history: `GET /api/subscriptions/history`
    *   Create order ID: `POST /api/subscriptions/create-order` (payload: `{ plan }`)
    *   Verify transaction: `POST /api/subscriptions/verify-payment`

### 10. Profile & Point Transfers (`pages/Profile.jsx`)
Enables profile view, avatar changes, bio updates, friend additions/deletions, and point transfers.
*   **State Hooks**: `profile`, `editing` (boolean toggling inputs), `transferModal` (open state), `transferPoints`, `transferMsg`.
*   **API Integrations**:
    *   Fetch profile details: `GET /api/users/:id`
    *   Update profile metadata/avatar: `PUT /api/users/profile` (Supports fields `name`, `bio`, `phone`, and `avatar` file upload)
    *   Send friend request: `POST /api/users/friend-request/:id`
    *   Unfriend: `DELETE /api/users/friend/:id`
    *   Point Transfer: `POST /api/rewards/transfer` (payload: `{ toUserId, points, message }`). *Rule: Users must maintain at least 10 points after sending points.*

### 11. Settings (`pages/Settings.jsx`)
Provides configuration tabs for Language selection, Password changes, Friend requests management, and finding new users.
*   **Language switches and OTP checks**:
    *   Switching to French requires an **Email OTP**. All other translation switches require a **Mobile OTP**.
    *   API trigger: `POST /api/users/language` (payload: `{ language }`) which sends the OTP.
    *   API validation: `POST /api/users/verify-language-otp` (payload: `{ otp }`) to confirm.
*   **API Integrations**:
    *   Change password: `POST /api/auth/change-password` (payload: `{ currentPassword, newPassword }`)
    *   Pending friend requests: `GET /api/users/me/requests`
    *   Accept request: `POST /api/users/accept-friend/:id`
    *   Decline request: `POST /api/users/decline-friend/:id`
    *   Global user search: `GET /api/users/search?q=query`
    *   Send request: `POST /api/users/friend-request/:id`

### 12. Leaderboards (`pages/Leaderboard.jsx`)
*   **State Hooks**: `leaderboard` (ranked lists of top contributors), `transfers` (history of point transfers).
*   **API Integrations**:
    *   Get rankings: `GET /api/rewards/leaderboard`
    *   Get transfer activity logs: `GET /api/rewards/transfers`

---

## 🎨 Styles & Themes (`ui-reference/index.css`)
If your team uses CSS variables or Tailwind utility classes:
*   The application currently utilizes CSS variables defined in `:root` inside `index.css` (such as colors like `--bg-primary: #0b0b1e`, gradients like `--gradient-primary`, and visual constants).
*   Your team should check `index.css` to see the classes currently styled (e.g. `.glass-card`, `.btn-primary`, `.btn-secondary`, `.points-display`, `.skeleton`, etc.) or replace it completely if they are introducing a brand new custom CSS stylesheet or framework like Tailwind CSS.
