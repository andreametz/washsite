export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  let city, state, maxPrice;
  try {
    const body = req.body || {};
    city = body.city;
    state = body.state;
    maxPrice = body.maxPrice;
  } catch(e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!city || !state) return res.status(400).json({ error: 'City and state required' });

  const priceClause = maxPrice && maxPrice !== '0'
    ? ` priced under $${Number(maxPrice).toLocaleString()}`
    : '';

  const system = `You are a commercial real estate analyst for tunnel express car wash site selection. Find and score vacant commercial land listings. Required pillars: pop>=30000, 0-1 tunnel wash within 1mi (self-serve don't count), AADT>=13000, parcel 0.5-1.0ac, by-right zoning, MHI>=50000. Scoring max 15pts: income(0-2), competition(0-2), aadt(0-2), size(0-2), price(0-2), goingHome(0-1), multifamily(0-1), speedLimit(0-1), retail(0-1), frontage(0-1). Return ONLY valid JSON no markdown: {"city":"","state":"","cityMHI":0,"cityPop":0,"searchNote":"","listings":[{"address":"","city":"","state":"","acres":0,"price":null,"zoning":"","apn":null,"listingUrl":null,"mapUrl":"","zoningUrl":null,"pillars":{"allPass":false,"fails":[]},"scores":{"income":0,"competition":0,"aadt":0,"size":0,"price":0,"goingHome":0,"multifamily":0,"speedLimit":0,"retail":0,"frontage":0},"totalScore":0,"unverified":[],"notes":""}]}`;

  const userMsg = `Find 3-6 active vacant commercial land listings (0.5-1.0 acres${priceClause}) in ${city}, ${state} for a tunnel express car wash. Search LoopNet, Crexi, LandWatch, county assessor. Check AADT from state DOT, competition from Google Maps, zoning from city code. Score every parcel. Return JSON only.`;

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
      max_tokens: 3000,
      system,
      messages: [{ role: 'user', content: userMsg }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
  });

  try {
    let response = await makeRequest();

    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 20000));
      response = await makeRequest();
    }

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
