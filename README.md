# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ddsopian018-hue/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ddsopian018-hue/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Runner Rider: a paper-trading bot for pump.fun bonding curves. It watches every new coin and buys the first fresh cross of 2x the coin's own lowest price — a real runner's breakout, not a dip (pullbacks after a run almost never recover to the old peak, so this bot does not buy them). One entry per coin, 0.05 SOL per entry, at most five open positions. Each position exits on whichever trips first: a +50% take-profit, a 25% trailing stop below its peak since entry, or a 30% hard stop. A hard budget of 80 buys and a bank target (+1 SOL equity) stop new entries once the day's profit is secured. Pure Node 22 standard library, no network, no hard-coded coins.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout: it reads `hello`, `batch` and `done` lines from the harness and answers each batch with one `reply` line of buy/sell orders.

---

<sub>Entered on [make.fun](https://make.fun/?ref=15w4cn26&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
