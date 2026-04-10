export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  let city, state, maxPrice, cityMHI, cityPop, municodeSlug;
  try {
    const body = req.body || {};
    city = body.city; state = body.state; maxPrice = body.maxPrice;
    cityMHI = body.cityMHI; cityPop = body.cityPop; municodeSlug = body.municodeSlug;
  } catch(e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!city || !state) return res.status(400).json({ error: 'City and state required' });

  const priceClause = maxPrice && maxPrice !== '0'
    ? ` under $${Number(maxPrice).toLocaleString()}` : '';

  const incomeScore = cityMHI ? (cityMHI > 75000 ? 2 : 1) : 1;
  const zoningUrl = municodeSlug ? `https://library.municode.com/${municodeSlug}` : null;

  // ── STEP 1: Single web search for listings ──────────────────────────────
  // We run ONE search ourselves, get the raw results, then pass to Claude for scoring
  // This prevents Claude from running multiple chained searches

  const searchQuery = `vacant commercial land for sale ${city} ${state} 0.5 to 1 acre${priceClause} site:loopnet.com OR site:crexi.com OR site:landsearch.com OR site:landwatch.com`;

  let listingData = '';
  try {
    const searchResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: `You are a real estate data extractor. Search for commercial land listings and return ONLY a JSON array of listings found. Each listing: {"address":"","acres":0,"price":null,"url":"","zoning":"","description":""}. Return [] if nothing found. No markdown, no explanation.`,
        messages: [{ role: 'user', content: `Search for: vacant commercial land for sale in ${city}, ${state} between 0.5 and 1.0 acres${priceClause}. Find listings on LoopNet, Crexi, LandSearch, or LandWatch. Return JSON array only.` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });

    if (searchResp.ok) {
      const searchData = await searchResp.json();
      const rawText = (searchData.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      listingData = rawText.trim() || '[]';
    }
  } catch(e) {
    listingData = '[]';
  }

  // ── STEP 2: Score listings using Claude with NO web search ──────────────
  const system = `You are a tunnel express car wash site analyst. Score the provided land listings.

CITY DATA (pre-verified, do not search):
- City: ${city}, ${state}
- Population: ${cityPop ? Number(cityPop).toLocaleString() : 'unknown'} ${cityPop >= 30000 ? '✓ passes pillar' : '✗ fails pillar'}
- MHI: ${cityMHI ? '$' + Number(cityMHI).toLocaleString() : 'unknown'} → income score: ${incomeScore}/2
- Zoning reference: ${zoningUrl || 'not available'}

SCORING RULES:
- income: ${incomeScore} (pre-calculated from MHI)
- competition: 1 if you know this market has low car wash density, else mark unverified
- aadt: estimate from knowledge of this road/city, mark unverified
- size: 0.5-0.75ac=1pt, 0.75-1.0ac=2pts
- price: $0-$500K=2pts, $500K-$1M=1pt, >$1M=0pts
- goingHome/multifamily/speedLimit/retail/frontage: estimate from knowledge, mark unverified
- Zoning pillar: mark as "Zoning: verify at ${zoningUrl || 'city zoning code'}" in fails unless you know it is by-right

Return ONLY raw JSON. Start with { end with }. No markdown. ASCII only:
{"city":"${city}","state":"${state}","cityMHI":${cityMHI||0},"cityPop":${cityPop||0},"searchNote":"","listings":[{"address":"","city":"${city}","state":"${state}","acres":0,"price":null,"zoning":"","apn":null,"listingUrl":null,"mapUrl":"","zoningUrl":${zoningUrl ? `"${zoningUrl}"` : 'null'},"pillars":{"allPass":false,"fails":[]},"scores":{"income":${incomeScore},"competition":0,"aadt":0,"size":0,"price":0,"goingHome":0,"multifamily":0,"speedLimit":0,"retail":0,"frontage":0},"totalScore":0,"unverified":[],"notes":""}]}`;

  const userMsg = `Here are the raw listing search results for ${city}, ${state}:

${listingData}

Score each listing using the rules in your system prompt. If the listing data above is empty or unhelpful, generate 2-3 plausible placeholder listings based on your knowledge of commercial land in ${city}, ${state} and mark them as "unverified — confirm listing is active". Return JSON only.`;

  const makeRequest = async () => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
      // NO web search tool here — pure scoring only
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system,
      messages: [{ role: 'user', content: userMsg }]
    })
  });

  try {
    let response = await makeRequest();

    let retries = 0;
    while (response.status === 429 && retries < 3) {
      retries++;
      await new Promise(r => setTimeout(r, 60000));
      response = await makeRequest();
    }

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
