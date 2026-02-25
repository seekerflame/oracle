import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';

/**
 * poly_executor.js
 * 💰 THE RUDY RAID: PolyMarket Betting Engine
 * 
 * Executes bets on targeted high-alpha markets using the CLOB API.
 */

import { checkGas } from './gas_sentinel.js';

const ETH_PRIVATE_KEY = process.env.ETH_PRIVATE_KEY;
const MARKET_ID = '1301544'; // U.S. evacuates Baghdad Embassy by February 28?
const BET_AMOUNT = 15; // Reduced to $15 for risk management

const US_EVACUATES_BAGHDAD_CONDITION_ID = "0x56a642878c772e0bd995f5fd72f6a7bbced4e815615705779c13d7890f545464"; // Derived from marketID
const YES_TOKEN_ID = "46139312350713967618426245298341049149495513939822327454410984217986250336846"; // VERIFIED YES TOKEN ID

async function executeBet() {
    console.log('--- 🛡️ THE RUDY RAID: EXECUTING BET ---');

    // 1. Pre-flight Gas Check: Targeted for Polygon (POL)
    const isFueled = await checkGas('POL');
    if (!isFueled) {
        console.log('  🛑 EXECUTION ABORTED: Insufficient native gas (POL/MATIC).');
        return;
    }

    const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
    const wallet = new ethers.Wallet(ETH_PRIVATE_KEY, provider);

    const client = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet
    );

    try {
        console.log('  🔍 Verifying Polygon USDC balance...');
        // PolyMarket USDC.e address on Polygon
        const usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
        const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
        const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);
        const usdcBalance = await usdcContract.balanceOf(wallet.address);

        console.log(`     USDC Balance: ${ethers.formatUnits(usdcBalance, 6)} USDC`);

        if (usdcBalance < ethers.parseUnits(BET_AMOUNT.toString(), 6)) {
            console.log('  ⏳ Insufficient USDC. Waiting for bridge...');
            return;
        }

        // 1. Place Market Buy for YES
        console.log('  🚀 Placing Market Order for YES shares...');
        const buyOrder = await client.createOrder({
            tokenID: YES_TOKEN_ID,
            price: 0.05, // Buy up to 5c to ensure execution at current ~2.4c
            side: "BUY",
            size: BET_AMOUNT / 0.03 // Buy ~$10 worth
        });
        const buyResp = await client.postOrder(buyOrder);
        console.log(`     Buy Order Result: ${JSON.stringify(buyResp)}`);

        // 2. Set Auto-Sell Limit Order at $0.40 (Stop Profit)
        console.log('  🏹 Setting Auto-Sell (Stop Profit) at $0.40...');
        const sellOrder = await client.createOrder({
            tokenID: YES_TOKEN_ID,
            price: 0.40,
            side: "SELL",
            size: (BET_AMOUNT / 0.03) // Sell all shares
        });
        const sellResp = await client.postOrder(sellOrder);
        console.log(`     Sell Order Result: ${JSON.stringify(sellResp)}`);

        console.log('  ✅ Strategy Deployed: Buy YES @ Market, Sell @ $0.40.');

    } catch (e) {
        console.log(`  ❌ Bet Execution Failed: ${e.message}`);
    }
}

executeBet();
