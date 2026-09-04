const axios = require('axios');
const { getOllamaBaseUrl } = require('../utils/ollamaHelper');

exports.sendMessage = async (req, res) => {
    try {
        const { message, model } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, message: "Message text is required." });
        }

        const ollamaBaseUrl = getOllamaBaseUrl();
        const requestPayload = {
            model: model || process.env.OLLAMA_MODEL || 'qwen2.5:1.5b', 
            prompt: message,
            stream: false
        };

        console.log(`\n================================================================================`);
        console.log(`📤 [AI REQUEST -> OLLAMA (STANDALONE CONTROLLER)]`);
        console.log(`  • Endpoint: ${ollamaBaseUrl}/api/generate`);
        console.log(`  • Payload:`);
        console.log(JSON.stringify(requestPayload, null, 2));
        console.log(`================================================================================\n`);

        const response = await axios.post(`${ollamaBaseUrl}/api/generate`, requestPayload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json',
                'Accept-Encoding': 'identity' 
            }
        });

        console.log(`\n================================================================================`);
        console.log(`📥 [AI RESPONSE <- OLLAMA (STANDALONE CONTROLLER)]`);
        console.log(`  • Status:   ${response.status} OK`);
        console.log(`  • Response:`);
        console.log(JSON.stringify(response.data, null, 2));
        console.log(`================================================================================\n`);

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