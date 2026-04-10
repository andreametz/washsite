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
    city = body.city;
    state = body.state;
    maxPrice = body.maxPrice;
    cityMHI = body.cityMHI;
    cityPop = body.cityPop;
    municodeSlug = body.municodeSlug;
  } catch(e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!city || !state) return res.status(400).json({ error: 'City and state required' });

  const priceClause = maxPrice && maxPrice !== '0'
    ? ` priced under $${Number(maxPrice).toLocaleString()}`
    : '';

  const zoningUrl = municodeSlug
    ? `https://library.municode.com/${municodeSlug}`
    : null;

  const system = `You are a tunnel express car wash site analyst. Your job is to find vacant commercial land listings and verify zoning only. Use at most 2 web searches total: one for listings, one for zoning.

CITY CONTEXT (already verified — do not search for these):
- Population: ${cityPop ? Number(cityPop).toLocaleString() : 'unknown'} ✓
- Median Household Income: ${cityMHI ? '$' + Number(cityMHI).toLocaleString() : 'unknown'} ✓
- These already pass the population and income pillars.

WHAT TO SEARCH:
1. Search for vacant commercial land listings (0.5–1.0 acres${priceClause}) in ${city}, ${state} on LoopNet, Crexi, or LandWatch
2. ${zoningUrl ? `Check ${zoningUrl} to verify if car washes / auto-related uses are permitted by-right (no SUP required)` : `Search for ${city} ${state} zoning code car wash permitted uses`}

SCORING (score from training knowledge, mark as unverified if uncertain):
- income: ${cityMHI ? (cityMHI > 75000 ? '2 (>$75K confirmed)' : '1 ($50K-$75K confirmed)') : '?'}
- competition: score 1-2 based on your knowledge of car wash density in this market, mark unverified
- aadt: score based on known road traffic levels, mark unverified  
- size: score from listing acreage (0.5–0.75ac=1pt, 0.75–1.0ac=2pts)
- price: $0–$500K=2pts, $500K–$1M=1pt, >$1M=0pts
- goingHome: mark unverified
- multifamily: score from knowledge of area, mark unverified
- speedLimit: mark unverified
- retail: score from knowledge of area, mark unverified
- frontage: mark unverified if not in listing

ZONING PILLAR: Only mark allPass:true if you confirmed by-right zoning from the zoning search. If uncertain, mark as pillar fail with "Zoning: requires verification" in fails array.

Return ONLY a raw JSON object. No markdown, no code fences, no explanation before or after. Start your response with { and end with }. Use only ASCII characters in string values:
{"city":"","state":"","cityMHI":${cityMHI||0},"cityPop":${cityPop||0},"searchNote":"","listings":[{"address":"","city":"","state":"","acres":0,"price":null,"zoning":"","apn":null,"listingUrl":null,"mapUrl":"","zoningUrl":${zoningUrl ? `"${zoningUrl}"` : 'null'},"pillars":{"allPass":false,"fails":[]},"scores":{"income":0,"competition":0,"aadt":0,"size":0,"price":0,"goingHome":0,"multifamily":0,"speedLimit":0,"retail":0,"frontage":0},"totalScore":0,"unverified":[],"notes":""}]}`;

  const userMsg = `Find 3-6 vacant commercial land listings (0.5–1.0 acres${priceClause}) in ${city}, ${state} for a tunnel express car wash. Use max 2 web searches: one for listings, one for zoning verification. Score each parcel. Return JSON only.`;

  const makeRequest = async () => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: userMsg }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
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
