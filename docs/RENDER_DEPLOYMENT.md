# Deploying Backend & F5-TTS Voice Service to Render (Free Tier Guide)

This guide walks you through deploying the **Node.js Express Backend** to Render's Free Tier while hosting the **Python F5-TTS Voice Engine** independently (e.g. on Google Colab GPU or a separate Docker container).

---

## Architecture Overview

```
 ┌───────────────────────────┐           ┌────────────────────────────────┐
 ├   Node.js Backend         │   HTTP    │   Python F5-TTS Engine         │
 │   (Render Free Tier)      ├──────────►│   (Google Colab GPU / Docker)  │
 │   - Auth, Database, APIs  │  F5_URL   │   - Zero-Shot Voice Cloning    │
 └───────────────────────────┘           └────────────────────────────────┘
```

- **Node.js Express Service**: Deployed on **Render Free Web Service** (~150 MB RAM, 0.1 CPU).
- **Python F5-TTS Engine**: Hosted externally on **Google Colab Free T4 GPU** (or Docker/Modal/HuggingFace) because PyTorch requires >1.5 GB RAM.

---

## Step 1: Deploy Node.js Backend on Render

1. Push your repository to **GitHub / GitLab**.
2. Go to [Render Dashboard](https://dashboard.render.com/) and click **New +** -> **Blueprint**.
3. Connect your repository. Render will automatically detect the [`render.yaml`](../render.yaml) file.
4. Click **Apply**.

### Environment Variables on Render

In your Render Service Dashboard -> **Environment**:

| Environment Variable | Description / Value |
| :--- | :--- |
| `NODE_ENV` | `production` |
| `PORT` | `5000` |
| `MONGODB_URI` | Your MongoDB Atlas Connection String (`mongodb+srv://...`) |
| `JWT_SECRET` | Secret key for authentication tokens |
| `F5_TTS_URL` | URL of your Python F5-TTS Service (e.g., `https://your-ngrok-url.ngrok-free.app` or Colab URL) |
| `ENABLE_EDGE_FALLBACK` | `true` (Ensures smooth speech generation fallback if F5 is offline) |

---

## Step 2: Set Up Python F5-TTS Voice Engine

### Option A: Free Google Colab GPU (Recommended for Zero-Cost GPU)
1. Open the existing notebook [`colab/F5_TTS_Colab_GPU.ipynb`](../colab/F5_TTS_Colab_GPU.ipynb) in Google Colab.
2. Select **Runtime -> Change runtime type -> T4 GPU**.
3. Run all cells in the notebook.
4. Copy the generated public URL (e.g., `https://xxxx.ngrok-free.app` or `https://xxxx.loca.lt`).
5. Set `F5_TTS_URL` in your Render Environment Variables to this URL.

### Option B: Deploy Standalone Docker Service
1. Use the provided [`voice_engine_f5/Dockerfile`](../voice_engine_f5/Dockerfile) to build and deploy to Docker-capable hosts (Hugging Face Spaces, Modal, Render Starter GPU).
2. Set `F5_TTS_URL` in Node.js to your deployed server URL.

---

## Health Check & Verification

Once deployed:
- Visit `https://<your-render-app>.onrender.com/api/health` to check Node.js backend status.
- Test voice generation in your frontend. If `F5_TTS_URL` is configured, cloned voice will process via F5-TTS. If offline, it automatically falls back to Edge-TTS / Google-TTS.
