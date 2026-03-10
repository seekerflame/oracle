import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import 'dotenv/config';

async function verifyClob() {
    const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
    const wallet = new ethers.Wallet(process.env.ETH_PRIVATE_KEY, provider);
    
    // Patch for ethers v6
    wallet._signTypedData = wallet.signTypedData.bind(wallet);

    const client = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet,
        undefined,
        undefined,
        0,
        {
            apiKey: process.env.POLY_API_KEY,
            apiSecret: process.env.POLY_API_SECRET,
            apiPassphrase: process.env.POLY_API_PASSPHRASE
        }
    );

    console.log('🧪 VERIFICATION: Checking CLOB Account...');
    try {
        // Polymarket Collateral Token (USDC.e)
        const collateralAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const code = await provider.getCode(collateralAddress);
        console.log(`📡 RPC Check (USDC.e): ${code !== '0x' ? 'OK' : 'FAIL'}`);

        // Check allowance
        console.log('📡 Fetching allowance...');
        const balance = await client.getCollateralAllowance();
        console.log(`💰 Collateral Allowance: ${balance}`);
        
    } catch (e) {
        console.error(`❌ Verification Failed: ${e.message}`);
        if (e.info) console.error('Details:', JSON.stringify(e.info, null, 2));
    }
}

verifyClob();
