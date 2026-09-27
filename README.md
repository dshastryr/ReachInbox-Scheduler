# ReachInbox Email Scheduler

A full-stack email scheduling application that accepts email send requests, schedules them using BullMQ and Redis, delivers emails through SMTP, and provides a dashboard for monitoring scheduled, sent, failed, and queued emails.

The system is designed to persist scheduled jobs across backend/worker restarts and supports Google authentication, Slack notifications, Elasticsearch search, sender-level rate limiting, and minimum send-spacing controls.

---

## 1. Features

### Authentication

- Google OAuth 2.0 login.
- Redis-backed, single-use OAuth state.
- HttpOnly Redis-backed sessions.
- Authenticated API requests are user-scoped.
- Users can log out and revoke their session.

### Email Scheduling

- Compose and schedule emails for a future time.
- Supports:
  - Sender selection
  - Campaign name
  - Subject
  - Body
  - Multiple recipients
  - CSV/TXT recipient import
  - Minimum send delay
  - Hourly sending limit
- Duplicate recipients are removed.
- Invalid email addresses are reported.
- Scheduling creates persistent database records and BullMQ jobs.

### Queue and Worker

- BullMQ is used for persistent job scheduling.
- Redis stores BullMQ queue state and delayed jobs.
- Worker concurrency is configurable.
- Scheduled jobs survive backend and worker restarts.
- Email jobs move through states such as:
  - `SCHEDULED`
  - `PROCESSING`
  - `SENT`
  - `FAILED`

### Rate Limiting

- Sender-level hourly limits.
- Minimum spacing between emails from the same sender.
- Redis Lua-based atomic reservation prevents concurrent workers from bypassing limits.
- A spacing deferral does not consume hourly quota.
- Deferred jobs remain scheduled and are rescheduled through BullMQ.
- Rate-limit notifications can be sent to Slack.

### Email Delivery

- SMTP delivery through Ethereal Email for development/testing.
- Successful delivery is persisted before Elasticsearch indexing.
- SMTP failures are recorded as failed jobs with failure reasons.
- Elasticsearch failure does not cause an already-sent email to be sent again.

### Slack Integration

- Per-user Slack OAuth connection.
- Slack connection status can be viewed from the integrations section.
- Rate-limit notifications are sent to a configured Slack channel.
- Slack notifications do not cause an email job to fail if Slack is unavailable.
- Slack OAuth uses the `chat:write` scope.

### Elasticsearch

- Successful email records are indexed in Elasticsearch.
- Search supports subject and recipient text.
- Search results are scoped to the authenticated user.
- Duplicate indexing of the same email job is prevented using its UUID.

### Queue Dashboard

Bull Board is available at:

`http://localhost:5000/admin/queues`

The dashboard is:

- Authenticated
- Read-only
- Connected to the existing `email-scheduler` BullMQ queue

It displays queue states such as:

- Waiting
- Active
- Delayed
- Completed
- Failed

---

## 2. Architecture

```text
                         ┌─────────────────────┐
                         │      Frontend       │
                         │   localhost:5173    │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │   Express Backend   │
                         │   localhost:5000    │
                         └──────┬──────┬───────┘
                                │      │
                 ┌──────────────┘      └──────────────┐
                 ▼                                    ▼
        ┌─────────────────┐                  ┌─────────────────┐
        │   PostgreSQL    │                  │      Redis      │
        │ Users/Campaigns │                  │ BullMQ/Sessions │
        │   Email Jobs    │                  │ Rate Limiting   │
        └─────────────────┘                  └────────┬────────┘
                                                       │
                                                       ▼
                                             ┌─────────────────┐
                                             │  BullMQ Worker  │
                                             └────────┬────────┘
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │   SMTP/Ethereal │
                                             └─────────────────┘
                                                      │
                                                      ▼
                                                   Email

        Successful delivery
                 │
                 ▼
        ┌─────────────────┐
        │  Elasticsearch  │
        │ Email search    │
        └─────────────────┘

        Rate-limit events
                 │
                 ▼
        ┌─────────────────┐
        │      Slack      │
        │   Notification  │
        └─────────────────┘
```

---

## 3. Technology Stack

### Frontend
- HTML
- CSS
- JavaScript

### Backend
- Node.js
- TypeScript
- Express
- Prisma

### Data and Infrastructure
- PostgreSQL
- Redis
- BullMQ
- Elasticsearch

### Authentication / Integrations
- Google OAuth 2.0
- Slack OAuth
- Ethereal Email SMTP

### Queue Dashboard
- Bull Board

### Development
- Docker Compose
- npm
- TypeScript
- tsx

---

## 4. Project Structure

```text
ReachInbox-Scheduler/
│
├── backend/
│   ├── src/
│   │   ├── lib/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── workers/
│   │   └── scripts/
│   ├── prisma/
│   ├── package.json
│   └── .env.example
│
├── frontend/
│   ├── src/
│   ├── test/
│   └── package.json
│
├── docker-compose.yml
└── README.md
```

