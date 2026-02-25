import 'dotenv/config';
import { ethers } from 'ethers';
import fetch from 'node-fetch';

/**
 * bridge_executor.js
 * 🌁 THE RUDY BRIDGE: Arbitrum ETH -> Polygon USDC
 * 
 * Uses LI.FI API to find the best route and bridge funds.
 */

const ETH_PRIVATE_KEY = process.env.ETH_PRIVATE_KEY;
const FROM_CHAIN = 'ARB'; // Arbitrum
const TO_CHAIN = 'POL';   // Polygon
const FROM_TOKEN = 'ETH';
const TO_TOKEN = 'POL'; // New native gas token symbol
const AMOUNT = '0.005'; // ~$15 worth for guaranteed routing

async function bridgeFunds() {
    console.log(`--- 🌁 INITIATING BRIDGE: ${FROM_CHAIN} -> ${TO_CHAIN} ---`);

    const provider = new ethers.JsonRpcProvider('https://arb1.arbitrum.io/rpc');
    const wallet = new ethers.Wallet(ETH_PRIVATE_KEY, provider);

    try {
        // 1. Get a quote from LI.FI
        console.log(`  🔍 Fetching quote for ${AMOUNT} ${FROM_TOKEN}...`);
        const quoteUrl = `https://li.quest/v1/quote?fromChain=ARB&toChain=POL&fromToken=${FROM_TOKEN}&toToken=${TO_TOKEN}&fromAddress=${wallet.address}&fromAmount=${ethers.parseUnits(AMOUNT, 'ether').toString()}`;

        const response = await fetch(quoteUrl);
        const quote = await response.json();

        if (quote.errors || !quote.transactionRequest) {
            throw new Error(`LI.FI Quote Error: ${JSON.stringify(quote.errors || 'No transaction request')}`);
        }

        console.log(`  ✅ Route found via ${quote.tool}`);
        console.log(`     Estimated Received: ${quote.estimate.toAmountMin / 1e6} USDC`);
        console.log(`     Estimated Time: ${quote.estimate.executionDuration}s`);

        // 2. Execute Transaction
        console.log('  🚀 Sending bridge transaction...');
        // Prepare tx for v6
        const txRequest = {
            to: quote.transactionRequest.to,
            data: quote.transactionRequest.data,
            value: quote.transactionRequest.value,
            gasLimit: quote.transactionRequest.gasLimit,
            chainId: 42161 // Arbitrum One
        };
        const tx = await wallet.sendTransaction(txRequest);
        console.log(`  ⛓️  Transaction Sent: https://arbiscan.io/tx/${tx.hash}`);

        console.log('  ⏳ Waiting for confirmation...');
        await tx.wait();
        console.log('  ✅ Bridge confirmed on Arbitrum. Funds will arrive on Polygon shortly.');

    } catch (e) {
        console.log(`  ❌ Bridge Failed: ${e.message}`);
    }
}

bridgeFunds();
