import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';

/**
 * generate_clob_creds.js
 * 🗝️ THE RUDY RAID: PolyMarket Authentication
 * 
 * Generates L2 CLOB API credentials for the Oracle wallet.
 */

const ETH_PRIVATE_KEY = process.env.ETH_PRIVATE_KEY;

async function generate() {
    console.log('--- 🗝️ GENERATING POLYMARKET CLOB CREDENTIALS ---');

    const provider = new ethers.JsonRpcProvider('https://polygon.drpc.org');
    const wallet = new ethers.Wallet(ETH_PRIVATE_KEY, provider);

    // Shim for signing
    wallet._signTypedData = wallet.signTypedData.bind(wallet);

    const client = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet
    );

    try {
        console.log('  📜 Deriving API Credentials...');
        const creds = await client.createApiKey();
        console.log('\n--- ⚠️  SAVE TO .env ---');
        console.log(`POLY_API_KEY=${creds.key}`);
        console.log(`POLY_API_SECRET=${creds.secret}`);
        console.log(`POLY_API_PASSPHRASE=${creds.passphrase}`);
        console.log('------------------------\n');

        console.log('  ✅ Credentials Generated successfully.');
    } catch (e) {
        console.log('  ❌ Generation Failed:', e.message);
    }
}

generate();
