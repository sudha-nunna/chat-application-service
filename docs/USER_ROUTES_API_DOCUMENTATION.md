# 📘 User API Integration Guide (Frontend & Mobile App)

This document provides exact, production-ready specifications for all **User-Related Routes** in the backend application. Base URL for local development is `http://localhost:5000`.

---

## 🔑 Authentication & Headers

All protected endpoints require an **Authorization Header** containing a valid JWT Token obtained upon Registration/Login:

```http
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

---

## 1. 🚀 Registration & Welcome Credits Allocation

### 1.1 Google OAuth Registration & Login
When a new user registers via Google OAuth, the system automatically creates their account, grants **100 Free Welcome Credits (Signup Bonus)**, sets `signupBonusGranted: true`, and logs an official `CreditTransaction` of type `admin_grant`.

* **HTTP Method**: `POST`
* **Full Endpoint URL**: `http://localhost:5000/auth/google`
* **Headers**: `Content-Type: application/json`
* **Authentication**: None (Public)

#### Request Body
```json
{
  "token": "YOUR_GOOGLE_ID_TOKEN_STRING"
}
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "65f1a2b3c4d5e6f7a8b9c0d1",
    "name": "Alex Smith",
    "email": "alex.smith@example.com",
    "profilePic": "https://lh3.googleusercontent.com/a/...",
    "avatarUrl": "https://lh3.googleusercontent.com/a/...",
    "avatarImageId": null,
    "botName": "",
    "plan": "free",
    "isProfileSetup": false,
    "isAvatarSetup": false,
    "isVoiceSetup": false,
    "hasAvatar": false,
    "hasVoice": false,
    "isAvatarUploaded": false,
    "isVoiceUploaded": false,
    "voiceSampleId": null,
    "voiceSampleUrl": ""
  }
}
```

#### 💡 Registration Credit Logic:
* **Initial Credit Balance**: `100.00` AI Credits automatically assigned.
* **Initial Plan**: `"free"` Tier.
* **Daily Message Limit**: `50` messages per day for Free Tier.
* **Paid Status**: `isPaidUser: false` (until first credit package purchase).
* **Welcome Credit Ledger**: Recorded in `CreditTransaction` collection with description `"100 Free Welcome Credits (Signup Bonus)"`.

---

### 1.2 Google OAuth Callback Registration
Alternative Google OAuth authorization code exchange endpoint.

* **HTTP Method**: `POST`
* **Full Endpoint URL**: `http://localhost:5000/auth/google/callback`
* **Headers**: `Content-Type: application/json`
* **Authentication**: None (Public)

#### Request Body
```json
{
  "code": "4/0AeaYSHC...",
  "redirectUri": "http://localhost:5173/auth/google/callback"
}
```

#### Response (`200 OK`)
Returns JWT token and user profile object.

---

### 1.3 Get Current User Profile & Wallet Details
Retrieves authenticated user details including credit balance, bot name, active voice/avatar assets, and setup completion status.

* **HTTP Method**: `GET`
* **Full Endpoint URL**: `http://localhost:5000/auth/me`
* **Headers**: `Authorization: Bearer <jwt_token>`
* **Authentication**: Required (`protect`)

#### Response (`200 OK`)
```json
{
  "success": true,
  "user": {
    "id": "65f1a2b3c4d5e6f7a8b9c0d1",
    "name": "Alex Smith",
    "email": "alex.smith@example.com",
    "profilePic": "http://localhost:5000/bots/media/65f2...",
    "avatarUrl": "http://localhost:5000/bots/media/65f2...",
    "avatarImageId": "65f2a1...",
    "avatarId": "65f2a1...",
    "image": "http://localhost:5000/bots/media/65f2...",
    "botName": "Maya AI",
    "authType": "google",
    "plan": "free",
    "isProfileSetup": true,
    "isAvatarSetup": true,
    "isVoiceSetup": true,
    "hasAvatar": true,
    "hasVoice": true,
    "isAvatarUploaded": true,
    "isVoiceUploaded": true,
    "voiceSampleId": "65f3b2...",
    "voiceSampleUrl": "http://localhost:5000/bots/media/65f3...",
    "createdAt": "2026-09-01T12:00:00.000Z",
    "updatedAt": "2026-09-02T10:00:00.000Z"
  }
}
```

---

## 2. 💳 User Credits Management & Purchasing

### 2.1 Get Available Credit Top-Up Packages
Fetches all active credit top-up packages configured in MongoDB. Render this list on the Credit Store / Top-Up screen in FE & Mobile App.

