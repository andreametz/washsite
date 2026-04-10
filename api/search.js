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
    ? ` under $${Number(maxPrice).toLocaleString()}` : ' under $1,000,000';
  const incomeScore = cityMHI ? (cityMHI > 75000 ? 2 : 1) : 1;
  const zoningUrl = municodeSlug ? `https://library.municode.com/${municodeSlug}` : null;

  const searches = [
    `"${city}" "${state}" vacant commercial land for sale 0.5 acre 1 acre loopnet`,
    `"${city}" "${state}" commercial lot pad site for sale half acre one acre crexi`,
    `"${city}" "${state}" vacant land commercial for sale 0.5 to 1 acre landwatch`,
    `"${city}" "${state}" commercial land for sale loopnet crexi landsearch 2025`,
  ];

  const extractorSystem = `You are a commercial real estate data extractor. Search for VACANT LAND ONLY suitable for building a car wash.

ONLY INCLUDE:
- Vacant commercial land / lots
- Unimproved land zoned commercial or general business
- Pad sites (empty, no building)
- Land listed on LoopNet, Crexi, LandWatch, or LandSearch
- Size: 0.5 to 1.0 acres ONLY — skip anything smaller than 0.5ac or larger than 1.0ac
- Price: under $1,000,000 ONLY — skip anything over $1M

DO NOT INCLUDE — skip immediately:
- Homes, houses, residential properties
- Buildings of any kind (retail, office, warehouse, industrial)
- Properties with square footage listed (SF, sq ft) — these are buildings
- Residential lots or subdivisions
- Anything with bedrooms, bathrooms, HOA
- Acreage over 1.0 acres or under 0.5 acres
- Price over $1,000,000

Return a JSON array. Each item: {"address":"full street address","acres":0.0,"price":null,"url":"full listing URL","zoning":"","description":"brief description of the land"}
Return [] if nothing qualifies. No markdown, no explanation — just the JSON array.`;

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
        max_tokens: 2500,
        system: extractorSystem,
        messages: [{ role: 'user', content: `Search and extract ALL qualifying vacant commercial land listings: ${query}` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    }).then(r => r.ok ? r.json() : null).catch(() => null)
  );

  const searchResults = await Promise.all(searchPromises);

  const allListings = [];
  const seen = new Set();

  // Keywords that indicate a building/residential — reject these
  const rejectPattern = /\b(house|home|residence|residential|bedroom|bath|sqft|sq\.?ft|square.?feet|square.?foot|apartment|condo|townhome|townhouse|single.?family|duplex|sfr|mls#?|hoa|warehouse|office building|retail building|industrial|sq\.ft|garage|roof|hvac|tenant|lease|±\d+,?\d+\s*sf)\b/i;

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

        // Reject buildings/residential
        const fullText = [item.address, item.description, item.zoning].filter(Boolean).join(' ');
        if (rejectPattern.test(fullText)) continue;

        // Strict size filter — must be 0.5 to 1.0 acres
        const acres = parseFloat(item.acres);
        if (acres && (acres < 0.5 || acres > 1.0)) continue;

        // Strict price filter — must be under $1M
        let price = null;
        if (item.price) {
          const ps = String(item.price).toLowerCase().replace(/[\s,]/g, '');
          if (ps.includes('m')) price = parseFloat(ps.replace(/[^0-9.]/g, '')) * 1000000;
          else if (ps.includes('k')) price = parseFloat(ps.replace(/[^0-9.]/g, '')) * 1000;
          else price = parseFloat(ps.replace(/[^0-9.]/g, ''));
        }
        if (price && price > 1000000) continue;

        // Deduplicate
        const key = item.address.toLowerCase().replace(/\s+/g, '');
        if (seen.has(key)) continue;
        seen.add(key);
        allListings.push(item);
      }
    } catch(e) { continue; }
  }

  const listingData = allListings.length > 0 ? JSON.stringify(allListings) : '[]';

  const system = `You are a tunnel express car wash site analyst. Score the provided VACANT LAND listings only.

CITY DATA (pre-verified):
- City: ${city}, ${state}
- Population: ${cityPop ? Number(cityPop).toLocaleString() : 'unknown'} ${cityPop >= 30000 ? '✓' : '✗'}
- MHI: ${cityMHI ? '$' + Number(cityMHI).toLocaleString() : 'unknown'} → income score: ${incomeScore}/2
- Zoning reference: ${zoningUrl || 'search city zoning code'}

HARD RULES — remove any listing that fails these:
- Size must be 0.5 to 1.0 acres — reject anything outside this range
- Price must be under $1,000,000 — reject anything over $1M
- Must be vacant land only — reject any building, home, or improved property

SCORING:
- income: ${incomeScore} (fixed)
- competition: estimate from knowledge of ${city} car wash market, mark unverified
- aadt: estimate from knowledge of roads in ${city}, mark unverified
- size: 0.5-0.75ac=1pt, 0.75-1.0ac=2pts, unknown=1pt mark unverified
- price: $0-500K=2pts, $500K-$1M=1pt, over $1M=exclude, unknown=1pt mark unverified
- goingHome/multifamily/speedLimit/retail/frontage: estimate from knowledge, mark unverified
- Zoning pillar: mark "Zoning: verify at ${zoningUrl || 'city code'}" in fails unless confirmed by-right

Return ONLY raw JSON starting with { ending with }, no markdown, ASCII only:
{"city":"${city}","state":"${state}","cityMHI":${cityMHI||0},"cityPop":${cityPop||0},"searchNote":"","listings":[{"address":"","city":"${city}","state":"${state}","acres":0,"price":null,"zoning":"","apn":null,"listingUrl":null,"mapUrl":"","zoningUrl":${zoningUrl?`"${zoningUrl}"`:'null'},"pillars":{"allPass":false,"fails":[]},"scores":{"income":${incomeScore},"competition":0,"aadt":0,"size":0,"price":0,"goingHome":0,"multifamily":0,"speedLimit":0,"retail":0,"frontage":0},"totalScore":0,"unverified":[],"notes":""}]}`;

  const userMsg = allListings.length > 0
    ? `Score these ${allListings.length} vacant land listings for ${city}, ${state}. Apply all hard rules. Return all qualifying results as JSON.\n\n${listingData}`
    : `No listings found from live search. Generate 3-5 realistic VACANT COMMERCIAL LAND listings (0.5-1.0 acres, under $1M) based on your knowledge of commercial corridors in ${city}, ${state}. Mark each "unverified — confirm listing is active". Return JSON.`;

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
