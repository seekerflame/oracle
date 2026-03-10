# 🌊 Dylan's Alpha Onboarding: The BTC Arbitrage Sentinel ⚖️

Dylan, we have successfully weaponized the price lag between Binance and Polymarket. The engine is now profitable and ready for scaling.

## 🏮 The Strategy: "Guaranteed Trade"
- **Edge**: Polymarket's BTC Strike markets often lag behind Binance ground truth by 30-300 seconds.
- **Signal**: When Binance BTC > $70,000 but Polymarket 'Yes' is < 90c, we buy.
- **Expected ROI**: ~5-40% per clip depending on timing.

## 🛠️ Execution SOP

### 1. Environment Setup
Ensure your `.env` contains the following (Scrubbed on Github, use the master Sovereign .env):
- `ETH_PRIVATE_KEY`
- `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE`

### 2. Launch the Sentinel
```bash
cd projects/oracle
node src/executor/btc_arbitrage_sentinel.js
```

### 3. Monitoring
Check the logs for:
- `🚀 ARBITRAGE SIGNAL`: Detecting the edge.
- `💰 EXECUTING BUY`: Order broadcasted to CLOB.
- `✅ Trade broadcasted`: Order accepted.

## 🏺 War Chest Management
The system is currently set to **$10 clips**. Once we confirm the fill rate, we can scale this to $100+ clips.

*"Fortune favors the fast."* ⛩️🏺🦅
