import fetch from 'node-fetch';
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';

/**
 * Oracle Truth Machine — BTC Arbitrage Sentinel ⚖️
 * 
 * Strategy: Guaranteed Trade Frontrunning
 * Source 1 (Ground Truth): Binance BTCUSDT
 * Source 2 (Lagging Market): Polymarket BTC Strikes
 */

class BTCArbitrageSentinel {
    constructor() {
        this.binanceUrl = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';
        this.gammaUrl = 'https://gamma-api.polymarket.com/events?slug=bitcoin-above-on-march-10'; 
        
        const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
        const wallet = new ethers.Wallet(process.env.ETH_PRIVATE_KEY, provider);
        
        // Ethers v6 compatibility patch for v5 libraries
        wallet._signTypedData = wallet.signTypedData.bind(wallet);
        
        this.client = new ClobClient(
            'https://clob.polymarket.com',
            137,
            wallet,
            undefined,
            undefined,
            0, // SignatureType.EOA
            {
                apiKey: process.env.POLY_API_KEY,
                apiSecret: process.env.POLY_API_SECRET,
                apiPassphrase: process.env.POLY_API_PASSPHRASE
            }
        );
    }

    async getBinancePrice() {
        const res = await fetch(this.binanceUrl);
        const data = await res.json();
        return parseFloat(data.price);
    }

    async getPolyStrikeData() {
        const res = await fetch(this.gammaUrl);
        const data = await res.json();
        
        // Gamma response is an array of events.Slug search returns the correct event at index 0.
        const event = data[0];
        if (!event || !event.markets) throw new Error('No markets found for this event');

        // Extracting $70k strike specifically - check title or groupItemTitle
        const market = event.markets.find(m => m.groupItemTitle === '$70,000' || m.question.includes('$70,000'));
        if (!market) throw new Error('Strike $70,000 market not found');

        const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
        const clobIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;

        return {
            strike: 70000,
            yesPrice: parseFloat(prices[0]),
            noPrice: parseFloat(prices[1]),
            clobTokenId: clobIds[0] 
        };
    }

    async monitor() {
        console.log('⚖️ SENTINEL: Initializing BTC Arbitrage Loop...');
        try {
            const btcPrice = await this.getBinancePrice();
            const polyData = await this.getPolyStrikeData();

            console.log(`📈 Binance BTC: $${btcPrice}`);
            console.log(`🏺 Poly $70k Strike 'Yes': ${(polyData.yesPrice * 100).toFixed(2)}%`);

            if (btcPrice > polyData.strike && polyData.yesPrice < 0.9) {
                const diff = (1 - polyData.yesPrice) * 100;
                console.log(`🚀 ARBITRAGE SIGNAL: BTC is $${btcPrice} (> strike), but Yes is only ${(polyData.yesPrice * 100).toFixed(2)}%!`);
                console.log(`💎 EDGE: ${diff.toFixed(2)}% potential gain on approach to expiry.`);
                
                // Autonomous Execution
                await this.executeTrade(polyData.clobTokenId, polyData.yesPrice, "BUY");
            } else {
                console.log('😴 EDGE: Signal below threshold. Standing by.');
            }
        } catch (e) {
            console.error(`❌ Sentinel Error: ${e.message}`);
        }
    }

    async executeTrade(tokenId, price, side) {
        console.log(`💰 EXECUTING ${side} for ${tokenId} at ${price}...`);
        try {
            // Ensure price is a string and formatted correctly for CLOB
            const roundedPrice = parseFloat(price).toFixed(2);
            
            const order = await this.client.createOrder({
                tokenID: tokenId,
                price: roundedPrice,
                side: side,
                size: 10 // Start with $10 clips as requested/confirmed
            });
            
            console.log('   📡 Order created, posting to CLOB...');
            const result = await this.client.postOrder(order);
            console.log(`   ✅ Trade broadcasted: ${result.orderID}`);
        } catch (e) {
            console.error(`   ❌ Trade Failed: ${e.message}`);
        }
    }

    start() {
        setInterval(() => this.monitor(), 30000); // 30s heartbeat
        this.monitor();
    }
}

const sentinel = new BTCArbitrageSentinel();
sentinel.start();
