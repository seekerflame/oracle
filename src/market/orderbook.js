import 'dotenv/config';
import { PolymarketConnector } from './polymarket_api.js';
import { fileURLToPath } from 'url';

/**
 * Oracle Truth Machine — Order Book Depth Analysis
 *
 * Analyzes Polymarket CLOB order books to find:
 * - Bid/ask spreads (wider = less efficient = more edge)
 * - Liquidity depth (how much capital on each side)
 * - Price impact estimation (how much $ moves the price)
 * - Walls (large limit orders acting as support/resistance)
 * - Thin spots (where small capital can move price significantly)
 *
 * This is the market mechanics pentesting layer.
 */

export class OrderBookAnalyzer {
    constructor() {
        this.pm = new PolymarketConnector();
    }

    /**
     * Full depth analysis for a market's order book.
     * @param {string} tokenId - CLOB token ID for the YES outcome
     * @returns {Object} Depth analysis
     */
    async analyzeDepth(tokenId) {
        const book = await this.pm.getOrderBook(tokenId);

        const bids = (book.bids || []).map(o => ({
            price: parseFloat(o.price),
            size: parseFloat(o.size),
        })).sort((a, b) => b.price - a.price); // Highest bid first

        const asks = (book.asks || []).map(o => ({
            price: parseFloat(o.price),
            size: parseFloat(o.size),
        })).sort((a, b) => a.price - b.price); // Lowest ask first

        const bestBid = bids[0]?.price || 0;
        const bestAsk = asks[0]?.price || 1;
        const spread = bestAsk - bestBid;
        const midPrice = (bestBid + bestAsk) / 2;
        const spreadPct = midPrice > 0 ? (spread / midPrice) * 100 : 0;

        const bidLiquidity = bids.reduce((sum, o) => sum + (o.price * o.size), 0);
        const askLiquidity = asks.reduce((sum, o) => sum + (o.price * o.size), 0);
        const totalLiquidity = bidLiquidity + askLiquidity;

        // Price impact: how much does buying/selling X amount move the price?
        const priceImpact = {
            buy10: this._calcPriceImpact(asks, 10),
            buy100: this._calcPriceImpact(asks, 100),
            buy1000: this._calcPriceImpact(asks, 1000),
            sell10: this._calcPriceImpact(bids, 10),
            sell100: this._calcPriceImpact(bids, 100),
            sell1000: this._calcPriceImpact(bids, 1000),
        };

        // Detect walls (orders > 3x average size)
        const allOrders = [...bids, ...asks];
        const avgSize = allOrders.length > 0 ? allOrders.reduce((s, o) => s + o.size, 0) / allOrders.length : 0;
        const wallThreshold = avgSize * 3;

        const walls = allOrders
            .filter(o => o.size > wallThreshold)
            .map(o => ({
                price: o.price,
                size: o.size,
                side: bids.includes(o) ? 'BID' : 'ASK',
                multiplier: (o.size / avgSize).toFixed(1),
            }));

        // Find thin spots (gaps between price levels > 2%)
        const thinSpots = this._findThinSpots(bids, asks);

        // Imbalance: which side has more weight?
        const imbalance = totalLiquidity > 0
            ? ((bidLiquidity - askLiquidity) / totalLiquidity * 100).toFixed(1)
            : 0;

        return {
            bestBid,
            bestAsk,
            spread,
            spreadPct: parseFloat(spreadPct.toFixed(2)),
            midPrice: parseFloat(midPrice.toFixed(4)),
            bidLiquidity: parseFloat(bidLiquidity.toFixed(2)),
            askLiquidity: parseFloat(askLiquidity.toFixed(2)),
            totalLiquidity: parseFloat(totalLiquidity.toFixed(2)),
            imbalance: parseFloat(imbalance), // Positive = more bids (bullish), Negative = more asks
            priceImpact,
            walls,
            thinSpots,
            bidDepth: bids.length,
            askDepth: asks.length,
        };
    }

    /**
     * Calculate price impact for a given trade size.
     * Walks through the order book to determine the effective execution price.
     * @param {Array} orders - Sorted orders (asks for buys, bids for sells)
     * @param {number} usdAmount - Trade size in USD
     * @returns {Object} { avgPrice, slippage, ordersConsumed }
     */
    _calcPriceImpact(orders, usdAmount) {
        if (orders.length === 0) return { avgPrice: 0, slippagePct: 100, ordersConsumed: 0 };

        let remaining = usdAmount;
        let totalShares = 0;
        let totalCost = 0;
        let ordersConsumed = 0;

        for (const order of orders) {
            const orderValue = order.price * order.size;
            const consumed = Math.min(remaining, orderValue);
            const shares = consumed / order.price;

            totalShares += shares;
            totalCost += consumed;
            remaining -= consumed;
            ordersConsumed++;

            if (remaining <= 0) break;
        }

        const avgPrice = totalShares > 0 ? totalCost / totalShares : 0;
        const bestPrice = orders[0]?.price || 0;
        const slippagePct = bestPrice > 0 ? ((avgPrice - bestPrice) / bestPrice * 100) : 0;

        return {
            avgPrice: parseFloat(avgPrice.toFixed(4)),
            slippagePct: parseFloat(Math.abs(slippagePct).toFixed(2)),
            ordersConsumed,
            filled: remaining <= 0,
            unfilledUsd: parseFloat(remaining.toFixed(2)),
        };
    }