* **HTTP Method**: `GET`
* **Full Endpoint URL**: `http://localhost:5000/credits/packs`
* **Headers**: `Authorization: Bearer <jwt_token>`
* **Authentication**: Required (`protect`)

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": [
    {
      "id": "starter_pack",
      "name": "Starter Pack",
      "credits": 500,
      "price": "$4.99",
      "priceUsd": 4.99,
      "popular": false,
      "description": "500 AI Credits Package",
      "features": [
        "500 AI Credits",
        "Unlocks Paid Tier (No daily message cap)",
        "Priority Cluster Routing",
        "All Online AI Models Included"
      ]
    },
    {
      "id": "pro_pack",
      "name": "Pro Power Pack",
      "credits": 2500,
      "price": "$19.99",
      "priceUsd": 19.99,
      "popular": true,
      "description": "2,500 AI Credits Package",
      "features": [
        "2,500 AI Credits",
        "Unlocks Paid Tier (No daily message cap)",
        "Priority Cluster Routing",
        "All Online AI Models Included"
      ]
    }
  ]
}
```

---

### 2.2 Purchase / Top-Up Credits
Allows users to buy credit packages. Upon successful purchase, the system immediately credits the user's wallet, updates `isPaidUser = true` (removing daily message caps), and creates a `CreditTransaction` log.

* **HTTP Method**: `POST`
* **Full Endpoint URL**: `http://localhost:5000/credits/purchase`
* **Headers**: `Authorization: Bearer <jwt_token>`, `Content-Type: application/json`
* **Authentication**: Required (`protect`)

#### Request Body
```json
{
  "packId": "starter_pack"
}
```
*(Note: `packId` accepts either the plan `key` e.g., `"starter_pack"` or MongoDB `_id`)*

#### Response (`200 OK`)
```json
{
  "success": true,
  "message": "Successfully added 500 credits to your wallet!",
  "data": {
    "creditsAdded": 500,
    "newBalance": 600,
    "isPaidUser": true,
    "transactionId": "65f4c3d2e1f0a9b8c7d6e5f4"
  }
}
```

---

## 3. 📊 Usage Limits, Metrics & Daily Allowances

### 3.1 Get User Usage Summary & Limits Dashboard
Fetches real-time credit balance, today's message and token usage, daily remaining message caps, model usage breakdown, and past 7 days usage history.

* **HTTP Method**: `GET`
* **Full Endpoint URL**: `http://localhost:5000/usage/summary`
* **Headers**: `Authorization: Bearer <jwt_token>`
* **Authentication**: Required (`protect`)

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "65f1a2b3c4d5e6f7a8b9c0d1",
      "name": "Alex Smith",
      "email": "alex.smith@example.com",
      "credits": 100,
      "isPaidUser": false,
      "plan": "Free Tier"
    },
    "plan": {
      "key": "free",
      "name": "FREE TIER",
      "maxMessagesPerDay": 50,
      "isPaidUser": false
    },
    "today": {
      "date": "2026-09-02",
      "messagesUsed": 12,
      "tokensUsed": 3450,
      "creditsUsed": 2.5,
      "messagesRemaining": 38
    },
    "lifetime": {
      "totalTokens": 28400,
      "totalCreditsUsed": 18.75,
      "totalRequests": 85
    },
    "modelBreakdown": [
      {
        "modelId": "gemini-2.5-flash",
        "totalRequests": 50,
        "creditsUsed": 10.0,
        "promptTokens": 12000,
        "completionTokens": 8000,
        "totalTokens": 20000,
        "avgLatencyMs": 420
      },
      {
        "modelId": "llama3.2:3b",
        "totalRequests": 35,
        "creditsUsed": 8.75,
        "promptTokens": 5000,
        "completionTokens": 3400,
        "totalTokens": 8400,
        "avgLatencyMs": 680
      }
    ],
    "recentHistory": [
      {
        "date": "2026-09-01",
        "messagesUsedToday": 25,
        "tokensUsedToday": 8200,
        "creditsUsedToday": 5.0
      },
      {
        "date": "2026-09-02",
        "messagesUsedToday": 12,
        "tokensUsedToday": 3450,
        "creditsUsedToday": 2.5
      }
    ],
    "recentTransactions": [
      {
        "_id": "65f1a2...",
        "userId": "65f1a2...",
        "amount": 100,
        "type": "admin_grant",
        "description": "100 Free Welcome Credits (Signup Bonus)",
        "balanceAfter": 100,
        "createdAt": "2026-09-01T12:00:00.000Z"
      }
    ]
  }
}
```

#### 💡 Usage Limit Rules for FE/App:
* **Free Tier (`isPaidUser: false`)**:
  * Daily Cap: `50 messages / day` (resets daily at 00:00 UTC).
  * `messagesRemaining`: Numeric value (`50 - messagesUsed`).
* **Paid Tier (`isPaidUser: true`)**:
  * Daily Cap: Unlimited (`maxMessagesPerDay: -1`).
  * `messagesRemaining`: `"Unlimited"`.

---

### 3.2 Get Active User Subscription
* **HTTP Method**: `GET`
* **Full Endpoint URL**: `http://localhost:5000/subscription/me`
* **Headers**: `Authorization: Bearer <jwt_token>`
* **Authentication**: Required (`auth`)

#### Response (`200 OK`)
```json
{
  "success": true,
  "subscription": {
    "id": "sub_123456",
    "plan": "free",
    "status": "active",
    "currentPeriodEnd": "2026-10-01T00:00:00.000Z"
  }
}
```

