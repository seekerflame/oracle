import fetch from 'node-fetch';

/**
 * hype_discovery.js
 * 🚀 THE HYPE SENTINEL: Discovery Module
 * 
 * Fetches trending coins from CoinGecko as a first signal for social momentum.
 */

async function getTrending() {
    console.log('--- 🚀 HYPE SENTINEL: DISCOVERY MODE ---');
    const url = 'https://api.coingecko.com/api/v3/search/trending';

    try {
        const response = await fetch(url);
        const data = await response.json();

        console.log('Top Trending Tokens (CoinGecko):');
        data.coins.slice(0, 5).forEach((item, index) => {
            const coin = item.item;
            console.log(`  ${index + 1}. ${coin.name} ($${coin.symbol}) | Rank: ${coin.market_cap_rank}`);
        });

        return data.coins;
    } catch (e) {
        console.log('  ❌ Discovery Failed:', e.message);
        return [];
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    getTrending();
}

export { getTrending };