    /**
     * Find price gaps ("thin spots") in the order book.
     * These are areas where small capital can cause large price moves.
     */
    _findThinSpots(bids, asks) {
        const spots = [];

        // Check gaps in asks (buy side)
        for (let i = 1; i < asks.length; i++) {
            const gap = asks[i].price - asks[i - 1].price;
            const gapPct = (gap / asks[i - 1].price) * 100;
            if (gapPct > 2) {
                spots.push({
                    type: 'ASK_GAP',
                    from: asks[i - 1].price,
                    to: asks[i].price,
                    gapPct: parseFloat(gapPct.toFixed(1)),
                    note: `${gapPct.toFixed(1)}% gap — buy pressure here jumps price`,
                });
            }
        }

        // Check gaps in bids (sell side)
        for (let i = 1; i < bids.length; i++) {
            const gap = bids[i - 1].price - bids[i].price;
            const gapPct = (gap / bids[i - 1].price) * 100;
            if (gapPct > 2) {
                spots.push({
                    type: 'BID_GAP',
                    from: bids[i - 1].price,
                    to: bids[i].price,
                    gapPct: parseFloat(gapPct.toFixed(1)),
                    note: `${gapPct.toFixed(1)}% gap — sell pressure here drops price`,
                });
            }
        }

        return spots;
    }

    /**
     * Format analysis for human-readable output.
     */
    static formatReport(marketTitle, analysis) {
        let r = `\n📊 ORDER BOOK: ${marketTitle}\n`;
        r += `${'─'.repeat(60)}\n`;
        r += `  Best Bid: $${analysis.bestBid.toFixed(4)} | Best Ask: $${analysis.bestAsk.toFixed(4)}\n`;
        r += `  Spread: $${analysis.spread.toFixed(4)} (${analysis.spreadPct}%)\n`;
        r += `  Mid Price: $${analysis.midPrice}\n`;
        r += `\n  💰 Liquidity:\n`;
        r += `     Bids: $${analysis.bidLiquidity.toFixed(0)} (${analysis.bidDepth} orders)\n`;
        r += `     Asks: $${analysis.askLiquidity.toFixed(0)} (${analysis.askDepth} orders)\n`;
        r += `     Total: $${analysis.totalLiquidity.toFixed(0)}\n`;
        r += `     Imbalance: ${analysis.imbalance > 0 ? '🟢' : '🔴'} ${analysis.imbalance}% ${analysis.imbalance > 0 ? '(bid-heavy)' : '(ask-heavy)'}\n`;

        r += `\n  📐 Price Impact:\n`;
        r += `     Buy $10:   avg $${analysis.priceImpact.buy10.avgPrice} (${analysis.priceImpact.buy10.slippagePct}% slip)\n`;
        r += `     Buy $100:  avg $${analysis.priceImpact.buy100.avgPrice} (${analysis.priceImpact.buy100.slippagePct}% slip)\n`;
        r += `     Buy $1000: avg $${analysis.priceImpact.buy1000.avgPrice} (${analysis.priceImpact.buy1000.slippagePct}% slip)\n`;

        if (analysis.walls.length > 0) {
            r += `\n  🧱 Walls (${analysis.walls.length}):\n`;
            for (const w of analysis.walls) {
                r += `     ${w.side} wall at $${w.price.toFixed(4)} — ${w.size.toFixed(0)} shares (${w.multiplier}x avg)\n`;
            }
        }

        if (analysis.thinSpots.length > 0) {
            r += `\n  ⚡ Thin Spots (${analysis.thinSpots.length}):\n`;
            for (const s of analysis.thinSpots) {
                r += `     ${s.type}: $${s.from.toFixed(4)} → $${s.to.toFixed(4)} (${s.gapPct}% gap)\n`;
            }
        }

        return r;
    }

    close() {
        this.pm.close();
    }
}

// ─── Self-test ─────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const analyzer = new OrderBookAnalyzer();

    console.log('📊 ORDER BOOK ANALYZER — SELF-TEST\n');

    // Get a geopolitical market to analyze
    const geoMarkets = await analyzer.pm.getActiveGeopolitical();

    if (geoMarkets.length === 0) {
        console.log('  No geopolitical markets found. Testing with mock data...');
    } else {
        // Analyze the top 3 most liquid geo markets
        const sorted = geoMarkets
            .filter(m => m.tokens && m.tokens.length > 0)
            .sort((a, b) => b.volume24h - a.volume24h)
            .slice(0, 3);

        for (const market of sorted) {
            const tokenId = market.tokens[0]; // YES token
            if (!tokenId) continue;

            try {
                const depth = await analyzer.analyzeDepth(tokenId);
                console.log(OrderBookAnalyzer.formatReport(market.title, depth));
            } catch (e) {
                console.log(`  ❌ Failed to analyze "${market.title}": ${e.message}`);
            }
        }
    }

    analyzer.close();
    console.log('\n✅ Self-test complete.');
}
