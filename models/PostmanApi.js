const mongoose = require("mongoose");

const postmanApiSchema = new mongoose.Schema(
  {
    botId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bot",
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    collectionName: {
      type: String,
      required: true
    },
    name: {
      type: String,
      required: true
    },
    method: {
      type: String,
      enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
      default: "GET",
      required: true
    },
    url: {
      type: String,
      required: true
    },
    headers: [
      {
        key: String,
        value: String,
        description: String
      }
    ],
    queryParams: [
      {
        key: String,
        value: String,
        description: String
      }
    ],
    body: {
      mode: {
        type: String,
        default: "raw"
      },
      raw: String,
      options: mongoose.Schema.Types.Mixed
    },
    description: {
      type: String,
      default: ""
    },
    tags: [
      {
        type: String
      }
    ]
  },
  {
    timestamps: true
  }
);

postmanApiSchema.index({ botId: 1, name: "text", url: "text", description: "text" });

module.exports = mongoose.model("PostmanApi", postmanApiSchema);