---

## 5. Prerequisites

Install:

- Node.js
- npm
- Docker Desktop
- Git

The project uses Docker Compose for the local PostgreSQL, Redis, and Elasticsearch services.

---

## 6. Start Infrastructure

From the project root:

```bash
docker-compose up -d
```

Check the containers:

```bash
docker-compose ps
```

The application requires:

- PostgreSQL
- Redis
- Elasticsearch

Redis is configured with:

```text
maxmemory-policy noeviction
```

This is required for reliable BullMQ operation.

---

## 7. Backend Setup

Open a terminal:

```bash
cd backend
npm install
```

Create:

```text
backend/.env
```

using:

```text
backend/.env.example
```

as the template.

Run Prisma migrations:

```bash
npx prisma migrate dev
```

Build the backend:

```bash
npm run build
```

Start the development server:

```bash
npm run dev
```

Backend:

`http://localhost:5000`

Health check:

`http://localhost:5000/health`

---

## 8. Start the Worker

Open another terminal:

```bash
cd backend
npm run worker
```

The worker processes scheduled BullMQ email jobs.

Keep the worker running while testing scheduled email delivery.

---

## 9. Frontend Setup

Open another terminal:

```bash
cd frontend
npm install
npm run dev
```

Frontend:

`http://localhost:5173`

---

## 10. Environment Variables

The backend `.env` contains configuration for the application.

Important variables include:

### Database
- `DATABASE_URL`

### Redis
Redis connection configuration used by BullMQ and application services.

### Elasticsearch
Elasticsearch connection configuration.

### Google OAuth
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`

For local development, the Google callback is:

`http://localhost:5000/api/auth/google/callback`

### Frontend
```text
FRONTEND_URL=http://localhost:5173
```

### Slack OAuth
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_REDIRECT_URI`
- `SLACK_NOTIFICATION_CHANNEL_ID`

Local Slack callback:

`http://localhost:5000/api/slack/callback`

### SMTP

Configure the sender's SMTP credentials through the application's sender configuration.

For development testing, Ethereal Email can be used.

---

## 11. Google OAuth Setup

Create a Google OAuth client for a web application.

For local development configure:

**Authorized JavaScript origin:**
`http://localhost:5173`

and:

**Authorized redirect URI:**
`http://localhost:5000/api/auth/google/callback`

The application requests:

- `openid`
- `email`
- `profile`

Google access tokens are used for profile lookup and are not stored as persistent application credentials.

---

## 12. Slack Setup

Create a Slack application and enable OAuth.

The application requires:

- `chat:write`

Configure the redirect URI:

`http://localhost:5000/api/slack/callback`

Set:

`SLACK_NOTIFICATION_CHANNEL_ID`

to the ID of the Slack channel where notifications should be posted.

The Slack app must be installed in the workspace and have access to the configured channel.

---

## 13. Scheduling an Email

1. Sign in with Google.
2. Configure/select an SMTP sender.
3. Open Compose.
4. Enter recipients or upload a CSV/TXT file.
5. Enter subject and body.
6. Configure:
   - Start time
   - Minimum delay
   - Hourly limit
7. Click Schedule emails.

The backend creates the campaign and email jobs atomically in PostgreSQL and enqueues deterministic BullMQ jobs.

After successful scheduling:

- The compose form is reset.
- The recipient list is cleared.
- Scheduled email data is refreshed.

If scheduling fails, the draft remains available for retry.

---

## 14. Recipient Import

CSV and TXT recipient files are processed in the browser.

The parser:

- Normalizes addresses.
- Removes duplicates.
- Ignores blank content.
- Counts malformed addresses.
- Shows the valid unique recipient count before scheduling.

---

## 15. Rate Limiting and Send Spacing

The worker reserves sender capacity in Redis before SMTP delivery.

Two limits are enforced:

### Hourly limit

The campaign's `hourlyLimit` controls the maximum number of sends allowed for the sender during a UTC-hour window.

### Minimum delay

The campaign's `delayMs` specifies the minimum spacing between actual sends in milliseconds.

Redis performs the reservation atomically so concurrent workers cannot bypass the limits.

When a job cannot send immediately:

```text
EmailJob → SCHEDULED
        ↓
BullMQ delayed job
        ↓
Future processing
```

A deferral does not count as a failed attempt.

---

## 16. Slack Rate-Limit Notifications

When an hourly sender limit is reached, the worker can send a Slack notification.

Notifications are deduplicated using a Redis sender/hour key so concurrent rate-limit events do not produce multiple alerts for the same sender in the same UTC hour.

Minimum-delay deferrals do not generate Slack rate-limit alerts.

A Slack API failure does not fail or retry the email job.

---

## 17. Email Status and History

The application tracks:

- `SCHEDULED`
- `PROCESSING`
- `SENT`
- `FAILED`

### Scheduled Emails

Displays:

- Scheduled jobs
- Processing jobs

### Sent Emails

Displays successful delivery history.

