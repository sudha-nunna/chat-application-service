/**
 * Server-Side Code RAG (Retrieval Augmented Generation) Engine
 * Processes multi-file project workspace files, ranks relevance against user prompts,
 * and prunes prompt context before sending to LLM backends (Ollama, OpenAI, Gemini, Claude).
 */

const acorn = require("acorn");
const jsx = require("acorn-jsx");
const JSXParser = acorn.Parser.extend(jsx());

const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
  "between", "both", "but", "by", "can", "did", "do", "does", "doing", "don't",
  "down", "during", "each", "few", "for", "from", "further", "had", "has", "have",
  "having", "he", "her", "here", "his", "how", "i", "if", "in", "into", "is", "it",
  "its", "me", "more", "most", "my", "no", "nor", "not", "of", "off", "on", "once",
  "only", "or", "other", "our", "ours", "out", "over", "own", "same", "she", "should",
  "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "then",
  "there", "these", "they", "this", "those", "through", "to", "too", "under", "until",
  "up", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who",
  "whom", "why", "will", "with", "would", "you", "your", "yours", "please", "make", "change"
]);

function tokenizeQuery(query) {
  if (!query || typeof query !== "string") return [];
  return query
    .toLowerCase()
    .replace(/[^a-z0-9_$]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Extracts imports from code string
 */
function extractImports(codeStr) {
  const imports = new Set();
  if (!codeStr || typeof codeStr !== "string") return imports;

  const importRegex = /(?:import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/g;
  let match;
  while ((match = importRegex.exec(codeStr)) !== null) {
    const spec = match[1] || match[2];
    if (spec) imports.add(spec);
  }
  return imports;
}

/**
 * Selects relevant project files for multi-file LLM generation prompts
 *
 * @param {Array<{ path: string, content: string }>} files - Array of project files
 * @param {string} promptText - User chat prompt
 * @param {number} maxTokenBudget - Max token budget (default 16000)
 */
function selectRelevantServerFiles(files, promptText, maxTokenBudget = 16000) {
  if (!Array.isArray(files) || files.length <= 1) {
    return files || [];
  }

  const queryTokens = tokenizeQuery(promptText);
  const fileScores = new Map();
  const fileMap = new Map();
  const N = files.length;
  const df = new Map();
  const tfList = [];
  let sumDocLength = 0;

  // Calculate TF and DF for BM25
  files.forEach((file) => {
    fileMap.set(file.path, file);
    const contentLower = (file.content || "").toLowerCase();
    const tokens = tokenizeQuery(contentLower + " " + file.path);
    const tf = new Map();
    tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
    tfList.push(tf);
    
    const uniqueTokens = new Set(tokens);
    uniqueTokens.forEach(t => df.set(t, (df.get(t) || 0) + 1));
    sumDocLength += tokens.length;
  });

  const avgDocLength = sumDocLength / Math.max(N, 1);
  const k1 = 1.2;
  const b = 0.75;

  files.forEach((file, index) => {
    const normPath = file.path.toLowerCase();
    let score = 0;

    // Entry point priority
    if (normPath.includes("app.") || normPath.includes("index.") || normPath.includes("package.json") || normPath.includes("main.")) {
      score += 6.0;
    }

    // Path keyword match
    queryTokens.forEach((token) => {
      if (normPath.includes(token)) {
        score += 10.0;
      }
    });

    // BM25 Content Scoring
    const docLength = [...tfList[index].values()].reduce((val, acc) => acc + val, 0);
    queryTokens.forEach((token) => {
      const qTf = tfList[index].get(token) || 0;
      if (qTf > 0) {
        const qDf = df.get(token) || 0;
        const idf = Math.log((N - qDf + 0.5) / (qDf + 0.5) + 1);
        const tfNorm = (qTf * (k1 + 1)) / (qTf + k1 * (1 - b + b * (docLength / Math.max(avgDocLength, 1))));
        score += idf * tfNorm;
      }
    });

    fileScores.set(file.path, score);
  });

  // 1-hop Dependency Expansion
  const sortedInitial = Array.from(fileScores.entries()).sort((a, b) => b[1] - a[1]);
  const topPaths = sortedInitial.slice(0, 4).map(([p]) => p);

  topPaths.forEach((path) => {
    const file = fileMap.get(path);
    if (!file) return;
    const imports = extractImports(file.content);

    files.forEach((otherFile) => {
      if (otherFile.path === path) return;
      imports.forEach((imp) => {
        if (otherFile.path.includes(imp.replace(/^\.\//, "").replace(/^\//, ""))) {
          const current = fileScores.get(otherFile.path) || 0;
          fileScores.set(otherFile.path, current + 4.0);
        }
      });
    });
  });

  // Budget selection
  const sortedFinal = Array.from(fileScores.entries()).sort((a, b) => b[1] - a[1]);
  const selected = [];
  let currentTokens = 0;

  for (const [path] of sortedFinal) {
    const file = fileMap.get(path);
    if (!file) continue;

    const fileTokens = Math.ceil((file.content || "").length / 4);
    if (currentTokens + fileTokens <= maxTokenBudget || selected.length === 0) {
      selected.push(file);
      currentTokens += fileTokens;
    }
  }

  return selected;
}

/**
 * Formats pruned project files into markdown code fences for system/user prompts
 */
function formatFilesForPrompt(files) {
  if (!Array.isArray(files) || files.length === 0) return "";
  return files
    .map((f) => `### File: ${f.path}\n\`\`\`\n${f.content || ""}\n\`\`\``)
    .join("\n\n");
}

/**
 * AST Validation Pipeline
 */
function validateAST(code, filePath) {
  if (!code) return { valid: true };
  try {
    JSXParser.parse(code, { sourceType: "module", ecmaVersion: "latest" });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message, path: filePath };
  }
}

/**
 * Import Validation Pipeline
 */
function validateImports(files) {
  if (!Array.isArray(files) || files.length === 0) return { valid: true };
  const filePaths = new Set(files.map(f => (f.path || "").toLowerCase()));
  const errors = [];
  
  files.forEach(file => {
    const imports = extractImports(file.content || "");
    imports.forEach(imp => {
      // Basic relative import check
      if (imp.startsWith(".")) {
        const cleanImp = imp.replace(/^\.\//, "").replace(/^\.\.\//, "").toLowerCase();
        // Allow extensionless matching
        const exists = Array.from(filePaths).some(p => p.includes(cleanImp));
        if (!exists) {
          errors.push({ file: file.path, missingImport: imp });
        }
      }
    });
  });
  
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

module.exports = {
  selectRelevantServerFiles,
  formatFilesForPrompt,
  tokenizeQuery,
  validateAST,
  validateImports
};
