/**
 * Postman Collection v2.0 / v2.1 JSON Parser Utility
 */

function parsePostmanUrl(urlObj) {
  if (!urlObj) return "";
  if (typeof urlObj === "string") return urlObj;
  if (urlObj.raw) return urlObj.raw;
  
  const protocol = urlObj.protocol ? `${urlObj.protocol}://` : "";
  const host = Array.isArray(urlObj.host) ? urlObj.host.join(".") : "";
  const path = Array.isArray(urlObj.path) ? "/" + urlObj.path.join("/") : "";
  return `${protocol}${host}${path}`;
}

function extractItemsRecursive(items, collectionName, resultList = []) {
  if (!Array.isArray(items)) return resultList;

  for (const item of items) {
    if (item.item && Array.isArray(item.item)) {
      // Folder item
      extractItemsRecursive(item.item, collectionName, resultList);
    } else if (item.request) {
      const req = item.request;
      const method = (req.method || "GET").toUpperCase();
      const url = parsePostmanUrl(req.url);

      const headers = Array.isArray(req.header)
        ? req.header.map(h => ({
            key: h.key || "",
            value: h.value || "",
            description: h.description || ""
          }))
        : [];

      const queryParams = req.url && Array.isArray(req.url.query)
        ? req.url.query.map(q => ({
            key: q.key || "",
            value: q.value || "",
            description: q.description || ""
          }))
        : [];

      let bodyData = { mode: "raw", raw: "" };
      if (req.body) {
        bodyData.mode = req.body.mode || "raw";
        bodyData.raw = req.body.raw || "";
      }

      resultList.push({
        collectionName,
        name: item.name || "API Endpoint",
        method,
        url,
        headers,
        queryParams,
        body: bodyData,
        description: item.description || req.description || "",
        tags: [method, collectionName].filter(Boolean)
      });
    }
  }

  return resultList;
}

function parsePostmanCollection(jsonInput) {
  try {
    const data = typeof jsonInput === "string" ? JSON.parse(jsonInput) : jsonInput;
    if (!data || (!data.info && !data.item)) {
      throw new Error("Invalid Postman collection format. Expected v2.0/v2.1 JSON schema.");
    }

    const collectionName = data.info?.name || "Postman Collection";
    const items = data.item || [];

    const endpoints = extractItemsRecursive(items, collectionName);
    return {
      success: true,
      collectionName,
      count: endpoints.length,
      endpoints
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      endpoints: []
    };
  }
}

module.exports = {
  parsePostmanCollection
};