### Failed Emails

Displays:

- Recipient
- Subject
- Failure time
- Failure reason

Email list queries are authenticated and user-scoped.

Client-provided user IDs are not trusted for ownership checks.

---

## 18. Elasticsearch Search

Successful email delivery is indexed in Elasticsearch.

Search can use:

- Recipient
- Subject

Search requests require authentication and are scoped to the authenticated user.

Email jobs are indexed using their UUID, preventing duplicate documents for the same job.

If Elasticsearch is unavailable after SMTP delivery:

```text
SMTP delivery → SENT
             ↓
      Elasticsearch failure
```

The email remains `SENT` and is not delivered again.

---

## 19. Bull Board Queue Dashboard

Open:

`http://localhost:5000/admin/queues`

The dashboard displays the existing:

`email-scheduler`

BullMQ queue.

The dashboard is authenticated and read-only.

---

## 20. Restart Persistence

Scheduled BullMQ jobs are stored in Redis.

The application was verified with the following flow:

```text
Schedule email
      ↓
Stop backend + worker
      ↓
Redis remains running
      ↓
Restart backend + worker
      ↓
BullMQ recovers scheduled job
      ↓
Worker processes email
      ↓
Email delivered
      ↓
Slack notification received
      ↓
Email appears in Sent Emails
```

This confirms that scheduled jobs survive backend and worker restarts.

---

## 21. Testing

### Backend build
```bash
cd backend
npm run build
```

### Frontend tests
```bash
cd frontend
npm test
```

### Backend authentication/scheduling tests
```bash
npm run auth-scheduling:test
```

### Google OAuth tests
```bash
npm run google:test
```

### Slack tests
```bash
npm run slack:test
```

### Email delay/rate-limit tests
```bash
npm run delay:test
npm run rate-limit:test
```

### Elasticsearch tests
```bash
npm run elasticsearch:test
```

### Queue dashboard tests
```bash
npm run queue-dashboard:test
```

The focused automated tests cover authentication, scheduling, BullMQ enqueueing, rate limiting, delayed jobs, Slack behavior, Elasticsearch indexing/search, worker delivery, SMTP failure handling, and queue dashboard access.

---

## 22. Manual Verification

The following functionality has also been manually verified during development:

- Google sign-in
- Email scheduling through the browser
- Ethereal email delivery
- Sent Emails display
- Slack OAuth connection
- Real Slack notification delivery
- Backend and worker restart persistence
- Scheduled job recovery after restart

---

## 23. Failure Handling

### SMTP failure

SMTP errors cause the email job to be recorded as `FAILED` with the failure reason.

### Slack failure

Slack notification failures are isolated from email delivery.

A Slack failure does not cause the successfully delivered email to fail or be retried.

### Elasticsearch failure

An Elasticsearch indexing failure does not cause a successfully sent email to be sent again.

### Rate-limit deferral

Rate-limited jobs remain scheduled and are moved to a future BullMQ delay instead of being marked as failed.

---

## 24. Security Considerations

- OAuth states are stored in Redis and consumed only once.
- OAuth state has a limited lifetime.
- Sessions use HttpOnly cookies.
- User ownership is resolved server-side.
- Client-provided user IDs are not trusted for authorization.
- Slack access tokens are not exposed by the status endpoint.
- Queue dashboard access requires authentication.
- The queue dashboard is read-only.

For production deployment, additional role-based authorization should be considered for the global queue dashboard.

---

## 25. Known Limitations

- The queue dashboard currently does not have a separate admin role. Authenticated users may view the global queue status.
- Ethereal Email is intended for development/testing rather than production email delivery.
- Real third-party OAuth credentials are required for Google and Slack integrations.
- Production deployment should use HTTPS.
- Redis should use `maxmemory-policy noeviction`.
- The current prototype is intended for local/development deployment unless additional production infrastructure and security controls are added.

---

## 26. Quick Start

From the project root:

```bash
docker-compose up -d
```

**Terminal 1:**
```bash
cd backend
npm install
npm run dev
```

**Terminal 2:**
```bash
cd backend
npm run worker
```

**Terminal 3:**
```bash
cd frontend
npm install
npm run dev
```

Then open:

`http://localhost:5173`

Sign in with Google, configure an SMTP sender, and schedule an email.

---

## 27. Verification Summary

The implementation has been tested across the main application paths:

| Feature | Status |
|---|---|
| Google OAuth | ✓ |
| Email scheduling | ✓ |
| BullMQ queue | ✓ |
| Redis persistence | ✓ |
| Worker processing | ✓ |
| Ethereal SMTP delivery | ✓ |
| Sent/Failed history | ✓ |
| Elasticsearch search | ✓ |
| Rate limiting | ✓ |
| Minimum send spacing | ✓ |
| Slack OAuth | ✓ |
| Slack notification | ✓ |
| Queue dashboard | ✓ |
| Restart persistence | ✓ |

---

## License

This project was developed as part of the ReachInbox email scheduler assignment.
