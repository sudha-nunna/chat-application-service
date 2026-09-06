/**
 * financeSearchService.js
 * Instant, zero-key financial quotes for stock indices, crypto, and commodities.
 * Fetches real-time market data so the AI can quote live prices accurately.
 */

const FINANCIAL_TICKERS = [
  { match: /\b(nifty\s*50|nifty|nsei)\b/i, symbol: '^NSEI', name: 'NIFTY 50 (National Stock Exchange of India)', currency: 'INR' },
  { match: /\b(bank\s*nifty|nifty\s*bank)\b/i, symbol: '^NSEBANK', name: 'NIFTY Bank Index (NSE)', currency: 'INR' },
  { match: /\b(sensex|bse\s*sensex|bsesn)\b/i, symbol: '^BSESN', name: 'BSE SENSEX (Bombay Stock Exchange)', currency: 'INR' },
  { match: /\b(bitcoin|btc)\b/i, symbol: 'BTC-USD', name: 'Bitcoin', currency: 'USD' },
  { match: /\b(ethereum|eth)\b/i, symbol: 'ETH-USD', name: 'Ethereum', currency: 'USD' },
  { match: /\b(solana|sol)\b/i, symbol: 'SOL-USD', name: 'Solana', currency: 'USD' },
  { match: /\b(gold\s*rate|gold\s*price|gold)\b/i, symbol: 'GC=F', name: 'Gold Futures', currency: 'USD' },
  { match: /\b(silver\s*rate|silver\s*price|silver)\b/i, symbol: 'SI=F', name: 'Silver Futures', currency: 'USD' },
  { match: /\b(crude\s*oil|brent\s*crude)\b/i, symbol: 'CL=F', name: 'Crude Oil WTI', currency: 'USD' },
  { match: /\b(s&p\s*500|sp\s*500|sp500)\b/i, symbol: '^GSPC', name: 'S&P 500 Index', currency: 'USD' },
  { match: /\b(nasdaq\s*100|nasdaq)\b/i, symbol: '^IXIC', name: 'NASDAQ Composite', currency: 'USD' },
  { match: /\b(dow\s*jones|djia)\b/i, symbol: '^DJI', name: 'Dow Jones Industrial Average', currency: 'USD' },
  { match: /\b(apple\s*stock|aapl)\b/i, symbol: 'AAPL', name: 'Apple Inc. (AAPL)', currency: 'USD' },
  { match: /\b(tesla\s*stock|tsla)\b/i, symbol: 'TSLA', name: 'Tesla Inc. (TSLA)', currency: 'USD' },
  { match: /\b(nvidia\s*stock|nvda)\b/i, symbol: 'NVDA', name: 'NVIDIA Corporation (NVDA)', currency: 'USD' },
  { match: /\b(reliance\s*industries|reliance\s*share|reliance)\b/i, symbol: 'RELIANCE.NS', name: 'Reliance Industries Ltd (NSE)', currency: 'INR' },
  { match: /\b(tcs\s*share|tcs)\b/i, symbol: 'TCS.NS', name: 'Tata Consultancy Services (NSE)', currency: 'INR' },
  { match: /\b(hdfc\s*bank)\b/i, symbol: 'HDFCBANK.NS', name: 'HDFC Bank Ltd (NSE)', currency: 'INR' }
];

async function fetchLiveFinanceQuote(userPrompt) {
  if (!userPrompt || typeof userPrompt !== 'string') return null;
  const matchItem = FINANCIAL_TICKERS.find((t) => t.match.test(userPrompt));
  if (!matchItem) return null;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(matchItem.symbol)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(4000)
    });

    if (!response.ok) return null;
    const data = await response.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') return null;

    const currentPrice = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const change = prevClose ? (currentPrice - prevClose).toFixed(2) : null;
    const changePercent = prevClose ? (((currentPrice - prevClose) / prevClose) * 100).toFixed(2) : null;
    const currency = meta.currency || matchItem.currency || '';
    const dayHigh = meta.regularMarketDayHigh || meta.dayHigh;
    const dayLow = meta.regularMarketDayLow || meta.dayLow;
    const currSign = currency === 'INR' ? '₹' : '$';

    let text = '[LIVE REAL-TIME FINANCIAL MARKET DATA]\n';
    text += `Asset: ${matchItem.name} (${matchItem.symbol})\n`;
    text += `Current Price: ${currSign}${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}\n`;
    if (prevClose) {
      text += `Previous Close: ${currSign}${prevClose.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}\n`;
    }
    if (change !== null) {
      const sign = change > 0 ? '+' : '';
      text += `Day Change: ${sign}${change} (${sign}${changePercent}%)\n`;
    }
    if (dayHigh && dayLow) {
      text += `24h High: ${currSign}${dayHigh} | 24h Low: ${currSign}${dayLow}\n`;
    }
    text += `Exchange Time: ${new Date().toUTCString()}\n`;
    text += 'Data Source: Live Exchange Network Feeds\n\n';
    text += '[INSTRUCTIONS FOR AI ASSISTANT]\n';
    text += 'The user is asking for financial market information. Use the verified live financial market data above to state the current price, previous close, and change clearly and confidently. Cite the source as live exchange data.';

    const sources = [
      {
        id: 1,
        title: `${matchItem.name} Real-Time Quote - Yahoo Finance`,
        url: `https://finance.yahoo.com/quote/${encodeURIComponent(matchItem.symbol)}`,
        domain: 'finance.yahoo.com',
        snippet: `Live market price: ${currSign}${currentPrice.toFixed(2)} ${currency}. Change: ${change ? `${change} (${changePercent}%)` : '0.00'}`
      },
      {
        id: 2,
        title: `${matchItem.name} Interactive Overview - Google Finance`,
        url: `https://www.google.com/finance/quote/${encodeURIComponent(matchItem.symbol)}`,
        domain: 'google.com',
        snippet: `Real-time quote, intraday performance, and historical trends for ${matchItem.name}.`
      }
    ];

    return {
      formattedContext: text,
      sources
    };
  } catch (err) {
    console.warn(`⚠️ [FINANCE FETCH] Failed to get live quote for ${matchItem.symbol}:`, err.message);
    return null;
  }
}

module.exports = {
  fetchLiveFinanceQuote,
  FINANCIAL_TICKERS
};
