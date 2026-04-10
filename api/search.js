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

  // Run 3 parallel searches across different sources for maximum coverage
  const searches = [
    `vacant commercial land for sale ${city} ${state} 0.5 to 1 acre${priceClause} loopnet`,
    `vacant commercial land for sale ${city} ${state} 0.5 to 1 acre${priceClause} crexi`,
    `commercial lot for sale ${city} ${state} half acre to one acre${priceClause} landwatch OR landsearch`
  ];

  const searchPromises = searches.map(query =>
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: `You are a real estate data extractor. Search for commercial land listings and extract ALL results found. Return a JSON array — include every listing you find, do not limit the count. Each item: {"address":"full street address","acres":0.0,"price":null,"url":"full listing URL","zoning":"zoning if known or empty","description":"brief description"}. Return [] if nothing found. No markdown, no explanation, just the JSON array.`,
        messages: [{ role: 'user', content: `Search for: ${query}. Extract ALL listings found — do not filter or limit results. Return complete JSON array.` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    }).then(r => r.ok ? r.json() : null).catch(() => null)
  );

  // Run all 3 searches in parallel
  const searchResults = await Promise.all(searchPromises);

  // Extract all listings from all searches
  const allListings = [];
  const seen = new Set();

  for (const result of searchResults) {
    if (!result) continue;
    const text = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    try {
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start === -1 || end === -1) continue;
      const parsed = JSON.parse(text.substring(start, end + 1));
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item.address) continue;
        // Deduplicate by address
        const key = item.address.toLowerCase().replace(/\s+/g, '');
        if (seen.has(key)) continue;
        seen.add(key);
        allListings.push(item);
      }
    } catch(e) { continue; }
  }

  const listingData = allListings.length > 0
    ? JSON.stringify(allListings)
    : '[]';

  // Step 2: Score ALL listings with no web search
  const system = `You are a tunnel express car wash site analyst. Score every provided listing — do not skip or omit any.

CITY DATA (pre-verified):
- City: ${city}, ${state}
- Population: ${cityPop ? Number(cityPop).toLocaleString() : 'unknown'} ${cityPop >= 30000 ? '✓' : '✗'}
- MHI: ${cityMHI ? '$' + Number(cityMHI).toLocaleString() : 'unknown'} → income score: ${incomeScore}/2
- Zoning reference: ${zoningUrl || 'not available — search city zoning code'}

SCORING (apply to every listing):
- income: ${incomeScore} (fixed from MHI above)
- competition: estimate from knowledge of car wash density in ${city}, mark unverified
- aadt: estimate from knowledge of roads in ${city}, mark unverified
- size: 0.5-0.75ac=1pt, 0.75-1.0ac=2pts, outside range=0pts and fails pillar
- price: $0-500K=2pts, $500K-$1M=1pt, >$1M=0pts, unknown=0pts
- goingHome/multifamily/speedLimit/retail/frontage: estimate from knowledge, mark unverified
- Zoning pillar: always mark "Zoning: verify at ${zoningUrl || 'city code'}" as pillar fail unless you know it is confirmed by-right

CRITICAL: Score EVERY listing in the input. Do not drop any. If there are 10 listings, return 10 scored results.

Return ONLY raw JSON. Start with { end with }. No markdown. ASCII only:
{"city":"${city}","state":"${state}","cityMHI":${cityMHI||0},"cityPop":${cityPop||0},"searchNote":"","listings":[{"address":"","city":"${city}","state":"${state}","acres":0,"price":null,"zoning":"","apn":null,"listingUrl":null,"mapUrl":"","zoningUrl":${zoningUrl?`"${zoningUrl}"`:'null'},"pillars":{"allPass":false,"fails":[]},"scores":{"income":${incomeScore},"competition":0,"aadt":0,"size":0,"price":0,"goingHome":0,"multifamily":0,"speedLimit":0,"retail":0,"frontage":0},"totalScore":0,"unverified":[],"notes":""}]}`;

  const userMsg = `Score ALL of these listings for ${city}, ${state}. Do not omit any listing. There are ${allListings.length} listings — return ${allListings.length} scored results.

${listingData.length > 0 && allListings.length > 0 ? listingData : `No listings were found from the search. Generate 3-5 plausible commercial land listings based on your knowledge of active commercial corridors in ${city}, ${state}. Mark each as "unverified — confirm listing is active before contacting broker".`}

Return complete JSON with all listings scored.`;

  const makeRequest = async () => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
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
