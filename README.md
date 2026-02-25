# 🔮 Oracle Trading Engine

> **An open-source, multi-strategy trading engine with institutional-grade risk management.**

Oracle scans markets, detects signals, and executes trades with a multi-layer risk system that separates winners from gamblers.

---

## ✨ Features

| Module | What It Does |
|--------|-------------|
| **Market Scanner** | Scans 18+ tickers for technical setups |
| **Signal Engine** | Confluence scoring (0-13 scale) combining RSI, MACD, Bollinger, ATR, and insider data |
| **Risk Manager** | 8 safety rules: max drawdown, position sizing, R:R ratio, sector limits, daily loss caps |
| **Insider Tracker** | Pulls SEC Form 4 filings, detects cluster buys |
| **Congress Tracker** | Monitors congressional trading activity |
| **DEX Executor** | On-chain swaps via Uniswap V3 (Polygon, Arbitrum) |
| **Gas Sentinel** | Multi-chain gas monitoring with RPC fallbacks |
| **Whale Tracer** | Tracks high-value wallet clusters |

## 🏗️ Architecture

```
src/
├── scan.js              # Main entry point — market scanner
├── analysis/
│   ├── indicators.js    # RSI, MACD, Bollinger Bands, ATR
│   └── signals.js       # Confluence scoring engine
├── risk/
│   └── manager.js       # 8-rule risk management system
├── strategies/
│   └── yield.js         # Yield optimization strategies
├── executor/
│   ├── dex_executor.js  # On-chain DEX trading
│   ├── gas_sentinel.js  # Multi-chain gas monitoring
│   ├── whale_tracer.js  # Whale wallet tracking
│   ├── hype_tracer.js   # Hype cycle detection
│   └── ...              # More executors
├── wallet/
│   └── generate.js      # Wallet generation utilities
└── data/                # Data connectors (Alpaca, SEC, etc.)
```

## 🚀 Quick Start

```bash
# Clone the repo
git clone https://github.com/seekerflame/oracle.git
cd oracle

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your API keys

# Run the scanner
npm run scan

# Run with specific tickers
node src/scan.js NVDA TSLA AAPL

# Run insider-only scan
node src/scan.js --insider

# Paper trade (dry run)
npm run paper

# DEX trade (dry run)
npm run dex-trade

# DEX trade (LIVE — use with caution)
npm run dex-live
```

## 📊 Signal Scoring

The Signal Engine uses confluence scoring — multiple indicators must agree before a trade is recommended:

| Indicator | Weight | Buy Signal | Sell Signal |
|-----------|--------|-----------|-------------|
| RSI (14) | 0-2 pts | < 30 (oversold) | > 70 (overbought) |
| MACD | 0-2 pts | Bullish crossover | Bearish crossover |
| Bollinger | 0-2 pts | Price < lower band | Price > upper band |
| ATR | 0-2 pts | Low volatility setup | High volatility warning |
| Volume | 0-2 pts | Above-average volume | Below-average volume |
| Insider | 0-3 pts | Cluster buys detected | — |

**Minimum score to trade: 5/13.** Scores 7+ are strong signals. Scores 9+ are high-conviction.

## 🛡️ Risk Management

The Risk Manager enforces 8 non-negotiable rules:

1. **Max 5% per trade** — No single position exceeds 5% of portfolio
2. **Stop-loss** — 2x ATR below entry
3. **Take-profit** — Minimum 3:1 reward-to-risk ratio
4. **Max drawdown** — 10% = ALL trading paused
5. **Max 5 open positions** — No overexposure
6. **Sector limits** — Max 2 positions in the same sector
7. **Daily loss cap** — -2% = stop for the day
8. **Signal minimum** — Score must be 5+ to enter

## ⚙️ Configuration

Create a `.env` file:

```bash
# Market Data (Alpaca — free tier available)
ALPACA_API_KEY=your_key
ALPACA_SECRET_KEY=your_secret

# Ethereum/Polygon Wallet
ETH_WALLET_ADDRESS=0x_your_address
ETH_PRIVATE_KEY=0x_your_key

# Solana Wallet (optional)
SOLANA_WALLET_ADDRESS=your_address
SOLANA_PRIVATE_KEY=your_key
```

> ⚠️ **NEVER commit your `.env` file.** It is excluded via `.gitignore`.

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/new-strategy`)
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

**All contributions earn AT (Abundance Token) credit in the community ledger.**

## 📜 License

MIT — Use it, fork it, build on it. Just don't use it to extract from the community.

---

*Built by EternalFlame | Part of the Gaia Protocol Ecosystem*
