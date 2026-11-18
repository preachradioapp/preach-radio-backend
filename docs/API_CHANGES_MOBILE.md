# API changes affecting the mobile apps

Branch: `fix/dashboard-api-sync`. Response envelopes (`{ success, message, data }`) and existing field names are unchanged unless listed here.

## Action required

| # | Endpoint | Change | What the app must do |
|---|---|---|---|
| 1 | `GET /normal-user/get-all-user` | Now requires a token (roles: user, admin, superAdmin). It was public and exposed every user's email and phone. | Send `Authorization`. A **creator** account now gets `403` — tell us if the creator app calls this. |
| 2 | `GET /podcast/get-single/:id` | The full `likers` array is no longer returned (it leaked every user who liked the podcast). New fields: `isLike`, `isBookmark`. When a token is sent, `likers` contains **only the caller's own entry** if they liked it, otherwise `[]`. | **Send the `Authorization` header** on this call (it's optional, but without it `isLike`/`isBookmark` are always `false`). Prefer `isLike` over `likers`. Existing `likers.some(l => l.user === myProfileId)` checks keep working. |
| 3 | `POST /podcast/create` | Validation is stricter: `duration` must be a number (it was already required by the database); `category`/`subCategory`/`station` must be valid ids; `coverImage`/`podcast_url` must be URLs; `coordinates` must be `[lng (-180..180), lat (-90..90)]`; `title` ≤ 300, `description` ≤ 10000, `tags` ≤ 50 items. | Make sure the creator upload sends `duration` and well-formed values. Invalid input now returns **400** with a readable `message` (it used to be 500). |
| 4 | Any endpoint that returns a podcast | Admins can now **hide** a podcast. Hidden podcasts disappear from every list, feed and search, and `get-single` returns **404**. Populated references (e.g. bookmarks, watch history) return `podcast: null`. | Handle `podcast: null` in bookmark and history lists (deleted podcasts already behave this way), and handle 404 on the detail screen. |
| 5 | All authenticated endpoints | A signed-in user calling a route their role can't use now gets **403** (`"You do not have permission…"`) instead of 401. **401 now means only** "token missing, invalid or expired". | If the app logs out on 401, nothing to do — it no longer logs users out when the problem is a missing permission. Don't treat 403 as a logout. |
| 6 | `GET /podcast/my-podcasts` (creator app) | **Bug fix with a visible effect:** this endpoint always returned the *station's* podcasts, even to creators, because the role check never ran. Creators now get **their own** podcasts. | Re-test the creator's "My podcasts" screen. If the app filtered the old response client-side to work around the bug, remove that. |
| 7 | `POST /podcast/create` (creator app) | Creators whose account is **not yet approved** now get `403` (`"Your creator account is waiting for approval"`). Previously pending creators could publish publicly. The owner is always set by the server: `creator`/`station` in the body are ignored. | Show the pending-approval message (or hide the upload button for unapproved creators). |
| 9 | `POST /podcast/create` and every endpoint that returns a podcast | The **cover image is now optional**. A podcast or clip may be published without `coverImage` (or `podcast_cover` file), and responses then have **no `coverImage` field** (or `null`). | Make the cover optional in the creator upload form. Everywhere a cover is shown, fall back to a placeholder when `coverImage` is missing (for video clips, the video's first frame works well). Don't assume it's a string. |
| 8 | Account deletion (`DELETE` own account, admin delete, admin rejection of a creator) | Deleting or rejecting a **creator** now also deletes their podcasts, plus those podcasts' likes, bookmarks and album entries. Before, their podcasts stayed public with a dead `creator` reference. Self-deletion by a creator previously left the creator profile behind; it is now removed. | If the app warns before account deletion, mention that the creator's podcasts are deleted too. |

## New: Preach Clips (reels)

Clips are podcasts with `type: "clip"`, stored in the same collection, so likes, views, bookmarks, comments, reports and hide/publish all work the same way.

**Uploading a clip** — `POST /podcast/create`, same flow as an episode, plus:

| Field | Episode | Clip |
|---|---|---|
| `type` | `"episode"` (default when omitted) | `"clip"` — **required** to create a clip |
| `durationSeconds` | optional (recommended) | **required**, whole seconds, **≤ 120** |
| `location`, `address` | required (unchanged) | optional |
| `sourcePodcast` | not allowed | optional: id of the full episode the clip was cut from (must be an episode, not a clip) |
| `duration` | unchanged — still required, same format as today | same |

Errors return `400` with a readable message, e.g. `"Clips can be at most 2 minutes long"`.

**Reading clips**
- `GET /podcast/all?type=clip` lists clips; `?type=episode` lists full episodes only. With no `type`, all podcasts are returned (unchanged).
- `?reels=1` **still works** and means the same as `type=clip`. The same applies to `GET /podcast/my-podcasts?reels=1`.
- Responses include `type`, `durationSeconds` and `sourcePodcast` (an id in lists; on `get-single` an object `{ _id, title, coverImage, mediaType, duration, durationSeconds }` for a "Watch full message" button, or `null` if that episode was removed or hidden).
- **Older records** created before this change have no `type` field. They're still classified by the previous rule (`duration ≤ 60` for lists, `≤ 120` for the home "clips" row), so the reels feed looks the same as before. Treat a missing `type` as an episode when displaying a single item.

**What the app must do**
1. In the creator upload flow, add a Clip option that sends `type: "clip"` and `durationSeconds`. Check the 2-minute limit in the app before uploading, so users don't upload a long file only to have it rejected.
2. Send `durationSeconds` for episodes too. It is the unambiguous length and will replace `duration` once the old format question below is settled.
3. Optionally show "Watch full message" when a clip has a `sourcePodcast`.

## No action needed (behaviour fixes)

- **Likes** are stored in a new `likes` collection. `POST /podcast/like-unlike/:id` keeps the same response (`{ isLike }`), but rapid double-taps can no longer double-count, and `totalLikes` stays exact.
- **Station podcasts now include `station.donationLink`** (feed, detail, my-podcasts). The Station model stores the value as `donationUrl`, so the link that queries asked for was always missing and the donate button for station podcasts never had a link. Creator podcasts are unchanged (`creator.donationLink`).
- **Feed like/bookmark state updates immediately.** It was cached for up to 10 minutes after toggling.
- **New podcast fields** (additive): `mediaType` (`"audio" | "video"`) and `status` (`"published"`). The apps can use `mediaType` instead of guessing from the URL.
- `GET /podcast/all` caps `limit` at 100 per page.
- `get-single` responses for signed-in users are sent `Cache-Control: private` (personal data must not be cached by shared caches/CDNs).
- `DELETE /album/delete/:id` is now admin-only (any user could previously delete any album).
- `POST /generate-presigned-url` with missing fields returns `400` instead of hanging until the request times out.
- Search and list filters escape special characters, so searching `C++` or `(a+)+` is now a literal search, not a regex pattern.
- Notifications: search now matches `title`/`message`, and delete removes the right notification.

## Still open — needs a decision with the mobile team

- **`duration` unit.** The admin dashboard stores 4 min 07 s as `4.07` (minutes.seconds). But the old reels rule (`duration <= 60`) only makes sense in seconds. Which format does the creator app send, and how does the app display it? The new `durationSeconds` field avoids the question for new content. Once we know the old format, we can backfill `durationSeconds` (and `type`) for existing records and retire the legacy rule.
- **`POST /generate-presigned-url` has no authentication**, so anyone can request an upload URL to the S3 bucket. We'd like to require a token. Does the app always send one when uploading?

## Deployment order (backend)

1. Deploy this branch. New indexes build automatically on startup.
2. Immediately run the likes migration (idempotent, safe to re-run):
   ```bash
   node dist/scripts/migrate-podcast-likes.js --dry-run   # report only
   node dist/scripts/migrate-podcast-likes.js
   ```
   Until it runs, older likes still work for like/unlike, but don't show as "liked" in the feed.
