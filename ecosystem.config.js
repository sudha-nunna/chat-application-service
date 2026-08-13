module.exports = {
  apps: [
    {
      name: "chat-backend",
      script: "server.js",
      cwd: "./",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 5000
      },
      out_file: "./logs/backend-out.log",
      error_file: "./logs/backend-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z"
    },
    {
      name: "voice-engine",
      script: "voice_engine/f5_service.py",
      interpreter: "./venv/Scripts/python.exe",
      cwd: "./",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "4G",
      env: {
        PYTHONUNBUFFERED: "1",
        PORT: 8000
      },
      out_file: "./logs/voice-engine-out.log",
      error_file: "./logs/voice-engine-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z"
    }
  ]
};