import crypto from 'crypto';
import fetch from 'node-fetch';
import 'dotenv/config';

/**
 * Oracle Truth Machine — Coinbase CDP Audit
 * 🧪 JWT AUTHENTICATION LAYER
 * 
 * Fetches balances from Coinbase Developer Platform.
 */

async function coinbaseAudit() {
    const keyName = process.env.COINBASE_API_KEY_NAME;
    const keySecret = process.env.COINBASE_API_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!keyName || !keySecret) {
        console.error('❌ Missing Coinbase API Credentials in .env');
        return;
    }

    console.log('🏺 COINBASE AUDIT: Initializing session...');

    // JWT Construction for CDP
    const algorithm = 'ES256';
    const header = { alg: algorithm, kid: keyName, typ: 'JWT' };
    const payload = {
        iss: 'coinbase-cloud',
        nbf: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: keyName,
    };

    const token = signJwt(header, payload, keySecret);

    try {
        const res = await fetch('https://api.coinbase.com/api/v3/brokerage/accounts', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        
        if (data.accounts) {
            console.log('✅ Accounts Fetched:');
            data.accounts.forEach(acc => {
                if (parseFloat(acc.available_balance.value) > 0) {
                    console.log(`   - ${acc.currency}: ${acc.available_balance.value} (Total: ${acc.hold.value})`);
                }
            });
        } else {
            console.log('⚠️ No active balances found or API error:', data);
        }
    } catch (e) {
        console.error('❌ Audit Failed:', e.message);
    }
}

function signJwt(header, payload, secret) {
    const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.sign(null, Buffer.from(`${base64Header}.${base64Payload}`), secret).toString('base64url');
    return `${base64Header}.${base64Payload}.${signature}`;
}

coinbaseAudit();