---

## 4. 🤖 AI Models Catalog & Model Selection

### 4.1 Get All Available AI Models (For UI Selector Dropdown)
Reads available models dynamically from active system nodes. Returns pricing, speed tier, provider, and recommended status for rendering model selectors in FE & Mobile App.

* **HTTP Method**: `GET`
* **Full Endpoint URL**: `http://localhost:5000/models/available`
* **Headers**: Optional `Authorization: Bearer <jwt_token>`
* **Authentication**: Public / Optional

#### Response (`200 OK`)
```json
{
  "success": true,
  "total": 3,
  "models": [
    {
      "modelId": "gemini-2.5-flash",
      "displayName": "Gemini 2.5 Flash",
      "provider": "gemini",
      "serverName": "GEMINI_NODE_1",
      "serverId": "65f987654321fedcba098765",
      "serverFormat": "gemini",
      "modelsCount": 1,
      "tier": "FAST",
      "promptTokenCostPer1k": 0.05,
      "completionTokenCostPer1k": 0.1,
      "creditCost": 0.5,
      "minCreditCost": 0.5,
      "enabled": true,
      "recommended": true,
      "isOnline": true,
      "description": "Hosted on active server: GEMINI_NODE_1"
    },
    {
      "modelId": "zhipuai/glm-4-flash",
      "displayName": "Glm 4 Flash",
      "provider": "glm",
      "serverName": "GLM_NODE_1",
      "serverId": "65f987654321fedcba098766",
      "serverFormat": "glm",
      "modelsCount": 1,
      "tier": "FAST",
      "promptTokenCostPer1k": 0.05,
      "completionTokenCostPer1k": 0.1,
      "creditCost": 0.5,
      "minCreditCost": 0.5,
      "enabled": true,
      "recommended": false,
      "isOnline": true,
      "description": "Hosted on active server: GLM_NODE_1"
    },
    {
      "modelId": "llama3.2:3b",
      "displayName": "Llama3.2 3b",
      "provider": "openai",
      "serverName": "OLLAMA_NODE_1",
      "serverId": "65f987654321fedcba098767",
      "serverFormat": "openai",
      "modelsCount": 1,
      "tier": "FAST",
      "promptTokenCostPer1k": 0.05,
      "completionTokenCostPer1k": 0.1,
      "creditCost": 0.5,
      "minCreditCost": 0.5,
      "enabled": true,
      "recommended": false,
      "isOnline": true,
      "description": "Hosted on active server: OLLAMA_NODE_1"
    }
  ]
}
```

---

### 4.2 Selecting a Model for Chat Session / Execution
To select a model when starting a conversation or sending a message, pass the `model` or `modelId` string (obtained from `http://localhost:5000/models/available`) in the chat creation / message payload.

* **HTTP Method**: `POST`
* **Full Endpoint URL**: `http://localhost:5000/chats`
* **Headers**: `Authorization: Bearer <jwt_token>`, `Content-Type: application/json`
* **Authentication**: Required (`protect`)

#### Request Body
```json
{
  "title": "General AI Discussion",
  "model": "gemini-2.5-flash",
  "modelId": "gemini-2.5-flash"
}
```

#### Response (`201 Created`)
```json
{
  "success": true,
  "chat": {
    "_id": "65f5e4d3c2b1a09876543210",
    "userId": "65f1a2b3c4d5e6f7a8b9c0d1",
    "title": "General AI Discussion",
    "model": "gemini-2.5-flash",
    "createdAt": "2026-09-02T10:15:00.000Z"
  }
}
```

---

## 📌 Summary Table for Quick Reference

| Feature | HTTP Method | Full Endpoint URL | Auth Required | Description |
| :--- | :---: | :--- | :---: | :--- |
| **Registration + Welcome Credits** | `POST` | `http://localhost:5000/auth/google` | ❌ No | Creates account + grants **100 Free Credits** |
| **Google Auth Callback** | `POST` | `http://localhost:5000/auth/google/callback` | ❌ No | Exchange auth code + grant welcome credits |
| **User Profile & Balance** | `GET` | `http://localhost:5000/auth/me` | 🔑 Bearer | Get user profile, credits, bot & setup status |
| **Credit Packages** | `GET` | `http://localhost:5000/credits/packs` | 🔑 Bearer | List available credit top-up packages |
| **Purchase Credits** | `POST` | `http://localhost:5000/credits/purchase` | 🔑 Bearer | Top up user credits & unlock paid status |
| **Usage Summary & Limits** | `GET` | `http://localhost:5000/usage/summary` | 🔑 Bearer | Get today's usage, caps, breakdown & logs |
| **Get Available AI Models** | `GET` | `http://localhost:5000/models/available` | 🌐 Optional | Get all active models for UI selector |
| **Select Model for Chat** | `POST` | `http://localhost:5000/chats` | 🔑 Bearer | Start chat session with chosen `modelId` |

---

*Document prepared for Frontend (Web) and Mobile App (iOS / Android) Engineering Teams.*
