
const axios = require('axios');

const OLLAMA_BASE_URL = process.env.OLLAMA_HOST_URL 
  ? process.env.OLLAMA_HOST_URL.trim().replace(/\/$/, "") 
  : "http://127.0.0.1:11434";

exports.sendMessage = async (req, res) => {
    try {
        const { message, model } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, message: "Message text is required." });
        }

        console.log(`Sending API Request to: ${OLLAMA_BASE_URL}/api/generate`);

        const response = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
            model: model || 'qwen2.5:1.5b', 
            prompt: message,
            stream: false
        }, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json',
                // CRITICAL: Force disables Axios default node auto-compression fingerprints
                'Accept-Encoding': 'identity' 
            }
        });

        return res.status(200).json({
            success: true,
            data: response.data
        });

    } catch (error) {
        console.error("Ollama Pipeline Error Handling Vector Layer Failure:", error.message);
        
        let statusCode = 500;
        let details = 'Internal server failure execution layer.';

        if (error.response) {
            statusCode = error.response.status;
            details = error.response.data;
            console.error(`Cloudflare Gateway Returned Status: ${statusCode}`);
        }

        return res.status(statusCode).json({
            success: false,
            error: error.message,
            details: details
        });
    }
};