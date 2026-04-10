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

  // 4 parallel searches across different sources and query styles
  const searches = [
    `"${city}" "${state}" commercial land for sale 0.5 acre 1 acre loopnet.com`,
    `"${city}" "${state}" commercial lot pad site for sale half acre one acre crexi`,
    `"${city}" "${state}" vacant land commercial sale .5 acre 1 acre landwatch landwatch.com`,
    `"${city}" "${state}" commercial land for sale site loopnet OR crexi OR landsearch 2024 2025`,
  ];

  const extractorSystem = `You are a real estate listing extractor. Find VACANT COMMERCIAL LAND listings only.
INCLUDE: vacant lots, commercial land, pad sites, development land, commercial parcels
EXCLUDE: homes, houses, residential lots, buildings, warehouses, office buildings, retail buildings, any structure with square footage
RULES:
- Search thoroughly and extract every qualifying listing you find
- Include listings even if acreage or price is unknown — leave those fields null
- Return a JSON array. Each item: {"address":"full street address with city and state","acres":null,"price":null,"url":"full listing URL","zoning":"","description":""}
- Return [] only if you truly find nothing
- No markdown, no explanation — just the raw JSON array starting with [`;

  const searchPromises = searches.map((query, idx) =>
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
        max_tokens: 2500,
        system: extractorSystem,
        messages: [{ role: 'user', content: `Search for this query and extract ALL listings: ${query}` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    }).then(r => r.ok ? r.json() : null).catch(() => null)
  );

  const searchResults = await Promise.all(searchPromises);

  // Extract and deduplicate all listings
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
        // Hard filter on size only if explicitly known
        const acres = parseFloat(item.acres);
        if (acres && (acres < 0.45 || acres > 1.1)) continue;
        // Hard filter on price only if explicitly known
        let price = null;
        if (item.price) {
          const ps = String(item.price).toLowerCase().replace(/[\s,]/g, '');
          if (ps.includes('m')) price = parseFloat(ps.replace(/[^0-9.]/g, '')) * 1000000;
          else if (ps.includes('k')) price = parseFloat(ps.replace(/[^0-9.]/g, '')) * 1000;
          else price = parseFloat(ps.replace(/[^0-9.]/g, ''));
        }
        if (price && price > 1000000) continue;
        // Filter out residential/building listings
        const desc = ((item.description||'') + ' ' + (item.address||'') + ' ' + (item.zoning||'')).toLowerCase();
        const isResidential = /\b(house|home|residential|bedroom|bath|sqft|sq ft|square feet|apartment|condo|townhome|townhouse|single.family|duplex|sfr|mls#|hoa)\b/.test(desc);
        if (isResidential) continue;

        // Deduplicate
        const key = item.address.toLowerCase().replace(/\s+/g, '');
        if (seen.has(key)) continue;
        seen.add(key);
        allListings.push(item);
      }
    } catch(e) { continue; }
  }

  const listingData = allListings.length > 0 ? JSON.stringify(allListings) : '[]';

  // Step 2: Score ALL listings
  const system = `You are a tunnel express car wash site analyst. Score every listing provided.

CITY DATA (pre-verified, do not search):
- City: ${city}, ${state}
- Population: ${cityPop ? Number(cityPop).toLocaleString() : 'unknown'} ${cityPop >= 30000 ? '✓' : '✗'}
- MHI: ${cityMHI ? '$' + Number(cityMHI).toLocaleString() : 'unknown'} → income score: ${incomeScore}/2
- Zoning reference: ${zoningUrl || 'search city zoning code'}

SCORING:
- income: ${incomeScore} (fixed)
- competition: estimate from knowledge of ${city} car wash market, mark unverified
- aadt: estimate from knowledge of roads in ${city}, mark unverified
- size: 0.5-0.75ac=1pt, 0.75-1.0ac=2pts, unknown=1pt (mark unverified)
- price: $0-500K=2pts, $500K-$1M=1pt, >$1M=DO NOT INCLUDE (remove from results), unknown=1pt (mark unverified)
- goingHome/multifamily/speedLimit/retail/frontage: estimate from knowledge, mark unverified
- Zoning pillar: mark "Zoning: verify at ${zoningUrl || 'city code'}" in fails unless confirmed by-right

CRITICAL: Score EVERY listing. Return ALL of them. Do not drop any.

Return ONLY raw JSON, start with {, end with }, no markdown, ASCII only:
{"city":"${city}","state":"${state}","cityMHI":${cityMHI||0},"cityPop":${cityPop||0},"searchNote":"","listings":[{"address":"","city":"${city}","state":"${state}","acres":0,"price":null,"zoning":"","apn":null,"listingUrl":null,"mapUrl":"","zoningUrl":${zoningUrl?`"${zoningUrl}"`:'null'},"pillars":{"allPass":false,"fails":[]},"scores":{"income":${incomeScore},"competition":0,"aadt":0,"size":0,"price":0,"goingHome":0,"multifamily":0,"speedLimit":0,"retail":0,"frontage":0},"totalScore":0,"unverified":[],"notes":""}]}`;

  const userMsg = allListings.length > 0
    ? `Score ALL ${allListings.length} of these listings for ${city}, ${state}. Return all ${allListings.length} scored results.\n\n${listingData}`
    : `No listings were found from live search. Generate 4-6 realistic commercial land listings based on your knowledge of active commercial corridors in ${city}, ${state}. Mark each as "unverified — confirm listing is active". Return JSON.`;

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
